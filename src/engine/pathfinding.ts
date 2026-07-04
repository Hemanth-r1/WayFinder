import type { RoadEdge, RoadGraph, TrafficSignal, RouteInfo, NavigationRequest, GeoPoint } from '../types';
import { SIGNAL_TIMING } from '../types';

const EARTH_RADIUS_M = 6371000;

function haversineDistance(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function estimateSignalDelay(signal: TrafficSignal | undefined): number {
  if (!signal) return 0;
  const phase = signal.phases[signal.currentPhaseIndex];
  if (phase.color === 'GREEN') {
    const remaining = phase.duration - signal.timer;
    return Math.max(0, remaining * 0.3);
  }
  const timeToGreen = signal.phases
    .slice(signal.currentPhaseIndex + 1)
    .reduce((sum, p) => sum + p.duration + p.yellowDuration, 0);
  return timeToGreen + SIGNAL_TIMING.yellowDuration;
}

function edgeCost(
  edge: RoadEdge,
  signal: TrafficSignal | undefined,
  congestionWeight: number,
  prevEdgeBearing: number | null,
): number {
  const travelTime = (edge.length / (edge.speedLimit / 3.6));
  const signalDelay = estimateSignalDelay(signal);
  const congestionPenalty = edge.congestionWeight * congestionWeight * 15;
  const turnPenalty = prevEdgeBearing !== null
    ? Math.abs(((edge.bearing - prevEdgeBearing + 180) % 360) - 180) / 90 * 2
    : 0;
  return travelTime + signalDelay + congestionPenalty + turnPenalty;
}

export function aStarRoute(
  graph: RoadGraph,
  startId: string,
  endId: string,
  signals: Map<string, TrafficSignal>,
  options: { avoidCongestion?: boolean; preferMainRoads?: boolean } = {},
): RouteInfo | null {
  const { nodes, adjacency } = graph;
  const startNode = nodes.get(startId);
  const endNode = nodes.get(endId);
  if (!startNode || !endNode) return null;

  const openSet = new Set<string>([startId]);
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>();
  const fScore = new Map<string, number>();
  const prevEdgeBearing = new Map<string, number | null>();

  gScore.set(startId, 0);
  fScore.set(startId, haversineDistance(startNode, endNode));

  let iterations = 0;
  const maxIterations = nodes.size * 2;

  while (openSet.size > 0 && iterations < maxIterations) {
    iterations++;
    let current = '';
    let currentF = Infinity;
    for (const id of openSet) {
      const f = fScore.get(id) ?? Infinity;
      if (f < currentF) { currentF = f; current = id; }
    }

    if (current === endId) {
      return reconstructPath(cameFrom, current, graph, signals, gScore.get(current) ?? 0);
    }

    openSet.delete(current);
    const neighbors = adjacency.get(current) || [];

    for (const edge of neighbors) {
      const neighbor = edge.to;
      const neighborNode = nodes.get(neighbor);
      if (!neighborNode) continue;

      let effectiveEdge = { ...edge };
      if (options.preferMainRoads && (edge.roadType === 'residential' || edge.roadType === 'tertiary')) {
        effectiveEdge.congestionWeight *= 1.5;
      }

      const targetSignal = signals.get(edge.to);
      const prevBearing = prevEdgeBearing.get(current);
      const tentativeG = (gScore.get(current) ?? Infinity) +
        edgeCost(effectiveEdge, targetSignal, options.avoidCongestion ? 2 : 1,         prevBearing ?? null);


      if (tentativeG < (gScore.get(neighbor) ?? Infinity)) {
        cameFrom.set(neighbor, current);
        gScore.set(neighbor, tentativeG);
        fScore.set(neighbor, tentativeG + haversineDistance(neighborNode, endNode));
        prevEdgeBearing.set(neighbor, edge.bearing);
        openSet.add(neighbor);
      }
    }
  }

  return null;
}

function reconstructPath(
  cameFrom: Map<string, string>,
  current: string,
  graph: RoadGraph,
  signals: Map<string, TrafficSignal>,
  totalTime: number,
): RouteInfo {
  const path: string[] = [current];
  while (cameFrom.has(current)) {
    current = cameFrom.get(current)!;
    path.unshift(current);
  }

  let totalDistance = 0;
  let signalCount = 0;
  let totalCongestion = 0;
  let edgeCount = 0;
  const roadNames: string[] = [];

  for (let i = 0; i < path.length - 1; i++) {
    const fromId = path[i];
    const toId = path[i + 1];
    const edges = graph.adjacency.get(fromId) || [];
    const edge = edges.find(e => e.to === toId);
    if (edge) {
      totalDistance += edge.length;
      totalCongestion += edge.congestionWeight;
      edgeCount++;
      if (edge.name && !roadNames.includes(edge.name)) roadNames.push(edge.name);
    }
    if (signals.has(toId)) signalCount++;
  }

  return {
    path,
    distance: totalDistance,
    estimatedTime: totalTime,
    signalCount,
    avgCongestion: edgeCount > 0 ? totalCongestion / edgeCount : 0,
    roadNames,
  };
}

export function findRouteForNavigation(
  graph: RoadGraph,
  request: NavigationRequest,
  signals: Map<string, TrafficSignal>,
): RouteInfo | null {
  return aStarRoute(graph, request.sourceNodeId, request.destNodeId, signals, {
    avoidCongestion: request.avoidCongestion,
    preferMainRoads: request.preferMainRoads,
  });
}

export function generateRandomRoute(
  graph: RoadGraph,
  signals: Map<string, TrafficSignal>,
): { startId: string; endId: string; route: RouteInfo } | null {
  const nodeIds = Array.from(graph.nodes.keys());
  if (nodeIds.length < 2) return null;

  const edgeNodes = nodeIds.filter(id => {
    const adj = graph.adjacency.get(id) || [];
    return adj.length < 4;
  });

  const candidates = edgeNodes.length > 0 ? edgeNodes : nodeIds;
  const maxAttempts = 20;

  for (let i = 0; i < maxAttempts; i++) {
    const startId = candidates[Math.floor(Math.random() * candidates.length)];
    let endId = candidates[Math.floor(Math.random() * candidates.length)];
    let attempts = 0;
    while (endId === startId && attempts < 10) {
      endId = candidates[Math.floor(Math.random() * candidates.length)];
      attempts++;
    }
    if (endId === startId) continue;

    const route = aStarRoute(graph, startId, endId, signals);
    if (route && route.path.length >= 3) {
      return { startId, endId, route };
    }
  }

  return null;
}
