import type { TrafficSignal, Vehicle, RoadGraph } from '../../types';
import type { SolverContext, ControllerConfig } from './types';
import { haversineMeters } from '../../utils/geo';

function findGreenPhases(signal: TrafficSignal): { ns?: TrafficSignal['phases'][0]; ew?: TrafficSignal['phases'][0] } {
  const result: { ns?: TrafficSignal['phases'][0]; ew?: TrafficSignal['phases'][0] } = {};
  for (const phase of signal.phases) {
    if (phase.color === 'GREEN') {
      if (phase.group === 'NS') result.ns = phase;
      else result.ew = phase;
    }
  }
  return result;
}

function getOppositeGreenPhase(signal: TrafficSignal, currentPhase: TrafficSignal['phases'][0]): TrafficSignal['phases'][0] | undefined {
  const targetGroup = currentPhase.group === 'NS' ? 'EW' : 'NS';
  for (const phase of signal.phases) {
    if (phase.color === 'GREEN' && phase.group === targetGroup) return phase;
  }
  return undefined;
}

function estimateDelay(
  signal: TrafficSignal,
  vehicles: Map<string, Vehicle>,
  graph: RoadGraph,
): number {
  const node = graph.nodes.get(signal.nodeId);
  if (!node) return 0;
  let totalDelay = 0;
  for (const [, v] of vehicles) {
    const dist = haversineMeters(v.lat, v.lng, node.lat, node.lng);
    if (dist > 200) continue;

    const currentPhase = signal.phases[signal.currentPhaseIndex];
    if (currentPhase.color !== 'GREEN') continue;

    const oppositeGroup = currentPhase.group === 'NS' ? 'EW' : 'NS';
    let oppositeGreenDuration = 0;
    for (const phase of signal.phases) {
      if (phase.group === oppositeGroup && phase.color === 'GREEN') {
        oppositeGreenDuration = phase.duration;
        break;
      }
    }

    if (oppositeGreenDuration === 0) continue;

    const approachDir = Math.atan2(v.lng - node.lng, v.lat - node.lat) * 180 / Math.PI;
    const isNS = ((approachDir + 360) % 360 > 315 || (approachDir + 360) % 360 <= 45) || ((approachDir + 360) % 360 > 135 && (approachDir + 360) % 360 <= 225);
    const vehicleGroup = isNS ? 'NS' : 'EW';

    if (vehicleGroup === oppositeGroup) {
      const waitTime = currentPhase.duration + currentPhase.yellowDuration - signal.timer + oppositeGreenDuration;
      totalDelay += Math.max(0, waitTime);
    }
  }
  return totalDelay;
}

function computeMaxQueue(
  signal: TrafficSignal,
  vehicles: Map<string, Vehicle>,
  graph: RoadGraph,
): number {
  const node = graph.nodes.get(signal.nodeId);
  if (!node) return 0;
  let nsCount = 0;
  let ewCount = 0;
  for (const [, v] of vehicles) {
    const dist = haversineMeters(v.lat, v.lng, node.lat, node.lng);
    if (dist > 200) continue;
    const approachDir = Math.atan2(v.lng - node.lng, v.lat - node.lat) * 180 / Math.PI;
    const isNS = ((approachDir + 360) % 360 > 315 || (approachDir + 360) % 360 <= 45) || ((approachDir + 360) % 360 > 135 && (approachDir + 360) % 360 <= 225);
    if (isNS) nsCount++;
    else ewCount++;
  }
  return Math.max(nsCount, ewCount);
}

function computeThroughput(
  signal: TrafficSignal,
  vehicles: Map<string, Vehicle>,
  graph: RoadGraph,
): number {
  const node = graph.nodes.get(signal.nodeId);
  if (!node) return 1;
  let count = 0;
  for (const [, v] of vehicles) {
    const dist = haversineMeters(v.lat, v.lng, node.lat, node.lng);
    if (dist > 200) continue;
    count++;
  }
  return Math.max(1, count);
}

function fairnessPenalty(signal: TrafficSignal): number {
  const greenPhases = findGreenPhases(signal);
  const nsG = greenPhases.ns?.duration ?? 0;
  const ewG = greenPhases.ew?.duration ?? 0;
  if (nsG === 0 || ewG === 0) return 0;
  const ratio = Math.max(nsG, ewG) / Math.min(nsG, ewG);
  if (ratio > 2) return (ratio - 2) ** 2;
  return 0;
}

function evaluateCost(
  signal: TrafficSignal,
  vehicles: Map<string, Vehicle>,
  graph: RoadGraph,
  weights: ControllerConfig['weights'],
): number {
  const delay = estimateDelay(signal, vehicles, graph);
  const maxQueue = computeMaxQueue(signal, vehicles, graph);
  const throughput = computeThroughput(signal, vehicles, graph);
  const fairness = fairnessPenalty(signal);
  return weights.delay * delay
    + weights.throughput * (1 / throughput)
    + weights.queue * maxQueue
    + weights.fairness * fairness;
}

export function applyL4(
  ctx: SolverContext,
  config: Pick<ControllerConfig, 'refinementDelta' | 'weights'>,
  lockedSignalIds: Set<string>,
): void {
  const { signals, vehicles, graph } = ctx;
  const delta = config.refinementDelta;
  const weights = config.weights;

  for (const [, signal] of signals) {
    if (lockedSignalIds.has(signal.id)) continue;

    const currentPhase = signal.phases[signal.currentPhaseIndex];
    if (currentPhase.color !== 'GREEN') continue;

    const oppositeGreen = getOppositeGreenPhase(signal, currentPhase);
    if (!oppositeGreen) continue;

    const baseline = evaluateCost(signal, vehicles, graph, weights);

    const origDuration = currentPhase.duration;
    const origOppDuration = oppositeGreen.duration;

    const candidates = [0, delta, -delta];
    let bestCost = baseline;
    let bestDelta = 0;

    for (const adj of candidates) {
      const newDuration = Math.max(8, Math.min(45, origDuration + adj));
      const newOppDuration = Math.max(8, Math.min(45, origOppDuration - adj));

      currentPhase.duration = newDuration;
      oppositeGreen.duration = newOppDuration;

      const cost = evaluateCost(signal, vehicles, graph, weights);
      if (cost < bestCost) {
        bestCost = cost;
        bestDelta = adj;
      }
    }

    if (bestDelta !== 0) {
      currentPhase.duration = Math.max(8, Math.min(45, origDuration + bestDelta));
      oppositeGreen.duration = Math.max(8, Math.min(45, origOppDuration - bestDelta));
    } else {
      currentPhase.duration = origDuration;
      oppositeGreen.duration = origOppDuration;
    }
  }
}