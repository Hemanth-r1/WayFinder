import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AuthProvider } from './context/AuthContext';
import { useAuth } from './context/useAuth';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LoadingOverlay } from './components/LoadingSpinner';
import LoginScreen from './components/LoginScreen';
import OfflineSetup from './components/OfflineSetup';
import { needsOfflineSetup } from './services/offlineMap';
import MapView from './components/MapView';
import RoleSelector from './components/RoleSelector';
import UserPanel, { type RecentTrip } from './roles/UserPanel';
import SupporterPanel from './roles/SupporterPanel';
import JunctionPanel from './roles/JunctionPanel';
import EmergencyPanel from './roles/EmergencyPanel';
import AdminPanel from './roles/AdminPanel';
import AboutCompany from './components/AboutCompany';
import { BrandLockup } from './components/BrandMark';
import { BRAND } from './brand';
import { isDriver, canControl } from './types/roles';
import MyDataCard from './components/MyDataCard';
import { keepDataOnDevice } from './services/userData';
import OfflineCard from './components/OfflineCard';
import { offlineRoute } from './utils/offlineRoute';
import NavigationGuide from './components/NavigationGuide';
import { progressiveLoader, type LoadUpdate, type LoadPhase } from './services/progressiveLoader';
import { serverClient } from './services/serverClient';
import type { RoadGraph, TrafficSignal, Vehicle } from './types';
import type {
  ServerStats, RouteOption, NavigationResponse, Conditions, WeatherMode, TrafficMode, ReportType, ReportVote, Behaviour, Jam, JamSeverity, CoordinationPlan, Corridor, EmergencyKind, Announcement,
} from './services/serverClient';
import { REPORT_LABEL } from './utils/reports';
import ConditionsPanel from './components/ConditionsPanel';
import ToastContainer, { pushToast } from './components/Toast';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db, isFirebaseReady } from './config/firebase';
import { useIsMobile } from './hooks/useIsMobile';
import { nodeLabel, snapToRoad, currentPosition, googleMapsUrl, type Place } from './utils/places';

const PHASE_LABEL: Record<LoadPhase, string> = {
  empty: 'Initializing...', map: 'Loading map tiles...', roads: 'Loading road network...', signals: 'Loading signals...', vehicles: 'Loading vehicles...', full: 'Live data',
};

function AppContent() {
  const [offlineSetup, setOfflineSetup] = useState(needsOfflineSetup);
  // Live data has arrived at least once (the server may still be waking up)
  const [liveReady, setLiveReady] = useState(false);
  const { user, role, loading: authLoading } = useAuth();

  // Every API call identifies the caller: a Firebase ID token, or the demo identity.
  // Set during render so it is in place before any effect below makes a request.
  const identityKey = `${user?.uid ?? ''}|${role}`;
  const lastIdentity = useRef('');
  if (lastIdentity.current !== identityKey) {
    lastIdentity.current = identityKey;
    serverClient.setIdentity(async (): Promise<Record<string, string>> => {
      if (!user) return {};
      if (isFirebaseReady) return { Authorization: `Bearer ${await user.getIdToken()}` };
      return { 'X-Demo-User': user.uid, 'X-Demo-Role': role };
    });
  }
  const [loading, setLoading] = useState(true);
  const [loadingPhase, setLoadingPhase] = useState<LoadPhase>('empty');
  const [loadSource, setLoadSource] = useState('none');
  const [graph, setGraph] = useState<RoadGraph>({ nodes: new Map(), edges: new Map(), adjacency: new Map() });
  const [signals, setSignals] = useState<Map<string, TrafficSignal>>(new Map());
  // Signal states arrive every few seconds; the device runs the cycle in between
  useEffect(() => {
    const t = window.setInterval(() => setSignals(prev => {
      if (prev.size === 0) return prev;
      const next = new Map<string, TrafficSignal>();
      for (const [id, s] of prev) {
        if (!s.phases.length) { next.set(id, s); continue; }
        let i = s.currentPhaseIndex % s.phases.length, timer = s.timer + 1;
        for (let guard = 0; timer >= s.phases[i].duration && guard < s.phases.length; guard++) {
          timer -= s.phases[i].duration;
          i = (i + 1) % s.phases.length;
        }
        next.set(id, i === s.currentPhaseIndex && timer === s.timer ? s : { ...s, currentPhaseIndex: i, timer });
      }
      return next;
    }), 1000);
    return () => window.clearInterval(t);
  }, []);
  const [vehicles, setVehicles] = useState<Map<string, Vehicle>>(new Map());
  const [traffic, setTraffic] = useState<Map<string, number>>(new Map());
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  /** Junction open in the police panel, and where the map should move to */
  const [selectedJunction, setSelectedJunction] = useState<string | null>(null);
  const [mapFocus, setMapFocus] = useState<{ lat: number; lng: number; zoom: number; key: number } | null>(null);
  // About panel (company info) and the admins' announcement banner (checked every 5 min)
  const [showAbout, setShowAbout] = useState(false);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  useEffect(() => {
    const load = () => serverClient.announcement().then(setAnnouncement).catch(() => {});
    load();
    const t = window.setInterval(load, 5 * 60 * 1000);
    return () => window.clearInterval(t);
  }, []);
  // Police: coordination preview drawn on the map while the console shows it
  const [coordPlan, setCoordPlan] = useState<CoordinationPlan | null>(null);
  // Emergency runs: responders choose one for their trip; operators see all, controllers dispatch
  const [emergencyKind, setEmergencyKind] = useState<EmergencyKind | null>(null);
  const [corridors, setCorridors] = useState<Corridor[]>([]);
  const [ambulanceFrom, setAmbulanceFrom] = useState<{ lat: number; lng: number } | null>(null);
  const [stats, setStats] = useState<ServerStats>({
    totalVehicles: 0, avgSpeed: 0, avgDelay: 0, congestionHotspots: 0,
    greenWaveActive: false, signalCoordinationScore: 0, throughput: 0, maxCongestion: 0,
    slaSpeed: 0, slaCompliant: false, emergencySlaSpeed: 0, activeCorridors: 0,
  });
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [selectedDest, setSelectedDest] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [destLabel, setDestLabel] = useState<string | null>(null);
  // The user's latest road report (a photo can be added to it) and the destination's position
  const [lastReportId, setLastReportId] = useState<string | null>(null);
  // Ask the browser to keep WayFinder's maps and roads on this device (not cleared when space is low)
  useEffect(() => { keepDataOnDevice(); }, []);
  const [locating, setLocating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [conditions, setConditions] = useState<Conditions | null>(null);
  const [dismissedOffer, setDismissedOffer] = useState<string | null>(null);
  const [rerouting, setRerouting] = useState(false);
  const isMobile = useIsMobile();
  // Responders (ambulance, fire, police drivers) use the driver view, with emergency runs
  const driverView = isDriver(role);
  const simpleView = driverView;
  const [graphVersion, setGraphVersion] = useState(0);
  const [routeOptions, setRouteOptions] = useState<RouteOption[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [navigation, setNavigation] = useState<NavigationResponse | null>(null);
  const navigatedVehicle = navigation !== null;
  const navigatingRef = useRef(false);
  // Phases as the cached road data had them, to fall back to when a junction's custom phases end
  const baseSignalPhases = useRef(new Map<string, TrafficSignal['phases']>());
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

    // Live map updates
    serverClient.startLive();
    const onServerUpdate = (data: any) => {
      if ((data.type === 'update' || data.type === 'initial') && data.data) {
        setLiveReady(true);
        if (data.data.vehicles) {
          setVehicles(new Map(data.data.vehicles.map((v: any) => [v.id, v])));
        }
        // Live phase per signal: [phase index, seconds into phase]
        const states = data.data.signalStates as Record<string, [number, number]> | undefined;
        // Junctions whose phases changed since the road data was cached (turn phases, new greens)
        const phaseSets = data.data.phaseSets as Record<string, TrafficSignal['phases']> | undefined;
        if (states) {
          setSignals(prev => {
            if (prev.size === 0) return prev;
            const next = new Map(prev);
            for (const [id, [phaseIndex, timer]] of Object.entries(states)) {
              const s = next.get(id);
              if (!s) continue;
              const phases = phaseSets?.[id] ?? baseSignalPhases.current.get(id) ?? s.phases;
              if (!baseSignalPhases.current.has(id)) baseSignalPhases.current.set(id, s.phases);
              if (s.currentPhaseIndex !== phaseIndex || Math.abs(s.timer - timer) > 0.9 || s.phases !== phases) {
                next.set(id, { ...s, phases, cycleLength: phases.reduce((t, p) => t + p.duration, 0), currentPhaseIndex: phaseIndex, timer });
              }
            }
            return next;
          });
        }
        // Traffic per road: [edgeId, level 1–3]; roads not listed flow freely
        if (data.data.traffic) setTraffic(new Map(data.data.traffic as [string, number][]));
        if (data.data.stats) {
          setStats(data.data.stats);
        }
        if (data.data.conditions) {
          setConditions(data.data.conditions);
        }
      }
    };
    serverClient.onUpdate(onServerUpdate);
    serverClient.fetchConditions().then(setConditions).catch(() => {});

    return () => {
      progressiveLoader.removeUpdateCallback(onLoad);
      serverClient.removeUpdateCallback(onServerUpdate);
      serverClient.stopLive();
    };
  }, [user]);

  const graphRef = useRef(graph);
  graphRef.current = graph;
  const trafficRef = useRef(traffic);
  trafficRef.current = traffic;
  const signalsRef = useRef(signals);
  signalsRef.current = signals;

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
        // Server unreachable or failing (offline, proxy 5xx): plan on the device with the saved road network
        {
          const busy = err instanceof Error && /busy/i.test(err.message);
          const local = offlineRoute(graphRef.current, signalsRef.current, selectedSource, selectedDest, trafficRef.current);
          if (local) {
            setRouteOptions([local]);
            setSelectedRouteIndex(0);
            setRouteError(busy
              ? 'Planned on your phone (server busy) — with live traffic, without road reports'
              : 'Offline route — typical speeds, no live traffic or road reports');
            return;
          }
        }
        setRouteOptions([]);
        setRouteError(err instanceof Error ? err.message : 'Failed to plan route');
      })
      .finally(() => {
        if (!controller.signal.aborted) setRouteLoading(false);
      });
    return () => controller.abort();
  }, [user, selectedSource, selectedDest, navigatedVehicle]);

  // ── Choosing places ──────────────────────────────────────────────────────

  const setSource = useCallback((id: string | null, label?: string) => {
    setSelectedSource(id);
    setSourceLabel(id ? label ?? nodeLabel(graphRef.current, id) : null);
  }, []);
  const setDest = useCallback((id: string | null, label?: string) => {
    setSelectedDest(id);
    setDestLabel(id ? label ?? nodeLabel(graphRef.current, id) : null);
  }, []);

  // Live navigation updates while driving
  const refreshNavigation = useCallback(async () => {
    if (!user || !navigatingRef.current) return;
    try {
      const update = await serverClient.getUserNavigation(user.uid);
      if (!navigatingRef.current) return;
      if (update.arrived) {
        navigatingRef.current = false;
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
  }, [user, setSource, setDest]);

  // Navigation updates at the pace the server asks for (2 s normally, longer when it is busy)
  useEffect(() => {
    if (!navigatedVehicle) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await refreshNavigation();
      if (alive) timer = setTimeout(loop, serverClient.pace('navigation'));
    };
    timer = setTimeout(loop, serverClient.pace('navigation'));
    return () => { alive = false; clearTimeout(timer); };
  }, [navigatedVehicle, refreshNavigation]);

  // Real drivers: stream the phone's GPS so their vehicle, live speeds and rerouting use it
  const driveMode = navigation?.mode;
  useEffect(() => {
    if (!user || driveMode !== 'gps' || !navigator.geolocation) return;
    // Send the newest fix at most every 2 s (or as slowly as the server asks); a fix arriving in between is sent late, never dropped
    let latest: GeolocationPosition | null = null;
    let lastSent = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const send = () => {
      timer = null;
      if (!latest) return;
      const pos = latest;
      latest = null;
      lastSent = Date.now();
      const kmh = pos.coords.speed !== null && pos.coords.speed >= 0 ? pos.coords.speed * 3.6 : undefined;
      serverClient.sendPosition(user.uid, pos.coords.latitude, pos.coords.longitude, kmh)
        .then(r => {
          if (r.rerouted) {
            pushToast('You left the route — found a new one', 'info');
            refreshNavigation();
          }
        })
        .catch(err => console.error('Failed to send position:', err));
    };
    const watchId = navigator.geolocation.watchPosition(
      pos => {
        latest = pos;
        if (!timer) timer = setTimeout(send, Math.max(0, serverClient.pace('gps') - (Date.now() - lastSent)));
      },
      err => {
        // Timeouts just mean no new fix yet (e.g. standing still); only a denial needs the driver
        if (err.code === err.PERMISSION_DENIED) pushToast('Location permission was turned off — your position is no longer updating', 'warning');
        else console.warn('GPS:', err.code, err.message);
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    );
    return () => {
      navigator.geolocation.clearWatch(watchId);
      if (timer) clearTimeout(timer);
    };
  }, [user, driveMode, refreshNavigation]);

  // ── Reroutes and road conditions ───────────────────────────────────────────
  const offer = navigation?.reroute ?? null;
  const offerKey = offer ? `${offer.reason}:${offer.roadNames.join('|')}:${Math.round(offer.distance / 50)}` : null;
  const showReroute = !!offer && offerKey !== dismissedOffer;
  const reroutePolyline = useMemo(
    () => showReroute && offer ? offer.geometry.map(p => [p.lat, p.lng] as [number, number]) : undefined,
    [showReroute, offer],
  );

  const handleAcceptReroute = useCallback(async () => {
    if (!user) return;
    setRerouting(true);
    try {
      await serverClient.acceptReroute(user.uid);
      pushToast('Rerouted', 'success');
      await refreshNavigation();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Failed to reroute', 'error');
    } finally {
      setRerouting(false);
    }
  }, [user, refreshNavigation]);

  const refreshConditions = useCallback(async () => {
    try { setConditions(await serverClient.fetchConditions()); } catch { /* next live update brings it */ }
  }, []);

  // Emergency runs on the map (operators and responders), refreshed every 2 s while any is active
  useEffect(() => {
    if (role === 'user') return;
    let alive = true;
    let t = 0;
    const load = () => serverClient.listEmergency()
      .then(c => { if (alive) setCorridors(c); })
      .catch(() => { /* not signed in yet */ })
      .finally(() => { if (alive) t = window.setTimeout(load, corridorsActive.current ? 2000 : 10000); });
    load();
    return () => { alive = false; window.clearTimeout(t); };
  }, [role]);
  const corridorsActive = useRef(false);
  corridorsActive.current = corridors.some(c => c.status === 'active');

  // Controllers: right-click "Ambulance starts here", then "goes here" dispatches it
  const handleAmbulance = useCallback(async (end: 'from' | 'to', lat: number, lng: number) => {
    if (end === 'from') { setAmbulanceFrom({ lat, lng }); pushToast('Ambulance start set — right-click the destination', 'success'); return; }
    if (!ambulanceFrom) return;
    try {
      const c = await serverClient.dispatchEmergency(ambulanceFrom, { lat, lng }, 'ambulance');
      setAmbulanceFrom(null);
      setCorridors(prev => [...prev.filter(x => x.id !== c.id), c]);
      pushToast(`🚑 Ambulance dispatched: ${c.signals.length} signals on its way, ~${Math.max(1, Math.round(c.eta / 60))} min`, 'success');
    } catch (err) {
      pushToast((err as Error).message, 'error');
    }
  }, [ambulanceFrom]);

  // Intentional test jams (operators see them; controllers create and remove them)
  const [jams, setJams] = useState<Jam[]>([]);
  useEffect(() => {
    if (driverView) return;
    let alive = true;
    const load = () => serverClient.listJams().then(j => { if (alive) setJams(j); }).catch(() => { /* not signed in yet */ });
    load();
    const t = window.setInterval(load, 15000);
    return () => { alive = false; window.clearInterval(t); };
  }, [driverView]);
  const handleCreateJam = useCallback(async (lat: number, lng: number, severity: JamSeverity) => {
    try {
      const { jam, jams: all } = await serverClient.createJam(lat, lng, severity);
      setJams(all);
      pushToast(`${severity === 'stopped' ? 'Jammed' : 'Slowed'} ${jam.road}: ${jam.vehicles} vehicles queued over ${jam.metres} m`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Failed to create jam', 'error');
    }
  }, []);
  const handleRemoveJam = useCallback(async (id: string) => {
    try { setJams(await serverClient.removeJam(id)); } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Failed to remove jam', 'error');
    }
  }, []);
  const handleBehaviour = useCallback((change: Partial<Behaviour>) => {
    serverClient.setBehaviour(change).then(setConditions).catch(err => pushToast(err.message, 'error'));
  }, []);

  const handleReport = useCallback(async (type: ReportType, lat: number, lng: number, radiusMetres: number) => {
    const { label } = REPORT_LABEL[type];
    try {
      const { report, merged } = await serverClient.report(type, lat, lng, radiusMetres);
      if (!merged) setLastReportId(report.id);
      const where = report.roadName ? ` on ${report.roadName}` : '';
      pushToast(
        report.status === 'confirmed'
          ? `${label}${where} confirmed — routes now avoid it`
          : merged
            ? `Thanks — added your report to ${label.toLowerCase()}${where}`
            : `Thanks — ${label.toLowerCase()}${where} reported. It fully affects routes once another driver confirms it.`,
        'success', 6000,
      );
      refreshConditions();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Failed to send report', 'error');
    }
  }, [refreshConditions]);

  const handleVoteReport = useCallback(async (id: string, vote: ReportVote) => {
    try {
      const { cleared, report } = await serverClient.voteReport(id, vote);
      pushToast(
        cleared ? 'Thanks — marked clear for everyone'
          : report?.status === 'confirmed' && vote === 'confirm' ? 'Thanks — now confirmed, routes avoid it'
          : 'Thanks for checking',
        'success',
      );
      refreshConditions();
      refreshNavigation();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Failed to send answer', 'error');
    }
  }, [refreshConditions, refreshNavigation]);

  const handleRemoveReport = useCallback(async (id: string) => {
    try {
      await serverClient.removeReport(id);
      pushToast('Report removed', 'success');
      refreshConditions();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Failed to remove report', 'error');
    }
  }, [refreshConditions]);

  const handleWeather = useCallback((mode: WeatherMode) => {
    serverClient.setWeatherMode(mode).then(setConditions).catch(err => pushToast(err.message, 'error'));
  }, []);
  const handleTraffic = useCallback((level: TrafficMode) => {
    serverClient.setTrafficLevel(level).then(setConditions).catch(err => pushToast(err.message, 'error'));
  }, []);

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
    await progressiveLoader.load();
  }, []);

  // Start navigation
  const handleStartNavigation = useCallback(async () => {
    if (!user || !selectedSource || !selectedDest) return;
    
    setStarting(true);
    try {
      const chosen = routeOptions[selectedRouteIndex];
      // Phones drive with real GPS when a fix is available; otherwise the drive is simulated
      let mode: 'gps' | 'simulated' = 'simulated';
      if (isMobile && 'geolocation' in navigator) {
        try {
          await currentPosition();
          mode = 'gps';
        } catch {
          pushToast('Location is off — showing a simulated drive instead', 'warning');
        }
      }
      const nav = await serverClient.startNavigation(user.uid, selectedSource, selectedDest, chosen?.edgeIds, mode, role === 'responder' ? emergencyKind : null);
      navigatingRef.current = true;
      setNavigation(nav);
      // Zoom to the car: the follow camera takes over once its position arrives
      const start = nav.path?.[0];
      if (start) setMapFocus({ lat: start.lat, lng: start.lng, zoom: 16.5, key: Date.now() });
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
  }, [user, selectedSource, selectedDest, sourceLabel, destLabel, routeOptions, selectedRouteIndex, isMobile, role, emergencyKind]);

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
  // First launch on this device: download the city first (like a game after install)
  if (offlineSetup) return <OfflineSetup onDone={() => setOfflineSetup(false)} />;

  const hideSidebar = isMobile && navigatedVehicle;
  const conditionBadges: string[] = [];
  if (conditions?.weather.condition === 'rain') conditionBadges.push('🌧 Rain');
  if (conditions?.weather.condition === 'heavy_rain') conditionBadges.push('⛈ Heavy rain');
  if (conditions?.trafficLevel === 'heavy') conditionBadges.push('🚗 Heavy traffic');
  for (const type of ['block', 'tree', 'waterlogging', 'rain'] as const) {
    const ofType = conditions?.reports.filter(r => r.type === type) ?? [];
    const confirmed = ofType.filter(r => r.status === 'confirmed').length;
    const unconfirmed = ofType.length - confirmed;
    if (ofType.length === 0) continue;
    const parts = [confirmed && `${confirmed}`, unconfirmed && `${unconfirmed} unconfirmed`].filter(Boolean).join(' + ');
    conditionBadges.push(`${REPORT_LABEL[type].icon} ${REPORT_LABEL[type].label.toLowerCase()}: ${parts}`);
  }

  return (
    <div style={{
      // % of the full-height #root rather than dvh, which older Safari/Firefox don't support
      width: '100%', maxWidth: '100vw', height: '100%', display: 'flex', margin: 0, padding: 0, overflow: 'hidden',
      flexDirection: isMobile ? 'column-reverse' : 'row',
    }}>
      {/* Sidebar (bottom sheet on phones) */}
      <div style={{
        display: hideSidebar ? 'none' : 'flex', flexDirection: 'column',
        ...(isMobile
          ? { width: '100%', maxHeight: '52%', borderTop: '1px solid #222', borderRadius: '14px 14px 0 0' }
          : { width: 340, minWidth: 340, height: '100%', borderRight: '1px solid #222' }),
        background: 'rgba(8,8,18,0.99)', zIndex: 1001,
        fontFamily: 'inherit',
      }}>
        {/* Header */}
        <div style={{
          padding: isMobile ? '8px 14px' : '10px 14px', borderBottom: '1px solid #222',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
          background: 'rgba(10,10,13,0.97)', borderRadius: isMobile ? '14px 14px 0 0' : 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <button onClick={() => setShowAbout(true)} title="About WayFinder and TUFF Foundation" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
              <BrandLockup size={isMobile ? 26 : 30} />
            </button>
            {loadingPhase !== 'full' && (
              <span style={{ fontSize: 10, color: '#FF9800' }}>{PHASE_LABEL[loadingPhase]}</span>
            )}
          </div>
          <RoleSelector />
        </div>

        {/* Announcement from the admins */}
        {announcement && (
          <div role="status" style={{
            padding: '8px 14px', fontSize: 12, lineHeight: 1.45, borderBottom: '1px solid #222',
            color: announcement.level === 'warning' ? '#fbbf24' : '#2fe4cc',
            background: announcement.level === 'warning' ? '#fbbf2414' : '#2fe4cc12',
          }}>
            {announcement.level === 'warning' ? '⚠️ ' : '📢 '}{announcement.text}
          </div>
        )}
        {loadingPhase === 'full' && conditionBadges.length > 0 && (
          <div title="Current road conditions" style={{
            padding: '6px 14px', fontSize: 12, color: '#64B5F6', background: '#64B5F60d', borderBottom: '1px solid #222',
          }}>
            {conditionBadges.join(' · ')}
          </div>
        )}

        {!loading && loadSource === 'error' && (
          <div style={{ margin: '8px 14px', fontSize: 11, color: '#F44336' }}>
            Could not reach the WayFinder server. <button onClick={handleRefresh} style={{ background: 'none', border: 'none', color: '#4f8ef7', cursor: 'pointer', padding: 0 }}>Retry</button>
          </div>
        )}

        {/* Role panels */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minWidth: 0 }}>
          {driverView && (
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
              emergencyKind={role === 'responder' ? emergencyKind : undefined}
              onEmergencyKind={role === 'responder' ? setEmergencyKind : undefined}
            />
          )}
          {/* Emergency runs: operators watch (controllers dispatch and cancel) */}
          {!driverView && (
            <EmergencyPanel
              corridors={corridors}
              canControl={canControl(role)}
              picking={ambulanceFrom !== null}
              onCancel={async id => { try { await serverClient.cancelEmergency(id); setCorridors(await serverClient.listEmergency()); } catch (err) { pushToast((err as Error).message, 'error'); } }}
              onFocus={(lat, lng) => setMapFocus({ lat, lng, zoom: 15, key: Date.now() })}
            />
          )}
          {/* Police view first: junction control console */}
          {!driverView && (
            <JunctionPanel
              canControl={canControl(role)}
              selectedId={selectedJunction}
              onSelect={setSelectedJunction}
              onFocus={(lat, lng) => setMapFocus({ lat, lng, zoom: 17, key: Date.now() })}
              onPreview={setCoordPlan}
            />
          )}
          {user && (
            <MyDataCard
              uid={user.uid}
              current={selectedDest && graph.nodes.get(selectedDest) ? { lat: graph.nodes.get(selectedDest)!.lat, lng: graph.nodes.get(selectedDest)!.lng, name: destLabel ?? 'Destination' } : null}
              onGo={p => handlePickDest({ label: p.name, detail: '', lat: p.lat, lng: p.lng, source: 'map' })}
              lastReportId={lastReportId}
            />
          )}
          <OfflineCard online={online} />
          {/* Operators set city-wide conditions and review driver reports */}
          {!driverView && (
            <ConditionsPanel
              conditions={conditions}
              onWeather={handleWeather}
              onTraffic={handleTraffic}
              onRemoveReport={handleRemoveReport}
              onBehaviour={handleBehaviour}
              jams={jams}
              onRemoveJam={canControl(role) ? handleRemoveJam : undefined}
            />
          )}
          {role === 'admin' && user && <AdminPanel myUid={user.uid} />}
          {/* Company info */}
          <div style={{ padding: '14px', borderTop: '1px solid #1a1a22', fontSize: 11, color: '#7a95b0', lineHeight: 1.6 }}>
            <button onClick={() => setShowAbout(true)} style={{ background: 'none', border: 'none', padding: 0, color: '#2fe4cc', cursor: 'pointer', fontSize: 11 }}>About WayFinder</button>
            {' · '}A {BRAND.parent.name} company{' · '}
            <a href={BRAND.companies[1].url} target="_blank" rel="noopener" style={{ color: '#7a95b0' }}>{BRAND.companies[1].name}</a>
            <div>© {new Date().getFullYear()} {BRAND.parent.name}</div>
          </div>
          {role === 'supporter' && (
            <SupporterPanel
              graph={graph}
              signals={signals}
            />
          )}
        </div>

        {/* Footer: operator tools (hidden for drivers) */}
        {!simpleView && (
          <div style={{ padding: '8px 14px', borderTop: '1px solid #0a0a0d', background: 'rgba(10,10,13,0.97)' }}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <button onClick={handleRefresh} style={{ flex: 1, padding: '9px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}>
                🔄 Refresh
              </button>
              <button onClick={() => setShowHeatmap(p => !p)} style={{ flex: 1, padding: '9px', background: showHeatmap ? 'rgba(68,136,255,0.25)' : '#222', color: '#fff', border: `1px solid ${showHeatmap ? '#4f8ef7' : '#444'}`, borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}>
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

      {showAbout && <AboutCompany onClose={() => setShowAbout(false)} />}
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
          reports={conditions?.reports}
          reroutePolyline={reroutePolyline}
          onReport={handleReport}
          onVoteReport={handleVoteReport}
          onRemoveReport={handleRemoveReport}
          onCreateJam={canControl(role) ? handleCreateJam : undefined}
          canRemoveReports={!driverView}
          followVehicleId={simpleView && navigation?.vehicleId ? navigation.vehicleId : undefined}
          traffic={traffic}
          focus={mapFocus}
          onSelectJunction={setSelectedJunction}
          coordination={!driverView ? coordPlan : null}
          emergencyCorridors={corridors}
          onAmbulance={canControl(role) ? handleAmbulance : undefined}
          ambulanceFromSet={ambulanceFrom !== null}
          onViewportChange={(bbox, zoom) => { serverClient.setViewport(bbox, zoom); progressiveLoader.loadView(bbox, zoom); }}
        />
      </div>

      {!liveReady && !loading && (
        <div style={{
          position: 'fixed', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 1500,
          background: 'rgba(20,24,38,0.95)', color: '#cfe0ff', border: '1px solid #2c4a7a', borderRadius: 16,
          padding: '6px 14px', fontSize: 12, fontFamily: 'inherit', whiteSpace: 'nowrap',
        }}>⏳ Connecting to live traffic… (map ready)</div>
      )}

      {/* Navigation Guide Overlay */}
      {navigation && (
        <NavigationGuide
          navigation={navigation}
          onClear={handleClearRoute}
          onOpenGoogleMaps={handleOpenGoogleMaps}
          destLabel={destLabel}
          isMobile={isMobile}
          showReroute={showReroute}
          rerouting={rerouting}
          onAcceptReroute={handleAcceptReroute}
          onDismissReroute={() => setDismissedOffer(offerKey)}
          onAnswerReport={handleVoteReport}
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
