import type {
  RoadGraph, TrafficSignal, Vehicle, CongestionZone, TrafficStats, Direction, SignalColor, VehicleType, OptimizationResult,
} from '../types';
import { loadBangaloreNetwork, type LoadingPhase } from '../data/roadNetwork';
import { clearGraphCache } from '../data/graphCache';
import { updateAdaptiveSignals, coordinateGreenWave, getDominantFlowDirection } from './signalControl';
import { spawnRandomVehicle, spawnVehicleAt, updateVehicle } from './vehicleSim';
import { detectCongestionZones, computeStats } from './congestion';
import { SIMULATION_CONFIG, SIGNAL_CONFIG } from '../config';
import { createSimClock, tickClock, getCurrentProfile, type SimClock, type TimeOfDay, classifyHour } from './timeOfDay';
import { applyEmergencyPriority, type EmergencyOverride } from './emergencyPriority';
import { runOptimizer, applyOptimizationPlan } from './optimizer';

const OPTIMIZER_INTERVAL = 30;
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
  loadingPhase: string = 'empty';
  dataVersion: number = 0;
  onGraphUpdate?: (phase: LoadingPhase) => void;

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
    this.loadingPhase = 'loading';

    const result = await loadBangaloreNetwork((phase) => {
      this.graph = { nodes: phase.nodes, edges: phase.edges, adjacency: phase.adjacency };
      this.signals = phase.signals;
      this.loadingPhase = phase.phase;
      this.dataVersion = Date.now();
      this.onGraphUpdate?.(phase);
    }, forceRefresh);

    this.graph = { nodes: result.nodes, edges: result.edges, adjacency: result.adjacency };
    this.signals = result.signals;
    this.loadingPhase = result.phase;
    this.loading = false;
    this.loaded = true;
    this.dataVersion = Date.now();
    console.log(`[WayFinder] Engine update [${result.phase}]: ${result.nodes.size}n, ${result.edges.size}e, ${result.signals.size}s from ${result.source}`);
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

    this.simClock = tickClock(this.simClock, dt);
    const profile = this.currentProfile;
    this.maxVehicles = Math.max(10, Math.min(SIMULATION_CONFIG.MAX_VEHICLES, Math.round(SIMULATION_CONFIG.MAX_VEHICLES * profile.volumeMultiplier)));

    this.spawnVehicles(dt);

    for (const [id, vehicle] of this.vehicles) {
      if (!updateVehicle(vehicle, dt, this.graph, this.signals, this.vehicles)) {
        this.vehicles.delete(id);
      }
    }

    if (this.manualOverrideActive) {
      this.manualOverrideTimer += dt;
      if (this.manualOverrideTimer >= this.manualOverrideDuration) this.deactivateManualOverride();
    }

    if (!this.manualOverrideActive) {
      this.emergencyOverrides = applyEmergencyPriority(
        this.vehicles, this.signals, this.graph.nodes, this.emergencyOverrides, dt,
      );
    }

    const dominant = getDominantFlowDirection(this.vehicles);
    if (!this.manualOverrideActive) {
      updateAdaptiveSignals(this.signals, this.vehicles, this.graph.nodes, dt);
      if (this.vehicles.size > SIGNAL_CONFIG.GREEN_WAVE_MIN_VEHICLES) {
        coordinateGreenWave(this.signals, this.graph.nodes, dominant);
      }
    }

    this.optimizerTimer += dt;
    if (this.optimizerTimer >= OPTIMIZER_INTERVAL && !this.manualOverrideActive) {
      this.optimizerTimer = 0;
      const result = runOptimizer(this.signals, this.vehicles, this.graph.nodes, 150);
      this.lastOptimizationResult = result;
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

  spawnVehicleAtNode(nodeId: string, type: VehicleType): void {
    const v = spawnVehicleAt(this.graph, nodeId, type, this.signals);
    if (v) this.vehicles.set(v.id, v);
  }

  spawnVehicleFromDirection(direction: Direction, type?: VehicleType): void {
    const edgeNodes = Array.from(this.graph.nodes.entries()).filter(([id, _node]) => {
      const adj = this.graph.adjacency.get(id) || [];
      return adj.some(e => {
        const bearing = e.bearing;
        if (direction === 'N') return bearing > 315 || bearing <= 45;
        if (direction === 'S') return bearing > 135 && bearing <= 225;
        if (direction === 'E') return bearing > 45 && bearing <= 135;
        if (direction === 'W') return bearing > 225 && bearing <= 315;
        return false;
      });
    });
    if (edgeNodes.length === 0) return;
    const startId = edgeNodes[Math.floor(Math.random() * edgeNodes.length)][0];
    const vType = type || (['sedan', 'sedan', 'suv', 'hatchback', 'bike', 'auto'] as VehicleType[])[Math.floor(Math.random() * 6)];
    const v = spawnVehicleAt(this.graph, startId, vType, this.signals);
    if (v) this.vehicles.set(v.id, v);
  }

  spawnEmergencyVehicle(): void {
    const v = spawnRandomVehicle(this.graph, this.signals);
    if (!v) return;
    const emergency = { ...v, type: 'emergency' as VehicleType, color: '#F44336' };
    this.vehicles.set(emergency.id, emergency);
  }

  addSignalAtNode(nodeId: string): boolean {
    if (this.signals.has(nodeId)) return false;
    const node = this.graph.nodes.get(nodeId); if (!node) return false;
    const id = `SIG-U${Date.now().toString(36).toUpperCase()}`;
    this.signals.set(nodeId, {
      id, nodeId, phases: [], currentPhaseIndex: 0, timer: 0,
      cycleLength: 30, offset: 0, greenWaveDirection: null,
      congestionLevel: 0, adaptiveTiming: true, approaches: [],
    });
    node.trafficSignalId = id;
    return true;
  }

  runOptimizerNow(): OptimizationResult {
    const result = runOptimizer(this.signals, this.vehicles, this.graph.nodes, 150);
    this.lastOptimizationResult = result;
    if (result.improvement > 0) applyOptimizationPlan(result.plan, this.signals);
    return result;
  }

  async refreshRoadData(): Promise<void> {
    await clearGraphCache(CENTER.lat, CENTER.lng, RADIUS);
    this.vehicles.clear();
    await this.init(true);
    this.start();
  }

  manualOverrideSignal(signalId: string, direction: Direction, color: SignalColor): void {
    const signal = this.signals.get(signalId);
    if (!signal) return;
    this.manualOverrideActive = true;
    this.manualOverrideTimer = 0;
    signal.adaptiveTiming = false;

    for (const phase of signal.phases) {
      if (phase.direction === direction) {
        phase.color = color;
        phase.duration = color === 'GREEN' ? 30 : 5;
      } else {
        phase.color = color === 'GREEN' ? 'RED' : 'GREEN';
        phase.duration = color === 'GREEN' ? 5 : 25;
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

export type { Vehicle };
