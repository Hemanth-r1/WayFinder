import type { TrafficSignal } from './types.js';

export type SignalGroup = 'NS' | 'EW';
export type ApproachState = 'RED' | 'YELLOW' | 'GREEN';

/** Phase group that serves traffic travelling on the given bearing (same split as deriveApproaches). */
export function groupForBearing(bearing: number): SignalGroup {
  const b = ((bearing % 360) + 360) % 360;
  return (b >= 315 || b < 45) || (b >= 135 && b < 225) ? 'NS' : 'EW';
}

/** Light currently shown to a vehicle approaching on `group`. */
export function approachState(signal: TrafficSignal, group: SignalGroup): ApproachState {
  const phase = signal.phases[signal.currentPhaseIndex];
  if (!phase || phase.group !== group) return 'RED';
  return phase.color === 'GREEN' ? 'GREEN' : phase.color === 'YELLOW' ? 'YELLOW' : 'RED';
}

/**
 * Seconds a vehicle on `group` arriving `arrivalIn` seconds from now waits for green,
 * projecting the fixed phase sequence forward from the signal's current state.
 */
export function waitOnArrival(signal: TrafficSignal, group: SignalGroup, arrivalIn: number): number {
  const phases = signal.phases;
  if (phases.length === 0) return 0;
  const isOurGreen = (i: number) => phases[i].group === group && phases[i].color === 'GREEN';
  if (!phases.some((_, i) => isOurGreen(i))) return 0;

  let idx = signal.currentPhaseIndex;
  let phaseStart = -signal.timer;
  for (let guard = 0; phaseStart + phases[idx].duration <= arrivalIn && guard < 1000; guard++) {
    phaseStart += phases[idx].duration;
    idx = (idx + 1) % phases.length;
  }
  if (isOurGreen(idx)) return 0;

  let greenAt = phaseStart + phases[idx].duration;
  idx = (idx + 1) % phases.length;
  for (let guard = 0; !isOurGreen(idx) && guard < phases.length; guard++) {
    greenAt += phases[idx].duration;
    idx = (idx + 1) % phases.length;
  }
  return Math.max(0, greenAt - arrivalIn);
}

/** Expected wait for a random arrival: red share r of cycle C gives r²·C/2; two-phase ≈ C/8. */
export function expectedSignalDelay(signal: TrafficSignal): number {
  return signal.cycleLength / 8;
}
