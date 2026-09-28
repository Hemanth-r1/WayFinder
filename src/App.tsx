import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AuthProvider } from './context/AuthContext';
import { useAuth } from './context/useAuth';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LoadingOverlay } from './components/LoadingSpinner';
import LoginScreen from './components/LoginScreen';
import MapView from './components/MapView';
import RoleSelector from './components/RoleSelector';
import UserPanel, { type RecentTrip } from './roles/UserPanel';
import SupporterPanel from './roles/SupporterPanel';
import ControllerPanel from './roles/ControllerPanel';
import NavigationGuide from './components/NavigationGuide';
import { progressiveLoader, type LoadUpdate, type LoadPhase } from './services/progressiveLoader';
import { serverClient } from './services/serverClient';
import type { RoadGraph, TrafficSignal, Vehicle } from './types';
import type { ServerStats, RouteOption, NavigationResponse } from './services/serverClient';
import ToastContainer, { pushToast } from './components/Toast';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './config/firebase';
import { useIsMobile } from './hooks/useIsMobile';
import { nodeLabel, snapToRoad, currentPosition, googleMapsUrl, type Place } from './utils/places';

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
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [destLabel, setDestLabel] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [starting, setStarting] = useState(false);
  const isMobile = useIsMobile();
  const simpleView = role === 'user';
  const [graphVersion, setGraphVersion] = useState(0);
  const [routeOptions, setRouteOptions] = useState<RouteOption[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [navigation, setNavigation] = useState<NavigationResponse | null>(null);
  const navigatedVehicle = navigation !== null;
  const navigatingRef = useRef(false);
  navigatingRef.current = navigatedVehicle;
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [speed, setSpeed] = useState(1);

  // Initialize progressive loading
  useEffect(() => {
    const onLoad = (update: LoadUpdate) => {
      setLoadingPhase(update.phase);
      setLoadSource(update.source);
      
      if (update.graph) {
        setGraph(update.graph);
        setGraphVersion(v => v + 1);
      }
      if (update.signals) setSignals(update.signals);
      if (update.vehicles) setVehicles(update.vehicles);
      if (update.stats) setStats(update.stats);
      
      if (update.phase === 'full') {
        setLoading(false);
      }
    };
    progressiveLoader.onUpdate(onLoad);
    progressiveLoader.load();

    // Connect WebSocket for real-time updates
    serverClient.connectWebSocket(user?.uid);
    const onServerUpdate = (data: any) => {
      if ((data.type === 'update' || data.type === 'initial') && data.data) {
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
    };
    serverClient.onUpdate(onServerUpdate);

    return () => {
      progressiveLoader.removeUpdateCallback(onLoad);
      serverClient.removeUpdateCallback(onServerUpdate);
      serverClient.disconnectWebSocket();
    };
  }, [user]);

  // Route options for the selected origin/destination. The server spreads users across
  // nearby routes, so options are fetched per user rather than computed locally.
  useEffect(() => {
    if (!selectedSource || !selectedDest || navigatedVehicle) {
      setRouteOptions([]);
      setRouteError(null);
      return;
    }
    const controller = new AbortController();
    setRouteLoading(true);
    setRouteError(null);
    serverClient.fetchRouteOptions(user?.uid, selectedSource, selectedDest, controller.signal)
      .then(options => {
        setRouteOptions(options);
        setSelectedRouteIndex(0);
        if (options.length === 0) setRouteError('No route found between these points');
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        setRouteOptions([]);
        setRouteError(err instanceof Error ? err.message : 'Failed to plan route');
      })
      .finally(() => {
        if (!controller.signal.aborted) setRouteLoading(false);
      });
    return () => controller.abort();
  }, [user, selectedSource, selectedDest, navigatedVehicle]);

  // ── Choosing places ──────────────────────────────────────────────────────
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const setSource = useCallback((id: string | null, label?: string) => {
    setSelectedSource(id);
    setSourceLabel(id ? label ?? nodeLabel(graphRef.current, id) : null);
  }, []);
  const setDest = useCallback((id: string | null, label?: string) => {
    setSelectedDest(id);
    setDestLabel(id ? label ?? nodeLabel(graphRef.current, id) : null);
  }, []);

  // Live navigation updates while driving
  useEffect(() => {
    if (!user || !navigatedVehicle) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const update = await serverClient.getUserNavigation(user.uid);
        if (cancelled) return;
        if (update.arrived) {
          pushToast('You have arrived at your destination', 'success');
          setNavigation(null);
          setSource(null);
          setDest(null);
          serverClient.removeUserVehicle(user.uid).catch(() => {});
          return;
        }
        setNavigation(prev => prev ? { ...update, alternatives: prev.alternatives } : prev);
      } catch (err) {
        console.error('Failed to get navigation update:', err);
      }
    };
    const interval = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [user, navigatedVehicle, setSource, setDest]);

  const snapPlace = useCallback((place: Place): string | null => {
    const node = snapToRoad(graphRef.current, place.lat, place.lng);
    if (!node) {
      pushToast(`${place.label} is outside the area WayFinder covers`, 'warning');
      return null;
    }
    return node.id;
  }, []);

  const handlePickSource = useCallback((place: Place) => {
    const id = snapPlace(place);
    if (id) setSource(id, place.label);
  }, [snapPlace, setSource]);
  const handlePickDest = useCallback((place: Place) => {
    const id = snapPlace(place);
    if (id) setDest(id, place.label);
  }, [snapPlace, setDest]);

  const handleUseLocation = useCallback(async () => {
    setLocating(true);
    try {
      const pos = await currentPosition();
      const id = snapPlace({ label: 'Your location', detail: '', source: 'gps', ...pos });
      if (id) setSource(id, 'My location');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Could not get your location', 'error');
    } finally {
      setLocating(false);
    }
  }, [snapPlace, setSource]);

  const handleSwap = useCallback(() => {
    const [s, sl, d, dl] = [selectedSource, sourceLabel, selectedDest, destLabel];
    setSource(d, dl ?? undefined);
    setDest(s, sl ?? undefined);
  }, [selectedSource, sourceLabel, selectedDest, destLabel, setSource, setDest]);

  const handlePickRecent = useCallback((trip: RecentTrip) => {
    const nodes = graphRef.current.nodes;
    if (!nodes.has(trip.sourceNodeId) || !nodes.has(trip.destNodeId)) {
      pushToast('That trip is no longer on the map — search for it again', 'warning');
      return;
    }
    setSource(trip.sourceNodeId, trip.sourceName);
    setDest(trip.destNodeId, trip.destName);
  }, [setSource, setDest]);

  // Refresh data
  const handleRefresh = useCallback(async () => {
    setLoading(true);
    await progressiveLoader.load(true);
  }, []);

  // Start navigation
  const handleStartNavigation = useCallback(async () => {
    if (!user || !selectedSource || !selectedDest) return;
    
    setStarting(true);
    try {
      const chosen = routeOptions[selectedRouteIndex];
      const nav = await serverClient.startNavigation(user.uid, selectedSource, selectedDest, chosen?.edgeIds);
      setNavigation(nav);
      setRouteOptions([]);
      if (db) {
        addDoc(collection(db, 'routes'), {
          userId: user.uid,
          sourceNodeId: selectedSource, destNodeId: selectedDest,
          sourceName: sourceLabel, destName: destLabel,
          createdAt: serverTimestamp(),
        }).catch(err => console.error('Failed to save trip:', err));
      }
    } catch (err) {
      console.error('Failed to start navigation:', err);
      pushToast(err instanceof Error ? err.message : 'Failed to start navigation', 'error');
    } finally {
      setStarting(false);
    }
  }, [user, selectedSource, selectedDest, sourceLabel, destLabel, routeOptions, selectedRouteIndex]);

  /**
   * Hands this user's route to Google Maps for voice guidance. The trip is still started in
   * WayFinder so the route counts as taken and the next drivers are spread elsewhere.
   */
  const handleOpenGoogleMaps = useCallback(() => {
    const geometry = navigation?.routeInfo.geometry ?? routeOptions[selectedRouteIndex]?.geometry;
    const url = geometry && googleMapsUrl(geometry, { navigate: isMobile });
    if (!url) return;
    // Open synchronously so pop-up blockers allow it
    window.open(url, '_blank', 'noopener');
    if (!navigation) handleStartNavigation();
  }, [navigation, routeOptions, selectedRouteIndex, isMobile, handleStartNavigation]);

  // Clear route
  const handleClearRoute = useCallback(() => {
    const wasNavigating = navigatingRef.current;
    setNavigation(null);
    setRouteOptions([]);
    if (user && wasNavigating) {
      serverClient.removeUserVehicle(user.uid).catch(err => console.error('Failed to end navigation:', err));
    }
  }, [user]);

  const selectedRoute = routeOptions[selectedRouteIndex] ?? null;
  const panelRoute = navigation?.routeInfo ?? selectedRoute;
  const routePolyline = useMemo<[number, number][] | undefined>(() => {
    const pts = navigation ? navigation.path : selectedRoute?.geometry;
    return pts?.map(p => [p.lat, p.lng] as [number, number]);
  }, [navigation, selectedRoute]);
  const altPolylines = useMemo(
    () => navigation ? [] : routeOptions
      .filter((_, i) => i !== selectedRouteIndex)
      .map(r => r.geometry.map(p => [p.lat, p.lng] as [number, number])),
    [navigation, routeOptions, selectedRouteIndex],
  );

  if (authLoading) return <LoadingOverlay message="Loading..." />;
  if (!user) return <LoginScreen />;

  const hideSidebar = isMobile && navigatedVehicle;

  return (
    <div style={{
      width: '100vw', height: '100dvh', display: 'flex', margin: 0, padding: 0, overflow: 'hidden',
      flexDirection: isMobile ? 'column-reverse' : 'row',
    }}>
      {/* Sidebar (bottom sheet on phones) */}
      <div style={{
        display: hideSidebar ? 'none' : 'flex', flexDirection: 'column',
        ...(isMobile
          ? { width: '100%', maxHeight: '52dvh', borderTop: '1px solid #222', borderRadius: '14px 14px 0 0' }
          : { width: 340, minWidth: 340, height: '100%', borderRight: '1px solid #222' }),
        background: 'rgba(8,8,18,0.99)', zIndex: 1001,
        fontFamily: 'system-ui, sans-serif',
      }}>
        {/* Header */}
        <div style={{
          padding: isMobile ? '8px 14px' : '10px 14px', borderBottom: '1px solid #222',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
          background: 'rgba(15,15,28,0.98)', borderRadius: isMobile ? '14px 14px 0 0' : 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}>🧭</span>
            <span style={{ fontSize: 15, fontWeight: 'bold', color: '#fff' }}>WayFinder</span>
            {loadingPhase !== 'full' && (
              <span style={{ fontSize: 10, color: '#FF9800' }}>{PHASE_LABEL[loadingPhase]}</span>
            )}
          </div>
          <RoleSelector />
        </div>

        {!loading && loadSource === 'error' && (
          <div style={{ margin: '8px 14px', fontSize: 11, color: '#F44336' }}>
            Could not reach the WayFinder server. <button onClick={handleRefresh} style={{ background: 'none', border: 'none', color: '#4488FF', cursor: 'pointer', padding: 0 }}>Retry</button>
          </div>
        )}

        {/* Role panels */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {role === 'user' && (
            <UserPanel
              graph={graph}
              sourceLabel={sourceLabel}
              destLabel={destLabel}
              onPickSource={handlePickSource}
              onPickDest={handlePickDest}
              onClearSource={() => setSource(null)}
              onClearDest={() => setDest(null)}
              onSwap={handleSwap}
              onUseLocation={handleUseLocation}
              locating={locating}
              onPickRecent={handlePickRecent}
              routeOptions={routeOptions}
              selectedRouteIndex={selectedRouteIndex}
              onSelectRoute={setSelectedRouteIndex}
              routeLoading={routeLoading}
              routeError={routeError}
              navigating={navigatedVehicle}
              starting={starting}
              onStart={handleStartNavigation}
              onOpenGoogleMaps={handleOpenGoogleMaps}
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

        {/* Footer: operator tools (hidden for drivers) */}
        {!simpleView && (
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
        )}
      </div>

      {/* Map */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
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
          onSelectSource={setSource}
          onSelectDest={setDest}
          role={role}
          graphVersion={graphVersion}
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
          routePolyline={routePolyline}
          altRoutePolylines={altPolylines}
          onStartNavigation={handleStartNavigation}
          routeInfo={panelRoute}
          clearRoute={handleClearRoute}
          navigatedVehicle={navigatedVehicle}
          simpleView={simpleView}
          compact={isMobile}
        />
      </div>

      {/* Navigation Guide Overlay */}
      {navigation && (
        <NavigationGuide
          navigation={navigation}
          onClear={handleClearRoute}
          onOpenGoogleMaps={handleOpenGoogleMaps}
          destLabel={destLabel}
          isMobile={isMobile}
        />
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
