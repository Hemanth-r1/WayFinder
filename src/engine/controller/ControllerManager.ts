import type { TrafficSignal, Vehicle, RoadGraph } from '../../types';
import type { OverrideRequest, SolverContext, ControllerConfig, EmergencyOverride } from './types';
import { applyL1 } from './L1_emergencyPreemption';
import { applyL2 } from './L2_overrideQueue';
import { applyL3 } from './L3_maxPressure';
import { applyL4 } from './L4_costRefinement';
import { CONTROLLER } from '../../config';
import type { TimeProfile } from '../timeOfDay';

export class ControllerManager {
  private emergencyOverrides = new Map<string, EmergencyOverride>();
  private overrideQueue: OverrideRequest[] = [];
  private previouslyLocked: Set<string> = new Set();
  private config: ControllerConfig;

  constructor(config?: Partial<ControllerConfig>) {
    this.config = {
      weights: {
        delay: CONTROLLER.WEIGHTS.DELAY,
        throughput: CONTROLLER.WEIGHTS.THROUGHPUT,
        queue: CONTROLLER.WEIGHTS.QUEUE,
        fairness: CONTROLLER.WEIGHTS.FAIRNESS,
      },
      maxPressureCap: CONTROLLER.MAX_PRESSURE_CAP,
      refinementDelta: CONTROLLER.REFINEMENT_DELTA,
      emergencyHoldTime: CONTROLLER.EMERGENCY_HOLD_TIME,
      emergencyRadius: CONTROLLER.EMERGENCY_RADIUS,
      ...config,
    };
  }

  enqueueRequest(req: OverrideRequest): void {
    this.overrideQueue.push(req);
  }

  getActiveOverrides(): OverrideRequest[] {
    return [...this.overrideQueue];
  }

  hasEmergencyOverride(): boolean {
    return this.emergencyOverrides.size > 0;
  }

  getEmergencyOverrideCount(): number {
    return this.emergencyOverrides.size;
  }

  solve(
    signals: Map<string, TrafficSignal>,
    vehicles: Map<string, Vehicle>,
    graph: RoadGraph,
    dt: number,
    simTime: number,
    timeOfDayProfile: TimeProfile,
  ): void {
    for (const sigId of this.previouslyLocked) {
      if (!lockedNow(this.emergencyOverrides, simTime, this.overrideQueue, sigId)) {
        restoreNominalPhases(signals, sigId);
      }
    }

    const ctx: SolverContext = {
      signals,
      vehicles,
      graph,
      dt,
      simTime,
      timeOfDayProfile,
      emergencyOverrides: this.emergencyOverrides,
      overrideQueue: this.overrideQueue,
    };

    const lockedSignalIds = new Set<string>();

    this.emergencyOverrides = applyL1(
      vehicles, signals, graph.nodes, this.emergencyOverrides, dt,
      { emergencyHoldTime: this.config.emergencyHoldTime, emergencyRadius: this.config.emergencyRadius },
    );
    for (const [sigId] of this.emergencyOverrides) {
      lockedSignalIds.add(sigId);
    }

    const activeQueue = this.overrideQueue.filter(req => simTime < req.expiresAt);
    const processed = applyL2(signals, activeQueue, simTime);
    for (const req of processed) {
      lockedSignalIds.add(req.signalId);
    }

    this.overrideQueue = activeQueue;

    for (const sigId of Array.from(this.previouslyLocked)) {
      if (!lockedSignalIds.has(sigId)) {
        restoreNominalPhases(signals, sigId);
      }
    }

    applyL3(ctx, { maxPressureCap: this.config.maxPressureCap }, lockedSignalIds);

    applyL4(ctx, {
      refinementDelta: this.config.refinementDelta,
      weights: this.config.weights,
    }, lockedSignalIds);

    this.previouslyLocked = lockedSignalIds;
  }
}

function lockedNow(
  emergencyOverrides: Map<string, EmergencyOverride>,
  simTime: number,
  queue: OverrideRequest[],
  sigId: string,
): boolean {
  if (emergencyOverrides.has(sigId)) return true;
  for (const req of queue) {
    if (req.signalId === sigId && simTime < req.expiresAt) return true;
  }
  return false;
}

function restoreNominalPhases(signals: Map<string, TrafficSignal>, sigId: string): void {
  const sig = signals.get(sigId);
  if (!sig || sig.phases.length < 4) return;
  sig.phases[0].color = 'GREEN';
  sig.phases[1].color = 'YELLOW';
  sig.phases[2].color = 'GREEN';
  sig.phases[3].color = 'YELLOW';
  sig.timer = 0;
}
