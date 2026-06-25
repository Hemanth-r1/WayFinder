import type { Direction, Intersection, TrafficSignal, Vehicle, SignalColor, GridConfig } from '../types';
import { MAX_VEHICLES_PER_SEGMENT } from '../types';

const DIRECTION_OPPOSITES: Record<Direction, Direction> = {
  N: 'S', S: 'N', E: 'W', W: 'E',
};
const DIRECTION_LEFT: Record<Direction, Direction> = {
  N: 'W', S: 'E', E: 'N', W: 'S',
};
const DIRECTION_RIGHT: Record<Direction, Direction> = {
  N: 'E', S: 'W', E: 'S', W: 'N',
};

export function oppositeDirection(d: Direction): Direction {
  return DIRECTION_OPPOSITES[d];
}
export function turnLeft(d: Direction): Direction {
  return DIRECTION_LEFT[d];
}
export function turnRight(d: Direction): Direction {
  return DIRECTION_RIGHT[d];
}

export function getDirectionFromTo(from: Intersection, to: Intersection): Direction {
  if (to.row < from.row) return 'N';
  if (to.row > from.row) return 'S';
  if (to.col > from.col) return 'E';
  return 'W';
}

export function getNeighbor(
  intersection: Intersection,
  direction: Direction,
  intersections: Map<string, Intersection>,
  grid: GridConfig
): Intersection | null {
  const { row, col } = intersection;
  let tr = row, tc = col;
  switch (direction) {
    case 'N': tr--; break;
    case 'S': tr++; break;
    case 'E': tc++; break;
    case 'W': tc--; break;
  }
  if (tr < 0 || tr >= grid.rows || tc < 0 || tc >= grid.cols) return null;
  return intersections.get(`${tc},${tr}`) || null;
}

export function getAvailableDirections(
  intersection: Intersection,
  _intersections: Map<string, Intersection>,
  grid: GridConfig
): Direction[] {
  const dirs: Direction[] = [];
  if (intersection.row > 0) dirs.push('N');
  if (intersection.row < grid.rows - 1) dirs.push('S');
  if (intersection.col < grid.cols - 1) dirs.push('E');
  if (intersection.col > 0) dirs.push('W');
  return dirs;
}

export function findRoute(
  startId: string,
  intersections: Map<string, Intersection>,
  _signals: Map<string, TrafficSignal>,
  grid: GridConfig,
  blockedSegments: Set<string>,
  preferDirection: Direction | null
): string[] {
  const start = intersections.get(startId);
  if (!start) return [];

  const candidates: Intersection[] = [];
  for (const [, int] of intersections) {
    const dist = Math.abs(int.row - start.row) + Math.abs(int.col - start.col);
    if (dist >= Math.min(grid.rows, grid.cols) * 0.4 && int.id !== startId) {
      candidates.push(int);
    }
  }

  if (candidates.length === 0) return [];
  const target = candidates[Math.floor(Math.random() * candidates.length)];

  const visited = new Set<string>();
  const parent = new Map<string, string | null>();
  const queue: string[] = [startId];
  visited.add(startId);
  parent.set(startId, null);

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (currentId === target.id) {
      const path: string[] = [];
      let node: string | null = currentId;
      while (node !== null) { path.unshift(node); node = parent.get(node) || null; }
      return path;
    }

    const current = intersections.get(currentId);
    if (!current) continue;

    const dirs = getAvailableDirections(current, intersections, grid);
    const orderedDirs = preferDirection
      ? [preferDirection, ...dirs.filter(d => d !== preferDirection)]
      : dirs;

    for (const dir of orderedDirs) {
      const neighbor = getNeighbor(current, dir, intersections, grid);
      if (!neighbor) continue;
      const segId = `${currentId}-${neighbor.id}`;
      if (blockedSegments.has(segId)) continue;
      if (!visited.has(neighbor.id)) {
        visited.add(neighbor.id);
        parent.set(neighbor.id, currentId);
        queue.push(neighbor.id);
      }
    }
  }

  return [];
}

export function findAlternativeRoute(
  currentId: string,
  route: string[],
  routeIndex: number,
  intersections: Map<string, Intersection>,
  signals: Map<string, TrafficSignal>,
  grid: GridConfig,
  blockedSegments: Set<string>
): string[] {
  const blocked = new Set(blockedSegments);
  if (routeIndex < route.length - 1) {
    blocked.add(`${currentId}-${route[routeIndex + 1]}`);
  }
  return findRoute(currentId, intersections, signals, grid, blocked, null);
}

export function coordinateSignals(
  signals: Map<string, TrafficSignal>,
  vehicles: Map<string, Vehicle>,
  intersections: Map<string, Intersection>,
  deltaTime: number
): void {
  const densityByDirection = countDirectionDensity(vehicles);
  const dominantDirection = getDominantDirection(densityByDirection);
  const greenWaveGroup = buildGreenWaveGroup(dominantDirection, signals, intersections);

  for (const [id, signal] of signals) {
    const intersection = intersections.get(id);
    if (!intersection) continue;

    const inGreenWave = greenWaveGroup.has(id);
    signal.greenWaveDirection = inGreenWave ? dominantDirection : null;
    const localDensity = measureLocalCongestion(id, vehicles, intersections);
    signal.congestionLevel = localDensity;
    signal.timer += deltaTime;

    const currentPhase = signal.phases[signal.currentPhaseIndex];
    if (signal.timer >= currentPhase.duration) {
      signal.timer = 0;
      signal.currentPhaseIndex = (signal.currentPhaseIndex + 1) % signal.phases.length;
    }

    if (inGreenWave && dominantDirection) {
      applyGreenWavePhase(signal, dominantDirection, greenWaveGroup.size);
    }

    if (localDensity > 0.7 && dominantDirection) {
      boostCongestedDirection(signal, densityByDirection, dominantDirection);
    }
  }
}

function countDirectionDensity(vehicles: Map<string, Vehicle>): Record<Direction, number> {
  const counts: Record<Direction, number> = { N: 0, S: 0, E: 0, W: 0 };
  for (const [, v] of vehicles) counts[v.direction]++;
  return counts;
}

function getDominantDirection(density: Record<Direction, number>): Direction | null {
  const ns = density.N + density.S;
  const ew = density.E + density.W;
  if (ns === 0 && ew === 0) return null;
  return ns >= ew ? (density.N >= density.S ? 'N' : 'S') : (density.E >= density.W ? 'E' : 'W');
}

function buildGreenWaveGroup(
  _dominantDirection: Direction | null,
  signals: Map<string, TrafficSignal>,
  _intersections: Map<string, Intersection>
): Set<string> {
  const group = new Set<string>();
  for (const [id] of signals) group.add(id);
  return group;
}

function measureLocalCongestion(
  intersectionId: string,
  vehicles: Map<string, Vehicle>,
  intersections: Map<string, Intersection>
): number {
  const int = intersections.get(intersectionId);
  if (!int) return 0;
  let nearby = 0;
  const threshold = 0.0004;
  for (const [, v] of vehicles) {
    const dlat = v.lat - int.lat;
    const dlng = v.lng - int.lng;
    if (Math.sqrt(dlat * dlat + dlng * dlng) < threshold) nearby++;
  }
  return Math.min(1, nearby / 12);
}

function applyGreenWavePhase(signal: TrafficSignal, direction: Direction): void {
  const isNS = direction === 'N' || direction === 'S';
  if (isNS) {
    for (let i = 0; i < signal.phases.length; i++) {
      const p = signal.phases[i];
      if (p.direction === 'N' || p.direction === 'S') {
        p.duration = p.color === 'GREEN' ? 16 : 2;
      } else {
        p.duration = p.color === 'GREEN' ? 8 : 3;
      }
    }
  } else {
    for (let i = 0; i < signal.phases.length; i++) {
      const p = signal.phases[i];
      if (p.direction === 'E' || p.direction === 'W') {
        p.duration = p.color === 'GREEN' ? 16 : 2;
      } else {
        p.duration = p.color === 'GREEN' ? 8 : 3;
      }
    }
  }
}

function boostCongestedDirection(
  signal: TrafficSignal,
  densityByDirection: Record<Direction, number>,
  dominantDirection: Direction
): void {
  const total = densityByDirection.N + densityByDirection.S + densityByDirection.E + densityByDirection.W;
  if (total === 0) return;
  const nsRatio = (densityByDirection.N + densityByDirection.S) / total;
  const isVertical = dominantDirection === 'N' || dominantDirection === 'S';
  const ratio = isVertical ? nsRatio : (1 - nsRatio);
  const extraGreen = Math.min(6, Math.round(ratio * 8));

  for (let i = 0; i < signal.phases.length; i++) {
    const p = signal.phases[i];
    const isPrimary = (isVertical && (p.direction === 'N' || p.direction === 'S')) ||
                      (!isVertical && (p.direction === 'E' || p.direction === 'W'));
    if (p.color === 'GREEN') {
      p.duration = Math.max(5, (isPrimary ? 12 : 6) + extraGreen - 3);
    } else {
      p.duration = Math.max(2, (isPrimary ? 2 : 3));
    }
  }
}

export function getSignalColorForDirection(
  signal: TrafficSignal,
  approachDirection: Direction,
  vehicleDirection: Direction
): SignalColor {
  const phase = signal.phases[signal.currentPhaseIndex];
  if (phase.direction === approachDirection || phase.direction === oppositeDirection(approachDirection)) {
    if (vehicleDirection === approachDirection || vehicleDirection === oppositeDirection(approachDirection)) {
      return phase.color;
    }
  }
  if (vehicleDirection === turnLeft(approachDirection) || vehicleDirection === turnRight(approachDirection)) {
    if (phase.color === 'GREEN') return 'GREEN';
  }
  return 'RED';
}

export function detectBlockedRoutes(
  vehicles: Map<string, Vehicle>,
  _intersections: Map<string, Intersection>,
  grid: GridConfig
): Set<string> {
  const blocked = new Set<string>();
  const segmentDensity = new Map<string, number>();

  for (const [, v] of vehicles) {
    segmentDensity.set(v.currentSegmentId, (segmentDensity.get(v.currentSegmentId) || 0) + 1);
  }

  for (const [segId, count] of segmentDensity) {
    if (count > MAX_VEHICLES_PER_SEGMENT) {
      blocked.add(segId);
    }
  }

  return blocked;
}
