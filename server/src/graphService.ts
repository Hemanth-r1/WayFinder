import type { RoadGraph, TrafficSignal } from './types.js';
import { loadGraphFromCache, saveGraphToCache } from './graphCache.js';

interface GraphCache {
  graph: RoadGraph | null;
  signals: TrafficSignal[];
  source: string;
  version: number;
}

let cache: GraphCache = { graph: null, signals: [], source: 'none', version: 0 };
const CENTER = { lat: 12.9716, lng: 77.5946 };
const RADIUS = 40000;

export async function getGraph(forceRefresh = false): Promise<{
  graph: RoadGraph; signals: TrafficSignal[]; source: string; version: number;
}> {
  // Try cache first (storage-first)
  if (!forceRefresh && cache.graph && cache.graph.nodes.length > 0) {
    return { graph: cache.graph, signals: cache.signals, source: cache.source, version: cache.version };
  }

  // Try loading from persistent cache
  if (!forceRefresh) {
    const cached = await loadGraphFromCache();
    if (cached && cached.graph.nodes.length > 0) {
      cache = {
        graph: cached.graph,
        signals: cached.signals,
        source: 'storage',
        version: cached.version,
      };
      return { graph: cache.graph!, signals: cache.signals, source: cache.source, version: cache.version };
    }
  }

  // Build from OSM
  const { buildBangaloreNetwork } = await import('./roadNetwork.js');
  const result = await buildBangaloreNetwork(CENTER.lat, CENTER.lng, RADIUS);
  cache = { ...result, version: Date.now() };

  // Save to persistent cache
  if (cache.graph) {
    await saveGraphToCache(cache.graph, cache.signals);
  }

  return { graph: cache.graph!, signals: cache.signals, source: cache.source, version: cache.version };
}

export function invalidateCache(): void {
  cache = { graph: null, signals: [], source: 'none', version: 0 };
}
