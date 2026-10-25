import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
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
let clientGraph: { json: string; gzip: Buffer; version: string } | null = null;

/** The road network, loaded once (bundled snapshot → live Overpass → synthetic grid). */
export async function getGraph(): Promise<GraphState> {
  if (current) return current;
  loading ??= buildBangaloreNetwork(CENTER.lat, CENTER.lng).then(net => {
    current = { ...net, version: Date.now() };
    return current;
  }).catch(err => {
    loading = null; // let the next call try again
    throw err;
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
export async function getClientGraph(): Promise<{ json: string; gzip: Buffer; version: string }> {
  if (clientGraph) return clientGraph;
  const { graph, signals, source } = await getGraph();
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
    // Live phases come with every update; fixed values here keep the file identical across
    // restarts, so phones and the CDN keep their copy until the roads really change
    signals: signals.map(({ approaches: _a, ...s }) => {
      const n = nodeById.get(s.nodeId);
      return { ...s, currentPhaseIndex: 0, timer: 0, lat: n?.lat, lng: n?.lng };
    }),
    source,
  });
  const version = createHash('sha1').update(json).digest('hex').slice(0, 12);
  const withVersion = `${json.slice(0, -1)},"version":"${version}"}`;
  clientGraph = { json: withVersion, gzip: gzipSync(withVersion, { level: 6 }), version };
  console.log(`[WayFinder] Client graph: ${(json.length / 1e6).toFixed(1)} MB (${(clientGraph.gzip.length / 1e6).toFixed(1)} MB gzipped), version ${version}`);
  return clientGraph;
}
