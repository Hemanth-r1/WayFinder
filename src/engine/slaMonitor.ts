import type { Vehicle, SLAStats } from '../types';
import { SIGNAL_CONFIG } from '../config';

export function computeSLAStats(vehicles: Map<string, Vehicle>): SLAStats {
  let sumSpeed = 0;
  let count = 0;
  let emergSumSpeed = 0;
  let emergCount = 0;

  for (const [, v] of vehicles) {
    if (v.distanceTravelled < SIGNAL_CONFIG.SLA.MIN_DISTANCE) continue;
    const speedKmh = (v.distanceTravelled / Math.max(v.timeTravelled, 0.1)) * 3.6;
    if (v.type === 'emergency') {
      emergSumSpeed += speedKmh;
      emergCount++;
    } else {
      sumSpeed += speedKmh;
      count++;
    }
  }

  const fleetAvg = count > 0 ? sumSpeed / count : 0;
  const emergAvg = emergCount > 0 ? emergSumSpeed / emergCount : 0;

  return {
    fleetAvgSpeedKmh: Math.round(fleetAvg * 10) / 10,
    slaCompliant: fleetAvg >= SIGNAL_CONFIG.SLA.TARGET_SPEED,
    vehicleCount: count,
    emergencyAvgSpeedKmh: Math.round(emergAvg * 10) / 10,
    emergencyCompliant: emergAvg >= SIGNAL_CONFIG.SLA.EMERGENCY_TARGET,
  };
}
