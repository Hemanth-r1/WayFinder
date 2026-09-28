/**
 * MapView.tsx
 * REQ-G3: Roads rendered as full geometry polylines.
 * REQ-M1: Click opens context menu popup.
 * Vehicle markers rotated to match bearing.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { RoadGraph, TrafficSignal, Vehicle, CongestionZone, VehicleType } from '../types';
import { findNearestNode } from '../data/roadNetwork';
import MapContextMenu from './MapContextMenu';
import NavigationPanel from './NavigationPanel';
import ControlPanel from './ControlPanel';
import type { NavRouteSummary } from './NavigationPanel';
import type { RoadBlock } from '../services/serverClient';
import { distanceMetres } from '../utils/places';

const VEHICLE_ICONS: Record<string, string> = {
  sedan: '🚗', suv: '🚙', hatchback: '🚗', truck: '🚚',
  bus: '🚌', emergency: '🚨', bike: '🛵', auto: '🛺', van: '📦',
};

const MAP_CENTER: [number, number] = [12.9716, 77.5946];

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
  blocks?: RoadBlock[];
  /** Offered reroute, drawn dashed green */
  reroutePolyline?: [number, number][];
  /** `radiusMetres` ≈ a finger-width on screen at the current zoom */
  onReportBlock?: (lat: number, lng: number, radiusMetres: number) => void;
  onClearBlock?: (id: string) => void;
}

interface ContextMenuState {
  lat: number; lng: number; nodeId: string | null;
  nodeDegree: number; roadNames: string[];
  screenX: number; screenY: number;
}

export default function MapView({
  graph, signals, vehicles, congestionZones, onCancelOverride,
  overrideActive, overrideTimeRemaining, selectedSource, selectedDest,
  onSelectSource, onSelectDest, role, graphVersion, vehicleVersion, stats,
  onAddSignal, onSpawnVehicleAt, showHeatmap = true, routePolyline, altRoutePolylines, speed: _speed, onSpeedChange: _onSpeedChange,
  onStartNavigation, routeInfo, clearRoute, navigatedVehicle, simpleView = false, compact = false,
  blocks = [], reroutePolyline, onReportBlock, onClearBlock,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const miniMapRef = useRef<L.Map | null>(null);
  const roadLayerRef = useRef<L.LayerGroup | null>(null);
  const signalLayerRef = useRef<L.LayerGroup | null>(null);
  const vehicleLayerRef = useRef<L.LayerGroup | null>(null);
  const heatmapLayerRef = useRef<L.LayerGroup | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const sourceDestLayerRef = useRef<L.LayerGroup | null>(null);
  const blockLayerRef = useRef<L.LayerGroup | null>(null);
  const vehicleMarkersRef = useRef<Map<string, L.Marker>>(new Map());
  const lastGraphVersion = useRef(0);
  const firstFitDone = useRef(false);
  const iconCacheRef = useRef<Map<string, L.DivIcon>>(new Map());

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Prop refs to avoid stale closures in the map click handler
  const graphRef = useRef(graph);
  const simpleViewRef = useRef(simpleView);
  const roleRef = useRef(role);
  const selectedSourceRef = useRef(selectedSource);
  const selectedDestRef = useRef(selectedDest);
  const onSelectSourceRef = useRef(onSelectSource);
  const onSelectDestRef = useRef(onSelectDest);

  graphRef.current = graph;
  roleRef.current = role;
  selectedSourceRef.current = selectedSource;
  selectedDestRef.current = selectedDest;
  onSelectSourceRef.current = onSelectSource;
  onSelectDestRef.current = onSelectDest;

  // ── Init map once ──────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    const map = L.map(container, { center: MAP_CENTER, zoom: 13, zoomControl: false });
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    mapRef.current = map;
    roadLayerRef.current = L.layerGroup().addTo(map);
    signalLayerRef.current = L.layerGroup().addTo(map);
    vehicleLayerRef.current = L.layerGroup().addTo(map);
    heatmapLayerRef.current = L.layerGroup().addTo(map);
    routeLayerRef.current = L.layerGroup().addTo(map);
    sourceDestLayerRef.current = L.layerGroup().addTo(map);
    blockLayerRef.current = L.layerGroup().addTo(map);

    map.on('click', (e: L.LeafletMouseEvent) => {
      const nearest = findNearestNode(graphRef.current.nodes, e.latlng.lat, e.latlng.lng);
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
        lat: e.latlng.lat, lng: e.latlng.lng, nodeId, nodeDegree, roadNames,
        screenX: e.originalEvent.clientX, screenY: e.originalEvent.clientY,
      });
    });

    // Mini-map
    const miniEl = simpleViewRef.current ? null : document.getElementById('mini-map');
    if (miniEl && !miniMapRef.current) {
      const mm = L.map(miniEl, {
        center: MAP_CENTER, zoom: 11, zoomControl: false,
        attributionControl: false, dragging: false, scrollWheelZoom: false,
      });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(mm);
      L.circleMarker(MAP_CENTER, { radius: 5, color: '#FF6D00', fillColor: '#FF6D00', fillOpacity: 1, weight: 2 }).addTo(mm);
      miniMapRef.current = mm;
    }

    // Keep Leaflet in sync when the layout changes (phone bottom sheet, rotation)
    const resizeObserver = new ResizeObserver(() => map.invalidateSize());
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      map.remove(); mapRef.current = null;
      if (miniMapRef.current) { miniMapRef.current.remove(); miniMapRef.current = null; }
    };
  }, []); // intentionally empty — one-time init, all props via refs

  // ── Draw roads (REQ-G3: full geometry polyline) ───────────────────────────
  useEffect(() => {
    const layer = roadLayerRef.current;
    if (!layer || !mapRef.current) return;
    if (graphVersion === lastGraphVersion.current) return;
    lastGraphVersion.current = graphVersion;
    layer.clearLayers();

    const drawn = new Set<string>();
    for (const [, edge] of graph.edges) {
      const key = [edge.from, edge.to].sort().join('|');
      if (drawn.has(key)) continue; drawn.add(key);

      // Use full geometry array (REQ-G3)
      const geom = edge.geometry;
      if (!geom || geom.length < 2) continue;
      const latlngs = geom.map(p => [p.lat, p.lng] as [number, number]);

      const isPrimary = edge.roadType === 'primary' || edge.roadType === 'motorway' || edge.roadType === 'trunk';
      const isSecondary = edge.roadType === 'secondary';
      L.polyline(latlngs, {
        color: isPrimary ? '#FF6D00' : isSecondary ? '#FF9100' : '#FFAB4044',
        weight: isPrimary ? 4 : isSecondary ? 3 : 1.5,
        opacity: isPrimary ? 0.85 : isSecondary ? 0.65 : 0.4,
        interactive: false, // taps fall through to the map menu
      }).addTo(layer);
    }

    if (graph.nodes.size > 0 && !firstFitDone.current) {
      const allPoints = Array.from(graph.nodes.values()).map(n => [n.lat, n.lng] as [number, number]);
      if (allPoints.length > 0) {
        mapRef.current.fitBounds(L.latLngBounds(allPoints), { padding: [20, 20] });
        firstFitDone.current = true;
      }
    }
  }, [graph, graphVersion]);

  // ── Source / Destination markers ──────────────────────────────────────────
  useEffect(() => {
    const layer = sourceDestLayerRef.current; if (!layer) return;
    layer.clearLayers();
    if (selectedSource) {
      const n = graph.nodes.get(selectedSource);
      if (n) {
        L.circleMarker([n.lat, n.lng], { radius: 10, color: '#4CAF50', fillColor: '#4CAF50', fillOpacity: 0.9, weight: 3 })
          .bindTooltip('Origin', { permanent: true, direction: 'top', className: 'wf-tooltip' })
          .addTo(layer);
      }
    }
    if (selectedDest) {
      const n = graph.nodes.get(selectedDest);
      if (n) {
        L.circleMarker([n.lat, n.lng], { radius: 10, color: '#F44336', fillColor: '#F44336', fillOpacity: 0.9, weight: 3 })
          .bindTooltip('Destination', { permanent: true, direction: 'top', className: 'wf-tooltip' })
          .addTo(layer);
      }
    }
  }, [selectedSource, selectedDest, graph]);

  // ── Bring newly chosen places into view ───────────────────────────────────
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    const pts = [selectedSource, selectedDest]
      .map(id => id ? graphRef.current.nodes.get(id) : undefined)
      .filter((n): n is NonNullable<typeof n> => !!n)
      .map(n => [n.lat, n.lng] as [number, number]);
    if (pts.length === 2) {
      map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 16 });
    } else if (pts.length === 1 && !map.getBounds().pad(-0.1).contains(pts[0])) {
      map.setView(pts[0], Math.max(map.getZoom(), 15));
    }
  }, [selectedSource, selectedDest]);

  // ── Update signals (circles only, zoom-dependent LOD) ────────────────────
  useEffect(() => {
    const layer = signalLayerRef.current; if (!layer) return;

    layer.clearLayers();
    const hasRoads = graph.edges.size > 0;
    const mapZoom = mapRef.current?.getZoom() ?? 13;
    const minEdgeCount = mapZoom <= 13 ? 0 : mapZoom <= 15 ? 2 : 3;

    for (const sig of signals.values()) {
      const nodeId = sig.nodeId;
      const node = graph.nodes.get(nodeId); if (!node) continue;
      const adjEdges = graph.adjacency.get(nodeId)?.length ?? 0;
      if (hasRoads && adjEdges < minEdgeCount) continue;

      const phase = sig.phases[sig.currentPhaseIndex];
      const isGreen = phase.color === 'GREEN';
      const isYellow = phase.color === 'YELLOW';
      const color = isGreen ? '#00E676' : isYellow ? '#FFD600' : '#FF1744';
      const pulseSize = isGreen ? 9 : 7;

      const circle = L.circleMarker([node.lat, node.lng], {
        radius: pulseSize, color, fillColor: color, fillOpacity: 0.9, weight: 3,
        // Drivers tap roads (to set places or report blocks); signal details are for operators
        interactive: !simpleViewRef.current,
      }).addTo(layer);

      // Click shows popup with signal details
      circle.bindPopup(`
        <div style="font-family:monospace;font-size:11px;color:#ccc;background:#111;padding:8px;min-width:160px;">
          <div style="font-weight:bold;color:#fff;margin-bottom:4px;">${sig.id}</div>
          <div>Phase: <span style="color:${color}">${phase.color}</span> → ${phase.group}</div>
          <div>Timer: ${sig.timer.toFixed(1)}s / ${phase.duration.toFixed(0)}s</div>
          <div>Cycle: ${sig.cycleLength.toFixed(0)}s</div>
          <div>Congestion: ${(sig.congestionLevel * 100).toFixed(0)}%</div>
          <div>Edges: ${adjEdges}</div>
          ${sig.greenWaveDirection ? `<div>Green Wave: ${sig.greenWaveDirection}</div>` : ''}
        </div>
      `, { className: 'wf-popup' });
    }
  }, [signals, graph]);

  // ── Update vehicles with rotation ────────────────────────────────────────
  useEffect(() => {
    const layer = vehicleLayerRef.current; if (!layer) return;
    const markers = vehicleMarkersRef.current;
    const active = new Set(vehicles.keys());

    // Remove stale markers
    for (const [id] of markers) {
      if (!active.has(id)) { markers.get(id)?.remove(); markers.delete(id); }
    }

    for (const [, v] of vehicles) {
      const icon = VEHICLE_ICONS[v.type] || '🚗';
      const rotation = Math.round(v.bearing / 15) * 15;
      const navGlow = v.isNavigated ? 'box-shadow:0 0 8px 3px #4488FF;' : '';
      const iconKey = `${icon}_${rotation}_${v.color}_${v.isNavigated ? 'nav' : ''}`;
      const existing = markers.get(v.id);

      if (existing) {
        existing.setLatLng([v.lat, v.lng]);
        existing.setTooltipContent(`${v.type.toUpperCase()} · ${Math.round(v.speed)} km/h`);
        // Only update icon if rotation/color changed
        if ((existing as any)._lastIconKey !== iconKey) {
          let cachedIcon = iconCacheRef.current.get(iconKey);
          if (!cachedIcon) {
            cachedIcon = L.divIcon({
              className: '',
              html: `<div style="font-size:16px;transform:rotate(${rotation}deg);filter:drop-shadow(0 1px 3px ${v.color});transform-origin:center;${navGlow}">${icon}</div>`,
              iconSize: [20, 20], iconAnchor: [10, 10],
            });
            iconCacheRef.current.set(iconKey, cachedIcon);
          }
          existing.setIcon(cachedIcon);
          (existing as any)._lastIconKey = iconKey;
        }
      } else {
        let cachedIcon = iconCacheRef.current.get(iconKey);
        if (!cachedIcon) {
          cachedIcon = L.divIcon({
            className: '',
            html: `<div style="font-size:16px;transform:rotate(${rotation}deg);filter:drop-shadow(0 1px 3px ${v.color});transform-origin:center;${navGlow}">${icon}</div>`,
            iconSize: [20, 20], iconAnchor: [10, 10],
          });
          iconCacheRef.current.set(iconKey, cachedIcon);
        }
        const tooltipText = `${v.type.toUpperCase()} · ${Math.round(v.speed)} km/h`;
        const newMarker = L.marker([v.lat, v.lng], {
          icon: cachedIcon,
          zIndexOffset: v.type === 'emergency' ? 1000 : 0,
          // In heavy traffic cars cover the roads; let drivers' taps reach the map
          interactive: !simpleViewRef.current,
        }).bindTooltip(tooltipText, {
          direction: 'top', offset: [0, -2], className: 'wf-tooltip',
        }).addTo(layer);
        (newMarker as any)._lastIconKey = iconKey;
        markers.set(v.id, newMarker);
      }
    }
  }, [vehicles, vehicleVersion]);

  // ── Congestion heatmap ────────────────────────────────────────────────────
  useEffect(() => {
    const layer = heatmapLayerRef.current; if (!layer) return;
    layer.clearLayers();
    if (!showHeatmap) return;
    for (const zone of congestionZones) {
      const color = zone.level > 0.7 ? '#FF1744' : zone.level > 0.4 ? '#FF9100' : '#FFEB3B';
      const r = Math.max(15, Math.min(50, zone.vehicles * 5));
      L.circleMarker([zone.centerLat, zone.centerLng], {
        radius: r, color, fillColor: color, fillOpacity: zone.level * 0.3,
        weight: 1, opacity: 0.5,
      }).addTo(layer);
    }
  }, [congestionZones, showHeatmap]);

  // ── Route display ──────────────────────────────────────────────────────────
  useEffect(() => {
    const layer = routeLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const alt of altRoutePolylines ?? []) {
      if (alt.length > 1) L.polyline(alt, { color: '#8899AA', weight: 5, opacity: 0.5 }).addTo(layer);
    }
    if (routePolyline && routePolyline.length > 1) {
      L.polyline(routePolyline, {
        color: '#4488FF', weight: 6, opacity: 0.9,
      }).addTo(layer);
    }
    if (reroutePolyline && reroutePolyline.length > 1) {
      L.polyline(reroutePolyline, { color: '#00E676', weight: 6, opacity: 0.9, dashArray: '10, 8' }).addTo(layer);
    }
  }, [routePolyline, altRoutePolylines, reroutePolyline]);

  // ── Road blocks ────────────────────────────────────────────────────────────
  useEffect(() => {
    const layer = blockLayerRef.current; if (!layer) return;
    layer.clearLayers();
    for (const b of blocks) {
      for (const id of b.edgeIds) {
        const geom = graph.edges.get(id)?.geometry;
        if (geom && geom.length > 1) {
          L.polyline(geom.map(p => [p.lat, p.lng] as [number, number]), { color: '#FF1744', weight: 7, opacity: 0.85 }).addTo(layer);
        }
      }
      L.marker([b.lat, b.lng], {
        icon: L.divIcon({ className: '', html: '<div style="font-size:22px;line-height:22px">🚧</div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
        zIndexOffset: 2000,
      }).bindTooltip(`${b.roadName}: ${b.reason}`, { direction: 'top', className: 'wf-tooltip' }).addTo(layer);
    }
  }, [blocks, graph]);

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

  const nearbyBlock = contextMenu
    ? blocks.find(b => distanceMetres(b, contextMenu) < 80) ?? null
    : null;

  const handleSetDest = useCallback(() => {
    if (contextMenu?.nodeId) onSelectDest(contextMenu.nodeId);
  }, [contextMenu, onSelectDest]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* Mini-map */}
      {!simpleView && <div id="mini-map" style={{
        position: 'absolute', bottom: 12, right: 12, zIndex: 1000,
        width: 160, height: 120, borderRadius: 8, overflow: 'hidden',
        border: '2px solid #333', boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
      }} />}

      {/* Live stats HUD */}
      {!simpleView && <div style={{
        position: 'absolute', top: 12, left: 270, zIndex: 1001,
        background: 'rgba(10,10,20,0.85)', border: '1px solid #333', borderRadius: 8,
        padding: '6px 12px', fontFamily: 'monospace', fontSize: 11, color: '#ccc',
        display: 'flex', gap: 14, backdropFilter: 'blur(4px)',
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
          backdropFilter: 'blur(4px)',
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
          onReportBlock={() => {
            const map = mapRef.current;
            const radius = map ? map.containerPointToLatLng([0, 0]).distanceTo(map.containerPointToLatLng([24, 0])) : 60;
            onReportBlock?.(contextMenu.lat, contextMenu.lng, radius);
          }}
          nearbyBlock={nearbyBlock}
          onClearBlock={id => onClearBlock?.(id)}
          simple={simpleView}
        />
      )}

      <style>{`
        .wf-tooltip {
          background: rgba(0,0,0,0.8) !important;
          border: 1px solid #444 !important;
          color: #fff !important;
          font-size: 11px !important;
        }
        .wf-tooltip::before { display: none !important; }
        .wf-popup .leaflet-popup-content-wrapper { background: #111 !important; color: #ccc !important; border-radius: 6px !important; border: 1px solid #333 !important; }
        .wf-popup .leaflet-popup-tip { background: #111 !important; border: 1px solid #333 !important; }
        .wf-popup .leaflet-popup-close-button { color: #666 !important; }
      `}</style>
    </div>
  );
}
