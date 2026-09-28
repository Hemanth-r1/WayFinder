import type { RoadGraph, RoadEdge, TrafficSignal, Vehicle, TrafficStats } from './types.js';
import {
  getGraphIndex, congestionFactor, edgeCapacity, activeRouteEdgeIds, recordObservedSpeed, type GraphIndex,
} from './pathfindingService.js';
import { groupForBearing, approachState } from './signalTiming.js';
import { getWeather, getTrafficLevel, isEdgeBlocked, type TrafficLevel } from './conditionsService.js';

export interface SimState {
  vehicles: Map<string, Vehicle>;
  signals: Map<string, TrafficSignal>;
  graph: RoadGraph;
  running: boolean;
  simTime: number;
  lastUpdate: number;
}

export interface GpsMatch {
  /** Snapped onto the route within GPS_MATCH_METRES */
  onRoute: boolean;
  arrived: boolean;
  /** Metres from the nearest point on the upcoming route */
  offset: number;
}

export interface NavigationProgress {
  /** Index into the route's edgeIds of the edge being driven */
  edgeIndex: number;
  /** Metres driven along that edge */
  edgeProgress: number;
  vehicle: Vehicle;
}

/** Simulated vehicle count per traffic level (real users' vehicles come on top). */
const SIM_VEHICLES: Record<TrafficLevel, number> = { light: 60, normal: 150, heavy: 350 };
/** Share of new simulated vehicles placed on routes real users are driving. */
const CORRIDOR_SHARE = 0.5;
/** Chance a corridor vehicle keeps to a user route at each junction. */
const CORRIDOR_STICKINESS = 0.7;
/** GPS points further than this from the upcoming route count as off-route. */
const GPS_MATCH_METRES = 50;
/** How many upcoming route edges to search when matching GPS. */
const GPS_LOOKAHEAD_EDGES = 12;
/** Within this distance of the destination counts as arrived. */
const ARRIVAL_METRES = 30;

const SIMULATION_CONFIG = {
  SPAWN_INTERVAL: { min: 200, max: 800 },
  INITIAL_VEHICLES: 20,
  UPDATE_INTERVAL: 0.05,
  VEHICLE_SPAWN_COUNT: 3,
  /** Background vehicles despawn after roughly this many seconds of driving */
  LIFETIME: { min: 90, max: 300 },
  /** Gap kept to the vehicle ahead and to a red stop line (m) */
  MIN_GAP: 7,
  /** Distance over which vehicles slow for a red light (m) */
  BRAKE_ZONE: 40,
};

const VEHICLE_TYPES: { type: string; color: string; speedFactor: number }[] = [
  { type: 'sedan', color: '#2196F3', speedFactor: 0.9 },
  { type: 'suv', color: '#26A69A', speedFactor: 0.85 },
  { type: 'bike', color: '#FFB300', speedFactor: 0.95 },
  { type: 'auto', color: '#8BC34A', speedFactor: 0.7 },
  { type: 'bus', color: '#EF5350', speedFactor: 0.65 },
];

interface SimVehicle {
  pub: Vehicle;
  edge: RoadEdge;
  /** Metres along `edge` */
  progress: number;
  speedFactor: number;
  /** Seconds left before a background vehicle leaves */
  ttl: number;
  /** Navigated vehicles: route edges and current index */
  userId?: string;
  route?: string[];
  routeIndex: number;
  /** Real driver: position comes from GPS updates, not the simulation */
  gps?: { at: number; lat: number; lng: number };
  /** Simulated vehicle that keeps to real users' routes */
  corridor?: boolean;
}

class SimulationEngine {
  private state: SimState;
  private index: GraphIndex;
  private sim = new Map<string, SimVehicle>();
  private occupancy = new Map<string, number>();
  private edgeGeomCache = new Map<string, number[]>();
  private spawnTimer = 0;
  private vehicleCounter = 0;
  private updateCallbacks: Set<(state: SimState) => void> = new Set();
  private arrivalHandler: ((userId: string) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(graph: RoadGraph, signals: TrafficSignal[]) {
    this.state = {
      vehicles: new Map(),
      signals: new Map(signals.map(s => [s.id, s])),
      graph,
      running: false,
      simTime: 0,
      lastUpdate: Date.now(),
    };
    this.index = getGraphIndex(graph, signals);
  }

  start(): void {
    this.state.running = true;
    this.state.lastUpdate = Date.now();
    for (let i = 0; i < SIMULATION_CONFIG.INITIAL_VEHICLES; i++) this.spawnRandomVehicle();
    this.runLoop();
  }

  stop(): void {
    this.state.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  onUpdate(callback: (state: SimState) => void): void {
    this.updateCallbacks.add(callback);
  }

  removeUpdateCallback(callback: (state: SimState) => void): void {
    this.updateCallbacks.delete(callback);
  }

  /** Called with the userId when a navigated vehicle reaches its destination. */
  setArrivalHandler(handler: (userId: string) => void): void {
    this.arrivalHandler = handler;
  }

  private runLoop(): void {
    if (!this.state.running) return;

    const now = Date.now();
    const deltaTime = Math.min((now - this.state.lastUpdate) / 1000, SIMULATION_CONFIG.UPDATE_INTERVAL);
    this.state.lastUpdate = now;
    this.state.simTime += deltaTime;

    this.update(deltaTime);
    this.notifyCallbacks();

    this.timer = setTimeout(() => this.runLoop(), 50); // ~20 FPS
  }

  private update(dt: number): void {
    this.spawnVehicles(dt);
    this.updateSignals(dt);
    this.rebuildOccupancy();

    // Leader lookup: vehicles per edge, furthest along first
    const byEdge = new Map<string, SimVehicle[]>();
    for (const sv of this.sim.values()) {
      const list = byEdge.get(sv.edge.id);
      if (list) list.push(sv); else byEdge.set(sv.edge.id, [sv]);
    }
    for (const list of byEdge.values()) list.sort((a, b) => b.progress - a.progress);

    for (const [id, sv] of this.sim) {
      if (sv.gps) continue; // real drivers move with their GPS updates
      const leaders = byEdge.get(sv.edge.id) ?? [];
      const ahead = leaders[leaders.indexOf(sv) - 1];
      if (!this.updateVehicle(sv, dt, ahead)) this.removeVehicle(id);
    }
  }

  private rebuildOccupancy(): void {
    this.occupancy.clear();
    for (const sv of this.sim.values()) {
      this.occupancy.set(sv.edge.id, (this.occupancy.get(sv.edge.id) ?? 0) + 1);
    }
  }

  private simulatedCount(): number {
    let n = 0;
    for (const sv of this.sim.values()) if (!sv.userId) n++;
    return n;
  }

  private spawnVehicles(dt: number): void {
    const target = SIM_VEHICLES[getTrafficLevel()];
    const simulated = this.simulatedCount();
    if (simulated >= target) return;

    this.spawnTimer += dt * 1000;
    // Fill faster the further below target we are
    const interval = Math.max(
      SIMULATION_CONFIG.SPAWN_INTERVAL.min / 2,
      SIMULATION_CONFIG.SPAWN_INTERVAL.max * (simulated / target),
    );
    if (this.spawnTimer < interval) return;
    this.spawnTimer = 0;

    const count = Math.min(SIMULATION_CONFIG.VEHICLE_SPAWN_COUNT * 2, target - simulated);
    for (let i = 0; i < count; i++) this.spawnRandomVehicle();
  }

  /** Random open edge, or (for corridor vehicles) one on a real user's route. */
  private pickSpawnEdge(corridor: boolean): RoadEdge | null {
    if (corridor) {
      const ids = activeRouteEdgeIds();
      for (let tries = 0; tries < 5 && ids.length > 0; tries++) {
        const e = this.index.edges.get(ids[Math.floor(Math.random() * ids.length)]);
        if (e && !isEdgeBlocked(e.id)) return e;
      }
    }
    const edges = this.index.edgeList;
    for (let tries = 0; tries < 5 && edges.length > 0; tries++) {
      const e = edges[Math.floor(Math.random() * edges.length)];
      if (!isEdgeBlocked(e.id)) return e;
    }
    return null;
  }

  private spawnRandomVehicle(): void {
    const corridor = activeRouteEdgeIds().length > 0 && Math.random() < CORRIDOR_SHARE;
    const edge = this.pickSpawnEdge(corridor);
    if (!edge) return;
    const kind = VEHICLE_TYPES[Math.floor(Math.random() * VEHICLE_TYPES.length)];
    const { min, max } = SIMULATION_CONFIG.LIFETIME;

    this.vehicleCounter++;
    const sv: SimVehicle = {
      pub: {
        id: `v${this.vehicleCounter}`, lat: 0, lng: 0, speed: 0, bearing: edge.bearing,
        type: kind.type, color: kind.color, isNavigated: false,
      },
      edge,
      progress: Math.random() * edge.length,
      speedFactor: kind.speedFactor * (0.85 + Math.random() * 0.2),
      ttl: min + Math.random() * (max - min),
      routeIndex: 0,
      corridor,
    };
    this.placeVehicle(sv);
    this.sim.set(sv.pub.id, sv);
    this.state.vehicles.set(sv.pub.id, sv.pub);
  }

  private removeVehicle(id: string): void {
    this.sim.delete(id);
    this.state.vehicles.delete(id);
  }

  /** Advances one vehicle; returns false when it should leave the simulation. */
  private updateVehicle(sv: SimVehicle, dt: number, ahead: SimVehicle | undefined): boolean {
    const edge = sv.edge;
    const cruise = (edge.speedLimit / 3.6) * sv.speedFactor * getWeather().speedFactor /
      congestionFactor(edge, this.occupancy.get(edge.id) ?? 0);
    let limit = edge.length + 1_000_000; // how far along this edge we may go
    let target = cruise;

    // A navigated vehicle waits before a road block on its route until it is rerouted
    const nextRouteEdge = sv.route?.[sv.routeIndex + 1];
    if (nextRouteEdge && isEdgeBlocked(nextRouteEdge)) {
      limit = Math.max(sv.progress, edge.length - SIMULATION_CONFIG.MIN_GAP);
    }

    const signal = this.index.signalByNode.get(edge.to);
    const isLastEdge = sv.route !== undefined && sv.routeIndex >= sv.route.length - 1;
    if (signal && !isLastEdge) {
      const state = approachState(signal, groupForBearing(edge.bearing));
      const toLine = edge.length - sv.progress;
      // Commit through yellow only when too close to stop comfortably
      const mustStop = state === 'RED' || (state === 'YELLOW' && toLine > 15);
      if (mustStop) {
        const stopAt = Math.max(sv.progress, edge.length - SIMULATION_CONFIG.MIN_GAP / 2);
        limit = Math.min(limit, stopAt);
        if (toLine < SIMULATION_CONFIG.BRAKE_ZONE) target = Math.min(target, cruise * Math.max(0, toLine - 3) / SIMULATION_CONFIG.BRAKE_ZONE);
      }
    }
    if (ahead) {
      const gap = ahead.progress - sv.progress;
      limit = Math.min(limit, Math.max(sv.progress, ahead.progress - SIMULATION_CONFIG.MIN_GAP));
      if (gap < SIMULATION_CONFIG.MIN_GAP * 3) target = Math.min(target, ahead.pub.speed / 3.6);
    }

    const moved = Math.max(0, Math.min(target * dt, limit - sv.progress));
    sv.progress += moved;
    sv.pub.speed = dt > 0 ? (moved / dt) * 3.6 : 0;
    sv.ttl -= dt;

    for (let hops = 0; sv.progress >= sv.edge.length && hops < 10; hops++) {
      const overflow = sv.progress - sv.edge.length;
      const next = this.nextEdge(sv);
      if (!next) {
        if (sv.userId) this.arrivalHandler?.(sv.userId);
        return false;
      }
      sv.edge = next;
      sv.progress = overflow;
    }

    if (!sv.userId && sv.ttl <= 0) return false;
    this.placeVehicle(sv);
    return true;
  }

  private nextEdge(sv: SimVehicle): RoadEdge | null {
    if (sv.route) {
      sv.routeIndex++;
      const id = sv.route[sv.routeIndex];
      return id ? this.index.edges.get(id) ?? null : null;
    }
    const options = (this.index.outEdges.get(sv.edge.to) ?? []).filter(e => !isEdgeBlocked(e.id));
    const forward = options.filter(e => e.to !== sv.edge.from);
    let pool = forward.length > 0 ? forward : options;
    if (sv.corridor && Math.random() < CORRIDOR_STICKINESS) {
      const onRoutes = new Set(activeRouteEdgeIds());
      const corridor = pool.filter(e => onRoutes.has(e.id));
      if (corridor.length > 0) pool = corridor;
    }
    return pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : null;
  }

  /** Cumulative geometry distances (in degrees-space metres) for interpolation. */
  private cumulative(edge: RoadEdge): number[] {
    let cum = this.edgeGeomCache.get(edge.id);
    if (!cum) {
      cum = [0];
      const g = edge.geometry;
      for (let i = 1; i < g.length; i++) {
        const dLat = (g[i].lat - g[i - 1].lat) * 111320;
        const dLng = (g[i].lng - g[i - 1].lng) * 111320 * Math.cos(g[i].lat * Math.PI / 180);
        cum.push(cum[i - 1] + Math.hypot(dLat, dLng));
      }
      this.edgeGeomCache.set(edge.id, cum);
    }
    return cum;
  }

  private placeVehicle(sv: SimVehicle): void {
    const g = sv.edge.geometry;
    if (!g || g.length < 2) {
      const n = this.index.nodes.get(sv.edge.to);
      if (n) { sv.pub.lat = n.lat; sv.pub.lng = n.lng; }
      sv.pub.bearing = sv.edge.bearing;
      return;
    }
    const cum = this.cumulative(sv.edge);
    const total = cum[cum.length - 1] || 1;
    const d = Math.min(1, Math.max(0, sv.progress / (sv.edge.length || 1))) * total;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const segLen = cum[i] - cum[i - 1] || 1;
    const t = (d - cum[i - 1]) / segLen;
    const a = g[i - 1], b = g[i];
    sv.pub.lat = a.lat + (b.lat - a.lat) * t;
    sv.pub.lng = a.lng + (b.lng - a.lng) * t;
    const y = (b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180);
    const x = b.lat - a.lat;
    sv.pub.bearing = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
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
    for (const callback of this.updateCallbacks) callback(this.state);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Puts the user's vehicle at the start of `route` (edge IDs), replacing any previous one. */
  addUserVehicle(userId: string, route: string[], gps = false): Vehicle | null {
    const first = route.length > 0 ? this.index.edges.get(route[0]) : undefined;
    if (!first) return null;
    this.removeUserVehicle(userId);

    const sv: SimVehicle = {
      pub: {
        id: `user_${userId}`, lat: 0, lng: 0, speed: 0, bearing: first.bearing,
        type: 'sedan', color: '#4488FF', isNavigated: true,
      },
      edge: first,
      progress: 0,
      speedFactor: 0.9,
      ttl: Infinity,
      userId,
      route,
      routeIndex: 0,
    };
    this.placeVehicle(sv);
    if (gps) sv.gps = { at: Date.now(), lat: sv.pub.lat, lng: sv.pub.lng };
    this.sim.set(sv.pub.id, sv);
    this.state.vehicles.set(sv.pub.id, sv.pub);
    return sv.pub;
  }

  removeUserVehicle(userId: string): void {
    this.removeVehicle(`user_${userId}`);
  }

  getUserVehicle(userId: string): Vehicle | undefined {
    return this.state.vehicles.get(`user_${userId}`);
  }

  getNavigationProgress(userId: string): NavigationProgress | null {
    const sv = this.sim.get(`user_${userId}`);
    if (!sv || !sv.route) return null;
    return { edgeIndex: sv.routeIndex, edgeProgress: sv.progress, vehicle: sv.pub };
  }

  /**
   * Replaces a user's route. `edgeIds[0]` may be the edge they are on (progress is kept)
   * or a fresh start edge (they are placed at its start).
   */
  replaceUserRoute(userId: string, edgeIds: string[]): boolean {
    const sv = this.sim.get(`user_${userId}`);
    const first = edgeIds.length > 0 ? this.index.edges.get(edgeIds[0]) : undefined;
    if (!sv || !first) return false;
    if (first.id !== sv.edge.id) {
      sv.edge = first;
      sv.progress = 0;
      if (!sv.gps) this.placeVehicle(sv);
    }
    sv.route = edgeIds;
    sv.routeIndex = 0;
    return true;
  }

  /**
   * Moves a real driver's vehicle to their GPS fix, snapped onto the upcoming part of
   * their route. Their measured speed feeds live traffic for everyone's routing.
   */
  updateUserGps(userId: string, lat: number, lng: number, speedKmh?: number): GpsMatch | null {
    const sv = this.sim.get(`user_${userId}`);
    if (!sv || !sv.route) return null;
    const now = Date.now();
    const prev = sv.gps;

    let best = { index: -1, along: 0, dist: Infinity, lat, lng };
    const end = Math.min(sv.route.length, sv.routeIndex + GPS_LOOKAHEAD_EDGES);
    for (let i = sv.routeIndex; i < end; i++) {
      const edge = this.index.edges.get(sv.route[i]);
      if (!edge) continue;
      const m = this.project(edge, lat, lng);
      if (m.dist < best.dist) best = { index: i, ...m };
    }

    sv.gps = { at: now, lat, lng };
    const onRoute = best.dist <= GPS_MATCH_METRES;
    let speed = speedKmh;
    if (speed === undefined && prev) {
      const secs = (now - prev.at) / 1000;
      if (secs > 0.5) speed = this.metres(prev, { lat, lng }) / secs * 3.6;
    }
    if (speed !== undefined && Number.isFinite(speed)) sv.pub.speed = Math.max(0, speed);

    if (onRoute) {
      const edge = this.index.edges.get(sv.route[best.index])!;
      sv.routeIndex = best.index;
      sv.edge = edge;
      sv.progress = best.along;
      sv.pub.lat = best.lat;
      sv.pub.lng = best.lng;
      sv.pub.bearing = edge.bearing;
      if (speed !== undefined && prev && now - prev.at < 30000) recordObservedSpeed(edge.id, sv.pub.speed);
    } else {
      sv.pub.lat = lat;
      sv.pub.lng = lng;
    }

    const last = this.index.edges.get(sv.route[sv.route.length - 1]);
    const destNode = last ? this.index.nodes.get(last.to) : undefined;
    const arrived = !!destNode && this.metres(destNode, { lat, lng }) <= ARRIVAL_METRES;
    if (arrived) {
      this.removeVehicle(sv.pub.id);
      this.arrivalHandler?.(userId);
    }
    return { onRoute, arrived, offset: best.dist };
  }

  private metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const dLat = (b.lat - a.lat) * 111320;
    const dLng = (b.lng - a.lng) * 111320 * Math.cos(a.lat * Math.PI / 180);
    return Math.hypot(dLat, dLng);
  }

  /** Nearest point on `edge` to (lat, lng): distance, metres along the edge, and the point. */
  private project(edge: RoadEdge, lat: number, lng: number): { dist: number; along: number; lat: number; lng: number } {
    const g = edge.geometry;
    const cum = this.cumulative(edge);
    const total = cum[cum.length - 1] || 1;
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 111320;
    let best = { dist: Infinity, along: 0, lat: g[0].lat, lng: g[0].lng };
    for (let i = 1; i < g.length; i++) {
      const ax = (g[i - 1].lng - lng) * kx, ay = (g[i - 1].lat - lat) * ky;
      const bx = (g[i].lng - lng) * kx, by = (g[i].lat - lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const px = ax + t * dx, py = ay + t * dy;
      const dist = Math.hypot(px, py);
      if (dist < best.dist) {
        best = {
          dist,
          along: (cum[i - 1] + t * (cum[i] - cum[i - 1])) / total * edge.length,
          lat: g[i - 1].lat + t * (g[i].lat - g[i - 1].lat),
          lng: g[i - 1].lng + t * (g[i].lng - g[i - 1].lng),
        };
      }
    }
    return best;
  }

  /** Live simulated vehicles per edge ID. */
  getOccupancy(): Map<string, number> {
    return this.occupancy;
  }

  /** Average speed (km/h) of simulated vehicles on each of the given edges. */
  getEdgeSpeeds(edgeIds: Iterable<string>): Map<string, number> {
    const wanted = new Set(edgeIds);
    const sums = new Map<string, { total: number; n: number }>();
    for (const sv of this.sim.values()) {
      if (!wanted.has(sv.edge.id)) continue;
      const s = sums.get(sv.edge.id) ?? { total: 0, n: 0 };
      s.total += sv.pub.speed; s.n++;
      sums.set(sv.edge.id, s);
    }
    return new Map([...sums].map(([id, s]) => [id, s.total / s.n]));
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
    let hotspots = 0, maxCongestion = 0;
    for (const [edgeId, count] of this.occupancy) {
      const edge = this.index.edges.get(edgeId);
      if (!edge) continue;
      const level = Math.min(1, count / edgeCapacity(edge));
      maxCongestion = Math.max(maxCongestion, level);
      if (level > 0.5) hotspots++;
    }

    return {
      totalVehicles: vehicles.length,
      avgSpeed,
      avgDelay: 0,
      congestionHotspots: hotspots,
      greenWaveActive: false,
      signalCoordinationScore: 0,
      throughput: 0,
      maxCongestion,
      slaSpeed: avgSpeed,
      slaCompliant: avgSpeed >= 24,
      emergencySlaSpeed: 0,
      activeCorridors: 0,
      simulatedVehicles: this.simulatedCount(),
      realVehicles: vehicles.length - this.simulatedCount(),
    };
  }
}

export type { SimulationEngine };

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
