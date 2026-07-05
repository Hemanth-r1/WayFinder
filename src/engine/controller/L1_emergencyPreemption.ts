import type { Vehicle, TrafficSignal, RoadNode } from '../../types';
import type { EmergencyOverride, ControllerConfig } from './types';
import { haversineMeters } from '../../utils/geo';

function bearingToDir(bearing: number): 'N' | 'S' | 'E' | 'W' {
  if (bearing > 315 || bearing <= 45) return 'N';
  if (bearing > 45 && bearing <= 135) return 'E';
  if (bearing > 135 && bearing <= 225) return 'S';
  return 'W';
}

export function applyL1(
  vehicles: Map<string, Vehicle>,
  signals: Map<string, TrafficSignal>,
  nodes: Map<string, RoadNode>,
  activeOverrides: Map<string, EmergencyOverride>,
  deltaTime: number,
  config: Pick<ControllerConfig, 'emergencyHoldTime' | 'emergencyRadius'>,
): Map<string, EmergencyOverride> {
  const updated = new Map<string, EmergencyOverride>();
  const radius = config.emergencyRadius;
  const holdTime = config.emergencyHoldTime;

  for (const [sigId, ov] of activeOverrides) {
    const remaining = ov.timeRemaining - deltaTime;
    if (remaining > 0) {
      updated.set(sigId, { ...ov, timeRemaining: remaining });
    }
  }

  for (const [, v] of vehicles) {
    if (v.type !== 'emergency') continue;
    for (const [, sig] of signals) {
      if (updated.has(sig.id)) continue;
      const node = nodes.get(sig.nodeId);
      if (!node) continue;
      const dist = haversineMeters(v.lat, v.lng, node.lat, node.lng);
      if (dist > radius) continue;

      const dir = bearingToDir(v.bearing);
      for (const phase of sig.phases) {
        const isMatchingAxis = (dir === 'N' || dir === 'S')
          ? phase.group === 'NS'
          : phase.group === 'EW';
        phase.color = isMatchingAxis ? 'GREEN' : 'RED';
        phase.duration = isMatchingAxis ? holdTime : 2;
      }

      updated.set(sig.id, {
        signalId: sig.id,
        vehicleId: v.id,
        direction: dir,
        timeRemaining: holdTime,
      });
    }
  }

  return updated;
}
