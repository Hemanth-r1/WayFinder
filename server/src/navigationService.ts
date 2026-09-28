import type { RoadGraph, TrafficSignal, RouteInfo } from './types.js';
import {
  findRouteOptions, getGraphIndex, routeFromEdgeIds, edgeTravelTime, edgeCapacity, describeRoute,
  type GraphIndex, type RoutingContext,
} from './pathfindingService.js';
import { getSimulationEngine } from './simulationEngine.js';
import {
  startUserSession, getUserSession, updateSessionRoute,
  type DriveMode, type RerouteSuggestion, type UserSession,
} from './userVehicleService.js';
import { isEdgeBlocked, getWeather, type WeatherCondition } from './conditionsService.js';
import { groupForBearing, approachState, waitOnArrival, type ApproachState } from './signalTiming.js';

export interface NavigationRequest {
  userId: string;
  sourceNodeId: string;
  destNodeId: string;
  /** Route the user picked from /api/route; falls back to the recommended route if stale. */
  edgeIds?: string[];
  /** 'gps' when the phone will send positions; otherwise the drive is simulated */
  mode?: DriveMode;
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
  mode: DriveMode;
  /** Better route available now (road block ahead, or faster with live traffic) */
  reroute: RerouteOffer | null;
  /** A road block is ahead and no way around it was found */
  blockedAhead: boolean;
  weather: WeatherCondition;
}

export interface RerouteOffer {
  reason: RerouteSuggestion['reason'];
  savedSeconds: number;
  distance: number;
  estimatedTime: number;
  roadNames: string[];
  geometry: Array<{ lat: number; lng: number }>;
}

export interface PositionResult {
  onRoute: boolean;
  arrived: boolean;
  /** Left the route and a new one was assigned automatically */
  rerouted: boolean;
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
/** Look for a faster route at most this often per user (A* on a city graph isn't free). */
const REROUTE_CHECK_MS = 15000;
/** Suggest a faster route only if it saves at least this much... */
const MIN_REROUTE_SAVING_S = 60;
/** ...and this share of the remaining time. */
const MIN_REROUTE_SAVING_SHARE = 0.1;
/** Consecutive off-route GPS fixes before rerouting (filters GPS jitter). */
const OFF_ROUTE_FIXES = 2;

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
  const { userId, sourceNodeId, destNodeId, edgeIds, mode = 'simulated' } = req;
  const index = getGraphIndex(graph, signals);
  requireNodes(index, sourceNodeId, destNodeId);
  if (!getSimulationEngine()) throw new NavigationError('Simulation engine not initialized', 503);

  const ctx = routingContext(userId);
  const options = findRouteOptions(graph, signals, sourceNodeId, destNodeId, ctx);
  const chosen = (edgeIds && routeFromEdgeIds(index, sourceNodeId, destNodeId, edgeIds, ctx)) || options[0];
  if (!chosen) throw new NavigationError('No route found', 404);

  startUserSession(userId, chosen, mode);

  return {
    path: chosen.geometry,
    distance: chosen.distance,
    duration: chosen.estimatedTime,
    signals: signalsAhead(index, chosen.edgeIds, 0, 0),
    trafficConditions: trafficAlong(index, chosen.edgeIds),
    routeInfo: chosen,
    alternatives: options.filter(o => o.edgeIds.join() !== chosen.edgeIds.join()),
    arrived: false,
    mode,
    reroute: null,
    blockedAhead: false,
    weather: getWeather().condition,
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
      mode: session.mode, reroute: null, blockedAhead: false, weather: getWeather().condition,
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

  const blockedAhead = remainingIds.slice(1).some(isEdgeBlocked);
  refreshRerouteSuggestion(session, index, remainingIds, blockedAhead, graph, signals);
  const suggestion = session.pendingReroute;

  return {
    path,
    distance: Math.max(0, distance),
    duration,
    signals: ahead,
    trafficConditions: trafficAlong(index, remainingIds),
    routeInfo: route,
    alternatives: [],
    arrived: false,
    mode: session.mode,
    reroute: suggestion ? {
      reason: suggestion.reason,
      savedSeconds: suggestion.savedSeconds,
      distance: suggestion.route.distance,
      estimatedTime: suggestion.route.estimatedTime,
      roadNames: suggestion.route.roadNames,
      geometry: suggestion.route.geometry,
    } : null,
    blockedAhead: blockedAhead && !suggestion,
    weather: getWeather().condition,
  };
}

/**
 * Keeps `session.pendingReroute` current. A block ahead is checked every update; a faster
 * route (live traffic, weather, other drivers) at most every REROUTE_CHECK_MS.
 */
function refreshRerouteSuggestion(
  session: UserSession, index: GraphIndex, remainingIds: string[], blockedAhead: boolean,
  graph: RoadGraph, signals: TrafficSignal[],
): void {
  const current = index.edges.get(remainingIds[0]);
  if (!current) return;
  const pending = session.pendingReroute;
  // Drop suggestions made from an edge we have left, or that now cross a block
  if (pending && (pending.fromEdgeId !== current.id || pending.route.edgeIds.some(isEdgeBlocked))) {
    session.pendingReroute = null;
  }
  if (pending?.reason === 'faster' && blockedAhead) session.pendingReroute = null;

  const now = Date.now();
  const due = now - session.lastRerouteCheck >= REROUTE_CHECK_MS;
  const needBlockedAlternative = blockedAhead && session.pendingReroute?.reason !== 'blocked';
  if (!due && !needBlockedAlternative) return;
  session.lastRerouteCheck = now;
  if (remainingIds.length < 2) return;

  const ctx = routingContext(session.userId);
  const best = findRouteOptions(graph, signals, current.to, session.destNodeId, ctx, 1)[0];
  if (!best) return;
  const rest = remainingIds.slice(1);
  if (best.edgeIds.join() === rest.join()) {
    session.pendingReroute = null;
    return;
  }

  if (blockedAhead) {
    session.pendingReroute = { reason: 'blocked', fromEdgeId: current.id, route: best, savedSeconds: 0 };
    return;
  }
  const currentTime = describeRoute(index, current.to, rest, ctx).estimatedTime;
  const saved = currentTime - best.estimatedTime;
  if (saved >= Math.max(MIN_REROUTE_SAVING_S, MIN_REROUTE_SAVING_SHARE * currentTime)) {
    session.pendingReroute = { reason: 'faster', fromEdgeId: current.id, route: best, savedSeconds: saved };
  } else if (session.pendingReroute?.reason === 'faster') {
    session.pendingReroute = null;
  }
}

/** Puts the user on `newEdgeIds` (the first edge is where they are, or where they start). */
function applyRoute(session: UserSession, index: GraphIndex, newEdgeIds: string[]): RouteInfo {
  const first = index.edges.get(newEdgeIds[0])!;
  const route = describeRoute(index, first.from, newEdgeIds, routingContext(session.userId));
  getSimulationEngine()?.replaceUserRoute(session.userId, newEdgeIds);
  updateSessionRoute(session.userId, route);
  return route;
}

/** Accepts the offered reroute (recomputed from the current position if the offer is stale). */
export function acceptReroute(userId: string, graph: RoadGraph, signals: TrafficSignal[]): RouteInfo {
  const session = getUserSession(userId);
  if (!session || !session.isActive) throw new NavigationError('No active navigation', 404);
  const progress = getSimulationEngine()?.getNavigationProgress(userId);
  if (!progress) throw new NavigationError('No active navigation', 404);
  const index = getGraphIndex(graph, signals);
  const currentId = session.route.edgeIds[progress.edgeIndex];
  const current = index.edges.get(currentId)!;

  let next = session.pendingReroute?.fromEdgeId === currentId ? session.pendingReroute.route : null;
  if (!next) {
    next = findRouteOptions(graph, signals, current.to, session.destNodeId, routingContext(userId), 1)[0] ?? null;
  }
  if (!next) throw new NavigationError('No other route available', 404);
  return applyRoute(session, index, [currentId, ...next.edgeIds]);
}

/** A GPS fix from a navigating phone. Leaving the route triggers an automatic reroute. */
export function updatePosition(
  userId: string, lat: number, lng: number, speedKmh: number | undefined,
  graph: RoadGraph, signals: TrafficSignal[],
): PositionResult {
  const session = getUserSession(userId);
  if (!session || !session.isActive) throw new NavigationError('No active navigation', 404);
  const engine = getSimulationEngine();
  const match = engine?.updateUserGps(userId, lat, lng, speedKmh);
  if (!match) throw new NavigationError('No active navigation', 404);
  if (match.arrived || match.onRoute) {
    session.offRouteFixes = 0;
    return { onRoute: match.onRoute, arrived: match.arrived, rerouted: false };
  }

  if (++session.offRouteFixes < OFF_ROUTE_FIXES) return { onRoute: false, arrived: false, rerouted: false };

  // Off the route: plan again from the road nearest the driver
  const index = getGraphIndex(graph, signals);
  let nearest: string | null = null;
  let bestD = Infinity;
  for (const node of index.nodes.values()) {
    if ((index.outEdges.get(node.id)?.length ?? 0) === 0) continue;
    const d = (node.lat - lat) ** 2 + ((node.lng - lng) * Math.cos(lat * Math.PI / 180)) ** 2;
    if (d < bestD) { bestD = d; nearest = node.id; }
  }
  if (!nearest || nearest === session.destNodeId) return { onRoute: false, arrived: false, rerouted: false };
  const next = findRouteOptions(graph, signals, nearest, session.destNodeId, routingContext(userId), 1)[0];
  if (!next) return { onRoute: false, arrived: false, rerouted: false };
  applyRoute(session, index, next.edgeIds);
  engine?.updateUserGps(userId, lat, lng, speedKmh);
  return { onRoute: false, arrived: false, rerouted: true };
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
