/**
 * Route search worker. Runs A* on the shared, typed-array road graph that the main
 * thread builds once (routeWorkers.ts), so searches use the other CPU cores and never
 * stall the simulation. Live costs (traffic, reports, other navigators, signals) are
 * shared memory the main thread refreshes every second. Mirrors pathfindingService's
 * cost model.
 */
import { parentPort, workerData } from 'node:worker_threads';

export interface SharedGraph {
  n: number;
  m: number;
  maxSpeedMs: number;
  nodeLat: Float64Array; nodeLng: Float64Array;
  outStart: Int32Array; outEdges: Int32Array;
  eFrom: Int32Array; eTo: Int32Array; eBearing: Float32Array; eLocal: Uint8Array;
  /** Free-flow seconds */
  eBase: Float32Array; eLen: Float32Array;
  /** Live: traffic × measured speed × report factor (1 = free flow) */
  eMul: Float32Array;
  eBlocked: Uint8Array;
  /** Live: navigators routed over the edge */
  eNav: Float32Array;
  /** Live: expected wait at the signal at the edge's end (s) */
  eSignal: Float32Array;
  /** Live: [weather speed factor] */
  scalars: Float64Array;
}

export interface RouteRequest {
  id: number;
  src: number;
  dst: number;
  /** Hash of the user id (cost spread between users), 0 for none */
  userHash: number;
  /** Edges of this user's own registered route: not counted as other navigators' load */
  own: number[];
  maxOptions: number;
}

export interface RouteReply { id: number; routes: number[][]; error?: string }
/** Steps closed by junction turn rules, as edge index pairs [from, to, from, to, …] */
export interface BansMessage { bans: number[] }

/** Closed steps, keyed fromEdge * m + toEdge */
let bans = new Set<number>();

// Same tuning as pathfindingService.ts
const SHARE_PENALTY = 0.12;
const MAX_SHARE_FACTOR = 2;
const USER_SPREAD = 0.03;
const TURN_SECONDS_PER_90 = 3;
const U_TURN_PENALTY = 30;
const LOCAL_STREET_METRES = 1500;
const MAX_ALT_STRETCH = 1.3;
const MAX_ALT_OVERLAP = 0.75;
const ALT_EDGE_PENALTY = 1.4;

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function spread(userHash: number, e: number): number {
  if (!userHash) return 1;
  let h = Math.imul(userHash ^ e, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return 1 + ((h >>> 0) / 0xffffffff) * USER_SPREAD;
}

export function createSearcher(G: SharedGraph) {
  // Search state per road segment (edge), not per junction: with closed turns the best way
  // can pass the same junction twice (straight on, U-turn further on, back through it)
  const g = new Float64Array(G.m).fill(Infinity);
  const via = new Int32Array(G.m).fill(-1);
  const closed = new Uint8Array(G.m);
  const touched: number[] = [];
  // Binary heap of (edge, key)
  let hn = new Int32Array(1024), hk = new Float64Array(1024), hs = 0;
  const push = (node: number, key: number) => {
    if (hs === hn.length) {
      const n2 = new Int32Array(hs * 2); n2.set(hn); hn = n2;
      const k2 = new Float64Array(hs * 2); k2.set(hk); hk = k2;
    }
    let i = hs++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= key) break;
      hn[i] = hn[p]; hk[i] = hk[p]; i = p;
    }
    hn[i] = node; hk[i] = key;
  };
  const pop = (): number => {
    const top = hn[0];
    const ln = hn[--hs], lk = hk[hs];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i, mk = lk;
      if (l < hs && hk[l] < mk) { m = l; mk = hk[l]; }
      if (r < hs && hk[r] < mk) { m = r; mk = hk[r]; }
      if (m === i) break;
      hn[i] = hn[m]; hk[i] = hk[m]; i = m;
    }
    hn[i] = ln; hk[i] = lk;
    return top;
  };

  /** Seconds to drive edge e now, as pathfindingService.edgeTravelTime. */
  const travel = (e: number, own: Set<number>): number => {
    const others = Math.max(0, G.eNav[e] - (own.has(e) ? 1 : 0));
    return G.eBase[e] / G.scalars[0] * G.eMul[e] * Math.min(MAX_SHARE_FACTOR, 1 + SHARE_PENALTY * others);
  };
  const turn = (prev: number, next: number): number => {
    if (prev < 0) return 0;
    if (G.eTo[next] === G.eFrom[prev]) return U_TURN_PENALTY + 2 * TURN_SECONDS_PER_90;
    const diff = Math.abs(((G.eBearing[next] - G.eBearing[prev] + 540) % 360) - 180);
    return (diff / 90) * TURN_SECONDS_PER_90;
  };

  function aStar(src: number, dst: number, userHash: number, own: Set<number>, penalty?: Map<number, number>): number[] | null {
    if (src === dst) return [];
    for (const e of touched) { g[e] = Infinity; via[e] = -1; closed[e] = 0; }
    touched.length = 0;
    hs = 0;
    const sLat = G.nodeLat[src], sLng = G.nodeLng[src], dLat = G.nodeLat[dst], dLng = G.nodeLng[dst];
    const localOk = (v: number) =>
      haversine(G.nodeLat[v], G.nodeLng[v], sLat, sLng) <= LOCAL_STREET_METRES ||
      haversine(G.nodeLat[v], G.nodeLng[v], dLat, dLng) <= LOCAL_STREET_METRES;
    // Reach the end of edge e coming from edge prev (−1 at the start)
    const relax = (e: number, prev: number, base: number) => {
      const to = G.eTo[e];
      if (G.eBlocked[e]) return;
      if (prev >= 0 && bans.size > 0 && bans.has(prev * G.m + e)) return; // closed turn
      if (G.eLocal[e] && !localOk(to) && !localOk(G.eFrom[e])) return;
      const t = base + travel(e, own) * spread(userHash, e) * (penalty?.get(e) ?? 1) +
        turn(prev, e) + (to !== dst ? G.eSignal[e] : 0);
      if (t < g[e]) {
        if (g[e] === Infinity) touched.push(e);
        g[e] = t; via[e] = prev;
        push(e, t + haversine(G.nodeLat[to], G.nodeLng[to], dLat, dLng) / G.maxSpeedMs);
      }
    };
    for (let k = G.outStart[src]; k < G.outStart[src + 1]; k++) relax(G.outEdges[k], -1, 0);
    while (hs > 0) {
      const cur = pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      const node = G.eTo[cur];
      if (node === dst) {
        const path: number[] = [];
        for (let e = cur; e >= 0; e = via[e]) path.push(e);
        return path.reverse();
      }
      for (let k = G.outStart[node]; k < G.outStart[node + 1]; k++) {
        const e = G.outEdges[k];
        if (!closed[e]) relax(e, cur, g[cur]);
      }
    }
    return null;
  }

  /** Estimated seconds and metres of a route, as pathfindingService.describeRoute. */
  function measure(path: number[], own: Set<number>): { time: number; distance: number } {
    let time = 0, distance = 0, prev = -1;
    path.forEach((e, i) => {
      time += travel(e, own) + turn(prev, e) + (i < path.length - 1 ? G.eSignal[e] : 0);
      distance += G.eLen[e];
      prev = e;
    });
    return { time, distance };
  }

  /** Up to maxOptions distinct routes, as pathfindingService.findRouteOptions. */
  return function routeOptions(req: RouteRequest): number[][] {
    const own = new Set(req.own);
    const best = aStar(req.src, req.dst, req.userHash, own);
    if (!best || best.length === 0) return [];
    const options = [{ path: best, ...measure(best, own) }];
    const penalty = new Map<number, number>();
    let last = best;
    for (let attempt = 0; attempt < req.maxOptions * 2 && options.length < req.maxOptions; attempt++) {
      for (const e of last) penalty.set(e, (penalty.get(e) ?? 1) * ALT_EDGE_PENALTY);
      const path = aStar(req.src, req.dst, req.userHash, own, penalty);
      if (!path || path.length === 0) break;
      last = path;
      const cand = { path, ...measure(path, own) };
      if (cand.time > options[0].time * MAX_ALT_STRETCH) continue;
      const set = new Set(path);
      const distinct = options.every(o => {
        let shared = 0;
        for (const e of o.path) if (set.has(e)) shared += G.eLen[e];
        return shared <= MAX_ALT_OVERLAP * cand.distance;
      });
      if (distinct) options.push(cand);
    }
    return options.map(o => o.path);
  };
}

if (parentPort && workerData?.graph) {
  const search = createSearcher(workerData.graph as SharedGraph);
  parentPort.on('message', (req: RouteRequest | BansMessage) => {
    if ('bans' in req) {
      const m = (workerData.graph as SharedGraph).m, next = new Set<number>();
      for (let i = 0; i + 1 < req.bans.length; i += 2) next.add(req.bans[i] * m + req.bans[i + 1]);
      bans = next;
      return;
    }
    let reply: RouteReply;
    try { reply = { id: req.id, routes: search(req) }; }
    catch (err) { reply = { id: req.id, routes: [], error: (err as Error).message }; }
    parentPort!.postMessage(reply);
  });
}
