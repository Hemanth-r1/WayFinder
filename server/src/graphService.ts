import { gzipSync } from 'node:zlib';
import type { RoadGraph, TrafficSignal, Place } from './types.js';
import { buildBangaloreNetwork } from './roadNetwork.js';

interface GraphState {
  graph: RoadGraph;
  signals: TrafficSignal[];
  places: Place[];
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

/** Residential lanes stay on the server (routing, simulation); the base map draws them. */
const SERVER_ONLY_TYPES = new Set(['residential', 'living_street']);

/**
 * Graph for browsers, serialised once: every road except residential lanes (those would
 * make it ~14 MB). Two-way roads send their shape only on one direction (`geometry:
 * null` on the other — the client reverses it); adjacency is rebuilt from the edges.
 * Signals carry static timing and their position; live phases come with updates.
 */
export async function getClientGraph(): Promise<{ json: string; gzip: Buffer }> {
  if (clientGraph) return clientGraph;
  const { graph, signals, source, version } = await getGraph();
  const sent = new Set<string>();
  const kept = graph.edges.filter(e => !SERVER_ONLY_TYPES.has(e.roadType));
  const used = new Set<string>();
  for (const e of kept) { used.add(e.from); used.add(e.to); }
  const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
  const edges = kept.map(e => {
    const reverseSent = sent.has(`${e.to}-${e.from}`);
    sent.add(e.id);
    return [e.id, e.from, e.to, e.name, e.roadType, e.speedLimit, e.lanes, Math.round(e.length), e.bearing,
      reverseSent ? null : e.geometry.map(p => [p.lat, p.lng])];
  });
  const json = JSON.stringify({
    format: 2,
    nodes: graph.nodes.filter(n => used.has(n.id)).map(n => [n.id, n.lat, n.lng]),
    edges,
    signals: signals.map(({ approaches: _a, ...s }) => {
      const n = nodeById.get(s.nodeId);
      return { ...s, lat: n?.lat, lng: n?.lng };
    }),
    source, version,
  });
  clientGraph = { json, gzip: gzipSync(json, { level: 6 }) };
  console.log(`[WayFinder] Client graph: ${(json.length / 1e6).toFixed(1)} MB (${(clientGraph.gzip.length / 1e6).toFixed(1)} MB gzipped)`);
  return clientGraph;
}
