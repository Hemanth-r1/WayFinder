import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { RoadGraph, TrafficSignal, Vehicle, CongestionZone, Direction, SignalColor } from '../types';
import { findNearestNode } from '../data/roadNetwork';
import NavigationPanel from './NavigationPanel';
import ControlPanel from './ControlPanel';

const VEHICLE_SIZES: Record<string, number> = {
  sedan: 9, suv: 10, hatchback: 8, truck: 11, bus: 12, emergency: 10, bike: 7, auto: 8, van: 10,
};
const VEHICLE_ICONS: Record<string, string> = {
  sedan: '\u{1F697}', suv: '\u{1F699}', hatchback: '\u{1F697}', truck: '\u{1F69A}',
  bus: '\u{1F68C}', emergency: '\u{1F6A8}', bike: '\u{1F6F5}', auto: '\u{1F68F}', van: '\u{1F4FB}',
};

interface MapViewProps {
  graph: RoadGraph;
  signals: Map<string, TrafficSignal>;
  vehicles: Map<string, Vehicle>;
  congestionZones: CongestionZone[];
  stats: {
    totalVehicles: number;
    avgSpeed: number;
    congestionHotspots: number;
    greenWaveActive: boolean;
    signalCoordinationScore: number;
  };
  onNodeClick: (nodeId: string) => void;
  paused: boolean;
  onTogglePause: () => void;
  onSpawnVehicle: (dir: Direction) => void;
  onManualOverride: (signalId: string, direction: Direction, color: SignalColor) => void;
  onCancelOverride: () => void;
  overrideActive: boolean;
  overrideTimeRemaining: number;
  signalsMap: Map<string, TrafficSignal>;
}

export default function MapView({
  graph, signals, vehicles, congestionZones, stats,
  onNodeClick, paused, onTogglePause, onSpawnVehicle,
  onManualOverride, onCancelOverride, overrideActive, overrideTimeRemaining,
  signalsMap,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const miniMapRef = useRef<L.Map | null>(null);
  const roadLayerRef = useRef<L.LayerGroup | null>(null);
  const signalLayerRef = useRef<L.LayerGroup | null>(null);
  const vehicleLayerRef = useRef<L.LayerGroup | null>(null);
  const heatmapLayerRef = useRef<L.LayerGroup | null>(null);
  const vehicleMarkersRef = useRef<Map<string, L.CircleMarker>>(new Map());
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [selectedDest, setSelectedDest] = useState<string | null>(null);

  const center: [number, number] = [12.9716, 77.5946];

  // Init main map
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    const map = L.map(container, { center, zoom: 16, zoomControl: false });
    L.control.zoom({ position: 'bottomleft' }).addTo(map);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);

    mapRef.current = map;
    roadLayerRef.current = L.layerGroup().addTo(map);
    signalLayerRef.current = L.layerGroup().addTo(map);
    vehicleLayerRef.current = L.layerGroup().addTo(map);
    heatmapLayerRef.current = L.layerGroup().addTo(map);

    // Draw roads
    const drawn = new Set<string>();
    for (const [, edge] of graph.edges) {
      const key = [edge.from, edge.to].sort().join('-');
      if (drawn.has(key)) continue;
      drawn.add(key);
      const f = graph.nodes.get(edge.from);
      const t = graph.nodes.get(edge.to);
      if (!f || !t) continue;
      const isPrimary = edge.roadType === 'primary';
      const isSecondary = edge.roadType === 'secondary';
      L.polyline(
        [[f.lat, f.lng], [t.lat, t.lng]],
        { color: isPrimary ? '#FF6D00' : isSecondary ? '#FF9100' : '#FFAB4066', weight: isPrimary ? 4 : isSecondary ? 3 : 1.5, opacity: isPrimary ? 0.8 : isSecondary ? 0.6 : 0.4 },
      ).addTo(roadLayerRef.current!);
    }

    // Click handler
    map.on('click', (e: L.LeafletMouseEvent) => {
      const nearest = findNearestNode(graph.nodes, e.latlng.lat, e.latlng.lng);
      if (nearest) {
        if (!selectedSource) setSelectedSource(nearest.id);
        else if (!selectedDest) setSelectedDest(nearest.id);
        else { setSelectedSource(nearest.id); setSelectedDest(null); }
        onNodeClick(nearest.id);
      }
    });

    // Init mini-map
    const miniEl = document.getElementById('mini-map');
    if (miniEl && !miniMapRef.current) {
      const mm = L.map(miniEl, { center, zoom: 11, zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(mm);
      L.circleMarker(center, { radius: 6, color: '#4488FF', fillColor: '#4488FF', fillOpacity: 1, weight: 2 }).addTo(mm);
      miniMapRef.current = mm;
    }

    return () => {
      map.remove();
      mapRef.current = null;
      if (miniMapRef.current) { miniMapRef.current.remove(); miniMapRef.current = null; }
    };
  }, []);

  // Update signals
  useEffect(() => {
    const layer = signalLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const [nodeId, sig] of signals) {
      const node = graph.nodes.get(nodeId);
      if (!node) continue;
      const phase = sig.phases[sig.currentPhaseIndex];
      const isGreen = phase.color === 'GREEN';
      const isNS = phase.direction === 'N' || phase.direction === 'S';
      const color = isGreen ? (isNS ? '#00E676' : '#FFD600') : '#FF1744';

      // Signal dot
      L.circleMarker([node.lat, node.lng], {
        radius: 8, color, fillColor: color, fillOpacity: 0.95, weight: 3,
      }).addTo(layer);

      // Signal label
      L.marker([node.lat, node.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div style="position:absolute;top:-24px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.88);color:${color};padding:1px 6px;border-radius:3px;font-size:10px;font-family:monospace;font-weight:bold;white-space:nowrap;border:1px solid ${color}44;pointer-events:none;">${sig.id} <span style="color:#fff">${phase.color}</span></div>`,
          iconSize: [0, 0],
          iconAnchor: [0, 12],
        }),
      }).addTo(layer);
    }
  }, [signals, graph]);

  // Update vehicles
  useEffect(() => {
    const layer = vehicleLayerRef.current;
    if (!layer) return;
    const markers = vehicleMarkersRef.current;
    const active = new Set(vehicles.keys());
    for (const [id] of markers) {
      if (!active.has(id)) { markers.get(id)?.remove(); markers.delete(id); }
    }
    for (const [, v] of vehicles) {
      const size = VEHICLE_SIZES[v.type] || 9;
      let m = markers.get(v.id);
      if (m) {
        m.setLatLng([v.lat, v.lng]);
      } else {
        m = L.circleMarker([v.lat, v.lng], {
          radius: size, color: v.color, fillColor: v.color, fillOpacity: 0.95, weight: 2,
        }).addTo(layer);
        markers.set(v.id, m);
      }
    }
  }, [vehicles]);

  // Update heatmap
  useEffect(() => {
    const layer = heatmapLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const zone of congestionZones) {
      const color = zone.level > 0.7 ? '#FF1744' : zone.level > 0.4 ? '#FF9100' : '#00E676';
      L.circleMarker([zone.centerLat, zone.centerLng], {
        radius: Math.max(30, zone.radius), color, fillColor: color, fillOpacity: 0.15, weight: 1, opacity: 0.4,
      }).addTo(layer);
    }
  }, [congestionZones]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* Mini-map */}
      <div id="mini-map" style={{
        position: 'absolute', bottom: 80, right: 12, zIndex: 1000,
        width: 180, height: 130, borderRadius: 8, overflow: 'hidden',
        border: '2px solid #444', boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
      }} />

      {/* Vehicle legend */}
      <div style={{
        position: 'absolute', bottom: 80, left: 12, zIndex: 1000,
        background: 'rgba(10,10,20,0.92)', padding: '8px 12px', borderRadius: 8,
        border: '1px solid #333', fontFamily: 'monospace', fontSize: 11,
      }}>
        <div style={{ color: '#fff', fontWeight: 'bold', marginBottom: 4, fontSize: 10, textTransform: 'uppercase' }}>Vehicles</div>
        {Object.entries(VEHICLE_ICONS).map(([type, icon]) => (
          <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1 }}>
            <span style={{ fontSize: 12 }}>{icon}</span>
            <span style={{ color: '#aaa' }}>{type}</span>
          </div>
        ))}
      </div>

      <NavigationPanel
        graph={graph}
        signals={signals}
        onRouteCalculated={() => {}}
        onNodeSelect={(id) => { if (id) { if (!selectedSource) setSelectedSource(id); else setSelectedDest(id); } }}
        selectedSource={selectedSource}
        selectedDest={selectedDest}
      />

      <ControlPanel
        isRunning={!paused}
        vehicleCount={stats.totalVehicles}
        avgSpeed={stats.avgSpeed}
        congestionHotspots={stats.congestionHotspots}
        greenWaveActive={stats.greenWaveActive}
        signalCoordination={stats.signalCoordinationScore}
        onTogglePause={onTogglePause}
        onSpawnVehicle={onSpawnVehicle}
        onManualOverride={(sid, dir, col) => onManualOverride(sid, dir as Direction, col as SignalColor)}
        overrideActive={overrideActive}
        overrideTimeRemaining={overrideTimeRemaining}
        onCancelOverride={onCancelOverride}
        signals={signalsMap}
      />

      {/* Stats bar */}
      <div style={{
        position: 'absolute', top: 12, left: 12, zIndex: 1000,
        background: 'rgba(10,10,20,0.92)', color: '#ccc', padding: '12px 16px',
        borderRadius: 10, fontFamily: 'monospace', fontSize: 12, minWidth: 190,
        lineHeight: 1.8, border: '1px solid #333',
      }}>
        <div style={{ color: '#fff', fontWeight: 'bold', fontSize: 14, marginBottom: 6 }}>Traffic Monitor</div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#888' }}>Vehicles</span><span style={{ color: '#fff', fontWeight: 'bold' }}>{stats.totalVehicles}</span></div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#888' }}>Avg Speed</span><span style={{ color: '#fff', fontWeight: 'bold' }}>{stats.avgSpeed} km/h</span></div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#888' }}>Congestion</span><span style={{ color: stats.congestionHotspots > 3 ? '#FF1744' : '#4CAF50', fontWeight: 'bold' }}>{stats.congestionHotspots} hotspots</span></div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#888' }}>Green Wave</span><span style={{ color: stats.greenWaveActive ? '#4CAF50' : '#666', fontWeight: 'bold' }}>{stats.greenWaveActive ? 'ACTIVE' : 'OFF'}</span></div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#888' }}>Coordination</span><span style={{ color: '#fff', fontWeight: 'bold' }}>{stats.signalCoordinationScore}%</span></div>
      </div>

      {/* Override banner */}
      {overrideActive && (
        <div style={{
          position: 'absolute', top: 60, left: '50%', transform: 'translateX(-50%)', zIndex: 1002,
          background: 'rgba(255,152,0,0.15)', border: '1px solid #FF9800', borderRadius: 8,
          padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12,
          fontFamily: 'monospace', fontSize: 12, fontWeight: 'bold',
        }}>
          <span style={{ color: '#FF9800' }}>MANUAL OVERRIDE</span>
          <span style={{ color: '#fff' }}>{Math.round(overrideTimeRemaining)}s</span>
          <button onClick={onCancelOverride} style={{ padding: '4px 10px', background: '#FF9800', color: '#000', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}>Cancel</button>
        </div>
      )}

      {/* Bottom controls */}
      <div style={{
        position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: 8, zIndex: 1000,
      }}>
        <button onClick={onTogglePause} style={{ padding: '8px 20px', background: 'rgba(0,0,0,0.8)', color: '#fff', border: '1px solid #555', borderRadius: 6, cursor: 'pointer', fontFamily: 'monospace', fontSize: 13 }}>
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>
    </div>
  );
}
