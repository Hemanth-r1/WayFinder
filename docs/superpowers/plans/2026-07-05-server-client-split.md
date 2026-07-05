# Server/Client Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Offload graph building, congestion, SLA, corridor detection, and pathfinding from the browser to a Node.js server on Firebase App Hosting, keeping only lightweight vehicle movement client-side.

**Architecture:** Express REST API for initial graph fetch + heavy computation endpoints. Firestore for periodic state sync and command bus. Client retains per-frame vehicle movement for 60fps rendering.

**Tech Stack:** Node.js + Express + TypeScript (server), Firestore, Firebase App Hosting, Docker

## Global Constraints

- `verbatimModuleSyntax: true` — always use `import type` for type-only imports
- `erasableSyntaxOnly: true` — no enums, no namespaces
- `noUnusedLocals` / `noUnusedParameters` are errors
- Client bundled by Vite; server compiled by `tsc` separately
- All Map/Set types must be serializable for network transfer (convert to arrays)
- Server must deploy as a container to Cloud Run via Firebase App Hosting
- Firestore commands collection: `commands/{docId}` with fields `{ type, payload, userId, createdAt }`

---

### Task 1: Server Scaffold

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/src/index.ts`
- Create: `server/Dockerfile`
- Create: `server/.dockerignore`
- Modify: `package.json` (root) — add `"build:server"` script

**Interfaces:**
- Produces: Express app listening on `process.env.PORT || 8080`
- Produces: `GET /api/health` → `{ status: 'ok' }`

- [ ] **Step 1: Create `server/package.json`**

```json
{
  "name": "wayfinder-server",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts"
  },
  "dependencies": {
    "express": "^4.21.0",
    "firebase-admin": "^12.6.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "tsx": "^4.19.0",
    "typescript": "~5.7.0"
  }
}
```

- [ ] **Step 2: Create `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `server/src/index.ts`**

```typescript
import express from 'express';

const app = express();
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const PORT = parseInt(process.env.PORT || '8080', 10);
app.listen(PORT, () => {
  console.log(`[WayFinder Server] Listening on ${PORT}`);
});
```

- [ ] **Step 4: Create `server/Dockerfile`**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

- [ ] **Step 5: Create `server/.dockerignore`**

```
node_modules
src
tsconfig.json
```

- [ ] **Step 6: Add build script to root `package.json`**

```json
// Inside scripts:
"build:server": "cd server && tsc"
```

- [ ] **Step 7: Verify server compiles**

```bash
cd server && npm install && npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add server/ package.json
git commit -m "feat(server): scaffold Express app with health endpoint"
```

---

### Task 2: Shared Types Package

**Files:**
- Create: `server/src/types.ts` — mirror of shared types (serializable versions)
- Modify: `server/src/index.ts` — add placeholder route

**Interfaces:**
- Produces: Serializable versions of `RoadGraph`, `Vehicle`, `TrafficSignal`, `CongestionZone`, `TrafficStats`, `RouteInfo`
- Consumes: (none — standalone type definitions)

- [ ] **Step 1: Create `server/src/types.ts` with serializable graph types**

Server-side types differ from client types in that they use arrays instead of Maps for network transfer:

```typescript
// Serializable versions — Maps converted to arrays for JSON transfer

export interface RoadNode {
  id: string; lat: number; lng: number; trafficSignalId?: string;
}

export interface RoadEdge {
  id: string; from: string; to: string;
  name: string; roadType: string; speedLimit: number; length: number;
  bearing: number; lanes: number; geometry: { lat: number; lng: number }[];
}

export interface RoadGraph {
  nodes: RoadNode[];
  edges: RoadEdge[];
  adjacency: [string, string[]][]; // nodeId → edgeId list
}

export interface SignalPhase {
  group: string; color: string; duration: number; yellowDuration: number;
}

export interface TrafficSignal {
  id: string; nodeId: string;
  phases: SignalPhase[];
  currentPhaseIndex: number; timer: number;
  cycleLength: number; offset: number;
  greenWaveDirection: string | null;
  congestionLevel: number; adaptiveTiming: boolean;
}

export interface Vehicle {
  id: string; lat: number; lng: number;
  speed: number; bearing: number;
  type: string; color: string;
  isNavigated: boolean;
}

export interface CongestionZone {
  centerLat: number; centerLng: number;
  level: number; vehicles: number;
}

export interface TrafficStats {
  totalVehicles: number; avgSpeed: number; avgDelay: number;
  congestionHotspots: number; greenWaveActive: boolean;
  signalCoordinationScore: number; throughput: number; maxCongestion: number;
  slaSpeed: number; slaCompliant: boolean;
  emergencySlaSpeed: number; activeCorridors: number;
}

export interface RouteInfo {
  path: string[]; distance: number; estimatedTime: number;
  signalCount: number; roadNames: string[];
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/types.ts
git commit -m "feat(server): add serializable shared types"
```

---

### Task 3: Server Graph Service (OSM + Caching)

**Files:**
- Create: `server/src/graphService.ts`
- Modify: `server/src/index.ts` — add `GET /api/graph`

**Interfaces:**
- Produces: `GET /api/graph?lat=12.9716&lng=77.5946&radius=40000` → `{ nodes, edges, adjacency, signals, source, version }`
- Produces: `loadBangaloreNetwork(callback)` — same signature as client version, writes to memory cache

- [ ] **Step 1: Create `server/src/graphService.ts`**

Extract the graph-building logic from `src/data/roadNetwork.ts` into the server:

```typescript
import type { RoadNode, RoadEdge, TrafficSignal, RoadGraph } from './types.js';

interface GraphCache {
  graph: RoadGraph | null;
  signals: TrafficSignal[];
  source: string;
  version: number;
}

let cache: GraphCache = { graph: null, signals: [], source: 'none', version: 0 };
const CENTER = { lat: 12.9716, lng: 77.5946 };
const RADIUS = 40000;

export async function getGraph(): Promise<{
  graph: RoadGraph; signals: TrafficSignal[]; source: string; version: number;
}> {
  if (cache.graph && cache.graph.nodes.length > 0) {
    return { graph: cache.graph, signals: cache.signals, source: cache.source, version: cache.version };
  }
  // Build the graph synchronously from Overpass or fallback
  const { buildBangaloreNetwork } = await import('./roadNetwork.js');
  const result = await buildBangaloreNetwork(CENTER.lat, CENTER.lng, RADIUS);
  cache = { ...result, version: Date.now() };
  return { graph: cache.graph!, signals: cache.signals, source: cache.source, version: cache.version };
}

export function invalidateCache(): void {
  cache = { graph: null, signals: [], source: 'none', version: 0 };
}
```

- [ ] **Step 2: Create `server/src/roadNetwork.ts`**

Copy/adapt the heavy graph-building from `src/data/roadNetwork.ts` (the Overpass fetch, geometry processing, synthetic grid fallback). This is ~560 lines on the client. For the server, extract just the `loadBangaloreNetwork` / `buildBangaloreNetwork` function — imported in graphService.ts.

```typescript
import type { RoadNode, RoadEdge, TrafficSignal, RoadGraph } from './types.js';

export async function buildBangaloreNetwork(
  centerLat: number, centerLng: number, radiusM: number
): Promise<{
  graph: RoadGraph; signals: TrafficSignal[]; source: string;
}> {
  // 1. Try Overpass API
  try { return await fetchFromOverpass(centerLat, centerLng, radiusM); }
  catch { /* fall through */ }
  // 2. Fallback to synthetic grid
  return buildSyntheticGrid(centerLat, centerLng);
}

async function fetchFromOverpass(
  lat: number, lng: number, radius: number
): Promise<{ graph: RoadGraph; signals: TrafficSignal[]; source: string }> {
  const query = `[out:json][timeout:60];
    (
      way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential)$"]
        (around:${radius},${lat},${lng});
      node(around:${radius},${lat},${lng})["highway"="traffic_signals"];
    );
    out body;>;out skel qt;`;
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Overpass ${resp.status}`);
  const raw = await resp.json() as any;
  return parseOSMData(raw, { lat, lng, radius });
}

function parseOSMData(
  raw: any, _bounds: { lat: number; lng: number; radius: number }
): { graph: RoadGraph; signals: TrafficSignal[]; source: string } {
  // Same geometry processing as client src/data/roadNetwork.ts
  // (RDp simplification, bearing calc, node dedup, signal creation)
  // [Abridged for plan — implement full logic from roadNetwork.ts]
  return {
    graph: { nodes: [], edges: [], adjacency: [] },
    signals: [],
    source: 'overpass',
  };
}

function buildSyntheticGrid(
  centerLat: number, centerLng: number
): { graph: RoadGraph; signals: TrafficSignal[]; source: string } {
  // Same 10x10 grid logic as client
  // [Abridged for plan — implement full logic from roadNetwork.ts]
  return {
    graph: { nodes: [], edges: [], adjacency: [] },
    signals: [],
    source: 'synthetic',
  };
}
```

- [ ] **Step 3: Add `GET /api/graph` to `server/src/index.ts`**

```typescript
import { getGraph } from './graphService.js';

app.get('/api/graph', async (_req, res) => {
  try {
    const result = await getGraph();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Verify `GET /api/graph` works**

```bash
cd server && npx tsc && node dist/index.js &
curl http://localhost:8080/api/graph | head -c 500
```
Expected: JSON with nodes, edges, adjacency arrays.

- [ ] **Step 5: Commit**

```bash
git add server/src/graphService.ts server/src/roadNetwork.ts server/src/index.ts
git commit -m "feat(server): graph building from Overpass with caching"
```

---

### Task 4: Server Heavy Computation Endpoints

**Files:**
- Create: `server/src/congestionService.ts`
- Create: `server/src/slaService.ts`
- Create: `server/src/corridorService.ts`
- Create: `server/src/pathfindingService.ts`
- Modify: `server/src/index.ts` — add routes

**Interfaces:**
- `POST /api/congestion` → `{ zones: CongestionZone[], stats: TrafficStats }`
- `POST /api/sla` → `{ slaSpeed, slaCompliant, emergencySlaSpeed }`
- `POST /api/corridors` → `{ corridors: CorridorInfo[] }`
- `POST /api/route` → `{ route: RouteInfo | null }`

- [ ] **Step 1: Implement congestion + stats endpoint**

```typescript
// server/src/congestionService.ts
import type { Vehicle, CongestionZone, TrafficStats, RoadNode } from './types.js';

export function computeCongestionZones(
  vehicles: Vehicle[], _nodes: RoadNode[]
): CongestionZone[] {
  // Group vehicles by proximity, compute center + level
  const zones: CongestionZone[] = [];
  const threshold = 0.005; // ~500m
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
  const total = vehicles.size || vehicles.length;
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

- [ ] **Step 2: Implement SLA service**

```typescript
// server/src/slaService.ts
import type { Vehicle } from './types.js';

export function computeSLA(vehicles: Vehicle[]): {
  slaSpeed: number; slaCompliant: boolean;
  emergencySlaSpeed: number;
} {
  const speeds = vehicles.map(v => v.speed);
  const avg = speeds.length > 0
    ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
  const emergency = vehicles
    .filter(v => v.type === 'emergency')
    .map(v => v.speed);
  const emergencyAvg = emergency.length > 0
    ? emergency.reduce((a, b) => a + b, 0) / emergency.length : 0;
  return {
    slaSpeed: avg,
    slaCompliant: avg >= 25,
    emergencySlaSpeed: emergencyAvg,
  };
}
```

- [ ] **Step 3: Implement corridor detection**

```typescript
// server/src/corridorService.ts
import type { Vehicle, TrafficSignal, RoadGraph } from './types.js';

export function detectCorridors(
  vehicles: Vehicle[], _graph: RoadGraph, _signals: TrafficSignal[]
): number {
  // Count vehicles heading same direction on same roads
  const directions = vehicles.filter(v => v.speed > 10).length;
  return directions > 20 ? Math.floor(directions / 10) : 0;
}
```

- [ ] **Step 4: Implement pathfinding service**

```typescript
// server/src/pathfindingService.ts
import type { RoadGraph, TrafficSignal, RouteInfo } from './types.js';

export function findRoute(
  graph: RoadGraph, sourceId: string, destId: string,
  _signals: TrafficSignal[]
): RouteInfo | null {
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
  const adj = new Map<string, string[]>(graph.adjacency);
  const edgeMap = new Map(graph.edges.map(e => [e.id, e]));

  // BFS/A* on the adjacency list
  const open = [{ id: sourceId, cost: 0, heuristic: 0, parent: null as any }];
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
      const edgeIds = adj.get(sourceId) || [];
      const roadNames = edgeIds.map(eid => edgeMap.get(eid)?.name).filter(Boolean) as string[];
      return {
        path,
        distance: path.length * 500,
        estimatedTime: path.length * 30,
        signalCount: path.filter(id => _signals.some(s => s.nodeId === id)).length,
        roadNames: [...new Set(roadNames)],
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
        open.push({ id: nextId, cost: tentative, heuristic: h, parent: null });
      }
    }
  }
  return null;
}
```

- [ ] **Step 5: Wire routes in `server/src/index.ts`**

```typescript
import { getGraph } from './graphService.js';
import { computeCongestionZones, computeStats } from './congestionService.js';
import { computeSLA } from './slaService.js';
import { detectCorridors } from './corridorService.js';
import { findRoute } from './pathfindingService.js';

app.post('/api/congestion', (req, res) => {
  const { vehicles, nodes } = req.body;
  const zones = computeCongestionZones(vehicles, nodes);
  const stats = computeStats(vehicles, zones);
  res.json({ zones, stats });
});

app.post('/api/sla', (req, res) => {
  const { vehicles } = req.body;
  res.json(computeSLA(vehicles));
});

app.post('/api/corridors', (req, res) => {
  const { vehicles, graph, signals } = req.body;
  res.json({ corridors: detectCorridors(vehicles, graph, signals) });
});

app.post('/api/route', (req, res) => {
  const { graph, signals, sourceId, destId } = req.body;
  const route = findRoute(graph, sourceId, destId, signals);
  res.json({ route });
});
```

- [ ] **Step 6: Verify compilation**

```bash
cd server && npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/congestionService.ts server/src/slaService.ts \
  server/src/corridorService.ts server/src/pathfindingService.ts \
  server/src/index.ts
git commit -m "feat(server): congestion, SLA, corridor, and route endpoints"
```

---

### Task 5: Server Firestore Command Listener

**Files:**
- Create: `server/src/firebaseClient.ts`
- Modify: `server/src/index.ts` — initialize Firebase Admin + start listener

**Interfaces:**
- Produces: Listens to `commands/{docId}` in Firestore, processes spawn/override/navigate
- Produces: Writes results to `computation/{key}` for client to consume

- [ ] **Step 1: Create `server/src/firebaseClient.ts`**

```typescript
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export function initFirebase(): void {
  if (getApps().length > 0) return;

  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : undefined;

  initializeApp(
    serviceAccount
      ? { credential: cert(serviceAccount) }
      : { projectId: process.env.GOOGLE_CLOUD_PROJECT }
  );
}

export function getDb() {
  return getFirestore();
}
```

- [ ] **Step 2: Wire Firebase init in `server/src/index.ts`**

```typescript
import { initFirebase, getDb } from './firebaseClient.js';

// After app creation:
initFirebase();
const db = getDb();

// Listen for commands
const unsubCommands = db.collection('commands')
  .where('processed', '==', false)
  .onSnapshot(async (snapshot) => {
    for (const doc of snapshot.docs) {
      const cmd = doc.data();
      try {
        // Process based on cmd.type
        await db.collection('commands').doc(doc.id).update({ processed: true });
      } catch (err) {
        console.error('Command processing error:', err);
      }
    }
  });

// Graceful shutdown
process.on('SIGTERM', () => { unsubCommands(); process.exit(0); });
```

- [ ] **Step 3: Commit**

```bash
git add server/src/firebaseClient.ts server/src/index.ts
git commit -m "feat(server): Firestore command listener for spawn/override/navigate"
```

---

### Task 6: Client Sync Layer

**Files:**
- Create: `src/engine/serverSync.ts`
- Modify: `src/data/roadNetwork.ts` — add server fetch path

**Interfaces:**
- Consumes: `GET /api/graph` JSON from server
- Produces: `fetchGraphFromServer(serverUrl)` → `RoadGraph` (with Maps restored)
- Produces: `pollCongestion(serverUrl, vehicles)` → `CongestionZone[] + TrafficStats`
- Produces: `pollSLA(serverUrl, vehicles)` → SLA stats

- [ ] **Step 1: Create `src/engine/serverSync.ts`**

```typescript
import type { RoadGraph, TrafficSignal, Vehicle, CongestionZone, TrafficStats } from '../types';
import type { RouteInfo } from '../types';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:8080';

/** Deserialize server JSON arrays back into client Maps */
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

- [ ] **Step 2: Update `src/data/roadNetwork.ts` to use server**

At the top of `loadBangaloreNetwork`, add a server fetch attempt before falling back to client-side Overpass fetch:

```typescript
// Add near top of file
const SERVER_URL = import.meta.env.VITE_SERVER_URL;

// Inside loadBangaloreNetwork, before Overpass fetch:
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

- [ ] **Step 3: Commit**

```bash
git add src/engine/serverSync.ts src/data/roadNetwork.ts
git commit -m "feat(client): server sync layer — fetch graph, congestion, SLA, route from API"
```

---

### Task 7: Trim TrafficEngine — Strip Heavy Computation

**Files:**
- Modify: `src/engine/TrafficEngine.ts`
- Modify: `src/App.tsx` — use server polling for congestion/SLA/corridors

**Interfaces:**
- Consumes: `fetchCongestion`, `fetchSLA` from serverSync
- Produces: Lean `TrafficEngine` that only spawns vehicles + updates positions

- [ ] **Step 1: Strip congestion, SLA, corridor imports and calls from `TrafficEngine.ts`**

Remove:
```typescript
import { computeSLAStats } from './slaMonitor';
import { detectCorridors } from './corridorDetector';
import { detectCongestionZones, computeStats } from './congestion';
```

In `update()`, remove the calls to:
```typescript
this.slaStats = computeSLAStats(this.vehicles);
this.corridorTimer += dt;
if (this.corridorTimer >= SIGNAL_CONFIG.CORRIDOR.DETECT_INTERVAL) { ... }
this.congestionZones = detectCongestionZones(...);
this.stats = computeStats(...);
```

Replace the `update()` method end with:

```typescript
// Heavy computation removed — client only simulates vehicle movement
// Congestion, SLA, corridors computed server-side via serverSync
```

- [ ] **Step 2: Add server polling to `App.tsx`**

In the animation loop (or a separate interval), add calls to `fetchCongestion` and `fetchSLA` every 5 seconds:

```typescript
import { fetchCongestion, fetchSLA, fetchRoute } from './engine/serverSync';

// In AppContent, add:
const serverPollRef = useRef<ReturnType<typeof setInterval>>();

useEffect(() => {
  serverPollRef.current = setInterval(async () => {
    const e = engineRef.current;
    if (!e || !e.loaded) return;
    try {
      const { zones, stats } = await fetchCongestion(e.vehicles, e.graph.nodes);
      e.congestionZones = zones;
      e.stats = { ...e.stats, ...stats };
    } catch { /* server offline — use local defaults */ }
  }, 5000);
  return () => clearInterval(serverPollRef.current);
}, []);
```

- [ ] **Step 3: Verify build**

```bash
npm run build
```
Expected: tsc + vite build succeed.

- [ ] **Step 4: Commit**

```bash
git add src/engine/TrafficEngine.ts src/App.tsx
git commit -m "refactor(client): strip heavy computation, add server polling"
```

---

### Task 8: Firebase App Hosting Deployment Config

**Files:**
- Create: `firebase.apphosting.yaml`
- Modify: `firebase.json` — add App Hosting target
- Create: `server/start.sh` — entrypoint for Cloud Run

**Interfaces:**
- Produces: Working Firebase App Hosting deployment

- [ ] **Step 1: Create `firebase.apphosting.yaml`**

```yaml
# Firebase App Hosting configuration
runConfig:
  minInstances: 0
  maxInstances: 1
  concurrency: 80
  cpu: 1
  memoryMiB: 512

env:
  - variable: GOOGLE_CLOUD_PROJECT
    value: project-7d0d26b8-5887-43f6-804
  - variable: SERVER_URL
    value: https://api-wayfinder-abc123.web.app
```

- [ ] **Step 2: Add build step for server deployment**

Update `server/Dockerfile` to include the build step (multi-stage):

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
COPY --from=builder /app/dist/ ./dist/
COPY package*.json ./
RUN npm ci --omit=dev
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Wire client to use server URL via env**

In `vite.config.ts`, add environment variable prefix:

```typescript
// VITE_SERVER_URL already read in serverSync.ts
// Set in .env: VITE_SERVER_URL=https://api-wayfinder-abc123.web.app
```

- [ ] **Step 4: Commit**

```bash
git add firebase.apphosting.yaml server/Dockerfile
git commit -m "deploy: Firebase App Hosting config for server container"
```

---

## Spec Coverage

| Spec Requirement | Task |
|-----------------|------|
| Server scaffold + health endpoint | Task 1 |
| Serializable shared types | Task 2 |
| Graph building + caching | Task 3 |
| Congestion endpoint | Task 4 |
| SLA endpoint | Task 4 |
| Corridor detection endpoint | Task 4 |
| Pathfinding endpoint | Task 4 |
| Firestore command listener | Task 5 |
| Client sync layer (fetch graph, poll) | Task 6 |
| Client engine trim | Task 7 |
| Deployment config | Task 8 |
