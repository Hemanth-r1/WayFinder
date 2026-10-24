/**
 * Loads Bangalore's road network: the bundled OSM snapshot, else live Overpass, else a
 * small synthetic grid (last resort, so the app still starts with no data at all).
 */
import type { RoadNode, RoadEdge, TrafficSignal, RoadGraph } from './types.js';
import { buildGraphFromOsm, buildSignals, haversineMetres, bearing } from './osmGraph.js';
import { readSnapshot, fetchBangaloreFromOverpass } from './osmSource.js';

export interface Network {
  graph: RoadGraph;
  signals: TrafficSignal[];
  source: string;
}

// ── Synthetic grid fallback ──────────────────────────────────────────────────

function buildSyntheticGrid(centerLat: number, centerLng: number): Network {
  const nodes = new Map<string, RoadNode>();
  const edges = new Map<string, RoadEdge>();
  const rows = 8, cols = 8;
  const avenues = ['MG Road', 'Brigade Rd', 'Residency Rd', 'Commercial St', 'Church St', 'Kasturba Rd', 'Infantry Rd', 'St Marks Rd'];
  const streets = ['Vittal Mallya Rd', 'Rest House Rd', 'High Ground', 'Agram Rd', 'Waltaire Rd', 'Richmond Rd', 'Lavelle Rd', 'Cunningham Rd'];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = `${c},${r}`;
      nodes.set(id, { id, lat: centerLat + (r - rows / 2) * 0.0014, lng: centerLng + (c - cols / 2) * 0.0018 });
    }
  }
  const addEdge = (from: string, to: string, roadType: string, speed: number, name: string) => {
    const f = nodes.get(from)!, t = nodes.get(to)!;
    const length = haversineMetres(f, t);
    const b = Math.round(bearing(f, t));
    edges.set(`${from}-${to}`, { id: `${from}-${to}`, from, to, roadType, speedLimit: speed, lanes: 2, length, bearing: b, name, geometry: [f, t] });
    edges.set(`${to}-${from}`, { id: `${to}-${from}`, from: to, to: from, roadType, speedLimit: speed, lanes: 2, length, bearing: (b + 180) % 360, name, geometry: [t, f] });
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c < cols - 1) addEdge(`${c},${r}`, `${c + 1},${r}`, r % 2 ? 'primary' : 'tertiary', r % 2 ? 40 : 30, avenues[r % avenues.length]);
      if (r < rows - 1) addEdge(`${c},${r}`, `${c},${r + 1}`, c % 2 ? 'secondary' : 'tertiary', c % 2 ? 35 : 30, streets[c % streets.length]);
    }
  }

  const out = new Map<string, string[]>();
  const inEdges = new Map<string, RoadEdge[]>();
  for (const e of edges.values()) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.id);
    (inEdges.get(e.to) ?? inEdges.set(e.to, []).get(e.to)!).push(e);
  }
  const junctions = [...nodes.keys()].filter(id => (inEdges.get(id)?.length ?? 0) >= 3).map(id => [id]);
  const signals = buildSignals(junctions, nodes, inEdges);
  console.log(`[WayFinder] Synthetic grid: ${nodes.size} nodes, ${edges.size} edges, ${signals.length} signals`);
  return {
    graph: { nodes: [...nodes.values()], edges: [...edges.values()], adjacency: [...out] },
    signals,
    source: 'synthetic grid',
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function buildBangaloreNetwork(centerLat: number, centerLng: number): Promise<Network> {
  try {
    const osm = await readSnapshot();
    if (osm) {
      const t0 = Date.now();
      const net = buildGraphFromOsm(osm);
      console.log(`[WayFinder] Bangalore snapshot: ${net.graph.nodes.length} nodes, ${net.graph.edges.length} edges, ` +
        `${net.signals.length} signals (${Date.now() - t0} ms)`);
      return { ...net, source: osm.source };
    }
    console.warn('[WayFinder] No bundled road snapshot — run `npm run build:osm` in server/');
  } catch (err) {
    console.warn('[WayFinder] Road snapshot unreadable:', (err as Error).message);
  }

  try {
    const osm = await fetchBangaloreFromOverpass();
    const net = buildGraphFromOsm(osm);
    if (net.graph.edges.length > 100) return { ...net, source: osm.source };
  } catch (err) {
    console.warn('[WayFinder] Overpass unavailable:', (err as Error).message);
  }

  console.warn('[WayFinder] Using synthetic grid — the map will not match real roads');
  return buildSyntheticGrid(centerLat, centerLng);
}
