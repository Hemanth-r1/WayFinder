import { useState, useCallback, useMemo, useEffect } from 'react';
import { collection, query, where, onSnapshot, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../config/firebase';
import { useAuth } from '../context/useAuth';
import type { RoadGraph, TrafficSignal, Direction, SignalColor, CongestionZone } from '../types';
import type { UserRoute } from '../types/roles';

interface FirestoreOverride {
  id: string;
  controllerId: string;
  signalId: string;
  direction: Direction;
  color: SignalColor;
  active: boolean;
  expiresAt: { toDate: () => Date };
  timestamp: ReturnType<typeof serverTimestamp>;
}

interface Props {
  graph: RoadGraph;
  signals: Map<string, TrafficSignal>;
  congestionZones: CongestionZone[];
  userRoutes: UserRoute[];
  stats: { totalVehicles: number; avgSpeed: number; congestionHotspots: number; greenWaveActive: boolean; signalCoordinationScore: number };
  onOverrideSignal: (signalId: string, direction: Direction, color: SignalColor) => void;
  onOverrideRoute: (routeSignals: string[], direction: Direction, color: SignalColor) => void;
  onCancelOverride: () => void;
  onSpawnEmergency: () => void;
  onExportStats: () => void;
  onRunOptimizer: () => void;
  onRefreshRoads: () => void;
  lastOptResult: import('../types').OptimizationResult | null;
  overrideActive: boolean;
  overrideTimeRemaining: number;
}

export default function ControllerPanel({
  graph, signals, userRoutes, stats,
  onOverrideSignal, onOverrideRoute, onCancelOverride,
  onSpawnEmergency, onExportStats, onRunOptimizer, onRefreshRoads, lastOptResult,
  overrideActive, overrideTimeRemaining,
}: Props) {
  const { user } = useAuth();
  const [selectedSignal, setSelectedSignal] = useState<string | null>(null);
  const [overrideMode, setOverrideMode] = useState<'individual' | 'route'>('individual');
  const [selectedRouteSignals, setSelectedRouteSignals] = useState<string[]>([]);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [signalSearch, setSignalSearch] = useState('');
  const [fsOverrides, setFsOverrides] = useState<FirestoreOverride[]>([]);

  const signalList = useMemo(() => Array.from(signals.values()), [signals]);

  const filteredSignals = useMemo(() => {
    if (!signalSearch.trim()) return signalList;
    const q = signalSearch.toLowerCase();
    return signalList.filter(s => s.id.toLowerCase().includes(q));
  }, [signalList, signalSearch]);

  useEffect(() => {
    const q = query(collection(db, 'overrides'), where('active', '==', true));
    const unsub = onSnapshot(q, (snapshot) => {
      const list: FirestoreOverride[] = [];
      snapshot.forEach((doc) => {
        const d = doc.data();
        list.push({
          id: doc.id,
          controllerId: d.controllerId,
          signalId: d.signalId,
          direction: d.direction,
          color: d.color,
          active: d.active,
          expiresAt: d.expiresAt,
          timestamp: d.timestamp,
        });
      });
      setFsOverrides(list);
    });
    return unsub;
  }, []);

  const handleSelectRoute = useCallback(() => {
    const counts = new Map<string, number>();
    for (const route of userRoutes) {
      for (const sigId of route.signalOverrides) counts.set(sigId, (counts.get(sigId) || 0) + 1);
    }
    const top = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id]) => id);
    setSelectedRouteSignals(top.length > 0 ? top : Array.from(signals.keys()).slice(0, 5));
  }, [userRoutes, signals]);

  const writeOverrideToFirestore = useCallback((signalId: string, direction: Direction, color: SignalColor) => {
    if (!user) return;
    addDoc(collection(db, 'overrides'), {
      controllerId: user.uid,
      signalId,
      direction,
      color,
      active: true,
      expiresAt: new Date(Date.now() + 30_000),
      timestamp: serverTimestamp(),
    });
  }, [user]);

  const handleOverride = useCallback((direction: Direction, color: SignalColor) => {
    if (overrideMode === 'individual' && selectedSignal) {
      onOverrideSignal(selectedSignal, direction, color);
      writeOverrideToFirestore(selectedSignal, direction, color);
    } else if (overrideMode === 'route') {
      const sigs = selectedRouteSignals.length > 0
        ? selectedRouteSignals
        : Array.from(signals.keys()).slice(0, 5);
      onOverrideRoute(sigs, direction, color);
      sigs.forEach(sid => writeOverrideToFirestore(sid, direction, color));
    } else {
      const allSigs = Array.from(signals.keys());
      onOverrideRoute(allSigs, direction, color);
      allSigs.forEach(sid => writeOverrideToFirestore(sid, direction, color));
    }
  }, [overrideMode, selectedSignal, selectedRouteSignals, onOverrideSignal, onOverrideRoute, signals, writeOverrideToFirestore]);

  return (
    <div style={{ padding: '0 14px' }}>
      {/* Dashboard */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Controller Dashboard</div>
        {overrideActive && (
          <div style={styles.overrideIndicator}>
            ⚡ OVERRIDE ACTIVE — {Math.round(overrideTimeRemaining)}s
          </div>
        )}
        <div style={styles.statGrid}>
          <div style={styles.statBox}>
            <div style={styles.statNum}>{stats.totalVehicles}</div>
            <div style={styles.statLbl}>Vehicles</div>
          </div>
          <div style={styles.statBox}>
            <div style={styles.statNum}>{stats.avgSpeed} km/h</div>
            <div style={styles.statLbl}>Avg Speed</div>
          </div>
          <div style={styles.statBox}>
            <div style={{ ...styles.statNum, color: stats.congestionHotspots > 3 ? '#FF1744' : '#4CAF50' }}>
              {stats.congestionHotspots}
            </div>
            <div style={styles.statLbl}>Hotspots</div>
          </div>
          <div style={styles.statBox}>
            <div style={{ ...styles.statNum, color: stats.greenWaveActive ? '#4CAF50' : '#555' }}>
              {stats.greenWaveActive ? 'ON' : 'OFF'}
            </div>
            <div style={styles.statLbl}>Green Wave</div>
          </div>
        </div>
        <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
          <button onClick={onSpawnEmergency}
            style={{ flex: 1, padding: '6px 8px', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold', background: '#F44336' }}>
            🚨 Emergency
          </button>
          <button onClick={onExportStats}
            style={{ flex: 1, padding: '6px 8px', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold', background: '#37474F' }}>
            📥 Export
          </button>
          <button onClick={onRefreshRoads}
            style={{ flex: 1, padding: '6px 8px', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold', background: '#1565C0' }}>
            🗺 Re-fetch
          </button>
        </div>

        {/* Optimizer panel */}
        <div style={{ marginTop: 8, background: '#0a0a18', borderRadius: 6, padding: '8px 10px', border: '1px solid #1a1a2e' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
            <span style={{ fontSize: 10, color: '#555', textTransform: 'uppercase' as const, letterSpacing: 1 }}>Network Optimizer</span>
            <button onClick={onRunOptimizer}
              style={{ padding: '3px 8px', background: '#1a237e', color: '#82b1ff', border: '1px solid #283593', borderRadius: 4, cursor: 'pointer', fontSize: 10 }}>
              ▶ Run Now
            </button>
          </div>
          {lastOptResult ? (
            <div style={{ fontSize: 10, fontFamily: 'monospace', color: '#888' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Improvement</span>
                <span style={{ color: lastOptResult.improvement > 0.1 ? '#4CAF50' : '#FF9800' }}>
                  {(lastOptResult.improvement * 100).toFixed(1)}%
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Delay saved</span>
                <span style={{ color: '#ccc' }}>{Math.round(lastOptResult.baselineDelay - lastOptResult.estimatedDelay)}s</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Iterations</span>
                <span style={{ color: '#ccc' }}>{lastOptResult.iterationsRun} in {lastOptResult.elapsedMs}ms</span>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 10, color: '#444' }}>Runs every 30s automatically</div>
          )}
        </div>
      </div>

      {/* Signal Override */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Signal Override</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <button
            onClick={() => setOverrideMode('individual')}
            style={{ flex: 1, padding: '6px 8px', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold', background: overrideMode === 'individual' ? '#4CAF50' : '#333' }}
          >
            Individual
          </button>
          <button
            onClick={() => { setOverrideMode('route'); handleSelectRoute(); }}
            style={{ flex: 1, padding: '6px 8px', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold', background: overrideMode === 'route' ? '#FF9800' : '#333' }}
          >
            Route ({selectedRouteSignals.length})
          </button>
        </div>
        {overrideMode === 'individual' && !selectedSignal && (
          <div style={{ fontSize: 11, color: '#666', padding: '4px 0 8px' }}>
            Select a signal below to enable individual override
          </div>
        )}
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => handleOverride('N', 'GREEN')}
            style={{ flex: 1, padding: '8px 6px', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold', background: '#4CAF50' }}
          >
            NS Green
          </button>
          <button
            onClick={() => handleOverride('E', 'GREEN')}
            style={{ flex: 1, padding: '8px 6px', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold', background: '#2196F3' }}
          >
            EW Green
          </button>
          <button
            onClick={() => handleOverride('N', 'RED')}
            style={{ flex: 1, padding: '8px 6px', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold', background: '#f44336' }}
          >
            All Red
          </button>
        </div>
        {overrideActive && (
          <button
            onClick={onCancelOverride}
            style={{ width: '100%', padding: '6px', background: '#FF9800', color: '#000', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold', marginTop: 8 }}
          >
            Cancel Override (Esc)
          </button>
        )}
      </div>

      {/* Firestore Overrides */}
      {user && fsOverrides.filter(o => o.controllerId !== user.uid).length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Firestore Overrides</div>
          {fsOverrides.filter(o => o.controllerId !== user.uid).map((o) => (
            <div key={o.id} style={{
              display: 'flex', gap: 6, padding: '4px 0', fontSize: 10, fontFamily: 'monospace',
              borderBottom: '1px solid #1a1a2e',
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0, marginTop: 3,
                background: o.color === 'GREEN' ? '#4CAF50' : o.color === 'YELLOW' ? '#FFD600' : '#f44336',
              }} />
              <span style={{ color: '#888' }}>{o.signalId}</span>
              <span style={{ color: '#555' }}>{o.direction}</span>
              <span style={{ color: '#fff', fontWeight: 'bold' }}>{o.color}</span>
              <span style={{ color: '#444', marginLeft: 'auto' }}>
                {o.controllerId.slice(0, 6)}…
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Signal list with search */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Signals ({filteredSignals.length} / {signalList.length})</div>
        <input
          type="text"
          value={signalSearch}
          onChange={e => setSignalSearch(e.target.value)}
          placeholder="Search by ID…"
          style={styles.searchInput}
        />
        <div style={{ maxHeight: 260, overflow: 'auto' }}>
          {filteredSignals.map((sig) => {
            const phase = sig.phases[sig.currentPhaseIndex];
            const isGreen = phase.color === 'GREEN';
            const isSelected = selectedSignal === sig.id;
            const inRoute = selectedRouteSignals.includes(sig.id);
            return (
              <div
                key={sig.id}
                onClick={() => setSelectedSignal(isSelected ? null : sig.id)}
                style={{
                  display: 'flex', gap: 8, padding: '6px 4px', cursor: 'pointer', borderRadius: 4,
                  background: isSelected ? '#ffffff11' : inRoute ? '#FF980011' : 'transparent',
                  borderLeft: isSelected ? '3px solid #4CAF50' : inRoute ? '3px solid #FF9800' : '3px solid transparent',
                }}
              >
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: isGreen ? '#4CAF50' : phase.color === 'YELLOW' ? '#FFD600' : '#f44336', flexShrink: 0, marginTop: 2 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#fff', fontWeight: 'bold' }}>{sig.id}</span>
                    <span style={{ color: isGreen ? '#4CAF50' : '#f44336', fontSize: 10, fontWeight: 'bold' }}>{phase.color}</span>
                  </div>
                  {isSelected && (
                    <div style={{ marginTop: 4, background: '#ffffff08', borderRadius: 4, padding: 6, fontSize: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                        <span style={{ color: '#888' }}>Location</span>
                        <span style={{ color: '#fff' }}>
                          {graph.nodes.get(sig.nodeId)?.lat.toFixed(4)}, {graph.nodes.get(sig.nodeId)?.lng.toFixed(4)}
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                        <span style={{ color: '#888' }}>Cycle</span>
                        <span style={{ color: '#fff' }}>{sig.cycleLength}s</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                        <span style={{ color: '#888' }}>Congestion</span>
                        <span style={{ color: sig.congestionLevel > 0.5 ? '#FF1744' : '#4CAF50' }}>
                          {Math.round(sig.congestionLevel * 100)}%
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#888' }}>Adaptive</span>
                        <span style={{ color: sig.adaptiveTiming ? '#4CAF50' : '#FF9800' }}>
                          {sig.adaptiveTiming ? 'ON' : 'OVERRIDE'}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {filteredSignals.length === 0 && (
            <div style={{ fontSize: 11, color: '#555', padding: '8px 0' }}>No signals match "{signalSearch}"</div>
          )}
        </div>
      </div>

      {/* Route analytics */}
      <div style={styles.section}>
        <button
          onClick={() => setShowAnalytics(!showAnalytics)}
          style={{ width: '100%', padding: '6px', background: '#1a1a2e', color: '#ccc', border: '1px solid #333', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}
        >
          {showAnalytics ? '▲' : '▼'} Route Analytics ({userRoutes.length} routes)
        </button>
        {showAnalytics && (
          <div style={{ marginTop: 8 }}>
            {userRoutes.length === 0 && <div style={{ fontSize: 11, color: '#555' }}>No routes submitted yet</div>}
            {userRoutes.slice(-8).reverse().map((r) => (
              <div key={r.id} style={{ padding: '5px 0', borderBottom: '1px solid #1a1a2e' }}>
                <div style={{ fontSize: 11 }}>
                  <span style={{ color: '#4CAF50' }}>{r.sourceName}</span>
                  <span style={{ color: '#444', margin: '0 4px' }}>→</span>
                  <span style={{ color: '#FF5722' }}>{r.destName}</span>
                </div>
                <div style={{ fontSize: 10, color: '#555', marginTop: 2 }}>
                  {new Date(r.timestamp).toLocaleTimeString()} · {r.signalOverrides.length} signals
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overrideIndicator: {
    background: '#FF9800', color: '#000', padding: '3px 10px',
    borderRadius: 4, fontSize: 10, fontWeight: 'bold', marginBottom: 8, display: 'inline-block',
  },
  section: { padding: '10px 0', borderBottom: '1px solid #1e1e2e' },
  sectionTitle: { fontSize: 10, color: '#666', textTransform: 'uppercase' as const, marginBottom: 8, fontWeight: 'bold', letterSpacing: 1 },
  statGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 },
  statBox: { background: '#ffffff08', borderRadius: 6, padding: 8, textAlign: 'center' as const },
  statNum: { fontSize: 13, fontWeight: 'bold', color: '#fff' },
  statLbl: { fontSize: 9, color: '#666', marginTop: 2, textTransform: 'uppercase' as const },
  searchInput: {
    width: '100%', padding: '6px 8px', background: '#1a1a2e', border: '1px solid #333',
    borderRadius: 4, color: '#fff', fontSize: 11, marginBottom: 6, boxSizing: 'border-box' as const,
    outline: 'none',
  },
};
