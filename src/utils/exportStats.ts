/**
 * Stats Export Utility
 * Exports current simulation state as a downloadable JSON file.
 */
import type { TrafficStats, CongestionZone } from '../types';
import type { UserRoute } from '../types/roles';
import type { SimClock } from '../engine/timeOfDay';
import { formatSimTime } from '../engine/timeOfDay';

export interface ExportPayload {
  exportedAt: string;
  simTime: string;
  stats: TrafficStats;
  congestionZones: CongestionZone[];
  userRoutes: UserRoute[];
  signalCount: number;
  nodeCount: number;
}

export function buildExportPayload(
  stats: TrafficStats,
  congestionZones: CongestionZone[],
  userRoutes: UserRoute[],
  signalCount: number,
  nodeCount: number,
  clock: SimClock,
): ExportPayload {
  return {
    exportedAt: new Date().toISOString(),
    simTime: formatSimTime(clock),
    stats,
    congestionZones,
    userRoutes,
    signalCount,
    nodeCount,
  };
}

/** Trigger browser download of stats as JSON */
export function downloadStatsJSON(payload: ExportPayload): void {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `wayfinder-stats-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
