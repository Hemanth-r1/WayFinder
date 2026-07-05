import type { Vehicle } from './types.js';

export function computeSLA(vehicles: Vehicle[]): {
  slaSpeed: number; slaCompliant: boolean; emergencySlaSpeed: number;
} {
  const speeds = vehicles.map(v => v.speed);
  const avg = speeds.length > 0
    ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
  const emergency = vehicles.filter(v => v.type === 'emergency').map(v => v.speed);
  const emergencyAvg = emergency.length > 0
    ? emergency.reduce((a, b) => a + b, 0) / emergency.length : 0;
  return { slaSpeed: avg, slaCompliant: avg >= 25, emergencySlaSpeed: emergencyAvg };
}
