### Task 2: Shared Types Package

**Files:**
- Create: `server/src/types.ts` — mirror of shared types (serializable versions)

**Interfaces:**
- Produces: Serializable versions of `RoadGraph`, `Vehicle`, `TrafficSignal`, `CongestionZone`, `TrafficStats`, `RouteInfo`
- Consumes: (none — standalone type definitions)

**Step 1: Create `server/src/types.ts` with serializable graph types**

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
  adjacency: [string, string[]][];
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

**Step 2: Commit**

```bash
git add server/src/types.ts
git commit -m "feat(server): add serializable shared types"
```
