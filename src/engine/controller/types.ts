import type { TrafficSignal, Vehicle, RoadGraph, SignalColor } from '../../types';
import type { TimeProfile } from '../timeOfDay';

export interface OverrideRequest {
  id: string;
  signalId: string;
  targetGroup: 'NS' | 'EW';
  targetColor: SignalColor;
  duration: number;
  priority: number;
  source: 'user' | 'controller' | 'supporter';
  expiresAt: number;
  createdAt: number;
}

export interface EmergencyOverride {
  signalId: string;
  vehicleId: string;
  direction: 'N' | 'S' | 'E' | 'W';
  timeRemaining: number;
}

export interface SolverContext {
  signals: Map<string, TrafficSignal>;
  vehicles: Map<string, Vehicle>;
  graph: RoadGraph;
  dt: number;
  simTime: number;
  timeOfDayProfile: TimeProfile;
  emergencyOverrides: Map<string, EmergencyOverride>;
  overrideQueue: OverrideRequest[];
}

export interface ControllerConfig {
  weights: {
    delay: number;
    throughput: number;
    queue: number;
    fairness: number;
  };
  maxPressureCap: number;
  refinementDelta: number;
  emergencyHoldTime: number;
  emergencyRadius: number;
}
