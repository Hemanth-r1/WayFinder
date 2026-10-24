/**
 * Junction surge scenarios: fill every approach of a junction bumper-to-bumper ("100%
 * traffic"), keep heavy traffic arriving, and measure how long it takes to clear —
 * with today's fixed timings, with WayFinder's signal control, and with signal control
 * plus navigation for app users.
 */
import type { RoadEdge, TrafficSignal, RouteInfo } from './types.js';
import { getSimulationEngine, type MovementEvent } from './simulationEngine.js';
import { getGraphIndex, findRoute, type GraphIndex } from './pathfindingService.js';
import { getGraph } from './graphService.js';
import { getJunction, applyPlan, holdGreen } from './junctionService.js';
import { onMovement } from './countsService.js';
import { haversineMetres } from './osmGraph.js';

export type ScenarioMode = 'today' | 'navigation' | 'signals' | 'signals+navigation';

export interface SurgeOptions {
  junctionIds: string[];
  /** Queue length placed on every approach (m) */
  fillMetres?: number;
  /** Arrivals after the fill, as a share of each approach's capacity at today's timing */
  arrivalShare?: number;
  /** Share of drivers using the app (rerouted around the jam), in signals+navigation mode */
  appShare?: number;
}

interface ArmRoutes {
  signalId: string;
  approach: RoadEdge;
  group: string;
  /** Routes from 2.5 km upstream through this approach to each exit, 2 km beyond */
  routes: RouteInfo[];
  originId: string;
  /** Vehicles per second at today's capacity share */
  arrivalRate: number;
}

const SAT_PER_LANE_S = 0.5; // 1800 vehicles/h per lane of green
const ORIGIN_METRES = 2500;
const DEST_METRES = 2000;

function turn(a: number, b: number): number {
  return Math.abs(((b - a + 540) % 360) - 180);
}

/** Follows a road straight on (forwards or backwards) for about `metres`; returns the end node. */
function walk(index: GraphIndex, inEdges: Map<string, RoadEdge[]>, start: RoadEdge, metres: number, forward: boolean): string {
  let edge: RoadEdge | undefined = start;
  let dist = 0;
  let node = forward ? start.to : start.from;
  const seen = new Set<string>();
  while (edge && dist < metres && !seen.has(edge.id)) {
    seen.add(edge.id);
    dist += edge.length;
    node = forward ? edge.to : edge.from;
    const cur: RoadEdge = edge;
    const nexts = forward
      ? (index.outEdges.get(cur.to) ?? []).filter(e => e.to !== cur.from)
      : (inEdges.get(cur.from) ?? []).filter(e => e.from !== cur.to);
    edge = nexts.sort((p, q) => turn(p.bearing, cur.bearing) - turn(q.bearing, cur.bearing))[0];
  }
  return node;
}

/** Origin–destination routes through every approach of the junctions. */
async function buildArms(junctionIds: string[]): Promise<ArmRoutes[]> {
  const { graph, signals } = await getGraph();
  const index = getGraphIndex(graph, signals);
  const inEdges = new Map<string, RoadEdge[]>();
  for (const e of index.edgeList) (inEdges.get(e.to) ?? inEdges.set(e.to, []).get(e.to)!).push(e);

  const arms: ArmRoutes[] = [];
  for (const id of junctionIds) {
    const sig = signals.find(s => s.id === id);
    if (!sig) continue;
    const members = new Set(sig.nodeIds ?? [sig.nodeId]);
    const exits: RoadEdge[] = [];
    for (const n of members) for (const e of index.outEdges.get(n) ?? []) if (!members.has(e.to)) exits.push(e);
    const dests = [...new Set(exits.map(x => walk(index, inEdges, x, DEST_METRES, true)))];
    for (const a of sig.approaches) {
      if (a.group === 'FREE') continue;
      const approach = index.edges.get(a.edgeId);
      if (!approach) continue;
      const originId = walk(index, inEdges, approach, ORIGIN_METRES, false);
      const routes: RouteInfo[] = [];
      for (const d of dests) {
        const r = findRoute(graph, originId, d, signals);
        if (r && r.edgeIds.includes(approach.id) && r.distance < 8000) routes.push(r);
      }
      if (routes.length === 0) continue;
      const green = sig.phases.filter(p => p.group === a.group && p.color === 'GREEN').reduce((t, p) => t + p.duration, 0);
      arms.push({
        signalId: id, approach, group: a.group, routes, originId,
        arrivalRate: approach.lanes * SAT_PER_LANE_S * green / sig.cycleLength,
      });
    }
  }
  return arms;
}

/**
 * Fills every approach with a standing queue `fillMetres` long (all lanes). Returns the
 * ids of the placed vehicles.
 */
async function fillApproaches(arms: ArmRoutes[], fillMetres: number): Promise<string[]> {
  const engine = getSimulationEngine()!;
  const { graph, signals } = await getGraph();
  const index = getGraphIndex(graph, signals);
  const ids: string[] = [];
  const SPACING = 6; // metres per vehicle per lane, bumper to bumper
  for (const arm of arms) {
    for (let back = 3; back < fillMetres; back += SPACING) {
      for (let lane = 0; lane < Math.max(1, arm.approach.lanes); lane++) {
        const r = arm.routes[Math.floor(Math.random() * arm.routes.length)];
        const ai = r.edgeIds.indexOf(arm.approach.id);
        // Walk back along this route from the stop line
        let k = ai, remaining = back;
        while (k >= 0) {
          const e = index.edges.get(r.edgeIds[k])!;
          if (remaining <= e.length) break;
          remaining -= e.length;
          k--;
        }
        if (k < 0) continue;
        const e = index.edges.get(r.edgeIds[k])!;
        const id = engine.addRoutedVehicle(r.edgeIds, { startIndex: k, progress: e.length - remaining, lane, queued: true });
        if (id) ids.push(id);
      }
    }
  }
  return ids;
}

export interface ScenarioSample {
  minute: number;
  /** Vehicles stopped or crawling within 700 m of the junctions */
  queued: number;
  /** Vehicles of the initial queue still waiting to cross */
  initialLeft: number;
  /** Vehicles that crossed the junctions in the last sample period */
  crossed: number;
}

export interface ScenarioResult {
  mode: ScenarioMode;
  junctions: string[];
  initialQueue: number;
  peakQueued: number;
  /** Minutes until every vehicle of the initial queue had crossed */
  initialClearedMin: number | null;
  /** Minutes until the queue fell below 25% of its peak (and stayed there) */
  normalMin: number | null;
  avgWaitS: number;
  maxWaitS: number;
  crossedPerHour: number;
  appRerouted: number;
  controlActions: number;
  timeline: ScenarioSample[];
}

/**
 * Runs a surge for `minutes` of simulated time, stepping the engine directly (faster
 * than real time). The engine must be initialised and not running its own loop.
 */
export async function runSurge(mode: ScenarioMode, opts: SurgeOptions, minutes = 40, dt = 0.25): Promise<ScenarioResult> {
  const engine = getSimulationEngine()!;
  const { graph, signals } = await getGraph();
  const index = getGraphIndex(graph, signals);
  const arms = await buildArms(opts.junctionIds);
  const centre = opts.junctionIds.map(id => signals.find(s => s.id === id)!).filter(Boolean)
    .map(s => index.nodes.get(s.nodeId)!)
    .reduce((c, n, _, all) => ({ lat: c.lat + n.lat / all.length, lng: c.lng + n.lng / all.length }), { lat: 0, lng: 0 });
  const box: [number, number, number, number] = [centre.lng - 0.008, centre.lat - 0.008, centre.lng + 0.008, centre.lat + 0.008];

  const initial = new Set(await fillApproaches(arms, opts.fillMetres ?? 600));
  const initialQueue = initial.size;
  const junctionSet = new Set(opts.junctionIds);
  const waits: number[] = [];
  let crossedWindow = 0, crossedTotal = 0;
  const off = onMovement((m: MovementEvent) => {
    if (!junctionSet.has(m.signalId)) return;
    crossedWindow++; crossedTotal++;
    waits.push(m.waitSeconds);
    initial.delete(m.vehicleId);
  });

  const appShare = mode === 'signals+navigation' || mode === 'navigation' ? (opts.appShare ?? 0.4) : 0;
  const controlSignals = mode === 'signals' || mode === 'signals+navigation';
  const lastHold = new Map<string, number>();
  const arrivalShare = opts.arrivalShare ?? 0.8;
  const accum = new Map<ArmRoutes, number>();
  let appRerouted = 0, controlActions = 0;
  const timeline: ScenarioSample[] = [];
  let peakQueued = 0, initialClearedMin: number | null = null, normalMin: number | null = null, belowCount = 0;

  /** App user: route from `fromNode` to the destination with live traffic; may skip the jam. */
  const appRoute = (fromNode: string, destNode: string) =>
    findRoute(graph, fromNode, destNode, signals, { occupancy: engine.getOccupancy() });

  // App users already in the queue but far enough back reroute once, a minute in
  const rerouteQueued = () => {
    for (const id of initial) {
      if (Math.random() >= appShare) continue;
      const r = engine.vehicleRoute(id);
      if (!r || r.v > 1.5) continue;
      const here = index.edges.get(r.route[r.routeIndex]);
      const dest = index.edges.get(r.route[r.route.length - 1])?.to;
      if (!here || !dest) continue;
      const alt = appRoute(here.to, dest);
      if (!alt || alt.edgeIds.some(e => r.route.slice(r.routeIndex + 1, r.routeIndex + 4).includes(e))) continue;
      // A rerouted driver leaves the jam by another road: no longer waiting to cross here
      if (engine.rerouteVehicle(id, [here.id, ...alt.edgeIds])) { appRerouted++; initial.delete(id); }
    }
  };

  const steps = Math.round(minutes * 60 / dt);
  for (let step = 0; step < steps; step++) {
    const t = step * dt;

    // Arrivals on every approach
    for (const arm of arms) {
      const due = (accum.get(arm) ?? 0) + arm.arrivalRate * arrivalShare * dt;
      let n = Math.floor(due);
      accum.set(arm, due - n);
      while (n-- > 0) {
        let route = arm.routes[Math.floor(Math.random() * arm.routes.length)];
        if (Math.random() < appShare) {
          const alt = appRoute(arm.originId, index.edges.get(route.edgeIds[route.edgeIds.length - 1])!.to);
          if (alt) {
            if (!alt.edgeIds.includes(arm.approach.id)) appRerouted++;
            route = alt;
          }
        }
        engine.addRoutedVehicle(route.edgeIds, { startIndex: 0, progress: 0 });
      }
    }

    // WayFinder signal control: suggested timing every minute; a coordinated hold only
    // when a queue is about to block the junction behind it (at most every 2 minutes)
    if (controlSignals && step % Math.round(60 / dt) === 0 && t > 0) {
      for (const id of opts.junctionIds) {
        applyPlan(id, 'recommended', 'scenario');
        controlActions++;
        const j = getJunction(id);
        const spill = j?.approaches
          .filter(a => a.from && a.queueMetres >= 0.75 * a.from.metres)
          .sort((a, b) => b.queueMetres - a.queueMetres)[0];
        if (j && spill && !j.control?.hold && t - (lastHold.get(id) ?? -1e9) >= 120) {
          holdGreen(id, spill.group, 30, true, 'scenario');
          lastHold.set(id, t);
          controlActions++;
        }
      }
    }
    if (appShare > 0 && step === Math.round(60 / dt)) rerouteQueued();

    await engine.update(dt);

    // Sample every 30 s
    if (step % Math.round(30 / dt) === 0) {
      const near = engine.getVehiclesIn(box, 100000)
        .filter(v => v.speed < 7 && haversineMetres(v, centre) < 700).length;
      peakQueued = Math.max(peakQueued, near);
      const minute = Math.round(t / 6) / 10;
      timeline.push({ minute, queued: near, initialLeft: initial.size, crossed: crossedWindow });
      crossedWindow = 0;
      if (initialClearedMin === null && initial.size === 0) initialClearedMin = minute;
      if (t > 120 && near < peakQueued * 0.25) {
        if (++belowCount >= 2 && normalMin === null) normalMin = minute;
      } else belowCount = 0;
    }
  }
  off();

  const sorted = [...waits].sort((a, b) => a - b);
  return {
    mode, junctions: opts.junctionIds, initialQueue, peakQueued,
    initialClearedMin, normalMin,
    avgWaitS: Math.round(waits.reduce((s, w) => s + w, 0) / Math.max(1, waits.length)),
    maxWaitS: sorted.length ? sorted[sorted.length - 1] : 0,
    crossedPerHour: Math.round(crossedTotal / (minutes / 60)),
    appRerouted, controlActions, timeline,
  };
}

/** Live demo: fills the junction approaches in the running simulation (no measurement). */
export async function surgeLive(junctionIds: string[], fillMetres = 600): Promise<number> {
  const arms = await buildArms(junctionIds);
  return (await fillApproaches(arms, fillMetres)).length;
}

export type { TrafficSignal };
