/**
 * graphCache.ts — localStorage + IndexedDB persistence for the road graph
 * Small graphs (<10k nodes) use localStorage for speed.
 * Large graphs use IndexedDB for nearly unlimited storage.
 * Key: wayfinder_graph_v2_{lat}_{lng}_{radius}
 * TTL: 7 days (IndexedDB), 24 hours (localStorage)
 */
import type { RoadNode, RoadEdge, TrafficSignal, SignalPhase, GeoPoint, RoadGraph, SignalApproach } from '../types';
import { saveToIndexedDB, loadFromIndexedDB, clearIndexedDB } from './indexedDBCache';

const CACHE_VERSION = 'v2';
const LS_TTL_MS = 24 * 60 * 60 * 1000;
const LARGE_GRAPH_THRESHOLD = 10000;

interface CachedGraph {
  timestamp: number;
  nodes: Array<[string, RoadNode]>;
  edges: Array<[string, { id: string; from: string; to: string; roadType: string; speedLimit: number; lanes: number; length: number; bearing: number; name?: string; congestionWeight: number; geometry: GeoPoint[]; oneway: boolean }]>;
  adjacencyKeys: string[];
  adjacencyNodeIds: string[];
  signals: Array<[string, { id: string; nodeId: string; phases: SignalPhase[]; currentPhaseIndex: number; timer: number; cycleLength: number; offset: number; congestionLevel: number; adaptiveTiming: boolean; approaches: SignalApproach[]; greenWaveDirection: string | null }]>;
}

function cacheKey(lat: number, lng: number, radius: number): string {
  return `wayfinder_graph_${CACHE_VERSION}_${lat.toFixed(4)}_${lng.toFixed(4)}_${radius}`;
}

function buildPayload(graph: RoadGraph, signals: Map<string, TrafficSignal>): CachedGraph {
  const adjacencyKeys: string[] = [];
  const adjacencyNodeIds: string[] = [];
  for (const [nodeId, edges] of graph.adjacency) {
    for (const e of edges) {
      adjacencyNodeIds.push(nodeId);
      adjacencyKeys.push(e.id);
    }
  }
  return {
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
}

function restoreGraph(data: CachedGraph): { graph: RoadGraph; signals: Map<string, TrafficSignal> } | null {
  try {
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
    return { graph: { nodes, edges, adjacency }, signals };
  } catch {
    return null;
  }
}

export async function saveGraphToCache(
  lat: number, lng: number, radius: number,
  graph: RoadGraph,
  signals: Map<string, TrafficSignal>,
): Promise<void> {
  const key = cacheKey(lat, lng, radius);
  const payload = buildPayload(graph, signals);

  if (graph.nodes.size >= LARGE_GRAPH_THRESHOLD) {
    try {
      await saveToIndexedDB(key, payload);
      console.log(`[WayFinder] Cached ${graph.nodes.size} nodes to IndexedDB`);
    } catch (e) {
      console.warn('[WayFinder] IndexedDB write failed:', e);
    }
  } else {
    try {
      localStorage.setItem(key, JSON.stringify(payload));
      console.log('[WayFinder] Cached to localStorage');
    } catch (e) {
      console.warn('[WayFinder] localStorage write failed:', e);
    }
  }
}

export async function loadGraphFromCache(lat: number, lng: number, radius: number): Promise<{ graph: RoadGraph; signals: Map<string, TrafficSignal> } | null> {
  const key = cacheKey(lat, lng, radius);

  try {
    const result = await loadFromIndexedDB<CachedGraph>(key);
    if (result) {
      if (Date.now() - result.timestamp > 7 * 24 * 60 * 60 * 1000) {
        clearIndexedDB(key);
      } else {
        const restored = restoreGraph(result.data);
        if (restored) {
          console.log(`[WayFinder] Loaded ${restored.graph.nodes.size} nodes from IndexedDB cache`);
          return restored;
        }
      }
    }
  } catch { /* IndexedDB unavailable or empty */ }

  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const data: CachedGraph = JSON.parse(raw);
      if (Date.now() - data.timestamp > LS_TTL_MS) {
        localStorage.removeItem(key);
      } else {
        const restored = restoreGraph(data);
        if (restored) {
          console.log(`[WayFinder] Loaded ${restored.graph.nodes.size} nodes from localStorage cache`);
          return restored;
        }
      }
    }
  } catch { /* localStorage unavailable */ }

  return null;
}

export async function clearGraphCache(lat: number, lng: number, radius: number): Promise<void> {
  const key = cacheKey(lat, lng, radius);
  localStorage.removeItem(key);
  try { await clearIndexedDB(key); } catch { /* ignore */ }
  console.log('[WayFinder] Graph cache cleared');
}
