import type {
  RoadGraph, TrafficSignal, Vehicle, CongestionZone, TrafficStats, Direction, SignalColor, VehicleType, SLAStats, CorridorInfo,
} from '../types';
import { loadBangaloreNetwork, type LoadUpdate, type LoadPhase } from '../data/roadNetwork';
import { clearGraphCache } from '../data/graphCache';
import { computeSLAStats } from './slaMonitor';
import { detectCorridors } from './corridorDetector';
import { spawnRandomVehicle, spawnVehicleAt, spawnNavigatedVehicle, updateVehicle } from './vehicleSim';
import { aStarRoute } from './pathfinding';
import type { RouteInfo } from '../types';
import { detectCongestionZones, computeStats } from './congestion';
import { SIMULATION_CONFIG, SIGNAL_CONFIG } from '../config';
import { SIGNAL_TIMING } from '../types';
import { createSimClock, tickClock, getCurrentProfile, type SimClock, type TimeOfDay, classifyHour } from './timeOfDay';
import { ControllerManager } from './controller/ControllerManager';
import type { OverrideRequest } from './controller/types';

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
    slaSpeed: 0, slaCompliant: false, emergencySlaSpeed: 0, activeCorridors: 0,
  };

  running = false;
  loading = false;
  loaded = false;
  loadingPhase: LoadPhase = 'empty';
  dataVersion = 0;

  onGraphUpdate?: (phase: LoadPhase) => void;

  simClock: SimClock = createSimClock(8, 2);
  get timeOfDay(): TimeOfDay { return classifyHour(this.simClock.hour); }
  get currentProfile() { return getCurrentProfile(this.simClock); }
  get simSeconds(): number {
    return this.simClock.elapsed * this.simClock.simMinutesPerRealSecond * 60;
  }

  controllerManager = new ControllerManager();

  private spawnTimer = 0;
  private maxVehicles: number = SIMULATION_CONFIG.MAX_VEHICLES;
  private slaStats: SLAStats = {
    fleetAvgSpeedKmh: 0, slaCompliant: false, vehicleCount: 0,
    emergencyAvgSpeedKmh: 0, emergencyCompliant: false,
  };
  private corridors: CorridorInfo[] = [];
  private corridorTimer = 0;

  async init(forceRefresh = false): Promise<void> {
    this.loading = true;
    this.dataVersion++;

    await loadBangaloreNetwork((update: LoadUpdate) => {
      if (update.phase === 'fetching') {
        this.loadingPhase = 'fetching';
        this.onGraphUpdate?.(this.loadingPhase);
        return;
      }
      this.graph = { nodes: update.nodes, edges: update.edges, adjacency: update.adjacency };
      this.signals = update.signals;
      this.loadingPhase = update.phase;
      this.dataVersion++;
      this.loading = false;
      this.loaded = true;
      this.onGraphUpdate?.(this.loadingPhase);
      console.log(`[WayFinder] Engine update [${update.phase}]: ${update.nodes.size}n, ${update.edges.size}e, ${update.signals.size}s from ${update.source}`);
    }, forceRefresh);

    this.loading = false;
    this.loaded = true;
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

    this.controllerManager.solve(
      this.signals, this.vehicles, this.graph, dt, this.simSeconds, profile,
    );

    this.slaStats = computeSLAStats(this.vehicles);
    this.stats.slaSpeed = this.slaStats.fleetAvgSpeedKmh;
    this.stats.slaCompliant = this.slaStats.slaCompliant;
    this.stats.emergencySlaSpeed = this.slaStats.emergencyAvgSpeedKmh;

    this.corridorTimer += dt;
    if (this.corridorTimer >= SIGNAL_CONFIG.CORRIDOR.DETECT_INTERVAL) {
      this.corridorTimer = 0;
      this.corridors = detectCorridors(this.vehicles, this.graph, this.signals);
    }
    this.stats.activeCorridors = this.corridors.length;

    this.congestionZones = detectCongestionZones(this.vehicles, this.graph.nodes);
    this.stats = computeStats(this.vehicles, this.congestionZones);
    this.stats.slaSpeed = this.slaStats.fleetAvgSpeedKmh;
    this.stats.slaCompliant = this.slaStats.slaCompliant;
    this.stats.emergencySlaSpeed = this.slaStats.emergencyAvgSpeedKmh;
    this.stats.activeCorridors = this.corridors.length;

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

  spawnNavigatedVehicle(sourceId: string, destId: string): Vehicle | null {
    const v = spawnNavigatedVehicle(this.graph, sourceId, destId, this.signals);
    if (v) { this.vehicles.set(v.id, v); }
    return v ?? null;
  }

  computeRoute(sourceId: string, destId: string): RouteInfo | null {
    return aStarRoute(this.graph, sourceId, destId, this.signals);
  }

  addSignalAtNode(nodeId: string): boolean {
    if (this.signals.has(nodeId)) return false;
    const node = this.graph.nodes.get(nodeId); if (!node) return false;
    const id = `SIG-U${Date.now().toString(36).toUpperCase()}`;
    const yellowS = SIGNAL_TIMING.yellowDuration;
    this.signals.set(nodeId, {
      id, nodeId,
      phases: [
        { group: 'NS', color: 'GREEN', duration: SIGNAL_TIMING.minGreen, yellowDuration: yellowS },
        { group: 'NS', color: 'YELLOW', duration: yellowS, yellowDuration: 0 },
        { group: 'EW', color: 'GREEN', duration: SIGNAL_TIMING.minGreen, yellowDuration: yellowS },
        { group: 'EW', color: 'YELLOW', duration: yellowS, yellowDuration: 0 },
      ],
      currentPhaseIndex: 0, timer: 0,
      cycleLength: SIGNAL_TIMING.minGreen * 2 + yellowS * 2, offset: 0, greenWaveDirection: null,
      congestionLevel: 0, adaptiveTiming: true, approaches: [],
    });
    node.trafficSignalId = id;
    return true;
  }

  manualOverrideSignal(signalId: string, group: 'NS' | 'EW', color: SignalColor): void {
    const duration = color === 'GREEN' ? 30 : 5;
    const req: OverrideRequest = {
      id: `ovr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      signalId,
      targetGroup: group,
      targetColor: color,
      duration,
      priority: 80,
      source: 'user',
      expiresAt: this.simSeconds + duration,
      createdAt: Date.now(),
    };
    this.controllerManager.enqueueRequest(req);
  }

  deactivateManualOverride(): void {
    const simTime = this.simSeconds;
    const active = this.controllerManager.getActiveOverrides();
    for (const req of active) {
      req.expiresAt = simTime;
    }
  }

  isManualOverrideActive(): boolean {
    return this.controllerManager.getActiveOverrides().length > 0;
  }

  getManualOverrideTimeRemaining(): number {
    const simTime = this.simSeconds;
    const active = this.controllerManager.getActiveOverrides();
    let maxRemaining = 0;
    for (const req of active) {
      const remaining = req.expiresAt - simTime;
      if (remaining > maxRemaining) maxRemaining = remaining;
    }
    return maxRemaining;
  }

  hasEmergencyOverride(): boolean {
    return this.controllerManager.hasEmergencyOverride();
  }

  getEmergencyOverrideCount(): number {
    return this.controllerManager.getEmergencyOverrideCount();
  }

  async refreshRoadData(): Promise<void> {
    await clearGraphCache(CENTER.lat, CENTER.lng, RADIUS);
    this.vehicles.clear();
    await this.init(true);
    this.start();
  }

  async exportSignalsToJSON(): Promise<string | null> {
    if (this.signals.size === 0 || this.graph.nodes.size === 0) return null;
    const { serializeSignals, extractSignalPoints } = await import('../data/signalStore');
    const points = extractSignalPoints(this.signals, this.graph.nodes);
    return serializeSignals(points);
  }
}

export type { Vehicle };
