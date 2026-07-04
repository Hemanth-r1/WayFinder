import { useRef, useState, useEffect, useCallback } from 'react';
import { AuthProvider } from './context/AuthContext';
import { useAuth } from './context/useAuth';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LoadingOverlay } from './components/LoadingSpinner';
import LoginScreen from './components/LoginScreen';
import MapView from './components/MapView';
import RoleSelector from './components/RoleSelector';
import UserPanel from './roles/UserPanel';
import SupporterPanel from './roles/SupporterPanel';
import ControllerPanel from './roles/ControllerPanel';
import { TrafficEngine } from './engine/TrafficEngine';
import type { Direction, SignalColor, VehicleType, OptimizationResult, RouteInfo } from './types';
import type { UserRoute } from './types/roles';
import { downloadStatsJSON, buildExportPayload } from './utils/exportStats';
import ToastContainer from './components/Toast';

const TOD_COLOR: Record<string, string> = {
  early_morning: '#1a237e', morning_rush: '#e65100', midday: '#f9a825', evening_rush: '#bf360c', night: '#0d47a1',
};
const TOD_ICON: Record<string, string> = { early_morning: '🌙', morning_rush: '🌅', midday: '☀️', evening_rush: '🌆', night: '🌃' };

function AppContent() {
  const { user, role, loading: authLoading } = useAuth();
  const engineRef = useRef<TrafficEngine | null>(null);
  const frameRef = useRef(0);
  const lastTimeRef = useRef(0);
  const pausedRef = useRef(false);
  const overrideActiveRef = useRef(false);

  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
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
  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null);
  const [navigatedVehicle, setNavigatedVehicle] = useState(false);
  const [speed, setSpeed] = useState(1);
  const speedRef = useRef(1);
  const [showHeatmap, setShowHeatmap] = useState(true);
  useEffect(() => { speedRef.current = speed; }, [speed]);

  // ── Engine boot (progressive) ─────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    const engine = new TrafficEngine();
    engineRef.current = engine;

    // Map renders immediately — graph updates trickle in
    engine.onGraphUpdate = (phase: string) => {
      if (!active) return;
      setLoading(engine.loading);
      if (phase !== 'empty' && phase !== 'fetching') {
        setLoadError(null);
        setEngineState(prev => ({
          ...prev,
          nodeCount: engine.graph.nodes.size,
          edgeCount: engine.graph.edges.size,
          signalCount: engine.signals.size,
          graphVersion: engine.dataVersion,
        }));
      }
    };

    engine.init().then(() => {
      if (!active) return;
      setLoading(false);
      engine.start();

      const loop = (time: number) => {
        if (!active) return;
        const rawDelta = lastTimeRef.current ? (time - lastTimeRef.current) / 1000 * speedRef.current : 0;
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
              graphVersion: engine.dataVersion,
            };
            if (prev.vehicleCount === next.vehicleCount && prev.signalCount === next.signalCount
                && prev.nodeCount === next.nodeCount && prev.avgSpeed === next.avgSpeed && prev.graphVersion === next.graphVersion) return prev;
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
        case 's': case 'S':
          engineRef.current?.spawnVehicleFromDirection(
            (['N', 'S', 'E', 'W'] as Direction[])[Math.floor(Math.random() * 4)]
          );
          break;
        case 'h': case 'H':
          setShowHeatmap(p => !p);
          break;
        case '1': setSpeed(0.5); break;
        case '2': setSpeed(1); break;
        case '3': setSpeed(2); break;
        case '4': setSpeed(4); break;
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

  /** Convert Direction (N/S/E/W) to NS/EW group */
  const toGroup = useCallback((d: string): 'NS' | 'EW' => {
    if (d === 'NS' || d === 'EW') return d as 'NS' | 'EW';
    return (d === 'N' || d === 'S') ? 'NS' : 'EW';
  }, []);

  const handleManualOverride = useCallback((signalId: string, direction: string, color: string) => {
    engineRef.current?.manualOverrideSignal(signalId, toGroup(direction), color as SignalColor);
    setOverrideActive(true); overrideActiveRef.current = true;
  }, [toGroup]);

  const handleRouteOverride = useCallback((routeSignals: string[], direction: string, color: SignalColor) => {
    for (const sigId of routeSignals) engineRef.current?.manualOverrideSignal(sigId, toGroup(direction), color);
    setOverrideActive(true); overrideActiveRef.current = true;
  }, [toGroup]);

  const handleCancelOverride = useCallback(() => {
    engineRef.current?.deactivateManualOverride();
    setOverrideActive(false); overrideActiveRef.current = false;
  }, []);

  const handleAddSignal = useCallback((nodeId: string, _lat: number, _lng: number) => {
    engineRef.current?.addSignalAtNode(nodeId);
  }, []);

  const handleSpawnVehicleAt = useCallback((nodeId: string, type: VehicleType) => {
    engineRef.current?.spawnVehicleAtNode(nodeId, type);
  }, []);

  const handleSpawnEmergency = useCallback(() => {
    engineRef.current?.spawnEmergencyVehicle();
  }, []);

  const handleExportStats = useCallback(() => {
    const e = engineRef.current; if (!e) return;
    downloadStatsJSON(buildExportPayload(e.stats, e.congestionZones, [] as UserRoute[], e.signals.size, e.graph.nodes.size, e.simClock));
  }, []);

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

  const handleStartNavigation = useCallback(() => {
    const e = engineRef.current; if (!e) return;
    if (!selectedSource || !selectedDest) return;
    const r = e.computeRoute(selectedSource, selectedDest);
    if (!r) return;
    setRouteInfo(r);
    const v = e.spawnNavigatedVehicle(selectedSource, selectedDest);
    if (v) setNavigatedVehicle(true);
  }, [selectedSource, selectedDest]);

  const handleClearRoute = useCallback(() => {
    setRouteInfo(null);
    setNavigatedVehicle(false);
  }, []);

  const handleExportSignals = useCallback(async () => {
    const e = engineRef.current; if (!e) return;
    const json = await e.exportSignalsToJSON();
    if (!json) return;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'signals.json'; a.click();
    URL.revokeObjectURL(url);
  }, []);

  if (authLoading) return <LoadingOverlay message="Loading..." />;
  if (!user) return <LoginScreen />;

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

        {/* Loading indicator — always visible until full data arrives */}
        {loading && (
          <div style={{ margin: '8px 14px', padding: '6px 10px', background: '#4488FF11', border: '1px solid #4488FF33', borderRadius: 6, fontSize: 10, color: '#4488FF' }}>
            <span>⏳ Loading: {engineRef.current?.loadingPhase === 'fetching' ? 'Fetching from Overpass API…' : engineRef.current?.loadingPhase === 'signals' ? 'Signal markers loaded, fetching roads…' : 'Loading road network…'}</span>
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
          {role === 'user' && (
            <UserPanel
              graph={e?.graph ?? { nodes: new Map(), edges: new Map(), adjacency: new Map() }}
              signals={e?.signals ?? new Map()}
              selectedSource={selectedSource} selectedDest={selectedDest}
              onSelectSource={setSelectedSource} onSelectDest={setSelectedDest}
            />
          )}
          {role === 'supporter' && (
            <SupporterPanel
              graph={e?.graph ?? { nodes: new Map(), edges: new Map(), adjacency: new Map() }}
              signals={e?.signals ?? new Map()}
            />
          )}
          {role === 'controller' && (
            <ControllerPanel
              graph={e?.graph ?? { nodes: new Map(), edges: new Map(), adjacency: new Map() }}
              signals={e?.signals ?? new Map()}
              congestionZones={e?.congestionZones ?? []} userRoutes={[] as UserRoute[]}
              stats={e?.stats ?? {
                totalVehicles: 0, avgSpeed: 0, avgDelay: 0, congestionHotspots: 0,
                greenWaveActive: false, signalCoordinationScore: 0, throughput: 0, maxCongestion: 0,
              }}
              onOverrideSignal={handleManualOverride}
              onOverrideRoute={handleRouteOverride}
              onCancelOverride={handleCancelOverride}
              onSpawnEmergency={handleSpawnEmergency}
              onExportStats={handleExportStats}
              onExportSignals={handleExportSignals}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 10, color: '#888', minWidth: 40 }}>Speed</span>
            <input
              type="range" min="0.5" max="4" step="0.5"
              value={speed}
              onChange={(e) => setSpeed(parseFloat(e.target.value))}
              style={{ flex: 1, accentColor: '#FF6D00', height: 4 }}
            />
            <span style={{ color: '#fff', fontWeight: 'bold', fontSize: 12, minWidth: 28, textAlign: 'right' }}>
              {speed}×
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <button onClick={handleTogglePause} style={{ flex: 1, padding: '9px', background: paused ? '#4CAF50' : '#FF6D00', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}>
              {paused ? '▶ Resume' : '⏸ Pause'}
            </button>
            <button onClick={() => setShowHeatmap(p => !p)} style={{ flex: 1, padding: '9px', background: showHeatmap ? 'rgba(68,136,255,0.25)' : '#222', color: '#fff', border: `1px solid ${showHeatmap ? '#4488FF' : '#444'}`, borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}>
              🔥 Heatmap
            </button>
          </div>
          <div style={{ fontSize: 9, color: '#444', textAlign: 'center', fontFamily: 'monospace', marginBottom: 3 }}>
            <kbd style={{ background: '#111', padding: '1px 4px', border: '1px solid #333', borderRadius: 2 }}>Space</kbd> pause ·{' '}
            <kbd style={{ background: '#111', padding: '1px 4px', border: '1px solid #333', borderRadius: 2 }}>S</kbd> spawn ·{' '}
            <kbd style={{ background: '#111', padding: '1px 4px', border: '1px solid #333', borderRadius: 2 }}>E</kbd> emergency ·{' '}
            <kbd style={{ background: '#111', padding: '1px 4px', border: '1px solid #333', borderRadius: 2 }}>H</kbd> heatmap ·{' '}
            <kbd style={{ background: '#111', padding: '1px 4px', border: '1px solid #333', borderRadius: 2 }}>1-4</kbd> speed ·{' '}
            <kbd style={{ background: '#111', padding: '1px 4px', border: '1px solid #333', borderRadius: 2 }}>Esc</kbd> cancel
          </div>
          <div style={{ fontSize: 10, color: '#555', textAlign: 'center', fontFamily: 'monospace' }}>
            {engineState.vehicleCount}v · {engineState.signalCount}s · {engineState.nodeCount}n
          </div>
        </div>
      </div>

      {/* ── Map (always visible) ─────────────────────────────────────────── */}
      <div style={{ flex: 1, height: '100vh', position: 'relative' }}>
        <MapView
          graph={e?.graph ?? { nodes: new Map(), edges: new Map(), adjacency: new Map() }}
          signals={e?.signals ?? new Map()}
          vehicles={e?.vehicles ?? new Map()}
          congestionZones={e?.congestionZones ?? []}
          onNodeClick={handleNodeClick}
          onCancelOverride={handleCancelOverride}
          overrideActive={overrideActive} overrideTimeRemaining={overrideTimeRemaining}
          selectedSource={selectedSource} selectedDest={selectedDest}
          onSelectSource={setSelectedSource} onSelectDest={setSelectedDest}
          role={role} graphVersion={engineState.graphVersion}
          vehicleVersion={engineState.graphVersion}
          stats={engineState}
          onAddSignal={handleAddSignal}
          onSpawnVehicleAt={handleSpawnVehicleAt}
          showHeatmap={showHeatmap}
          speed={speed}
          onSpeedChange={setSpeed}
          onStartNavigation={handleStartNavigation}
          routeInfo={routeInfo}
          clearRoute={handleClearRoute}
          navigatedVehicle={navigatedVehicle}
        />
      </div>
      <ToastContainer />
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
