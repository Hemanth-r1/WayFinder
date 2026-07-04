import { useRef, useState, useEffect, useCallback } from 'react';
import MapView from './components/MapView';
import { TrafficEngine } from './engine/TrafficEngine';
import type { Direction, SignalColor } from './types';

function App() {
  const engineRef = useRef<TrafficEngine | null>(null);
  const frameRef = useRef(0);
  const lastTimeRef = useRef(0);
  const [paused, setPaused] = useState(false);
  const [, setTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadStatus, setLoadStatus] = useState('Initializing...');
  const [overrideActive, setOverrideActive] = useState(false);
  const [overrideTimeRemaining, setOverrideTimeRemaining] = useState(0);

  useEffect(() => {
    const engine = new TrafficEngine();
    engineRef.current = engine;

    setLoadStatus('Fetching Bangalore road data from OpenStreetMap...');
    engine.init().then(() => {
      setLoading(false);
      engine.start();

      const loop = (time: number) => {
        const rawDelta = lastTimeRef.current ? (time - lastTimeRef.current) / 1000 : 0;
        lastTimeRef.current = time;
        const dt = Math.min(rawDelta, 0.05);
        if (!paused && engine.running) {
          engine.update(dt);
          if (engine.isManualOverrideActive()) {
            setOverrideActive(true);
            setOverrideTimeRemaining(engine.getManualOverrideTimeRemaining());
          } else if (overrideActive) {
            setOverrideActive(false);
          }
        }
        setTick(t => t + 1);
        frameRef.current = requestAnimationFrame(loop);
      };
      frameRef.current = requestAnimationFrame(loop);
    }).catch((err) => {
      console.error('Engine init failed:', err);
      setLoadStatus('Failed to load road data. Using fallback.');
      engine.start();
      setLoading(false);
    });

    return () => {
      cancelAnimationFrame(frameRef.current);
      engineRef.current?.stop();
    };
  }, []);

  const handleTogglePause = useCallback(() => setPaused(p => !p), []);
  const handleNodeClick = useCallback(() => {}, []);
  const handleManualOverride = useCallback((signalId: string, direction: string, color: string) => {
    engineRef.current?.manualOverrideSignal(signalId, direction as Direction, color as SignalColor);
    setOverrideActive(true);
  }, []);
  const handleCancelOverride = useCallback(() => {
    engineRef.current?.deactivateManualOverride();
    setOverrideActive(false);
  }, []);
  const handleSpawnVehicle = useCallback((direction: Direction) => {
    engineRef.current?.spawnVehicleFromDirection(direction);
  }, []);

  if (loading) {
    return (
      <div style={{
        width: '100vw', height: '100vh', display: 'flex', alignItems: 'center',
        justifyContent: 'center', background: '#0a0a14', color: '#fff',
        fontFamily: 'system-ui', flexDirection: 'column', gap: 20,
      }}>
        <div style={{
          width: 60, height: 60, border: '4px solid #333', borderTop: '4px solid #FF6D00',
          borderRadius: '50%', animation: 'spin 1s linear infinite',
        }} />
        <div style={{ fontSize: 20, fontWeight: 'bold' }}>WayFinder</div>
        <div style={{ color: '#888', fontSize: 14 }}>{loadStatus}</div>
        <style>{`@keyframes spin { 100% { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  const e = engineRef.current;
  if (!e) return null;

  return (
    <div style={{ width: '100vw', height: '100vh', margin: 0, padding: 0, overflow: 'hidden' }}>
      <MapView
        graph={e.graph} signals={e.signals} vehicles={e.vehicles}
        congestionZones={e.congestionZones} stats={e.stats}
        onNodeClick={handleNodeClick} paused={paused}
        onTogglePause={handleTogglePause} onSpawnVehicle={handleSpawnVehicle}
        onManualOverride={handleManualOverride} onCancelOverride={handleCancelOverride}
        overrideActive={overrideActive} overrideTimeRemaining={overrideTimeRemaining}
        signalsMap={e.signals}
      />
    </div>
  );
}

export default App;
