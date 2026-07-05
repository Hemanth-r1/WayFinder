import type { RoadGraph, TrafficSignal } from './types.js';

interface GraphCache {
  graph: RoadGraph | null;
  signals: TrafficSignal[];
  source: string;
  version: number;
}

let cache: GraphCache = { graph: null, signals: [], source: 'none', version: 0 };
const CENTER = { lat: 12.9716, lng: 77.5946 };
const RADIUS = 40000;

export async function getGraph(): Promise<{
  graph: RoadGraph; signals: TrafficSignal[]; source: string; version: number;
}> {
  if (cache.graph && cache.graph.nodes.length > 0) {
    return { graph: cache.graph, signals: cache.signals, source: cache.source, version: cache.version };
  }
  const { buildBangaloreNetwork } = await import('./roadNetwork.js');
  const result = await buildBangaloreNetwork(CENTER.lat, CENTER.lng, RADIUS);
  cache = { ...result, version: Date.now() };
  return { graph: cache.graph!, signals: cache.signals, source: cache.source, version: cache.version };
}

export function invalidateCache(): void {
  cache = { graph: null, signals: [], source: 'none', version: 0 };
}
