import { useRef, useState, useEffect, useCallback } from 'react';
import { AuthProvider } from './context/AuthContext';
import { useAuth } from './context/useAuth';
import { ErrorBoundary } from './components/ErrorBoundary';
import MapView from './components/MapView';
import RoleSelector from './components/RoleSelector';
import UserPanel from './roles/UserPanel';
import SupporterPanel from './roles/SupporterPanel';
import ControllerPanel from './roles/ControllerPanel';
import { TrafficEngine } from './engine/TrafficEngine';
import type { Direction, SignalColor, VehicleType, OptimizationResult } from './types';
import type { UserRoute, SupporterSignal } from './types/roles';
import { downloadStatsJSON, buildExportPayload } from './utils/exportStats';

const TOD_COLOR: Record<string, string> = {
  early_morning: '#1a237e', morning_rush: '#e65100', midday: '#f9a825', evening_rush: '#bf360c', night: '#0d47a1',
};
const TOD_ICON: Record<string, string> = { early_morning: '🌙', morning_rush: '🌅', midday: '☀️', evening_rush: '🌆', night: '🌃' };
const PHASE_LABEL: Record<string, string> = { empty: 'Initializing...', signals: 'Loading signals...', cached: 'Loading cached data...', fallback: 'Using fallback network', full: 'Live OSM data' };

function AppContent() {
  const { role } = useAuth();
  const engineRef = useRef<TrafficEngine | null>(null);
  const frameRef = useRef(0);
  const lastTimeRef = useRef(0);
  const pausedRef = useRef(false);
  const overrideActiveRef = useRef(false);

  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingPhase, setLoadingPhase] = useState('empty');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [overrideActive, setOverrideActive] = useState(false);
  const [overrideTimeRemaining, setOverrideTimeRemaining] = useState(0);
  const [emergencyCount, setEmergencyCount] = useState(0);
  const [simTime, setSimTime] = useState('08:00');
  const [timeOfDay, setTimeOfDay] = useState('morning_rush');
  const [lastOptResult, setLastOptResult] = useState<OptimizationResult | null>(null);
  const [engineState, setEngineState] = useState({
    nodeCount: 0, edgeCount: 0, signalCount: 0, vehicleCount: 0,
    avgSpeed: 0, congestionHotspots: 0, greenWaveActive: false,
    signalCoordinationScore: 0, graphVersion: 0,
  });
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [selectedDest, setSelectedDest] = useState<string | null>(null);
  const [userRoutes, setUserRoutes] = useState<UserRoute[]>([]);
  const [addedSignals, setAddedSignals] = useState<SupporterSignal[]>([]);

  // ── Engine boot ───────────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    const engine = new TrafficEngine();
    engineRef.current = engine;

    engine.onGraphUpdate = (phase) => {
      if (!active) return;
      setEngineState(prev => ({
        ...prev,
        nodeCount: phase.nodes.size,
        edgeCount: phase.edges.size,
        signalCount: phase.signals.size,
        graphVersion: Date.now(),
      }));
      setLoadingPhase(phase.phase);
      if (phase.phase === 'fallback' || phase.phase === 'full' || phase.phase === 'cached') {
        if (active && !engine.loaded) {
          setLoading(false);
          engine.loaded = true;
        }
      }
    };

    engine.init().then(() => {
      if (!active) return;
      setLoading(false);
      if (!engine.loaded) engine.loaded = true;
      engine.start();
      console.log(`[WayFinder] Engine update [${engine.loadingPhase}]: ${engine.graph.nodes.size}n, ${engine.graph.edges.size}e, ${engine.signals.size}s`);

      const loop = (time: number) => {
        if (!active) return;
        const rawDelta = lastTimeRef.current ? (time - lastTimeRef.current) / 1000 : 0;
        lastTimeRef.current = time;
        const dt = Math.min(rawDelta, 0.05);

        if (!pausedRef.current && engine.running) engine.update(dt);

        if (engine.isManualOverrideActive()) {
          setOverrideActive(true); overrideActiveRef.current = true;
          setOverrideTimeRemaining(engine.getManualOverrideTimeRemaining());
        } else if (overrideActiveRef.current) {
          setOverrideActive(false); overrideActiveRef.current = false;
        }

        setEmergencyCount(engine.getEmergencyOverrideCount());

        if (Math.floor(time / 100) % 2 === 0) {
          setSimTime(`${String(engine.simClock.hour).padStart(2, '0')}:${String(engine.simClock.minute).padStart(2, '0')}`);
          setTimeOfDay(engine.timeOfDay);
          if (engine.lastOptimizationResult) setLastOptResult(engine.lastOptimizationResult);
          setEngineState(prev => {
            const next = {
              nodeCount: engine.graph.nodes.size,
              edgeCount: engine.graph.edges.size,
              signalCount: engine.signals.size,
              vehicleCount: engine.vehicles.size,
              avgSpeed: engine.stats.avgSpeed,
              congestionHotspots: engine.stats.congestionHotspots,
              greenWaveActive: engine.stats.greenWaveActive,
              signalCoordinationScore: engine.stats.signalCoordinationScore,
              graphVersion: Date.now(),
            };
            if (prev.vehicleCount === next.vehicleCount && prev.signalCount === next.signalCount
                && prev.nodeCount === next.nodeCount && prev.avgSpeed === next.avgSpeed) return prev;
            return next;
          });
        }

        frameRef.current = requestAnimationFrame(loop);
      };
      frameRef.current = requestAnimationFrame(loop);
    }).catch(err => {
      if (!active) return;
      console.error(err); setLoadError(String(err)); setLoading(false);
    });

    return () => {
      active = false;
      cancelAnimationFrame(frameRef.current);
      engineRef.current?.stop();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case ' ': case 'p': case 'P':
          e.preventDefault();
          pausedRef.current = !pausedRef.current; setPaused(pausedRef.current); break;
        case 'Escape':
          if (overrideActiveRef.current) {
            engineRef.current?.deactivateManualOverride();
            setOverrideActive(false); overrideActiveRef.current = false;
          }
          break;
        case 'e': case 'E':
          engineRef.current?.spawnEmergencyVehicle(); break;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleTogglePause = useCallback(() => {
    pausedRef.current = !pausedRef.current; setPaused(pausedRef.current);
  }, []);

  const handleNodeClick = useCallback(() => {}, []);

  const handleManualOverride = useCallback((signalId: string, direction: string, color: string) => {
    engineRef.current?.manualOverrideSignal(signalId, direction as Direction, color as SignalColor);
    setOverrideActive(true); overrideActiveRef.current = true;
  }, []);

  const handleRouteOverride = useCallback((routeSignals: string[], direction: Direction, color: SignalColor) => {
    for (const sigId of routeSignals) engineRef.current?.manualOverrideSignal(sigId, direction, color);
    setOverrideActive(true); overrideActiveRef.current = true;
  }, []);

  const handleCancelOverride = useCallback(() => {
    engineRef.current?.deactivateManualOverride();
    setOverrideActive(false); overrideActiveRef.current = false;
  }, []);

  const handleSubmitRoute = useCallback((route: UserRoute) => {
    setUserRoutes(prev => [...prev, route]);
  }, []);

  const handleAddSignal = useCallback((nodeId: string, lat: number, lng: number) => {
    const e = engineRef.current; if (!e) return;
    const added = e.addSignalAtNode(nodeId);
    if (added) {
      setAddedSignals(prev => [
        ...prev,
        { id: `sup_${Date.now()}`, supporterId: 'current', lat, lng, roadName: nodeId, signalType: 'smart', timestamp: Date.now(), notes: '' },
      ]);
    }
  }, []);

  const handleSpawnVehicleAt = useCallback((nodeId: string, type: VehicleType) => {
    engineRef.current?.spawnVehicleAtNode(nodeId, type);
  }, []);

  const handleSpawnEmergency = useCallback(() => {
    engineRef.current?.spawnEmergencyVehicle();
  }, []);

  const handleExportStats = useCallback(() => {
    const e = engineRef.current; if (!e) return;
    downloadStatsJSON(buildExportPayload(e.stats, e.congestionZones, userRoutes, e.signals.size, e.graph.nodes.size, e.simClock));
  }, [userRoutes]);

  const handleRunOptimizer = useCallback(() => {
    const result = engineRef.current?.runOptimizerNow();
    if (result) setLastOptResult(result);
  }, []);

  const handleRefreshRoads = useCallback(async () => {
    if (!engineRef.current) return;
    setLoading(true);
    await engineRef.current.refreshRoadData();
    setLoading(false);
  }, []);

  const e = engineRef.current;

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', margin: 0, padding: 0, overflow: 'hidden' }}>
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <div style={{
        width: 340, minWidth: 340, height: '100vh', display: 'flex', flexDirection: 'column',
        background: 'rgba(8,8,18,0.99)', borderRight: '1px solid #222', zIndex: 1001,
        fontFamily: 'system-ui, sans-serif',
      }}>
        {/* Header */}
        <div style={{
          padding: '10px 14px', borderBottom: '1px solid #222',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          background: 'rgba(15,15,28,0.98)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}>🚦</span>
            <span style={{ fontSize: 14, fontWeight: 'bold', color: '#fff' }}>WayFinder</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {(loading || loadingPhase !== 'full') && (
              <span style={{
                fontSize: 9, padding: '2px 6px', borderRadius: 4,
                background: '#FF6D0022', border: '1px solid #FF6D0044', color: '#FF9800',
              }}>
                {PHASE_LABEL[loadingPhase] || loadingPhase}
              </span>
            )}
            <div style={{
              background: `${TOD_COLOR[timeOfDay] ?? '#333'}22`,
              border: `1px solid ${TOD_COLOR[timeOfDay] ?? '#444'}55`,
              borderRadius: 6, padding: '2px 8px', fontSize: 10,
              fontFamily: 'monospace', color: '#aaa', display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <span>{TOD_ICON[timeOfDay] ?? '🕐'}</span>
              <span>{simTime}</span>
            </div>
            <RoleSelector />
          </div>
        </div>

        {/* Emergency alert */}
        {emergencyCount > 0 && (
          <div style={{ background: '#FF174415', borderBottom: '1px solid #FF174433', padding: '4px 14px', fontSize: 10, color: '#FF5252', fontWeight: 'bold' }}>
            🚨 {emergencyCount} emergency signal {emergencyCount === 1 ? 'override' : 'overrides'} active
          </div>
        )}

        {/* Error banner */}
        {loadError && (
          <div style={{ margin: 8, padding: 8, background: '#FF980011', border: '1px solid #FF980033', borderRadius: 6 }}>
            <div style={{ color: '#FF9800', fontSize: 11, fontWeight: 'bold' }}>⚠ Synthetic fallback network</div>
            <div style={{ color: '#666', fontSize: 10, marginTop: 2 }}>{loadError}</div>
          </div>
        )}

        {/* Role panels */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {role === 'user' && e && (
            <UserPanel
              graph={e.graph} signals={e.signals}
              selectedSource={selectedSource} selectedDest={selectedDest}
              onSelectSource={setSelectedSource} onSelectDest={setSelectedDest}
              onSubmitRoute={handleSubmitRoute} submittedRoutes={userRoutes}
            />
          )}
          {role === 'supporter' && e && (
            <SupporterPanel
              graph={e.graph} signals={e.signals}
              onAddSignal={handleAddSignal} addedSignals={addedSignals}
            />
          )}
          {role === 'controller' && e && (
            <ControllerPanel
              graph={e.graph} signals={e.signals}
              congestionZones={e.congestionZones} userRoutes={userRoutes}
              stats={e.stats}
              onOverrideSignal={handleManualOverride}
              onOverrideRoute={handleRouteOverride}
              onCancelOverride={handleCancelOverride}
              onSpawnEmergency={handleSpawnEmergency}
              onExportStats={handleExportStats}
              onRunOptimizer={handleRunOptimizer}
              onRefreshRoads={handleRefreshRoads}
              lastOptResult={lastOptResult}
              overrideActive={overrideActive}
              overrideTimeRemaining={overrideTimeRemaining}
            />
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '8px 14px', borderTop: '1px solid #1a1a2e', background: 'rgba(15,15,28,0.98)' }}>
          <button onClick={handleTogglePause} style={{
            width: '100%', padding: '9px', marginBottom: 6,
            background: paused ? '#4CAF50' : '#FF6D00', color: '#fff',
            border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 'bold',
          }}>
            {paused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <div style={{ fontSize: 9, color: '#444', textAlign: 'center', fontFamily: 'monospace', marginBottom: 3 }}>
            <kbd style={{ background: '#111', padding: '1px 4px', border: '1px solid #333', borderRadius: 2 }}>Space</kbd> pause ·{' '}
            <kbd style={{ background: '#111', padding: '1px 4px', border: '1px solid #333', borderRadius: 2 }}>E</kbd> emergency ·{' '}
            <kbd style={{ background: '#111', padding: '1px 4px', border: '1px solid #333', borderRadius: 2 }}>Esc</kbd> cancel override
          </div>
          <div style={{ fontSize: 10, color: '#555', textAlign: 'center', fontFamily: 'monospace' }}>
            {engineState.vehicleCount}v · {engineState.signalCount}s · {engineState.nodeCount}n
          </div>
        </div>
      </div>

      {/* ── Map ──────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, height: '100vh', position: 'relative' }}>
        {e && (
          <MapView
            graph={e.graph} signals={e.signals} vehicles={e.vehicles}
            congestionZones={e.congestionZones} onNodeClick={handleNodeClick}
            onCancelOverride={handleCancelOverride}
            overrideActive={overrideActive} overrideTimeRemaining={overrideTimeRemaining}
            selectedSource={selectedSource} selectedDest={selectedDest}
            onSelectSource={setSelectedSource} onSelectDest={setSelectedDest}
            role={role} graphVersion={engineState.graphVersion}
            vehicleVersion={engineState.vehicleCount}
            stats={engineState}
            onAddSignal={handleAddSignal}
            onSpawnVehicleAt={handleSpawnVehicleAt}
          />
        )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </ErrorBoundary>
  );
}
