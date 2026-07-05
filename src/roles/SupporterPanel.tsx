import { useState, useEffect, useCallback, useMemo } from 'react';
import { collection, query, where, onSnapshot, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../config/firebase';
import { useAuth } from '../context/useAuth';
import type { RoadGraph, TrafficSignal } from '../types';
import type { SupporterSignal } from '../types/roles';

interface Props {
  graph: RoadGraph; signals: Map<string, TrafficSignal>;
}

export default function SupporterPanel({ graph, signals }: Props) {
  const { user } = useAuth();
  const [mode, setMode] = useState<'view' | 'add'>('view');
  const [roadName, setRoadName] = useState('');
  const [placementPos, setPlacementPos] = useState<{ lat: number; lng: number } | null>(null);
  const [firebaseSignals, setFirebaseSignals] = useState<SupporterSignal[]>([]);
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'signals'), where('supporterId', '==', user.uid));
    const unsub = onSnapshot(q, (snapshot) => {
      const list: SupporterSignal[] = snapshot.docs.map(doc => {
        const d = doc.data();
        return {
          id: doc.id,
          supporterId: d.supporterId ?? '',
          lat: d.lat ?? 0,
          lng: d.lng ?? 0,
          roadName: d.roadName ?? '',
          signalType: d.signalType ?? 'smart',
          timestamp: d.timestamp?.toMillis() ?? Date.now(),
          notes: d.notes ?? '',
        };
      });
      setFirebaseSignals(list);
    });
    return unsub;
  }, [user]);

  const signalList = useMemo(() => Array.from(signals.values()), [signals]);
  const gapNodes = useMemo(() => Array.from(graph.nodes.values()).filter(n => { const adj = graph.adjacency.get(n.id) || []; return adj.length >= 3 && !signals.has(n.id); }), [graph, signals]);

  const handlePlace = useCallback(() => {
    if (!placementPos || !user) return;
    addDoc(collection(db, 'signals'), {
      supporterId: user.uid,
      nodeId: roadName || 'unknown',
      lat: placementPos.lat,
      lng: placementPos.lng,
      roadName: roadName || 'unknown',
      signalType: 'smart',
      timestamp: serverTimestamp(),
    });
    setPlacementPos(null); setRoadName(''); setMode('view');
  }, [placementPos, roadName, user]);

  return (
    <div style={{ padding: '0 14px' }}>
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Supporter Tools</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <button onClick={() => setMode('view')} style={{ flex: 1, padding: '6px 8px', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold', background: mode === 'view' ? '#FF9800' : '#333' }} title="View existing signals">View</button>
          <button onClick={() => setMode('add')} style={{ flex: 1, padding: '6px 8px', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold', background: mode === 'add' ? '#4CAF50' : '#333' }} title="Add a new signal">Add Signal</button>
        </div>
        {mode === 'add' && (
          <div>
            <input type="text" value={roadName} onChange={(e) => setRoadName(e.target.value)} placeholder="Road name" style={styles.input} />
            {placementPos && <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Lat: {placementPos.lat.toFixed(6)}, Lng: {placementPos.lng.toFixed(6)}</div>}
            {!placementPos && <div style={{ fontSize: 11, color: '#666', padding: '4px 0' }}>Click map to place</div>}
            <button onClick={handlePlace} style={{ width: '100%', padding: '8px', background: '#4CAF50', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 'bold', marginTop: 4 }}>Place Signal</button>
          </div>
        )}
      </div>
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Coverage Gaps ({gapNodes.length})</div>
        {gapNodes.slice(0, 10).map((node) => (
          <div key={node.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #222' }}>
            <span style={{ fontSize: 11, color: '#888', fontFamily: 'monospace' }}>{node.lat.toFixed(4)}, {node.lng.toFixed(4)}</span>
            <button onClick={() => { setPlacementPos({ lat: node.lat, lng: node.lng }); setMode('add'); }} style={{ padding: '2px 8px', background: '#FF980022', color: '#FF9800', border: '1px solid #FF980044', borderRadius: 3, cursor: 'pointer', fontSize: 10 }}>+ Add</button>          </div>
        ))}
        {gapNodes.length > 10 && <div style={{ fontSize: 11, color: '#666', padding: '4px 0' }}>+{gapNodes.length - 10} more...</div>}
      </div>
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Signals ({signalList.length})</div>
        <div style={{ maxHeight: 200, overflow: 'auto' }}>
          {signalList.slice(0, 15).map((sig) => {
            const phase = sig.phases[sig.currentPhaseIndex]; const isGreen = phase.color === 'GREEN';
            return (
              <div key={sig.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: isGreen ? '#4CAF50' : '#f44336', flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 11, fontFamily: 'monospace', color: '#fff' }}>{sig.id}</span>
                <span style={{ color: isGreen ? '#4CAF50' : '#f44336', fontSize: 11, fontWeight: 'bold' }}>{phase.color}</span>
              </div>
            );
          })}
        </div>
      </div>
      {firebaseSignals.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Your Signals ({firebaseSignals.length})</div>
          {firebaseSignals.map((s) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#FF9800', flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: 11, fontFamily: 'monospace', color: '#fff' }}>{s.roadName}</span>
              <span style={{ color: '#888', fontSize: 10 }}>{new Date(s.timestamp).toLocaleTimeString()}</span>
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
  input: { width: '100%', padding: '6px 8px', background: '#1a1a2e', border: '1px solid #444', borderRadius: 4, color: '#fff', fontSize: 11, marginBottom: 6, boxSizing: 'border-box' as const },
};
