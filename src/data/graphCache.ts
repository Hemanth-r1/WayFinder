/**
 * graphCache.ts — localStorage persistence for the road graph (REQ-P1, REQ-G5)
 * Key: wayfinder_graph_v2_{lat}_{lng}_{radius}
 * TTL: 24 hours
 */
import type { RoadNode, RoadEdge, TrafficSignal, SignalPhase, GeoPoint, RoadGraph, SignalApproach } from '../types';

const CACHE_VERSION = 'v2';
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CachedGraph {
  timestamp: number;
  nodes: Array<[string, RoadNode]>;
  edges: Array<[string, { id: string; from: string; to: string; roadType: string; speedLimit: number; lanes: number; length: number; bearing: number; name?: string; congestionWeight: number; geometry: GeoPoint[]; oneway: boolean }]>;
  adjacencyKeys: string[];     // edge IDs in order per node
  adjacencyNodeIds: string[];  // node IDs parallel to edge arrays
  signals: Array<[string, { id: string; nodeId: string; phases: SignalPhase[]; currentPhaseIndex: number; timer: number; cycleLength: number; offset: number; congestionLevel: number; adaptiveTiming: boolean; approaches: SignalApproach[]; greenWaveDirection: string | null }]>;
}

function cacheKey(lat: number, lng: number, radius: number): string {
  return `wayfinder_graph_${CACHE_VERSION}_${lat.toFixed(4)}_${lng.toFixed(4)}_${radius}`;
}

export function saveGraphToCache(
  lat: number, lng: number, radius: number,
  graph: RoadGraph,
  signals: Map<string, TrafficSignal>,
): void {
  try {
    // Build adjacency serialization
    const adjacencyKeys: string[] = [];
    const adjacencyNodeIds: string[] = [];
    for (const [nodeId, edges] of graph.adjacency) {
      for (const e of edges) {
        adjacencyNodeIds.push(nodeId);
        adjacencyKeys.push(e.id);
      }
    }

    const payload: CachedGraph = {
      timestamp: Date.now(),
      nodes: Array.from(graph.nodes.entries()),
      edges: Array.from(graph.edges.entries()) as CachedGraph['edges'],
      adjacencyKeys,
      adjacencyNodeIds,
      signals: Array.from(signals.entries()).map(([k, v]) => [k, {
        id: v.id, nodeId: v.nodeId, phases: v.phases,
        currentPhaseIndex: v.currentPhaseIndex, timer: v.timer,
        cycleLength: v.cycleLength, offset: v.offset,
        congestionLevel: v.congestionLevel, adaptiveTiming: v.adaptiveTiming,
        approaches: v.approaches ?? [],
        greenWaveDirection: v.greenWaveDirection ?? null,
      }]),
    };
    localStorage.setItem(cacheKey(lat, lng, radius), JSON.stringify(payload));
    console.log('[WayFinder] Graph cached to localStorage');
  } catch (e) {
    console.warn('[WayFinder] Cache write failed (storage full?)', e);
  }
}

export function loadGraphFromCache(lat: number, lng: number, radius: number): { graph: RoadGraph; signals: Map<string, TrafficSignal> } | null {
  try {
    const raw = localStorage.getItem(cacheKey(lat, lng, radius));
    if (!raw) return null;
    const data: CachedGraph = JSON.parse(raw);
    if (Date.now() - data.timestamp > TTL_MS) {
      localStorage.removeItem(cacheKey(lat, lng, radius));
      console.log('[WayFinder] Cache expired — will re-fetch');
      return null;
    }

    const nodes = new Map<string, RoadNode>(data.nodes);
    const edges = new Map<string, RoadEdge>(data.edges as Array<[string, RoadEdge]>);
    const adjacency = new Map<string, RoadEdge[]>();
    for (let i = 0; i < data.adjacencyNodeIds.length; i++) {
      const nodeId = data.adjacencyNodeIds[i];
      const edgeId = data.adjacencyKeys[i];
      const edge = edges.get(edgeId);
      if (!edge) continue;
      if (!adjacency.has(nodeId)) adjacency.set(nodeId, []);
      adjacency.get(nodeId)!.push(edge);
    }

    const signals = new Map<string, TrafficSignal>();
    for (const [k, v] of data.signals) {
      signals.set(k, {
        ...v,
        greenWaveDirection: (v as any).greenWaveDirection ?? null,
        approaches: v.approaches ?? [],
      });
    }

    console.log(`[WayFinder] Loaded graph from cache (${nodes.size} nodes, ${edges.size} edges)`);
    return { graph: { nodes, edges, adjacency }, signals };
  } catch (e) {
    console.warn('[WayFinder] Cache read failed', e);
    return null;
  }
}

export function clearGraphCache(lat: number, lng: number, radius: number): void {
  localStorage.removeItem(cacheKey(lat, lng, radius));
  console.log('[WayFinder] Graph cache cleared');
}
