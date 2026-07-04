import { describe, test, expect } from 'vitest';
import { buildExportPayload } from './exportStats';
import { createSimClock } from '../engine/timeOfDay';
import type { TrafficStats, CongestionZone } from '../types';

const mockStats: TrafficStats = {
  totalVehicles: 50,
  avgSpeed: 32,
  avgDelay: 10,
  congestionHotspots: 2,
  greenWaveActive: true,
  signalCoordinationScore: 75,
  throughput: 40,
  maxCongestion: 0.6,
};

const mockZones: CongestionZone[] = [
  { centerLat: 12.97, centerLng: 77.59, radius: 100, level: 0.6, vehicles: 8, trend: 'increasing' },
];

describe('buildExportPayload', () => {
  test('includes all required fields', () => {
    const clock = createSimClock(9, 2);
    const payload = buildExportPayload(mockStats, mockZones, [], 20, 150, clock);
    expect(payload.stats).toBe(mockStats);
    expect(payload.congestionZones).toBe(mockZones);
    expect(payload.userRoutes).toEqual([]);
    expect(payload.signalCount).toBe(20);
    expect(payload.nodeCount).toBe(150);
    expect(payload.simTime).toBe('09:00');
    expect(payload.exportedAt).toBeTruthy();
  });

  test('exportedAt is a valid ISO date string', () => {
    const clock = createSimClock(8, 2);
    const payload = buildExportPayload(mockStats, [], [], 0, 0, clock);
    expect(() => new Date(payload.exportedAt)).not.toThrow();
    expect(new Date(payload.exportedAt).getFullYear()).toBeGreaterThan(2020);
  });
});
