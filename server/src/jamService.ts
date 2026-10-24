/**
 * Intentional jams: an operator picks a spot on a road and the live simulation gets a
 * standing queue there (both directions of a two-way road), plus a slow bottleneck at the
 * spot, until it expires or is removed. Used to study how a jam spreads to neighbouring
 * junctions and how signal control and rerouting cope — a design and training tool.
 */
import type { RoadEdge } from './types.js';
import { getSimulationEngine } from './simulationEngine.js';
import { getGraphIndex, nearestRoadSegment, type GraphIndex } from './pathfindingService.js';
import { getGraph } from './graphService.js';

export type JamSeverity = 'stopped' | 'slow';

export interface Jam {
  id: string;
  lat: number;
  lng: number;
  road: string;
  severity: JamSeverity;
  /** Queue length placed behind the spot, per direction (m) */
  metres: number;
  edgeIds: string[];
  vehicles: number;
  createdAt: number;
  expiresAt: number;
  createdBy: string;
}

/** Speed multiplier at the jam spot: 'stopped' leaves a crawl so the queue still moves a little. */
const SEVERITY_SPEED: Record<JamSeverity, number> = { stopped: 0.04, slow: 0.25 };
const MAX_JAMS = 20;

const jams = new Map<string, Jam>();
/** Edge id → speed multiplier (lowest of the jams on it) */
let effects = new Map<string, number>();
let counter = 0;
let inEdgesCache: { index: GraphIndex; map: Map<string, RoadEdge[]> } | null = null;

function inEdges(index: GraphIndex): Map<string, RoadEdge[]> {
  if (inEdgesCache?.index === index) return inEdgesCache.map;
  const map = new Map<string, RoadEdge[]>();
  for (const e of index.edgeList) (map.get(e.to) ?? map.set(e.to, []).get(e.to)!).push(e);
  inEdgesCache = { index, map };
  return map;
}

function turn(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function rebuild(): void {
  const now = Date.now();
  for (const [id, j] of jams) if (j.expiresAt <= now) jams.delete(id);
  const next = new Map<string, number>();
  for (const j of jams.values()) {
    const f = SEVERITY_SPEED[j.severity];
    for (const id of j.edgeIds) next.set(id, Math.min(next.get(id) ?? 1, f));
  }
  effects = next;
}

/** Speed multiplier from intentional jams (1 = none). Called by the simulation per road. */
export function jamSpeedFactor(edgeId: string): number {
  return effects.size === 0 ? 1 : effects.get(edgeId) ?? 1;
}

export function listJams(): Jam[] {
  rebuild();
  return [...jams.values()];
}

export function removeJam(id: string): boolean {
  const ok = jams.delete(id);
  rebuild();
  return ok;
}

/** Distance along an edge's geometry to the point nearest (lat, lng). */
function progressAlong(e: RoadEdge, lat: number, lng: number): number {
  const g = e.geometry;
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 111320;
  let best = Infinity, bestAt = 0, run = 0;
  for (let i = 1; i < g.length; i++) {
    const ax = (g[i - 1].lng - lng) * kx, ay = (g[i - 1].lat - lat) * ky;
    const bx = (g[i].lng - lng) * kx, by = (g[i].lat - lat) * ky;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    const t = len > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (len * len))) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) { best = d; bestAt = run + t * len; }
    run += len;
  }
  return run > 0 ? (bestAt / run) * e.length : e.length / 2;
}

/** Edges leading back from `e` along the same road (straightest feeder), up to `metres`. */
function upstream(e: RoadEdge, metres: number, index: GraphIndex): RoadEdge[] {
  const chain: RoadEdge[] = [];
  const seen = new Set([e.id]);
  let cur = e, total = 0;
  const ins = inEdges(index);
  while (total < metres && chain.length < 40) {
    const feeder = (ins.get(cur.from) ?? [])
      .filter(x => x.from !== cur.to && !seen.has(x.id))
      .sort((a, b) => turn(a.bearing, cur.bearing) - turn(b.bearing, cur.bearing))[0];
    if (!feeder || turn(feeder.bearing, cur.bearing) > 60) break;
    chain.unshift(feeder);
    seen.add(feeder.id);
    total += feeder.length;
    cur = feeder;
  }
  return chain;
}

/** A few edges onward from `e`, so queued vehicles have somewhere to go once it clears. */
function onward(e: RoadEdge, index: GraphIndex): RoadEdge[] {
  const out: RoadEdge[] = [];
  let cur = e;
  for (let i = 0; i < 4; i++) {
    const n = (index.outEdges.get(cur.to) ?? [])
      .filter(x => x.to !== cur.from)
      .sort((a, b) => turn(a.bearing, cur.bearing) - turn(b.bearing, cur.bearing))[0];
    if (!n) break;
    out.push(n);
    cur = n;
  }
  return out;
}

/**
 * Jam the road nearest (lat, lng): a bottleneck on that segment and a bumper-to-bumper
 * queue `metres` long behind it in each direction.
 */
export async function createJam(input: {
  lat: number; lng: number; metres?: number; minutes?: number; severity?: JamSeverity; createdBy: string;
}): Promise<Jam> {
  const engine = getSimulationEngine();
  if (!engine) throw new Error('Simulation is not running');
  rebuild();
  if (jams.size >= MAX_JAMS) throw new Error(`At most ${MAX_JAMS} jams at a time — remove one first`);
  const { graph, signals } = await getGraph();
  const index = getGraphIndex(graph, signals);
  const seg = nearestRoadSegment(index, input.lat, input.lng, 80);
  if (!seg) throw new Error('No road within 80 m of that spot');
  const metres = Math.min(1500, Math.max(50, input.metres ?? 400));
  const severity: JamSeverity = input.severity === 'slow' ? 'slow' : 'stopped';
  const minutes = Math.min(120, Math.max(1, input.minutes ?? 20));

  let placed = 0;
  for (const id of seg.edgeIds) {
    const e = index.edges.get(id);
    if (!e) continue;
    const at = progressAlong(e, input.lat, input.lng);
    const back = upstream(e, metres, index);
    const route = [...back, e, ...onward(e, index)].map(x => x.id);
    const ei = back.length;
    // Bumper to bumper by each vehicle's real length, back from the spot
    placed += engine.addQueue(() => ({ route, endIndex: ei, endProgress: at }), metres, e.lanes).length;
  }
  const jam: Jam = {
    id: `jam${++counter}`, lat: input.lat, lng: input.lng, road: seg.edge.name || 'Unnamed road',
    severity, metres, edgeIds: seg.edgeIds, vehicles: placed,
    createdAt: Date.now(), expiresAt: Date.now() + minutes * 60_000, createdBy: input.createdBy,
  };
  jams.set(jam.id, jam);
  rebuild();
  return jam;
}

// Drop expired jams now and then even if nobody asks
setInterval(rebuild, 30_000).unref?.();
