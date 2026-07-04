export interface GeoPoint { lat: number; lng: number; }
export type Direction = 'N' | 'S' | 'E' | 'W';
export type SignalColor = 'RED' | 'YELLOW' | 'GREEN';
export type VehicleType = 'sedan' | 'suv' | 'hatchback' | 'truck' | 'bus' | 'emergency' | 'bike' | 'auto' | 'van';
export type RoadType = 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'residential';

export interface RoadNode {
  id: string; lat: number; lng: number; isIntersection: boolean; trafficSignalId?: string;
}
export interface RoadEdge {
  id: string; from: string; to: string; roadType: RoadType; speedLimit: number;
  lanes: number; length: number; bearing: number; name?: string; congestionWeight: number;
  /** Full OSM geometry polyline — index 0 = from-node, last = to-node */
  geometry: GeoPoint[];
  /** True for one-way roads — no reverse edge exists */
  oneway: boolean;
}
export interface RoadGraph {
  nodes: Map<string, RoadNode>; edges: Map<string, RoadEdge>; adjacency: Map<string, RoadEdge[]>;
}

/** Per-approach signal state (derived from actual edge bearings at the intersection) */
export interface SignalApproach {
  edgeId: string;
  bearing: number;
  color: SignalColor;
  duration: number;
}

export interface SignalPhase { group: 'NS' | 'EW'; color: SignalColor; duration: number; yellowDuration: number; }
export interface TrafficSignal {
  id: string; nodeId: string; phases: SignalPhase[]; currentPhaseIndex: number;
  timer: number; cycleLength: number; offset: number;
  greenWaveDirection: Direction | null; congestionLevel: number; adaptiveTiming: boolean;
  /** Geometry-aware per-approach states (REQ-S1) */
  approaches: SignalApproach[];
}
export interface Vehicle {
  id: string; type: VehicleType; lat: number; lng: number; bearing: number;
  speed: number; targetSpeed: number; acceleration: number; deceleration: number;
  currentEdgeId: string; edgeProgress: number; targetNodeId: string;
  /** Explicit destination — vehicle removed when it reaches this node */
  destinationNodeId: string;
  route: string[]; routeIndex: number; color: string; length: number; width: number;
  stuckTime: number; rerouted: boolean; responseDelay: number; reactionTimer: number;
  waitingForSignal: boolean; driverAggression: number; routeETA: number;
  /** Lane index (0 = leftmost in direction of travel) */
  laneIndex: number;
  /** Segment index within current edge geometry */
  segmentIndex: number;
  /** True if this vehicle was spawned by a user navigation request */
  isNavigated?: boolean;
}
export interface TrafficStats {
  totalVehicles: number; avgSpeed: number; avgDelay: number; congestionHotspots: number;
  greenWaveActive: boolean; signalCoordinationScore: number; throughput: number; maxCongestion: number;
}
export interface RouteInfo {
  path: string[]; distance: number; estimatedTime: number; signalCount: number;
  avgCongestion: number; roadNames: string[];
}
export interface NavigationRequest {
  sourceNodeId: string; destNodeId: string; avoidCongestion: boolean; preferMainRoads: boolean;
}
export interface CongestionZone {
  centerLat: number; centerLng: number; radius: number; level: number;
  vehicles: number; trend: 'increasing' | 'stable' | 'decreasing';
}

/** Signal plan produced by the network optimizer */
export interface SignalPlanEntry {
  signalId: string;
  greenNS: number;   // seconds
  greenEW: number;   // seconds
  offset: number;    // seconds
  cycleLength: number;
}
export interface OptimizationResult {
  plan: SignalPlanEntry[];
  estimatedDelay: number;   // total vehicle-seconds
  baselineDelay: number;
  improvement: number;      // fraction 0–1
  iterationsRun: number;
  elapsedMs: number;
}

export const VEHICLE_PHYSICS: Record<VehicleType, {
  maxSpeed: number; acceleration: number; deceleration: number;
  length: number; width: number; responseDelay: [number, number];
}> = {
  sedan:     { maxSpeed: 50, acceleration: 2.8, deceleration: 4.5, length: 4.5, width: 1.8, responseDelay: [0.7, 1.3] },
  suv:       { maxSpeed: 48, acceleration: 2.2, deceleration: 4.0, length: 5.0, width: 2.0, responseDelay: [0.8, 1.4] },
  hatchback: { maxSpeed: 45, acceleration: 3.0, deceleration: 5.0, length: 4.0, width: 1.7, responseDelay: [0.6, 1.2] },
  truck:     { maxSpeed: 35, acceleration: 1.2, deceleration: 3.0, length: 12,  width: 2.5, responseDelay: [1.0, 2.0] },
  bus:       { maxSpeed: 40, acceleration: 1.5, deceleration: 3.5, length: 10,  width: 2.4, responseDelay: [0.9, 1.8] },
  emergency: { maxSpeed: 70, acceleration: 3.5, deceleration: 5.0, length: 5.5, width: 2.0, responseDelay: [0.3, 0.6] },
  bike:      { maxSpeed: 55, acceleration: 3.5, deceleration: 5.5, length: 2.2, width: 0.8, responseDelay: [0.5, 0.9] },
  auto:      { maxSpeed: 35, acceleration: 2.0, deceleration: 4.0, length: 3.0, width: 1.5, responseDelay: [0.7, 1.3] },
  van:       { maxSpeed: 42, acceleration: 1.8, deceleration: 3.5, length: 6.0, width: 2.2, responseDelay: [0.8, 1.5] },
};

export const SIGNAL_TIMING = {
  minGreen: 8, maxGreen: 45, yellowDuration: 5, allRedDuration: 2, lostTimePerPhase: 2, criticalGap: 2.0,
};

/** Lane width in degrees (≈3.5m at Bangalore latitude) */
export const LANE_WIDTH_DEG = { lat: 0.0000315, lng: 0.0000350 };
