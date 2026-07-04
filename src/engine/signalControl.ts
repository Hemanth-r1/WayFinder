import type { TrafficSignal, Vehicle, RoadNode, Direction } from '../types';
import { SIGNAL_TIMING } from '../types';

const EARTH_RADIUS_M = 6371000;

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function getVehicleCountNear(
  vehicles: Map<string, Vehicle>,
  lat: number,
  lng: number,
  radiusMeters: number,
): number {
  let count = 0;
  for (const [, v] of vehicles) {
    const dist = haversineMeters(v.lat, v.lng, lat, lng);
    if (dist < radiusMeters) count++;
  }
  return count;
}

function getDirectionalDensity(
  vehicles: Map<string, Vehicle>,
  lat: number,
  lng: number,
  radiusMeters: number,
): Record<Direction, number> {
  const counts: Record<Direction, number> = { N: 0, S: 0, E: 0, W: 0 };
  for (const [, v] of vehicles) {
    const dist = haversineMeters(v.lat, v.lng, lat, lng);
    if (dist < radiusMeters) {
      const dlat = v.lat - lat;
      const dlng = v.lng - lng;
      if (Math.abs(dlat) > Math.abs(dlng)) {
        counts[dlat > 0 ? 'N' : 'S']++;
      } else {
        counts[dlng > 0 ? 'E' : 'W']++;
      }
    }
  }
  return counts;
}

function webstersOptimalCycle(totalLostTime: number, criticalFlowRatio: number): number {
  if (criticalFlowRatio <= 0 || criticalFlowRatio >= 1) return SIGNAL_TIMING.minGreen * 2 + totalLostTime;
  const num = (1.5 * totalLostTime) + 5;
  const den = 1 - criticalFlowRatio;
  return Math.max(SIGNAL_TIMING.minGreen * 2 + totalLostTime, Math.min(SIGNAL_TIMING.maxGreen * 2 + totalLostTime, num / den));
}

function computeGreenSplit(
  cycleLength: number,
  lostTime: number,
  flowRatios: Record<Direction, number>,
): Record<Direction, number> {
  const effectiveGreen = cycleLength - lostTime;
  const totalFlow = Object.values(flowRatios).reduce((s, v) => s + v, 0);
  if (totalFlow === 0) {
    const equal = effectiveGreen / 2;
    return { N: equal, S: equal, E: equal, W: equal };
  }
  const nsFlow = flowRatios.N + flowRatios.S;
  const ewFlow = flowRatios.E + flowRatios.W;
  const nsGreen = (nsFlow / totalFlow) * effectiveGreen;
  const ewGreen = (ewFlow / totalFlow) * effectiveGreen;
  return { N: nsGreen, S: nsGreen, E: ewGreen, W: ewGreen };
}

function computeOffset(
  signal: TrafficSignal,
  upstreamSignal: TrafficSignal | null,
  nodeA: RoadNode,
  nodeB: RoadNode,
  speedMs: number,
): number {
  if (!upstreamSignal) return 0;
  const distance = haversineMeters(nodeA.lat, nodeA.lng, nodeB.lat, nodeB.lng);
  const travelTime = distance / speedMs;
  const idealOffset = (upstreamSignal.offset + travelTime) % signal.cycleLength;
  return Math.max(0, Math.min(signal.cycleLength, idealOffset));
}

export function updateAdaptiveSignals(
  signals: Map<string, TrafficSignal>,
  vehicles: Map<string, Vehicle>,
  nodes: Map<string, RoadNode>,
  deltaTime: number,
): void {
  for (const [, signal] of signals) {
    const node = nodes.get(signal.nodeId);
    if (!node) continue;

    signal.timer += deltaTime;

    const nearbyCount = getVehicleCountNear(vehicles, node.lat, node.lng, 200);
    signal.congestionLevel = Math.min(1, nearbyCount / 20);

    const density = getDirectionalDensity(vehicles, node.lat, node.lng, 150);
    const nsDensity = density.N + density.S;
    const ewDensity = density.E + density.W;
    const totalDensity = nsDensity + ewDensity;

    const flowRatios: Record<Direction, number> = {
      N: totalDensity > 0 ? nsDensity / totalDensity * 0.5 : 0.25,
      S: totalDensity > 0 ? nsDensity / totalDensity * 0.5 : 0.25,
      E: totalDensity > 0 ? ewDensity / totalDensity * 0.5 : 0.25,
      W: totalDensity > 0 ? ewDensity / totalDensity * 0.5 : 0.25,
    };

    const totalLostTime = signal.phases.length * SIGNAL_TIMING.lostTimePerPhase;
    const criticalFlowRatio = Math.max(
      flowRatios.N + flowRatios.S,
      flowRatios.E + flowRatios.W,
    );

    const optimalCycle = webstersOptimalCycle(totalLostTime, criticalFlowRatio);
    const greenSplit = computeGreenSplit(optimalCycle, totalLostTime, flowRatios);

    const currentPhase = signal.phases[signal.currentPhaseIndex];
    const isNS = currentPhase.direction === 'N' || currentPhase.direction === 'S';
    const adjustedGreen = isNS
      ? Math.max(SIGNAL_TIMING.minGreen, Math.min(SIGNAL_TIMING.maxGreen, greenSplit.N))
      : Math.max(SIGNAL_TIMING.minGreen, Math.min(SIGNAL_TIMING.maxGreen, greenSplit.E));

    if (signal.timer >= currentPhase.duration + currentPhase.yellowDuration) {
      signal.timer = 0;
      signal.currentPhaseIndex = (signal.currentPhaseIndex + 1) % signal.phases.length;
      const nextPhase = signal.phases[signal.currentPhaseIndex];
      if (nextPhase.color === 'GREEN') {
        nextPhase.duration = adjustedGreen;
      }
    }
  }
}

export function coordinateGreenWave(
  signals: Map<string, TrafficSignal>,
  nodes: Map<string, RoadNode>,
  dominantDirection: 'NS' | 'EW' | null,
): void {
  if (!dominantDirection) return;

  const isNS = dominantDirection === 'NS';
  const sortedSignals = Array.from(signals.values()).sort((a, b) => {
    const nodeA = nodes.get(a.nodeId);
    const nodeB = nodes.get(b.nodeId);
    if (!nodeA || !nodeB) return 0;
    return isNS ? nodeA.lat - nodeB.lat : nodeA.lng - nodeB.lng;
  });

  const avgSpeedMs = 12;
  for (let i = 0; i < sortedSignals.length; i++) {
    const signal = sortedSignals[i];
    const node = nodes.get(signal.nodeId);
    if (!node) continue;

    signal.greenWaveDirection = isNS ? 'N' : 'E';

    if (i === 0) {
      signal.offset = 0;
    } else {
      const prevSignal = sortedSignals[i - 1];
      const prevNode = nodes.get(prevSignal.nodeId);
      if (prevNode) {
        signal.offset = computeOffset(signal, prevSignal, prevNode, node, avgSpeedMs);
      }
    }
  }
}

export function getDominantFlowDirection(vehicles: Map<string, Vehicle>): 'NS' | 'EW' | null {
  let ns = 0, ew = 0;
  for (const [, v] of vehicles) {
    if (v.bearing > 315 || v.bearing <= 45) ns++;
    else if (v.bearing > 135 && v.bearing <= 225) ns++;
    else ew++;
  }
  if (ns === 0 && ew === 0) return null;
  return ns >= ew ? 'NS' : 'EW';
}
