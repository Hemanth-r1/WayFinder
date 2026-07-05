### Task 4: Server Heavy Computation Endpoints

**Files:**
- Create: `server/src/congestionService.ts`
- Create: `server/src/slaService.ts`
- Create: `server/src/corridorService.ts`
- Create: `server/src/pathfindingService.ts`
- Modify: `server/src/index.ts` — add POST routes

**Interfaces:**
- `POST /api/congestion` body: `{ vehicles, nodes }` → `{ zones: CongestionZone[], stats: TrafficStats }`
- `POST /api/sla` body: `{ vehicles }` → `{ slaSpeed, slaCompliant, emergencySlaSpeed }`
- `POST /api/corridors` body: `{ vehicles, graph, signals }` → `{ corridors: number }`
- `POST /api/route` body: `{ graph, signals, sourceId, destId }` → `{ route: RouteInfo | null }`

**Step 1: Create `server/src/congestionService.ts`**

```typescript
import type { Vehicle, CongestionZone, TrafficStats, RoadNode } from './types.js';

export function computeCongestionZones(
  vehicles: Vehicle[], _nodes: RoadNode[]
): CongestionZone[] {
  const zones: CongestionZone[] = [];
  const threshold = 0.005;
  const clustered = new Set<string>();
  for (const v of vehicles) {
    if (clustered.has(v.id)) continue;
    const nearby = vehicles.filter(o =>
      !clustered.has(o.id) &&
      Math.abs(o.lat - v.lat) < threshold &&
      Math.abs(o.lng - v.lng) < threshold
    );
    if (nearby.length < 2) continue;
    const lat = nearby.reduce((s, o) => s + o.lat, 0) / nearby.length;
    const lng = nearby.reduce((s, o) => s + o.lng, 0) / nearby.length;
    const level = Math.min(1, nearby.length / 20);
    zones.push({ centerLat: lat, centerLng: lng, level, vehicles: nearby.length });
    for (const o of nearby) clustered.add(o.id);
  }
  return zones;
}

export function computeStats(
  vehicles: Vehicle[], congestionZones: CongestionZone[]
): TrafficStats {
  const total = vehicles.length;
  const avgSpeed = total > 0
    ? vehicles.reduce((s, v) => s + v.speed, 0) / total : 0;
  return {
    totalVehicles: total, avgSpeed, avgDelay: 0,
    congestionHotspots: congestionZones.filter(z => z.level > 0.5).length,
    greenWaveActive: false, signalCoordinationScore: 0,
    throughput: 0, maxCongestion: Math.max(0, ...congestionZones.map(z => z.level)),
    slaSpeed: avgSpeed, slaCompliant: avgSpeed > 30,
    emergencySlaSpeed: 0, activeCorridors: 0,
  };
}
```

**Step 2: Create `server/src/slaService.ts`**

```typescript
import type { Vehicle } from './types.js';

export function computeSLA(vehicles: Vehicle[]): {
  slaSpeed: number; slaCompliant: boolean; emergencySlaSpeed: number;
}> {
  const speeds = vehicles.map(v => v.speed);
  const avg = speeds.length > 0
    ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
  const emergency = vehicles.filter(v => v.type === 'emergency').map(v => v.speed);
  const emergencyAvg = emergency.length > 0
    ? emergency.reduce((a, b) => a + b, 0) / emergency.length : 0;
  return { slaSpeed: avg, slaCompliant: avg >= 25, emergencySlaSpeed: emergencyAvg };
}
```

**Step 3: Create `server/src/corridorService.ts`**

```typescript
import type { Vehicle } from './types.js';

export function detectActiveCorridors(vehicles: Vehicle[]): number {
  const directions = vehicles.filter(v => v.speed > 10).length;
  return directions > 20 ? Math.floor(directions / 10) : 0;
}
```

**Step 4: Create `server/src/pathfindingService.ts`**

```typescript
import type { RoadGraph, TrafficSignal, RouteInfo } from './types.js';

export function findRoute(
  graph: RoadGraph, sourceId: string, destId: string, _signals: TrafficSignal[]
): RouteInfo | null {
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
  const adj = new Map<string, string[]>(graph.adjacency);
  const edgeMap = new Map(graph.edges.map(e => [e.id, e]));

  const open = [{ id: sourceId, cost: 0, heuristic: 0 }];
  const closed = new Set<string>();
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>();
  gScore.set(sourceId, 0);

  while (open.length > 0) {
    open.sort((a, b) => (a.cost + a.heuristic) - (b.cost + b.heuristic));
    const current = open.shift()!;
    if (current.id === destId) {
      const path: string[] = [];
      let c: string | undefined = destId;
      while (c) { path.unshift(c); c = cameFrom.get(c); }
      const roadNames = [...new Set(path.flatMap(id =>
        (adj.get(id) || []).map(eid => edgeMap.get(eid)?.name).filter(Boolean) as string[]
      ))];
      return {
        path,
        distance: path.length * 500,
        estimatedTime: path.length * 30,
        signalCount: path.filter(id => _signals.some(s => s.nodeId === id)).length,
        roadNames,
      };
    }
    closed.add(current.id);
    const neighbors = adj.get(current.id) || [];
    for (const edgeId of neighbors) {
      const edge = edgeMap.get(edgeId);
      if (!edge) continue;
      const nextId = edge.from === current.id ? edge.to : edge.from;
      if (closed.has(nextId)) continue;
      const tentative = gScore.get(current.id)! + edge.length;
      if (tentative < (gScore.get(nextId) ?? Infinity)) {
        gScore.set(nextId, tentative);
        cameFrom.set(nextId, current.id);
        const node = nodeMap.get(nextId);
        const h = node ? Math.abs(node.lat - nodeMap.get(destId)!.lat) * 111000 +
          Math.abs(node.lng - nodeMap.get(destId)!.lng) * 111000 * Math.cos(node.lat * Math.PI / 180) : 0;
        open.push({ id: nextId, cost: tentative, heuristic: h });
      }
    }
  }
  return null;
}
```

**Step 5: Wire routes in `server/src/index.ts`**

Add these imports:

```typescript
import { computeCongestionZones, computeStats } from './congestionService.js';
import { computeSLA } from './slaService.js';
import { detectActiveCorridors } from './corridorService.js';
import { findRoute } from './pathfindingService.js';
```

Add these routes after `GET /api/graph`:

```typescript
app.post('/api/congestion', (req, res) => {
  const { vehicles, nodes } = req.body;
  const zones = computeCongestionZones(vehicles, nodes || []);
  const stats = computeStats(vehicles, zones);
  res.json({ zones, stats });
});

app.post('/api/sla', (req, res) => {
  const { vehicles } = req.body;
  res.json(computeSLA(vehicles || []));
});

app.post('/api/corridors', (req, res) => {
  const { vehicles } = req.body;
  res.json({ activeCorridors: detectActiveCorridors(vehicles || []) });
});

app.post('/api/route', (req, res) => {
  const { graph, signals, sourceId, destId } = req.body;
  const route = findRoute(graph, sourceId, destId, signals || []);
  res.json({ route });
});
```

**Step 6: Verify compilation**

```bash
cd server && npx tsc --noEmit
```
Expected: No errors.

**Step 7: Commit**

```bash
git add server/src/congestionService.ts server/src/slaService.ts server/src/corridorService.ts server/src/pathfindingService.ts server/src/index.ts
git commit -m "feat(server): congestion, SLA, corridor, and route endpoints"
```
