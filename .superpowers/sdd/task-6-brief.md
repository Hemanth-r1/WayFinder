### Task 6: Client Sync Layer

**Files:**
- Create: `src/engine/serverSync.ts`
- Modify: `src/data/roadNetwork.ts` — add server fetch path

**Step 1: Create `src/engine/serverSync.ts`**

```typescript
import type { RoadGraph, TrafficSignal, Vehicle, CongestionZone, TrafficStats } from '../types';
import type { RouteInfo } from '../types';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:8080';

function graphFromJSON(data: {
  nodes: any[]; edges: any[]; adjacency: [string, string[]][];
  signals: any[];
}): { graph: RoadGraph; signals: Map<string, TrafficSignal> } {
  const nodes = new Map(data.nodes.map((n: any) => [n.id, n]));
  const edges = new Map(data.edges.map((e: any) => [e.id, e]));
  const adjacency = new Map<string, string[]>(data.adjacency);
  const signals = new Map(data.signals.map((s: any) => [s.nodeId, s]));
  return { graph: { nodes, edges, adjacency }, signals };
}

export async function fetchGraphFromServer(): Promise<{
  graph: RoadGraph; signals: Map<string, TrafficSignal>; source: string; version: number;
}> {
  const res = await fetch(`${SERVER_URL}/api/graph`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  const data = await res.json();
  const { graph, signals } = graphFromJSON(data);
  return { graph, signals, source: data.source, version: data.version };
}

export async function fetchCongestion(
  vehicles: Map<string, Vehicle>, nodes: Map<string, any>
): Promise<{ zones: CongestionZone[]; stats: TrafficStats }> {
  const vehicleArray = Array.from(vehicles.values()).map(v => ({
    id: v.id, lat: v.lat, lng: v.lng, speed: v.speed, bearing: v.bearing,
    type: v.type, color: v.color, isNavigated: v.isNavigated,
  }));
  const nodeArray = Array.from(nodes.values()).map(n => ({
    id: n.id, lat: n.lat, lng: n.lng,
  }));
  const res = await fetch(`${SERVER_URL}/api/congestion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vehicles: vehicleArray, nodes: nodeArray }),
  });
  if (!res.ok) return { zones: [], stats: {} as TrafficStats };
  return res.json();
}

export async function fetchSLA(vehicles: Map<string, Vehicle>): Promise<{
  slaSpeed: number; slaCompliant: boolean; emergencySlaSpeed: number;
}> {
  const vehicleArray = Array.from(vehicles.values()).map(v => ({
    id: v.id, lat: v.lat, lng: v.lng, speed: v.speed, type: v.type,
  }));
  const res = await fetch(`${SERVER_URL}/api/sla`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vehicles: vehicleArray }),
  });
  if (!res.ok) return { slaSpeed: 0, slaCompliant: false, emergencySlaSpeed: 0 };
  return res.json();
}

export async function fetchRoute(
  graph: RoadGraph, signals: Map<string, TrafficSignal>,
  sourceId: string, destId: string
): Promise<RouteInfo | null> {
  const graphArray = {
    nodes: Array.from(graph.nodes.values()).map(n => ({ id: n.id, lat: n.lat, lng: n.lng })),
    edges: Array.from(graph.edges.values()).map(e => ({
      id: e.id, from: e.from, to: e.to, name: e.name,
      roadType: e.roadType, speedLimit: e.speedLimit, length: e.length, bearing: e.bearing,
      geometry: e.geometry,
    })),
    adjacency: Array.from(graph.adjacency.entries()),
  };
  const signalArray = Array.from(signals.values()).map(s => ({
    id: s.id, nodeId: s.nodeId,
    phases: s.phases, currentPhaseIndex: s.currentPhaseIndex,
    timer: s.timer, cycleLength: s.cycleLength, offset: s.offset,
    greenWaveDirection: s.greenWaveDirection,
    congestionLevel: s.congestionLevel, adaptiveTiming: s.adaptiveTiming,
  }));
  const res = await fetch(`${SERVER_URL}/api/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      graph: graphArray, signals: signalArray,
      sourceId, destId,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.route;
}
```

**Step 2: Update `src/data/roadNetwork.ts`**

Start by reading the file (especially `loadBangaloreNetwork`). Add near the top after the imports:

```typescript
const SERVER_URL = import.meta.env.VITE_SERVER_URL;
```

Then inside `loadBangaloreNetwork`, BEFORE the Overpass fetch (the try block that does `POST https://overpass-api.de/api/interpreter`), add:

```typescript
if (SERVER_URL) {
  try {
    const res = await fetch(`${SERVER_URL}/api/graph`);
    if (res.ok) {
      const data = await res.json();
      const { graphFromJSON } = await import('../engine/serverSync');
      const { graph: g, signals: sigs } = graphFromJSON(data);
      callback({
        phase: 'full', nodes: g.nodes, edges: g.edges,
        adjacency: g.adjacency, signals: sigs, source: data.source || 'server',
      });
      return;
    }
  } catch { /* fall through to client-side fetch */ }
}
```

**Step 3: Verify build**

```bash
npm run build
```
Expected: tsc + vite build succeed.

**Step 4: Commit**

```bash
git add src/engine/serverSync.ts src/data/roadNetwork.ts
git commit -m "feat(client): server sync layer — fetch graph, congestion, SLA, route from API"
```
