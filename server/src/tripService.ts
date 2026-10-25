/**
 * Origin–destination trips for the simulated traffic, so every vehicle drives like a real
 * person going somewhere instead of wandering.
 *
 * Zones: the city on a 0.025° grid (~2.7 km), cells with enough road. Each zone has
 *   homes   = metres of residential street in it,
 *   jobs    = known job hubs (tech parks, CBD, markets, industrial areas) + arterial length,
 *   leisure = malls and parks + neighbourhood names,
 *   an anchor = a node on a mid-sized road near its centre (not a signal).
 * Demand by IST hour (weekday / weekend): share of commutes out (home → job), back
 * (job → home), other trips and through traffic (city edge → city edge, ~5%). The
 * destination zone is drawn by gravity: weight × exp(−distance / 7 km).
 *
 * Routes: zone anchor → anchor, planned on the route workers with live traffic (up to 3
 * options), cached. Planning is budgeted (one search at a time, only when real users
 * aren't queued), so simulated traffic never delays a real driver's route. Each trip adds
 * a short drive through side streets at both ends (a walk back from the anchor and on from
 * the destination), so trips start and end on real streets; loops are cut out.
 * App users (30%) take a fresh route (≤ 10 min old, choosing among the options) and are
 * rerouted around road blocks; the rest keep their habitual route (≤ 60 min old).
 */
import type { RoadEdge, RoadGraph, TrafficSignal, Place } from './types.js';
import { getGraphIndex, type GraphIndex } from './pathfindingService.js';
import { findRouteOptionsAsync, routeQueuePerWorker } from './routeWorkers.js';
import { getSimulationEngine, rankOf, type TripPlan, type VehicleKind } from './simulationEngine.js';
import { isEdgeBlocked } from './reportsService.js';
import { isTurnBanned, onBansChanged } from './turnRules.js';

const BBOX = { s: 12.80, w: 77.42, n: 13.20, e: 77.82 };
const CELL = 0.025;
const MIN_ROAD_M = 3000;
const DECAY_M = 7000;
const APP_SHARE = 0.3;
const APP_MAX_AGE_MS = 10 * 60_000;
const HABIT_MAX_AGE_MS = 60 * 60_000;
const PLAN_EVERY_MS = 250;
const MAX_CACHE = 6000;
const REROUTE_EVERY_MS = 2000;
const MAX_REROUTES = 2;
/** Side-street drive added at each end of a trip (m) */
const LOCAL_M = [150, 700] as const;
/** A trip may borrow the route of a planned pair whose ends are this close to its own (m) */
const NEAR_M = 3500;

/** Where people work (approximate centres, relative size). */
const JOB_HUBS: [string, number, number, number][] = [
  ['Manyata Tech Park', 13.0475, 77.6205, 10], ['ITPL Whitefield', 12.9857, 77.7368, 10],
  ['Electronic City', 12.8452, 77.6600, 10], ['ORR Bellandur', 12.9260, 77.6800, 10],
  ['MG Road CBD', 12.9750, 77.6060, 9], ['Peenya Industrial Area', 13.0280, 77.5200, 8],
  ['Majestic', 12.9767, 77.5713, 7], ['KR Market', 12.9650, 77.5770, 5],
  ['Embassy Golf Links', 12.9545, 77.6440, 6], ['Bagmane Tech Park', 12.9807, 77.6620, 6],
  ['Marathahalli ORR', 12.9560, 77.7010, 6], ['Koramangala', 12.9352, 77.6245, 6],
  ['Sarjapur Road', 12.9100, 77.6850, 5], ['Indiranagar', 12.9784, 77.6408, 5],
  ['Bommasandra', 12.8150, 77.6950, 5], ['Yeshwanthpur', 13.0230, 77.5500, 4],
  ['Hebbal', 13.0450, 77.5960, 4], ['Jayanagar', 12.9300, 77.5830, 4], ['Kengeri', 12.9110, 77.4850, 3],
];
/** Where people go shopping or out. */
const LEISURE_HUBS: [string, number, number, number][] = [
  ['Phoenix Marketcity', 12.9975, 77.6960, 8], ['Orion Mall', 13.0110, 77.5550, 7],
  ['Mantri Square', 12.9916, 77.5707, 6], ['Forum Koramangala', 12.9346, 77.6112, 6],
  ['Phoenix Mall of Asia', 13.0870, 77.5980, 6], ['Nexus Shantiniketan', 12.9890, 77.7280, 5],
  ['Lalbagh', 12.9507, 77.5848, 4], ['Cubbon Park', 12.9763, 77.5929, 4], ['Commercial Street', 12.9822, 77.6083, 5],
];

interface Zone {
  i: number;
  lat: number; lng: number;
  home: number; job: number; leisure: number; through: number;
  anchor: string;
  /** Edges in the zone that trips may start or end on */
  local: RoadEdge[];
  /** Zones within NEAR_M, nearest first (itself first): stand-ins while a pair is not planned */
  near: Zone[];
}

type Purpose = 'out' | 'back' | 'other' | 'through';

let idx: GraphIndex | null = null;
const zones: Zone[] = [];
const inEdges = new Map<string, RoadEdge[]>();
/** "from|to" → route options (edge ids) and when planned */
const cache = new Map<string, { options: string[][]; at: number }>();
/** Pairs wanted but not planned yet, with how often they were asked for */
const wanted = new Map<string, number>();
let planning = false;
const stats = { planned: 0, planFailed: 0, misses: 0, borrowed: 0 };
const purposes: Record<Purpose, number> = { out: 0, back: 0, other: 0, through: 0 };

function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const kx = 111320 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot((a.lng - b.lng) * kx, (a.lat - b.lat) * 111320);
}

function cellOf(lat: number, lng: number): number {
  const cols = Math.ceil((BBOX.e - BBOX.w) / CELL);
  return Math.floor((lat - BBOX.s) / CELL) * cols + Math.floor((lng - BBOX.w) / CELL);
}

/** Builds the zones and starts planning routes. Call once the graph and signals are ready. */
export function initTrips(graph: RoadGraph, signals: TrafficSignal[], places: Place[]): void {
  idx = getGraphIndex(graph, signals);
  const index = idx;
  for (const e of index.edgeList) (inEdges.get(e.to) ?? inEdges.set(e.to, []).get(e.to)!).push(e);
  const byCell = new Map<number, { edges: RoadEdge[]; road: number; home: number; arterial: number; lat: number; lng: number; n: number }>();
  for (const e of index.edgeList) {
    const p = e.geometry[0];
    if (!p || p.lat < BBOX.s || p.lat >= BBOX.n || p.lng < BBOX.w || p.lng >= BBOX.e) continue;
    const c = cellOf(p.lat, p.lng);
    let z = byCell.get(c);
    if (!z) { z = { edges: [], road: 0, home: 0, arterial: 0, lat: 0, lng: 0, n: 0 }; byCell.set(c, z); }
    z.edges.push(e); z.road += e.length; z.lat += p.lat; z.lng += p.lng; z.n++;
    const r = rankOf(e);
    if (r === 0) z.home += e.length;
    if (r >= 3) z.arterial += e.length;
  }
  for (const z of byCell.values()) {
    if (z.road < MIN_ROAD_M) continue;
    const lat = z.lat / z.n, lng = z.lng / z.n;
    // Anchor: start of a mid-sized road near the centre, not at a signal (no turn rules at the joint)
    const candidates = z.edges.filter(e => rankOf(e) >= 1 && rankOf(e) <= 4 && !index.signalByNode.has(e.from) && !index.signalByNode.has(e.to));
    const pool = candidates.length ? candidates : z.edges;
    let best = pool[0], bestD = Infinity;
    for (const e of pool) { const d = metres(e.geometry[0], { lat, lng }); if (d < bestD) { bestD = d; best = e; } }
    const nearEdge = lat < BBOX.s + 0.03 || lat > BBOX.n - 0.03 || lng < BBOX.w + 0.03 || lng > BBOX.e - 0.03;
    zones.push({
      i: zones.length, lat, lng, home: z.home, job: z.arterial * 0.3, leisure: 0,
      through: nearEdge ? z.edges.filter(e => rankOf(e) >= 5).reduce((t, e) => t + e.length, 0) : 0,
      anchor: best.from, local: z.edges, near: [],
    });
  }
  const nearest = (lat: number, lng: number) => zones.reduce((b, z) => (metres(z, { lat, lng }) < metres(b, { lat, lng }) ? z : b), zones[0]);
  const totalHome = zones.reduce((t, z) => t + z.home, 0) || 1;
  const hubScale = totalHome / 200; // a weight-10 hub ≈ 5% of all homes' pull
  for (const [, lat, lng, w] of JOB_HUBS) nearest(lat, lng).job += w * hubScale;
  for (const [, lat, lng, w] of LEISURE_HUBS) nearest(lat, lng).leisure += w * hubScale;
  for (const p of places) {
    if (p.lat < BBOX.s || p.lat >= BBOX.n || p.lng < BBOX.w || p.lng >= BBOX.e) continue;
    const z = zones.find(x => cellOf(x.lat, x.lng) === cellOf(p.lat, p.lng));
    if (z) z.leisure += hubScale * 0.2;
  }
  for (const z of zones) z.near = zones.filter(o => metres(o, z) <= NEAR_M).sort((a, b) => metres(a, z) - metres(b, z));
  console.log(`[Trips] ${zones.length} zones, ${zones.filter(z => z.through > 0).length} on the city edge`);
  // Turn rules changed: routes planned before may use a closed turn
  onBansChanged(() => cache.clear());
  setInterval(planNext, PLAN_EVERY_MS).unref();
  setInterval(rerouteAppUsers, REROUTE_EVERY_MS).unref();
  getSimulationEngine()?.setTripSource(nextTrip);
}

/** Share of out / back / other / through trips by IST time of day. */
function demandMix(): Record<Purpose, number> {
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  const h = ist.getUTCHours(), weekend = ist.getUTCDay() === 0 || ist.getUTCDay() === 6;
  if (weekend) return { out: 0.1, back: 0.1, other: 0.75, through: 0.05 };
  if (h >= 6 && h < 11) return { out: 0.6, back: 0.05, other: 0.3, through: 0.05 };
  if (h >= 11 && h < 16) return { out: 0.15, back: 0.15, other: 0.65, through: 0.05 };
  if (h >= 16 && h < 21) return { out: 0.05, back: 0.6, other: 0.3, through: 0.05 };
  return { out: 0.1, back: 0.2, other: 0.65, through: 0.05 };
}

function draw<T>(items: T[], weight: (t: T) => number): T | null {
  let total = 0;
  for (const t of items) total += Math.max(0, weight(t));
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const t of items) { r -= Math.max(0, weight(t)); if (r <= 0) return t; }
  return items[items.length - 1];
}

/** Origin and destination zones for one new trip. */
function pickZones(): { from: Zone; to: Zone; purpose: Purpose } | null {
  const mix = demandMix();
  const purpose = draw(Object.keys(mix) as Purpose[], p => mix[p])!;
  const pull = (o: Zone, w: (z: Zone) => number) => (z: Zone) => {
    if (z === o) return 0;
    return w(z) * Math.exp(-metres(o, z) / DECAY_M);
  };
  let from: Zone | null, to: Zone | null;
  switch (purpose) {
    case 'out': from = draw(zones, z => z.home); to = from && draw(zones, pull(from, z => z.job)); break;
    case 'back': from = draw(zones, z => z.job); to = from && draw(zones, pull(from, z => z.home)); break;
    case 'through': {
      from = draw(zones, z => z.through);
      // Through traffic crosses the city: far edge zones, no distance decay
      to = from && draw(zones, z => (z.through > 0 && metres(z, from!) > 15000 ? z.through : 0));
      break;
    }
    default: {
      from = draw(zones, z => z.home * 0.6 + z.job * 0.4);
      to = from && draw(zones, pull(from, z => z.leisure * 0.5 + z.home * 0.25 + z.job * 0.25));
    }
  }
  return from && to ? { from, to, purpose } : null;
}

/** The planned pair nearest to (from, to): both ends within NEAR_M, smallest total offset. */
function borrow(from: Zone, to: Zone): { entry: { options: string[][]; at: number }; from: Zone; to: Zone } | null {
  let best: { entry: { options: string[][]; at: number }; from: Zone; to: Zone } | null = null, bestD = Infinity;
  for (const o of from.near) {
    const dO = metres(o, from);
    if (dO >= bestD) break;
    for (const d of to.near) {
      const dd = dO + metres(d, to);
      if (dd >= bestD) break;
      if (o === d) continue;
      const e = cache.get(`${o.i}|${d.i}`);
      if (e) { best = { entry: e, from: o, to: d }; bestD = dd; }
    }
  }
  return best;
}

/** A short drive through side streets: backwards into `node` (start) or onwards from it (end). */
function localDrive(node: string, toward: boolean, zone: Zone, minRank: number): string[] {
  const index = idx!;
  const want = LOCAL_M[0] + Math.random() * (LOCAL_M[1] - LOCAL_M[0]);
  const out: RoadEdge[] = [];
  let at = node, len = 0, prev: RoadEdge | null = null;
  for (let step = 0; step < 20 && len < want; step++) {
    const options = (toward ? inEdges.get(at) : index.outEdges.get(at)) ?? [];
    const ok = options.filter(e => {
      if (rankOf(e) < minRank || isEdgeBlocked(e.id)) return false;
      if (prev && (toward ? e.from === prev.to : e.to === prev.from)) return false; // no U-turn
      if (prev && (toward ? isTurnBanned(e.id, prev.id) : isTurnBanned(prev.id, e.id))) return false;
      return metres(e.geometry[0], zone) < 2500;
    });
    // Prefer smaller roads: trips start and end in side streets
    const e = draw(ok, x => 1 / (1 + rankOf(x)));
    if (!e) break;
    out.push(e); len += e.length; prev = e;
    at = toward ? e.from : e.to;
  }
  const ids = out.map(e => e.id);
  return toward ? ids.reverse() : ids;
}

/** Cuts loops (and the U-turn where the local drive meets the main route) out of a path. */
function withoutLoops(ids: string[]): string[] {
  const index = idx!;
  const out: string[] = [];
  const at = new Map<string, number>(); // node → position in out where it was the start node
  for (const id of ids) {
    const e = index.edges.get(id);
    if (!e) continue;
    const seen = at.get(e.from);
    if (seen !== undefined) {
      for (const dropped of out.splice(seen)) { const d = index.edges.get(dropped); if (d) at.delete(d.from); }
    }
    at.set(e.from, out.length);
    out.push(id);
  }
  return out;
}

function connected(ids: string[]): boolean {
  const index = idx!;
  for (let k = 1; k < ids.length; k++) {
    const a = index.edges.get(ids[k - 1]), b = index.edges.get(ids[k]);
    if (!a || !b || a.to !== b.from || isTurnBanned(a.id, b.id)) return false;
  }
  return ids.length > 0;
}

/** The spawner's trip source: a whole route from a side street to a side street. */
function nextTrip(kind: VehicleKind, warm: boolean): TripPlan | null {
  if (!idx || zones.length < 2) return null;
  const now = Date.now();
  for (let tries = 0; tries < 4; tries++) {
    const pz = pickZones();
    if (!pz) continue;
    const key = `${pz.from.i}|${pz.to.i}`;
    const app = Math.random() < APP_SHARE;
    let c = cache.get(key);
    if (!c || now - c.at > (app ? APP_MAX_AGE_MS : HABIT_MAX_AGE_MS)) wanted.set(key, (wanted.get(key) ?? 0) + 1);
    if (!c) {
      // Not planned yet: borrow a planned route between neighbouring zones (ends within NEAR_M)
      const sub = borrow(pz.from, pz.to);
      if (!sub) { stats.misses++; continue; }
      stats.borrowed++;
      c = sub.entry; pz.from = sub.from; pz.to = sub.to;
    }
    // App users spread over the options (faster ones more likely); habit drivers take the first
    const core = app && c.options.length > 1 ? c.options[Math.floor(Math.random() * c.options.length)] : c.options[0];
    if (core.some(id => isEdgeBlocked(id)) && !app) continue;
    const minRank = Math.max(0, kind.minRank - 1);
    const route = withoutLoops([...localDrive(pz.from.anchor, true, pz.from, minRank), ...core, ...localDrive(idx.edges.get(core[core.length - 1])!.to, false, pz.to, minRank)]);
    if (route.length < 2 || !connected(route)) continue;
    purposes[pz.purpose]++;
    // Filling the network: start somewhere along the trip, not all at the origin
    const startIndex = warm ? Math.floor(Math.random() * route.length * 0.8) : 0;
    const e = idx.edges.get(route[startIndex])!;
    return { route, startIndex, progress: warm ? Math.random() * e.length : 0, app };
  }
  return null;
}

/** Plans the most wanted missing or stale zone pair, when the route workers have room. */
function planNext(): void {
  if (planning || wanted.size === 0 || !idx) return;
  if (routeQueuePerWorker() > 0.5) return; // real users first
  let key = '', most = -1;
  for (const [k, n] of wanted) if (n > most) { most = n; key = k; }
  wanted.delete(key);
  const [a, b] = key.split('|').map(Number);
  const from = zones[a], to = zones[b];
  if (!from || !to) return;
  planning = true;
  findRouteOptionsAsync(from.anchor, to.anchor, { occupancy: getSimulationEngine()?.getOccupancy() }, 3)
    .then(options => {
      const good = options.map(o => o.edgeIds).filter(ids => ids.length > 0);
      if (good.length) {
        cache.set(key, { options: good, at: Date.now() });
        stats.planned++;
        if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
      } else stats.planFailed++;
    })
    .catch(() => { stats.planFailed++; })
    .finally(() => { planning = false; });
}

let rerouting = 0;
/** App-using drivers with a road block ahead on their route get a new route around it. */
function rerouteAppUsers(): void {
  const engine = getSimulationEngine();
  if (!engine || !idx || rerouting >= MAX_REROUTES || routeQueuePerWorker() > 0.5) return;
  for (const t of engine.appTrips()) {
    if (rerouting >= MAX_REROUTES) break;
    const ahead = t.route.slice(t.routeIndex + 1, t.routeIndex + 12);
    // A block, or a turn closed since the route was planned
    const closedTurn = ahead.some((id, k) => isTurnBanned(k === 0 ? t.edgeId : ahead[k - 1], id));
    if (!closedTurn && !ahead.some(id => isEdgeBlocked(id))) continue;
    const here = idx.edges.get(t.edgeId);
    const dest = idx.edges.get(t.route[t.route.length - 1]);
    if (!here || !dest) continue;
    rerouting++;
    findRouteOptionsAsync(here.to, dest.to, { occupancy: engine.getOccupancy() }, 1)
      .then(options => {
        const next = options[0]?.edgeIds;
        // The search starts at the end of the current road and doesn't know how we arrived: the joint must not be a closed turn or U-turn
        const first = next?.length ? idx!.edges.get(next[0]) : undefined;
        if (!first || first.to === here.from || isTurnBanned(t.edgeId, first.id) || next!.some(id => isEdgeBlocked(id))) return;
        if (engine.rerouteVehicle(t.id, [t.edgeId, ...next!])) engine.countTripReroute();
      })
      .catch(() => { /* try again next round */ })
      .finally(() => { rerouting--; });
  }
}

/** Operators: how the trip model is doing. */
export function tripStats() {
  const engine = getSimulationEngine();
  const t = engine?.getTripStats();
  return {
    zones: zones.length,
    cachedPairs: cache.size, waitingPairs: wanted.size, ...stats,
    purposes: { ...purposes }, mix: demandMix(),
    trips: t ? {
      ...t,
      avgMinutes: t.done ? Math.round(t.seconds / t.done / 6) / 10 : null,
      avgKm: t.done ? Math.round(t.metres / t.done / 100) / 10 : null,
      routedShare: t.started + t.fallback ? Math.round(t.started / (t.started + t.fallback) * 100) : null,
    } : null,
  };
}
