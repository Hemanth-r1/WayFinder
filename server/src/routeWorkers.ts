/**
 * Route planning on all CPU cores. The road graph is copied once into shared typed
 * arrays (a few tens of MB, not a second copy of the JS graph per worker); a pool of
 * worker threads (one per spare core) runs the A* searches; the main thread keeps the
 * simulation and refreshes the live costs in shared memory every second.
 */
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import type { RoadGraph, TrafficSignal, RouteInfo } from './types.js';
import type { SharedGraph, RouteRequest, RouteReply } from './routeWorker.js';
import {
  getGraphIndex, describeRoute, findRouteOptions, congestionFactor, forEachObservedSpeed,
  forEachNavigatorEdge, userRouteEdgeIds, LOCAL_TYPES, type RoutingContext,
} from './pathfindingService.js';
import { forEachReportEffect } from './reportsService.js';
import { expectedSignalDelay, signalControl } from './signalTiming.js';
import { getWeather } from './conditionsService.js';
import { getSimulationEngine } from './simulationEngine.js';

const REFRESH_MS = 1000;
/** A search taking longer than this is abandoned (and planned on the main thread). */
const TIMEOUT_MS = 15000;

let G: SharedGraph | null = null;
let graphRef: RoadGraph | null = null;
let signalsRef: TrafficSignal[] = [];
let nodeIdx = new Map<string, number>();
let edgeIdx = new Map<string, number>();
const workers: { w: Worker; pending: number }[] = [];
const waiting = new Map<number, { resolve: (r: RouteReply) => void; timer: NodeJS.Timeout }>();
let nextId = 1;
let touched: number[] = [];
let signalEdges: { e: number; signal: TrafficSignal; group: string }[] = [];

function shared<T extends Float64Array | Float32Array | Int32Array | Uint8Array>(
  Ctor: { new(buf: SharedArrayBuffer): T; BYTES_PER_ELEMENT: number }, length: number,
): T {
  return new Ctor(new SharedArrayBuffer(Math.max(1, length) * Ctor.BYTES_PER_ELEMENT));
}

/** Builds the shared graph and starts the workers. Call once the graph is loaded. */
export function initRouteWorkers(graph: RoadGraph, signals: TrafficSignal[]): void {
  const index = getGraphIndex(graph, signals);
  graphRef = graph; signalsRef = signals;
  const n = graph.nodes.length, m = graph.edges.length;
  nodeIdx = new Map(graph.nodes.map((nd, i) => [nd.id, i]));
  edgeIdx = new Map(graph.edges.map((e, i) => [e.id, i]));
  const g: SharedGraph = {
    n, m, maxSpeedMs: index.maxSpeedMs,
    nodeLat: shared(Float64Array, n), nodeLng: shared(Float64Array, n),
    outStart: shared(Int32Array, n + 1), outEdges: shared(Int32Array, m),
    eFrom: shared(Int32Array, m), eTo: shared(Int32Array, m), eBearing: shared(Float32Array, m),
    eLocal: shared(Uint8Array, m), eBase: shared(Float32Array, m), eLen: shared(Float32Array, m),
    eMul: shared(Float32Array, m), eBlocked: shared(Uint8Array, m), eNav: shared(Float32Array, m),
    eSignal: shared(Float32Array, m), scalars: shared(Float64Array, 1),
  };
  graph.nodes.forEach((nd, i) => { g.nodeLat[i] = nd.lat; g.nodeLng[i] = nd.lng; });
  const count = new Int32Array(n);
  graph.edges.forEach((e, i) => {
    g.eFrom[i] = nodeIdx.get(e.from)!; g.eTo[i] = nodeIdx.get(e.to)!;
    g.eBearing[i] = e.bearing; g.eLocal[i] = LOCAL_TYPES.has(e.roadType) ? 1 : 0;
    g.eBase[i] = e.length / (Math.max(5, e.speedLimit) / 3.6); g.eLen[i] = e.length; g.eMul[i] = 1;
    count[g.eFrom[i]]++;
  });
  for (let v = 0; v < n; v++) g.outStart[v + 1] = g.outStart[v] + count[v];
  const fill = g.outStart.slice(0, n);
  for (let i = 0; i < m; i++) g.outEdges[fill[g.eFrom[i]]++] = i;
  signalEdges = [];
  graph.edges.forEach((e, i) => {
    const c = signalControl(index.signalByNode, e);
    if (c) signalEdges.push({ e: i, signal: c.signal, group: c.group });
  });
  G = g;
  refreshLiveCosts();
  setInterval(refreshLiveCosts, REFRESH_MS).unref();

  // Workers: every core but the one the simulation runs on (at least one)
  const size = Math.max(1, Math.min(8, availableParallelism() - 1));
  const isTs = import.meta.url.endsWith('.ts');
  for (let k = 0; k < size; k++) {
    const w = new Worker(new URL(isTs ? './routeWorker.ts' : './routeWorker.js', import.meta.url), {
      workerData: { graph: g },
      execArgv: isTs ? ['--import', 'tsx'] : [],
    });
    const slot = { w, pending: 0 };
    w.on('message', (reply: RouteReply) => {
      slot.pending--;
      const job = waiting.get(reply.id);
      if (!job) return;
      clearTimeout(job.timer);
      waiting.delete(reply.id);
      job.resolve(reply);
    });
    w.on('error', (err: Error) => console.error('[Routes] Worker failed:', err.message));
    w.unref();
    workers.push(slot);
  }
  console.log(`[Routes] ${size} route worker${size === 1 ? '' : 's'} (${availableParallelism()} CPU cores)`);
}

/** Copies the live cost inputs into shared memory (only roads whose costs changed). */
function refreshLiveCosts(): void {
  const g = G, graph = graphRef;
  if (!g || !graph) return;
  const weather = getWeather().speedFactor;
  g.scalars[0] = weather;
  for (const i of touched) { g.eMul[i] = 1; g.eBlocked[i] = 0; g.eNav[i] = 0; }
  const next: number[] = [];
  const mul = new Map<number, { cong: number; measured: number; factor: number }>();
  const entry = (i: number) => {
    let x = mul.get(i);
    if (!x) { x = { cong: 1, measured: 0, factor: 1 }; mul.set(i, x); next.push(i); }
    return x;
  };
  for (const [id, load] of getSimulationEngine()?.getOccupancy() ?? []) {
    const i = edgeIdx.get(id);
    if (i !== undefined && load > 0) entry(i).cong = congestionFactor(graph.edges[i], load);
  }
  forEachObservedSpeed((id, kmh) => {
    const i = edgeIdx.get(id);
    if (i !== undefined) entry(i).measured = graph.edges[i].length / (Math.max(5, kmh) / 3.6);
  });
  forEachReportEffect((id, eff) => {
    const i = edgeIdx.get(id);
    if (i === undefined) return;
    entry(i).factor = eff.timeFactor;
    if (eff.blocked) g.eBlocked[i] = 1;
  });
  for (const [i, x] of mul) {
    const modelled = g.eBase[i] / weather;
    g.eMul[i] = Math.max(x.cong, x.measured / modelled) * x.factor;
  }
  forEachNavigatorEdge((id, count) => {
    const i = edgeIdx.get(id);
    if (i !== undefined) { g.eNav[i] = count; if (!mul.has(i)) { mul.set(i, { cong: 1, measured: 0, factor: 1 }); next.push(i); } }
  });
  touched = next;
  for (const s of signalEdges) g.eSignal[s.e] = expectedSignalDelay(s.signal, s.group);
}

function userHash(userId: string | undefined): number {
  if (!userId) return 0;
  let h = 2166136261;
  for (let i = 0; i < userId.length; i++) h = Math.imul(h ^ userId.charCodeAt(i), 16777619);
  return (h >>> 0) || 1;
}

/**
 * Up to `maxOptions` routes, fastest first — searched on a worker thread. Falls back to
 * the main thread before the workers are up or if a worker fails.
 */
export async function findRouteOptionsAsync(
  sourceId: string, destId: string, ctx: RoutingContext, maxOptions = 3,
): Promise<RouteInfo[]> {
  const graph = graphRef;
  const src = nodeIdx.get(sourceId), dst = nodeIdx.get(destId);
  const slot = workers.length ? workers.reduce((a, b) => (b.pending < a.pending ? b : a)) : null;
  if (!graph || !slot || src === undefined || dst === undefined) {
    return graph ? findRouteOptions(graph, signalsRef, sourceId, destId, ctx, maxOptions) : [];
  }
  const own = ctx.userId ? userRouteEdgeIds(ctx.userId).map(id => edgeIdx.get(id)).filter((i): i is number => i !== undefined) : [];
  const req: RouteRequest = { id: nextId++, src, dst, userHash: userHash(ctx.userId), own, maxOptions };
  const reply = await new Promise<RouteReply>(resolve => {
    const timer = setTimeout(() => { waiting.delete(req.id); resolve({ id: req.id, routes: [], error: 'timeout' }); }, TIMEOUT_MS);
    waiting.set(req.id, { resolve, timer });
    slot.pending++;
    slot.w.postMessage(req);
  });
  if (reply.error) {
    console.warn('[Routes] Worker search failed, planning on the main thread:', reply.error);
    return findRouteOptions(graph, signalsRef, sourceId, destId, ctx, maxOptions);
  }
  const index = getGraphIndex(graph, signalsRef);
  return reply.routes
    .map(path => describeRoute(index, sourceId, path.map(i => graph.edges[i].id), ctx))
    .sort((a, b) => a.estimatedTime - b.estimatedTime);
}
