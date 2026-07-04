import type { RoadGraph, TrafficSignal, RouteInfo, GeoPoint } from '../types';
import { SIGNAL_TIMING } from '../types';

function haversine(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * Math.PI / 180; const dLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function estimateSignalDelay(signal: TrafficSignal | undefined): number {
  if (!signal) return 0;
  const phase = signal.phases[signal.currentPhaseIndex];
  if (phase.color === 'GREEN') return Math.max(0, (phase.duration - signal.timer) * 0.3);
  // Sum remaining phases in current cycle, wrapping around to beginning
  const remaining = signal.phases.slice(signal.currentPhaseIndex + 1)
    .concat(signal.phases.slice(0, signal.currentPhaseIndex + 1));
  return remaining.reduce((s, p) => s + p.duration + p.yellowDuration, 0) + SIGNAL_TIMING.yellowDuration;
}

function edgeCost(edge: { length: number; speedLimit: number; bearing: number; congestionWeight: number }, signal: TrafficSignal | undefined, congWeight: number, prevBearing: number | null): number {
  const travelTime = edge.length / (edge.speedLimit / 3.6);
  const signalDelay = estimateSignalDelay(signal);
  const congPenalty = edge.congestionWeight * congWeight * 15;
  const turnPenalty = prevBearing !== null ? Math.abs(((edge.bearing - prevBearing + 180) % 360) - 180) / 90 * 2 : 0;
  return travelTime + signalDelay + congPenalty + turnPenalty;
}

export function aStarRoute(graph: RoadGraph, startId: string, endId: string, signals: Map<string, TrafficSignal>, options: { avoidCongestion?: boolean; preferMainRoads?: boolean } = {}): RouteInfo | null {
  const { nodes, adjacency } = graph;
  const startNode = nodes.get(startId); const endNode = nodes.get(endId);
  if (!startNode || !endNode) return null;
  const openSet = new Set<string>([startId]);
  const cameFrom = new Map<string, string>(); const gScore = new Map<string, number>(); const fScore = new Map<string, number>();
  const prevBearing = new Map<string, number | null>();
  gScore.set(startId, 0); fScore.set(startId, haversine(startNode, endNode));
  let iter = 0;
  while (openSet.size > 0 && iter < nodes.size * 2) {
    iter++; let current = ''; let currentF = Infinity;
    for (const id of openSet) { const f = fScore.get(id) ?? Infinity; if (f < currentF) { currentF = f; current = id; } }
    if (current === endId) return reconstructPath(cameFrom, current, graph, signals, gScore.get(current) ?? 0);
    openSet.delete(current);
    for (const edge of adjacency.get(current) || []) {
      const neighbor = edge.to; const neighborNode = nodes.get(neighbor); if (!neighborNode) continue;
      let e = { ...edge };
      if (options.preferMainRoads && (edge.roadType === 'residential' || edge.roadType === 'tertiary')) e.congestionWeight *= 1.5;
      const tg = (gScore.get(current) ?? Infinity) + edgeCost(e, signals.get(edge.to), options.avoidCongestion ? 2 : 1, prevBearing.get(current) ?? null);
      if (tg < (gScore.get(neighbor) ?? Infinity)) {
        cameFrom.set(neighbor, current); gScore.set(neighbor, tg);
        fScore.set(neighbor, tg + haversine(neighborNode, endNode)); prevBearing.set(neighbor, edge.bearing);
        openSet.add(neighbor);
      }
    }
  }
  return null;
}

function reconstructPath(cameFrom: Map<string, string>, current: string, graph: RoadGraph, signals: Map<string, TrafficSignal>, totalTime: number): RouteInfo {
  const path: string[] = [current];
  while (cameFrom.has(current)) { current = cameFrom.get(current)!; path.unshift(current); }
  let dist = 0, sigCount = 0, cong = 0, edgeCount = 0; const names: string[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const edges = graph.adjacency.get(path[i]) || []; const edge = edges.find(e => e.to === path[i + 1]);
    if (edge) { dist += edge.length; cong += edge.congestionWeight; edgeCount++; if (edge.name && !names.includes(edge.name)) names.push(edge.name); }
    if (signals.has(path[i + 1])) sigCount++;
  }
  return { path, distance: dist, estimatedTime: totalTime, signalCount: sigCount, avgCongestion: edgeCount > 0 ? cong / edgeCount : 0, roadNames: names };
}

export function findRouteForNavigation(graph: RoadGraph, request: { sourceNodeId: string; destNodeId: string; avoidCongestion: boolean; preferMainRoads: boolean }, signals: Map<string, TrafficSignal>): RouteInfo | null {
  return aStarRoute(graph, request.sourceNodeId, request.destNodeId, signals, { avoidCongestion: request.avoidCongestion, preferMainRoads: request.preferMainRoads });
}
