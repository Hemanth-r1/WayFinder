import { serverClient } from './serverClient.ts';
import { dataCache } from './dataCache.ts';
import type { RoadGraph, RoadEdge, RoadNode, TrafficSignal } from '../types';

/** Graph as the server sends it: plain arrays, adjacency lists hold edge IDs. */
interface RawGraphData {
  graph: { nodes: RoadNode[]; edges: RoadEdge[]; adjacency: [string, string[]][] };
  signals: TrafficSignal[];
}

/** Builds the client RoadGraph; adjacency is resolved from edge IDs to edge objects. */
function hydrate(raw: RawGraphData): { graph: RoadGraph; signals: Map<string, TrafficSignal> } {
  const edges = new Map<string, RoadEdge>(
    raw.graph.edges.map(e => [e.id, { ...e, congestionWeight: e.congestionWeight ?? 0, oneway: e.oneway ?? false }]),
  );
  const adjacency = new Map<string, RoadEdge[]>(
    raw.graph.adjacency.map(([nodeId, ids]) => [
      nodeId,
      ids.map(id => edges.get(id)).filter((e): e is RoadEdge => e !== undefined),
    ]),
  );
  return {
    graph: { nodes: new Map(raw.graph.nodes.map(n => [n.id, n])), edges, adjacency },
    signals: new Map(raw.signals.map(s => [s.id, s])),
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
    for (const callback of this.updateCallbacks) {
      callback(update);
    }
  }

  async load(forceRefresh = false): Promise<void> {
    // Phase 1: Map base layer (instant - OSM tiles load automatically)
    this.notify({ phase: 'map', source: 'osm-tiles' });

    // Phase 2: Try cache first (storage-first)
    if (!forceRefresh) {
      const cached = dataCache.get<RawGraphData>('graph');
      if (cached?.graph?.nodes && cached.signals) {
        await this.publish(hydrate(cached), 'cache');
        return;
      }
    }

    // Phase 3: Fetch from server
    try {
      const serverData: RawGraphData = await serverClient.fetchGraph(forceRefresh);
      dataCache.set('graph', { graph: serverData.graph, signals: serverData.signals });
      await this.publish(hydrate(serverData), 'server');
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

  private async publish(data: { graph: RoadGraph; signals: Map<string, TrafficSignal> }, source: string): Promise<void> {
    const { graph, signals } = data;
    this.notify({ phase: 'roads', source, graph, signals });
    this.notify({ phase: 'signals', source, signals });
    await this.loadVehiclesFromServer();
    this.notify({ phase: 'full', source: source === 'cache' ? 'cache+server' : source });
  }

  private async loadVehiclesFromServer(): Promise<void> {
    try {
      const { vehicles } = await serverClient.fetchVehicles();
      const vehicleMap = new Map(vehicles.map((v: any) => [v.id, v]));
      
      this.notify({
        phase: 'vehicles',
        source: 'server',
        vehicles: vehicleMap,
      });
    } catch (err) {
      console.error('[ProgressiveLoader] Failed to load vehicles:', err);
    }
  }

  getCurrentPhase(): LoadPhase {
    return this.currentPhase;
  }
}

export const progressiveLoader = new ProgressiveLoader();
