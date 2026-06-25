export interface GeoPoint {
  lat: number;
  lng: number;
}

export type Direction = 'N' | 'S' | 'E' | 'W';

export type SignalColor = 'RED' | 'YELLOW' | 'GREEN';

export type VehicleType = 'car' | 'truck' | 'bus' | 'emergency';

export interface Intersection {
  id: string;
  row: number;
  col: number;
  lat: number;
  lng: number;
}

export interface RoadSegment {
  id: string;
  fromId: string;
  toId: string;
  direction: Direction;
  from: GeoPoint;
  to: GeoPoint;
  length: number;
}

export interface SignalPhase {
  direction: Direction;
  color: SignalColor;
  duration: number;
}

export interface TrafficSignal {
  intersectionId: string;
  phases: SignalPhase[];
  currentPhaseIndex: number;
  timer: number;
  greenWaveDirection: Direction | null;
  congestionLevel: number;
}

export interface Vehicle {
  id: string;
  type: VehicleType;
  lat: number;
  lng: number;
  direction: Direction;
  speed: number;
  baseSpeed: number;
  currentSegmentId: string;
  targetIntersectionId: string;
  route: string[];
  routeIndex: number;
  color: string;
  length: number;
  width: number;
  stuckTime: number;
  rerouted: boolean;
}

export interface TrafficStats {
  totalVehicles: number;
  avgSpeed: number;
  congestionHotspots: number;
  greenWaveActive: boolean;
  signalCoordinationScore: number;
  blockedRoutes: string[];
}

export interface GridConfig {
  cols: number;
  rows: number;
  centerLat: number;
  centerLng: number;
  latSpacing: number;
  lngSpacing: number;
}

export const DEFAULT_GRID: GridConfig = {
  cols: 12,
  rows: 8,
  centerLat: 40.7484,
  centerLng: -73.9856,
  latSpacing: 0.0012,
  lngSpacing: 0.0009,
};

export const APPROACHING_THRESHOLD = 0.0002;
export const VEHICLE_GAP = 0.00008;
export const INTERSECTION_RADIUS = 0.00025;
export const CLEANUP_DISTANCE = 0.002;
export const SPEED_SCALE = 0.000003;
export const MAX_VEHICLES_PER_SEGMENT = 4;
