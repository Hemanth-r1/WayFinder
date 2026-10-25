import type { TrafficSignal, RoadEdge } from './types.js';

/** Phase group: 'A' (main road), 'B' (cross road); legacy graphs use 'NS' / 'EW'. */
export type SignalGroup = string;
export type ApproachState = 'RED' | 'YELLOW' | 'GREEN';

/** Legacy grouping by compass direction, for approaches a controller doesn't list. */
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

/** Approach groups per edge, built once per controller list. */
const groupCache = new WeakMap<TrafficSignal, Map<string, string>>();

/** Forget cached approach groups after a junction's groups change (turn rules). */
export function clearSignalCache(signal: TrafficSignal): void {
  groupCache.delete(signal);
}

/**
 * The controller and phase group that govern traffic driving to the end of `edge`,
 * or null when the edge ends at no signal or runs inside a junction already passed.
 */
export function signalControl(
  signalByNode: Map<string, TrafficSignal>, edge: RoadEdge,
): { signal: TrafficSignal; group: SignalGroup } | null {
  const signal = signalByNode.get(edge.to);
  if (!signal) return null;
  let groups = groupCache.get(signal);
  if (!groups) {
    groups = new Map(signal.approaches.map(a => [a.edgeId, a.group]));
    groupCache.set(signal, groups);
  }
  const group = groups.get(edge.id) ?? groupForBearing(edge.bearing);
  return group === 'FREE' ? null : { signal, group };
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

/** Expected wait for a random arrival on a group with red share r of cycle C: r²·C/2. */
export function expectedSignalDelay(signal: TrafficSignal, group?: SignalGroup): number {
  const C = signal.cycleLength || 1;
  const green = signal.phases
    .filter(p => p.color !== 'RED' && (group === undefined || p.group === group))
    .reduce((s, p) => s + p.duration, 0);
  const share = group === undefined ? 0.5 : Math.min(1, Math.max(0, 1 - green / C));
  return share * share * C / 2;
}
