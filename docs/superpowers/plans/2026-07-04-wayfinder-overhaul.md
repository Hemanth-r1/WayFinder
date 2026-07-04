# WayFinder Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix known bugs, overhaul UI layout, add keyboard shortcuts, speed control, heatmap toggle, toast notifications, vehicle tooltips, vehicle list panel, and route display.

**Architecture:** Shared geo util extracted; all new UI state managed via React hooks/context in App.tsx; no external state libraries added.

**Tech Stack:** React 19, TypeScript 6, Leaflet 1.9, Vite 8

## Global Constraints

- `verbatimModuleSyntax: true` — always use `import type` for type-only imports
- `erasableSyntaxOnly: true` — no enums, namespaces, parameter properties
- `noUnusedLocals` / `noUnusedParameters` are errors — remove unused imports/vars
- No test framework — verify by running `npm run build` and `npm run lint`
- Inline styles throughout (no CSS modules, no Tailwind)
- No external dependencies beyond existing: firebase, leaflet, react, react-dom

---

### Task 1: Extract shared geo utility

**Files:**
- Create: `src/utils/geo.ts`
- Modify: `src/engine/congestion.ts`, `src/engine/signalControl.ts`, `src/engine/vehicleSim.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `haversineMeters(lat1, lng1, lat2, lng2): number`, `bearingBetween(lat1, lng1, lat2, lng2): number`

- [ ] **Step 1: Create `src/utils/geo.ts`**

```typescript
const EARTH_RADIUS_M = 6371000;

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

export function bearingBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
    Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}
```

- [ ] **Step 2: Replace duplicate in `src/engine/congestion.ts`**

Add import: `import { haversineMeters } from '../utils/geo';`
Remove the local `haversineMeters` function (lines 5-10).
Remove unused `EARTH_RADIUS_M` constant.

- [ ] **Step 3: Replace duplicate in `src/engine/signalControl.ts`**

Add import: `import { haversineMeters } from '../utils/geo';`
Remove the local `haversineMeters` function (lines 6-11).
Remove unused `EARTH_RADIUS_M` constant.

- [ ] **Step 4: Replace duplicate in `src/engine/vehicleSim.ts`**

Add import: `import { haversineMeters } from '../utils/geo';`
Remove the local `haversineMeters` function (lines 164-170).

- [ ] **Step 5: Build and lint check**

Run: `npm run build` and `npm run lint`

---

### Task 2: Fix TrafficEngine bugs

**Files:**
- Modify: `src/engine/TrafficEngine.ts`

**Interfaces:**
- Consumes: existing interfaces from types
- Produces: corrected TrafficEngine class

- [ ] **Step 1: Fix `spawnVehicleFromDirection` to use `_direction` param**

Replace the current body with logic that picks a start edge matching the direction:

```typescript
spawnVehicleFromDirection(direction: Direction, type?: VehicleType): void {
  const edgeNodes = Array.from(this.graph.nodes.entries()).filter(([id, _node]) => {
    const adj = this.graph.adjacency.get(id) || [];
    return adj.some(e => {
      const bearing = e.bearing;
      if (direction === 'N') return bearing > 315 || bearing <= 45;
      if (direction === 'S') return bearing > 135 && bearing <= 225;
      if (direction === 'E') return bearing > 45 && bearing <= 135;
      if (direction === 'W') return bearing > 225 && bearing <= 315;
      return false;
    });
  });
  if (edgeNodes.length === 0) return;
  const startId = edgeNodes[Math.floor(Math.random() * edgeNodes.length)][0];
  const vType = type || (['sedan', 'sedan', 'suv', 'hatchback', 'bike', 'auto'] as VehicleType[])[Math.floor(Math.random() * 6)];
  const v = spawnVehicleAt(this.graph, startId, vType);
  if (v) this.vehicles.set(v.id, v);
}
```

- [ ] **Step 2: Fix manual override to only disable target signal**

Change `manualOverrideSignal` to only set `adaptiveTiming = false` on the matched signal, not all signals:

```typescript
manualOverrideSignal(signalId: string, direction: Direction, color: SignalColor): void {
  const signal = this.signals.get(signalId);
  if (!signal) return;
  this.manualOverrideActive = true;
  this.manualOverrideTimer = 0;
  signal.adaptiveTiming = false;

  for (const phase of signal.phases) {
    if (phase.direction === direction) {
      phase.color = color;
      phase.duration = color === 'GREEN' ? 30 : 5;
    } else {
      phase.color = color === 'GREEN' ? 'RED' : 'GREEN';
      phase.duration = color === 'GREEN' ? 5 : 25;
    }
  }
}
```

- [ ] **Step 3: Build and lint check**

Run: `npm run build` and `npm run lint`

---

### Task 3: Remove unused NYC constants

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: Remove `GRID_CENTER` and `GRID_BOUNDS`**

Delete lines 156-162 (`export const GRID_CENTER` and `export const GRID_BOUNDS`).

- [ ] **Step 2: Build check**

Run: `npm run build`

---

### Task 4: Toast notification system

**Files:**
- Create: `src/components/Toast.tsx`

**Interfaces:**
- Produces: `Toast` component + `useToast` hook pattern

- [ ] **Step 1: Create `src/components/Toast.tsx`**

```typescript
import { useState, useEffect, useCallback } from 'react';

export interface ToastMessage {
  id: string;
  text: string;
  type: 'info' | 'success' | 'warning' | 'error';
  duration?: number;
}

let toastId = 0;

// Global toast state — simple module-level array so App.tsx can push without prop drilling
let listeners: Array<(msgs: ToastMessage[]) => void> = [];
let messages: ToastMessage[] = [];

function notify() {
  for (const fn of listeners) fn([...messages]);
}

export function pushToast(text: string, type: ToastMessage['type'] = 'info', duration = 4000) {
  const id = `toast-${++toastId}`;
  messages = [...messages, { id, text, type, duration }];
  notify();
  if (duration > 0) {
    setTimeout(() => {
      messages = messages.filter(m => m.id !== id);
      notify();
    }, duration);
  }
}

export default function ToastContainer() {
  const [items, setItems] = useState<ToastMessage[]>([]);

  useEffect(() => {
    listeners.push(setItems);
    return () => { listeners = listeners.filter(fn => fn !== setItems); };
  }, []);

  const dismiss = useCallback((id: string) => {
    messages = messages.filter(m => m.id !== id);
    notify();
  }, []);

  const bgColor: Record<string, string> = {
    info: '#4488FF', success: '#4CAF50', warning: '#FF9800', error: '#f44336',
  };

  return (
    <div style={{
      position: 'fixed', bottom: 80, left: 12, zIndex: 9999,
      display: 'flex', flexDirection: 'column', gap: 6, pointerEvents: 'none',
    }}>
      {items.map(msg => (
        <div
          key={msg.id}
          onClick={() => dismiss(msg.id)}
          style={{
            background: bgColor[msg.type], color: '#fff', padding: '8px 14px',
            borderRadius: 6, fontSize: 12, fontFamily: 'monospace',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)', cursor: 'pointer',
            pointerEvents: 'auto', maxWidth: 320,
            animation: 'toastIn 0.25s ease-out',
          }}
        >
          {msg.text}
        </div>
      ))}
      <style>{`@keyframes toastIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </div>
  );
}
```

- [ ] **Step 2: Build check**

Run: `npm run build`

---

### Task 5: Layout fix — no panel overlap

**Files:**
- Modify: `src/components/MapView.tsx`, `src/components/NavigationPanel.tsx`, `src/components/ControlPanel.tsx`

- [ ] **Step 1: Move NavigationPanel to left side**

In `NavigationPanel.tsx`, change `panel` style: `right: 12` → `left: 12`

- [ ] **Step 2: Keep ControlPanel on right, add `right: 12` constraint**

In `ControlPanel.tsx`, ensure `panel` style already has `right: 12` (it does).

- [ ] **Step 3: Move stats bar in MapView to below the override banner**

In `MapView.tsx`, change the stats bar style from `top: 12, left: 12` to `top: 60, left: 12`.

- [ ] **Step 4: Adjust NavPanel expand button to left side**

In `NavigationPanel.tsx`, change `expandBtn` style: `right: 12` → `left: 12`.

- [ ] **Step 5: Build check**

Run: `npm run build`

---

### Task 6: App.tsx overhaul — pause RAF, speed control, keyboard shortcuts, loading progress, re-render opt

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add speed multiplier state and properly pause RAF**

```typescript
const [speed, setSpeed] = useState(1);
const [tick, setTick] = useState(0);
```

Replace the animation loop to cancel RAF when paused:

```typescript
const loop = (time: number) => {
  if (!paused) {
    const rawDelta = lastTimeRef.current ? (time - lastTimeRef.current) / 1000 * speed : 0;
    lastTimeRef.current = time;
    const dt = Math.min(rawDelta, 0.05);
    if (engine.running) {
      engine.update(dt);
      // ... override state checks ...
    }
    setTick(t => t + 1);
    frameRef.current = requestAnimationFrame(loop);
  } else {
    frameRef.current = requestAnimationFrame(loop);
  }
};
```

Change the pause button effect: when paused, do NOT call engine.update and use `cancelAnimationFrame`:

```typescript
useEffect(() => {
  if (paused) {
    cancelAnimationFrame(frameRef.current);
  } else if (engineRef.current?.running) {
    lastTimeRef.current = 0;
    frameRef.current = requestAnimationFrame(loop);
  }
  return () => {};
}, [paused]);
```

Actually, let me rewrite the loop logic more cleanly. Replace the existing useEffect entirely:

```typescript
useEffect(() => {
  const engine = new TrafficEngine();
  engineRef.current = engine;

  setLoadStatus('Fetching Bangalore road data from OpenStreetMap...');
  engine.init().then(() => {
    setLoading(false);
    setLoadStatus('');
    engine.start();
    if (!paused) {
      lastTimeRef.current = 0;
      frameRef.current = requestAnimationFrame(loop);
    }
  }).catch((err) => {
    console.error('Engine init failed:', err);
    setLoadStatus('');
    engine.start();
    setLoading(false);
  });

  function loop(time: number) {
    const e = engineRef.current;
    if (!e || !e.running) return;
    const rawDelta = lastTimeRef.current ? (time - lastTimeRef.current) / 1000 * speedRef.current : 0;
    lastTimeRef.current = time;
    const dt = Math.min(rawDelta, 0.05);
    e.update(dt);
    if (e.isManualOverrideActive()) {
      setOverrideActive(true);
      setOverrideTimeRemaining(e.getManualOverrideTimeRemaining());
    } else if (overrideActiveRef.current) {
      setOverrideActive(false);
    }
    setTick(t => t + 1);
    frameRef.current = requestAnimationFrame(loop);
  }

  return () => {
    cancelAnimationFrame(frameRef.current);
    engineRef.current?.stop();
  };
}, []);
```

Hmm, this gets complicated with refs vs state for the speed value. Let me use refs for values that the RAF loop needs to read without re-creating the loop:

Add refs alongside state:
```typescript
const speedRef = useRef(1);
const pausedRef = useRef(false);
const overrideActiveRef = useRef(false);
```

Update refs when state changes:
```typescript
useEffect(() => { speedRef.current = speed; }, [speed]);
useEffect(() => { pausedRef.current = paused; }, [paused]);
useEffect(() => { overrideActiveRef.current = overrideActive; }, [overrideActive]);
```

Modify the loop to use refs:
```typescript
function loop(time: number) {
  const e = engineRef.current;
  if (!e || !e.running) return;
  const rawDelta = lastTimeRef.current ? (time - lastTimeRef.current) / 1000 * speedRef.current : 0;
  lastTimeRef.current = time;
  const dt = Math.min(rawDelta, 0.05);
  e.update(dt);
  if (e.isManualOverrideActive()) {
    setOverrideActive(true);
    setOverrideTimeRemaining(e.getManualOverrideTimeRemaining());
  } else if (overrideActiveRef.current) {
    setOverrideActive(false);
  }
  setTick(t => t + 1);
  frameRef.current = requestAnimationFrame(loop);
}
```

And the pause/add effect — only start/stop the loop, don't rebuild it:

```typescript
useEffect(() => {
  if (paused) {
    cancelAnimationFrame(frameRef.current);
  } else {
    lastTimeRef.current = 0;
    frameRef.current = requestAnimationFrame(loop);
  }
  return () => {};
}, [paused]);
```

- [ ] **Step 2: Add keyboard shortcuts**

```typescript
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        setPaused(p => !p);
        break;
      case 's':
      case 'S':
        engineRef.current?.spawnVehicleFromDirection(
          (['N', 'S', 'E', 'W'] as Direction[])[Math.floor(Math.random() * 4)]
        );
        break;
      case 'o':
      case 'O':
        engineRef.current?.deactivateManualOverride();
        setOverrideActive(false);
        break;
      case '1': setSpeed(0.5); break;
      case '2': setSpeed(1); break;
      case '3': setSpeed(2); break;
      case '4': setSpeed(4); break;
      case 'h':
      case 'H':
        setShowHeatmap(p => !p);
        break;
      case 'Escape':
        break;
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, []);
```

- [ ] **Step 3: Add step-by-step loading**

Replace the loading screen with one that shows substeps:

```typescript
const [loadStatus, setLoadStatus] = useState('Initializing...');

// In the init effect chain:
setLoadStatus('Fetching road network from OpenStreetMap...');
// After engine.init().then(...):
setLoadStatus('Initializing traffic signals...');
// After engine.start():
setLoadStatus('Spawning initial vehicles...');
setTimeout(() => setLoading(false), 400);
```

- [ ] **Step 4: Build and lint check**

Run: `npm run build` and `npm run lint`

---

### Task 7: MapView enhancements — route display, tooltips, heatmap toggle

**Files:**
- Modify: `src/components/MapView.tsx`

- [ ] **Step 1: Add route polyline**

Add state for the route path and a new layer group for routes:

```typescript
const [routePath, setRoutePath] = useState<[number, number][] | null>(null);
const routeLayerRef = useRef<L.LayerGroup | null>(null);
```

Initialize route layer in the main effect:
```typescript
routeLayerRef.current = L.layerGroup().addTo(map);
```

Pass `routePath` as a prop from App (or have NavigationPanel call back). Since it's complex to thread through, add a simple approach: store route in MapView state via a new prop.

Actually, the simpler approach: add a `routePolyline` prop to MapView. Let me add this to the props interface:

```typescript
routePolyline?: [number, number][];
```

Add an effect to draw it:
```typescript
useEffect(() => {
  const layer = routeLayerRef.current;
  if (!layer) return;
  layer.clearLayers();
  if (routePolyline && routePolyline.length > 1) {
    L.polyline(routePolyline, {
      color: '#4488FF', weight: 4, opacity: 0.8, dashArray: '10, 6',
    }).addTo(layer);
  }
}, [routePolyline]);
```

- [ ] **Step 2: Add vehicle tooltips**

Modify the vehicle update effect to attach tooltips:

```typescript
if (m) {
  m.setLatLng([v.lat, v.lng]);
  m.setTooltipContent(`${v.type.toUpperCase()} · ${Math.round(v.speed)} km/h · ETA ${Math.round(v.routeETA)}s`);
} else {
  m = L.circleMarker([v.lat, v.lng], {
    radius: size, color: v.color, fillColor: v.color, fillOpacity: 0.95, weight: 2,
  })
    .bindTooltip(`${v.type.toUpperCase()} · ${Math.round(v.speed)} km/h · ETA ${Math.round(v.routeETA)}s`, {
      direction: 'top', offset: [0, -4], className: 'vehicle-tooltip',
    })
    .addTo(layer);
  markers.set(v.id, m);
}
```

Add tooltip CSS to `index.css`:
```css
.vehicle-tooltip { background: rgba(10,10,20,0.92) !important; border: 1px solid #444 !important; color: #fff !important; font-family: monospace !important; font-size: 11px !important; padding: 4px 8px !important; border-radius: 4px !important; }
.vehicle-tooltip::before { border-top-color: #444 !important; }
```

- [ ] **Step 3: Add heatmap toggle prop and effect**

Add prop: `showHeatmap: boolean`

Modify the heatmap effect to check the flag:
```typescript
useEffect(() => {
  const layer = heatmapLayerRef.current;
  if (!layer) return;
  layer.clearLayers();
  if (!showHeatmap) return;
  for (const zone of congestionZones) { ... }
}, [congestionZones, showHeatmap]);
```

- [ ] **Step 4: Wire up `routePolyline` prop from NavigationPanel results**

Add `onRouteCalculated` callback prop that converts route path to latlngs:

In MapView, add a callback for when NavigationPanel calculates a route:
```typescript
const handleRouteCalculated = useCallback((route: RouteInfo | null) => {
  if (route) {
    const latlngs: [number, number][] = route.path.map(id => {
      const node = graph.nodes.get(id);
      return node ? [node.lat, node.lng] : null;
    }).filter(Boolean) as [number, number][];
    setRoutePolyline(latlngs);
  } else {
    setRoutePolyline(null);
  }
}, [graph.nodes]);
```

Pass to NavigationPanel: `onRouteCalculated={handleRouteCalculated}`

- [ ] **Step 5: Add heatmap toggle button to the control bar**

Add a button near the pause button:

```typescript
<button onClick={() => setShowHeatmap(p => !p)} style={{
  padding: '8px 16px', background: showHeatmap ? 'rgba(68,136,255,0.3)' : 'rgba(0,0,0,0.8)',
  color: '#fff', border: `1px solid ${showHeatmap ? '#4488FF' : '#555'}`, borderRadius: 6,
  cursor: 'pointer', fontFamily: 'monospace', fontSize: 13,
}}>
  Heatmap {showHeatmap ? 'ON' : 'OFF'}
</button>
```

- [ ] **Step 6: Build and lint check**

Run: `npm run build` and `npm run lint`

---

### Task 8: ControlPanel enhancements — speed slider, vehicle list, toggles

**Files:**
- Modify: `src/components/ControlPanel.tsx`

- [ ] **Step 1: Add speed control slider to ControlPanel**

Add props: `speed: number`, `onSpeedChange: (s: number) => void`

Add speed control section:
```typescript
<div style={styles.section}>
  <div style={styles.sectionTitle}>Sim Speed</div>
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <input
      type="range" min="0.5" max="4" step="0.5"
      value={speed}
      onChange={(e) => onSpeedChange(parseFloat(e.target.value))}
      style={{ flex: 1, accentColor: '#FF6D00' }}
    />
    <span style={{ color: '#fff', fontWeight: 'bold', fontSize: 13, minWidth: 32, textAlign: 'right' }}>
      {speed}×
    </span>
  </div>
</div>
```

- [ ] **Step 2: Add heatmap toggle to ControlPanel**

Add prop: `showHeatmap: boolean`, `onToggleHeatmap: () => void`

Add a toggle row:
```typescript
<div style={styles.section}>
  <div style={styles.sectionTitle}>Layers</div>
  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
    <input type="checkbox" checked={showHeatmap} onChange={onToggleHeatmap} />
    <span>Traffic Heatmap</span>
  </label>
</div>
```

- [ ] **Step 3: Add vehicle list panel**

Add state to track if vehicle list is expanded. Add props for vehicle data:
```typescript
vehicles: Array<{ id: string; type: string; speed: number; routeETA: number; lat: number; lng: number; color: string }>;
onVehicleSelect?: (vehicleId: string) => void;
```

Add a collapsible section:
```typescript
const [showVehicles, setShowVehicles] = useState(false);
// ...
<div style={styles.section}>
  <div style={styles.sectionTitle} onClick={() => setShowVehicles(!showVehicles)}>
    Vehicles ({vehicles.length}) {showVehicles ? '\u25B2' : '\u25BC'}
  </div>
  {showVehicles && (
    <div style={{ maxHeight: 200, overflow: 'auto' }}>
      {vehicles.map(v => (
        <div key={v.id} onClick={() => onVehicleSelect?.(v.id)} style={{
          display: 'flex', justifyContent: 'space-between', padding: '4px 6px',
          cursor: 'pointer', borderRadius: 4, fontSize: 11, fontFamily: 'monospace',
          borderLeft: `3px solid ${v.color}`, marginBottom: 2,
        }}>
          <span style={{ color: '#fff' }}>{v.id}</span>
          <span style={{ color: '#888' }}>{v.type}</span>
          <span style={{ color: '#4CAF50' }}>{Math.round(v.speed)} km/h</span>
        </div>
      ))}
    </div>
  )}
</div>
```

In MapView, add a `flyTo` handler for vehicle selection:
```typescript
const handleVehicleSelect = useCallback((vehicleId: string) => {
  const v = vehicles.get(vehicleId);
  if (v && mapRef.current) {
    mapRef.current.flyTo([v.lat, v.lng], 18);
  }
}, [vehicles]);
```

- [ ] **Step 4: Wire up new props through MapView → ControlPanel**

MapView needs to pass `speed`, `onSpeedChange`, `showHeatmap`, `onToggleHeatmap`, `vehicles`, `onVehicleSelect` to ControlPanel.

Update MapViewProps and pass through.

- [ ] **Step 5: Build and lint check**

Run: `npm run build` and `npm run lint`

---

### Task 9: Final integration — verify everything works together

- [ ] **Step 1: Add all new imports and props**

Ensure `MapView.tsx` passes all new props to `ControlPanel` and `NavigationPanel`.
Ensure `App.tsx` passes `showHeatmap`, `speed`, `onSpeedChange`, `vehicles`, `onVehicleSelect`, `routePolyline` to `MapView`.

- [ ] **Step 2: Full build and lint**

Run: `npm run build` — must pass with zero errors.
Run: `npm run lint` — must pass with zero warnings.

- [ ] **Step 3: Manual smoke test**

1. `npm run dev` starts without errors
2. Loading screen shows progress steps
3. Panels don't overlap (NavPanel left, ControlPanel right, stats bar top-center-left)
4. Space pauses/resumes simulation
5. Speed slider changes sim velocity
6. Hover over a vehicle shows tooltip
7. Heatmap toggle shows/hides congestion zones
8. Vehicle list shows vehicles, clicking centers map
9. Route calculation draws polyline
10. Toast appears on signal override
