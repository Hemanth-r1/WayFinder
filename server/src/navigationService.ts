import type { RoadGraph, TrafficSignal, Vehicle, RouteInfo } from './types.js';
import { findRoute } from './pathfindingService.js';
import { getSimulationEngine } from './simulationEngine.js';

export interface NavigationRequest {
  userId: string;
  sourceNodeId: string;
  destNodeId: string;
}

export interface NavigationResponse {
  path: Array<{ lat: number; lng: number }>;
  distance: number;
  duration: number;
  signals: SignalAhead[];
  trafficConditions: TrafficConditions;
  routeInfo: RouteInfo;
}

export interface SignalAhead {
  signalId: string;
  position: { lat: number; lng: number };
  distance: number;
  currentState: 'RED' | 'YELLOW' | 'GREEN';
  estimatedWait: number;
  estimatedArrival: number;
}

export interface TrafficConditions {
  congestionLevel: number;
  avgSpeed: number;
  vehicleCount: number;
}

export async function startNavigation(req: NavigationRequest, graph: RoadGraph, signals: TrafficSignal[]): Promise<NavigationResponse> {
  const { userId, sourceNodeId, destNodeId } = req;

  // Compute route
  const routeInfo = findRoute(graph, sourceNodeId, destNodeId, signals);
  if (!routeInfo) {
    throw new Error('No route found');
  }

  // Add user vehicle to simulation
  const engine = getSimulationEngine();
  if (!engine) {
    throw new Error('Simulation engine not initialized');
  }

  const { addUserVehicle } = await import('./userVehicleService.js');
  addUserVehicle(userId, sourceNodeId, destNodeId, routeInfo.path);

  // Build path geometry
  const path = buildPathGeometry(routeInfo.path, graph);

  // Get signals ahead
  const signalsAhead = getSignalsAhead(routeInfo.path, signals, graph);

  // Get current traffic conditions
  const trafficConditions = getTrafficConditions(engine);

  return {
    path,
    distance: routeInfo.distance,
    duration: routeInfo.estimatedTime,
    signals: signalsAhead,
    trafficConditions,
    routeInfo,
  };
}

export async function getNavigationUpdate(userId: string, graph: RoadGraph, signals: TrafficSignal[]): Promise<NavigationResponse | null> {
  const { getUserVehicle } = await import('./userVehicleService.js');
  const userVehicle = getUserVehicle(userId);
  
  if (!userVehicle || !userVehicle.isActive) {
    return null;
  }

  const engine = getSimulationEngine();
  if (!engine) return null;

  const vehicle = engine.getUserVehicle(userId);
  if (!vehicle) return null;

  // Re-compute signals ahead based on current position
  const signalsAhead = getSignalsAhead(userVehicle.route, signals, graph);
  const trafficConditions = getTrafficConditions(engine);

  // Build remaining path
  const remainingPath = userVehicle.route.slice(userVehicle.routeIndex);
  const path = buildPathGeometry(remainingPath, graph);

  return {
    path,
    distance: 0, // Would compute remaining distance
    duration: 0, // Would compute remaining time
    signals: signalsAhead,
    trafficConditions,
    routeInfo: {
      path: remainingPath,
      distance: 0,
      estimatedTime: 0,
      signalCount: signalsAhead.length,
      roadNames: [],
    },
  };
}

function buildPathGeometry(nodeIds: string[], graph: RoadGraph): Array<{ lat: number; lng: number }> {
  const path: Array<{ lat: number; lng: number }> = [];
  
  for (const nodeId of nodeIds) {
    const node = graph.nodes.find(n => n.id === nodeId);
    if (node) {
      path.push({ lat: node.lat, lng: node.lng });
    }
  }

  return path;
}

function getSignalsAhead(route: string[], signals: TrafficSignal[], graph: RoadGraph): SignalAhead[] {
  const signalsAhead: SignalAhead[] = [];
  const signalMap = new Map(signals.map(s => [s.nodeId, s]));

  // Look at next 10 nodes for signals
  const lookAhead = Math.min(route.length, 10);
  let distanceAccum = 0;

  for (let i = 0; i < lookAhead; i++) {
    const nodeId = route[i];
    const signal = signalMap.get(nodeId);
    
    if (signal) {
      const node = graph.nodes.find(n => n.id === nodeId);
      if (node) {
        const currentPhase = signal.phases[signal.currentPhaseIndex];
        const estimatedWait = estimateWaitTime(signal, distanceAccum);
        
        signalsAhead.push({
          signalId: signal.id,
          position: { lat: node.lat, lng: node.lng },
          distance: distanceAccum,
          currentState: currentPhase.color as 'RED' | 'YELLOW' | 'GREEN',
          estimatedWait,
          estimatedArrival: distanceAccum / 10, // Rough estimate
        });
      }
    }

    // Add edge distance
    if (i < route.length - 1) {
      const edge = graph.edges.find(e => e.from === route[i] && e.to === route[i + 1]);
      if (edge) {
        distanceAccum += edge.length;
      }
    }
  }

  return signalsAhead;
}

function estimateWaitTime(signal: TrafficSignal, distance: number): number {
  const currentPhase = signal.phases[signal.currentPhaseIndex];
  const timeToArrival = distance / 10; // Assume 10 m/s avg speed
  
  if (currentPhase.color === 'GREEN') {
    return Math.max(0, timeToArrival - signal.timer);
  } else if (currentPhase.color === 'YELLOW') {
    return currentPhase.duration + timeToArrival;
  } else {
    // RED - wait for next green
    const greenPhaseIndex = signal.phases.findIndex(p => p.color === 'GREEN' && p.group === currentPhase.group);
    if (greenPhaseIndex === -1) return signal.cycleLength;
    
    let timeToGreen = 0;
    for (let i = signal.currentPhaseIndex; i !== greenPhaseIndex; i = (i + 1) % signal.phases.length) {
      timeToGreen += signal.phases[i].duration;
    }
    return timeToGreen + timeToArrival;
  }
}

function getTrafficConditions(engine: any): TrafficConditions {
  const stats = engine.getStats();
  const vehicles = engine.getVehicles();
  
  // Calculate congestion level based on vehicle density
  const congestionLevel = Math.min(1, vehicles.length / 100);
  
  return {
    congestionLevel,
    avgSpeed: stats.avgSpeed,
    vehicleCount: vehicles.length,
  };
}
