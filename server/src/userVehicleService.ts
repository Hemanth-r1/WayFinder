import type { Vehicle, RouteInfo } from './types.js';
import { getSimulationEngine } from './simulationEngine.js';
import { registerUserRoute, releaseUserRoute } from './pathfindingService.js';

export interface UserSession {
  userId: string;
  vehicleId: string;
  sourceNodeId: string;
  destNodeId: string;
  route: RouteInfo;
  startTime: number;
  isActive: boolean;
  arrivedAt: number | null;
}

const sessions = new Map<string, UserSession>();

/**
 * Starts driving `route` for `userId`: spawns their vehicle and registers the route as
 * navigator load so users planning afterwards are spread onto other nearby roads.
 */
export function startUserSession(userId: string, route: RouteInfo): UserSession {
  const engine = getSimulationEngine();
  if (!engine) {
    throw new Error('Simulation engine not initialized');
  }

  const vehicle = engine.addUserVehicle(userId, route.edgeIds);
  if (!vehicle) {
    throw new Error('Failed to create user vehicle');
  }
  registerUserRoute(userId, route.edgeIds);

  const session: UserSession = {
    userId,
    vehicleId: vehicle.id,
    sourceNodeId: route.path[0],
    destNodeId: route.path[route.path.length - 1],
    route,
    startTime: Date.now(),
    isActive: true,
    arrivedAt: null,
  };
  sessions.set(userId, session);
  return session;
}

/** Vehicle reached the destination: stop counting its route as load but keep the session readable. */
export function markArrived(userId: string): void {
  const session = sessions.get(userId);
  releaseUserRoute(userId);
  if (session) {
    session.isActive = false;
    session.arrivedAt = Date.now();
  }
}

export function removeUserVehicle(userId: string): void {
  getSimulationEngine()?.removeUserVehicle(userId);
  releaseUserRoute(userId);
  sessions.delete(userId);
}

export function getUserSession(userId: string): UserSession | undefined {
  return sessions.get(userId);
}

export function getUserVehiclePosition(userId: string): Vehicle | null {
  return getSimulationEngine()?.getUserVehicle(userId) ?? null;
}

export function getAllUserSessions(): UserSession[] {
  return Array.from(sessions.values());
}
