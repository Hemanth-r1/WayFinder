import type { Vehicle, RoadNode, RoadEdge, CongestionZone, TrafficStats } from '../types';

const EARTH_RADIUS_M = 6371000;

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

const CELL_SIZE = 200;

export function computeCongestionGrid(
  vehicles: Map<string, Vehicle>,
  bounds: { north: number; south: number; east: number; west: number },
): { lat: number; lng: number; density: number }[] {
  const grid: { lat: number; lng: number; density: number; count: number }[] = [];

  const latRange = bounds.north - bounds.south;
  const lngRange = bounds.east - bounds.west;
  const latStep = latRange / 10;
  const lngStep = lngRange / 10;

  for (let i = 0; i <= 10; i++) {
    for (let j = 0; j <= 10; j++) {
      const lat = bounds.south + i * latStep;
      const lng = bounds.west + j * lngStep;
      grid.push({ lat, lng, density: 0, count: 0 });
    }
  }

  for (const [, v] of vehicles) {
    for (const cell of grid) {
      const dist = haversineMeters(v.lat, v.lng, cell.lat, cell.lng);
      if (dist < CELL_SIZE) {
        cell.count++;
        cell.density += 1 - (dist / CELL_SIZE);
      }
    }
  }

  const maxDensity = Math.max(...grid.map(c => c.density), 1);
  return grid.map(c => ({
    lat: c.lat,
    lng: c.lng,
    density: c.density / maxDensity,
  }));
}

export function detectCongestionZones(
  vehicles: Map<string, Vehicle>,
  nodes: Map<string, RoadNode>,
): CongestionZone[] {
  const zones: CongestionZone[] = [];
  const processed = new Set<string>();

  for (const [, node] of nodes) {
    if (processed.has(node.id)) continue;

    let nearbyCount = 0;
    const nearbyVehicles: Vehicle[] = [];
    const threshold = 0.0005;

    for (const [, v] of vehicles) {
      const dlat = Math.abs(v.lat - node.lat);
      const dlng = Math.abs(v.lng - node.lng);
      if (dlat < threshold && dlng < threshold) {
        nearbyCount++;
        nearbyVehicles.push(v);
      }
    }

    if (nearbyCount >= 5) {
      let avgLat = 0, avgLng = 0;
      for (const v of nearbyVehicles) {
        avgLat += v.lat;
        avgLng += v.lng;
      }
      avgLat /= nearbyCount;
      avgLng /= nearbyCount;

      const avgSpeed = nearbyVehicles.reduce((sum, v) => sum + v.speed, 0) / nearbyCount;
      const level = Math.min(1, nearbyCount / 15) * (1 - avgSpeed / 60);

      zones.push({
        centerLat: avgLat,
        centerLng: avgLng,
        radius: Math.max(80, nearbyCount * 15),
        level: Math.max(0, Math.min(1, level)),
        vehicles: nearbyCount,
        trend: 'stable',
      });

      for (const v of nearbyVehicles) {
        processed.add(v.id);
      }
    }
  }

  return zones.sort((a, b) => b.level - a.level);
}

export function computeEdgeCongestion(
  vehicles: Map<string, Vehicle>,
  edges: Map<string, RoadEdge>,
): Map<string, number> {
  const edgeCounts = new Map<string, number>();
  for (const [, v] of vehicles) {
    edgeCounts.set(v.currentEdgeId, (edgeCounts.get(v.currentEdgeId) || 0) + 1);
  }

  const result = new Map<string, number>();
  for (const [edgeId, edge] of edges) {
    const count = edgeCounts.get(edgeId) || 0;
    const capacity = edge.lanes * 3;
    result.set(edgeId, Math.min(1, count / capacity));
  }
  return result;
}

export function computeStats(
  vehicles: Map<string, Vehicle>,
  congestionZones: CongestionZone[],
): TrafficStats {
  let totalSpeed = 0;
  let speedCount = 0;
  let totalDelay = 0;
  let delayCount = 0;

  for (const [, v] of vehicles) {
    totalSpeed += v.speed;
    speedCount++;
    if (v.waitingForSignal || v.stuckTime > 0) {
      totalDelay++;
      delayCount++;
    }
  }

  return {
    totalVehicles: vehicles.size,
    avgSpeed: speedCount > 0 ? Math.round(totalSpeed / speedCount) : 0,
    avgDelay: delayCount > 0 ? Math.round((delayCount / Math.max(1, speedCount)) * 100) : 0,
    congestionHotspots: congestionZones.filter(z => z.level > 0.5).length,
    greenWaveActive: false,
    signalCoordinationScore: 0,
    throughput: Math.round(vehicles.size * 0.8),
    maxCongestion: congestionZones.length > 0 ? congestionZones[0].level : 0,
  };
}
