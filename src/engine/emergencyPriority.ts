/**
 * Emergency Vehicle Priority System
 * When an emergency vehicle is within proximity of a signal,
 * the signal is temporarily forced GREEN in the vehicle's direction.
 */
import type { Vehicle, TrafficSignal, RoadNode } from '../types';

const EMERGENCY_DETECTION_RADIUS = 200; // meters
const EMERGENCY_HOLD_DURATION = 15; // seconds per signal

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

/** Bearing to direction bucket */
function bearingToDir(bearing: number): 'N' | 'S' | 'E' | 'W' {
  if (bearing > 315 || bearing <= 45) return 'N';
  if (bearing > 45 && bearing <= 135) return 'E';
  if (bearing > 135 && bearing <= 225) return 'S';
  return 'W';
}

export interface EmergencyOverride {
  signalId: string;
  vehicleId: string;
  direction: 'N' | 'S' | 'E' | 'W';
  timeRemaining: number;
}

/** Find emergency vehicles near signals and apply priority overrides */
export function applyEmergencyPriority(
  vehicles: Map<string, Vehicle>,
  signals: Map<string, TrafficSignal>,
  nodes: Map<string, RoadNode>,
  activeOverrides: Map<string, EmergencyOverride>,
  deltaTime: number,
): Map<string, EmergencyOverride> {
  const updated = new Map<string, EmergencyOverride>();

  // Tick down existing overrides
  for (const [sigId, ov] of activeOverrides) {
    const remaining = ov.timeRemaining - deltaTime;
    if (remaining > 0) {
      updated.set(sigId, { ...ov, timeRemaining: remaining });
    } else {
      // Restore adaptive timing when override expires
      const sig = signals.get(sigId);
      if (sig) sig.adaptiveTiming = true;
    }
  }

  // Scan emergency vehicles
  for (const [, v] of vehicles) {
    if (v.type !== 'emergency') continue;
    for (const [, sig] of signals) {
      if (updated.has(sig.id)) continue; // already under override
      const node = nodes.get(sig.nodeId);
      if (!node) continue;
      const dist = haversineMeters(v.lat, v.lng, node.lat, node.lng);
      if (dist > EMERGENCY_DETECTION_RADIUS) continue;

      // Apply green in emergency vehicle's direction
      const dir = bearingToDir(v.bearing);
      sig.adaptiveTiming = false;
      for (const phase of sig.phases) {
        const isMatchingAxis = (dir === 'N' || dir === 'S')
          ? (phase.direction === 'N' || phase.direction === 'S')
          : (phase.direction === 'E' || phase.direction === 'W');
        phase.color = isMatchingAxis ? 'GREEN' : 'RED';
        phase.duration = isMatchingAxis ? EMERGENCY_HOLD_DURATION : 2;
      }

      updated.set(sig.id, {
        signalId: sig.id,
        vehicleId: v.id,
        direction: dir,
        timeRemaining: EMERGENCY_HOLD_DURATION,
      });
    }
  }

  return updated;
}
