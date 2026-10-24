/**
 * MapView.tsx
 * MapLibre GL map on free OpenFreeMap vector tiles, with WayFinder's own overlay:
 * roads, signals, vehicles, routes and crowd reports (see mapLayers.ts).
 * Tapping the map opens the context menu. While a driver navigates, the camera
 * follows their car, turning with its heading (Ola/Uber style).
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import type { Map as MLMap, MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { RoadGraph, TrafficSignal, Vehicle, CongestionZone, VehicleType } from '../types';
import { findNearestNode } from '../data/roadNetwork';
import MapContextMenu from './MapContextMenu';
import NavigationPanel from './NavigationPanel';
import ControlPanel from './ControlPanel';
import type { NavRouteSummary } from './NavigationPanel';
import type { RoadReport, ReportType, ReportVote } from '../services/serverClient';
import { distanceMetres } from '../utils/places';
import SignalCard from './SignalCard';
import {
  MAP_STYLES, SRC, LAYER, addOverlayLayers, addMissingImage, setSourceData,
  roadsData, trafficData, trafficBaseData, signalsData, vehiclesData, heatData, linesData, reportsData,
} from './mapLayers';

const MAP_CENTER: [number, number] = [12.9716, 77.5946];
const FOLLOW_ZOOM = 16.5;
const FOLLOW_PITCH = 50;

interface MapViewProps {
  graph: RoadGraph;
  signals: Map<string, TrafficSignal>;
  vehicles: Map<string, Vehicle>;
  congestionZones: CongestionZone[];
  onCancelOverride: () => void;
  overrideActive: boolean;
  overrideTimeRemaining: number;
  selectedSource: string | null;
  selectedDest: string | null;
  onSelectSource: (id: string | null) => void;
  onSelectDest: (id: string | null) => void;
  role: string;
  graphVersion: number;
  vehicleVersion: number;
  stats: { vehicleCount: number; avgSpeed: number; congestionHotspots: number; greenWaveActive: boolean; signalCoordinationScore: number };
  onAddSignal: (nodeId: string, lat: number, lng: number) => void;
  onSpawnVehicleAt: (nodeId: string, type: VehicleType) => void;
  showHeatmap?: boolean;
  routePolyline?: [number, number][];
  /** Other route options, drawn muted behind the selected route */
  altRoutePolylines?: [number, number][][];
  speed?: number;
  onSpeedChange?: (speed: number) => void;
  onStartNavigation: () => void;
  routeInfo: NavRouteSummary | null;
  clearRoute: () => void;
  navigatedVehicle: boolean;
  /** Driver view: hide operator overlays (stats, legend, floating nav panel, mini-map) */
  simpleView?: boolean;
  /** Phone layout */
  compact?: boolean;
  reports?: RoadReport[];
  /** Offered reroute, drawn dashed green */
  reroutePolyline?: [number, number][];
  /** `radiusMetres` ≈ a finger-width on screen at the current zoom */
  onReport?: (type: ReportType, lat: number, lng: number, radiusMetres: number) => void;
  onVoteReport?: (id: string, vote: ReportVote) => void;
  onRemoveReport?: (id: string) => void;
  /** Operators: remove reports outright */
  canRemoveReports?: boolean;
  /** The driver's own vehicle: drawn as a heading arrow and followed by the camera */
  followVehicleId?: string;
  /** Traffic level per edge (1 slow … 3 jammed); edges not listed flow freely */
  traffic?: Map<string, number>;
  /** Visible area ([west, south, east, north]) and zoom, after the map stops moving */
  onViewportChange?: (bbox: [number, number, number, number], zoom: number) => void;
  /** Fly here when `key` changes */
  focus?: { lat: number; lng: number; zoom: number; key: number } | null;
  /** Operators tapped a signal */
  onSelectJunction?: (id: string) => void;
}

interface ContextMenuState {
  lat: number; lng: number; nodeId: string | null;
  nodeDegree: number; roadNames: string[];
  screenX: number; screenY: number;
}

/** A vehicle moving from where it was drawn to its latest server position. */
interface AnimVehicle {
  v: Vehicle;
  fromLat: number; fromLng: number; fromBearing: number;
  t0: number; duration: number;
}

function interpolate(a: AnimVehicle, now: number): { lat: number; lng: number; bearing: number } {
  const t = Math.min(1, Math.max(0, (now - a.t0) / a.duration));
  const turn = ((a.v.bearing - a.fromBearing + 540) % 360) - 180;
  return {
    lat: a.fromLat + (a.v.lat - a.fromLat) * t,
    lng: a.fromLng + (a.v.lng - a.fromLng) * t,
    bearing: (a.fromBearing + turn * t + 360) % 360,
  };
}

/** Start/end pin: a dot on the point with its label above. Taps pass through to the map. */
function pinElement(color: string, label: string): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = 'position:relative;width:20px;height:20px;pointer-events:none;';
  el.innerHTML = `
    <div style="position:absolute;bottom:26px;left:50%;transform:translateX(-50%);white-space:nowrap;
      background:rgba(0,0,0,0.8);border:1px solid #444;color:#fff;font:11px system-ui,sans-serif;
      padding:2px 6px;border-radius:4px;">${label}</div>
    <div style="width:20px;height:20px;border-radius:50%;background:${color};border:3px solid #fff;
      box-shadow:0 1px 6px rgba(0,0,0,0.5);"></div>`;
  return el;
}


export default function MapView({
  graph, signals, vehicles, congestionZones, onCancelOverride,
  overrideActive, overrideTimeRemaining, selectedSource, selectedDest,
  onSelectSource, onSelectDest, role, graphVersion, vehicleVersion, stats,
  onAddSignal, onSpawnVehicleAt, showHeatmap = true, routePolyline, altRoutePolylines, speed: _speed, onSpeedChange: _onSpeedChange,
  onStartNavigation, routeInfo, clearRoute, navigatedVehicle, simpleView = false, compact = false,
  reports = [], reroutePolyline, onReport, onVoteReport, onRemoveReport, canRemoveReports = false,
  followVehicleId, traffic, onViewportChange, focus, onSelectJunction,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const miniRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const lastGraphVersion = useRef(-1);
  const firstFitDone = useRef(false);
  const pinMarkersRef = useRef<maplibregl.Marker[]>([]);

  /** Bumped each time a map instance finishes loading; overlay effects re-run on it */
  const [loadCount, setLoadCount] = useState(0);
  const loadedMapRef = useRef<MLMap | null>(null);
  const styleUrlRef = useRef<string>(MAP_STYLES.light);
  /** The map once its style and overlay layers are in place, else null */
  const loadedMap = () => (mapRef.current && loadedMapRef.current === mapRef.current ? mapRef.current : null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  /** Signal whose live timing card is open */
  const [selectedSignal, setSelectedSignal] = useState<string | null>(null);
  /** When the live signal states last arrived (for the card's countdown) */
  const signalsAt = useRef(Date.now());
  /** Camera tracks the driver's car; paused when they drag or rotate the map */
  const [following, setFollowing] = useState(true);
  const followZoomPending = useRef(true);
  const wasFollowing = useRef(false);

  // Prop refs to avoid stale closures in map event handlers
  const graphRef = useRef(graph);
  const signalsRef = useRef(signals);
  const simpleViewRef = useRef(simpleView);
  graphRef.current = graph;
  signalsRef.current = signals;
  const onViewportChangeRef = useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;
  const onSelectJunctionRef = useRef(onSelectJunction);
  onSelectJunctionRef.current = onSelectJunction;
  const followRef = useRef(followVehicleId);
  followRef.current = followVehicleId;
  const animRef = useRef<{ vehicles: Map<string, AnimVehicle>; lastUpdate: number; interval: number }>(
    { vehicles: new Map(), lastUpdate: 0, interval: 500 },
  );
  simpleViewRef.current = simpleView;

  // ── Init map once ──────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    let map: MLMap;
    styleUrlRef.current = simpleViewRef.current ? MAP_STYLES.light : MAP_STYLES.dark;
    try {
      map = new maplibregl.Map({
        container,
        style: styleUrlRef.current,
        center: [MAP_CENTER[1], MAP_CENTER[0]],
        zoom: 13,
        maxZoom: 19,
        attributionControl: { compact: true },
        // Map position in the URL (#zoom/lat/lng): shareable views, kept on reload
        hash: true,
      });
    } catch (err) {
      // No WebGL (very old browser or GPU blocked)
      setMapError(err instanceof Error ? err.message : 'Map could not start');
      return;
    }
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-left');

    map.on('styleimagemissing', e => addMissingImage(map, e.id));
    // Fires on first load and after each style switch (which drops our layers)
    map.on('style.load', () => {
      addOverlayLayers(map, { showRoads: !simpleViewRef.current });
      loadedMapRef.current = map;
      lastGraphVersion.current = -1; // new map: draw the roads again
      setLoadCount(c => c + 1);
    });

    const hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'wf-tooltip', offset: 12 });

    map.on('click', (e: MapMouseEvent) => {
      // Tapping a signal (finger-sized area) opens its live timing card, for everyone
      if (map.getLayer(LAYER.signals)) {
        const { x, y } = e.point;
        const hit = map.queryRenderedFeatures([[x - 10, y - 10], [x + 10, y + 10]], { layers: [LAYER.signals] })[0];
        const sigId = hit?.properties?.id as string | undefined;
        if (sigId && signalsRef.current.has(sigId)) {
          setSelectedSignal(sigId);
          setContextMenu(null);
          if (!simpleViewRef.current) onSelectJunctionRef.current?.(sigId);
          return;
        }
      }

      const { lat, lng } = e.lngLat;
      const nearest = findNearestNode(graphRef.current.nodes, lat, lng);
      const nodeId = nearest?.id ?? null;
      const nodeDegree = nodeId ? (graphRef.current.adjacency.get(nodeId)?.length ?? 0) : 0;
      const roadNames: string[] = nodeId
        ? [...new Set(
            (graphRef.current.adjacency.get(nodeId) ?? [])
              .map(ed => ed.name)
              .filter(Boolean) as string[]
          )]
        : [];
      setContextMenu({
        lat, lng, nodeId, nodeDegree, roadNames,
        screenX: e.originalEvent.clientX, screenY: e.originalEvent.clientY,
      });
    });

    // Operators: hover a vehicle for its type and speed
    map.on('mousemove', LAYER.vehicles, e => {
      const f = e.features?.[0];
      if (!f || simpleViewRef.current) return;
      map.getCanvas().style.cursor = 'pointer';
      hoverPopup.setLngLat(e.lngLat).setHTML(String(f.properties?.label ?? '')).addTo(map);
    });
    map.on('mouseleave', LAYER.vehicles, () => {
      map.getCanvas().style.cursor = '';
      hoverPopup.remove();
    });
    map.on('mouseenter', LAYER.signals, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', LAYER.signals, () => { map.getCanvas().style.cursor = ''; });

    // A drag or rotate by the user pauses the follow camera (zooming doesn't)
    const pauseFollow = (e: { originalEvent?: unknown }) => { if (e.originalEvent) setFollowing(false); };
    map.on('dragstart', pauseFollow);
    map.on('rotatestart', pauseFollow);

    // Tell the server what's on screen (it sends vehicles only there)
    let viewTimer: number | undefined;
    const reportView = () => {
      window.clearTimeout(viewTimer);
      viewTimer = window.setTimeout(() => {
        const b = map.getBounds();
        onViewportChangeRef.current?.([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], map.getZoom());
      }, 200);
    };
    map.on('moveend', reportView);
    map.on('load', reportView);

    // Keep the map sized to its box (phone bottom sheet, rotation)
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      window.clearTimeout(viewTimer);
      hoverPopup.remove();
      map.remove(); mapRef.current = null; loadedMapRef.current = null;
    };
  }, []); // intentionally empty — one-time init, props reach handlers via refs

  // Fly to a junction picked in the police panel
  useEffect(() => {
    const map = mapRef.current;
    if (map && focus) map.flyTo({ center: [focus.lng, focus.lat], zoom: focus.zoom, duration: 900 });
  }, [focus]);

  // ── Mini-map (operators) ──────────────────────────────────────────────────
  useEffect(() => {
    if (simpleView || !miniRef.current || mapError) return;
    let mini: MLMap;
    try {
      mini = new maplibregl.Map({
        container: miniRef.current,
        style: MAP_STYLES.dark,
        center: [MAP_CENTER[1], MAP_CENTER[0]],
        zoom: 10,
        interactive: false,
        attributionControl: false,
      });
    } catch {
      return; // mini-map is optional
    }
    const dot = document.createElement('div');
    dot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#FF6D00;border:2px solid #fff;';
    new maplibregl.Marker({ element: dot }).setLngLat([MAP_CENTER[1], MAP_CENTER[0]]).addTo(mini);
    return () => mini.remove();
  }, [simpleView, mapError]);

  // ── Roads ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const map = loadedMap();
    if (!map || graphVersion === lastGraphVersion.current) return;
    lastGraphVersion.current = graphVersion;
    setSourceData(map, SRC.roads, roadsData(graph));
    setSourceData(map, SRC.trafficBase, trafficBaseData(graph));

    // Show the whole network first, unless the URL already says where to look
    if (/^#[\d.]+\/[\d.-]+\/[\d.-]+/.test(location.hash)) firstFitDone.current = true;
    if (graph.nodes.size > 0 && !firstFitDone.current) {
      const bounds = new maplibregl.LngLatBounds();
      for (const n of graph.nodes.values()) bounds.extend([n.lng, n.lat]);
      map.fitBounds(bounds, { padding: 20, duration: 0 });
      firstFitDone.current = true;
    }
  }, [graph, graphVersion, loadCount]);

  // Role changed (demo role switch): light map for drivers, dark for operators
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedMap()) return;
    const want = simpleView ? MAP_STYLES.light : MAP_STYLES.dark;
    if (styleUrlRef.current === want) return;
    styleUrlRef.current = want;
    loadedMapRef.current = null; // overlay waits for 'style.load'
    map.setStyle(want, { diff: false });
  }, [simpleView, loadCount]);

  // Drivers see the base map's roads; operators also see the simulated network
  useEffect(() => {
    const map = loadedMap();
    if (map) map.setLayoutProperty('wf-roads', 'visibility', simpleView ? 'none' : 'visible');
  }, [simpleView, loadCount]);

  // ── Source / destination pins ─────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const m of pinMarkersRef.current) m.remove();
    pinMarkersRef.current = [];
    const add = (id: string | null, color: string, label: string) => {
      const n = id ? graph.nodes.get(id) : undefined;
      if (n) pinMarkersRef.current.push(new maplibregl.Marker({ element: pinElement(color, label) }).setLngLat([n.lng, n.lat]).addTo(map));
    };
    add(selectedSource, '#4CAF50', 'Origin');
    add(selectedDest, '#F44336', 'Destination');
  }, [selectedSource, selectedDest, graph]);

  // ── Bring newly chosen places into view ───────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const pts = [selectedSource, selectedDest]
      .map(id => id ? graphRef.current.nodes.get(id) : undefined)
      .filter((n): n is NonNullable<typeof n> => !!n)
      .map(n => [n.lng, n.lat] as [number, number]);
    if (pts.length === 2) {
      map.fitBounds(new maplibregl.LngLatBounds(pts[0], pts[0]).extend(pts[1]), { padding: 60, maxZoom: 16 });
    } else if (pts.length === 1 && !map.getBounds().contains(pts[0])) {
      map.easeTo({ center: pts[0], zoom: Math.max(map.getZoom(), 15) });
    }
  }, [selectedSource, selectedDest]);

  // ── Live layers ───────────────────────────────────────────────────────────
  useEffect(() => {
    signalsAt.current = Date.now();
    const map = loadedMap();
    if (map) setSourceData(map, SRC.signals, signalsData(signals, graph));
  }, [signals, graph, loadCount]);

  // Vehicles glide between server updates (sent every ~0.5 s) instead of jumping
  useEffect(() => {
    const anim = animRef.current;
    const now = performance.now();
    if (anim.lastUpdate > 0) {
      const gap = now - anim.lastUpdate;
      if (gap > 50 && gap < 3000) anim.interval = anim.interval * 0.7 + gap * 0.3;
    }
    anim.lastUpdate = now;
    const next = new Map<string, AnimVehicle>();
    for (const v of vehicles.values()) {
      const prev = anim.vehicles.get(v.id);
      const shown = prev ? interpolate(prev, now) : null;
      // Short hops glide; long jumps (new road, GPS fix) snap
      const near = shown && Math.abs(shown.lat - v.lat) < 0.0015 && Math.abs(shown.lng - v.lng) < 0.0015;
      next.set(v.id, {
        v,
        fromLat: near ? shown.lat : v.lat, fromLng: near ? shown.lng : v.lng,
        fromBearing: near ? shown.bearing : v.bearing,
        t0: now, duration: anim.interval,
      });
    }
    anim.vehicles = next;
  }, [vehicles, vehicleVersion]);

  useEffect(() => {
    let raf = 0, last = 0;
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const map = loadedMap();
      if (!map || t - last < 50 || document.hidden) return; // ~20 fps, paused in background tabs
      last = t;
      const anim = animRef.current;
      const shown: Vehicle[] = [];
      for (const a of anim.vehicles.values()) {
        const p = interpolate(a, t);
        shown.push({ ...a.v, lat: p.lat, lng: p.lng, bearing: p.bearing });
      }
      setSourceData(map, SRC.vehicles, vehiclesData(shown, followRef.current));
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const map = loadedMap();
    if (map) setSourceData(map, SRC.traffic, trafficData(graph, traffic ?? new Map()));
  }, [traffic, graph, loadCount]);

  useEffect(() => {
    const map = loadedMap();
    if (map) setSourceData(map, SRC.heat, heatData(congestionZones, showHeatmap));
  }, [congestionZones, showHeatmap, loadCount]);

  useEffect(() => {
    const map = loadedMap();
    if (!map) return;
    setSourceData(map, SRC.alts, linesData(altRoutePolylines ?? []));
    setSourceData(map, SRC.route, linesData([routePolyline]));
    setSourceData(map, SRC.reroute, linesData([reroutePolyline]));
  }, [routePolyline, altRoutePolylines, reroutePolyline, loadCount]);

  useEffect(() => {
    const map = loadedMap();
    if (!map) return;
    const { blocks, areas, icons } = reportsData(reports, graph);
    setSourceData(map, SRC.blocks, blocks);
    setSourceData(map, SRC.areas, areas);
    setSourceData(map, SRC.reportIcons, icons);
  }, [reports, graph, loadCount]);

  // ── Follow camera ─────────────────────────────────────────────────────────
  // A new trip starts in follow mode
  useEffect(() => {
    setFollowing(true);
    followZoomPending.current = true;
  }, [followVehicleId]);

  useEffect(() => {
    const map = loadedMap();
    if (!map) return;
    if (!followVehicleId) {
      // Trip over: flatten the map and point north again
      if (wasFollowing.current) map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 800 });
      wasFollowing.current = false;
      return;
    }
    if (!following) return;
    const v = vehicles.get(followVehicleId);
    if (!v) return;
    wasFollowing.current = true;
    const zoom = followZoomPending.current ? Math.max(map.getZoom(), FOLLOW_ZOOM) : undefined;
    followZoomPending.current = false;
    // Leave out the part of the map hidden under the trip card, then put the car
    // about two-thirds of the way down what's left so more road ahead is visible
    const box = map.getContainer().getBoundingClientRect();
    const cover = document.querySelector('[data-map-cover="bottom"]')?.getBoundingClientRect();
    const covered = cover ? Math.min(Math.max(box.bottom - cover.top, 0), box.height * 0.6) : 0;
    const visible = box.height - covered;
    map.easeTo({
      center: [v.lng, v.lat],
      bearing: v.bearing,
      pitch: FOLLOW_PITCH,
      ...(zoom !== undefined ? { zoom } : {}),
      padding: { top: visible * 0.3, bottom: covered, left: 0, right: 0 },
      duration: 1000,
      easing: t => t,
    });
  }, [vehicles, vehicleVersion, followVehicleId, following, loadCount]);

  const recenter = useCallback(() => {
    followZoomPending.current = true;
    setFollowing(true);
  }, []);

  // ── Context menu handlers ─────────────────────────────────────────────────
  const handleAddSignal = useCallback(() => {
    if (!contextMenu?.nodeId) return;
    onAddSignal(contextMenu.nodeId, contextMenu.lat, contextMenu.lng);
  }, [contextMenu, onAddSignal]);

  const handleSpawnVehicle = useCallback((type: VehicleType) => {
    if (!contextMenu?.nodeId) return;
    onSpawnVehicleAt(contextMenu.nodeId, type);
  }, [contextMenu, onSpawnVehicleAt]);

  const handleSetSource = useCallback(() => {
    if (contextMenu?.nodeId) onSelectSource(contextMenu.nodeId);
  }, [contextMenu, onSelectSource]);

  const handleSetDest = useCallback(() => {
    if (contextMenu?.nodeId) onSelectDest(contextMenu.nodeId);
  }, [contextMenu, onSelectDest]);

  // Reports the tapped point falls within (rain areas are large; blocks and waterlogging local)
  const nearbyReports = contextMenu
    ? reports.filter(r => distanceMetres(r, contextMenu) < Math.max(80, r.radius))
    : [];

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {mapError && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#ccc', fontSize: 14, padding: 24, textAlign: 'center', background: '#1a1a2e',
        }}>
          The map needs WebGL, which this browser or device has turned off. Try an up-to-date Chrome, Edge, Safari or Firefox.
        </div>
      )}

      {/* Back to following the car after the driver moved the map (top: the trip card covers the bottom) */}
      {followVehicleId && !following && (
        <button onClick={recenter} style={{
          position: 'absolute', left: '50%', transform: 'translateX(-50%)',
          top: 16, zIndex: 1003,
          padding: '10px 18px', borderRadius: 22, border: 'none', cursor: 'pointer',
          background: '#2F6BFF', color: '#fff', fontSize: 14, fontWeight: 600,
          boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
        }}>◎ Re-center</button>
      )}

      {/* Mini-map */}
      {!simpleView && <div ref={miniRef} style={{
        position: 'absolute', bottom: 12, right: 12, zIndex: 1000,
        width: 160, height: 120, borderRadius: 8, overflow: 'hidden',
        border: '2px solid #333', boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
      }} />}

      {/* Live stats HUD */}
      {!simpleView && <div style={{
        position: 'absolute', top: 12, left: 270, zIndex: 1001,
        background: 'rgba(10,10,20,0.85)', border: '1px solid #333', borderRadius: 8,
        padding: '6px 12px', fontFamily: 'monospace', fontSize: 11, color: '#ccc',
        display: 'flex', gap: 14, backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
      }}>
        <span>🚗 {stats.vehicleCount}</span>
        <span>⚡ {stats.avgSpeed.toFixed(1)} km/h</span>
        <span style={{ color: stats.congestionHotspots > 3 ? '#FF1744' : '#4CAF50' }}>
          🔥 {stats.congestionHotspots}
        </span>
        <span style={{ color: stats.greenWaveActive ? '#00E676' : '#555' }}>
          🌊 {stats.greenWaveActive ? 'ON' : 'OFF'}
        </span>
        <span style={{ color: stats.signalCoordinationScore > 60 ? '#00E676' : '#FF9800' }}>
          📡 {stats.signalCoordinationScore}%
        </span>
      </div>}

      {/* Override banner */}
      {overrideActive && (
        <div style={{
          position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
          zIndex: 1002, background: 'rgba(255,152,0,0.12)', border: '1px solid #FF9800',
          borderRadius: 8, padding: '7px 16px', display: 'flex', alignItems: 'center',
          gap: 12, fontFamily: 'monospace', fontSize: 12, fontWeight: 'bold',
          backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        }}>
          <span style={{ color: '#FF9800' }}>⚡ OVERRIDE</span>
          <span style={{ color: '#fff' }}>{Math.round(overrideTimeRemaining)}s</span>
          <button onClick={onCancelOverride} style={{
            padding: '3px 10px', background: '#FF9800', color: '#000',
            border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold',
          }}>Cancel (Esc)</button>
        </div>
      )}

      {!simpleView && <NavigationPanel
        selectedSource={selectedSource}
        selectedDest={selectedDest}
        onSelectSource={onSelectSource}
        onSelectDest={onSelectDest}
        onStartNavigation={onStartNavigation}
        routeInfo={routeInfo}
        clearRoute={clearRoute}
        navigatedVehicle={navigatedVehicle}
      />}
      {!simpleView && !compact && <ControlPanel />}

      {selectedSignal && signals.get(selectedSignal) && (
        <SignalCard
          signal={signals.get(selectedSignal)!}
          updatedAt={signalsAt.current}
          onClose={() => setSelectedSignal(null)}
          compact={compact}
        />
      )}

      {/* Context menu */}
      {contextMenu && (
        <MapContextMenu
          {...contextMenu}
          role={role}
          onClose={() => setContextMenu(null)}
          onAddSignal={handleAddSignal}
          onSpawnVehicle={handleSpawnVehicle}
          onSetSource={handleSetSource}
          onSetDest={handleSetDest}
          onReport={type => {
            const map = mapRef.current;
            const radius = map ? map.unproject([0, 0]).distanceTo(map.unproject([24, 0])) : 60;
            onReport?.(type, contextMenu.lat, contextMenu.lng, radius);
          }}
          nearbyReports={nearbyReports}
          onVote={(id, vote) => onVoteReport?.(id, vote)}
          canRemove={canRemoveReports}
          onRemove={id => onRemoveReport?.(id)}
          simple={simpleView}
        />
      )}

      <style>{`
        .wf-tooltip .maplibregl-popup-content {
          background: rgba(0,0,0,0.8); border: 1px solid #444; color: #fff;
          font-size: 11px; padding: 3px 7px; border-radius: 4px; pointer-events: none;
        }
        .wf-tooltip .maplibregl-popup-tip { display: none; }
        .wf-popup .maplibregl-popup-content { background: #111; color: #ccc; border-radius: 6px; border: 1px solid #333; padding: 10px; }
        .wf-popup.maplibregl-popup-anchor-bottom .maplibregl-popup-tip { border-top-color: #111; }
        .wf-popup.maplibregl-popup-anchor-top .maplibregl-popup-tip { border-bottom-color: #111; }
        .wf-popup .maplibregl-popup-close-button { color: #666; }
      `}</style>
    </div>
  );
}
