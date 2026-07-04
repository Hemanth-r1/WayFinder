import type { TrafficSignal, Vehicle, RoadNode, Direction } from '../types';
import { SIGNAL_TIMING } from '../types';

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * Math.PI / 180; const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

function getVehicleCountNear(vehicles: Map<string, Vehicle>, lat: number, lng: number, radius: number): number {
  let count = 0;
  for (const [, v] of vehicles) { if (haversineMeters(v.lat, v.lng, lat, lng) < radius) count++; }
  return count;
}

function getDirectionalDensity(vehicles: Map<string, Vehicle>, lat: number, lng: number, radius: number): Record<Direction, number> {
  const counts: Record<Direction, number> = { N: 0, S: 0, E: 0, W: 0 };
  for (const [, v] of vehicles) {
    if (haversineMeters(v.lat, v.lng, lat, lng) < radius) {
      const dlat = v.lat - lat; const dlng = v.lng - lng;
      if (Math.abs(dlat) > Math.abs(dlng)) counts[dlat > 0 ? 'N' : 'S']++;
      else counts[dlng > 0 ? 'E' : 'W']++;
    }
  }
  return counts;
}

function webstersOptimalCycle(totalLostTime: number, criticalFlowRatio: number): number {
  if (criticalFlowRatio <= 0 || criticalFlowRatio >= 1) return SIGNAL_TIMING.minGreen * 2 + totalLostTime;
  return Math.max(SIGNAL_TIMING.minGreen * 2 + totalLostTime, Math.min(SIGNAL_TIMING.maxGreen * 2 + totalLostTime, ((1.5 * totalLostTime) + 5) / (1 - criticalFlowRatio)));
}

function computeGreenSplit(cycleLength: number, lostTime: number, flowRatios: Record<Direction, number>): Record<Direction, number> {
  const eg = cycleLength - lostTime; const total = Object.values(flowRatios).reduce((s, v) => s + v, 0);
  if (total === 0) return { N: eg / 2, S: eg / 2, E: eg / 2, W: eg / 2 };
  const ns = flowRatios.N + flowRatios.S; const ew = flowRatios.E + flowRatios.W;
  const nsG = (ns / total) * eg; const ewG = (ew / total) * eg;
  return { N: nsG, S: nsG, E: ewG, W: ewG };
}

export function updateAdaptiveSignals(signals: Map<string, TrafficSignal>, vehicles: Map<string, Vehicle>, nodes: Map<string, RoadNode>, deltaTime: number): void {
  for (const [, signal] of signals) {
    const node = nodes.get(signal.nodeId); if (!node) continue;
    signal.timer += deltaTime;
    const nearby = getVehicleCountNear(vehicles, node.lat, node.lng, 200);
    signal.congestionLevel = Math.min(1, nearby / 20);
    const density = getDirectionalDensity(vehicles, node.lat, node.lng, 150);
    const nsD = density.N + density.S; const ewD = density.E + density.W; const total = nsD + ewD;
    const flowRatios: Record<Direction, number> = {
      N: total > 0 ? nsD / total * 0.5 : 0.25, S: total > 0 ? nsD / total * 0.5 : 0.25,
      E: total > 0 ? ewD / total * 0.5 : 0.25, W: total > 0 ? ewD / total * 0.5 : 0.25,
    };
    const totalLost = signal.phases.length * SIGNAL_TIMING.lostTimePerPhase;
    const critical = Math.max(flowRatios.N + flowRatios.S, flowRatios.E + flowRatios.W);
    const optimalCycle = webstersOptimalCycle(totalLost, critical);
    const greenSplit = computeGreenSplit(optimalCycle, totalLost, flowRatios);
    const currentPhase = signal.phases[signal.currentPhaseIndex];
    const isNS = currentPhase.direction === 'N' || currentPhase.direction === 'S';
    const adjustedGreen = Math.max(SIGNAL_TIMING.minGreen, Math.min(SIGNAL_TIMING.maxGreen, isNS ? greenSplit.N : greenSplit.E));
    if (signal.timer >= currentPhase.duration + currentPhase.yellowDuration) {
      signal.timer = 0; signal.currentPhaseIndex = (signal.currentPhaseIndex + 1) % signal.phases.length;
      const next = signal.phases[signal.currentPhaseIndex];
      if (next.color === 'GREEN') next.duration = adjustedGreen;
    }
  }
}

export function coordinateGreenWave(signals: Map<string, TrafficSignal>, nodes: Map<string, RoadNode>, dominant: 'NS' | 'EW' | null): void {
  if (!dominant) return;
  const isNS = dominant === 'NS';
  const sorted = Array.from(signals.values()).sort((a, b) => {
    const nA = nodes.get(a.nodeId); const nB = nodes.get(b.nodeId);
    if (!nA || !nB) return 0; return isNS ? nA.lat - nB.lat : nA.lng - nB.lng;
  });
  const avgSpeed = 12;
  for (let i = 0; i < sorted.length; i++) {
    const sig = sorted[i]; const node = nodes.get(sig.nodeId); if (!node) continue;
    sig.greenWaveDirection = isNS ? 'N' : 'E';
    if (i > 0) {
      const prev = sorted[i - 1]; const prevNode = nodes.get(prev.nodeId);
      if (prevNode) {
        const dist = haversineMeters(prevNode.lat, prevNode.lng, node.lat, node.lng);
        sig.offset = (prev.offset + dist / avgSpeed) % sig.cycleLength;
      }
    }
  }
}

export function getDominantFlowDirection(vehicles: Map<string, Vehicle>): 'NS' | 'EW' | null {
  let ns = 0, ew = 0;
  for (const [, v] of vehicles) {
    if (v.bearing > 315 || v.bearing <= 45) ns++; else if (v.bearing > 135 && v.bearing <= 225) ns++; else ew++;
  }
  if (ns === 0 && ew === 0) return null; return ns >= ew ? 'NS' : 'EW';
}
