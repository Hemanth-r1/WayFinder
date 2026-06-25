import { useRef, useState } from 'react';
import MapView from './components/MapView';
import { TrafficEngine } from './engine/TrafficEngine';

function App() {
  const engineRef = useRef<TrafficEngine | null>(null);
  const [ready, setReady] = useState(false);

  if (!engineRef.current) {
    engineRef.current = new TrafficEngine();
    engineRef.current.setFirebaseSync(false);
    setReady(true);
  }

  return (
    <div style={{ width: '100vw', height: '100vh', margin: 0, padding: 0, overflow: 'hidden' }}>
      {ready && engineRef.current && <MapView engine={engineRef.current} />}
    </div>
  );
}

export default App;
