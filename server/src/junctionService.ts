/**
 * Junctions for traffic police: every signalised junction with a permanent ID, its
 * approaches and neighbours, live queues and arrivals, a recommended timing plan and
 * advice for the junctions next to it.
 *
 * Officers read this view and apply changes in their own signal system. Controllers can
 * also try changes in the simulation: holding a green, or a new timing plan. With
 * coordination on, the neighbours react: downstream junctions open a green wave for the
 * released traffic, and upstream junctions feeding the held (red) approaches shorten
 * their green towards it so queues don't spill back into them.
 */
import type { RoadEdge, TrafficSignal, SignalArm, Place } from './types.js';
import { haversineMetres } from './osmGraph.js';
import type { GraphIndex } from './pathfindingService.js';
import { getSimulationEngine } from './simulationEngine.js';
import { approachState } from './signalTiming.js';
import { getDb } from './firebaseClient.js';

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Saturation flow per lane (PCU/h) — IRC:93 urban value, rounded. */
const SATURATION_PER_LANE = 1800;
/** Lost time per phase change: yellow + all-red (s). */
const LOST_PER_PHASE = 5;
/** Cycle limits used by Bangalore signals (s). */
const MIN_CYCLE = 60;
const MAX_CYCLE = 180;
const MIN_GREEN = 15;
/** Simulated vehicles each stand for this many real ones in arrival rates (simulationEngine DEMAND_SCALE). */
const DEMAND_SCALE_FOR_QUEUES = 6;
/** Largest cycle change one recommendation suggests (share of the current cycle). */
const MAX_STEP = 0.3;
/** Neighbour search: follow a road at most this far to the next junction (m). */
const MAX_LINK_METRES = 1500;
/** Queue reaching this share of the road to the upstream junction risks blocking it. */
const SPILLBACK_SHARE = 0.75;
/** Upstream gating: shorten the feeding green to this share while a hold lasts. */
const GATE_FACTOR = 0.6;
/** Downstream green-wave holds last at most this long (s). */
const WAVE_HOLD_MAX = 60;
/** Nobody should wait longer than this at one signal (s) — Bangalore drivers already face ~5–6 min. */
export const MAX_WAIT_S = 300;
/** Vehicles leaving per lane per second of green (≈ 1800 per hour). */
const DISCHARGE_PER_LANE_S = 0.5;

// ── Network of junctions ─────────────────────────────────────────────────────

/** A road from one junction to the next (upstream U → downstream J). */
export interface JunctionLink {
  from: string;
  to: string;
  /** Group at U whose green sends traffic towards J */
  fromGroup: string;
  /** Approach edge at J and its group there */
  approachEdgeId: string;
  toGroup: string;
  metres: number;
  /** Free-flow travel time (s) */
  seconds: number;
  road: string;
  /** Direction traffic leaves U on this road (degrees) */
  departure: number;
}

interface JunctionNet {
  signals: Map<string, TrafficSignal>;
  upstream: Map<string, JunctionLink[]>;
  downstream: Map<string, JunctionLink[]>;
}

let net: JunctionNet | null = null;
let indexRef: GraphIndex | null = null;

function groupFor(arrival: number, axis: number): 'A' | 'B' {
  const rel = ((arrival - axis) % 180 + 180) % 180;
  return rel < 45 || rel >= 135 ? 'A' : 'B';
}

/** Direction of travel on the first stretch of an edge (as it leaves its start node). */
function departureBearing(e: RoadEdge): number {
  const g = e.geometry;
  if (g.length < 2) return e.bearing;
  const y = (g[1].lng - g[0].lng) * Math.cos(g[0].lat * Math.PI / 180);
  const x = g[1].lat - g[0].lat;
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function turn(a: number, b: number): number {
  return Math.abs(((b - a + 540) % 360) - 180);
}

/** Builds the junction-to-junction links by following each approach road upstream. */
export function initJunctions(index: GraphIndex, signals: TrafficSignal[], placeList: Place[] = []): void {
  indexRef = index;
  indexPlaces(placeList);
  const inEdges = new Map<string, RoadEdge[]>();
  for (const e of index.edgeList) (inEdges.get(e.to) ?? inEdges.set(e.to, []).get(e.to)!).push(e);

  const byId = new Map(signals.map(s => [s.id, s]));
  const upstream = new Map<string, JunctionLink[]>();
  const downstream = new Map<string, JunctionLink[]>();

  for (const j of signals) {
    const members = new Set(j.nodeIds ?? [j.nodeId]);
    for (const a of j.approaches) {
      if (a.group === 'FREE') continue;
      let edge = index.edges.get(a.edgeId);
      let metres = 0, seconds = 0;
      const seen = new Set<string>();
      while (edge && metres < MAX_LINK_METRES && !seen.has(edge.id)) {
        seen.add(edge.id);
        metres += edge.length;
        seconds += edge.length / (Math.max(10, edge.speedLimit) / 3.6);
        const u = index.signalByNode.get(edge.from);
        if (u && !members.has(edge.from) && u.id !== j.id) {
          const link: JunctionLink = {
            from: u.id, to: j.id,
            // Straight-through traffic at U leaves in the direction it arrived: same group
            fromGroup: groupFor(departureBearing(edge), u.axis ?? 0),
            approachEdgeId: a.edgeId, toGroup: a.group,
            metres: Math.round(metres), seconds: Math.round(seconds),
            road: index.edges.get(a.edgeId)?.name || edge.name || '',
            departure: Math.round(departureBearing(edge)),
          };
          (upstream.get(j.id) ?? upstream.set(j.id, []).get(j.id)!).push(link);
          (downstream.get(u.id) ?? downstream.set(u.id, []).get(u.id)!).push(link);
          break;
        }
        // Keep following the same road backwards (straightest predecessor, no U-turns)
        const cur: RoadEdge = edge;
        const preds = (inEdges.get(cur.from) ?? []).filter(p => p.from !== cur.to);
        edge = preds.sort((p, q) => turn(p.bearing, cur.bearing) - turn(q.bearing, cur.bearing))[0];
      }
    }
  }
  net = { signals: byId, upstream, downstream };
  const links = [...upstream.values()].reduce((n, l) => n + l.length, 0);
  console.log(`[Junctions] ${signals.length} junctions, ${links} links between neighbours`);

  // Describe every direction of traffic in words, for drivers and police alike
  for (const j of signals) {
    j.arms = describeArms(j, index, inEdges);
    const members = new Set(j.nodeIds ?? [j.nodeId]);
    exitsBySignal.set(j.id, describeExits(j, members, index, inEdges));
    feedersBySignal.set(j.id, new Map(j.approaches
      .filter(a => a.group !== 'FREE')
      .map(a => [a.edgeId, findFeeders(index.edges.get(a.edgeId), members, index, inEdges)])));
    mergesBySignal.set(j.id, findMerges(j.id, members, index, inEdges));
    chainsBySignal.set(j.id, new Map(j.approaches
      .filter(a => a.group !== 'FREE' && index.edges.has(a.edgeId))
      .map(a => [a.edgeId, upstreamChain(index.edges.get(a.edgeId)!, members, index, inEdges)])));
  }
}

// ── Directions in words ──────────────────────────────────────────────────────

/** How far to follow a road to name the next / previous junction for directions (m). */
const NAME_SEARCH_METRES = 5000;
/** Feeders: roads joining an approach within this distance of the stop line (m). */
const FEEDER_METRES = 1200;
/** Merges: roads joining an exit within this distance after the junction (m). */
const MERGE_METRES = 500;

let places: Place[] = [];
const placeGrid = new Map<string, Place[]>();
const PLACE_CELL = 0.02; // ~2 km

function indexPlaces(list: Place[]): void {
  places = list;
  placeGrid.clear();
  for (const p of list) {
    const key = `${Math.floor(p.lat / PLACE_CELL)},${Math.floor(p.lng / PLACE_CELL)}`;
    (placeGrid.get(key) ?? placeGrid.set(key, []).get(key)!).push(p);
  }
}

/** Nearest neighbourhood name within `maxMetres`, e.g. "Nagasandra". */
export function nearestPlace(lat: number, lng: number, maxMetres = 2500): string | undefined {
  if (places.length === 0) return undefined;
  const cy = Math.floor(lat / PLACE_CELL), cx = Math.floor(lng / PLACE_CELL);
  let best: { name: string; d: number } | undefined;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    for (const p of placeGrid.get(`${cy + dy},${cx + dx}`) ?? []) {
      const d = haversineMetres({ lat, lng }, p);
      if (d <= maxMetres && (!best || d < best.d)) best = { name: p.name, d };
    }
  }
  return best?.name;
}

function km(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

/**
 * Follows a road (straightest continuation, no U-turns) forwards or backwards until it
 * reaches another signalised junction ("Yeshwanthpur Circle (2.1 km)"). Otherwise names
 * the neighbourhood where the road leads ("Nagasandra"), or the first new road met.
 */
function followRoad(
  start: RoadEdge, index: GraphIndex, inEdges: Map<string, RoadEdge[]>, forward: boolean, skip: Set<string>,
): string {
  let edge: RoadEdge | undefined = start;
  let metres = 0;
  let newRoad = '';
  let lastNode = forward ? start.to : start.from;
  const seen = new Set<string>();
  while (edge && metres < NAME_SEARCH_METRES && !seen.has(edge.id)) {
    seen.add(edge.id);
    metres += edge.length;
    const node = forward ? edge.to : edge.from;
    lastNode = node;
    if (!newRoad && edge.name && edge.name !== start.name) newRoad = edge.name;
    const sig = index.signalByNode.get(node);
    if (sig && !skip.has(node)) return `${sig.name ?? sig.id} (${km(metres)})`;
    const cur: RoadEdge = edge;
    const nexts = forward
      ? (index.outEdges.get(cur.to) ?? []).filter(e => e.to !== cur.from)
      : (inEdges.get(cur.from) ?? []).filter(e => e.from !== cur.to);
    edge = nexts.sort((p, q) => turn(p.bearing, cur.bearing) - turn(q.bearing, cur.bearing))[0];
    if (edge && turn(edge.bearing, cur.bearing) > 60) break; // the road ends here
  }
  const end = index.nodes.get(lastNode);
  const place = end && metres > 600 ? nearestPlace(end.lat, end.lng) : undefined;
  if (place) return newRoad ? `${place} (via ${newRoad})` : place;
  return newRoad;
}

/** Offset a point by metres east/north. */
function offset(lat: number, lng: number, de: number, dn: number): { lat: number; lng: number } {
  const cosLat = Math.cos(lat * Math.PI / 180);
  return {
    lat: Math.round((lat + dn / 111320) * 1e6) / 1e6,
    lng: Math.round((lng + de / (111320 * cosLat)) * 1e6) / 1e6,
  };
}

/** Unit vector (east, north) of the segment a → b. */
function unit(a: { lat: number; lng: number }, b: { lat: number; lng: number }): [number, number] {
  const cosLat = Math.cos(b.lat * Math.PI / 180);
  const east = (b.lng - a.lng) * cosLat * 111320, north = (b.lat - a.lat) * 111320;
  const len = Math.hypot(east, north) || 1;
  return [east / len, north / len];
}

/**
 * Signal head for an approach, where drivers look for it: on the far side of the
 * junction, across from the stop line — at the left kerb of the road straight ahead,
 * a few metres in, facing the waiting traffic (India drives on the left, so a two-way
 * road's lanes are on its left half). Without a straight exit, 12 m past the stop line.
 */
function signalHeadPosition(e: RoadEdge, straight: RoadEdge | undefined, index: GraphIndex, crossHalf: number): { lat: number; lng: number } {
  const g = e.geometry;
  const line = g[g.length - 1], prev = g.length >= 2 ? g[g.length - 2] : line;
  const [ue, un] = unit(prev, line);
  if (straight && straight.geometry.length >= 2 && turn(departureBearing(straight), e.bearing) < 50) {
    const sg = straight.geometry;
    const [xe, xn] = unit(sg[0], sg[1]);
    const twoWay = index.edges.has(`${straight.to}-${straight.from}`);
    const left = (twoWay ? straight.lanes * 3.2 : straight.lanes * 1.6) + 1.5;
    // Where the exit starts at the stop line itself (one-node junction), go past the cross road
    const along = Math.min(straight.from === e.to ? Math.max(6, crossHalf + 3) : 6, straight.length * 0.5);
    // Left of travel (east, north) is (-north, east)
    return offset(sg[0].lat, sg[0].lng, xe * along - xn * left, xn * along + xe * left);
  }
  const twoWay = index.edges.has(`${e.to}-${e.from}`);
  const left = (twoWay ? e.lanes * 3.2 : e.lanes * 1.6) + 1.5;
  const past = Math.max(12, crossHalf + 4);
  return offset(line.lat, line.lng, ue * past - un * left, un * past + ue * left);
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export function compass(bearing: number): string {
  return COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

/**
 * Each approach as "Tumkur Road from the south-east, heading north-west towards
 * <next junction>": straight ahead is the exit with the smallest turn.
 */
function describeArms(j: TrafficSignal, index: GraphIndex, inEdges: Map<string, RoadEdge[]>): SignalArm[] {
  if (!net) return [];
  const members = new Set(j.nodeIds ?? [j.nodeId]);
  const exits: RoadEdge[] = [];
  for (const n of members) for (const e of index.outEdges.get(n) ?? []) if (!members.has(e.to)) exits.push(e);
  const downs = net.downstream.get(j.id) ?? [];
  const ups = net.upstream.get(j.id) ?? [];
  const arms: SignalArm[] = [];
  for (const a of j.approaches) {
    if (a.group === 'FREE') continue;
    const e = index.edges.get(a.edgeId);
    const straight = exits
      .filter(x => x.to !== e?.from)
      .sort((x, y) => turn(departureBearing(x), a.bearing) - turn(departureBearing(y), a.bearing))[0];
    const wave = downs
      .filter(d => turn(d.departure, a.bearing) < 45)
      .sort((x, y) => turn(x.departure, a.bearing) - turn(y.departure, a.bearing))[0];
    const towards = wave ? `${net.signals.get(wave.to)?.name ?? wave.to} (${wave.metres} m)`
      : (straight && followRoad(straight, index, inEdges, true, members)) || straight?.name || '';
    const up = ups.find(u => u.approachEdgeId === a.edgeId);
    const fromJunction = up ? `${net.signals.get(up.from)?.name ?? up.from} (${up.metres} m)`
      : (e && followRoad(e, index, inEdges, false, members)) || undefined;
    // Half the width of the road crossing this approach (3.2 m lanes, per direction)
    const crossHalf = Math.max(0, ...j.approaches
      .filter(o => o.group !== 'FREE' && turn(o.bearing, a.bearing) > 45 && turn(o.bearing, a.bearing) < 135)
      .map(o => (index.edges.get(o.edgeId)?.lanes ?? 1) * 3.2));
    const head = e ? signalHeadPosition(e, straight, index, crossHalf) : index.nodes.get(j.nodeId)!;
    arms.push({
      edgeId: a.edgeId, group: a.group, road: e?.name || 'Unnamed road',
      from: compass(a.bearing + 180), heading: compass(a.bearing), towards,
      fromJunction, lanes: e?.lanes ?? 1, lat: head.lat, lng: head.lng,
    });
  }
  return arms;
}

// ── Exits, feeders (flyovers, ramps) and merges ──────────────────────────────

/** Where traffic can leave a junction. */
export interface JunctionExit {
  edgeId: string;
  road: string;
  heading: string;
  towards: string;
}

/** A road joining an approach before the stop line, or an exit just after the junction. */
export interface FeederRoad {
  edgeId: string;
  road: string;
  kind: 'flyover' | 'ramp' | 'road';
  /** Metres from the stop line (feeders) or from the junction (merges) */
  metres: number;
  /** Where its traffic comes from, e.g. "Nagasandra" */
  from: string;
  /** Merges: the exit road it joins */
  joins?: string;
}

const exitsBySignal = new Map<string, JunctionExit[]>();
/** Each approach's road upstream (edge ids, nearest first, ≤ 1.5 km): where its queue can reach */
const chainsBySignal = new Map<string, Map<string, string[]>>();
const CHAIN_METRES = 1500;

function upstreamChain(approach: RoadEdge, members: Set<string>, index: GraphIndex, inEdges: Map<string, RoadEdge[]>): string[] {
  const chain: string[] = [approach.id];
  let edge: RoadEdge | undefined = approach;
  let metres = approach.length;
  while (edge && metres < CHAIN_METRES) {
    if (index.signalByNode.get(edge.from) && !members.has(edge.from)) break; // previous junction
    const cur: RoadEdge = edge;
    const preds = (inEdges.get(cur.from) ?? []).filter(p => p.from !== cur.to && !members.has(p.from));
    edge = preds.sort((p, q) => turn(p.bearing, cur.bearing) - turn(q.bearing, cur.bearing))[0];
    if (!edge || turn(edge.bearing, cur.bearing) > 60 || chain.includes(edge.id)) break;
    chain.push(edge.id);
    metres += edge.length;
  }
  return chain;
}
const feedersBySignal = new Map<string, Map<string, FeederRoad[]>>();
const mergesBySignal = new Map<string, FeederRoad[]>();

function kindOf(e: RoadEdge): FeederRoad['kind'] {
  return e.elevated ? 'flyover' : e.roadType === 'link' ? 'ramp' : 'road';
}

/** Feeders worth showing: flyovers, ramps and anything bigger than a residential lane. */
function significant(e: RoadEdge): boolean {
  return !!e.elevated || !['residential', 'living_street', 'service'].includes(e.roadType);
}

function describeExits(j: TrafficSignal, members: Set<string>, index: GraphIndex, inEdges: Map<string, RoadEdge[]>): JunctionExit[] {
  const exits: JunctionExit[] = [];
  for (const n of members) {
    for (const e of index.outEdges.get(n) ?? []) {
      if (members.has(e.to)) continue;
      exits.push({
        edgeId: e.id, road: e.name || 'Unnamed road', heading: compass(departureBearing(e)),
        towards: followRoad(e, index, inEdges, true, members) || e.name || '',
      });
    }
  }
  return exits;
}

/** Where a flyover begins: walks back along elevated road and names that neighbourhood. */
function flyoverOrigin(fly: RoadEdge, members: Set<string>, index: GraphIndex, inEdges: Map<string, RoadEdge[]>): string {
  let edge = fly;
  const seen = new Set<string>();
  for (;;) {
    seen.add(edge.id);
    const cur = edge;
    const prev = (inEdges.get(cur.from) ?? []).find(p => p.elevated && !seen.has(p.id) && turn(p.bearing, cur.bearing) <= 45);
    if (!prev) break;
    edge = prev;
  }
  const start = index.nodes.get(edge.from);
  const place = start && nearestPlace(start.lat, start.lng, 3000);
  return place ? `${place} (flyover starts there)` : followRoad(fly, index, inEdges, false, members) || compass(fly.bearing + 180);
}

/**
 * What a feeding branch really is: walks back along it (straightest predecessor, up to
 * 800 m) past short unnamed links, so a flyover landing on a slip road is still reported
 * as the flyover — with where its traffic comes from.
 */
function branchIdentity(
  start: RoadEdge, members: Set<string>, index: GraphIndex, inEdges: Map<string, RoadEdge[]>,
): { road: string; kind: FeederRoad['kind']; from: string } {
  let edge: RoadEdge | undefined = start;
  let metres = 0;
  let named: RoadEdge | undefined;
  const seen = new Set<string>();
  while (edge && metres < 800 && !seen.has(edge.id)) {
    seen.add(edge.id);
    if (edge.elevated) {
      return { road: edge.name || 'Flyover', kind: 'flyover', from: flyoverOrigin(edge, members, index, inEdges) };
    }
    if (!named && edge.name) named = edge;
    metres += edge.length;
    const cur: RoadEdge = edge;
    const preds = (inEdges.get(cur.from) ?? []).filter(p => p.from !== cur.to);
    // A flyover landing beside the ground road: report the flyover
    const fly = preds.find(p => p.elevated && turn(p.bearing, cur.bearing) <= 45);
    if (fly) {
      return { road: fly.name || 'Flyover', kind: 'flyover', from: flyoverOrigin(fly, members, index, inEdges) };
    }
    edge = preds.sort((p, q) => turn(p.bearing, cur.bearing) - turn(q.bearing, cur.bearing))[0];
    if (edge && turn(edge.bearing, cur.bearing) > 70) break;
  }
  const base = named ?? start;
  return {
    road: base.name || (start.roadType === 'link' ? 'Slip road' : 'Unnamed road'),
    kind: kindOf(start),
    from: followRoad(base, index, inEdges, false, members) || compass(start.bearing + 180),
  };
}

/** Roads that join an approach within FEEDER_METRES of the stop line (walking upstream). */
function findFeeders(
  approach: RoadEdge | undefined, members: Set<string>, index: GraphIndex, inEdges: Map<string, RoadEdge[]>,
): FeederRoad[] {
  if (!approach) return [];
  const feeders: FeederRoad[] = [];
  const seen = new Set<string>([approach.id]);
  const stack: { edge: RoadEdge; dist: number }[] = [{ edge: approach, dist: 0 }];
  while (stack.length > 0 && feeders.length < 12) {
    const { edge, dist } = stack.pop()!;
    const reach = dist + edge.length;
    const sig = index.signalByNode.get(edge.from);
    if (sig && !members.has(edge.from)) continue; // another junction: its own approaches
    const preds = (inEdges.get(edge.from) ?? []).filter(p => p.from !== edge.to && !members.has(p.from) && !seen.has(p.id));
    for (const p of preds) {
      seen.add(p.id);
      if (preds.length > 1 && significant(p)) {
        feeders.push({ edgeId: p.id, metres: Math.round(reach), ...branchIdentity(p, members, index, inEdges) });
      }
      if (reach + p.length <= FEEDER_METRES && significant(p)) stack.push({ edge: p, dist: reach });
    }
  }
  return feeders;
}

/** Roads joining any exit within MERGE_METRES after the junction (e.g. a flyover landing). */
function findMerges(id: string, members: Set<string>, index: GraphIndex, inEdges: Map<string, RoadEdge[]>): FeederRoad[] {
  const merges: FeederRoad[] = [];
  for (const exit of exitsBySignal.get(id) ?? []) {
    let edge = index.edges.get(exit.edgeId);
    let metres = 0;
    const seen = new Set<string>();
    while (edge && metres < MERGE_METRES && !seen.has(edge.id)) {
      seen.add(edge.id);
      metres += edge.length;
      if (index.signalByNode.get(edge.to) && !members.has(edge.to)) break;
      const cur: RoadEdge = edge;
      for (const m of inEdges.get(cur.to) ?? []) {
        if (m.id === cur.id || members.has(m.from) || m.from === (index.outEdges.get(cur.to) ?? [])[0]?.to || !significant(m)) continue;
        if (merges.some(x => x.edgeId === m.id)) continue;
        merges.push({ edgeId: m.id, metres: Math.round(metres), joins: exit.road, ...branchIdentity(m, members, index, inEdges) });
      }
      const nexts = (index.outEdges.get(cur.to) ?? []).filter(e => e.to !== cur.from);
      edge = nexts.sort((p, q) => turn(p.bearing, cur.bearing) - turn(q.bearing, cur.bearing))[0];
    }
  }
  return merges;
}

/** Exit descriptions for a junction (used to label movement counts). */
export function junctionExits(id: string): JunctionExit[] {
  return exitsBySignal.get(id) ?? [];
}

// ── Live view and recommendations ────────────────────────────────────────────

export interface ApproachView {
  edgeId: string;
  road: string;
  group: string;
  bearing: number;
  lanes: number;
  light: 'RED' | 'YELLOW' | 'GREEN';
  queueVehicles: number;
  queueMetres: number;
  arrivalsPerHour: number;
  /** Upstream junction this road comes from */
  from?: { id: string; name: string; metres: number };
  /** "from the south-east, towards Yeshwanthpur" */
  direction: string;
  /** Physical (simulated) queue that discharges at the stop line */
  queueAgents: number;
  /** Estimated wait for the last vehicle in the queue (s), and whether it breaks MAX_WAIT_S */
  waitSeconds: number;
  overLimit: boolean;
  /** Roads (flyovers, ramps…) feeding this approach before the stop line, with live flow */
  feeders: (FeederRoad & { arrivalsPerHour: number })[];
}

export interface JunctionSummary {
  id: string;
  name: string;
  lat: number;
  lng: number;
  status: 'ok' | 'busy' | 'critical';
  /** 0–1+: worst of saturation and queue spillback */
  score: number;
  queueVehicles: number;
  cycle: number;
  controlled: boolean;
}

export interface JunctionDetail extends JunctionSummary {
  axis: number;
  phase: { index: number; group: string; color: string; timer: number; duration: number };
  phases: { group: string; color: string; duration: number }[];
  greens: Record<string, number>;
  approaches: ApproachView[];
  recommendation: {
    cycle: number;
    greens: Record<string, number>;
    /** Flow ratio per group and total (Webster's Y); ≥ 0.9 means oversaturated */
    flowRatio: Record<string, number>;
    saturation: number;
    summary: string;
  };
  advice: string[];
  /** Roads joining the exits just after the junction (e.g. a flyover landing) */
  merges: (FeederRoad & { arrivalsPerHour: number })[];
  neighbours: {
    upstream: { id: string; name: string; road: string; metres: number; seconds: number; toGroup: string }[];
    downstream: { id: string; name: string; road: string; metres: number; seconds: number; fromGroup: string }[];
  };
  control: ReturnType<NonNullable<ReturnType<typeof getSimulationEngine>>['getSignalControl']> | null;
}

/**
 * Seconds the last vehicle in a queue waits: until its group's green, plus a full cycle
 * for every extra green the queue needs to clear.
 */
function lastVehicleWait(s: TrafficSignal, group: string, queue: number, lanes: number): number {
  const green = s.phases.filter(p => p.group === group && p.color === 'GREEN').reduce((t, p) => t + p.duration, 0);
  if (green === 0) return 0;
  const C = s.cycleLength;
  const red = Math.max(0, C - green - 3);
  if (queue <= 0) return 0;
  const perCycle = green * Math.max(1, lanes) * DISCHARGE_PER_LANE_S;
  const cycles = Math.ceil(queue / perCycle);
  return red + (cycles - 1) * C;
}

/**
 * Adds each road's live arrival rate (real vehicles per hour). The same road reached
 * through two merge points is listed once (its busiest branch).
 */
function withFlow(roads: FeederRoad[]): (FeederRoad & { arrivalsPerHour: number })[] {
  const engine = getSimulationEngine();
  if (!engine || roads.length === 0) return [];
  const stats = engine.getApproachStats(roads.map(r => r.edgeId));
  const best = new Map<string, FeederRoad & { arrivalsPerHour: number }>();
  for (const r of roads) {
    const withRate = { ...r, arrivalsPerHour: stats.get(r.edgeId)?.arrivalsPerHour ?? 0 };
    const key = `${r.kind}|${r.road}|${r.from}|${r.joins ?? ''}`;
    const prev = best.get(key);
    if (!prev || withRate.arrivalsPerHour > prev.arrivalsPerHour) best.set(key, withRate);
  }
  return [...best.values()].sort((a, b) => b.arrivalsPerHour - a.arrivalsPerHour);
}

function nameOf(id: string): string {
  return net?.signals.get(id)?.name ?? id;
}

function greensOf(s: TrafficSignal): Record<string, number> {
  const g: Record<string, number> = {};
  for (const p of s.phases) if (p.color === 'GREEN') g[p.group] = p.duration;
  return g;
}

function groupLabel(s: TrafficSignal, group: string, approaches: ApproachView[]): string {
  const roads = [...new Set(approaches.filter(a => a.group === group).map(a => a.road).filter(Boolean))];
  return roads.length ? roads.slice(0, 2).join(' / ') : group === 'A' ? 'main road' : 'cross road';
}

function analyse(s: TrafficSignal): JunctionDetail | null {
  const engine = getSimulationEngine();
  const index = indexRef;
  if (!engine || !index || !net) return null;
  const node = index.nodes.get(s.nodeId);
  if (!node) return null;

  const real = s.approaches.filter(a => a.group !== 'FREE');
  const chains = chainsBySignal.get(s.id);
  const stats = new Map<string, { queueVehicles: number; queueAgents: number; queueMetres: number; arrivalsPerHour: number }>();
  for (const a of real) {
    const chain = chains?.get(a.edgeId) ?? [a.edgeId];
    const per = engine.getApproachStats(chain);
    let qv = 0, qa = 0, qm = 0, arrivals = per.get(chain[0])?.arrivalsPerHour ?? 0;
    for (const id of chain) {
      const st = per.get(id);
      const e = index.edges.get(id);
      if (!st || !e) break;
      qv += st.queueVehicles; qa += st.queueAgents; qm += st.queueMetres;
      arrivals = st.arrivalsPerHour; // demand reaching the back of the queue
      if (st.queueMetres < e.length * 0.8) break; // the queue ends on this stretch
    }
    stats.set(a.edgeId, { queueVehicles: qv, queueAgents: qa, queueMetres: Math.round(qm), arrivalsPerHour: arrivals });
  }
  const ups = net.upstream.get(s.id) ?? [];
  const approaches: ApproachView[] = real.map(a => {
    const e = index.edges.get(a.edgeId)!;
    const st = stats.get(a.edgeId) ?? { queueVehicles: 0, queueAgents: 0, queueMetres: 0, arrivalsPerHour: 0 };
    const link = ups.find(l => l.approachEdgeId === a.edgeId);
    const arm = s.arms?.find(x => x.edgeId === a.edgeId);
    const lanes = e?.lanes ?? 1;
    const wait = lastVehicleWait(s, a.group, st.queueAgents, lanes);
    return {
      edgeId: a.edgeId, road: e?.name ?? '', group: a.group, bearing: a.bearing, lanes,
      light: approachState(s, a.group),
      queueVehicles: st.queueVehicles, queueMetres: st.queueMetres, arrivalsPerHour: st.arrivalsPerHour, queueAgents: st.queueAgents,
      from: link ? { id: link.from, name: nameOf(link.from), metres: link.metres } : undefined,
      direction: arm ? `from the ${arm.from}${arm.fromJunction ? ` (${arm.fromJunction})` : ''}${arm.towards ? `, towards ${arm.towards}` : ''}` : '',
      waitSeconds: Math.round(wait), overLimit: wait > MAX_WAIT_S,
      feeders: withFlow(feedersBySignal.get(s.id)?.get(a.edgeId) ?? []).filter(f => f.kind !== 'road' || f.arrivalsPerHour > 0).slice(0, 5),
    };
  });
  const merges = withFlow(mergesBySignal.get(s.id) ?? []).filter(m => m.kind !== 'road' || m.arrivalsPerHour > 0).slice(0, 5);

  // Webster: critical flow ratio per group, optimal cycle, greens in proportion
  const groups = [...new Set(s.phases.filter(p => p.color === 'GREEN').map(p => p.group))];
  const flowRatio: Record<string, number> = {};
  for (const g of groups) {
    flowRatio[g] = Math.max(0, ...approaches.filter(a => a.group === g)
      .map(a => a.arrivalsPerHour / (SATURATION_PER_LANE * Math.max(1, a.lanes))));
  }
  const Y = groups.reduce((t, g) => t + flowRatio[g], 0);
  const L = LOST_PER_PHASE * groups.length + (groups.length === 1 ? 18 : 0);
  // Green each group needs to clear its standing queue plus one cycle of arrivals
  const need: Record<string, number> = {};
  for (const g of groups) {
    need[g] = Math.max(0, ...approaches.filter(a => a.group === g).map(a =>
      (a.queueAgents + a.arrivalsPerHour / DEMAND_SCALE_FOR_QUEUES * s.cycleLength / 3600) / (Math.max(1, a.lanes) * DISCHARGE_PER_LANE_S)));
  }
  const needTotal = groups.reduce((t, g) => t + need[g], 0);
  const saturated = Y >= 0.85 || needTotal + L > s.cycleLength * 0.9;
  // Saturated: long cycles (less time lost to yellow/all-red), greens in proportion to
  // queues. Otherwise Webster's optimum cycle with greens in proportion to flow.
  const target = saturated
    ? Math.min(MAX_CYCLE, Math.max(MIN_CYCLE, needTotal + L))
    : Math.min(MAX_CYCLE, Math.max(MIN_CYCLE, (1.5 * L + 5) / (1 - Y)));
  // Change timing step by step: at most ±30% of the current cycle per recommendation
  const cycle = Math.round(Math.min(s.cycleLength * (1 + MAX_STEP), Math.max(s.cycleLength * (1 - MAX_STEP), target)));
  const recGreens: Record<string, number> = {};
  const weights = saturated ? need : flowRatio;
  const weightTotal = groups.reduce((t, g) => t + weights[g], 0);
  for (const g of groups) {
    recGreens[g] = weightTotal > 0.01
      ? Math.max(MIN_GREEN, Math.round((cycle - L) * weights[g] / weightTotal))
      : greensOf(s)[g];
  }

  // Wait guard: every queue clears within two cycles — and in a jam, within MAX_WAIT_S,
  // so no approach is starved while the busiest one gets the long greens
  const cyclesToClear = saturated ? Math.max(1, Math.floor(MAX_WAIT_S / cycle)) : 2;
  const floorGreen: Record<string, number> = {};
  for (const g of groups) {
    const worst = approaches.filter(a => a.group === g)
      .reduce((m, a) => Math.max(m, a.queueAgents / (cyclesToClear * Math.max(1, a.lanes) * DISCHARGE_PER_LANE_S)), 0);
    floorGreen[g] = Math.max(MIN_GREEN, Math.min(120, Math.round(worst)));
    if (floorGreen[g] > recGreens[g]) recGreens[g] = floorGreen[g];
  }
  // Keep the cycle: take the extra green from groups that have more than their own floor
  const available = cycle - L;
  const over = groups.reduce((t, g) => t + recGreens[g], 0) - available;
  const spare = groups.reduce((t, g) => t + Math.max(0, recGreens[g] - floorGreen[g]), 0);
  if (over > 0 && spare > 0) {
    for (const g of groups) {
      const give = Math.max(0, recGreens[g] - floorGreen[g]) / spare * Math.min(over, spare);
      recGreens[g] = Math.round(recGreens[g] - give);
    }
  }

  const greens = greensOf(s);
  const changes = groups
    .filter(g => Math.abs((recGreens[g] ?? 0) - (greens[g] ?? 0)) >= 5)
    .map(g => `${groupLabel(s, g, approaches)} ${recGreens[g]} s green (now ${greens[g]} s)`);
  const summary = changes.length
    ? `Suggested cycle ${cycle} s: ${changes.join('; ')}.`
    : 'Current timing fits the traffic.';

  // Advice for neighbours: spillback towards upstream junctions, green waves downstream
  const advice: string[] = [];
  let spill = 0;
  for (const a of approaches) {
    if (!a.from) continue;
    const share = a.queueMetres / Math.max(1, a.from.metres);
    spill = Math.max(spill, share);
    if (share >= SPILLBACK_SHARE) {
      advice.push(`Queue on ${a.road || 'the approach'} reaches ${Math.round(share * 100)}% of the way back to ${a.from.name} (${a.from.id}): ` +
        `shorten ${a.from.id}'s green towards this junction, or give this approach more green.`);
    }
  }
  const heavy = groups.sort((g1, g2) => flowRatio[g2] - flowRatio[g1])[0];
  for (const d of (net.downstream.get(s.id) ?? []).filter(l => l.fromGroup === heavy).slice(0, 3)) {
    advice.push(`Green wave: start ${d.to} (${nameOf(d.to)}) green about ${d.seconds} s after this junction's ` +
      `${groupLabel(s, heavy, approaches)} green turns on (${d.metres} m along ${d.road || 'the road'}).`);
  }
  // Flyover / ramp traffic feeding approaches, and traffic merging just after the junction
  for (const a of approaches) {
    for (const f of a.feeders.filter(f => f.kind !== 'road' && f.arrivalsPerHour >= 300)) {
      advice.push(`${a.road || 'An approach'} includes ~${f.arrivalsPerHour}/h coming off the ${f.road}${f.kind === 'flyover' ? ' (flyover)' : ''}` +
        `${f.from ? ` from ${f.from}` : ''}, joining ${f.metres} m before the stop line — count it when timing group ${a.group}.`);
    }
  }
  for (const m of merges.filter(m => m.arrivalsPerHour >= 300)) {
    advice.push(`~${m.arrivalsPerHour}/h from ${m.road}${m.kind === 'flyover' ? ' (flyover)' : m.kind === 'ramp' ? ' (slip road)' : ''}` +
      `${m.from ? ` (from ${m.from})` : ''} joins ${m.joins} ${m.metres} m after this junction — if that stretch backs up, the exit blocks; hold the green into it short.`);
  }
  for (const a of approaches.filter(x => x.overLimit)) {
    advice.unshift(`Drivers on ${a.road || 'an approach'} (${a.direction}) wait up to ${Math.round(a.waitSeconds / 60)} min — over the ${MAX_WAIT_S / 60} min limit: ` +
      `give group ${a.group} more green now (Hold ${a.group}) or apply the suggested timing.`);
  }
  if (Y >= 0.9) advice.unshift(`Oversaturated (flow ratio ${Y.toFixed(2)}): even a ${MAX_CYCLE} s cycle can't clear it — divert traffic upstream.`);

  const queueVehicles = approaches.reduce((t, a) => t + a.queueVehicles, 0);
  const maxWait = Math.max(0, ...approaches.map(a => a.waitSeconds));
  const score = Math.max(Y, spill, maxWait / MAX_WAIT_S * 0.85);
  const control = engine.getSignalControl(s.id) ?? null;
  const phase = s.phases[s.currentPhaseIndex];
  return {
    id: s.id, name: s.name ?? s.id, lat: node.lat, lng: node.lng,
    status: score >= 0.85 ? 'critical' : score >= 0.6 ? 'busy' : 'ok',
    score: Math.round(score * 100) / 100, queueVehicles, cycle: s.cycleLength, controlled: !!control,
    axis: s.axis ?? 0,
    phase: { index: s.currentPhaseIndex, group: phase.group, color: phase.color, timer: Math.round(s.timer), duration: phase.duration },
    phases: s.phases.map(p => ({ group: p.group, color: p.color, duration: p.duration })),
    greens, approaches,
    recommendation: {
      cycle, greens: recGreens,
      flowRatio: Object.fromEntries(Object.entries(flowRatio).map(([g, v]) => [g, Math.round(v * 100) / 100])),
      saturation: Math.round(Y * 100) / 100, summary,
    },
    advice,
    merges,
    neighbours: {
      upstream: ups.map(l => ({ id: l.from, name: nameOf(l.from), road: l.road, metres: l.metres, seconds: l.seconds, toGroup: l.toGroup })),
      downstream: (net.downstream.get(s.id) ?? []).map(l => ({ id: l.to, name: nameOf(l.to), road: l.road, metres: l.metres, seconds: l.seconds, fromGroup: l.fromGroup })),
    },
    control,
  };
}

/** Every junction, worst first. */
let listCache: { at: number; list: JunctionSummary[] } | null = null;
const LIST_CACHE_MS = 8000;

export function listJunctions(): JunctionSummary[] {
  if (listCache && Date.now() - listCache.at < LIST_CACHE_MS) return listCache.list;
  const list = computeJunctionList();
  listCache = { at: Date.now(), list };
  return list;
}

function computeJunctionList(): JunctionSummary[] {
  const engine = getSimulationEngine();
  if (!engine || !net) return [];
  const result: JunctionSummary[] = [];
  for (const s of engine.getSignals()) {
    const d = analyse(s);
    if (!d) continue;
    const { id, name, lat, lng, status, score, queueVehicles, cycle, controlled } = d;
    result.push({ id, name, lat, lng, status, score, queueVehicles, cycle, controlled });
  }
  return result.sort((a, b) => b.score - a.score);
}

export function getJunction(id: string): JunctionDetail | null {
  const s = getSimulationEngine()?.getSignals().find(x => x.id === id);
  return s ? analyse(s) : null;
}

// ── Control (simulation) and audit log ───────────────────────────────────────

export interface ControlLogEntry {
  at: number;
  by: string;
  junction: string;
  action: string;
  detail: string;
}

const log: ControlLogEntry[] = [];
const MAX_LOG = 500;

function record(entry: Omit<ControlLogEntry, 'at'>): void {
  const e = { at: Date.now(), ...entry };
  log.unshift(e);
  if (log.length > MAX_LOG) log.pop();
  // Durable copy when Firestore is configured
  getDb()?.collection('signalControlLog').add(e).catch(() => {});
}

export function controlLog(limit = 100): ControlLogEntry[] {
  return log.slice(0, limit);
}

export class ControlError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/**
 * Holds \`group\` green at a junction. With \`coordinate\`, downstream neighbours on the
 * released direction get a green wave and upstream neighbours feeding the stopped
 * approaches are gated. Returns what changed.
 */
export function holdGreen(id: string, group: string, seconds: number, coordinate: boolean, by: string): string[] {
  const engine = getSimulationEngine();
  if (!engine || !net) throw new ControlError('Simulation not running', 503);
  const secs = Math.round(Math.min(180, Math.max(10, seconds)));
  if (!engine.holdSignal(id, group, secs, by)) throw new ControlError(`Junction ${id} has no group ${group}`);
  const changes = [`${id} (${nameOf(id)}): group ${group} held green for ${secs} s`];
  const before = getJunction(id);
  for (const a of before?.approaches.filter(x => x.group !== group) ?? []) {
    const wait = a.waitSeconds + secs;
    if (wait > MAX_WAIT_S) {
      changes.push(`⚠ ${a.road || 'Cross road'} (${a.direction}) drivers may now wait ~${Math.round(wait / 60)} min — over the ${MAX_WAIT_S / 60} min limit`);
    }
  }

  if (coordinate) changes.push(...coordinateNeighbours(id, group, secs, by));
  record({ by, junction: id, action: 'hold', detail: changes.join(' | ') });
  return changes;
}

/** Most neighbouring junctions one coordinated action may adjust, and how far away (m). */
const MAX_COORDINATED = 5;
const MAX_COORD_METRES = 3000;

/**
 * Coordinates up to MAX_COORDINATED junctions around a hold, nearest first:
 * - downstream, along the released traffic: each opens its green as the platoon
 *   arrives (cumulative travel time), passing the wave on junction to junction;
 * - upstream, on the roads now stopped: each feeding junction shortens its green
 *   towards the hold (60% for direct neighbours, 80% one junction further back), so
 *   queues don't spill back into junctions behind.
 */
function coordinateNeighbours(id: string, group: string, secs: number, by: string): string[] {
  const engine = getSimulationEngine();
  if (!engine || !net) return [];
  type Step = { kind: 'wave' | 'gate'; junction: string; group: string; metres: number; seconds: number; hop: number };
  const candidates: Step[] = [];

  // Downstream: follow the released group from junction to junction
  const seenDown = new Set<string>([id]);
  let frontier: { junction: string; group: string; metres: number; seconds: number; hop: number }[] = [{ junction: id, group, metres: 0, seconds: 0, hop: 0 }];
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const f of frontier) {
      for (const d of (net.downstream.get(f.junction) ?? []).filter(l => l.fromGroup === f.group)) {
        if (seenDown.has(d.to)) continue;
        const metres = f.metres + d.metres, seconds = f.seconds + d.seconds;
        if (metres > MAX_COORD_METRES) continue;
        seenDown.add(d.to);
        const step = { junction: d.to, group: d.toGroup, metres, seconds, hop: f.hop + 1 };
        candidates.push({ kind: 'wave', ...step });
        next.push(step);
      }
    }
    frontier = next;
  }

  // Upstream: roads stopped by the hold, then the junctions feeding those
  const seenUp = new Set<string>([id]);
  let upFrontier: { junction: string; groups: (g: string) => boolean; metres: number; hop: number }[] =
    [{ junction: id, groups: g => g !== group, metres: 0, hop: 0 }];
  while (upFrontier.length > 0) {
    const next: typeof upFrontier = [];
    for (const f of upFrontier) {
      for (const u of (net.upstream.get(f.junction) ?? []).filter(l => f.groups(l.toGroup))) {
        if (seenUp.has(u.from) || seenDown.has(u.from)) continue;
        const metres = f.metres + u.metres;
        if (metres > MAX_COORD_METRES) continue;
        seenUp.add(u.from);
        candidates.push({ kind: 'gate', junction: u.from, group: u.fromGroup, metres, seconds: 0, hop: f.hop + 1 });
        const fed = u.fromGroup;
        next.push({ junction: u.from, groups: g => g === fed, metres, hop: f.hop + 1 });
      }
    }
    upFrontier = next;
  }

  const changes: string[] = [];
  for (const c of candidates.sort((a, b) => a.metres - b.metres).slice(0, MAX_COORDINATED)) {
    if (c.kind === 'wave') {
      const hold = Math.min(WAVE_HOLD_MAX, secs);
      if (engine.holdSignal(c.junction, c.group, hold, `${by} (green wave from ${id})`, c.seconds)) {
        changes.push(`${c.junction} (${nameOf(c.junction)}): group ${c.group} green in ${c.seconds} s for ${hold} s — green wave (${c.metres} m downstream)`);
      }
    } else {
      const factor = c.hop === 1 ? GATE_FACTOR : 0.8;
      if (engine.scaleSignalGreen(c.junction, c.group, factor, secs, `${by} (gating for ${id})`)) {
        changes.push(`${c.junction} (${nameOf(c.junction)}): group ${c.group} green cut to ${Math.round(factor * 100)}% for ${secs} s — holds traffic back (${c.metres} m upstream)`);
      }
    }
  }
  return changes;
}

/** New green times for a junction (or the recommended ones). */
export function applyPlan(id: string, greens: Record<string, number> | 'recommended', by: string): string[] {
  const engine = getSimulationEngine();
  if (!engine) throw new ControlError('Simulation not running', 503);
  let plan = greens;
  if (plan === 'recommended') {
    const d = getJunction(id);
    if (!d) throw new ControlError(`Unknown junction ${id}`, 404);
    plan = d.recommendation.greens;
  }
  if (!engine.setSignalPlan(id, plan, by)) throw new ControlError(`Unknown junction ${id}`, 404);
  const detail = Object.entries(plan).map(([g, s]) => `${g} ${s} s`).join(', ');
  record({ by, junction: id, action: 'plan', detail });
  return [`${id} (${nameOf(id)}): greens ${detail}`];
}

export function resetJunction(id: string, by: string): string[] {
  const engine = getSimulationEngine();
  if (!engine?.resetSignal(id)) throw new ControlError(`Unknown junction ${id}`, 404);
  record({ by, junction: id, action: 'reset', detail: 'default timing' });
  return [`${id} (${nameOf(id)}): back to default timing`];
}

/** Labels for one movement through a junction: from which road/direction to which, and the turn. */
export interface MovementLabel {
  fromRoad: string;
  fromDir: string;
  toRoad: string;
  toDir: string;
  turn: 'straight' | 'left' | 'right' | 'U-turn';
}

export function describeMovement(signalId: string, fromEdge: string, toEdge: string): MovementLabel {
  const s = net?.signals.get(signalId);
  const arm = s?.arms?.find(a => a.edgeId === fromEdge);
  const exit = exitsBySignal.get(signalId)?.find(x => x.edgeId === toEdge);
  const inE = indexRef?.edges.get(fromEdge), outE = indexRef?.edges.get(toEdge);
  const approachBearing = s?.approaches.find(a => a.edgeId === fromEdge)?.bearing ?? inE?.bearing ?? 0;
  const diff = outE ? ((departureBearing(outE) - approachBearing + 540) % 360) - 180 : 0;
  // India drives on the left: a negative (anticlockwise) turn is a left turn
  const turnType: MovementLabel['turn'] = Math.abs(diff) < 30 ? 'straight' : Math.abs(diff) > 150 ? 'U-turn' : diff < 0 ? 'left' : 'right';
  return {
    fromRoad: arm?.road ?? inE?.name ?? 'Unnamed road',
    fromDir: arm ? `from the ${arm.from}${arm.fromJunction ? ` (${arm.fromJunction})` : ''}` : `from the ${compass(approachBearing + 180)}`,
    toRoad: exit?.road ?? outE?.name ?? 'Unnamed road',
    toDir: exit ? `heading ${exit.heading}${exit.towards ? ` towards ${exit.towards}` : ''}` : '',
    turn: turnType,
  };
}
