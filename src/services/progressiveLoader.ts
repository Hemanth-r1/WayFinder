import { serverClient } from './serverClient.ts';
import { dataCache } from './dataCache.ts';
import type { RoadGraph, RoadEdge, RoadNode, TrafficSignal, RoadType, GeoPoint } from '../types';

/**
 * Graph as the server sends it (format 2): nodes as [id, lat, lng]; edges as
 * [id, from, to, name, roadType, speedLimit, lanes, length, bearing, geometry | null].
 * A null geometry is the reverse direction of a two-way road: reuse the other one reversed.
 */
interface RawGraphData {
  format: 2;
  nodes: [string, number, number][];
  edges: [string, string, string, string, string, number, number, number, number, [number, number][] | null][];
  signals: TrafficSignal[];
  source: string;
}

function hydrate(raw: RawGraphData): { graph: RoadGraph; signals: Map<string, TrafficSignal> } {
  const nodes = new Map<string, RoadNode>(
    raw.nodes.map(([id, lat, lng]) => [id, { id, lat, lng, isIntersection: true }]),
  );
  const shapes = new Map<string, GeoPoint[]>();
  for (const e of raw.edges) if (e[9]) shapes.set(e[0], e[9].map(([lat, lng]) => ({ lat, lng })));

  const edges = new Map<string, RoadEdge>();
  const adjacency = new Map<string, RoadEdge[]>();
  for (const [id, from, to, name, roadType, speedLimit, lanes, length, bearing] of raw.edges) {
    const reverseId = `${to}-${from}`;
    const geometry = shapes.get(id) ?? [...(shapes.get(reverseId) ?? [])].reverse();
    const edge: RoadEdge = {
      id, from, to, name, roadType: roadType as RoadType, speedLimit, lanes, length, bearing,
      geometry: geometry.length >= 2 ? geometry : [nodes.get(from)!, nodes.get(to)!],
      congestionWeight: 0,
      oneway: false,
    };
    edges.set(id, edge);
    (adjacency.get(from) ?? adjacency.set(from, []).get(from)!).push(edge);
  }
  for (const e of edges.values()) e.oneway = !edges.has(`${e.to}-${e.from}`);

  return {
    graph: { nodes, edges, adjacency },
    signals: new Map(raw.signals.map(s => [s.id, { ...s, approaches: s.approaches ?? [] }])),
  };
}

export type LoadPhase = 'empty' | 'map' | 'roads' | 'signals' | 'vehicles' | 'full';

export interface LoadUpdate {
  phase: LoadPhase;
  source: string;
  graph?: RoadGraph;
  signals?: Map<string, TrafficSignal>;
  vehicles?: Map<string, any>;
  stats?: any;
}

export class ProgressiveLoader {
  private updateCallbacks: Set<(update: LoadUpdate) => void> = new Set();
  private currentPhase: LoadPhase = 'empty';

  onUpdate(callback: (update: LoadUpdate) => void): void {
    this.updateCallbacks.add(callback);
  }

  removeUpdateCallback(callback: (update: LoadUpdate) => void): void {
    this.updateCallbacks.delete(callback);
  }

  private notify(update: LoadUpdate): void {
    this.currentPhase = update.phase;
    for (const callback of this.updateCallbacks) callback(update);
  }

  /**
   * Loads Bangalore's road network from the server (the browser's HTTP cache keeps it
   * for an hour; it's too big for localStorage).
   */
  async load(): Promise<void> {
    this.notify({ phase: 'map', source: 'tiles' });
    dataCache.remove('graph'); // drop graphs cached by older versions (could be the demo grid)

    try {
      const raw = await serverClient.fetchGraph() as RawGraphData;
      if (raw.format !== 2) throw new Error('Unexpected graph format — reload after the server updates');
      const { graph, signals } = hydrate(raw);
      this.notify({ phase: 'roads', source: raw.source, graph, signals });
      this.notify({ phase: 'signals', source: raw.source, signals });
      this.notify({ phase: 'full', source: raw.source });
    } catch (err) {
      console.error('[ProgressiveLoader] Failed to load from server:', err);
      this.notify({
        phase: 'full',
        source: 'error',
        graph: { nodes: new Map(), edges: new Map(), adjacency: new Map() },
        signals: new Map(),
      });
    }
  }

  getCurrentPhase(): LoadPhase {
    return this.currentPhase;
  }
}

export const progressiveLoader = new ProgressiveLoader();
