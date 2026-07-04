import type { Vehicle, RoadNode, CongestionZone, TrafficStats } from '../types';

export function detectCongestionZones(vehicles: Map<string, Vehicle>, nodes: Map<string, RoadNode>): CongestionZone[] {
  const zones: CongestionZone[] = []; const processed = new Set<string>();
  for (const [, node] of nodes) {
    if (processed.has(node.id)) continue;
    let nearby = 0; const nearbyV: Vehicle[] = [];
    for (const [, v] of vehicles) {
      if (Math.abs(v.lat - node.lat) < 0.0005 && Math.abs(v.lng - node.lng) < 0.0005) { nearby++; nearbyV.push(v); }
    }
    if (nearby >= 5) {
      let avgLat = 0, avgLng = 0;
      for (const v of nearbyV) { avgLat += v.lat; avgLng += v.lng; }
      avgLat /= nearby; avgLng /= nearby;
      const avgSpeed = nearbyV.reduce((s, v) => s + v.speed, 0) / nearby;
      const level = Math.min(1, nearby / 15) * (1 - avgSpeed / 60);
      zones.push({ centerLat: avgLat, centerLng: avgLng, radius: Math.max(80, nearby * 15), level: Math.max(0, Math.min(1, level)), vehicles: nearby, trend: 'stable' });
      for (const v of nearbyV) processed.add(v.id);
    }
  }
  return zones.sort((a, b) => b.level - a.level);
}

export function computeStats(vehicles: Map<string, Vehicle>, congestionZones: CongestionZone[]): TrafficStats {
  let totalSpeed = 0, speedCount = 0, delayCount = 0, movingCount = 0;
  for (const [, v] of vehicles) {
    totalSpeed += v.speed; speedCount++;
    if (v.waitingForSignal || v.stuckTime > 0) delayCount++;
    if (v.speed > 5) movingCount++; // vehicles actively moving through network
  }
  return {
    totalVehicles: vehicles.size, avgSpeed: speedCount > 0 ? Math.round(totalSpeed / speedCount) : 0,
    avgDelay: delayCount > 0 ? Math.round((delayCount / Math.max(1, speedCount)) * 100) : 0,
    congestionHotspots: congestionZones.filter(z => z.level > 0.5).length,
    greenWaveActive: false, signalCoordinationScore: 0,
    throughput: movingCount, maxCongestion: congestionZones.length > 0 ? congestionZones[0].level : 0,
  };
}
