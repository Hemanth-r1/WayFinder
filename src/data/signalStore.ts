/**
 * signalStore.ts
 * Persists signal positions (lat/lng/id) to a JSON file for instant loading.
 * Signals are small data (~1KB per 100 signals) so this is always fast.
 */

export interface SignalPoint {
  id: string;
  nodeId: string;
  lat: number;
  lng: number;
}

interface SignalStoreFile {
  version: number;
  generated: string;
  signals: SignalPoint[];
}

const SIGNALS_FILE = '/signals.json';

let cachedSignals: SignalPoint[] | null = null;

/** Load signals from the static JSON file (instant, no OSM needed) */
export async function loadSignalPoints(): Promise<SignalPoint[] | null> {
  if (cachedSignals) return cachedSignals;
  try {
    const resp = await fetch(SIGNALS_FILE);
    if (!resp.ok) return null;
    const data: SignalStoreFile = await resp.json();
    if (!data.signals || !Array.isArray(data.signals)) return null;
    cachedSignals = data.signals;
    console.log(`[WayFinder] Loaded ${data.signals.length} signals from ${SIGNALS_FILE}`);
    return cachedSignals;
  } catch {
    return null;
  }
}

/** Build SignalPoint array from a signals map */
export function extractSignalPoints(
  signals: Map<string, { id: string; nodeId: string }>,
  nodes: Map<string, { lat: number; lng: number }>,
): SignalPoint[] {
  const points: SignalPoint[] = [];
  for (const [nodeId, sig] of signals) {
    const node = nodes.get(sig.nodeId || nodeId);
    if (node) {
      points.push({ id: sig.id, nodeId: sig.nodeId || nodeId, lat: node.lat, lng: node.lng });
    }
  }
  return points;
}

/** Serialize signals to downloadable JSON string */
export function serializeSignals(signals: SignalPoint[]): string {
  const file: SignalStoreFile = {
    version: 1,
    generated: new Date().toISOString(),
    signals,
  };
  return JSON.stringify(file, null, 2);
}
