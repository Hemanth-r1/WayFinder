import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { TrafficEngine } from '../engine/TrafficEngine';

interface MapViewProps {
  engine: TrafficEngine;
}

const GREEN = '#00e676';
const RED = '#ff1744';

function isNSPhase(p: { direction: string }): boolean {
  return p.direction === 'N' || p.direction === 'S';
}

export default function MapView({ engine }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const frameRef = useRef(0);
  const lastTimeRef = useRef(0);
  const runningRef = useRef(true);
  const pausedRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const vehicleMarkers = useRef<Map<string, L.CircleMarker>>(new Map());
  const signalMarkers = useRef<Map<string, L.CircleMarker>>(new Map());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;
    runningRef.current = true;

    const map = L.map(container, {
      center: [engine.grid.centerLat, engine.grid.centerLng],
      zoom: 15,
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    mapRef.current = map;

    const roadGroup = L.layerGroup().addTo(map);
    for (const [, seg] of engine.roadSegments) {
      L.polyline(
        [[seg.from.lat, seg.from.lng], [seg.to.lat, seg.to.lng]],
        { color: '#ff8800', weight: 5, opacity: 0.5 }
      ).addTo(roadGroup);
    }

    const signalGroup = L.layerGroup().addTo(map);
    for (const [id, sig] of engine.signals) {
      const int = engine.intersections.get(id);
      if (!int) continue;
      const isNS = isNSPhase(sig.phases[0]);
      const m = L.circleMarker([int.lat, int.lng], {
        radius: 6, color: isNS ? GREEN : RED, fillColor: isNS ? GREEN : RED,
        fillOpacity: 0.8, weight: 2,
      }).addTo(signalGroup);
      signalMarkers.current.set(id, m);
    }

    const greenWaveLayer = L.layerGroup().addTo(map);
    const blockerGroup = L.layerGroup().addTo(map);
    const updateBlockers = () => {
      blockerGroup.clearLayers();
      for (const segId of engine.stats.blockedRoutes) {
        const seg = engine.roadSegments.get(segId);
        if (!seg) continue;
        const midLat = (seg.from.lat + seg.to.lat) / 2;
        const midLng = (seg.from.lng + seg.to.lng) / 2;
        L.circleMarker([midLat, midLng], {
          radius: 14, color: '#ff0000', fillColor: '#ff000044',
          fillOpacity: 0.5, weight: 2, opacity: 0.8,
        }).addTo(blockerGroup);
      }
    };

    let debugCount = 0;
    const animLoop = (time: number) => {
      try {
        if (!runningRef.current) return;
        const rawDelta = lastTimeRef.current ? (time - lastTimeRef.current) / 1000 : 0;
        lastTimeRef.current = time;
        const dt = Math.min(rawDelta, 0.05);

        if (!pausedRef.current) {
          engine.update(dt);
        }

        debugCount++;
        if (debugCount % 60 === 0) {
          console.log(`WayFinder: running=${engine.running} vehicles=${engine.vehicles.size}`);
        }

        const vm = vehicleMarkers.current;
        const active = new Set(engine.vehicles.keys());

        for (const [id] of vm) {
          if (!active.has(id)) {
            const m = vm.get(id);
            if (m) map.removeLayer(m);
            vm.delete(id);
          }
        }

        for (const [, v] of engine.vehicles) {
          let m = vm.get(v.id);
          if (m) {
            m.setLatLng([v.lat, v.lng]);
          } else {
            vm.set(v.id, L.circleMarker([v.lat, v.lng], {
              radius: 7, color: v.color, fillColor: v.color, fillOpacity: 0.9, weight: 2,
            }).addTo(map));
          }
        }

        for (const [intId, m] of signalMarkers.current) {
          const sig = engine.signals.get(intId);
          if (!sig) continue;
          const phase = sig.phases[sig.currentPhaseIndex];
          const isNS = isNSPhase(phase);
          m.setStyle({ color: isNS && phase.color === 'GREEN' ? GREEN : RED, fillColor: isNS && phase.color === 'GREEN' ? GREEN : RED });
        }

        greenWaveLayer.clearLayers();
        for (const [, sig] of engine.signals) {
          if (sig.greenWaveDirection) {
            const ints = engine.intersections.get(sig.intersectionId);
            if (!ints) continue;
            L.circleMarker([ints.lat, ints.lng], {
              radius: 16, color: GREEN, fillColor: GREEN, fillOpacity: 0.08, weight: 1, opacity: 0.3,
            }).addTo(greenWaveLayer);
          }
        }

        updateBlockers();
      } catch (e) {
        console.error('WayFinder anim error:', e);
      }

      frameRef.current = requestAnimationFrame(animLoop);
    };

    engine.start();
    console.log('WayFinder: engine started, intersections:', engine.intersections.size);
    frameRef.current = requestAnimationFrame(animLoop);

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'p') {
        e.preventDefault();
        pausedRef.current = !pausedRef.current;
        setPaused(pausedRef.current);
      }
    };
    window.addEventListener('keydown', handleKey);

    const interval = setInterval(() => setTick(t => t + 1), 500);

    const handleResize = () => map.invalidateSize();
    window.addEventListener('resize', handleResize);

    return () => {
      runningRef.current = false;
      cancelAnimationFrame(frameRef.current);
      clearInterval(interval);
      engine.stop();
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', handleResize);
      map.remove();
      mapRef.current = null;
      vehicleMarkers.current.clear();
      signalMarkers.current.clear();
    };
  }, [engine]);

  const s = engine.stats;
  const congestionBar = '#'.repeat(Math.min(10, s.congestionHotspots)) + '-'.repeat(Math.max(0, 10 - s.congestionHotspots));

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <div style={{
        position: 'absolute', top: 12, left: 12, zIndex: 1000,
        background: 'rgba(0,0,0,0.8)', color: '#ccc',
        padding: '10px 14px', borderRadius: 8, fontFamily: 'monospace',
        fontSize: 12, minWidth: 200, lineHeight: 1.7, border: '1px solid #333',
        pointerEvents: 'none',
      }}>
        <div style={{ color: '#fff', fontWeight: 'bold', fontSize: 14, marginBottom: 4 }}>WayFinder Traffic</div>
        <div>Vehicles: <b style={{ color: '#fff' }}>{s.totalVehicles}</b></div>
        <div>Avg Speed: <b style={{ color: '#fff' }}>{s.avgSpeed}</b></div>
        <div>Congestion: <b style={{ color: s.congestionHotspots > 3 ? RED : GREEN }}>{congestionBar}</b></div>
        <div>Green Wave: <b style={{ color: s.greenWaveActive ? GREEN : '#ccc' }}>{s.greenWaveActive ? 'ACTIVE' : 'INACTIVE'}</b></div>
        <div>Coordination: <b style={{ color: '#fff' }}>{s.signalCoordinationScore}%</b></div>
        <div>Blocked: {s.blockedRoutes.length > 0
          ? <b style={{ color: RED }}>{s.blockedRoutes.length} route(s)</b>
          : 'None'}</div>
      </div>
      <div style={{
        position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: 8, zIndex: 1000, flexWrap: 'wrap', justifyContent: 'center',
      }}>
        <button onClick={() => { pausedRef.current = !pausedRef.current; setPaused(pausedRef.current); }}
          style={btnStyle}>{paused ? '▶ Resume' : '⏸ Pause'}</button>
        <button onClick={() => engine.addRandomBlockage()} style={btnStyle}>🚧 Block Route</button>
        <button onClick={() => engine.clearBlockage()} style={btnStyle}>🧹 Clear All</button>
        <button onClick={() => engine.toggleFirebaseSync(true)} style={btnStyle}>🔥 Sync</button>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: 'rgba(0,0,0,0.75)',
  color: '#fff',
  border: '1px solid #555',
  borderRadius: 6,
  cursor: 'pointer',
  fontFamily: 'monospace',
  fontSize: 13,
  backdropFilter: 'blur(4px)',
};
