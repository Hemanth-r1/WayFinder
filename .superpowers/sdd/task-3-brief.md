### Task 3: Server Graph Service (OSM + Caching)

**Files:**
- Create: `server/src/graphService.ts`
- Create: `server/src/roadNetwork.ts`
- Modify: `server/src/index.ts` — add `GET /api/graph`

**Interfaces:**
- Produces: `GET /api/graph?lat=12.9716&lng=77.5946&radius=40000` → `{ nodes, edges, adjacency, signals, source, version }`
- `buildBangaloreNetwork(centerLat, centerLng, radiusM)` → `{ graph: RoadGraph, signals: TrafficSignal[], source: string }`

**IMPORTANT CONTEXT:** The plan says `parseOSMData` and `buildSyntheticGrid` are "[Abridged for plan]" — the implementer MUST port the FULL graph-building logic from the existing client code at `src/data/roadNetwork.ts`. Read that file as the reference implementation.

**Server types are at** `server/src/types.ts` — they use arrays instead of Maps for JSON serialization:
- `RoadGraph` has `nodes: RoadNode[]`, `edges: RoadEdge[]`, `adjacency: [string, string[]][]`
- `TrafficSignal` matches the server type

The server version should:
1. Port the core graph building from `src/data/roadNetwork.ts` (Overpass fetch, geometry processing, synthetic grid fallback)
2. Use the server's serializable types (convert Maps to arrays at the end)
3. NOT include the client's progressive loading / multi-phase cache system — this is a simple "fetch once, cache forever" endpoint
4. NOT use `import.meta.env` or any browser APIs
5. Use Node.js global `fetch` (available in Node 20, which is the Docker image)

**Step 1: Create `server/src/graphService.ts`**

```typescript
import type { RoadGraph, TrafficSignal } from './types.js';

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
  const { buildBangaloreNetwork } = await import('./roadNetwork.js');
  const result = await buildBangaloreNetwork(CENTER.lat, CENTER.lng, RADIUS);
  cache = { ...result, version: Date.now() };
  return { graph: cache.graph!, signals: cache.signals, source: cache.source, version: cache.version };
}

export function invalidateCache(): void {
  cache = { graph: null, signals: [], source: 'none', version: 0 };
}
```

**Step 2: Create `server/src/roadNetwork.ts`**

Port the FULL graph-building logic from `C:\AVKS\Github\WayFinder\src\data\roadNetwork.ts` to the server.

The signature:

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
  const grid = buildSyntheticGrid(centerLat, centerLng);
  return grid;
}
```

Key differences from the client version:
- Use `import type { RoadNode, RoadEdge, TrafficSignal, RoadGraph } from './types.js'` (server types)
- Do NOT import from `../types`, `../config`, `./graphCache`, `./firebaseCache`, `./signalStore`
- The functions `bearingFromDeg`, `haversineMeters`, `rdp`, `perpendicularDist`, `polylineLength`, `speedForHighway`, `lanesForHighway`, `roadTypeFromHighway`, `isOneway`, `isReverseOneway`, `deriveApproaches`, `createPhase` should be ported as-is
- `fetchOSMBbox` uses the browser `fetch` API — this works in Node 20 (global fetch)
- `fetchOSMRoads` and the grid-based split strategy should be ported
- `buildGraphFromOSM` should be ported — it builds Maps internally but must convert to arrays for the return type
- `loadFallback` / synthetic grid should be ported as `buildSyntheticGrid`
- Remove: `loadBangaloreNetwork`, `LoadPhase`, `LoadUpdate`, `tryLoadSignalPoints`, `findNearestNode`, `getEdgeNodes` — these are client-only

The conversion from Maps to arrays happens at the very end:

```typescript
function toSerializable(result: {
  nodes: Map<string, any>; edges: Map<string, any>; adjacency: Map<string, any[]>; signals: Map<string, any>;
}): { graph: RoadGraph; signals: TrafficSignal[] } {
  return {
    graph: {
      nodes: Array.from(result.nodes.values()),
      edges: Array.from(result.edges.values()),
      adjacency: Array.from(result.adjacency.entries()).map(([k, v]) => [k, v.map((e: any) => e.id)]),
    },
    signals: Array.from(result.signals.values()),
  };
}
```

**Step 3: Add route to `server/src/index.ts`**

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

**Step 4: Verify compilation**

```bash
cd server && npx tsc --noEmit
```
Expected: No errors.

**Step 5: Commit**

```bash
git add server/src/graphService.ts server/src/roadNetwork.ts server/src/index.ts
git commit -m "feat(server): graph building from Overpass with caching"
```
