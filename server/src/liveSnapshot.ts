/**
 * The live map, built once per half-second for everyone instead of once per viewer, and
 * split so each device downloads only what changed. All /api/live/* answers are
 * CDN-cacheable (Firebase Hosting), so server work doesn't grow with the number of viewers.
 *
 *   common    every 1 s: stats + version numbers of the slower parts (sv, cv, pv, ta)
 *   cell/x/y  every 1 s: vehicles in a ~2 km cell, compact arrays
 *             [id, lat, lng, km/h, bearing, type, flag]
 *             (flag: 0 normal, 1 wrong way, 2 ran a red, 3 emergency vehicle on a run)
 *   signals   every ~5 s: [phase index, tenths of a second into it] per signal, in the order
 *             of signal-order/<sv> (sent once, kept on the device); devices advance the
 *             countdowns themselves in between
 *   traffic   full list [[edgeId, level], …]; traffic-delta: only what changed since the
 *             previous snapshot (ta), so a device already up to date gets a few bytes
 *   phases    signals whose phases differ from the cached road data (pv changes when they do)
 *   conditions (/api/conditions) are fetched only when cv changes
 */
import { getSimulationEngine } from './simulationEngine.js';
import { rulesOf, closedTurnsVersion } from './turnRules.js';
import type { SignalPhase } from './types.js';
import { getConditions } from './conditionsService.js';

/** Cell size in degrees (~2.2 km at Bangalore). The client uses the same grid. */
export const CELL_DEG = 0.02;
const REFRESH_MS = 500;
const TRAFFIC_MS = 3000;

interface Snapshot {
  at: number;
  /** City-wide fields as a JSON object */
  common: string;
  signals: string;
  /** Signal ids in the order of `signals`, and a short hash of that list */
  order: string;
  sv: string;
  phases: string;
  /** [[edgeId, level], …] and its time; the change from the previous traffic snapshot */
  traffic: string;
  trafficAt: number;
  trafficLevels: Map<string, number>;
  trafficDelta: string;
  /** Cell key → encoded vehicles without the outer brackets */
  cells: Map<string, { json: string; count: number }>;
}

let snap: Snapshot | null = null;

/** Short stable hash (FNV-1a) used as a version tag. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

export function cellOf(lng: number, lat: number): [number, number] {
  return [Math.floor(lng / CELL_DEG), Math.floor(lat / CELL_DEG)];
}

function build(): Snapshot | null {
  const engine = getSimulationEngine();
  if (!engine) return null;
  const now = Date.now();
  const groups = new Map<string, string[]>();
  for (const v of engine.getVehicles()) {
    const [x, y] = cellOf(v.lng, v.lat);
    const key = `${x}_${y}`;
    const flag = v.emergency ? 3 : v.wrongWay ? 1 : v.violation ? 2 : 0;
    const enc = `[${JSON.stringify(v.id)},${v.lat},${v.lng},${Math.round(v.speed)},${Math.round(Number(v.bearing) || 0)},"${v.type}",${flag}]`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(enc);
  }
  const cells = new Map<string, { json: string; count: number }>();
  for (const [key, list] of groups) cells.set(key, { json: list.join(','), count: list.length });

  const ids: string[] = [];
  const states: string[] = [];
  // Junctions whose phases differ from the cached road tiles (turn phases, new green times)
  const phaseSets: Record<string, SignalPhase[]> = {};
  for (const s of engine.getSignals()) {
    ids.push(s.id);
    states.push(`[${s.currentPhaseIndex},${Math.round(s.timer * 10)}]`);
    if (rulesOf(s.id)?.phases || engine.getSignalControl(s.id)?.plan) phaseSets[s.id] = s.phases;
  }
  const order = JSON.stringify(ids);
  const sv = snap && snap.order === order ? snap.sv : hash(order);
  const phases = JSON.stringify(phaseSets);
  const conditions = JSON.stringify(getConditions());

  const fresh = !snap || now - snap.trafficAt >= TRAFFIC_MS;
  let traffic = snap?.traffic ?? '[]', trafficAt = snap?.trafficAt ?? now;
  let trafficLevels = snap?.trafficLevels ?? new Map<string, number>(), trafficDelta = snap?.trafficDelta ?? '';
  if (fresh) {
    const next = new Map([...engine.getTraffic()].filter(([, level]) => level > 0));
    const set: [string, number][] = [];
    for (const [id, level] of next) if (trafficLevels.get(id) !== level) set.push([id, level]);
    const clear = [...trafficLevels.keys()].filter(id => !next.has(id));
    trafficDelta = JSON.stringify({ from: snap ? trafficAt : 0, at: now, set, clear });
    traffic = JSON.stringify([...next]);
    trafficLevels = next;
    trafficAt = now;
  }
  const common = JSON.stringify({
    stats: engine.getStats(), at: now,
    sv, cv: hash(conditions), pv: hash(phases), ta: trafficAt, ctv: closedTurnsVersion(),
  });
  return {
    at: now, common, signals: `[${states.join(',')}]`, order, sv, phases,
    traffic, trafficAt, trafficLevels, trafficDelta, cells,
  };
}

/** The current snapshot (rebuilt at most every REFRESH_MS, on demand). */
export function snapshot(): Snapshot | null {
  if (!snap || Date.now() - snap.at >= REFRESH_MS) snap = build() ?? snap;
  return snap;
}

export function commonJson(): string | null {
  return snapshot()?.common ?? null;
}

export function signalsJson(): string | null {
  return snapshot()?.signals ?? null;
}

/** The signal id list for version `sv` (null when the server's list has another version). */
export function signalOrderJson(sv: string): string | null {
  const s = snapshot();
  return s && s.sv === sv ? s.order : null;
}

export function phasesJson(): string | null {
  return snapshot()?.phases ?? null;
}

export function trafficJson(): string | null {
  return snapshot()?.traffic ?? null;
}

export function trafficDeltaJson(): string | null {
  return snapshot()?.trafficDelta ?? null;
}

/** Vehicles of one cell as a JSON array. */
export function cellJson(x: number, y: number): string | null {
  const s = snapshot();
  return s ? `[${s.cells.get(`${x}_${y}`)?.json ?? ''}]` : null;
}
