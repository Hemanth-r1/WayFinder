import type { Vehicle, TrafficSignal, RoadGraph, CorridorInfo } from '../types';
import { SIGNAL_CONFIG } from '../config';

/**
 * Count vehicles per road edge.
 */
function buildEdgeFlow(vehicles: Map<string, Vehicle>, graph: RoadGraph): Map<string, number> {
  const flow = new Map<string, number>();
  for (const [, v] of vehicles) {
    const edge = graph.edges.get(v.currentEdgeId);
    if (edge) flow.set(v.currentEdgeId, (flow.get(v.currentEdgeId) || 0) + 1);
  }
  return flow;
}

/**
 * Score each signal by total incident edge flow.
 */
function scoreSignals(
  signals: Map<string, TrafficSignal>,
  edgeFlow: Map<string, number>,
  graph: RoadGraph,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const [, sig] of signals) {
    let total = 0;
    const adj = graph.adjacency.get(sig.nodeId) || [];
    for (const e of adj) total += edgeFlow.get(e.id) || 0;
    scores.set(sig.nodeId, total);
  }
  return scores;
}

/**
 * Walk forward from a signal along the dominant flow direction,
 * collecting consecutive signals up to MAX_SIGNAL_DISTANCE apart.
 */
function walkCorridor(
  startId: string,
  signals: Map<string, TrafficSignal>,
  graph: RoadGraph,
  scores: Map<string, number>,
): string[] {
  const corridor: string[] = [startId];
  let current = startId;

  for (let attempt = 0; attempt < 20; attempt++) {
    const adj = graph.adjacency.get(current) || [];
    if (adj.length === 0) break;

    let bestEdge = adj[0];
    let bestFlow = 0;
    for (const e of adj) {
      const f = scores.get(e.to) || 0;
      if (f > bestFlow) { bestFlow = f; bestEdge = e; }
    }

    const nextId = bestEdge.to;
    if (!signals.has(nextId)) break;
    if (corridor.includes(nextId)) break;

    const edgeLen = bestEdge.length;
    if (edgeLen > SIGNAL_CONFIG.CORRIDOR.MAX_SIGNAL_DISTANCE) break;

    corridor.push(nextId);
    current = nextId;
  }

  return corridor;
}

export function detectCorridors(
  vehicles: Map<string, Vehicle>,
  graph: RoadGraph,
  signals: Map<string, TrafficSignal>,
): CorridorInfo[] {
  if (signals.size < SIGNAL_CONFIG.CORRIDOR.MIN_SIGNALS) return [];

  const edgeFlow = buildEdgeFlow(vehicles, graph);
  const scores = scoreSignals(signals, edgeFlow, graph);

  const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);

  const used = new Set<string>();
  const corridors: CorridorInfo[] = [];

  for (const [nodeId] of sorted) {
    if (used.has(nodeId)) continue;
    const sigIds = walkCorridor(nodeId, signals, graph, scores);
    if (sigIds.length < SIGNAL_CONFIG.CORRIDOR.MIN_SIGNALS) continue;

    for (const sid of sigIds) used.add(sid);

    let weight = 0;
    for (const sid of sigIds) weight += scores.get(sid) || 0;

    corridors.push({
      id: `cor-${corridors.length}`,
      signalIds: sigIds,
      weight,
      avgSpeedKmh: 0,
    });

    if (corridors.length >= SIGNAL_CONFIG.CORRIDOR.MAX_CORRIDORS) break;
  }

  return corridors;
}
