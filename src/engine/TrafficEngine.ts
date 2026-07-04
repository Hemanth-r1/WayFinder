import type {
  RoadGraph, TrafficSignal, Vehicle, CongestionZone, TrafficStats, Direction, SignalColor, VehicleType, OptimizationResult,
} from '../types';
import { loadBangaloreNetwork } from '../data/roadNetwork';
import { clearGraphCache } from '../data/graphCache';
import { updateAdaptiveSignals, coordinateGreenWave, getDominantFlowDirection } from './signalControl';
import { spawnRandomVehicle, spawnVehicleAt, updateVehicle } from './vehicleSim';
import { detectCongestionZones, computeStats } from './congestion';
import { SIMULATION_CONFIG, SIGNAL_CONFIG } from '../config';
import { createSimClock, tickClock, getCurrentProfile, type SimClock, type TimeOfDay, classifyHour } from './timeOfDay';
import { applyEmergencyPriority, type EmergencyOverride } from './emergencyPriority';
import { runOptimizer, applyOptimizationPlan } from './optimizer';

const OPTIMIZER_INTERVAL = 30; // seconds between optimizer runs
const CENTER = { lat: 12.9716, lng: 77.5946 };
const RADIUS = 40000;

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

  simClock: SimClock = createSimClock(8, 2);
  get timeOfDay(): TimeOfDay { return classifyHour(this.simClock.hour); }
  get currentProfile() { return getCurrentProfile(this.simClock); }

  emergencyOverrides: Map<string, EmergencyOverride> = new Map();

  lastOptimizationResult: OptimizationResult | null = null;
  private optimizerTimer = 0;

  private spawnTimer = 0;
  private maxVehicles: number = SIMULATION_CONFIG.MAX_VEHICLES;
  private manualOverrideActive = false;
  private manualOverrideTimer = 0;
  private manualOverrideDuration = 30;

  async init(forceRefresh = false): Promise<void> {
    this.loading = true;
    const result = await loadBangaloreNetwork(forceRefresh);
    const nodes = 'nodes' in result ? result.nodes : result.graph.nodes;
    const edges = 'edges' in result ? result.edges : result.graph.edges;
    const adjacency = 'adjacency' in result ? result.adjacency : result.graph.adjacency;
    const signals = result.signals;
    this.graph = { nodes, edges, adjacency };
    this.signals = signals;
    this.loading = false;
    this.loaded = true;
    console.log(`[WayFinder] Engine: ${nodes.size} nodes, ${edges.size} edges, ${signals.size} signals`);
  }

  start(): void {
    this.running = true;
    let spawned = 0;
    for (let i = 0; i < SIMULATION_CONFIG.INITIAL_VEHICLES; i++) {
      const v = spawnRandomVehicle(this.graph, this.signals);
      if (v) { this.vehicles.set(v.id, v); spawned++; }
    }
    console.log(`[WayFinder] Started: ${spawned} vehicles`);
  }

  stop(): void { this.running = false; }

  update(deltaTime: number): void {
    if (!this.running || !this.loaded) return;
    const dt = Math.min(deltaTime, SIMULATION_CONFIG.UPDATE_INTERVAL);

    // Advance simulation clock
    this.simClock = tickClock(this.simClock, dt);
    const profile = this.currentProfile;
    this.maxVehicles = Math.max(10, Math.min(SIMULATION_CONFIG.MAX_VEHICLES, Math.round(SIMULATION_CONFIG.MAX_VEHICLES * profile.volumeMultiplier)));

    this.spawnVehicles(dt);

    for (const [id, vehicle] of this.vehicles) {
      if (!updateVehicle(vehicle, dt, this.graph, this.signals, this.vehicles)) {
        this.vehicles.delete(id);
      }
    }

    // Manual override timer
    if (this.manualOverrideActive) {
      this.manualOverrideTimer += dt;
      if (this.manualOverrideTimer >= this.manualOverrideDuration) this.deactivateManualOverride();
    }

    // Emergency vehicle priority
    if (!this.manualOverrideActive) {
      this.emergencyOverrides = applyEmergencyPriority(
        this.vehicles, this.signals, this.graph.nodes, this.emergencyOverrides, dt,
      );
    }

    // Adaptive signals
    const dominant = getDominantFlowDirection(this.vehicles);
    if (!this.manualOverrideActive) {
      updateAdaptiveSignals(this.signals, this.vehicles, this.graph.nodes, dt);
      if (this.vehicles.size > SIGNAL_CONFIG.GREEN_WAVE_MIN_VEHICLES) {
        coordinateGreenWave(this.signals, this.graph.nodes, dominant);
      }
    }

    // Network optimizer (every 30 seconds, REQ-C1)
    this.optimizerTimer += dt;
    if (this.optimizerTimer >= OPTIMIZER_INTERVAL && !this.manualOverrideActive) {
      this.optimizerTimer = 0;
      // Run in idle time to avoid blocking (REQ-PERF3)
      const result = runOptimizer(this.signals, this.vehicles, this.graph.nodes, 150);
      this.lastOptimizationResult = result;
      // Auto-apply if improvement > 10% (REQ-C7)
      if (result.improvement > 0.10) {
        applyOptimizationPlan(result.plan, this.signals);
        console.log(`[WayFinder] Optimizer applied: ${(result.improvement * 100).toFixed(1)}% improvement, ${result.elapsedMs}ms`);
      }
    }

    this.congestionZones = detectCongestionZones(this.vehicles, this.graph.nodes);
    this.stats = computeStats(this.vehicles, this.congestionZones);

    const active = Array.from(this.signals.values()).filter(s => s.greenWaveDirection !== null).length;
    this.stats.greenWaveActive = active > this.signals.size * 0.3;
    this.stats.signalCoordinationScore = this.signals.size > 0
      ? Math.round((active / this.signals.size) * 100) : 0;
  }

  private spawnVehicles(deltaTime: number): void {
    if (this.vehicles.size >= this.maxVehicles) return;
    this.spawnTimer += deltaTime;
    const interval = Math.max(
      SIMULATION_CONFIG.SPAWN_INTERVAL.min,
      SIMULATION_CONFIG.SPAWN_INTERVAL.max - this.vehicles.size * 4,
    ) / 1000;
    if (this.spawnTimer < interval) return;
    this.spawnTimer = 0;
    const count = Math.min(SIMULATION_CONFIG.VEHICLE_SPAWN_COUNT, this.maxVehicles - this.vehicles.size);
    for (let i = 0; i < count; i++) {
      const v = spawnRandomVehicle(this.graph, this.signals);
      if (v) this.vehicles.set(v.id, v);
    }
  }

  /** Spawn a specific type at a given node (from context menu, REQ-M1) */
  spawnVehicleAtNode(nodeId: string, type: VehicleType): void {
    const v = spawnVehicleAt(this.graph, nodeId, type, this.signals);
    if (v) this.vehicles.set(v.id, v);
  }

  spawnVehicleFromDirection(_direction: Direction, type?: VehicleType): void {
    const vType = type || (['sedan', 'suv', 'hatchback', 'bike', 'auto'] as VehicleType[])[Math.floor(Math.random() * 5)];
    const v = spawnRandomVehicle(this.graph, this.signals);
    if (v) {
      (v as Vehicle & { type: VehicleType }).type = vType;
      this.vehicles.set(v.id, v);
    }
  }

  spawnEmergencyVehicle(): void {
    const v = spawnRandomVehicle(this.graph, this.signals);
    if (!v) return;
    // Override with emergency type
    const emergency = { ...v, type: 'emergency' as VehicleType, color: '#F44336' };
    this.vehicles.set(emergency.id, emergency);
  }

  /** Add a signal at a node (from Supporter panel / context menu) */
  addSignalAtNode(nodeId: string): boolean {
    if (this.signals.has(nodeId)) return false;
    const node = this.graph.nodes.get(nodeId); if (!node) return false;
    const id = `SIG-U${Date.now().toString(36).toUpperCase()}`;
    const adj = this.graph.adjacency.get(nodeId) ?? [];
    this.signals.set(nodeId, {
      id, nodeId, phases: [], currentPhaseIndex: 0, timer: 0,
      cycleLength: 30, offset: 0, greenWaveDirection: null,
      congestionLevel: 0, adaptiveTiming: true, approaches: [],
    });
    node.trafficSignalId = id;
    return true;
  }

  /** Force-run the optimizer immediately (Controller panel button) */
  runOptimizerNow(): OptimizationResult {
    const result = runOptimizer(this.signals, this.vehicles, this.graph.nodes, 150);
    this.lastOptimizationResult = result;
    if (result.improvement > 0) applyOptimizationPlan(result.plan, this.signals);
    return result;
  }

  /** Force-refresh road data from OSM */
  async refreshRoadData(): Promise<void> {
    clearGraphCache(CENTER.lat, CENTER.lng, RADIUS);
    this.vehicles.clear();
    await this.init(true);
    this.start();
  }

  manualOverrideSignal(signalId: string, direction: Direction, color: SignalColor): void {
    const signal = this.signals.get(signalId); if (!signal) return;
    this.manualOverrideActive = true;
    this.manualOverrideTimer = 0;
    signal.adaptiveTiming = false;

    for (const [, other] of this.signals) {
      other.adaptiveTiming = false;
      if (other.id === signalId) {
        for (const phase of other.phases) {
          if (phase.direction === direction) { phase.color = color; phase.duration = color === 'GREEN' ? 30 : 5; }
          else { phase.color = color === 'GREEN' ? 'RED' : 'GREEN'; phase.duration = color === 'GREEN' ? 5 : 25; }
        }
      } else {
        const otherNode = this.graph.nodes.get(other.nodeId);
        const overrideNode = this.graph.nodes.get(signal.nodeId);
        if (otherNode && overrideNode) {
          const isNS = Math.abs(otherNode.lat - overrideNode.lat) > Math.abs(otherNode.lng - overrideNode.lng);
          for (const phase of other.phases) {
            const dirNS = phase.direction === 'N' || phase.direction === 'S';
            if ((isNS && dirNS) || (!isNS && !dirNS)) {
              phase.color = color; phase.duration = color === 'GREEN' ? 25 : 5;
            } else {
              phase.color = color === 'GREEN' ? 'RED' : 'GREEN'; phase.duration = color === 'GREEN' ? 5 : 20;
            }
          }
        }
      }
    }
  }

  deactivateManualOverride(): void {
    this.manualOverrideActive = false; this.manualOverrideTimer = 0;
    for (const [, signal] of this.signals) {
      signal.adaptiveTiming = true; signal.currentPhaseIndex = 0; signal.timer = 0;
      for (const phase of signal.phases) phase.duration = 12;
    }
  }

  isManualOverrideActive(): boolean { return this.manualOverrideActive; }
  getManualOverrideTimeRemaining(): number { return Math.max(0, this.manualOverrideDuration - this.manualOverrideTimer); }
  hasEmergencyOverride(): boolean { return this.emergencyOverrides.size > 0; }
  getEmergencyOverrideCount(): number { return this.emergencyOverrides.size; }
}

// Re-export Vehicle type for TrafficEngine callers
export type { Vehicle };
