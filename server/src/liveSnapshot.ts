/**
 * The live map, built once per half-second for everyone instead of once per viewer:
 * vehicles grouped into ~2 km cells and pre-encoded as JSON, plus the city-wide parts
 * (signal phases, stats, conditions, road traffic). Requests only join ready-made
 * strings, and the /api/live/* endpoints are CDN-cacheable (Firebase Hosting caches them
 * for a second), so server work doesn't grow with the number of people watching.
 *
 * Vehicles are compact arrays: [id, lat, lng, km/h, bearing, type, flag]
 * (flag: 0 normal, 1 wrong way, 2 ran a red).
 */
import { getSimulationEngine, type BBox } from './simulationEngine.js';
import { getConditions } from './conditionsService.js';

/** Cell size in degrees (~2.2 km at Bangalore). The client uses the same grid. */
export const CELL_DEG = 0.02;
const REFRESH_MS = 500;
const TRAFFIC_MS = 3000;
/** Below this zoom vehicles are too small to matter; the traffic colours show the city. */
export const VEHICLE_MIN_ZOOM = 13.5;
const MAX_VEHICLES_PER_UPDATE = 4000;

interface Snapshot {
  at: number;
  /** City-wide fields as JSON without the outer braces */
  common: string;
  /** [[edgeId, level], …] */
  traffic: string;
  trafficAt: number;
  /** Cell key → encoded vehicles without the outer brackets, and how many */
  cells: Map<string, { json: string; count: number }>;
}

let snap: Snapshot | null = null;

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
    const flag = v.wrongWay ? 1 : v.violation ? 2 : 0;
    const enc = `[${JSON.stringify(v.id)},${v.lat},${v.lng},${Math.round(v.speed)},${Math.round(Number(v.bearing) || 0)},"${v.type}",${flag}]`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(enc);
  }
  const cells = new Map<string, { json: string; count: number }>();
  for (const [key, list] of groups) cells.set(key, { json: list.join(','), count: list.length });

  const signalStates: Record<string, [number, number]> = {};
  for (const s of engine.getSignals()) signalStates[s.id] = [s.currentPhaseIndex, Math.round(s.timer * 10) / 10];
  const common = JSON.stringify({ signalStates, stats: engine.getStats(), conditions: getConditions(), at: now }).slice(1, -1);

  const fresh = !snap || now - snap.trafficAt >= TRAFFIC_MS;
  const traffic = fresh ? JSON.stringify([...engine.getTraffic()].filter(([, level]) => level > 0)) : snap!.traffic;
  return { at: now, common, traffic, trafficAt: fresh ? now : snap!.trafficAt, cells };
}

/** The current snapshot (rebuilt at most every REFRESH_MS, on demand). */
export function snapshot(): Snapshot | null {
  if (!snap || Date.now() - snap.at >= REFRESH_MS) snap = build() ?? snap;
  return snap;
}

/** City-wide part as a JSON object. */
export function commonJson(): string | null {
  const s = snapshot();
  return s ? `{${s.common}}` : null;
}

export function trafficJson(): string | null {
  return snapshot()?.traffic ?? null;
}

/** Vehicles of one cell as a JSON array. */
export function cellJson(x: number, y: number): string | null {
  const s = snapshot();
  return s ? `[${s.cells.get(`${x}_${y}`)?.json ?? ''}]` : null;
}

/**
 * A full update for one viewer (WebSocket and /api/state), as a JSON string: vehicles in
 * the cells around the view, plus the city-wide part.
 */
export function updateJson(bbox: BBox | null, zoom: number, includeTraffic: boolean): string | null {
  const s = snapshot();
  if (!s) return null;
  const parts: string[] = [];
  if (bbox && zoom >= VEHICLE_MIN_ZOOM) {
    const [w, so, e, n] = bbox;
    const dx = (e - w) * 0.2, dy = (n - so) * 0.2;
    const [x0, y0] = cellOf(w - dx, so - dy), [x1, y1] = cellOf(e + dx, n + dy);
    let count = 0;
    for (let x = x0; x <= x1 && count < MAX_VEHICLES_PER_UPDATE; x++) {
      for (let y = y0; y <= y1 && count < MAX_VEHICLES_PER_UPDATE; y++) {
        const c = s.cells.get(`${x}_${y}`);
        if (c?.count) { parts.push(c.json); count += c.count; }
      }
    }
  }
  return `{"vehicles":[${parts.join(',')}],${s.common}${includeTraffic ? `,"traffic":${s.traffic}` : ''}}`;
}
