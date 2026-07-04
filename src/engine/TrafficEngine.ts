import type { RoadGraph, TrafficSignal, Vehicle, CongestionZone, TrafficStats, Direction, SignalColor, VehicleType } from '../types';
import { loadBangaloreNetwork, findNearestNode } from '../data/roadNetwork';
import { updateAdaptiveSignals, coordinateGreenWave, getDominantFlowDirection } from './signalControl';
import { spawnRandomVehicle, spawnVehicleAt, updateVehicle } from './vehicleSim';
import { detectCongestionZones, computeStats } from './congestion';

export class TrafficEngine {
  graph: RoadGraph = { nodes: new Map(), edges: new Map(), adjacency: new Map() };
  signals: Map<string, TrafficSignal> = new Map();
  vehicles: Map<string, Vehicle> = new Map();
  congestionZones: CongestionZone[] = [];
  stats: TrafficStats = {
    totalVehicles: 0, avgSpeed: 0, avgDelay: 0, congestionHotspots: 0,
    greenWaveActive: false, signalCoordinationScore: 0, throughput: 0, maxCongestion: 0,
  };
  running = false;
  loading = false;
  loaded = false;
  private spawnTimer = 0;
  private maxVehicles = 120;
  private manualOverrideActive = false;
  private manualOverrideTimer = 0;
  private manualOverrideDuration = 30;

  async init(): Promise<void> {
    this.loading = true;
    const { nodes, edges, adjacency, signals } = await loadBangaloreNetwork();
    this.graph = { nodes, edges, adjacency };
    this.signals = signals;
    this.loading = false;
    this.loaded = true;
    console.log(`WayFinder: ${nodes.size} nodes, ${edges.size} edges, ${signals.size} signals loaded`);
  }

  start(): void {
    this.running = true;
    for (let i = 0; i < 20; i++) {
      const v = spawnRandomVehicle(this.graph, this.signals);
      if (v) this.vehicles.set(v.id, v);
    }
  }

  stop(): void { this.running = false; }

  update(deltaTime: number): void {
    if (!this.running || !this.loaded) return;

    this.spawnVehicles(deltaTime);

    for (const [id, vehicle] of this.vehicles) {
      if (!updateVehicle(vehicle, deltaTime, this.graph, this.signals, this.vehicles)) {
        this.vehicles.delete(id);
      }
    }

    if (this.manualOverrideActive) {
      this.manualOverrideTimer += deltaTime;
      if (this.manualOverrideTimer >= this.manualOverrideDuration) {
        this.deactivateManualOverride();
      }
    }

    const dominant = getDominantFlowDirection(this.vehicles);
    if (!this.manualOverrideActive) {
      updateAdaptiveSignals(this.signals, this.vehicles, this.graph.nodes, deltaTime);
      if (this.vehicles.size > 20) {
        coordinateGreenWave(this.signals, this.graph.nodes, dominant);
      }
    }

    this.congestionZones = detectCongestionZones(this.vehicles, this.graph.nodes);
    this.stats = computeStats(this.vehicles, this.congestionZones);

    const activeCount = Array.from(this.signals.values()).filter(s => s.greenWaveDirection !== null).length;
    this.stats.greenWaveActive = activeCount > this.signals.size * 0.3;
    this.stats.signalCoordinationScore = this.signals.size > 0
      ? Math.round((activeCount / this.signals.size) * 100) : 0;
  }

  private spawnVehicles(deltaTime: number): void {
    if (this.vehicles.size >= this.maxVehicles) return;
    this.spawnTimer += deltaTime;
    const interval = Math.max(200, 800 - this.vehicles.size * 4) / 1000;
    if (this.spawnTimer < interval) return;
    this.spawnTimer = 0;
    const count = Math.min(3, this.maxVehicles - this.vehicles.size);
    for (let i = 0; i < count; i++) {
      const v = spawnRandomVehicle(this.graph, this.signals);
      if (v) this.vehicles.set(v.id, v);
    }
  }

  spawnVehicleFromDirection(_direction: Direction, type?: VehicleType): void {
    const nodeIds = Array.from(this.graph.nodes.keys());
    const edgeNodes = nodeIds.filter(id => {
      const adj = this.graph.adjacency.get(id) || [];
      return adj.length > 0 && adj.length < 5;
    });
    if (edgeNodes.length === 0) return;
    const startId = edgeNodes[Math.floor(Math.random() * edgeNodes.length)];
    const vType = type || (['sedan', 'sedan', 'suv', 'hatchback', 'bike', 'auto'] as VehicleType[])[Math.floor(Math.random() * 6)];
    const v = spawnVehicleAt(this.graph, startId, vType);
    if (v) this.vehicles.set(v.id, v);
  }

  manualOverrideSignal(signalId: string, direction: Direction, color: SignalColor): void {
    const signal = this.signals.get(signalId);
    if (!signal) return;
    this.manualOverrideActive = true;
    this.manualOverrideTimer = 0;
    signal.adaptiveTiming = false;

    for (const [, other] of this.signals) {
      other.adaptiveTiming = false;
      if (other.id === signalId) {
        for (const phase of other.phases) {
          if (phase.direction === direction) {
            phase.color = color;
            phase.duration = color === 'GREEN' ? 30 : 5;
          } else {
            phase.color = color === 'GREEN' ? 'RED' : 'GREEN';
            phase.duration = color === 'GREEN' ? 5 : 25;
          }
        }
      } else {
        const otherNode = this.graph.nodes.get(other.nodeId);
        const overrideNode = this.graph.nodes.get(signal.nodeId);
        if (otherNode && overrideNode) {
          const isNS = Math.abs(otherNode.lat - overrideNode.lat) > Math.abs(otherNode.lng - overrideNode.lng);
          for (const phase of other.phases) {
            const dirNS = phase.direction === 'N' || phase.direction === 'S';
            if ((isNS && dirNS) || (!isNS && !dirNS)) {
              phase.color = color;
              phase.duration = color === 'GREEN' ? 25 : 5;
            } else {
              phase.color = color === 'GREEN' ? 'RED' : 'GREEN';
              phase.duration = color === 'GREEN' ? 5 : 20;
            }
          }
        }
      }
    }
  }

  deactivateManualOverride(): void {
    this.manualOverrideActive = false;
    this.manualOverrideTimer = 0;
    for (const [, signal] of this.signals) {
      signal.adaptiveTiming = true;
      signal.currentPhaseIndex = 0;
      signal.timer = 0;
      for (const phase of signal.phases) { phase.duration = 12; }
    }
  }

  isManualOverrideActive(): boolean { return this.manualOverrideActive; }
  getManualOverrideTimeRemaining(): number { return Math.max(0, this.manualOverrideDuration - this.manualOverrideTimer); }

  findNearestNode(lat: number, lng: number) {
    return findNearestNode(this.graph.nodes, lat, lng);
  }
}
