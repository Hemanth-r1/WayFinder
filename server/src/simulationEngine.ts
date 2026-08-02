import type { RoadGraph, TrafficSignal, Vehicle, CongestionZone, TrafficStats } from './types.js';

export interface SimState {
  vehicles: Map<string, Vehicle>;
  signals: Map<string, TrafficSignal>;
  graph: RoadGraph;
  running: boolean;
  simTime: number;
  lastUpdate: number;
}

const SIMULATION_CONFIG = {
  MAX_VEHICLES: 120,
  SPAWN_INTERVAL: { min: 200, max: 800 },
  INITIAL_VEHICLES: 20,
  UPDATE_INTERVAL: 0.05,
  VEHICLE_SPAWN_COUNT: 3,
};

const VEHICLE_PHYSICS: Record<string, {
  maxSpeed: number; acceleration: number; deceleration: number;
  length: number; width: number;
}> = {
  sedan: { maxSpeed: 50, acceleration: 2.8, deceleration: 4.5, length: 4.5, width: 1.8 },
  suv: { maxSpeed: 48, acceleration: 2.2, deceleration: 4.0, length: 5.0, width: 2.0 },
  emergency: { maxSpeed: 70, acceleration: 3.5, deceleration: 5.0, length: 5.5, width: 2.0 },
  bike: { maxSpeed: 55, acceleration: 3.5, deceleration: 5.5, length: 2.2, width: 0.8 },
};

class SimulationEngine {
  private state: SimState;
  private spawnTimer = 0;
  private vehicleCounter = 0;
  private updateCallbacks: Set<(state: SimState) => void> = new Set();

  constructor(graph: RoadGraph, signals: TrafficSignal[]) {
    this.state = {
      vehicles: new Map(),
      signals: new Map(signals.map(s => [s.id, s])),
      graph,
      running: false,
      simTime: 0,
      lastUpdate: Date.now(),
    };
  }

  start(): void {
    this.state.running = true;
    this.state.lastUpdate = Date.now();
    
    // Spawn initial vehicles
    for (let i = 0; i < SIMULATION_CONFIG.INITIAL_VEHICLES; i++) {
      this.spawnRandomVehicle();
    }
    
    this.runLoop();
  }

  stop(): void {
    this.state.running = false;
  }

  onUpdate(callback: (state: SimState) => void): void {
    this.updateCallbacks.add(callback);
  }

  removeUpdateCallback(callback: (state: SimState) => void): void {
    this.updateCallbacks.delete(callback);
  }

  private runLoop(): void {
    if (!this.state.running) return;

    const now = Date.now();
    const deltaTime = Math.min((now - this.state.lastUpdate) / 1000, SIMULATION_CONFIG.UPDATE_INTERVAL);
    this.state.lastUpdate = now;
    this.state.simTime += deltaTime;

    this.update(deltaTime);
    this.notifyCallbacks();

    setTimeout(() => this.runLoop(), 50); // ~20 FPS
  }

  private update(dt: number): void {
    // Spawn vehicles
    this.spawnVehicles(dt);

    // Update signals
    this.updateSignals(dt);

    // Update vehicles
    for (const [id, vehicle] of this.state.vehicles) {
      if (!this.updateVehicle(vehicle, dt)) {
        this.state.vehicles.delete(id);
      }
    }
  }

  private spawnVehicles(dt: number): void {
    if (this.state.vehicles.size >= SIMULATION_CONFIG.MAX_VEHICLES) return;
    
    this.spawnTimer += dt * 1000;
    const interval = Math.max(
      SIMULATION_CONFIG.SPAWN_INTERVAL.min,
      SIMULATION_CONFIG.SPAWN_INTERVAL.max - this.state.vehicles.size * 4,
    );
    
    if (this.spawnTimer < interval) return;
    this.spawnTimer = 0;

    const count = Math.min(SIMULATION_CONFIG.VEHICLE_SPAWN_COUNT, SIMULATION_CONFIG.MAX_VEHICLES - this.state.vehicles.size);
    for (let i = 0; i < count; i++) {
      this.spawnRandomVehicle();
    }
  }

  private spawnRandomVehicle(): void {
    const nodes = this.state.graph.nodes;
    if (nodes.length < 2) return;

    const startNode = nodes[Math.floor(Math.random() * nodes.length)];
    const endNode = nodes[Math.floor(Math.random() * nodes.length)];
    
    if (startNode.id === endNode.id) return;

    const vehicle = this.createVehicle(startNode.id, endNode.id, 'sedan');
    if (vehicle) {
      this.state.vehicles.set(vehicle.id, vehicle);
    }
  }

  private createVehicle(startId: string, destId: string, type: string): Vehicle | null {
    const startNode = this.state.graph.nodes.find(n => n.id === startId);
    if (!startNode) return null;

    this.vehicleCounter++;
    const physics = VEHICLE_PHYSICS[type] || VEHICLE_PHYSICS.sedan;

    return {
      id: `v${this.vehicleCounter}`,
      lat: startNode.lat,
      lng: startNode.lng,
      speed: physics.maxSpeed * 0.4,
      bearing: 0,
      type,
      color: '#2196F3',
      isNavigated: false,
    };
  }

  private updateVehicle(vehicle: Vehicle, dt: number): boolean {
    // Simple linear movement towards destination
    // In a full implementation, this would use IDM physics and pathfinding
    const speed = vehicle.speed;
    const moveDist = (speed / 3.6) * dt; // Convert km/h to m/s
    
    // Random bearing change for simulation
    vehicle.bearing = (vehicle.bearing + (Math.random() - 0.5) * 10) % 360;
    
    // Move vehicle (simplified)
    const latOffset = (moveDist / 111320) * Math.cos(vehicle.bearing * Math.PI / 180);
    const lngOffset = (moveDist / 111320) * Math.sin(vehicle.bearing * Math.PI / 180);
    
    vehicle.lat += latOffset;
    vehicle.lng += lngOffset;

    // Remove if out of bounds
    const centerLat = 12.9716;
    const centerLng = 77.5946;
    const dist = Math.sqrt((vehicle.lat - centerLat) ** 2 + (vehicle.lng - centerLng) ** 2);
    
    return dist < 0.1; // Keep within ~10km
  }

  private updateSignals(dt: number): void {
    for (const signal of this.state.signals.values()) {
      signal.timer += dt;
      
      const currentPhase = signal.phases[signal.currentPhaseIndex];
      if (signal.timer >= currentPhase.duration) {
        signal.timer = 0;
        signal.currentPhaseIndex = (signal.currentPhaseIndex + 1) % signal.phases.length;
      }
    }
  }

  private notifyCallbacks(): void {
    for (const callback of this.updateCallbacks) {
      callback(this.state);
    }
  }

  // Public API for external control
  addUserVehicle(userId: string, startId: string, destId: string): Vehicle | null {
    const vehicle = this.createVehicle(startId, destId, 'sedan');
    if (vehicle) {
      vehicle.isNavigated = true;
      vehicle.color = '#4488FF';
      vehicle.id = `user_${userId}`;
      this.state.vehicles.set(vehicle.id, vehicle);
    }
    return vehicle;
  }

  removeUserVehicle(userId: string): void {
    this.state.vehicles.delete(`user_${userId}`);
  }

  getUserVehicle(userId: string): Vehicle | undefined {
    return this.state.vehicles.get(`user_${userId}`);
  }

  getVehicles(): Vehicle[] {
    return Array.from(this.state.vehicles.values());
  }

  getSignals(): TrafficSignal[] {
    return Array.from(this.state.signals.values());
  }

  getStats(): TrafficStats {
    const vehicles = this.getVehicles();
    const avgSpeed = vehicles.length > 0 
      ? vehicles.reduce((sum, v) => sum + v.speed, 0) / vehicles.length 
      : 0;

    return {
      totalVehicles: vehicles.length,
      avgSpeed,
      avgDelay: 0,
      congestionHotspots: 0,
      greenWaveActive: false,
      signalCoordinationScore: 0,
      throughput: 0,
      maxCongestion: 0,
      slaSpeed: avgSpeed,
      slaCompliant: avgSpeed >= 24,
      emergencySlaSpeed: 0,
      activeCorridors: 0,
    };
  }
}

let globalEngine: SimulationEngine | null = null;

export function initSimulationEngine(graph: RoadGraph, signals: TrafficSignal[]): SimulationEngine {
  if (globalEngine) {
    globalEngine.stop();
  }
  globalEngine = new SimulationEngine(graph, signals);
  return globalEngine;
}

export function getSimulationEngine(): SimulationEngine | null {
  return globalEngine;
}
