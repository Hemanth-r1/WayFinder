import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { collection, query, where, orderBy, onSnapshot, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../config/firebase';
import { useAuth } from '../context/useAuth';
import type { RoadGraph } from '../types';
import type { UserRoute } from '../types/roles';
import { aStarRoute } from '../engine/pathfinding';
import type { TrafficSignal } from '../types';

interface Props {
  graph: RoadGraph; signals: Map<string, TrafficSignal>;
  selectedSource: string | null; selectedDest: string | null;
  onSelectSource: (id: string | null) => void; onSelectDest: (id: string | null) => void;
}

export default function UserPanel({ graph, signals, selectedSource, selectedDest, onSelectSource, onSelectDest }: Props) {
  const { user } = useAuth();
  const [sourceName, setSourceName] = useState('');
  const [destName, setDestName] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [routes, setRoutes] = useState<UserRoute[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { return () => { if (timerRef.current) clearTimeout(timerRef.current); }; }, []);

  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, 'routes'),
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );
    const unsub = onSnapshot(q, (snapshot) => {
      const results: UserRoute[] = [];
      snapshot.forEach((doc) => {
        const d = doc.data();
        results.push({
          id: doc.id,
          userId: d.userId,
          sourceLat: 0,
          sourceLng: 0,
          destLat: 0,
          destLng: 0,
          sourceName: d.sourceNodeId,
          destName: d.destNodeId,
          timestamp: d.createdAt?.toMillis() ?? Date.now(),
          signalOverrides: [],
        });
      });
      setRoutes(results);
    }, (err) => {
      console.error('Firestore route subscription error:', err);
    });
    return unsub;
  }, [user]);

  const route = useMemo(
    () => selectedSource && selectedDest ? aStarRoute(graph, selectedSource, selectedDest, signals) : null,
    [selectedSource, selectedDest, graph, signals]
  );

  const handleSubmit = useCallback(async () => {
    if (!selectedSource || !selectedDest || !user) return;
    const src = graph.nodes.get(selectedSource); const dst = graph.nodes.get(selectedDest);
    if (!src || !dst) return;
    try {
      await addDoc(collection(db, 'routes'), {
        userId: user.uid,
        sourceNodeId: selectedSource,
        destNodeId: selectedDest,
        avoidCongestion: false,
        preferMainRoads: false,
        createdAt: serverTimestamp(),
      });
      setSubmitted(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setSubmitted(false), 2000);
    } catch (err) {
      console.error('Failed to submit route:', err);
    }
  }, [selectedSource, selectedDest, graph, user]);

  return (
    <div style={{ padding: '0 14px' }}>
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Navigation</div>
        <div style={styles.inputGroup}>
          <label style={styles.label}>From</label>
          <input type="text" value={sourceName} onChange={(e) => setSourceName(e.target.value)} placeholder={selectedSource || 'Click map to set'} style={styles.input} />
          {selectedSource && <button onClick={() => onSelectSource(null)} style={styles.clearBtn}>x</button>}
        </div>
        <div style={styles.inputGroup}>
          <label style={styles.label}>To</label>
          <input type="text" value={destName} onChange={(e) => setDestName(e.target.value)} placeholder={selectedDest || 'Click map to set'} style={styles.input} />
          {selectedDest && <button onClick={() => onSelectDest(null)} style={styles.clearBtn}>x</button>}
        </div>
      </div>
      {route && (
        <div style={styles.section}>
          <div style={{ background: '#ffffff08', borderRadius: 6, padding: 8 }}>
            <div style={styles.statRow}><span style={styles.statLabel}>Distance</span><span style={styles.statValue}>{(route.distance / 1000).toFixed(1)} km</span></div>
            <div style={styles.statRow}><span style={styles.statLabel}>Est. Time</span><span style={styles.statValue}>{Math.round(route.estimatedTime)}s</span></div>
            <div style={styles.statRow}><span style={styles.statLabel}>Signals</span><span style={styles.statValue}>{route.signalCount}</span></div>
          </div>
        </div>
      )}
      <div style={styles.section}>
        <button onClick={handleSubmit} disabled={!selectedSource || !selectedDest} style={{ width: '100%', padding: '10px', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 'bold', background: submitted ? '#4CAF50' : '#2196F3', opacity: selectedSource && selectedDest ? 1 : 0.5 }}>
          {submitted ? 'Submitted!' : 'Submit Route'}
        </button>
      </div>
      {routes.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Recent Routes ({routes.length})</div>
          {routes.slice(-5).reverse().map((r) => (
            <div key={r.id} style={{ padding: '6px 0', borderBottom: '1px solid #222' }}>
              <div style={{ fontSize: 12 }}><span style={{ color: '#4CAF50' }}>{r.sourceName}</span> <span style={{ color: '#666' }}>{'\u2192'}</span> <span style={{ color: '#FF5722' }}>{r.destName}</span></div>
              <div style={{ fontSize: 10, color: '#666' }}>{new Date(r.timestamp).toLocaleTimeString()} - {r.signalOverrides.length} signals</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  section: { padding: '10px 0', borderBottom: '1px solid #222' },
  sectionTitle: { fontSize: 11, color: '#888', textTransform: 'uppercase' as const, marginBottom: 8, fontWeight: 'bold' },
  inputGroup: { marginBottom: 8, position: 'relative' },
  label: { display: 'block', fontSize: 11, color: '#888', marginBottom: 4, textTransform: 'uppercase' as const },
  input: { width: '100%', padding: '8px 10px', background: '#1a1a2e', border: '1px solid #444', borderRadius: 6, color: '#fff', fontSize: 12, boxSizing: 'border-box' as const },
  clearBtn: { position: 'absolute', right: 8, top: 28, background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 14 },
  statRow: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 },
  statLabel: { color: '#888', fontSize: 12 },
  statValue: { color: '#fff', fontWeight: 'bold', fontSize: 12 },
};
