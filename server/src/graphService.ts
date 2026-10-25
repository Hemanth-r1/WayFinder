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

// ── Road tiles: browsers load only what's in view ────────────────────────────

/** Cell size of the road tiles (degrees, ~2 km). The client uses the same grid. */
export const ROAD_CELL_DEG = 0.02;
/** Drawn city-wide when zoomed out (simplified); every other road comes in cells. */
const MAIN_TYPES = new Set(['motorway', 'trunk', 'primary']);
/** Shape simplification for the zoomed-out main roads (m). */
const MAIN_SIMPLIFY_M = 15;

export interface Piece { json: string; gzip: Buffer }
interface RoadTiles { version: string; meta: Piece; signals: Piece; main: Piece; cells: Map<string, Piece> }
let tiles: RoadTiles | null = null;

function piece(obj: unknown): Piece {
  const json = JSON.stringify(obj);
  return { json, gzip: gzipSync(json, { level: 6 }) };
}

/** ~1 m precision is plenty for drawing and snapping, and keeps the files small. */
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

/** Douglas–Peucker: drop shape points closer than `tol` metres to the simplified line. */
function simplify(points: { lat: number; lng: number }[], tol: number): { lat: number; lng: number }[] {
  if (points.length <= 2) return points;
  const kx = 111320 * Math.cos(points[0].lat * Math.PI / 180), ky = 111320;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = points[a].lng * kx, ay = points[a].lat * ky, bx = points[b].lng * kx, by = points[b].lat * ky;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    let worst = -1, worstD = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((points[i].lng * kx - ax) * dy - (points[i].lat * ky - ay) * dx) / len;
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst > 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * The client road network split for loading on demand: ~2 km cells (by the road's start
 * junction), simplified main roads for the zoomed-out city view, and the signals. Same
 * format as /api/graph, plus a one-way flag (the reverse road may sit in a cell not loaded).
 * URLs carry the content version, so browsers and the CDN can keep them for good.
 */
export async function getRoadTiles(): Promise<RoadTiles> {
  if (tiles) return tiles;
  const { version } = await getClientGraph();
  const { graph, signals, source } = await getGraph();
  const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
  const kept = graph.edges.filter(e => !SERVER_ONLY_TYPES.has(e.roadType));
  const ids = new Set(kept.map(e => e.id));

  const encode = (edges: typeof kept, tol = 0) => {
    const used = new Set<string>(), sent = new Set<string>();
    const out = edges.map(e => {
      used.add(e.from); used.add(e.to);
      const reverseSent = sent.has(`${e.to}-${e.from}`);
      sent.add(e.id);
      const shape = tol ? simplify(e.geometry, tol) : e.geometry;
      return [e.id, e.from, e.to, e.name, e.roadType, e.speedLimit, e.lanes, Math.round(e.length), e.bearing,
        reverseSent ? null : shape.map(p => [r5(p.lat), r5(p.lng)]), ids.has(`${e.to}-${e.from}`) ? 0 : 1];
    });
    return { format: 2, nodes: [...used].map(id => { const n = nodeById.get(id)!; return [id, r5(n.lat), r5(n.lng)]; }), edges: out };
  };

  const byCell = new Map<string, typeof kept>();
  for (const e of kept) {
    const n = nodeById.get(e.from)!;
    const key = `${Math.floor(n.lng / ROAD_CELL_DEG)}_${Math.floor(n.lat / ROAD_CELL_DEG)}`;
    (byCell.get(key) ?? byCell.set(key, []).get(key)!).push(e);
  }
  const cells = new Map<string, Piece>();
  for (const [key, edges] of byCell) cells.set(key, piece(encode(edges)));

  tiles = {
    version,
    meta: piece({ version, source, cellDeg: ROAD_CELL_DEG }),
    signals: piece(signals.map(({ approaches: _a, ...s }) => {
      const n = nodeById.get(s.nodeId);
      return { ...s, currentPhaseIndex: 0, timer: 0, lat: n?.lat, lng: n?.lng };
    })),
    main: piece(encode(kept.filter(e => MAIN_TYPES.has(e.roadType)), MAIN_SIMPLIFY_M)),
    cells,
  };
  const total = [...cells.values()].reduce((t, p) => t + p.gzip.length, 0);
  console.log(`[WayFinder] Road tiles: ${cells.size} cells (${(total / 1e6).toFixed(1)} MB gzipped in all), main roads ${(tiles.main.gzip.length / 1e3).toFixed(0)} KB, signals ${(tiles.signals.gzip.length / 1e3).toFixed(0)} KB gzipped`);
  return tiles;
}
