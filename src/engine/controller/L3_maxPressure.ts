import type { Vehicle, RoadGraph, TrafficSignal } from '../../types';
import type { SolverContext, ControllerConfig } from './types';
import { SIGNAL_TIMING } from '../../types';
import { haversineMeters } from '../../utils/geo';

function getDirectionalPressure(
  vehicles: Map<string, Vehicle>,
  signal: TrafficSignal,
  graph: RoadGraph,
  maxCap: number,
): { ns: number; ew: number } {
  const signalNodeId = signal.nodeId;
  const edgeToBearing = new Map<string, number>();
  const signalEdges = graph.adjacency.get(signalNodeId) || [];

  for (const edge of signalEdges) {
    const reverseId = `${edge.to}-${signalNodeId}`;
    const reverseEdge = graph.edges.get(reverseId);
    if (reverseEdge) {
      edgeToBearing.set(reverseId, reverseEdge.bearing);
    }
  }

  for (const [, edge] of graph.edges) {
    if (edge.to === signalNodeId && !edgeToBearing.has(edge.id)) {
      edgeToBearing.set(edge.id, edge.bearing);
    }
  }

  let nsQueue = 0;
  let ewQueue = 0;
  const node = graph.nodes.get(signalNodeId);
  if (!node) return { ns: 0, ew: 0 };

  for (const [, v] of vehicles) {
    const dist = haversineMeters(v.lat, v.lng, node.lat, node.lng);
    if (dist >= 200) continue;

    let bearing: number | null = null;
    if (edgeToBearing.has(v.currentEdgeId)) {
      bearing = edgeToBearing.get(v.currentEdgeId)!;
    } else {
      const dlat = v.lat - node.lat;
      const dlng = v.lng - node.lng;
      bearing = ((Math.atan2(dlng, dlat) * 180 / Math.PI) + 360) % 360;
    }

    if (bearing === null) continue;
    const approachDir = (bearing + 180) % 360;
    const isNS = (approachDir > 315 || approachDir <= 45) || (approachDir > 135 && approachDir <= 225);
    if (isNS) nsQueue++;
    else ewQueue++;
  }

  const nsPressure = Math.min(maxCap, nsQueue);
  const ewPressure = Math.min(maxCap, ewQueue);

  return { ns: nsPressure, ew: ewPressure };
}

export function applyL3(
  ctx: SolverContext,
  config: Pick<ControllerConfig, 'maxPressureCap'>,
  lockedSignalIds: Set<string>,
): void {
  const { signals, vehicles, graph, dt, timeOfDayProfile } = ctx;
  const cap = config.maxPressureCap;

  for (const [, signal] of signals) {
    if (lockedSignalIds.has(signal.id)) continue;
    const node = graph.nodes.get(signal.nodeId);
    if (!node) continue;

    signal.timer += dt;

    const totalLost = signal.phases.length * SIGNAL_TIMING.lostTimePerPhase;

    const pressure = getDirectionalPressure(vehicles, signal, graph, cap);
    const totalPressure = pressure.ns + pressure.ew;

    let cycleLength = SIGNAL_TIMING.minGreen * 2 + totalLost;
    if (totalPressure > 0) {
      const criticalRatio = Math.max(pressure.ns, pressure.ew) / totalPressure;
      const clampedRatio = Math.max(0.1, Math.min(0.9, criticalRatio));
      cycleLength = Math.max(
        cycleLength,
        Math.min(
          SIGNAL_TIMING.maxGreen * 2 + totalLost,
          ((1.5 * totalLost) + 5) / (1 - clampedRatio),
        ),
      );
    }

    cycleLength = Math.round(cycleLength * timeOfDayProfile.cycleLengthMultiplier);
    signal.cycleLength = Math.max(cycleLength, SIGNAL_TIMING.minGreen * 2 + 4);

    const effectiveGreen = signal.cycleLength - totalLost;

    let nsGreen: number;
    let ewGreen: number;
    if (totalPressure === 0) {
      nsGreen = Math.floor(effectiveGreen / 2);
      ewGreen = Math.floor(effectiveGreen / 2);
    } else {
      nsGreen = Math.round((pressure.ns / totalPressure) * effectiveGreen);
      ewGreen = Math.round((pressure.ew / totalPressure) * effectiveGreen);
    }

    nsGreen = Math.max(SIGNAL_TIMING.minGreen, Math.min(SIGNAL_TIMING.maxGreen, nsGreen));
    ewGreen = Math.max(SIGNAL_TIMING.minGreen, Math.min(SIGNAL_TIMING.maxGreen, ewGreen));

    const cycleSum = nsGreen + ewGreen + totalLost;
    if (cycleSum > signal.cycleLength * 1.1) {
      const scale = (signal.cycleLength - totalLost) / (nsGreen + ewGreen);
      nsGreen = Math.round(nsGreen * scale);
      ewGreen = Math.round(ewGreen * scale);
    }

    if (signal.phases.length < 2) continue;

    const currentPhase = signal.phases[signal.currentPhaseIndex];

    if (currentPhase.color === 'YELLOW') {
      if (signal.timer >= currentPhase.duration) {
        signal.timer = 0;
        signal.currentPhaseIndex = (signal.currentPhaseIndex + 1) % signal.phases.length;

        const nsG = signal.phases.find(p => p.group === 'NS' && p.color === 'GREEN');
        const ewG = signal.phases.find(p => p.group === 'EW' && p.color === 'GREEN');
        if (nsG) nsG.duration = nsGreen;
        if (ewG) ewG.duration = ewGreen;

        for (const phase of signal.phases) {
          if (phase.color === 'YELLOW') {
            phase.duration = SIGNAL_TIMING.yellowDuration;
          }
        }
      }
      continue;
    }

    if (currentPhase.color !== 'GREEN') continue;

    if (signal.timer >= currentPhase.duration) {
      signal.timer = 0;
      signal.currentPhaseIndex = (signal.currentPhaseIndex + 1) % signal.phases.length;
    }
  }
}