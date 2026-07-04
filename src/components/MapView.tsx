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
  onNodeClick: (id: string) => void;
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
}

interface ContextMenuState {
  lat: number; lng: number; nodeId: string | null;
  nodeDegree: number; roadNames: string[];
  screenX: number; screenY: number;
}

export default function MapView({
  graph, signals, vehicles, congestionZones, onNodeClick, onCancelOverride,
  overrideActive, overrideTimeRemaining, selectedSource, selectedDest,
  onSelectSource, onSelectDest, role, graphVersion, vehicleVersion, stats,
  onAddSignal, onSpawnVehicleAt,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const miniMapRef = useRef<L.Map | null>(null);
  const roadLayerRef = useRef<L.LayerGroup | null>(null);
  const signalLayerRef = useRef<L.LayerGroup | null>(null);
  const vehicleLayerRef = useRef<L.LayerGroup | null>(null);
  const heatmapLayerRef = useRef<L.LayerGroup | null>(null);
  const sourceDestLayerRef = useRef<L.LayerGroup | null>(null);
  const vehicleMarkersRef = useRef<Map<string, L.Marker>>(new Map());
  const lastGraphVersion = useRef(0);
  const lastSignalPhases = useRef<Map<string, string>>(new Map());
  const firstFitDone = useRef(false);
  const iconCacheRef = useRef<Map<string, L.DivIcon>>(new Map());

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Prop refs to avoid stale closures in the map click handler
  const graphRef = useRef(graph);
  const roleRef = useRef(role);
  const selectedSourceRef = useRef(selectedSource);
  const selectedDestRef = useRef(selectedDest);
  const onSelectSourceRef = useRef(onSelectSource);
  const onSelectDestRef = useRef(onSelectDest);
  const onNodeClickRef = useRef(onNodeClick);

  graphRef.current = graph;
  roleRef.current = role;
  selectedSourceRef.current = selectedSource;
  selectedDestRef.current = selectedDest;
  onSelectSourceRef.current = onSelectSource;
  onSelectDestRef.current = onSelectDest;
  onNodeClickRef.current = onNodeClick;

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
    sourceDestLayerRef.current = L.layerGroup().addTo(map);

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
      if (nodeId) onNodeClickRef.current(nodeId);
    });

    // Mini-map
    const miniEl = document.getElementById('mini-map');
    if (miniEl && !miniMapRef.current) {
      const mm = L.map(miniEl, {
        center: MAP_CENTER, zoom: 11, zoomControl: false,
        attributionControl: false, dragging: false, scrollWheelZoom: false,
      });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(mm);
      L.circleMarker(MAP_CENTER, { radius: 5, color: '#FF6D00', fillColor: '#FF6D00', fillOpacity: 1, weight: 2 }).addTo(mm);
      miniMapRef.current = mm;
    }

    return () => {
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

  // ── Update signals (only on phase change) ────────────────────────────────
  useEffect(() => {
    const layer = signalLayerRef.current; if (!layer) return;

    // Check if any phase changed
    let changed = false;
    for (const [nodeId, sig] of signals) {
      const phase = sig.phases[sig.currentPhaseIndex];
      const key = `${nodeId}:${phase.color}:${sig.currentPhaseIndex}`;
      if (lastSignalPhases.current.get(nodeId) !== key) {
        changed = true;
        lastSignalPhases.current.set(nodeId, key);
      }
    }
    if (!changed) return;

    layer.clearLayers();
    for (const [nodeId, sig] of signals) {
      const node = graph.nodes.get(nodeId); if (!node) continue;
      const phase = sig.phases[sig.currentPhaseIndex];
      const isGreen = phase.color === 'GREEN';
      const isYellow = phase.color === 'YELLOW';
      const color = isGreen ? '#00E676' : isYellow ? '#FFD600' : '#FF1744';
      const pulseSize = isGreen ? 9 : 7;

      L.circleMarker([node.lat, node.lng], {
        radius: pulseSize, color, fillColor: color, fillOpacity: 0.9, weight: 3,
      }).addTo(layer);

      L.marker([node.lat, node.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div style="position:absolute;top:-26px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.9);color:${color};padding:1px 6px;border-radius:3px;font-size:9px;font-family:monospace;font-weight:bold;white-space:nowrap;border:1px solid ${color}44;pointer-events:none;">${sig.id}<span style="color:#aaa"> ${phase.color}</span></div>`,
          iconSize: [0, 0], iconAnchor: [0, 12],
        }),
      }).addTo(layer);
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
      const rotation = Math.round(v.bearing / 15) * 15; // bucket to 15-degree increments
      const iconKey = `${icon}_${rotation}_${v.color}`;
      const existing = markers.get(v.id);

      if (existing) {
        existing.setLatLng([v.lat, v.lng]);
        // Only update icon if rotation/color changed
        if ((existing as any)._lastIconKey !== iconKey) {
          let cachedIcon = iconCacheRef.current.get(iconKey);
          if (!cachedIcon) {
            cachedIcon = L.divIcon({
              className: '',
              html: `<div style="font-size:16px;transform:rotate(${rotation}deg);filter:drop-shadow(0 1px 3px ${v.color});transform-origin:center;">${icon}</div>`,
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
            html: `<div style="font-size:16px;transform:rotate(${rotation}deg);filter:drop-shadow(0 1px 3px ${v.color});transform-origin:center;">${icon}</div>`,
            iconSize: [20, 20], iconAnchor: [10, 10],
          });
          iconCacheRef.current.set(iconKey, cachedIcon);
        }
        const newMarker = L.marker([v.lat, v.lng], {
          icon: cachedIcon,
          zIndexOffset: v.type === 'emergency' ? 1000 : 0,
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
    for (const zone of congestionZones) {
      const color = zone.level > 0.7 ? '#FF1744' : zone.level > 0.4 ? '#FF9100' : '#FFEB3B';
      const r = Math.max(15, Math.min(50, zone.vehicles * 5));
      L.circleMarker([zone.centerLat, zone.centerLng], {
        radius: r, color, fillColor: color, fillOpacity: zone.level * 0.3,
        weight: 1, opacity: 0.5,
      }).addTo(layer);
    }
  }, [congestionZones]);

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

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* Mini-map */}
      <div id="mini-map" style={{
        position: 'absolute', bottom: 12, right: 12, zIndex: 1000,
        width: 160, height: 120, borderRadius: 8, overflow: 'hidden',
        border: '2px solid #333', boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
      }} />

      {/* Live stats HUD */}
      <div style={{
        position: 'absolute', top: 10, left: 10, zIndex: 1001,
        background: 'rgba(10,10,20,0.85)', border: '1px solid #333', borderRadius: 8,
        padding: '6px 12px', fontFamily: 'monospace', fontSize: 11, color: '#ccc',
        display: 'flex', gap: 14, backdropFilter: 'blur(4px)',
      }}>
        <span>🚗 {stats.vehicleCount}</span>
        <span>⚡ {stats.avgSpeed} km/h</span>
        <span style={{ color: stats.congestionHotspots > 3 ? '#FF1744' : '#4CAF50' }}>
          🔥 {stats.congestionHotspots}
        </span>
        <span style={{ color: stats.greenWaveActive ? '#00E676' : '#555' }}>
          🌊 {stats.greenWaveActive ? 'ON' : 'OFF'}
        </span>
        <span style={{ color: stats.signalCoordinationScore > 60 ? '#00E676' : '#FF9800' }}>
          📡 {stats.signalCoordinationScore}%
        </span>
      </div>

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
      `}</style>
    </div>
  );
}
