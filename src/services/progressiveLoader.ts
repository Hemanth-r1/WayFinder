import { serverClient } from './serverClient.ts';
import { dataCache } from './dataCache.ts';
import type { RoadGraph, TrafficSignal } from '../types';

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
      const cachedGraph = dataCache.get<RoadGraph>('graph');
      const cachedSignals = dataCache.get<TrafficSignal[]>('signals');
      
      if (cachedGraph && cachedSignals) {
        this.notify({
          phase: 'roads',
          source: 'cache',
          graph: cachedGraph,
          signals: new Map(cachedSignals.map(s => [s.id, s])),
        });
        
        this.notify({
          phase: 'signals',
          source: 'cache',
          signals: new Map(cachedSignals.map(s => [s.id, s])),
        });

        // Load vehicles from server
        await this.loadVehiclesFromServer();
        
        this.notify({
          phase: 'full',
          source: 'cache+server',
          graph: cachedGraph,
          signals: new Map(cachedSignals.map(s => [s.id, s])),
        });
        return;
      }
    }

    // Phase 3: Fetch from server
    try {
      const serverData = await serverClient.fetchGraph(forceRefresh);
      
      // Convert server format to client format
      const graph: RoadGraph = {
        nodes: new Map(serverData.graph.nodes.map((n: any) => [n.id, n])),
        edges: new Map(serverData.graph.edges.map((e: any) => [e.id, e])),
        adjacency: new Map(serverData.graph.adjacency.map((a: any) => [a[0], a[1]])),
      };
      
      const signals = new Map<string, TrafficSignal>(serverData.signals.map((s: any) => [s.id, s]));

      this.notify({
        phase: 'roads',
        source: 'server',
        graph,
        signals,
      });

      this.notify({
        phase: 'signals',
        source: 'server',
        signals,
      });

      // Cache the data
      dataCache.set('graph', graph);
      dataCache.set('signals', Array.from(signals.values()));

      // Load vehicles from server
      await this.loadVehiclesFromServer();

      this.notify({
        phase: 'full',
        source: 'server',
        graph,
        signals,
      });
    } catch (err) {
      console.error('[ProgressiveLoader] Failed to load from server:', err);
      // Fallback to synthetic grid could be implemented here
      this.notify({
        phase: 'full',
        source: 'error',
        graph: { nodes: new Map(), edges: new Map(), adjacency: new Map() },
        signals: new Map(),
      });
    }
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
