import type { Vehicle, VehicleType, TrafficSignal, RoadGraph } from '../types';
import { VEHICLE_PHYSICS } from '../types';
import { VehiclePhysics } from '../utils/physics';

let vehicleCounter = 0;

const VEHICLE_COLORS: Record<VehicleType, string[]> = {
  sedan: ['#2196F3', '#4CAF50', '#FF9800', '#E91E63', '#9C27B0', '#00BCD4', '#607D8B'],
  suv: ['#1565C0', '#2E7D32', '#E65100', '#AD1457', '#4527A0'],
  hatchback: ['#03A9F4', '#8BC34A', '#FFC107', '#FF5722', '#673AB7'],
  truck: ['#795548', '#5D4037', '#4E342E'],
  bus: ['#FFC107', '#FF9800', '#F57F17'],
  emergency: ['#F44336', '#D32F2F', '#B71C1C'],
  bike: ['#3F51B5', '#009688', '#00BCD4', '#795548'],
  auto: ['#FF6F00', '#F57F17', '#FFA000'],
  van: ['#455A64', '#37474F', '#546E7A'],
};

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function createVehicle(
  type: VehicleType,
  startNodeId: string,
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
  const responseDelay = randomInRange(physics.responseDelay[0], physics.responseDelay[1]);
  const driverAggression = randomInRange(0.7, 1.1);

  vehicleCounter++;

  return {
    id: `v${vehicleCounter}`,
    type,
    lat: startNode.lat,
    lng: startNode.lng,
    bearing: firstEdge.bearing,
    speed: physics.maxSpeed * 0.4 * driverAggression,
    targetSpeed: Math.min(physics.maxSpeed * driverAggression, firstEdge.speedLimit),
    acceleration: physics.acceleration * driverAggression,
    deceleration: physics.deceleration,
    currentEdgeId: firstEdge.id,
    edgeProgress: 0,
    targetNodeId: nextNodeId,
    route,
    routeIndex: 0,
    color: colors[Math.floor(Math.random() * colors.length)],
    length: physics.length,
    width: physics.width,
    stuckTime: 0,
    rerouted: false,
    responseDelay,
    reactionTimer: 0,
    waitingForSignal: false,
    driverAggression,
    routeETA: 0,
  };
}

export function updateVehicle(
  vehicle: Vehicle,
  deltaTime: number,
  graph: RoadGraph,
  signals: Map<string, TrafficSignal>,
  allVehicles: Map<string, Vehicle>,
): boolean {
  const edge = graph.edges.get(vehicle.currentEdgeId);
  if (!edge) return false;

  const targetNode = graph.nodes.get(vehicle.targetNodeId);
  if (!targetNode) return false;

  const signal = signals.get(vehicle.targetNodeId);
  const canProceed = checkCanProceed(vehicle, signal, allVehicles);

  if (!canProceed) {
    vehicle.reactionTimer += deltaTime;
    if (vehicle.reactionTimer < vehicle.responseDelay) {
      return true;
    }
    vehicle.waitingForSignal = true;
    const brakingDecel = vehicle.deceleration * 1.5;
    vehicle.speed = Math.max(0, vehicle.speed - brakingDecel * deltaTime);
    vehicle.stuckTime += deltaTime;
    return true;
  }

  vehicle.waitingForSignal = false;
  vehicle.reactionTimer = 0;
  vehicle.stuckTime = Math.max(0, vehicle.stuckTime - deltaTime * 0.5);

  const leadVehicle = findLeadVehicle(vehicle, allVehicles);
  const physics = VEHICLE_PHYSICS[vehicle.type];

  let accel: number;
  if (leadVehicle) {
    const dist = haversineMeters(vehicle.lat, vehicle.lng, leadVehicle.lat, leadVehicle.lng);
    const safeDist = VehiclePhysics.getSafeDistance(vehicle.speed / 3.6) * 3;
    const dv = (vehicle.speed - leadVehicle.speed) / 3.6;

    if (dist < safeDist * 0.5) {
      accel = -physics.deceleration * 2;
    } else {
      accel = VehiclePhysics.calculateAcceleration(
        vehicle.speed / 3.6,
        Math.max(dist, 1),
        dv,
        vehicle.targetSpeed / 3.6,
        1.0,
        physics.acceleration,
        physics.deceleration * 0.8,
        2.0,
      );
    }
  } else {
    const desiredSpeed = vehicle.targetSpeed / 3.6;
    const currentSpeed = vehicle.speed / 3.6;
    if (currentSpeed < desiredSpeed) {
      accel = physics.acceleration * (1 - Math.pow(currentSpeed / desiredSpeed, 4));
    } else {
      accel = -physics.deceleration * 0.5;
    }
  }

  const newSpeed = vehicle.speed + accel * deltaTime * 3.6;
  vehicle.speed = Math.max(0, Math.min(vehicle.targetSpeed * 1.1, newSpeed));

  const speedMs = vehicle.speed / 3.6;
  const moveDistance = speedMs * deltaTime;
  const edgeLength = edge.length;

  if (edgeLength <= 0) return false;

  const progressIncrement = moveDistance / edgeLength;
  vehicle.edgeProgress += progressIncrement;

  if (vehicle.edgeProgress >= 1) {
    return advanceToNextEdge(vehicle, graph);
  }

  const fromNode = graph.nodes.get(edge.from);
  const toNode = graph.nodes.get(edge.to);
  if (!fromNode || !toNode) return false;

  vehicle.lat = fromNode.lat + (toNode.lat - fromNode.lat) * vehicle.edgeProgress;
  vehicle.lng = fromNode.lng + (toNode.lng - fromNode.lng) * vehicle.edgeProgress;
  vehicle.bearing = edge.bearing;

  return true;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

function findLeadVehicle(vehicle: Vehicle, allVehicles: Map<string, Vehicle>): Vehicle | null {
  let closest: Vehicle | null = null;
  let closestDist = Infinity;

  for (const [, other] of allVehicles) {
    if (other.id === vehicle.id) continue;
    if (other.currentEdgeId !== vehicle.currentEdgeId) continue;

    const bearingDiff = Math.abs(vehicle.bearing - other.bearing);
    const normalizedDiff = bearingDiff > 180 ? 360 - bearingDiff : bearingDiff;
    if (normalizedDiff > 30) continue;

    const dist = haversineMeters(vehicle.lat, vehicle.lng, other.lat, other.lng);
    const dlat = other.lat - vehicle.lat;
    const dlng = other.lng - vehicle.lng;
    const angleToOther = Math.atan2(dlng, dlat) * 180 / Math.PI;
    const bearingToOther = ((angleToOther % 360) + 360) % 360;
    const relBearing = Math.abs(bearingToOther - vehicle.bearing);
    const isAhead = relBearing < 90 || relBearing > 270;

    if (isAhead && dist < closestDist && dist < 100) {
      closestDist = dist;
      closest = other;
    }
  }

  return closest;
}

function checkCanProceed(
  vehicle: Vehicle,
  signal: TrafficSignal | undefined,
  allVehicles: Map<string, Vehicle>,
): boolean {
  if (signal) {
    const phase = signal.phases[signal.currentPhaseIndex];
    if (phase.color === 'RED' || phase.color === 'YELLOW') {
      if (vehicle.edgeProgress > 0.8) return true;
      return false;
    }
  }

  const lead = findLeadVehicle(vehicle, allVehicles);
  if (lead) {
    const dist = haversineMeters(vehicle.lat, vehicle.lng, lead.lat, lead.lng);
    const safeDist = VehiclePhysics.getSafeDistance(vehicle.speed / 3.6) * 2;
    if (dist < safeDist * 0.4) return false;
  }

  return true;
}

function advanceToNextEdge(vehicle: Vehicle, graph: RoadGraph): boolean {
  vehicle.routeIndex++;
  if (vehicle.routeIndex >= vehicle.route.length - 1) {
    return false;
  }

  const currentId = vehicle.route[vehicle.routeIndex];
  const nextId = vehicle.route[vehicle.routeIndex + 1];

  const edges = graph.adjacency.get(currentId) || [];
  const nextEdge = edges.find(e => e.to === nextId);
  if (!nextEdge) return false;

  vehicle.currentEdgeId = nextEdge.id;
  vehicle.targetNodeId = nextId;
  vehicle.edgeProgress = 0;
  vehicle.bearing = nextEdge.bearing;
  vehicle.waitingForSignal = false;
  vehicle.reactionTimer = 0;

  const fromNode = graph.nodes.get(currentId);
  if (fromNode) {
    vehicle.lat = fromNode.lat;
    vehicle.lng = fromNode.lng;
  }

  return true;
}

export function spawnRandomVehicle(
  graph: RoadGraph,
  _signals: Map<string, TrafficSignal>,
): Vehicle | null {
  const nodeIds = Array.from(graph.nodes.keys());
  const edgeNodes = nodeIds.filter(id => {
    const adj = graph.adjacency.get(id) || [];
    return adj.length < 4 && adj.length > 0;
  });

  if (edgeNodes.length === 0) return null;

  const types: VehicleType[] = ['sedan', 'sedan', 'sedan', 'sedan', 'suv', 'suv', 'hatchback', 'bus', 'truck', 'bike', 'auto', 'van', 'emergency'];
  const type = types[Math.floor(Math.random() * types.length)];

  for (let attempt = 0; attempt < 15; attempt++) {
    const startId = edgeNodes[Math.floor(Math.random() * edgeNodes.length)];
    const startNode = graph.nodes.get(startId);
    if (!startNode) continue;

    const candidates = nodeIds.filter(id => {
      const n = graph.nodes.get(id);
      if (!n) return false;
      const d = Math.sqrt(Math.pow(startNode.lat - n.lat, 2) + Math.pow(startNode.lng - n.lng, 2));
      return d > 0.002 && d < 0.012 && id !== startId;
    });

    if (candidates.length === 0) continue;
    const endId = candidates[Math.floor(Math.random() * candidates.length)];

    const route = findBFSRoute(graph, startId, endId);
    if (route && route.length >= 3) {
      return createVehicle(type, startId, route, graph);
    }
  }

  return null;
}

export function spawnVehicleAt(
  graph: RoadGraph,
  startId: string,
  type: VehicleType,
): Vehicle | null {
  const startNode = graph.nodes.get(startId);
  if (!startNode) return null;

  const nodeIds = Array.from(graph.nodes.keys());
  const candidates = nodeIds.filter(id => {
    const n = graph.nodes.get(id);
    if (!n) return false;
    const d = Math.sqrt(Math.pow(startNode.lat - n.lat, 2) + Math.pow(startNode.lng - n.lng, 2));
    return d > 0.003 && id !== startId;
  });

  if (candidates.length === 0) return null;
  const endId = candidates[Math.floor(Math.random() * candidates.length)];
  const route = findBFSRoute(graph, startId, endId);
  if (route && route.length >= 2) {
    return createVehicle(type, startId, route, graph);
  }
  return null;
}

function findBFSRoute(graph: RoadGraph, startId: string, endId: string): string[] | null {
  const visited = new Set<string>();
  const parent = new Map<string, string | null>();
  const queue = [startId];
  visited.add(startId);
  parent.set(startId, null);

  let iterations = 0;
  while (queue.length > 0 && iterations < 500) {
    iterations++;
    const current = queue.shift()!;
    if (current === endId) {
      const path: string[] = [];
      let node: string | null = current;
      while (node !== null) {
        path.unshift(node);
        node = parent.get(node) ?? null;
      }
      return path;
    }
    const neighbors = graph.adjacency.get(current) || [];
    for (const edge of neighbors) {
      if (!visited.has(edge.to)) {
        visited.add(edge.to);
        parent.set(edge.to, current);
        queue.push(edge.to);
      }
    }
  }
  return null;
}
