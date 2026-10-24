import { gzipSync } from 'node:zlib';
import type { RoadGraph, TrafficSignal } from './types.js';
import { buildBangaloreNetwork } from './roadNetwork.js';

interface GraphState {
  graph: RoadGraph;
  signals: TrafficSignal[];
  source: string;
  version: number;
}

const CENTER = { lat: 12.9716, lng: 77.5946 };
let current: GraphState | null = null;
let loading: Promise<GraphState> | null = null;
let clientGraph: { json: string; gzip: Buffer } | null = null;

/** The road network, loaded once (bundled snapshot → live Overpass → synthetic grid). */
export async function getGraph(): Promise<GraphState> {
  if (current) return current;
  loading ??= buildBangaloreNetwork(CENTER.lat, CENTER.lng).then(net => {
    current = { ...net, version: Date.now() };
    return current;
  });
  return loading;
}

/**
 * Graph for browsers, serialised once. Two-way roads send their shape only on one
 * direction (`geometry: null` on the other — the client reverses it); adjacency is
 * rebuilt from the edges. Signals carry static timing; live phases come with updates.
 */
export async function getClientGraph(): Promise<{ json: string; gzip: Buffer }> {
  if (clientGraph) return clientGraph;
  const { graph, signals, source, version } = await getGraph();
  const sent = new Set<string>();
  const edges = graph.edges.map(e => {
    const reverseSent = sent.has(`${e.to}-${e.from}`);
    sent.add(e.id);
    return [e.id, e.from, e.to, e.name, e.roadType, e.speedLimit, e.lanes, Math.round(e.length), e.bearing,
      reverseSent ? null : e.geometry.map(p => [p.lat, p.lng])];
  });
  const json = JSON.stringify({
    format: 2,
    nodes: graph.nodes.map(n => [n.id, n.lat, n.lng]),
    edges,
    signals: signals.map(({ approaches: _a, ...s }) => s),
    source, version,
  });
  clientGraph = { json, gzip: gzipSync(json, { level: 6 }) };
  console.log(`[WayFinder] Client graph: ${(json.length / 1e6).toFixed(1)} MB (${(clientGraph.gzip.length / 1e6).toFixed(1)} MB gzipped)`);
  return clientGraph;
}
