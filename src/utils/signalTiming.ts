/**
 * What a signal shows each direction, now and next — for the live signal card and the
 * "switch off your engine" advice. Works from the signal's fixed phase sequence and its
 * live phase index and timer.
 */
import type { TrafficSignal } from '../types';

export interface GroupTiming {
  light: 'GREEN' | 'YELLOW' | 'RED';
  /** Seconds until this light changes */
  changesIn: number;
  /** Length of this group's green, amber and red in one cycle (s) */
  green: number;
  yellow: number;
  red: number;
  /** All-red clearance in each change (s), part of red: every direction stops while the junction empties */
  allRed: number;
}

/** Turns a turn-based phase plan lists for one approach, in display order. */
export const TURN_ORDER = ['left', 'straight', 'right', 'uturn'] as const;
export function turnsServed(sig: TrafficSignal, edgeId: string): string[] {
  const all = new Set(sig.phases.flatMap(p => p.moves ?? []));
  return TURN_ORDER.filter(t => all.has(`${edgeId}:${t}`));
}

/**
 * Timing for phase group `group` (or, on turn-based phases, for movement `move` =
 * "<approach edge id>:<turn>"), `elapsed` seconds after the signal's last update.
 */
export function groupTiming(sig: TrafficSignal, group: string, elapsed = 0, move?: string): GroupTiming {
  const phases = sig.phases;
  const ours = (p: TrafficSignal['phases'][number]) => move && p.moves ? p.moves.includes(move) : p.group === group;
  const cycle = phases.reduce((t, p) => t + p.duration, 0) || 1;
  const green = phases.filter(p => ours(p) && p.color === 'GREEN').reduce((t, p) => t + p.duration, 0);
  const yellow = phases.filter(p => ours(p) && p.color === 'YELLOW').reduce((t, p) => t + p.duration, 0);

  // Walk forward from the live state by the time elapsed since the update
  let i = sig.currentPhaseIndex;
  let t = sig.timer + elapsed;
  for (let guard = 0; t >= phases[i].duration && guard < 100; guard++) {
    t -= phases[i].duration;
    i = (i + 1) % phases.length;
  }
  const p = phases[i];
  const light: GroupTiming['light'] = ours(p) && p.color !== 'RED' ? (p.color === 'GREEN' ? 'GREEN' : 'YELLOW') : 'RED';

  // Time until the light changes: to the end of our green/yellow, or until our green starts
  let changesIn = p.duration - t;
  let j = (i + 1) % phases.length;
  for (let guard = 0; guard < phases.length; guard++) {
    const next = phases[j];
    const nextLight = ours(next) && next.color !== 'RED' ? (next.color === 'GREEN' ? 'GREEN' : 'YELLOW') : 'RED';
    if (nextLight !== light) break;
    changesIn += next.duration;
    j = (j + 1) % phases.length;
  }
  // Short all-red phases are clearance; long ones (pedestrian crossings) are not
  const allRed = Math.max(0, ...phases.filter(q => q.group === 'ALL' && q.duration <= 6).map(q => q.duration));
  return { light, changesIn: Math.max(0, Math.round(changesIn)), green, yellow, red: Math.max(0, cycle - green - yellow), allRed };
}

export function formatSeconds(s: number): string {
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim() : `${s} s`;
}
