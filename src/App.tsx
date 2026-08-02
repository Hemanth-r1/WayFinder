import { useState, useEffect, useCallback } from 'react';
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
import NavigationGuide from './components/NavigationGuide';
import { progressiveLoader, type LoadUpdate, type LoadPhase } from './services/progressiveLoader';
import { serverClient } from './services/serverClient';
import type { RoadGraph, TrafficSignal, Vehicle } from './types';
import type { ServerStats } from './services/serverClient';
import ToastContainer from './components/Toast';

const PHASE_LABEL: Record<LoadPhase, string> = {
  empty: 'Initializing...', map: 'Loading map tiles...', roads: 'Loading road network...', signals: 'Loading signals...', vehicles: 'Loading vehicles...', full: 'Live data',
};

function AppContent() {
  const { user, role, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [loadingPhase, setLoadingPhase] = useState<LoadPhase>('empty');
  const [loadSource, setLoadSource] = useState('none');
  const [graph, setGraph] = useState<RoadGraph>({ nodes: new Map(), edges: new Map(), adjacency: new Map() });
  const [signals, setSignals] = useState<Map<string, TrafficSignal>>(new Map());
  const [vehicles, setVehicles] = useState<Map<string, Vehicle>>(new Map());
  const [stats, setStats] = useState<ServerStats>({
    totalVehicles: 0, avgSpeed: 0, avgDelay: 0, congestionHotspots: 0,
    greenWaveActive: false, signalCoordinationScore: 0, throughput: 0, maxCongestion: 0,
    slaSpeed: 0, slaCompliant: false, emergencySlaSpeed: 0, activeCorridors: 0,
  });
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [selectedDest, setSelectedDest] = useState<string | null>(null);
  const [routeInfo, setRouteInfo] = useState<any>(null);
  const [navigatedVehicle, setNavigatedVehicle] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [speed, setSpeed] = useState(1);

  // Initialize progressive loading
  useEffect(() => {
    progressiveLoader.onUpdate((update: LoadUpdate) => {
      setLoadingPhase(update.phase);
      setLoadSource(update.source);
      
      if (update.graph) setGraph(update.graph);
      if (update.signals) setSignals(update.signals);
      if (update.vehicles) setVehicles(update.vehicles);
      if (update.stats) setStats(update.stats);
      
      if (update.phase === 'full') {
        setLoading(false);
      }
    });

    progressiveLoader.load();

    // Connect WebSocket for real-time updates
    serverClient.connectWebSocket(user?.uid);
    serverClient.onUpdate((data) => {
      if (data.type === 'update' && data.data) {
        if (data.data.vehicles) {
          setVehicles(new Map(data.data.vehicles.map((v: any) => [v.id, v])));
        }
        if (data.data.signals) {
          setSignals(new Map(data.data.signals.map((s: any) => [s.id, s])));
        }
        if (data.data.stats) {
          setStats(data.data.stats);
        }
      }
    });

    return () => {
      serverClient.disconnectWebSocket();
    };
  }, [user]);

  // Refresh data
  const handleRefresh = useCallback(async () => {
    setLoading(true);
    await progressiveLoader.load(true);
  }, []);

  // Start navigation
  const handleStartNavigation = useCallback(async () => {
    if (!user || !selectedSource || !selectedDest) return;
    
    try {
      const navigation = await serverClient.startNavigation(user.uid, selectedSource, selectedDest);
      setRouteInfo(navigation);
      setNavigatedVehicle(true);
    } catch (err) {
      console.error('Failed to start navigation:', err);
    }
  }, [user, selectedSource, selectedDest]);

  // Clear route
  const handleClearRoute = useCallback(() => {
    setRouteInfo(null);
    setNavigatedVehicle(false);
    if (user) {
      serverClient.removeUserVehicle(user.uid);
    }
  }, [user]);

  if (authLoading) return <LoadingOverlay message="Loading..." />;
  if (!user) return <LoginScreen />;

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', margin: 0, padding: 0, overflow: 'hidden' }}>
      {/* Sidebar */}
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
                {PHASE_LABEL[loadingPhase]}
              </span>
            )}
            <div style={{
              background: '#33322',
              border: '1px solid #44455',
              borderRadius: 6, padding: '2px 8px', fontSize: 10,
              fontFamily: 'monospace', color: '#aaa', display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <span>🕐</span>
              <span>Live</span>
            </div>
            <RoleSelector />
          </div>
        </div>

        {/* Loading indicator */}
        {loading && (
          <div style={{ margin: '8px 14px', padding: '6px 10px', background: '#4488FF11', border: '1px solid #4488FF33', borderRadius: 6, fontSize: 10, color: '#4488FF' }}>
            <span>⏳ Loading from {loadSource}...</span>
          </div>
        )}

        {/* Role panels */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {role === 'user' && (
            <UserPanel
              graph={graph}
              signals={signals}
              selectedSource={selectedSource}
              selectedDest={selectedDest}
              onSelectSource={setSelectedSource}
              onSelectDest={setSelectedDest}
            />
          )}
          {role === 'supporter' && (
            <SupporterPanel
              graph={graph}
              signals={signals}
            />
          )}
          {role === 'controller' && (
            <ControllerPanel
              graph={graph}
              signals={signals}
              congestionZones={[]}
              userRoutes={[]}
              stats={stats}
              onOverrideSignal={() => {}}
              onOverrideRoute={() => {}}
              onCancelOverride={() => {}}
              onSpawnEmergency={() => {}}
              onExportStats={() => {}}
              onExportSignals={() => {}}
              onRunOptimizer={() => {}}
              onRefreshRoads={handleRefresh}
              lastOptResult={null}
              overrideActive={false}
              overrideTimeRemaining={0}
            />
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '8px 14px', borderTop: '1px solid #1a1a2e', background: 'rgba(15,15,28,0.98)' }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <button onClick={handleRefresh} style={{ flex: 1, padding: '9px', background: '#1565C0', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}>
              🔄 Refresh
            </button>
            <button onClick={() => setShowHeatmap(p => !p)} style={{ flex: 1, padding: '9px', background: showHeatmap ? 'rgba(68,136,255,0.25)' : '#222', color: '#fff', border: `1px solid ${showHeatmap ? '#4488FF' : '#444'}`, borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}>
              🔥 Heatmap
            </button>
          </div>
          <div style={{ fontSize: 10, color: '#555', textAlign: 'center', fontFamily: 'monospace' }}>
            {vehicles.size}v · {signals.size}s · {graph.nodes.size}n
          </div>
          <div style={{ fontSize: 10, textAlign: 'center', fontFamily: 'monospace', marginTop: 2 }}>
            <span style={{ color: stats.slaCompliant ? '#4CAF50' : '#F44336' }}>
              {stats.slaCompliant ? '✅' : '⚠️'} {stats.slaSpeed.toFixed(1)} km/h
            </span>
          </div>
        </div>
      </div>

      {/* Map */}
      <div style={{ flex: 1, height: '100vh', position: 'relative' }}>
        <MapView
          graph={graph}
          signals={signals}
          vehicles={vehicles}
          congestionZones={[]}
          onCancelOverride={() => {}}
          overrideActive={false}
          overrideTimeRemaining={0}
          selectedSource={selectedSource}
          selectedDest={selectedDest}
          onSelectSource={setSelectedSource}
          onSelectDest={setSelectedDest}
          role={role}
          graphVersion={0}
          vehicleVersion={0}
          stats={{
            vehicleCount: stats.totalVehicles,
            avgSpeed: stats.avgSpeed,
            congestionHotspots: stats.congestionHotspots,
            greenWaveActive: stats.greenWaveActive,
            signalCoordinationScore: stats.signalCoordinationScore,
          }}
          onAddSignal={() => {}}
          onSpawnVehicleAt={() => {}}
          showHeatmap={showHeatmap}
          speed={speed}
          onSpeedChange={setSpeed}
          onStartNavigation={handleStartNavigation}
          routeInfo={routeInfo}
          clearRoute={handleClearRoute}
          navigatedVehicle={navigatedVehicle}
        />
      </div>
      
      {/* Navigation Guide Overlay */}
      {routeInfo && navigatedVehicle && (
        <NavigationGuide routeInfo={routeInfo} onClear={handleClearRoute} />
      )}
      
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
