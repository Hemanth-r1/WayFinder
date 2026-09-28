import { useState, useEffect, type CSSProperties } from 'react';
import { collection, query, where, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { db } from '../config/firebase';
import { useAuth } from '../context/useAuth';
import type { RoadGraph } from '../types';
import type { RouteOption } from '../services/serverClient';
import type { Place } from '../utils/places';
import PlaceInput from '../components/PlaceInput';

export interface RecentTrip {
  id: string;
  sourceNodeId: string; destNodeId: string;
  sourceName: string; destName: string;
}

interface Props {
  graph: RoadGraph;
  sourceLabel: string | null; destLabel: string | null;
  onPickSource: (place: Place) => void; onPickDest: (place: Place) => void;
  onClearSource: () => void; onClearDest: () => void;
  onSwap: () => void;
  onUseLocation: () => void; locating: boolean;
  onPickRecent: (trip: RecentTrip) => void;
  routeOptions: RouteOption[]; selectedRouteIndex: number; onSelectRoute: (index: number) => void;
  routeLoading: boolean; routeError: string | null;
  navigating: boolean; starting: boolean;
  onStart: () => void;
  onOpenGoogleMaps: () => void;
}

/** Road names that set this route apart from the other options (all names if none do). */
function distinctRoads(options: RouteOption[], index: number): string[] {
  const own = options[index].roadNames;
  const elsewhere = new Set(options.flatMap((o, i) => i === index ? [] : o.roadNames));
  const unique = own.filter(n => !elsewhere.has(n));
  return unique.length > 0 ? unique : own;
}

function formatMinutes(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

export default function UserPanel(p: Props) {
  const { user } = useAuth();
  const [recent, setRecent] = useState<RecentTrip[]>([]);

  useEffect(() => {
    if (!user || !db) return; // demo mode: Firebase not configured
    const q = query(
      collection(db, 'routes'),
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc'),
      limit(10),
    );
    const unsub = onSnapshot(q, (snapshot) => {
      const seen = new Set<string>();
      const trips: RecentTrip[] = [];
      snapshot.forEach((doc) => {
        const d = doc.data();
        const key = `${d.sourceNodeId}>${d.destNodeId}`;
        if (seen.has(key)) return;
        seen.add(key);
        trips.push({
          id: doc.id, sourceNodeId: d.sourceNodeId, destNodeId: d.destNodeId,
          sourceName: d.sourceName ?? d.sourceNodeId, destName: d.destName ?? d.destNodeId,
        });
      });
      setRecent(trips.slice(0, 4));
    }, (err) => {
      console.error('Firestore route subscription error:', err);
    });
    return unsub;
  }, [user]);

  const hasTrip = p.sourceLabel && p.destLabel;
  const selected = p.routeOptions[p.selectedRouteIndex];

  return (
    <div style={{ padding: '12px 14px' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <PlaceInput
            graph={p.graph}
            value={p.sourceLabel}
            placeholder="From: search or tap the map"
            dotColor="#4CAF50"
            onPick={p.onPickSource}
            onClear={p.onClearSource}
            onUseLocation={p.onUseLocation}
            locating={p.locating}
          />
          <PlaceInput
            graph={p.graph}
            value={p.destLabel}
            placeholder="To: where are you going?"
            dotColor="#F44336"
            onPick={p.onPickDest}
            onClear={p.onClearDest}
          />
        </div>
        <button
          onClick={p.onSwap}
          disabled={!p.sourceLabel && !p.destLabel}
          title="Swap origin and destination"
          style={{
            width: 34, height: 34, borderRadius: 17, border: '1px solid #333', background: '#1a1a2e',
            color: '#aaa', cursor: 'pointer', fontSize: 16, flexShrink: 0,
          }}
        >⇅</button>
      </div>

      {!hasTrip && (
        <div style={{ fontSize: 12, color: '#666', marginTop: 12, lineHeight: 1.5 }}>
          Search for a road or place, use your location, or tap a road on the map.
        </div>
      )}

      {hasTrip && !p.navigating && (
        <div style={{ marginTop: 14 }}>
          {p.routeLoading && <div style={styles.muted}>Finding the best routes for you…</div>}
          {!p.routeLoading && p.routeError && <div style={{ ...styles.muted, color: '#F44336' }}>{p.routeError}</div>}
          {!p.routeLoading && p.routeOptions.map((r, i) => {
            const isSel = i === p.selectedRouteIndex;
            return (
              <button key={r.edgeIds.join()} onClick={() => p.onSelectRoute(i)} style={{
                ...styles.option,
                background: isSel ? '#4488FF1f' : '#ffffff06',
                border: `1px solid ${isSel ? '#4488FF' : '#2a2a40'}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 18, fontWeight: 'bold', color: i === 0 ? '#4CAF50' : '#fff' }}>
                    {formatMinutes(r.estimatedTime)}
                  </span>
                  <span style={{ fontSize: 12, color: '#999' }}>{(r.distance / 1000).toFixed(1)} km</span>
                </div>
                <div style={{ fontSize: 12, color: '#bbb', marginTop: 2 }}>
                  {r.roadNames.length > 0 ? `via ${distinctRoads(p.routeOptions, i).slice(0, 2).join(', ')}` : 'via local roads'}
                </div>
                <div style={{ fontSize: 11, color: '#777', marginTop: 2 }}>
                  {i === 0 ? 'Best route for you' : 'Alternative'} · {r.signalCount} signal{r.signalCount === 1 ? '' : 's'}
                  {r.sharedUsers > 0 && <span style={{ color: '#FF9800' }}> · busier with other drivers</span>}
                </div>
              </button>
            );
          })}

          {selected && (
            <>
              {/* Kept in reach on small screens where the option list scrolls */}
              <div style={{ position: 'sticky', bottom: 0, background: 'rgba(8,8,18,0.99)', paddingBottom: 8 }}>
                <button onClick={p.onStart} disabled={p.starting} style={styles.primary}>
                  {p.starting ? 'Starting…' : '▶ Start'}
                </button>
                <button onClick={p.onOpenGoogleMaps} disabled={p.starting} style={styles.secondary}>
                  Open this route in Google Maps
                </button>
              </div>
              <div style={{ ...styles.muted, fontSize: 11, marginTop: 4 }}>
                Routes use live traffic and the routes other WayFinder drivers were given, so people going the same way are spread across nearby roads.
              </div>
            </>
          )}
        </div>
      )}

      {!hasTrip && recent.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={styles.sectionTitle}>Recent</div>
          {recent.map(t => (
            <button key={t.id} onClick={() => p.onPickRecent(t)} style={{ ...styles.option, background: 'transparent', border: 'none', borderBottom: '1px solid #222', borderRadius: 0 }}>
              <div style={{ fontSize: 13, color: '#ddd' }}>{t.destName}</div>
              <div style={{ fontSize: 11, color: '#777' }}>from {t.sourceName}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  muted: { fontSize: 12, color: '#888' },
  sectionTitle: { fontSize: 11, color: '#777', textTransform: 'uppercase', marginBottom: 6, fontWeight: 'bold', letterSpacing: 0.5 },
  option: {
    display: 'block', width: '100%', textAlign: 'left', marginBottom: 8, padding: '10px 12px',
    color: '#ccc', cursor: 'pointer', borderRadius: 8,
  },
  primary: {
    width: '100%', height: 46, marginTop: 4, background: '#4488FF', color: '#fff', border: 'none',
    borderRadius: 23, cursor: 'pointer', fontSize: 15, fontWeight: 'bold',
  },
  secondary: {
    width: '100%', height: 40, marginTop: 8, background: 'transparent', color: '#8ab4ff',
    border: '1px solid #33466a', borderRadius: 20, cursor: 'pointer', fontSize: 13,
  },
};
