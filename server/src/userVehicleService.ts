import type { Vehicle, RoadGraph, TrafficSignal } from './types.js';
import { getSimulationEngine } from './simulationEngine.js';

interface UserVehicle {
  userId: string;
  vehicleId: string;
  sourceNodeId: string;
  destNodeId: string;
  route: string[];
  routeIndex: number;
  startTime: number;
  isActive: boolean;
}

const userVehicles = new Map<string, UserVehicle>();

export function addUserVehicle(
  userId: string,
  sourceNodeId: string,
  destNodeId: string,
  route: string[],
): UserVehicle {
  const engine = getSimulationEngine();
  if (!engine) {
    throw new Error('Simulation engine not initialized');
  }

  const vehicle = engine.addUserVehicle(userId, sourceNodeId, destNodeId);
  if (!vehicle) {
    throw new Error('Failed to create user vehicle');
  }

  const userVehicle: UserVehicle = {
    userId,
    vehicleId: vehicle.id,
    sourceNodeId,
    destNodeId,
    route,
    routeIndex: 0,
    startTime: Date.now(),
    isActive: true,
  };

  userVehicles.set(userId, userVehicle);
  return userVehicle;
}

export function removeUserVehicle(userId: string): void {
  const engine = getSimulationEngine();
  if (engine) {
    engine.removeUserVehicle(userId);
  }
  userVehicles.delete(userId);
}

export function getUserVehicle(userId: string): UserVehicle | undefined {
  return userVehicles.get(userId);
}

export function getUserVehiclePosition(userId: string): Vehicle | null {
  const engine = getSimulationEngine();
  if (!engine) return null;
  
  const vehicle = engine.getUserVehicle(userId);
  return vehicle || null;
}

export function getAllUserVehicles(): UserVehicle[] {
  return Array.from(userVehicles.values());
}

export function updateUserRoute(userId: string, route: string[]): void {
  const userVehicle = userVehicles.get(userId);
  if (userVehicle) {
    userVehicle.route = route;
    userVehicle.routeIndex = 0;
  }
}

export function isUserActive(userId: string): boolean {
  const userVehicle = userVehicles.get(userId);
  return userVehicle?.isActive ?? false;
}
