import type { RoadGraph, TrafficSignal, RouteInfo } from './types.js';
import {
  findRouteOptions, getGraphIndex, routeFromEdgeIds, edgeTravelTime, edgeCapacity,
  type GraphIndex, type RoutingContext,
} from './pathfindingService.js';
import { getSimulationEngine } from './simulationEngine.js';
import { startUserSession, getUserSession } from './userVehicleService.js';
import { groupForBearing, approachState, waitOnArrival, type ApproachState } from './signalTiming.js';

export interface NavigationRequest {
  userId: string;
  sourceNodeId: string;
  destNodeId: string;
  /** Route the user picked from /api/route; falls back to the recommended route if stale. */
  edgeIds?: string[];
}

export interface NavigationResponse {
  /** Remaining path geometry, starting at the vehicle */
  path: Array<{ lat: number; lng: number }>;
  /** Remaining metres */
  distance: number;
  /** Remaining seconds */
  duration: number;
  signals: SignalAhead[];
  trafficConditions: TrafficConditions;
  routeInfo: RouteInfo;
  /** Other options that were available when navigation started */
  alternatives: RouteInfo[];
  arrived: boolean;
}

export interface SignalAhead {
  signalId: string;
  position: { lat: number; lng: number };
  distance: number;
  currentState: ApproachState;
  estimatedWait: number;
  estimatedArrival: number;
}

export interface TrafficConditions {
  congestionLevel: number;
  avgSpeed: number;
  vehicleCount: number;
}

/** Signals further than this are not listed as "ahead". */
const SIGNAL_LOOKAHEAD_M = 3000;

export class NavigationError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function routingContext(userId: string | undefined): RoutingContext {
  return { userId, occupancy: getSimulationEngine()?.getOccupancy() };
}

function requireNodes(index: GraphIndex, ...ids: string[]): void {
  for (const id of ids) {
    if (!index.nodes.has(id)) throw new NavigationError(`Unknown node ${id}`, 400);
  }
}

/** Route options for a user, fastest first, accounting for routes other users are driving. */
export function planRoutes(
  userId: string | undefined, sourceNodeId: string, destNodeId: string,
  graph: RoadGraph, signals: TrafficSignal[],
): RouteInfo[] {
  requireNodes(getGraphIndex(graph, signals), sourceNodeId, destNodeId);
  return findRouteOptions(graph, signals, sourceNodeId, destNodeId, routingContext(userId));
}

export function startNavigation(req: NavigationRequest, graph: RoadGraph, signals: TrafficSignal[]): NavigationResponse {
  const { userId, sourceNodeId, destNodeId, edgeIds } = req;
  const index = getGraphIndex(graph, signals);
  requireNodes(index, sourceNodeId, destNodeId);
  if (!getSimulationEngine()) throw new NavigationError('Simulation engine not initialized', 503);

  const ctx = routingContext(userId);
  const options = findRouteOptions(graph, signals, sourceNodeId, destNodeId, ctx);
  const chosen = (edgeIds && routeFromEdgeIds(index, sourceNodeId, destNodeId, edgeIds, ctx)) || options[0];
  if (!chosen) throw new NavigationError('No route found', 404);

  startUserSession(userId, chosen);

  return {
    path: chosen.geometry,
    distance: chosen.distance,
    duration: chosen.estimatedTime,
    signals: signalsAhead(index, chosen.edgeIds, 0, 0),
    trafficConditions: trafficAlong(index, chosen.edgeIds),
    routeInfo: chosen,
    alternatives: options.filter(o => o.edgeIds.join() !== chosen.edgeIds.join()),
    arrived: false,
  };
}

export function getNavigationUpdate(userId: string, graph: RoadGraph, signals: TrafficSignal[]): NavigationResponse | null {
  const session = getUserSession(userId);
  if (!session) return null;
  const index = getGraphIndex(graph, signals);
  const { route } = session;

  if (!session.isActive) {
    return {
      path: [], distance: 0, duration: 0, signals: [],
      trafficConditions: { congestionLevel: 0, avgSpeed: 0, vehicleCount: 0 },
      routeInfo: route, alternatives: [], arrived: true,
    };
  }

  const progress = getSimulationEngine()?.getNavigationProgress(userId);
  if (!progress) return null;

  const remainingIds = route.edgeIds.slice(progress.edgeIndex);
  const ctx = routingContext(userId);
  let distance = -progress.edgeProgress;
  let duration = 0;
  remainingIds.forEach((id, i) => {
    const edge = index.edges.get(id)!;
    distance += edge.length;
    const t = edgeTravelTime(edge, ctx);
    duration += i === 0 ? t * Math.max(0, 1 - progress.edgeProgress / (edge.length || 1)) : t;
  });

  // Geometry from the vehicle's current position onward
  const path = [{ lat: progress.vehicle.lat, lng: progress.vehicle.lng }];
  remainingIds.forEach((id, i) => {
    const geom = index.edges.get(id)!.geometry;
    if (i === 0) {
      path.push(geom[geom.length - 1]);
    } else {
      for (let k = 1; k < geom.length; k++) path.push(geom[k]);
    }
  });

  const ahead = signalsAhead(index, route.edgeIds, progress.edgeIndex, progress.edgeProgress);
  duration += ahead.reduce((s, sig) => s + sig.estimatedWait, 0);

  return {
    path,
    distance: Math.max(0, distance),
    duration,
    signals: ahead,
    trafficConditions: trafficAlong(index, remainingIds),
    routeInfo: route,
    alternatives: [],
    arrived: false,
  };
}

/** Signals at the end of each upcoming edge, with the state shown to our approach. */
function signalsAhead(index: GraphIndex, edgeIds: string[], fromIndex: number, fromProgress: number): SignalAhead[] {
  const result: SignalAhead[] = [];
  let distance = -fromProgress;
  let eta = 0;
  for (let i = fromIndex; i < edgeIds.length - 1; i++) {
    const edge = index.edges.get(edgeIds[i])!;
    const legLength = i === fromIndex ? edge.length - fromProgress : edge.length;
    distance += edge.length;
    eta += legLength / (Math.max(5, edge.speedLimit) / 3.6);
    if (distance > SIGNAL_LOOKAHEAD_M) break;

    const signal = index.signalByNode.get(edge.to);
    if (!signal) continue;
    const group = groupForBearing(edge.bearing);
    const wait = waitOnArrival(signal, group, eta);
    const node = index.nodes.get(edge.to)!;
    result.push({
      signalId: signal.id,
      position: { lat: node.lat, lng: node.lng },
      distance: Math.max(0, distance),
      currentState: approachState(signal, group),
      estimatedWait: wait,
      estimatedArrival: eta,
    });
    eta += wait;
  }
  return result;
}

function trafficAlong(index: GraphIndex, edgeIds: string[]): TrafficConditions {
  const engine = getSimulationEngine();
  const occupancy = engine?.getOccupancy();
  const speeds = engine?.getEdgeSpeeds(edgeIds) ?? new Map<string, number>();
  let congestion = 0, vehicles = 0, speedSum = 0, speedLen = 0, totalLen = 0;
  for (const id of edgeIds) {
    const edge = index.edges.get(id);
    if (!edge) continue;
    const count = occupancy?.get(id) ?? 0;
    vehicles += count;
    congestion += Math.min(1, count / edgeCapacity(edge)) * edge.length;
    speedSum += (speeds.get(id) ?? edge.speedLimit) * edge.length;
    speedLen += edge.length;
    totalLen += edge.length;
  }
  return {
    congestionLevel: totalLen > 0 ? congestion / totalLen : 0,
    avgSpeed: speedLen > 0 ? speedSum / speedLen : 0,
    vehicleCount: vehicles,
  };
}
