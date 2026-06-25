import { db } from '../config/firebase';
import { doc, setDoc, Timestamp } from 'firebase/firestore';
import type { TrafficSignal, Vehicle, TrafficStats, Intersection } from '../types';

const SYNC_INTERVAL = 1000;

export class SyncService {
  private enabled = false;
  private lastSync = 0;
  private sessionId: string;

  constructor() {
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  async syncSignals(signals: Map<string, TrafficSignal>, intersections: Map<string, Intersection>): Promise<void> {
    if (!this.enabled) return;
    const now = Date.now();
    if (now - this.lastSync < SYNC_INTERVAL) return;
    this.lastSync = now;

    const signalData: Record<string, object> = {};
    for (const [id, sig] of signals) {
      const int = intersections.get(id);
      signalData[id] = {
        intersectionId: sig.intersectionId,
        currentPhaseIndex: sig.currentPhaseIndex,
        greenWaveDirection: sig.greenWaveDirection,
        congestionLevel: sig.congestionLevel,
        row: int?.row ?? 0,
        col: int?.col ?? 0,
      };
    }

    try {
      const ref = doc(db, 'sessions', this.sessionId, 'traffic', 'signals');
      await setDoc(ref, {
        signals: signalData,
        timestamp: Timestamp.now(),
      }, { merge: true });
    } catch {
    }
  }

  async syncStats(stats: TrafficStats): Promise<void> {
    if (!this.enabled) return;
    try {
      const ref = doc(db, 'sessions', this.sessionId, 'traffic', 'stats');
      await setDoc(ref, {
        ...stats,
        timestamp: Timestamp.now(),
      }, { merge: true });
    } catch {
    }
  }

  async syncVehicles(vehicles: Map<string, Vehicle>): Promise<void> {
    if (!this.enabled) return;
    try {
      const ref = doc(db, 'sessions', this.sessionId, 'traffic', 'vehicles');
      const vehicleArr = Array.from(vehicles.values()).slice(0, 50).map(v => ({
        id: v.id,
        lat: v.lat,
        lng: v.lng,
        direction: v.direction,
        speed: Math.round(v.speed * 100) / 100,
        type: v.type,
      }));
      await setDoc(ref, {
        count: vehicles.size,
        vehicles: vehicleArr,
        timestamp: Timestamp.now(),
      }, { merge: true });
    } catch {
    }
  }

  getSessionId(): string {
    return this.sessionId;
  }
}
