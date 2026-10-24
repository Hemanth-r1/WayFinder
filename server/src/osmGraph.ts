/**
 * Builds WayFinder's road graph and signal controllers from OpenStreetMap data.
 *
 * - Roads: motorway … tertiary (+ links). A graph node sits at every junction, road end
 *   and signal stop line; edges keep the road's shape, lanes, one-way rules and a
 *   Bangalore-realistic free-flow speed.
 * - Only the largest strongly connected part is kept, so every road can reach every other.
 * - Signals: OSM `highway=traffic_signals` nodes, merged per junction (a dual carriageway
 *   crossing has several stop lines run by one controller). Each controller splits its
 *   approaches into two groups along the junction's main road (A = main road, B = cross
 *   road); stop lines with only one group are pedestrian crossings.
 */
import type { RoadNode, RoadEdge, RoadGraph, TrafficSignal, SignalPhase, SignalApproach, Place } from './types.js';

// ── Compact OSM snapshot ─────────────────────────────────────────────────────

export interface CompactWay {
  id: number;
  nodes: number[];
  /** OSM highway tag, e.g. "primary", "trunk_link" */
  hw: string;
  name?: string;
  oneway?: string;
  lanes?: string;
  maxspeed?: string;
  junction?: string;
  /** OSM bridge / layer tags (flyovers) */
  bridge?: string;
  layer?: string;
}

export interface CompactOsm {
  source: string;
  fetchedAt: string;
  /** [south, west, north, east] */
  bbox: [number, number, number, number];
  /** [osmId, lat, lng] */
  nodes: [number, number, number][];
  ways: CompactWay[];
  /** OSM ids of traffic signal nodes */
  signals: number[];
  /** Names tagged on signal nodes (e.g. "Silk Board Junction"), by OSM id */
  signalNames?: Record<string, string>;
  /** Neighbourhood names: [name, lat, lng] */
  places?: [string, number, number][];
}

// ── Road attributes (Bangalore) ──────────────────────────────────────────────

/** Importance: used for signal timing, spawning and turn choice. */
export const ROAD_RANK: Record<string, number> = {
  motorway: 5, trunk: 5, primary: 4, secondary: 3, tertiary: 2, link: 1,
  unclassified: 1, residential: 0, living_street: 0, service: 0,
};
/** Typical free-flow speeds on Bangalore roads (km/h) with side friction (pedestrians, stopping autos and buses, U-turns), below legal limits. */
const FREE_FLOW_KMH: Record<string, number> = {
  motorway: 65, trunk: 45, primary: 35, secondary: 30, tertiary: 25, link: 22,
  unclassified: 22, residential: 18, living_street: 10,
  /** Service and frontage roads beside flyovers, tech parks, markets */
  service: 20,
};
/** Lanes per direction when OSM has no lanes tag. */
const DEFAULT_LANES: Record<string, number> = {
  motorway: 3, trunk: 3, primary: 2, secondary: 2, tertiary: 1, link: 1,
  unclassified: 1, residential: 1, living_street: 1, service: 1,
};

/** OSM highway tag → WayFinder road type, or null for roads we don't model. */
function roadTypeOf(hw: string): string | null {
  if (hw.endsWith('_link')) return 'link';
  return hw in FREE_FLOW_KMH && hw !== 'link' ? hw : null;
}

function isOnewayForward(w: CompactWay, roadType: string): boolean {
  const o = w.oneway;
  if (o === 'yes' || o === '1' || o === 'true') return true;
  if (o === 'no' || o === '-1' || o === 'reverse') return false;
  return w.junction === 'roundabout' || w.junction === 'circular' || roadType === 'motorway';
}

function isOnewayReverse(w: CompactWay): boolean {
  return w.oneway === '-1' || w.oneway === 'reverse';
}

function lanesPerDirection(w: CompactWay, roadType: string, oneway: boolean): number {
  const total = parseInt(w.lanes ?? '', 10);
  if (!Number.isFinite(total) || total <= 0) return DEFAULT_LANES[roadType];
  return Math.max(1, Math.min(5, oneway ? total : Math.ceil(total / 2)));
}

function freeFlowSpeed(w: CompactWay, roadType: string): number {
  const base = FREE_FLOW_KMH[roadType];
  const tagged = parseInt(w.maxspeed ?? '', 10);
  return Number.isFinite(tagged) && tagged >= 15 ? Math.min(base, tagged) : base;
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

type LatLng = { lat: number; lng: number };

export function haversineMetres(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** Compass bearing (0 = north, clockwise) from a to b. */
export function bearing(a: LatLng, b: LatLng): number {
  const y = (b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180);
  const x = b.lat - a.lat;
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function polylineLength(pts: LatLng[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += haversineMetres(pts[i - 1], pts[i]);
  return len;
}

/** Ramer–Douglas–Peucker simplification; epsilon in degrees (~1e-5 ≈ 1 m). */
function simplify(points: LatLng[], epsilon: number): LatLng[] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [s, e] = stack.pop()!;
    let maxD = 0, idx = -1;
    const a = points[s], b = points[e];
    const dx = b.lng - a.lng, dy = b.lat - a.lat;
    const len2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      const p = points[i];
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / len2)) : 0;
      const d = Math.hypot(p.lng - a.lng - t * dx, p.lat - a.lat - t * dy);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > epsilon && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Deterministic 0–1 random numbers, so signal timings are the same on every start. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Connectivity ─────────────────────────────────────────────────────────────

/** Nodes of the largest strongly connected component (Kosaraju, iterative). */
function largestScc(nodeIds: string[], edges: Iterable<RoadEdge>): Set<string> {
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  for (const id of nodeIds) { out.set(id, []); inn.set(id, []); }
  for (const e of edges) { out.get(e.from)?.push(e.to); inn.get(e.to)?.push(e.from); }

  const visited = new Set<string>();
  const order: string[] = [];
  for (const start of nodeIds) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: [string, number][] = [[start, 0]];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const nbrs = out.get(top[0])!;
      if (top[1] < nbrs.length) {
        const next = nbrs[top[1]++];
        if (!visited.has(next)) { visited.add(next); stack.push([next, 0]); }
      } else {
        order.push(top[0]);
        stack.pop();
      }
    }
  }

  const comp = new Map<string, number>();
  const sizes: number[] = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const root = order[i];
    if (comp.has(root)) continue;
    const c = sizes.length;
    let size = 0;
    const stack = [root];
    comp.set(root, c);
    while (stack.length > 0) {
      const n = stack.pop()!;
      size++;
      for (const p of inn.get(n)!) if (!comp.has(p)) { comp.set(p, c); stack.push(p); }
    }
    sizes.push(size);
  }
  let best = 0;
  for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[best]) best = c;
  return new Set(nodeIds.filter(id => comp.get(id) === best));
}

// ── Signals ──────────────────────────────────────────────────────────────────

/** Stop lines closer than this belong to one junction controller. */
const CLUSTER_METRES = 60;
const YELLOW = 3;
const ALL_RED = 2;

/** Bearing of the last stretch of an edge — the direction traffic arrives from. */
function arrivalBearing(edge: RoadEdge): number {
  const g = edge.geometry;
  return g.length >= 2 ? bearing(g[g.length - 2], g[g.length - 1]) : edge.bearing;
}

/** 'A' when the approach runs along the main road (either direction), else 'B'. */
function groupFor(arrival: number, axis: number): 'A' | 'B' {
  const rel = ((arrival - axis) % 180 + 180) % 180;
  return rel < 45 || rel >= 135 ? 'A' : 'B';
}

/**
 * One controller per cluster of stop-line nodes. Approaches from inside the junction
 * (a short edge starting next to another stop line of the same junction) are 'FREE':
 * traffic has already passed the lights.
 */
export function buildSignals(
  clusters: string[][],
  nodes: Map<string, RoadNode>,
  inEdges: Map<string, RoadEdge[]>,
  seed = 1,
  opts: { idFor?: (nodeId: string) => string; tagName?: (nodeId: string) => string | undefined } = {},
): TrafficSignal[] {
  const signals: TrafficSignal[] = [];
  const rand = seededRandom(seed);

  clusters.forEach((cluster, ci) => {
    const members = new Set(cluster);
    const memberNodes = cluster.map(id => nodes.get(id)!).filter(Boolean);
    const nearCluster = (id: string) => {
      const n = nodes.get(id);
      return !!n && memberNodes.some(m => haversineMetres(m, n) < CLUSTER_METRES * 0.7);
    };

    const incoming: RoadEdge[] = [];
    const internal: RoadEdge[] = [];
    for (const id of cluster) {
      for (const e of inEdges.get(id) ?? []) {
        if (members.has(e.from) || (e.length < CLUSTER_METRES * 1.2 && nearCluster(e.from))) internal.push(e);
        else incoming.push(e);
      }
    }
    if (incoming.length === 0) return;

    // Main road: most important approach, then the longest
    const main = incoming.reduce((best, e) => {
      const r = ROAD_RANK[e.roadType] ?? 0, br = ROAD_RANK[best.roadType] ?? 0;
      return r > br || (r === br && e.length > best.length) ? e : best;
    });
    const axis = arrivalBearing(main);
    const approaches: SignalApproach[] = [
      ...incoming.map(e => {
        const b = arrivalBearing(e);
        return { edgeId: e.id, bearing: Math.round(b), group: groupFor(b, axis) };
      }),
      ...internal.map(e => ({ edgeId: e.id, bearing: Math.round(arrivalBearing(e)), group: 'FREE' })),
    ];

    const rankOf = (g: string) => Math.max(0, ...incoming
      .filter((_, i) => approaches[i].group === g)
      .map(e => ROAD_RANK[e.roadType] ?? 1));
    const rankA = rankOf('A'), rankB = rankOf('B');

    // Bangalore cycles run long: ~2 min at arterial crossings, ~1 min on minor roads
    let phases: SignalPhase[];
    if (rankB === 0) {
      // Pedestrian crossing / one-sided stop line
      const green = Math.round(45 + 6 * rankA + rand() * 15);
      phases = [
        { group: 'A', color: 'GREEN', duration: green, yellowDuration: YELLOW },
        { group: 'A', color: 'YELLOW', duration: YELLOW, yellowDuration: 0 },
        { group: 'ALL', color: 'RED', duration: Math.round(18 + rand() * 8), yellowDuration: 0 },
      ];
    } else {
      const greenA = Math.round(22 + 9 * rankA + rand() * 10);
      const greenB = Math.round(16 + 7 * rankB + rand() * 8);
      phases = [
        { group: 'A', color: 'GREEN', duration: greenA, yellowDuration: YELLOW },
        { group: 'A', color: 'YELLOW', duration: YELLOW, yellowDuration: 0 },
        { group: 'ALL', color: 'RED', duration: ALL_RED, yellowDuration: 0 },
        { group: 'B', color: 'GREEN', duration: greenB, yellowDuration: YELLOW },
        { group: 'B', color: 'YELLOW', duration: YELLOW, yellowDuration: 0 },
        { group: 'ALL', color: 'RED', duration: ALL_RED, yellowDuration: 0 },
      ];
    }
    const cycleLength = phases.reduce((s, p) => s + p.duration, 0);

    // Independent offsets: Bangalore signals are mostly not coordinated
    const offset = Math.floor(rand() * cycleLength);
    let phaseIndex = 0, t = offset;
    while (t >= phases[phaseIndex].duration) { t -= phases[phaseIndex].duration; phaseIndex = (phaseIndex + 1) % phases.length; }

    // Representative node for drawing: the member nearest the cluster centre
    const c = memberNodes.reduce((s, n) => ({ lat: s.lat + n.lat / memberNodes.length, lng: s.lng + n.lng / memberNodes.length }), { lat: 0, lng: 0 });
    const rep = memberNodes.reduce((b, n) => haversineMetres(n, c) < haversineMetres(b, c) ? n : b);

    const id = opts.idFor ? opts.idFor(rep.id) : `SIG-${String(ci + 1).padStart(4, '0')}`;
    const name = cluster.map(n => opts.tagName?.(n)).find(Boolean) ?? junctionName(incoming);
    for (const n of memberNodes) n.trafficSignalId = id;
    signals.push({
      id, name, nodeId: rep.id, nodeIds: cluster, axis: Math.round(axis),
      phases, currentPhaseIndex: phaseIndex, timer: t, cycleLength, offset,
      greenWaveDirection: null, congestionLevel: 0, adaptiveTiming: false,
      approaches,
    });
  });
  return signals;
}

/** "Hosur Road × Outer Ring Road" from the most important differently named approaches. */
function junctionName(incoming: RoadEdge[]): string {
  const byName = new Map<string, number>();
  for (const e of incoming) {
    if (!e.name) continue;
    byName.set(e.name, Math.max(byName.get(e.name) ?? -1, ROAD_RANK[e.roadType] ?? 0));
  }
  const names = [...byName].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  if (names.length >= 2) return `${names[0]} × ${names[1]}`;
  if (names.length === 1) return `${names[0]} signal`;
  return 'Unnamed junction';
}

/** Groups node ids whose points lie within `metres` of each other (union-find on a grid). */
export function clusterNodes(ids: string[], nodes: Map<string, RoadNode>, metres = CLUSTER_METRES): string[][] {
  const parent = new Map(ids.map(id => [id, id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const nx = parent.get(x)!; parent.set(x, r); x = nx; }
    return r;
  };
  const cell = metres / 111320;
  const grid = new Map<string, string[]>();
  for (const id of ids) {
    const n = nodes.get(id)!;
    const key = `${Math.floor(n.lat / cell)},${Math.floor(n.lng / cell)}`;
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(id);
  }
  for (const id of ids) {
    const n = nodes.get(id)!;
    const cy = Math.floor(n.lat / cell), cx = Math.floor(n.lng / cell);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const other of grid.get(`${cy + dy},${cx + dx}`) ?? []) {
        if (other <= id) continue;
        if (haversineMetres(n, nodes.get(other)!) <= metres) parent.set(find(id), find(other));
      }
    }
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const r = find(id);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(id);
  }
  return [...groups.values()];
}

// ── Choke points ─────────────────────────────────────────────────────────────

/**
 * Well-known Bangalore choke points. Roads within `radius` metres carry less traffic
 * than their lanes suggest (merges, bus bays, crossing flows), so queues form there first.
 */
export const BOTTLENECKS = [
  { name: 'Silk Board Junction', lat: 12.9172, lng: 77.6228, radius: 700, factor: 0.5 },
  { name: 'Hebbal Flyover', lat: 13.0358, lng: 77.5970, radius: 700, factor: 0.55 },
  { name: 'KR Puram / Tin Factory', lat: 12.9985, lng: 77.6750, radius: 900, factor: 0.55 },
  { name: 'Marathahalli Bridge', lat: 12.9560, lng: 77.7010, radius: 600, factor: 0.6 },
  { name: 'Iblur – Bellandur (ORR)', lat: 12.9230, lng: 77.6700, radius: 900, factor: 0.6 },
  { name: 'Goraguntepalya', lat: 13.0280, lng: 77.5400, radius: 600, factor: 0.6 },
  { name: 'Majestic / KG Road', lat: 12.9770, lng: 77.5720, radius: 700, factor: 0.6 },
  { name: 'Mekhri Circle', lat: 13.0140, lng: 77.5835, radius: 450, factor: 0.65 },
  { name: 'Sony World Junction', lat: 12.9370, lng: 77.6265, radius: 450, factor: 0.65 },
  { name: 'Nagawara Junction', lat: 13.0420, lng: 77.6240, radius: 500, factor: 0.65 },
  { name: 'Whitefield ITPL', lat: 12.9860, lng: 77.7330, radius: 700, factor: 0.65 },
  { name: 'Electronic City (Hosur Rd)', lat: 12.8460, lng: 77.6650, radius: 900, factor: 0.65 },
];

function markBottlenecks(edges: Iterable<RoadEdge>): void {
  for (const e of edges) {
    const mid = e.geometry[Math.floor(e.geometry.length / 2)];
    for (const b of BOTTLENECKS) {
      if (haversineMetres(mid, b) <= b.radius) e.bottleneck = Math.min(e.bottleneck ?? 1, b.factor);
    }
  }
}

// ── Pass-through merging ─────────────────────────────────────────────────────

function sameRoad(a: RoadEdge, b: RoadEdge): boolean {
  return a.name === b.name && a.roadType === b.roadType && a.lanes === b.lanes && a.speedLimit === b.speedLimit;
}

function joinEdges(a: RoadEdge, b: RoadEdge): RoadEdge {
  const geometry = [...a.geometry, ...b.geometry.slice(1)];
  return {
    ...a, id: `${a.from}-${b.to}`, to: b.to,
    length: Math.round((a.length + b.length) * 10) / 10,
    bearing: Math.round(bearing(geometry[0], geometry[geometry.length - 1])),
    geometry,
  };
}

/**
 * Removes nodes where a road simply continues (OSM splits ways at bridges, name tags
 * and so on): one-way chains (1 in, 1 out) and two-way pass-throughs (2 neighbours),
 * when both sides are the same road. Junctions and signal stop lines stay.
 */
function contractPassThrough(nodes: Map<string, RoadNode>, edges: Map<string, RoadEdge>, keep: Set<string>): void {
  const out = new Map<string, Set<string>>();
  const inn = new Map<string, Set<string>>();
  const add = (e: RoadEdge) => {
    (out.get(e.from) ?? out.set(e.from, new Set()).get(e.from)!).add(e.id);
    (inn.get(e.to) ?? inn.set(e.to, new Set()).get(e.to)!).add(e.id);
  };
  const remove = (e: RoadEdge) => { out.get(e.from)?.delete(e.id); inn.get(e.to)?.delete(e.id); edges.delete(e.id); };
  for (const e of edges.values()) add(e);

  const queue = [...nodes.keys()];
  for (const n of queue) {
    if (keep.has(n) || !nodes.has(n)) continue;
    const ins = [...(inn.get(n) ?? [])].map(id => edges.get(id)!);
    const outs = [...(out.get(n) ?? [])].map(id => edges.get(id)!);
    const pairs: [RoadEdge, RoadEdge][] = [];
    if (ins.length === 1 && outs.length === 1 && ins[0].from !== outs[0].to) {
      pairs.push([ins[0], outs[0]]);
    } else if (ins.length === 2 && outs.length === 2) {
      const [a1, a2] = ins;
      const b1 = outs.find(o => o.to === a2.from), b2 = outs.find(o => o.to === a1.from);
      if (b1 && b2 && a1.from !== a2.from) pairs.push([a1, b1], [a2, b2]);
    }
    if (pairs.length === 0 || !pairs.every(([a, b]) => sameRoad(a, b))) continue;
    const joined = pairs.map(([a, b]) => joinEdges(a, b));
    if (joined.some(j => edges.has(j.id))) continue; // would collide with a parallel road
    for (const [a, b] of pairs) { remove(a); remove(b); }
    for (const j of joined) { edges.set(j.id, j); add(j); }
    nodes.delete(n);
  }
}

// ── Graph ────────────────────────────────────────────────────────────────────

export interface BuiltNetwork {
  graph: RoadGraph;
  signals: TrafficSignal[];
  places: Place[];
}

/** Flyovers: OSM bridges raised a level (or more), and roads named as flyovers / elevated. */
function isElevated(w: CompactWay): boolean {
  const layer = parseInt(w.layer ?? '0', 10);
  return (w.bridge !== undefined && w.bridge !== 'no' && layer >= 1) || /flyover|elevated/i.test(w.name ?? '');
}

export function buildGraphFromOsm(osm: CompactOsm): BuiltNetwork {
  const coords = new Map<number, LatLng>();
  for (const [id, lat, lng] of osm.nodes) coords.set(id, { lat, lng });
  const signalOsm = new Set(osm.signals);

  const ways = osm.ways.filter(w => w.nodes.length >= 2 && roadTypeOf(w.hw) !== null);

  // Junctions (shared by ways), way ends and signal stop lines become graph nodes
  const use = new Map<number, number>();
  for (const w of ways) {
    w.nodes.forEach((n, i) => {
      const end = i === 0 || i === w.nodes.length - 1;
      use.set(n, (use.get(n) ?? 0) + (end ? 2 : 1));
    });
  }
  const isGraphNode = (osmId: number) => (use.get(osmId) ?? 0) >= 2 || signalOsm.has(osmId);

  const nodes = new Map<string, RoadNode>();
  const idOf = new Map<number, string>();
  const graphId = (osmId: number): string => {
    let id = idOf.get(osmId);
    if (!id) {
      id = `n${osmId.toString(36)}`; // stable across snapshot refreshes
      idOf.set(osmId, id);
      const c = coords.get(osmId)!;
      nodes.set(id, { id, lat: round6(c.lat), lng: round6(c.lng) });
    }
    return id;
  };

  const edges = new Map<string, RoadEdge>();
  const addEdge = (from: string, to: string, geom: LatLng[], w: CompactWay, roadType: string, lanes: number, length: number) => {
    const id = `${from}-${to}`;
    const existing = edges.get(id);
    if (existing && existing.length <= length) return; // parallel way: keep the shorter
    const g = simplify(geom, 0.00002).map(p => ({ lat: round6(p.lat), lng: round6(p.lng) }));
    edges.set(id, {
      ...(isElevated(w) ? { elevated: true } : {}),
      id, from, to, name: w.name ?? '', roadType,
      speedLimit: freeFlowSpeed(w, roadType), lanes,
      length: Math.round(length * 10) / 10,
      bearing: Math.round(bearing(g[0], g[g.length - 1])),
      geometry: g,
    });
  };

  for (const w of ways) {
    const roadType = roadTypeOf(w.hw)!;
    const reverse = isOnewayReverse(w);
    const forwardOnly = isOnewayForward(w, roadType);
    const lanes = lanesPerDirection(w, roadType, forwardOnly || reverse);

    let start: number | null = null;
    let geom: LatLng[] = [];
    for (const osmId of w.nodes) {
      const c = coords.get(osmId);
      if (!c) { start = null; geom = []; continue; } // gap in the data
      geom.push(c);
      if (start === null) { start = osmId; geom = [c]; continue; }
      if (!isGraphNode(osmId) || osmId === start) continue;

      const length = polylineLength(geom);
      if (length >= 2) {
        const a = graphId(start), b = graphId(osmId);
        if (!reverse) addEdge(a, b, geom, w, roadType, lanes, length);
        if (!forwardOnly) addEdge(b, a, [...geom].reverse(), w, roadType, lanes, length);
      }
      start = osmId;
      geom = [c];
    }
  }

  // Keep the largest strongly connected part
  const keep = largestScc([...nodes.keys()], edges.values());
  for (const id of [...nodes.keys()]) if (!keep.has(id)) nodes.delete(id);
  for (const [id, e] of [...edges]) if (!keep.has(e.from) || !keep.has(e.to)) edges.delete(id);

  const signalNodes = [...signalOsm].map(o => idOf.get(o)).filter((id): id is string => !!id && nodes.has(id));
  contractPassThrough(nodes, edges, new Set(signalNodes));

  const out = new Map<string, string[]>();
  const inEdges = new Map<string, RoadEdge[]>();
  for (const e of edges.values()) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.id);
    (inEdges.get(e.to) ?? inEdges.set(e.to, []).get(e.to)!).push(e);
  }

  markBottlenecks(edges.values());

  const osmOf = new Map<string, number>();
  for (const [osm, id] of idOf) osmOf.set(id, osm);
  const signals = buildSignals(clusterNodes(signalNodes, nodes), nodes, inEdges, 1, {
    idFor: nodeId => `J${(osmOf.get(nodeId) ?? 0).toString(36).toUpperCase()}`,
    tagName: nodeId => osm.signalNames?.[String(osmOf.get(nodeId))],
  });

  return {
    graph: { nodes: [...nodes.values()], edges: [...edges.values()], adjacency: [...out] },
    signals,
    places: (osm.places ?? []).map(([name, lat, lng]) => ({ name, lat, lng })),
  };
}
