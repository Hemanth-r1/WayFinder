/**
 * vehicleSim.ts
 * REQ-V1: Vehicles follow full edge geometry polyline.
 * REQ-V2: Bearing updates per geometry segment.
 * REQ-V3/V4: Lane assignment with perpendicular offset.
 * REQ-V5: Vehicles removed cleanly on reaching destinationNodeId.
 * REQ-V6: Spawn only from edge-of-network nodes.
 * REQ-V7: Lead-vehicle detection is lane-aware.
 * REQ-V8: Stuck vehicles reroute via A* up to 3 times.
 * REQ-V9: All vehicles routed via A*.
 */
import type { Vehicle, VehicleType, TrafficSignal, RoadGraph, GeoPoint } from '../types';
import { VEHICLE_PHYSICS, LANE_WIDTH_DEG } from '../types';
import { VehiclePhysics } from '../utils/physics';
import { aStarRoute } from './pathfinding';
import { getEdgeNodes } from '../data/roadNetwork';
import { haversineMeters, bearingBetween } from '../utils/geo';

let vehicleCounter = 0;

const VEHICLE_COLORS: Record<VehicleType, string[]> = {
  sedan:     ['#2196F3', '#4CAF50', '#FF9800', '#E91E63', '#9C27B0'],
  suv:       ['#1565C0', '#2E7D32', '#E65100'],
  hatchback: ['#03A9F4', '#8BC34A', '#FFC107'],
  truck:     ['#795548', '#5D4037'],
  bus:       ['#FFC107', '#FF9800'],
  emergency: ['#F44336', '#D32F2F'],
  bike:      ['#3F51B5', '#009688'],
  auto:      ['#FF6F00', '#F57F17'],
  van:       ['#455A64', '#37474F'],
};

/** Lane index per vehicle type (0 = leftmost in direction of travel; Bangalore drives on left) */
const PREFERRED_LANE: Record<VehicleType, number> = {
  bike: 0, auto: 0, sedan: 1, hatchback: 1, suv: 1, van: 1, bus: 1, truck: 1, emergency: 0,
};

function rnd(min: number, max: number) { return min + Math.random() * (max - min); }

// ── Geometry helpers ──────────────────────────────────────────────────────────

/** Walk a geometry polyline by `distMeters`, return {lat, lng, bearing, segmentIndex} */
function walkGeometry(geom: GeoPoint[], startSeg: number, startProgress: number, distMeters: number): {
  lat: number; lng: number; bearing: number; segmentIndex: number; edgeProgress: number;
} {
  let remaining = distMeters;
  let seg = startSeg;

  // Total length for edgeProgress computation
  let totalLen = 0;
  const segLengths: number[] = [];
  for (let i = 0; i < geom.length - 1; i++) {
    const l = haversineMeters(geom[i].lat, geom[i].lng, geom[i + 1].lat, geom[i + 1].lng);
    segLengths.push(l);
    totalLen += l;
  }

  // Find starting position within seg
  seg = Math.min(seg, segLengths.length - 1);
  let posInSeg = segLengths[seg] * startProgress;
  let coveredBefore = 0;
  for (let i = 0; i < seg; i++) coveredBefore += segLengths[i];
  coveredBefore += posInSeg;

  while (remaining > 0 && seg < geom.length - 1) {
    const segLen = segLengths[seg];
    const remainingInSeg = segLen - posInSeg;
    if (remaining <= remainingInSeg) {
      posInSeg += remaining;
      remaining = 0;
    } else {
      remaining -= remainingInSeg;
      coveredBefore += remainingInSeg;
      seg++;
      posInSeg = 0;
    }
  }

  if (seg >= geom.length - 1) {
    // End of edge
    const last = geom[geom.length - 1];
    const bear = geom.length >= 2 ? bearingBetween(geom[geom.length - 2].lat, geom[geom.length - 2].lng, last.lat, last.lng) : 0;
    return { lat: last.lat, lng: last.lng, bearing: bear, segmentIndex: geom.length - 2, edgeProgress: 1 };
  }

  const segLen = segLengths[seg];
  const t = segLen > 0 ? posInSeg / segLen : 0;
  const a = geom[seg]; const b = geom[seg + 1];
  const lat = a.lat + (b.lat - a.lat) * t;
  const lng = a.lng + (b.lng - a.lng) * t;
  const bearing = bearingBetween(a.lat, a.lng, b.lat, b.lng);

  // Compute edgeProgress cleanly
  let dist = 0;
  for (let i = 0; i < seg; i++) dist += segLengths[i];
  dist += posInSeg;

  return { lat, lng, bearing, segmentIndex: seg, edgeProgress: totalLen > 0 ? Math.min(1, dist / totalLen) : 0 };
}

/** Apply perpendicular lane offset to a lat/lng given bearing */
function applyLaneOffset(lat: number, lng: number, bearing: number, laneIndex: number): { lat: number; lng: number } {
  // Perpendicular to bearing = bearing + 90 (left side = leftmost lane = lane 0)
  const perpRad = (bearing + 90) * Math.PI / 180;
  const offsetLat = Math.sin(perpRad) * LANE_WIDTH_DEG.lat * (laneIndex + 0.5);
  const offsetLng = Math.cos(perpRad) * LANE_WIDTH_DEG.lng * (laneIndex + 0.5);
  return { lat: lat + offsetLat, lng: lng + offsetLng };
}

// ── Vehicle creation ──────────────────────────────────────────────────────────

export function createVehicle(
  type: VehicleType,
  startNodeId: string,
  destinationNodeId: string,
  route: string[],
  graph: RoadGraph,
): Vehicle | null {
  const startNode = graph.nodes.get(startNodeId);
  if (!startNode || route.length < 2) return null;
  const nextNodeId = route[1];
  const edges = graph.adjacency.get(startNodeId) || [];
  const firstEdge = edges.find(e => e.to === nextNodeId);
  if (!firstEdge) return null;

  const physics = VEHICLE_PHYSICS[type];
  const colors = VEHICLE_COLORS[type];
  const agg = rnd(0.7, 1.1);
  const preferredLane = PREFERRED_LANE[type];
  const laneIndex = Math.min(preferredLane, firstEdge.lanes - 1);

  vehicleCounter++;
  return {
    id: `v${vehicleCounter}`, type,
    lat: startNode.lat, lng: startNode.lng,
    bearing: firstEdge.geometry.length >= 2
      ? bearingBetween(firstEdge.geometry[0].lat, firstEdge.geometry[0].lng, firstEdge.geometry[1].lat, firstEdge.geometry[1].lng)
      : firstEdge.bearing,
    speed: physics.maxSpeed * 0.4 * agg,
    targetSpeed: Math.min(physics.maxSpeed * agg, firstEdge.speedLimit),
    acceleration: physics.acceleration * agg,
    deceleration: physics.deceleration,
    currentEdgeId: firstEdge.id, edgeProgress: 0, targetNodeId: nextNodeId,
    destinationNodeId,
    route, routeIndex: 0,
    color: colors[Math.floor(Math.random() * colors.length)],
    length: physics.length, width: physics.width,
    stuckTime: 0, rerouted: false,
    responseDelay: rnd(physics.responseDelay[0], physics.responseDelay[1]),
    reactionTimer: 0, waitingForSignal: false, driverAggression: agg, routeETA: 0,
    laneIndex, segmentIndex: 0,
  };
}

// ── Lead vehicle (lane-aware, REQ-V7) ────────────────────────────────────────

function findLeadVehicle(vehicle: Vehicle, allVehicles: Map<string, Vehicle>): Vehicle | null {
  let closest: Vehicle | null = null; let closestDist = Infinity;
  for (const [, other] of allVehicles) {
    if (other.id === vehicle.id) continue;
    if (other.currentEdgeId !== vehicle.currentEdgeId) continue;
    if (other.laneIndex !== vehicle.laneIndex) continue; // REQ-V7: lane-aware
    if (other.edgeProgress <= vehicle.edgeProgress) continue; // must be ahead
    const dist = haversineMeters(vehicle.lat, vehicle.lng, other.lat, other.lng);
    if (dist < closestDist && dist < 80) { closestDist = dist; closest = other; }
  }
  return closest;
}

// ── Signal check ──────────────────────────────────────────────────────────────

/** Map vehicle bearing to NS or EW group */
function bearingToGroup(bearing: number): 'NS' | 'EW' {
  // Bearing 0 = N, 90 = E, 180 = S, 270 = W
  // Vehicle moving N/S → NS group, moving E/W → EW group
  const norm = ((bearing % 360) + 360) % 360;
  if (norm > 315 || norm <= 45) return 'NS';  // moving N
  if (norm > 135 && norm <= 225) return 'NS';  // moving S
  return 'EW';  // moving E or W
}

function checkCanProceed(vehicle: Vehicle, signal: TrafficSignal | undefined): boolean {
  if (!signal) return true;
  const phase = signal.phases[signal.currentPhaseIndex];

  // Check if vehicle's travel axis matches the active phase group
  const vehicleGroup = bearingToGroup(vehicle.bearing);
  const matchesGroup = phase.group === vehicleGroup;

  if (phase.color === 'GREEN' && matchesGroup) return true;

  // YELLOW: stop if not already past stop line (85% edge progress)
  if (phase.color === 'YELLOW' && matchesGroup && vehicle.edgeProgress <= 0.85) return false;

  // RED: stop regardless (unless past stop line during transition)
  if (phase.color === 'RED' && vehicle.edgeProgress <= 0.85) return false;

  // If phase doesn't match vehicle group (e.g., EW phase, NS vehicle), stop
  if (!matchesGroup && vehicle.edgeProgress <= 0.85) return false;

  // Already past stop line → clear the intersection
  return true;
}

// ── Main update ───────────────────────────────────────────────────────────────

export function updateVehicle(
  vehicle: Vehicle,
  deltaTime: number,
  graph: RoadGraph,
  signals: Map<string, TrafficSignal>,
  allVehicles: Map<string, Vehicle>,
): boolean {
  const edge = graph.edges.get(vehicle.currentEdgeId);
  if (!edge) return false;

  // Destination reached
  if (vehicle.targetNodeId === vehicle.destinationNodeId && vehicle.edgeProgress >= 0.98) {
    return false; // Clean removal REQ-V5
  }

  const signal = signals.get(vehicle.targetNodeId);

  // Signal stop
  if (!checkCanProceed(vehicle, signal)) {
    vehicle.reactionTimer += deltaTime;
    if (vehicle.reactionTimer >= vehicle.responseDelay) {
      vehicle.waitingForSignal = true;
      vehicle.speed = Math.max(0, vehicle.speed - vehicle.deceleration * 1.5 * deltaTime);
      vehicle.stuckTime += deltaTime;
    }
    return true;
  }

  vehicle.waitingForSignal = false; vehicle.reactionTimer = 0;
  vehicle.stuckTime = Math.max(0, vehicle.stuckTime - deltaTime * 0.5);

  // Stuck rerouting (REQ-V8)
  if (vehicle.stuckTime > 10 && !vehicle.rerouted) {
    const currentNode = vehicle.route[vehicle.routeIndex];
    const result = aStarRoute(graph, currentNode, vehicle.destinationNodeId, signals);
    if (result && result.path.length >= 2) {
      vehicle.route = result.path;
      vehicle.routeIndex = 0;
      vehicle.rerouted = true;
      vehicle.stuckTime = 0;
    } else {
      return false; // Can't reroute — remove
    }
  }

  // IDM acceleration
  const lead = findLeadVehicle(vehicle, allVehicles);
  const physics = VEHICLE_PHYSICS[vehicle.type];
  let accel: number;

  if (lead) {
    const dist = haversineMeters(vehicle.lat, vehicle.lng, lead.lat, lead.lng);
    const safeDist = VehiclePhysics.getSafeDistance(vehicle.speed / 3.6) * 3;
    const dv = (vehicle.speed - lead.speed) / 3.6;
    if (dist < safeDist * 0.4) {
      accel = -physics.deceleration * 2;
    } else {
      accel = VehiclePhysics.calculateAcceleration(
        vehicle.speed / 3.6, Math.max(dist, 1), dv,
        vehicle.targetSpeed / 3.6, 1.0, physics.acceleration, physics.deceleration * 0.8, 2.0,
      );
    }
  } else {
    const desired = vehicle.targetSpeed / 3.6; const current = vehicle.speed / 3.6;
    accel = current < desired
      ? physics.acceleration * (1 - Math.pow(current / desired, 4))
      : -physics.deceleration * 0.3;
  }

  vehicle.speed = Math.max(0, Math.min(vehicle.targetSpeed * 1.1, vehicle.speed + accel * deltaTime * 3.6));
  const moveDist = (vehicle.speed / 3.6) * deltaTime;

  // Walk geometry (REQ-V1, REQ-V2)
  const geom = edge.geometry;
  if (!geom || geom.length < 2) {
    // Fallback linear interpolation for edges without geometry
    vehicle.edgeProgress += moveDist / Math.max(edge.length, 1);
    if (vehicle.edgeProgress >= 1) return advanceToNextEdge(vehicle, graph, signals);
    const f = graph.nodes.get(edge.from); const t = graph.nodes.get(edge.to);
    if (f && t) {
      vehicle.lat = f.lat + (t.lat - f.lat) * vehicle.edgeProgress;
      vehicle.lng = f.lng + (t.lng - f.lng) * vehicle.edgeProgress;
    }
    return true;
  }

  const walked = walkGeometry(geom, vehicle.segmentIndex, 0, moveDist);
  // Recompute properly: use total distance covered
  const totalCovered = vehicle.edgeProgress * edge.length + moveDist;
  const newProgress = totalCovered / Math.max(edge.length, 1);

  if (newProgress >= 1 || walked.edgeProgress >= 1) {
    return advanceToNextEdge(vehicle, graph, signals);
  }

  vehicle.edgeProgress = newProgress;
  vehicle.segmentIndex = walked.segmentIndex;
  vehicle.bearing = walked.bearing;

  // Apply lane offset (REQ-V4)
  const offset = applyLaneOffset(walked.lat, walked.lng, walked.bearing, vehicle.laneIndex);
  vehicle.lat = offset.lat;
  vehicle.lng = offset.lng;

  return true;
}

function advanceToNextEdge(vehicle: Vehicle, graph: RoadGraph, signals: Map<string, TrafficSignal>): boolean {
  vehicle.routeIndex++;
  if (vehicle.routeIndex >= vehicle.route.length - 1) return false;

  const currentId = vehicle.route[vehicle.routeIndex];
  const nextId = vehicle.route[vehicle.routeIndex + 1];
  const edges = graph.adjacency.get(currentId) || [];
  const nextEdge = edges.find(e => e.to === nextId);
  if (!nextEdge) return false;

  vehicle.currentEdgeId = nextEdge.id;
  vehicle.targetNodeId = nextId;
  vehicle.edgeProgress = 0;
  vehicle.segmentIndex = 0;
  vehicle.waitingForSignal = false;
  vehicle.reactionTimer = 0;

  // Update lane for new edge (stay in preferred lane, capped to lane count)
  vehicle.laneIndex = Math.min(PREFERRED_LANE[vehicle.type], nextEdge.lanes - 1);
  vehicle.targetSpeed = Math.min(VEHICLE_PHYSICS[vehicle.type].maxSpeed * vehicle.driverAggression, nextEdge.speedLimit);

  // Update bearing from first geometry segment
  if (nextEdge.geometry.length >= 2) {
    vehicle.bearing = bearingBetween(nextEdge.geometry[0].lat, nextEdge.geometry[0].lng, nextEdge.geometry[1].lat, nextEdge.geometry[1].lng);
  }

  const fromNode = graph.nodes.get(currentId);
  if (fromNode) { vehicle.lat = fromNode.lat; vehicle.lng = fromNode.lng; }

  // Update signal check
  const signal = signals.get(nextId);
  if (signal) {
    const phase = signal.phases[signal.currentPhaseIndex];
    vehicle.waitingForSignal = phase.color === 'RED';
  }

  return true;
}

// ── Spawning ─────────────────────────────────────────────────────────────────

export function spawnRandomVehicle(
  graph: RoadGraph,
  signals: Map<string, TrafficSignal>,
): Vehicle | null {
  const edgeNodeIds = getEdgeNodes(graph.adjacency); // REQ-V6: only edge nodes
  if (edgeNodeIds.length < 2) return null;

  const types: VehicleType[] = ['sedan', 'sedan', 'sedan', 'suv', 'hatchback', 'bus', 'truck', 'bike', 'bike', 'auto', 'van'];
  const type = types[Math.floor(Math.random() * types.length)];

  for (let attempt = 0; attempt < 20; attempt++) {
    const startId = edgeNodeIds[Math.floor(Math.random() * edgeNodeIds.length)];
    const startNode = graph.nodes.get(startId); if (!startNode) continue;

    // Pick a destination that is also an edge node, far enough away
    const candidates = edgeNodeIds.filter(id => {
      const n = graph.nodes.get(id); if (!n || id === startId) return false;
      const d = Math.sqrt((startNode.lat - n.lat) ** 2 + (startNode.lng - n.lng) ** 2);
      return d > 0.003 && d < 0.05;
    });
    if (candidates.length === 0) continue;

    const endId = candidates[Math.floor(Math.random() * candidates.length)];
    const routeInfo = aStarRoute(graph, startId, endId, signals); // REQ-V9: A*
    if (routeInfo && routeInfo.path.length >= 3) {
      return createVehicle(type, startId, endId, routeInfo.path, graph);
    }
  }
  return null;
}

export function spawnVehicleAt(
  graph: RoadGraph,
  startId: string,
  type: VehicleType,
  signals: Map<string, TrafficSignal>,
): Vehicle | null {
  const startNode = graph.nodes.get(startId); if (!startNode) return null;
  const edgeNodeIds = getEdgeNodes(graph.adjacency);
  const candidates = edgeNodeIds.filter(id => {
    const n = graph.nodes.get(id); if (!n || id === startId) return false;
    const d = Math.sqrt((startNode.lat - n.lat) ** 2 + (startNode.lng - n.lng) ** 2);
    return d > 0.003;
  });
  if (candidates.length === 0) return null;
  const endId = candidates[Math.floor(Math.random() * candidates.length)];
  const routeInfo = aStarRoute(graph, startId, endId, signals);
  if (routeInfo && routeInfo.path.length >= 2) {
    return createVehicle(type, startId, endId, routeInfo.path, graph);
  }
  return null;
}

/** Spawn a vehicle that follows a user-chosen origin → destination route */
export function spawnNavigatedVehicle(
  graph: RoadGraph,
  sourceId: string,
  destId: string,
  signals: Map<string, TrafficSignal>,
): Vehicle | null {
  const routeInfo = aStarRoute(graph, sourceId, destId, signals);
  if (!routeInfo || routeInfo.path.length < 2) return null;

  const type: VehicleType = 'sedan';
  const vehicle = createVehicle(type, sourceId, destId, routeInfo.path, graph);
  if (!vehicle) return null;

  vehicle.isNavigated = true;
  vehicle.color = '#4488FF';
  return vehicle;
}
