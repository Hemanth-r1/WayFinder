/**
 * Route planning for navigating users.
 *
 * Edge cost is travel time (seconds): free-flow time from length and speed limit,
 * scaled by live congestion from the simulation (BPR curve) and by how many other
 * WayFinder users are already routed over that edge. Because every started route is
 * registered as load, the next user asking for a similar trip is steered onto a
 * nearby route that is not yet taken, instead of everyone piling onto one road.
 */
import type { RoadGraph, RoadEdge, RoadNode, TrafficSignal, RouteInfo } from './types.js';
import { expectedSignalDelay } from './signalTiming.js';
import { getWeather } from './conditionsService.js';
import { isEdgeBlocked, edgeTimeFactor } from './reportsService.js';

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Extra cost per other navigator already routed over an edge (0.12 = +12%). */
const SHARE_PENALTY = 0.12;
/** Cap on the navigator-sharing multiplier. */
const MAX_SHARE_FACTOR = 2;
/** Per-user deterministic cost spread (+0–3%) so near-equal routes split between users. */
const USER_SPREAD = 0.03;
/** BPR congestion curve: t = t0 · (1 + α (v/c)^β). */
const BPR_ALPHA = 0.15;
const BPR_BETA = 4;
const MAX_CONGESTION_FACTOR = 4;
/** One vehicle per this many metres per lane is treated as capacity. */
const METRES_PER_VEHICLE = 25;
/** Seconds for a full 90° turn; 180° U-turns cost double plus a fixed penalty. */
const TURN_SECONDS_PER_90 = 3;
const U_TURN_PENALTY = 30;
/** Alternatives: accept routes up to this multiple of the best ETA... */
const MAX_ALT_STRETCH = 1.3;
/** ...that share at most this fraction of their length with an accepted route. */
const MAX_ALT_OVERLAP = 0.75;
/** Multiplier applied to edges already used when searching for the next alternative. */
const ALT_EDGE_PENALTY = 1.4;
/** Speeds observed from real drivers' GPS stay relevant for this long. */
const OBSERVATION_TTL_MS = 3 * 60 * 1000;
/** Weight of a new GPS speed sample in the per-edge moving average. */
const OBSERVATION_ALPHA = 0.4;

// ── Graph index ──────────────────────────────────────────────────────────────

export interface GraphIndex {
  nodes: Map<string, RoadNode>;
  edges: Map<string, RoadEdge>;
  outEdges: Map<string, RoadEdge[]>;
  signalByNode: Map<string, TrafficSignal>;
  edgeList: RoadEdge[];
  maxSpeedMs: number;
}

const indexCache = new WeakMap<RoadGraph, GraphIndex>();

/** Map-based view of the serialised graph. Built once per graph object. */
export function getGraphIndex(graph: RoadGraph, signals: TrafficSignal[]): GraphIndex {
  const cached = indexCache.get(graph);
  if (cached) return cached;

  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const edges = new Map(graph.edges.map(e => [e.id, e]));
  const outEdges = new Map<string, RoadEdge[]>();
  for (const [nodeId, edgeIds] of graph.adjacency) {
    const list: RoadEdge[] = [];
    for (const id of edgeIds) {
      const e = edges.get(id);
      if (e && e.from === nodeId) list.push(e);
    }
    outEdges.set(nodeId, list);
  }
  let maxSpeed = 1;
  for (const e of graph.edges) maxSpeed = Math.max(maxSpeed, e.speedLimit);

  const index: GraphIndex = {
    nodes, edges, outEdges,
    signalByNode: new Map(signals.map(s => [s.nodeId, s])),
    edgeList: graph.edges,
    maxSpeedMs: maxSpeed / 3.6,
  };
  indexCache.set(graph, index);
  return index;
}

// ── Navigator load ───────────────────────────────────────────────────────────

const userRouteEdges = new Map<string, Set<string>>();
const edgeNavigators = new Map<string, number>();

/** Record that `userId` is now driving over `edgeIds` (replaces any previous route). */
export function registerUserRoute(userId: string, edgeIds: string[]): void {
  releaseUserRoute(userId);
  const set = new Set(edgeIds);
  userRouteEdges.set(userId, set);
  for (const id of set) edgeNavigators.set(id, (edgeNavigators.get(id) ?? 0) + 1);
}

export function releaseUserRoute(userId: string): void {
  const set = userRouteEdges.get(userId);
  if (!set) return;
  for (const id of set) {
    const n = (edgeNavigators.get(id) ?? 1) - 1;
    if (n <= 0) edgeNavigators.delete(id); else edgeNavigators.set(id, n);
  }
  userRouteEdges.delete(userId);
}

/** Navigators on an edge, not counting `excludeUserId` itself. */
export function navigatorsOnEdge(edgeId: string, excludeUserId?: string): number {
  const n = edgeNavigators.get(edgeId) ?? 0;
  return excludeUserId && userRouteEdges.get(excludeUserId)?.has(edgeId) ? n - 1 : n;
}

export function activeNavigatorCount(): number {
  return userRouteEdges.size;
}

/** Edge IDs on any active navigator's route. */
export function activeRouteEdgeIds(): string[] {
  return Array.from(edgeNavigators.keys());
}

// ── Live speeds from real drivers ────────────────────────────────────────────

const observedSpeeds = new Map<string, { kmh: number; at: number }>();

/** Records a GPS-derived speed for an edge (moving average). */
export function recordObservedSpeed(edgeId: string, kmh: number): void {
  const now = Date.now();
  const prev = observedSpeeds.get(edgeId);
  const fresh = prev && now - prev.at < OBSERVATION_TTL_MS;
  observedSpeeds.set(edgeId, {
    kmh: fresh ? prev.kmh + OBSERVATION_ALPHA * (kmh - prev.kmh) : kmh,
    at: now,
  });
}

function observedKmh(edgeId: string): number | null {
  const o = observedSpeeds.get(edgeId);
  if (!o) return null;
  if (Date.now() - o.at > OBSERVATION_TTL_MS) {
    observedSpeeds.delete(edgeId);
    return null;
  }
  return o.kmh;
}

// ── Cost model ───────────────────────────────────────────────────────────────

export interface RoutingContext {
  /** The user being routed; their own registered route is not counted as load. */
  userId?: string;
  /** Live simulated vehicles per edge ID. */
  occupancy?: Map<string, number>;
}

/** Vehicles an edge holds before slowing sharply; reduced in rain. */
export function edgeCapacity(edge: RoadEdge): number {
  return Math.max(1, (edge.lanes || 1) * edge.length / METRES_PER_VEHICLE * getWeather().capacityFactor);
}

export function congestionFactor(edge: RoadEdge, vehicles: number): number {
  const ratio = vehicles / edgeCapacity(edge);
  return Math.min(MAX_CONGESTION_FACTOR, 1 + BPR_ALPHA * ratio ** BPR_BETA);
}

function freeFlowTime(edge: RoadEdge): number {
  return edge.length / (Math.max(5, edge.speedLimit) / 3.6);
}

/**
 * Predicted seconds to drive `edge` now: free-flow time slowed by weather and simulated
 * congestion, or the speed real WayFinder drivers just measured there if that is slower,
 * plus other navigators' expected load.
 */
export function edgeTravelTime(edge: RoadEdge, ctx: RoutingContext): number {
  const sharing = Math.min(MAX_SHARE_FACTOR, 1 + SHARE_PENALTY * navigatorsOnEdge(edge.id, ctx.userId));
  const modelled = freeFlowTime(edge) / getWeather().speedFactor * congestionFactor(edge, ctx.occupancy?.get(edge.id) ?? 0);
  const observed = observedKmh(edge.id);
  const measured = observed !== null ? edge.length / (Math.max(5, observed) / 3.6) : 0;
  // Crowd reports: unconfirmed blocks, waterlogging and local rain make roads costlier
  return Math.max(modelled, measured) * sharing * edgeTimeFactor(edge.id);
}

function turnCost(prev: RoadEdge | undefined, next: RoadEdge): number {
  if (!prev) return 0;
  if (next.to === prev.from) return U_TURN_PENALTY + 2 * TURN_SECONDS_PER_90;
  const diff = Math.abs(((next.bearing - prev.bearing + 540) % 360) - 180);
  return (diff / 90) * TURN_SECONDS_PER_90;
}

/** Stable per-(user, edge) multiplier in [1, 1 + USER_SPREAD]. */
function userSpread(userId: string | undefined, edgeId: string): number {
  if (!userId) return 1;
  let h = 2166136261;
  const key = userId + '|' + edgeId;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return 1 + ((h >>> 0) / 0xffffffff) * USER_SPREAD;
}

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// ── A* ───────────────────────────────────────────────────────────────────────

class MinHeap {
  private ids: string[] = [];
  private keys: number[] = [];
  get size() { return this.ids.length; }
  push(id: string, key: number): void {
    let i = this.ids.length;
    this.ids.push(id); this.keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.ids[i] = this.ids[p]; this.keys[i] = this.keys[p];
      i = p;
    }
    this.ids[i] = id; this.keys[i] = key;
  }
  pop(): string {
    const top = this.ids[0];
    const lastId = this.ids.pop()!; const lastKey = this.keys.pop()!;
    const n = this.ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1; const r = l + 1;
        let m = i; let mk = lastKey;
        if (l < n && this.keys[l] < mk) { m = l; mk = this.keys[l]; }
        if (r < n && this.keys[r] < mk) { m = r; mk = this.keys[r]; }
        if (m === i) break;
        this.ids[i] = this.ids[m]; this.keys[i] = this.keys[m];
        i = m;
      }
      this.ids[i] = lastId; this.keys[i] = lastKey;
    }
    return top;
  }
}

/** Returns the edge IDs of the cheapest route, or null if unreachable. */
function aStar(
  index: GraphIndex, sourceId: string, destId: string, ctx: RoutingContext,
  extraPenalty?: Map<string, number>,
): string[] | null {
  const dest = index.nodes.get(destId);
  if (!dest || !index.nodes.has(sourceId)) return null;
  if (sourceId === destId) return [];

  const g = new Map<string, number>([[sourceId, 0]]);
  const via = new Map<string, RoadEdge>();
  const closed = new Set<string>();
  const heap = new MinHeap();
  heap.push(sourceId, 0);

  while (heap.size > 0) {
    const current = heap.pop();
    if (closed.has(current)) continue;
    if (current === destId) {
      const edgeIds: string[] = [];
      for (let e = via.get(destId); e; e = via.get(e.from)) {
        edgeIds.push(e.id);
        if (e.from === sourceId) break;
      }
      return edgeIds.reverse();
    }
    closed.add(current);

    const gCur = g.get(current)!;
    const inEdge = via.get(current);
    for (const edge of index.outEdges.get(current) ?? []) {
      if (closed.has(edge.to) || isEdgeBlocked(edge.id)) continue;
      const signal = index.signalByNode.get(edge.to);
      const cost =
        edgeTravelTime(edge, ctx) * userSpread(ctx.userId, edge.id) * (extraPenalty?.get(edge.id) ?? 1) +
        turnCost(inEdge, edge) +
        (signal && edge.to !== destId ? expectedSignalDelay(signal) : 0);
      const tentative = gCur + cost;
      if (tentative < (g.get(edge.to) ?? Infinity)) {
        g.set(edge.to, tentative);
        via.set(edge.to, edge);
        const node = index.nodes.get(edge.to)!;
        heap.push(edge.to, tentative + haversine(node, dest) / index.maxSpeedMs);
      }
    }
  }
  return null;
}

// ── Route description ────────────────────────────────────────────────────────

export function describeRoute(index: GraphIndex, sourceId: string, edgeIds: string[], ctx: RoutingContext): RouteInfo {
  const path = [sourceId];
  const roadNames: string[] = [];
  const geometry: { lat: number; lng: number }[] = [];
  let distance = 0, time = 0, signalCount = 0, sharedUsers = 0;
  let prev: RoadEdge | undefined;

  const src = index.nodes.get(sourceId);
  if (src) geometry.push({ lat: src.lat, lng: src.lng });

  edgeIds.forEach((id, i) => {
    const edge = index.edges.get(id)!;
    path.push(edge.to);
    distance += edge.length;
    time += edgeTravelTime(edge, ctx) + turnCost(prev, edge);
    const signal = index.signalByNode.get(edge.to);
    if (signal && i < edgeIds.length - 1) {
      signalCount++;
      time += expectedSignalDelay(signal);
    }
    if (edge.name && roadNames[roadNames.length - 1] !== edge.name && !roadNames.includes(edge.name)) {
      roadNames.push(edge.name);
    }
    sharedUsers = Math.max(sharedUsers, navigatorsOnEdge(id, ctx.userId));
    const geom = edge.geometry?.length ? edge.geometry : [index.nodes.get(edge.from)!, index.nodes.get(edge.to)!];
    for (let k = geometry.length ? 1 : 0; k < geom.length; k++) geometry.push({ lat: geom[k].lat, lng: geom[k].lng });
    prev = edge;
  });

  return { path, edgeIds, distance, estimatedTime: time, signalCount, roadNames, geometry, sharedUsers };
}

/** Validates that `edgeIds` is a connected route from source to dest; returns null otherwise. */
export function routeFromEdgeIds(
  index: GraphIndex, sourceId: string, destId: string, edgeIds: string[], ctx: RoutingContext,
): RouteInfo | null {
  if (edgeIds.length === 0) return null;
  let at = sourceId;
  for (const id of edgeIds) {
    const edge = index.edges.get(id);
    if (!edge || edge.from !== at) return null;
    at = edge.to;
  }
  return at === destId ? describeRoute(index, sourceId, edgeIds, ctx) : null;
}

function sharedLength(index: GraphIndex, a: RouteInfo, b: RouteInfo): number {
  const inB = new Set(b.edgeIds);
  let len = 0;
  for (const id of a.edgeIds) if (inB.has(id)) len += index.edges.get(id)!.length;
  return len;
}

/**
 * Up to `maxOptions` distinct routes, fastest first. Alternatives come from the penalty
 * method: edges on routes found so far get costlier, and a new route is accepted only if
 * it is within MAX_ALT_STRETCH of the best ETA and overlaps each accepted route by at most
 * MAX_ALT_OVERLAP of its length.
 */
export function findRouteOptions(
  graph: RoadGraph, signals: TrafficSignal[], sourceId: string, destId: string,
  ctx: RoutingContext = {}, maxOptions = 3,
): RouteInfo[] {
  const index = getGraphIndex(graph, signals);
  const best = aStar(index, sourceId, destId, ctx);
  if (!best || best.length === 0) return [];

  const options = [describeRoute(index, sourceId, best, ctx)];
  const penalty = new Map<string, number>();
  let last = best;
  for (let attempt = 0; attempt < maxOptions * 2 && options.length < maxOptions; attempt++) {
    for (const id of last) penalty.set(id, (penalty.get(id) ?? 1) * ALT_EDGE_PENALTY);
    const edgeIds = aStar(index, sourceId, destId, ctx, penalty);
    if (!edgeIds || edgeIds.length === 0) break;
    last = edgeIds;
    const candidate = describeRoute(index, sourceId, edgeIds, ctx);
    if (candidate.estimatedTime > options[0].estimatedTime * MAX_ALT_STRETCH) continue;
    const distinct = options.every(o => sharedLength(index, candidate, o) <= MAX_ALT_OVERLAP * candidate.distance);
    if (distinct) options.push(candidate);
  }
  return options.sort((a, b) => a.estimatedTime - b.estimatedTime);
}

/** Single best route (kept for the legacy /api/route callers). */
export function findRoute(
  graph: RoadGraph, sourceId: string, destId: string, signals: TrafficSignal[], ctx: RoutingContext = {},
): RouteInfo | null {
  return findRouteOptions(graph, signals, sourceId, destId, ctx, 1)[0] ?? null;
}

/** Road segment nearest (lat, lng) within `maxMetres`, with its reverse direction if two-way. */
export function nearestRoadSegment(
  index: GraphIndex, lat: number, lng: number, maxMetres = 60,
): { edge: RoadEdge; edgeIds: string[]; distance: number } | null {
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 111320;
  let best: RoadEdge | null = null;
  let bestDist = maxMetres;
  for (const edge of index.edgeList) {
    const g = edge.geometry?.length >= 2 ? edge.geometry : null;
    if (!g) continue;
    for (let i = 1; i < g.length; i++) {
      const ax = (g[i - 1].lng - lng) * kx, ay = (g[i - 1].lat - lat) * ky;
      const bx = (g[i].lng - lng) * kx, by = (g[i].lat - lat) * ky;
      // Cheap reject: segment bounding box far from the point
      if (Math.min(ax, bx) > bestDist || Math.max(ax, bx) < -bestDist ||
          Math.min(ay, by) > bestDist || Math.max(ay, by) < -bestDist) continue;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < bestDist) { bestDist = d; best = edge; }
    }
  }
  if (!best) return null;
  const reverse = (index.outEdges.get(best.to) ?? []).find(e => e.to === best.from);
  return { edge: best, edgeIds: reverse ? [best.id, reverse.id] : [best.id], distance: bestDist };
}
