import type {
  Direction, Intersection, RoadSegment, TrafficSignal, Vehicle,
  TrafficStats, SignalPhase, VehicleType,
} from '../types';
import {
  DEFAULT_GRID, APPROACHING_THRESHOLD, VEHICLE_GAP,
  INTERSECTION_RADIUS, CLEANUP_DISTANCE, SPEED_SCALE, MAX_VEHICLES_PER_SEGMENT,
} from '../types';
import type { GridConfig } from '../types';
import {
  findRoute, findAlternativeRoute, coordinateSignals,
  detectBlockedRoutes, getNeighbor, getAvailableDirections,
  getDirectionFromTo, oppositeDirection, turnLeft, turnRight,
} from '../utils/algorithms';
import { SyncService } from './SyncService';

const VEHICLE_COLORS = [
  '#2196F3', '#4CAF50', '#FF9800', '#E91E63',
  '#9C27B0', '#00BCD4', '#FF5722', '#607D8B',
  '#3F51B5', '#009688', '#795548', '#F44336',
];

const VEHICLE_TYPES: VehicleType[] = ['car', 'car', 'car', 'truck', 'bus', 'car', 'car', 'emergency'];

const TURN_BIAS = 0.2;

export class TrafficEngine {
  intersections: Map<string, Intersection> = new Map();
  roadSegments: Map<string, RoadSegment> = new Map();
  signals: Map<string, TrafficSignal> = new Map();
  vehicles: Map<string, Vehicle> = new Map();
  grid: GridConfig;
  running = false;
  private vehicleIdCounter = 0;
  private spawnTimer = 0;
  private syncService: SyncService;
  private blockedRoutes: Set<string> = new Set();

  stats: TrafficStats = {
    totalVehicles: 0,
    avgSpeed: 0,
    congestionHotspots: 0,
    greenWaveActive: false,
    signalCoordinationScore: 85,
    blockedRoutes: [],
  };

  constructor(grid?: Partial<GridConfig>) {
    this.grid = { ...DEFAULT_GRID, ...grid };
    this.syncService = new SyncService();
    this.buildRoadNetwork();
    this.initializeSignals();
  }

  private buildRoadNetwork(): void {
    const { cols, rows, centerLat, centerLng, latSpacing, lngSpacing } = this.grid;

    const startLat = centerLat - (rows / 2) * latSpacing;
    const startLng = centerLng - (cols / 2) * lngSpacing;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const id = `${c},${r}`;
        this.intersections.set(id, {
          id,
          row: r,
          col: c,
          lat: startLat + r * latSpacing,
          lng: startLng + c * lngSpacing,
        });
      }
    }

    for (const [id, int] of this.intersections) {
      const [cStr] = id.split(',');
      const col = parseInt(cStr);
      const r = int.row;

      if (col < cols - 1) {
        const eastId = `${col + 1},${r}`;
        const east = this.intersections.get(eastId)!;
        this.roadSegments.set(`${id}-${eastId}`, {
          id: `${id}-${eastId}`,
          fromId: id,
          toId: eastId,
          direction: 'E',
          from: { lat: int.lat, lng: int.lng },
          to: { lat: east.lat, lng: east.lng },
          length: lngSpacing,
        });
        this.roadSegments.set(`${eastId}-${id}`, {
          id: `${eastId}-${id}`,
          fromId: eastId,
          toId: id,
          direction: 'W',
          from: { lat: east.lat, lng: east.lng },
          to: { lat: int.lat, lng: int.lng },
          length: lngSpacing,
        });
      }

      if (r < rows - 1) {
        const southId = `${col},${r + 1}`;
        const south = this.intersections.get(southId)!;
        this.roadSegments.set(`${id}-${southId}`, {
          id: `${id}-${southId}`,
          fromId: id,
          toId: southId,
          direction: 'S',
          from: { lat: int.lat, lng: int.lng },
          to: { lat: south.lat, lng: south.lng },
          length: latSpacing,
        });
        this.roadSegments.set(`${southId}-${id}`, {
          id: `${southId}-${id}`,
          fromId: southId,
          toId: id,
          direction: 'N',
          from: { lat: south.lat, lng: south.lng },
          to: { lat: int.lat, lng: int.lng },
          length: latSpacing,
        });
      }
    }
  }

  private initializeSignals(): void {
    for (const [id, int] of this.intersections) {
      const signal: TrafficSignal = {
        intersectionId: id,
        phases: [
          { direction: 'N', color: 'GREEN', duration: 12 },
          { direction: 'S', color: 'GREEN', duration: 12 },
          { direction: 'E', color: 'RED', duration: 1 },
          { direction: 'W', color: 'RED', duration: 1 },
        ],
        currentPhaseIndex: 0,
        timer: 0,
        greenWaveDirection: null,
        congestionLevel: 0,
      };

      const dirs = getAvailableDirections(int, this.intersections, this.grid);

      const hasNS = dirs.includes('N') && dirs.includes('S');
      const hasEW = dirs.includes('E') && dirs.includes('W');

      if (hasNS && hasEW) {
        signal.phases = [
          { direction: 'N', color: 'GREEN', duration: 12 },
          { direction: 'S', color: 'GREEN', duration: 12 },
          { direction: 'E', color: 'RED', duration: 2 },
          { direction: 'W', color: 'RED', duration: 2 },
          { direction: 'E', color: 'GREEN', duration: 10 },
          { direction: 'W', color: 'GREEN', duration: 10 },
          { direction: 'N', color: 'RED', duration: 2 },
          { direction: 'S', color: 'RED', duration: 2 },
        ];
      } else if (hasNS) {
        signal.phases = [
          { direction: 'N', color: 'GREEN', duration: 15 },
          { direction: 'S', color: 'GREEN', duration: 15 },
        ];
      } else if (hasEW) {
        signal.phases = [
          { direction: 'E', color: 'GREEN', duration: 15 },
          { direction: 'W', color: 'GREEN', duration: 15 },
        ];
      } else {
        const onlyDir = dirs[0];
        signal.phases = [
          { direction: onlyDir, color: 'GREEN', duration: 15 },
          { direction: oppositeDirection(onlyDir), color: 'RED', duration: 3 },
        ];
      }

      this.signals.set(id, signal);
    }
  }

  start(): void {
    this.running = true;
    for (let i = 0; i < 5; i++) {
      this.spawnVehicle();
    }
  }

  stop(): void {
    this.running = false;
  }

  setFirebaseSync(enabled: boolean): void {
    if (enabled) this.syncService.enable();
    else this.syncService.disable();
  }

  update(deltaTime: number): void {
    if (!this.running) return;

    this.blockedRoutes = detectBlockedRoutes(this.vehicles, this.intersections, this.grid);
    this.stats.blockedRoutes = Array.from(this.blockedRoutes);

    this.spawnVehicles(deltaTime);
    this.updateSignals(deltaTime);
    this.updateVehicles(deltaTime);
    this.cleanupVehicles();
    this.updateStats();

    this.syncService.syncSignals(this.signals, this.intersections);
    this.syncService.syncStats(this.stats);
    this.syncService.syncVehicles(this.vehicles);
  }

  private updateSignals(_deltaTime: number): void {
    coordinateSignals(this.signals, this.vehicles, this.intersections, _deltaTime);

    let nsGreenCount = 0;
    let nsCount = 0;
    let ewGreenCount = 0;
    let ewCount = 0;

    for (const [, signal] of this.signals) {
      const phase = signal.phases[signal.currentPhaseIndex];
      if (phase.direction === 'N' || phase.direction === 'S') {
        nsCount++;
        if (phase.color === 'GREEN') nsGreenCount++;
      } else {
        ewCount++;
        if (phase.color === 'GREEN') ewGreenCount++;
      }
    }

    this.stats.greenWaveActive = (nsCount > 0 && nsGreenCount > nsCount * 0.6) ||
      (ewCount > 0 && ewGreenCount > ewCount * 0.6);
  }

  private spawnVehicles(deltaTime: number): void {
    const maxVehicles = Math.min(150, Math.floor((this.grid.cols * this.grid.rows) * 1.8));
    if (this.vehicles.size >= maxVehicles) return;

    this.spawnTimer += deltaTime;
    const spawnInterval = Math.max(300, 1000 - this.vehicles.size * 3);

    if (this.spawnTimer < spawnInterval) return;
    this.spawnTimer = 0;

    const spawnCount = Math.min(3, maxVehicles - this.vehicles.size);
    for (let i = 0; i < spawnCount; i++) {
      this.spawnVehicle();
    }
  }

  private spawnVehicle(): void {
    const edgeIntersections: Intersection[] = [];

    for (const [, int] of this.intersections) {
      const dirs = getAvailableDirections(int, this.intersections, this.grid);
      if (dirs.length < 4 && dirs.length > 0) {
        edgeIntersections.push(int);
      }
    }

    if (edgeIntersections.length === 0) return;

    const startInt = edgeIntersections[Math.floor(Math.random() * edgeIntersections.length)];
    const exitDirs = getAvailableDirections(startInt, this.intersections, this.grid);
    if (exitDirs.length === 0) return;

    const entryDir = exitDirs[Math.floor(Math.random() * exitDirs.length)];

    const entryNeighbor = getNeighbor(startInt, entryDir, this.intersections, this.grid);
    if (!entryNeighbor) return;

    const fromId = entryNeighbor.id;
    const toId = startInt.id;
    const segId = `${fromId}-${toId}`;
    const seg = this.roadSegments.get(segId);
    if (!seg) return;

    const route = findRoute(startInt.id, this.intersections, this.signals, this.grid, this.blockedRoutes, entryDir);
    if (route.length < 2) return;

    const vType = VEHICLE_TYPES[Math.floor(Math.random() * VEHICLE_TYPES.length)];
    const basePxSpeed = vType === 'emergency' ? 180 : vType === 'bus' ? 80 : vType === 'truck' ? 70 : 100;
    const baseSpeed = basePxSpeed * SPEED_SCALE;

    this.vehicleIdCounter++;
    const vehicle: Vehicle = {
      id: `v${this.vehicleIdCounter}`,
      type: vType,
      lat: seg.from.lat,
      lng: seg.from.lng,
      direction: entryDir,
      speed: baseSpeed + (Math.random() - 0.5) * baseSpeed * 0.2,
      baseSpeed,
      currentSegmentId: segId,
      targetIntersectionId: startInt.id,
      route,
      routeIndex: 0,
      color: VEHICLE_COLORS[Math.floor(Math.random() * VEHICLE_COLORS.length)],
      length: 0.00005,
      width: 0.00003,
      stuckTime: 0,
      rerouted: false,
    };

    this.vehicles.set(vehicle.id, vehicle);
  }

  private updateVehicles(deltaTime: number): void {
    for (const [id, vehicle] of this.vehicles) {
      const seg = this.roadSegments.get(vehicle.currentSegmentId);
      if (!seg) { this.vehicles.delete(id); continue; }

      const signal = this.signals.get(vehicle.targetIntersectionId);
      if (!signal) { this.vehicles.delete(id); continue; }

      const targetInt = this.intersections.get(vehicle.targetIntersectionId);
      if (!targetInt) { this.vehicles.delete(id); continue; }

      const dlat = targetInt.lat - vehicle.lat;
      const dlng = targetInt.lng - vehicle.lng;
      const distToTarget = Math.sqrt(dlat * dlat + dlng * dlng);

      let canProceed = true;

      if (distToTarget < APPROACHING_THRESHOLD) {
        const phase = signal.phases[signal.currentPhaseIndex];
        const approachDir = oppositeDirection(vehicle.direction) as Direction;

        if (phase.color === 'RED') {
          const isAllowed = phase.direction === approachDir;
          if (!isAllowed) canProceed = false;
        }

        const others = this.getVehiclesInIntersection(vehicle.targetIntersectionId, vehicle.id);
        const conflict = others.some(ov => {
          const ovSeg = this.roadSegments.get(ov.currentSegmentId);
          if (!ovSeg) return false;
          return ovSeg.toId === vehicle.targetIntersectionId && ov.direction !== vehicle.direction;
        });

        if (conflict) {
          const priority: Direction[] = [vehicle.direction, oppositeDirection(vehicle.direction)];
          const otherHasPriority = others.some(ov => priority.includes(ov.direction));
          if (!otherHasPriority) canProceed = false;
        }

        const ahead = this.getVehicleAhead(vehicle, seg);
        if (ahead && this.distanceBetween(vehicle, ahead) < vehicle.length + VEHICLE_GAP) {
          canProceed = false;
        }
      } else {
        const ahead = this.getVehicleAhead(vehicle, seg);
        if (ahead) {
          const gap = this.distanceBetween(vehicle, ahead);
          const minGap = vehicle.length + VEHICLE_GAP * 1.5;
          if (gap < minGap) {
            canProceed = false;
            vehicle.speed = Math.min(vehicle.speed, ahead.speed * 0.8);
          }
        }
      }

      if (canProceed) {
        vehicle.stuckTime = 0;
        const speedFactor = this.blockedRoutes.has(vehicle.currentSegmentId) ? 0.3 : 1;
        const moveSpeed = vehicle.speed * deltaTime * speedFactor;

        if (distToTarget < moveSpeed) {
          vehicle.lat = targetInt.lat;
          vehicle.lng = targetInt.lng;
          this.advanceToNextSegment(vehicle);
        } else {
          vehicle.lat += (dlat / distToTarget) * moveSpeed;
          vehicle.lng += (dlng / distToTarget) * moveSpeed;
        }
      } else {
        vehicle.stuckTime += deltaTime;
      }

      if (vehicle.stuckTime > 5) {
        this.rerouteVehicle(vehicle);
      }
    }
  }

  private getVehicleAhead(vehicle: Vehicle, _seg: RoadSegment): Vehicle | null {
    let closest: Vehicle | null = null;
    let closestDist = Infinity;

    for (const [, ov] of this.vehicles) {
      if (ov.id === vehicle.id) continue;
      if (ov.currentSegmentId !== vehicle.currentSegmentId) continue;
      if (ov.direction !== vehicle.direction) continue;

      const dlat = ov.lat - vehicle.lat;
      const dlng = ov.lng - vehicle.lng;
      const angle = Math.atan2(dlng, dlat);
      const dirAngle = this.directionToAngle(vehicle.direction);
      let diff = angle - dirAngle;
      if (diff < -Math.PI) diff += Math.PI * 2;
      if (diff > Math.PI) diff -= Math.PI * 2;

      if (Math.abs(diff) < Math.PI / 4) {
        const dist = Math.sqrt(dlat * dlat + dlng * dlng);
        if (dist > 0 && dist < closestDist) {
          closestDist = dist;
          closest = ov;
        }
      }
    }

    return closest;
  }

  private getVehiclesInIntersection(intersectionId: string, excludeId?: string): Vehicle[] {
    const result: Vehicle[] = [];
    const int = this.intersections.get(intersectionId);
    if (!int) return result;

    for (const [, v] of this.vehicles) {
      if (excludeId && v.id === excludeId) continue;
      if (v.targetIntersectionId === intersectionId) {
        const dlat = Math.abs(v.lat - int.lat);
        const dlng = Math.abs(v.lng - int.lng);
        if (dlat < INTERSECTION_RADIUS && dlng < INTERSECTION_RADIUS) {
          result.push(v);
        }
      }
    }
    return result;
  }

  private distanceBetween(a: Vehicle, b: Vehicle): number {
    const dlat = a.lat - b.lat;
    const dlng = a.lng - b.lng;
    return Math.sqrt(dlat * dlat + dlng * dlng);
  }

  private directionToAngle(dir: Direction): number {
    switch (dir) {
      case 'E': return 0;
      case 'N': return -Math.PI / 2;
      case 'W': return Math.PI;
      case 'S': return Math.PI / 2;
    }
  }

  private advanceToNextSegment(vehicle: Vehicle): void {
    const currentInt = this.intersections.get(vehicle.targetIntersectionId);
    if (!currentInt) { this.vehicles.delete(vehicle.id); return; }

    vehicle.routeIndex++;

    if (vehicle.routeIndex >= vehicle.route.length) {
      this.vehicles.delete(vehicle.id);
      return;
    }

    const nextIntId = vehicle.route[vehicle.routeIndex];
    const nextInt = this.intersections.get(nextIntId);
    if (!nextInt) { this.vehicles.delete(vehicle.id); return; }

    const newDirection = getDirectionFromTo(currentInt, nextInt);
    const segId = `${currentInt.id}-${nextInt.id}`;
    const seg = this.roadSegments.get(segId);

    if (!seg) { this.vehicles.delete(vehicle.id); return; }

    if (this.blockedRoutes.has(segId)) {
      if (!vehicle.rerouted) {
        vehicle.rerouted = true;
        this.rerouteVehicle(vehicle);
        return;
      }
      this.vehicles.delete(vehicle.id);
      return;
    }

    vehicle.currentSegmentId = segId;
    vehicle.targetIntersectionId = nextIntId;
    vehicle.lat = currentInt.lat;
    vehicle.lng = currentInt.lng;
    vehicle.direction = newDirection;

    const dirs = getAvailableDirections(currentInt, this.intersections, this.grid);
    const isStraight = dirs.includes(newDirection);
    const canTurnLeft = dirs.includes(turnLeft(vehicle.direction));
    const canTurnRight = dirs.includes(turnRight(vehicle.direction));

    if (Math.random() < TURN_BIAS && canTurnLeft) {
      const leftDir = turnLeft(vehicle.direction);
      const leftNeighbor = getNeighbor(currentInt, leftDir, this.intersections, this.grid);
      if (leftNeighbor) {
        const newSegId = `${currentInt.id}-${leftNeighbor.id}`;
        const newSeg = this.roadSegments.get(newSegId);
        if (newSeg && !this.blockedRoutes.has(newSegId)) {
          vehicle.direction = leftDir;
          vehicle.currentSegmentId = newSegId;
          vehicle.targetIntersectionId = leftNeighbor.id;
          vehicle.route = [currentInt.id, leftNeighbor.id];
          vehicle.routeIndex = 0;
          vehicle.rerouted = false;
          return;
        }
      }
    }

    if (Math.random() < TURN_BIAS && canTurnRight) {
      const rightDir = turnRight(vehicle.direction);
      const rightNeighbor = getNeighbor(currentInt, rightDir, this.intersections, this.grid);
      if (rightNeighbor) {
        const newSegId = `${currentInt.id}-${rightNeighbor.id}`;
        const newSeg = this.roadSegments.get(newSegId);
        if (newSeg && !this.blockedRoutes.has(newSegId)) {
          vehicle.direction = rightDir;
          vehicle.currentSegmentId = newSegId;
          vehicle.targetIntersectionId = rightNeighbor.id;
          vehicle.route = [currentInt.id, rightNeighbor.id];
          vehicle.routeIndex = 0;
          vehicle.rerouted = false;
          return;
        }
      }
    }

    if (isStraight) { vehicle.rerouted = false; return; }
    vehicle.rerouted = false;
  }

  private rerouteVehicle(vehicle: Vehicle): void {
    const currentInt = this.intersections.get(vehicle.targetIntersectionId);
    if (!currentInt) return;

    const newRoute = findAlternativeRoute(
      vehicle.targetIntersectionId,
      vehicle.route,
      vehicle.routeIndex,
      this.intersections,
      this.signals,
      this.grid,
      this.blockedRoutes
    );

    if (newRoute.length >= 2) {
      vehicle.route = newRoute;
      vehicle.routeIndex = 0;
      vehicle.stuckTime = 0;
      vehicle.rerouted = true;

      if (newRoute.length > 1) {
        const nextId = newRoute[1];
        const nextInt = this.intersections.get(nextId);
        if (nextInt) {
          const newDirection = getDirectionFromTo(currentInt, nextInt);
          const segId = `${currentInt.id}-${nextInt.id}`;
          if (this.roadSegments.has(segId)) {
            vehicle.currentSegmentId = segId;
            vehicle.targetIntersectionId = nextId;
            vehicle.direction = newDirection;
          }
        }
      }
    } else {
      this.vehicles.delete(vehicle.id);
    }
  }

  private cleanupVehicles(): void {
    for (const [id, vehicle] of this.vehicles) {
      const seg = this.roadSegments.get(vehicle.currentSegmentId);
      if (!seg) { this.vehicles.delete(id); continue; }

      const int = this.intersections.get(vehicle.targetIntersectionId);
      if (!int) { this.vehicles.delete(id); continue; }

      const dlat = vehicle.lat - int.lat;
      const dlng = vehicle.lng - int.lng;
      if (Math.sqrt(dlat * dlat + dlng * dlng) > CLEANUP_DISTANCE) {
        this.vehicles.delete(id);
      }
    }
  }

  private updateStats(): void {
    let totalSpeed = 0;
    let speedCount = 0;
    let congestionCount = 0;

    for (const [, signal] of this.signals) {
      if (signal.congestionLevel > 0.5) congestionCount++;
    }

    for (const [, v] of this.vehicles) {
      totalSpeed += v.speed;
      speedCount++;
    }

    this.stats.totalVehicles = this.vehicles.size;
    this.stats.avgSpeed = speedCount > 0 ? totalSpeed / speedCount : 0;
    this.stats.avgSpeed = Math.round(this.stats.avgSpeed / SPEED_SCALE);
    this.stats.congestionHotspots = congestionCount;

    const activeCount = Array.from(this.signals.values()).filter(s => s.greenWaveDirection !== null).length;
    const totalSignals = this.signals.size;
    this.stats.signalCoordinationScore = totalSignals > 0
      ? Math.round((activeCount / totalSignals) * 100)
      : 0;
  }

  toggleFirebaseSync(enabled: boolean): void {
    this.setFirebaseSync(enabled);
  }

  addRandomBlockage(): void {
    if (this.roadSegments.size === 0) return;
    const segs = Array.from(this.roadSegments.values());
    const seg = segs[Math.floor(Math.random() * segs.length)];
    this.blockedRoutes.add(seg.id);
  }

  clearBlockage(segId?: string): void {
    if (segId) this.blockedRoutes.delete(segId);
    else this.blockedRoutes.clear();
  }
}
