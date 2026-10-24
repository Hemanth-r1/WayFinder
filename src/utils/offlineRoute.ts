/**
 * Route planning on the device, used when the WayFinder server can't be reached.
 * Uses the downloaded road network with free-flow speeds and typical signal waits —
 * no live traffic, crowd reports or route spreading (those need the server).
 */
import type { RoadGraph, RoadEdge, TrafficSignal } from '../types';
import type { RouteOption } from '../services/serverClient';

/** Average wait at a signal for a random arrival (s), roughly a quarter cycle. */
const SIGNAL_WAIT = 25;
const TURN_SECONDS_PER_90 = 3;

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** Binary min-heap of [priority, nodeId]. */
class Heap {
  private items: [number, string][] = [];
  get size() { return this.items.length; }
  push(p: number, id: string) {
    const a = this.items; a.push([p, id]);
    let i = a.length - 1;
    while (i > 0) { const j = (i - 1) >> 1; if (a[j][0] <= a[i][0]) break; [a[i], a[j]] = [a[j], a[i]]; i = j; }
  }
  pop(): string {
    const a = this.items; const top = a[0][1]; const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

/** Fastest route by free-flow time, or null when unreachable. */
export function offlineRoute(
  graph: RoadGraph, signals: Map<string, TrafficSignal>, sourceId: string, destId: string,
): RouteOption | null {
  const dest = graph.nodes.get(destId);
  if (!dest || !graph.nodes.has(sourceId)) return null;
  const signalNodes = new Set<string>();
  for (const s of signals.values()) for (const n of s.nodeIds ?? [s.nodeId]) signalNodes.add(n);
  let maxSpeed = 10;
  for (const e of graph.edges.values()) maxSpeed = Math.max(maxSpeed, e.speedLimit);
  const vmax = maxSpeed / 3.6;

  const g = new Map<string, number>([[sourceId, 0]]);
  const via = new Map<string, RoadEdge>();
  const done = new Set<string>();
  const heap = new Heap();
  heap.push(0, sourceId);
  while (heap.size > 0) {
    const cur = heap.pop();
    if (done.has(cur)) continue;
    if (cur === destId) break;
    done.add(cur);
    const inEdge = via.get(cur);
    for (const e of graph.adjacency.get(cur) ?? []) {
      if (done.has(e.to)) continue;
      const turn = inEdge ? Math.abs(((e.bearing - inEdge.bearing + 540) % 360) - 180) : 0;
      const cost = e.length / (Math.max(5, e.speedLimit) / 3.6)
        + (turn / 90) * TURN_SECONDS_PER_90 + (turn > 170 ? 30 : 0)
        + (signalNodes.has(e.to) && e.to !== destId ? SIGNAL_WAIT : 0);
      const t = g.get(cur)! + cost;
      if (t < (g.get(e.to) ?? Infinity)) {
        g.set(e.to, t);
        via.set(e.to, e);
        heap.push(t + haversine(graph.nodes.get(e.to)!, dest) / vmax, e.to);
      }
    }
  }
  if (!via.has(destId) && sourceId !== destId) return null;

  const edges: RoadEdge[] = [];
  for (let n = destId; n !== sourceId;) { const e = via.get(n)!; edges.unshift(e); n = e.from; }
  const geometry: { lat: number; lng: number }[] = [];
  const roadNames: string[] = [];
  let distance = 0, signalCount = 0;
  edges.forEach((e, i) => {
    distance += e.length;
    if (signalNodes.has(e.to) && i < edges.length - 1) signalCount++;
    if (e.name && !roadNames.includes(e.name)) roadNames.push(e.name);
    for (let k = geometry.length ? 1 : 0; k < e.geometry.length; k++) geometry.push(e.geometry[k]);
  });
  return {
    path: [sourceId, ...edges.map(e => e.to)], edgeIds: edges.map(e => e.id),
    distance, estimatedTime: g.get(destId) ?? 0, signalCount, roadNames, geometry, sharedUsers: 0,
  };
}
