import type { Vehicle, CongestionZone, TrafficStats, RoadNode } from './types.js';

export function computeCongestionZones(
  vehicles: Vehicle[], _nodes: RoadNode[]
): CongestionZone[] {
  const zones: CongestionZone[] = [];
  const threshold = 0.005;
  const clustered = new Set<string>();
  for (const v of vehicles) {
    if (clustered.has(v.id)) continue;
    const nearby = vehicles.filter(o =>
      !clustered.has(o.id) &&
      Math.abs(o.lat - v.lat) < threshold &&
      Math.abs(o.lng - v.lng) < threshold
    );
    if (nearby.length < 2) continue;
    const lat = nearby.reduce((s, o) => s + o.lat, 0) / nearby.length;
    const lng = nearby.reduce((s, o) => s + o.lng, 0) / nearby.length;
    const level = Math.min(1, nearby.length / 20);
    zones.push({ centerLat: lat, centerLng: lng, level, vehicles: nearby.length });
    for (const o of nearby) clustered.add(o.id);
  }
  return zones;
}

export function computeStats(
  vehicles: Vehicle[], congestionZones: CongestionZone[]
): TrafficStats {
  const total = vehicles.length;
  const avgSpeed = total > 0
    ? vehicles.reduce((s, v) => s + v.speed, 0) / total : 0;
  return {
    totalVehicles: total, avgSpeed, avgDelay: 0,
    congestionHotspots: congestionZones.filter(z => z.level > 0.5).length,
    greenWaveActive: false, signalCoordinationScore: 0,
    throughput: 0, maxCongestion: Math.max(0, ...congestionZones.map(z => z.level)),
    slaSpeed: avgSpeed, slaCompliant: avgSpeed > 30,
    emergencySlaSpeed: 0, activeCorridors: 0,
  };
}
