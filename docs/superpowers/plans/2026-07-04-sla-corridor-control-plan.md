# SLA-Driven Adaptive Corridor Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement corridor-based green-wave signal control with SLA monitoring and vehicle-aware micro-adjustment.

**Architecture:** Four new subsystems (SLA Monitor, Corridor Detector, Bandwidth Allocator, Vehicle-Aware Refiner) wired into TrafficEngine.update(). The existing coordinateGreenWave() is replaced. updateAdaptiveSignals() is kept as a fallback for non-corridor signals.

**Tech Stack:** TypeScript, no external dependencies beyond existing Leaflet/React.

## Global Constraints

- `verbatimModuleSyntax: true` — use `import type` for type-only imports
- `erasableSyntaxOnly: true` — no enums, no namespaces
- `noUnusedLocals` / `noUnusedParameters` are errors
- Inline styles throughout (no CSS modules, no Tailwind)
- All new files go in `src/engine/`

---

### Task 1: Add new types and constants

**Files:**
- Modify: `src/config/index.ts`
- Modify: `src/types/index.ts`

**Interfaces:**
- Produces: `CORRIDOR_DETECT_INTERVAL`, `MAX_CORRIDORS`, `CORRIDOR_MIN_SIGNALS`, `CORRIDOR_MAX_SIGNAL_DISTANCE`, `SLA_TARGET_SPEED`, `EMERGENCY_SLA_TARGET`, `SLA_ROLLING_WINDOW`, `REFINER_MAX_OFFSET_SHIFT`, `REFINER_LOOKAHEAD_DISTANCE`, `REFINER_EARLY_GREEN_THRESHOLD` in config
- Produces: `Vehicle.distanceTravelled`, `Vehicle.timeTravelled` fields
- Produces: `SLAStats` interface
- Produces: `CorridorInfo` interface
- Produces: `TrafficStats.slaSpeed`, `TrafficStats.slaCompliant`, `TrafficStats.emergencySlaSpeed`, `TrafficStats.activeCorridors` fields

- [ ] **Step 1: Add constants to `src/config/index.ts`**

Add this block inside the existing `SIGNAL_CONFIG` object, before the closing `}`:

```typescript
  SLA: {
    TARGET_SPEED: 24,           // km/h
    EMERGENCY_TARGET: 60,       // km/h
    ROLLING_WINDOW: 60,         // seconds
    MIN_DISTANCE: 100,          // meters — ignore vehicles that haven't travelled this far
    EMA_ALPHA: 0.1,            // exponential moving average weight
  } as const,
  CORRIDOR: {
    DETECT_INTERVAL: 10,       // seconds between corridor recomputation
    MAX_CORRIDORS: 5,
    MIN_SIGNALS: 3,
    MAX_SIGNAL_DISTANCE: 800,  // meters between consecutive corridor signals
    EDGE_FLOW_RADIUS: 50,      // meters — vehicle proximity to assign to edge
    BONUS_GREEN_MAX: 15,       // seconds — max bonus green for corridor direction
    BONUS_GREEN_FACTOR: 3,     // multiplier: (24 - avgSpeed) * factor
  } as const,
  REFINER: {
    MAX_OFFSET_SHIFT: 2,       // seconds
    LOOKAHEAD_DISTANCE: 500,   // meters
    EARLY_GREEN_THRESHOLD: 5,  // seconds — trigger early green when vehicle is this close
  } as const,
```

- [ ] **Step 2: Extend Vehicle and add interfaces to `src/types/index.ts`**

Add `distanceTravelled` and `timeTravelled` to the `Vehicle` interface (after `waitingForSignal`):

```typescript
  waitingForSignal: boolean; driverAggression: number; routeETA: number;
  distanceTravelled: number;  // meters accumulated across edges
  timeTravelled: number;      // seconds accumulated
```

Add these new interfaces after `CongestionZone`:

```typescript
export interface SLAStats {
  fleetAvgSpeedKmh: number;
  slaCompliant: boolean;
  vehicleCount: number;
  emergencyAvgSpeedKmh: number;
  emergencyCompliant: boolean;
}

export interface CorridorInfo {
  id: string;
  signalIds: string[];
  weight: number;
  avgSpeedKmh: number;
}
```

Add `slaSpeed`, `slaCompliant`, `emergencySlaSpeed`, `activeCorridors` to `TrafficStats`:

```typescript
export interface TrafficStats {
  totalVehicles: number; avgSpeed: number; avgDelay: number; congestionHotspots: number;
  greenWaveActive: boolean; signalCoordinationScore: number; throughput: number; maxCongestion: number;
  slaSpeed: number;         // fleet average km/h
  slaCompliant: boolean;    // fleetAvgSpeedKmh >= SLA_TARGET_SPEED
  emergencySlaSpeed: number;// emergency fleet average km/h
  activeCorridors: number;  // number of active corridors
}
```

- [ ] **Step 3: Update Vehicle creation to initialize new fields**

In `src/engine/vehicleSim.ts`, all `createVehicle()`-like call sites need `distanceTravelled: 0` and `timeTravelled: 0`. Search for `return {` block after `const id =` to find the vehicle creation and add the two fields.

Specifically, find the vehicle object creation in `spawnRandomVehicle`, `spawnVehicleAt`, `spawnNavigatedVehicle` — each of those creates a Vehicle object and should include:

```typescript
    distanceTravelled: 0,
    timeTravelled: 0,
```

- [ ] **Step 4: Build check**

Run: `npm run build`
Expected: Compiles cleanly (tsc + vite).

- [ ] **Step 5: Commit**

```bash
git add src/config/index.ts src/types/index.ts src/engine/vehicleSim.ts
git commit -m "feat: add SLA and corridor types, constants"
```

---

### Task 2: Implement SLA Monitor

**Files:**
- Create: `src/engine/slaMonitor.ts`

**Interfaces:**
- Consumes: `Vehicle` with `distanceTravelled` and `timeTravelled`
- Consumes: `SLA_TARGET_SPEED`, `EMERGENCY_SLA_TARGET`, `EMA_ALPHA`, `MIN_DISTANCE` from config
- Produces: `computeSLAStats(vehicles: Map<string, Vehicle>): SLAStats`

- [ ] **Step 1: Create `src/engine/slaMonitor.ts`**

```typescript
import type { Vehicle, SLAStats } from '../types';
import { SIGNAL_CONFIG } from '../config';

export function computeSLAStats(vehicles: Map<string, Vehicle>): SLAStats {
  let sumSpeed = 0;
  let count = 0;
  let emergSumSpeed = 0;
  let emergCount = 0;

  for (const [, v] of vehicles) {
    if (v.distanceTravelled < SIGNAL_CONFIG.SLA.MIN_DISTANCE) continue;
    const speedKmh = (v.distanceTravelled / Math.max(v.timeTravelled, 0.1)) * 3.6;
    if (v.type === 'emergency') {
      emergSumSpeed += speedKmh;
      emergCount++;
    } else {
      sumSpeed += speedKmh;
      count++;
    }
  }

  const fleetAvg = count > 0 ? sumSpeed / count : 0;
  const emergAvg = emergCount > 0 ? emergSumSpeed / emergCount : 0;

  return {
    fleetAvgSpeedKmh: Math.round(fleetAvg * 10) / 10,
    slaCompliant: fleetAvg >= SIGNAL_CONFIG.SLA.TARGET_SPEED,
    vehicleCount: count,
    emergencyAvgSpeedKmh: Math.round(emergAvg * 10) / 10,
    emergencyCompliant: emergAvg >= SIGNAL_CONFIG.SLA.EMERGENCY_TARGET,
  };
}
```

- [ ] **Step 2: Build check**

Run: `npm run build`
Expected: Compiles cleanly.

- [ ] **Step 3: Commit**

```bash
git add src/engine/slaMonitor.ts
git commit -m "feat: add SLA monitor"
```

---

### Task 3: Implement Corridor Detector

**Files:**
- Create: `src/engine/corridorDetector.ts`

**Interfaces:**
- Consumes: `Map<string, Vehicle>`, `RoadGraph`, `Map<string, TrafficSignal>`, config constants
- Produces: `detectCorridors(vehicles, graph, signals): CorridorInfo[]`

- [ ] **Step 1: Create `src/engine/corridorDetector.ts`**

```typescript
import type { Vehicle, TrafficSignal, RoadGraph, CorridorInfo } from '../types';
import { SIGNAL_CONFIG } from '../config';

function bearingToGroup(bearing: number): 'NS' | 'EW' {
  return (bearing > 315 || bearing <= 45) || (bearing > 135 && bearing <= 225) ? 'NS' : 'EW';
}

/**
 * Count vehicles per road edge by proximity.
 */
function buildEdgeFlow(vehicles: Map<string, Vehicle>, graph: RoadGraph): Map<string, number> {
  const flow = new Map<string, number>();
  for (const [, v] of vehicles) {
    const edge = graph.edges.get(v.currentEdgeId);
    if (edge) flow.set(v.currentEdgeId, (flow.get(v.currentEdgeId) || 0) + 1);
  }
  return flow;
}

/**
 * Score each signal by total incident edge flow.
 */
function scoreSignals(
  signals: Map<string, TrafficSignal>,
  edgeFlow: Map<string, number>,
  graph: RoadGraph,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const [, sig] of signals) {
    let total = 0;
    const adj = graph.adjacency.get(sig.nodeId) || [];
    for (const e of adj) total += edgeFlow.get(e.id) || 0;
    scores.set(sig.nodeId, total);
  }
  return scores;
}

/**
 * Walk forward from a signal along the dominant flow direction,
 * collecting consecutive signals up to MAX_SIGNAL_DISTANCE apart.
 */
function walkCorridor(
  startId: string,
  signals: Map<string, TrafficSignal>,
  graph: RoadGraph,
  scores: Map<string, number>,
): string[] {
  const corridor: string[] = [startId];
  let current = startId;

  for (let attempt = 0; attempt < 20; attempt++) {
    const adj = graph.adjacency.get(current) || [];
    if (adj.length === 0) break;

    // Pick highest-flow outgoing edge
    let bestEdge = adj[0];
    let bestFlow = 0;
    for (const e of adj) {
      const f = scores.get(e.to) || 0;
      if (f > bestFlow) { bestFlow = f; bestEdge = e; }
    }

    const nextId = bestEdge.to;
    if (!signals.has(nextId)) break;
    if (corridor.includes(nextId)) break;

    const edgeLen = bestEdge.length;
    if (edgeLen > SIGNAL_CONFIG.CORRIDOR.MAX_SIGNAL_DISTANCE) break;

    corridor.push(nextId);
    current = nextId;
  }

  return corridor;
}

export function detectCorridors(
  vehicles: Map<string, Vehicle>,
  graph: RoadGraph,
  signals: Map<string, TrafficSignal>,
): CorridorInfo[] {
  if (signals.size < SIGNAL_CONFIG.CORRIDOR.MIN_SIGNALS) return [];

  const edgeFlow = buildEdgeFlow(vehicles, graph);
  const scores = scoreSignals(signals, edgeFlow, graph);

  // Sort signals by score descending
  const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);

  const used = new Set<string>();
  const corridors: CorridorInfo[] = [];

  for (const [nodeId, _score] of sorted) {
    if (used.has(nodeId)) continue;
    const sigIds = walkCorridor(nodeId, signals, graph, scores);
    if (sigIds.length < SIGNAL_CONFIG.CORRIDOR.MIN_SIGNALS) continue;

    // Mark all signals in this corridor as used
    for (const sid of sigIds) used.add(sid);

    // Compute corridor weight (sum of edge flows)
    let weight = 0;
    for (const sid of sigIds) weight += scores.get(sid) || 0;

    corridors.push({
      id: `cor-${corridors.length}`,
      signalIds: sigIds,
      weight,
      avgSpeedKmh: 0, // set later by bandwidth allocator
    });

    if (corridors.length >= SIGNAL_CONFIG.CORRIDOR.MAX_CORRIDORS) break;
  }

  return corridors;
}
```

- [ ] **Step 2: Build check**

Run: `npm run build`
Expected: Compiles cleanly.

- [ ] **Step 3: Commit**

```bash
git add src/engine/corridorDetector.ts
git commit -m "feat: add corridor detector"
```

---

### Task 4: Implement Bandwidth Allocator

**Files:**
- Create: `src/engine/bandwidthAllocator.ts`

**Interfaces:**
- Consumes: `CorridorInfo[]`, `Map<string, TrafficSignal>`, `RoadGraph`, `SLAStats`, config
- Produces: `applyBandwidthAllocation(corridors, signals, graph, slaStats): void`

- [ ] **Step 1: Create `src/engine/bandwidthAllocator.ts`**

```typescript
import type { TrafficSignal, RoadGraph, CorridorInfo, SLAStats, Direction } from '../types';
import { SIGNAL_TIMING, SIGNAL_CONFIG } from '../types';

const slaConfig = SIGNAL_CONFIG.SLA;
const corrConfig = SIGNAL_CONFIG.CORRIDOR;

function corridorDirection(signal: TrafficSignal, graph: RoadGraph): Direction {
  const adj = graph.adjacency.get(signal.nodeId) || [];
  if (adj.length === 0) return 'N';
  // Use bearing of first edge with highest flow
  return adj[0].bearing > 315 || adj[0].bearing <= 45 ? 'N'
    : adj[0].bearing > 45 && adj[0].bearing <= 135 ? 'E'
    : adj[0].bearing > 135 && adj[0].bearing <= 225 ? 'S'
    : 'W';
}

export function applyBandwidthAllocation(
  corridors: CorridorInfo[],
  signals: Map<string, TrafficSignal>,
  graph: RoadGraph,
  slaStats: SLAStats,
): void {
  if (corridors.length === 0) return;

  const slaDeficit = Math.max(0, slaConfig.TARGET_SPEED - slaStats.fleetAvgSpeedKmh);
  const bonusGreen = Math.min(corrConfig.BONUS_GREEN_MAX, slaDeficit * corrConfig.BONUS_GREEN_FACTOR);

  const processed = new Set<string>();

  for (const corridor of corridors) {
    let prevOffset = 0;
    let prevSignalId: string | null = null;

    for (const sigId of corridor.signalIds) {
      const signal = signals.get(sigId);
      if (!signal) continue;

      const dir = corridorDirection(signal, graph);
      const isNS = dir === 'N' || dir === 'S';

      // Compute travel time from previous signal
      if (prevSignalId) {
        const prevSig = signals.get(prevSignalId);
        const edge = graph.edges.get(`${prevSig?.nodeId}-${signal.nodeId}`)
          || graph.edges.get(`${signal.nodeId}-${prevSig?.nodeId}`);
        if (edge) {
          const targetSpeed = slaConfig.TARGET_SPEED / 3.6; // m/s
          const travelTime = edge.length / Math.max(targetSpeed, 0.1);
          const cycleLen = Math.max(signal.cycleLength, 1);
          prevOffset = (prevOffset + travelTime) % cycleLen;
          signal.offset = Math.round(prevOffset);
        }
      }

      // Green split: corridor direction gets bonus green
      const nsGreen = isNS
        ? Math.min(SIGNAL_TIMING.maxGreen, signal.phases[0].duration + bonusGreen)
        : Math.max(SIGNAL_TIMING.minGreen, signal.phases[0].duration - bonusGreen * 0.5);
      const ewGreen = isNS
        ? Math.max(SIGNAL_TIMING.minGreen, signal.phases[2].duration - bonusGreen * 0.5)
        : Math.min(SIGNAL_TIMING.maxGreen, signal.phases[2].duration + bonusGreen);

      signal.phases[0].duration = Math.max(SIGNAL_TIMING.minGreen, Math.min(SIGNAL_TIMING.maxGreen, nsGreen));
      signal.phases[2].duration = Math.max(SIGNAL_TIMING.minGreen, Math.min(SIGNAL_TIMING.maxGreen, ewGreen));
      signal.cycleLength = signal.phases[0].duration + signal.phases[0].yellowDuration
        + signal.phases[2].duration + signal.phases[2].yellowDuration;
      signal.greenWaveDirection = dir;

      processed.add(sigId);
      prevSignalId = sigId;
    }
  }

  // Non-corridor signals: reset green wave direction
  for (const [, sig] of signals) {
    if (!processed.has(sig.nodeId)) {
      sig.greenWaveDirection = null;
    }
  }
}
```

- [ ] **Step 2: Build check**

Run: `npm run build`
Expected: Compiles cleanly.

- [ ] **Step 3: Commit**

```bash
git add src/engine/bandwidthAllocator.ts
git commit -m "feat: add bandwidth allocator"
```

---

### Task 5: Implement Vehicle-Aware Refiner

**Files:**
- Create: `src/engine/vehicleAwareRefiner.ts`

**Interfaces:**
- Consumes: `Map<string, Vehicle>`, `Map<string, TrafficSignal>`, `RoadGraph`, config
- Produces: `applyVehicleAwareRefinement(vehicles, signals, graph, dt): void`

- [ ] **Step 1: Create `src/engine/vehicleAwareRefiner.ts`**

```typescript
import type { Vehicle, TrafficSignal, RoadGraph } from '../types';
import { SIGNAL_TIMING, SIGNAL_CONFIG } from '../types';

const refConfig = SIGNAL_CONFIG.REFINER;
const slaConfig = SIGNAL_CONFIG.SLA;

function bearingToGroup(bearing: number): 'NS' | 'EW' {
  return (bearing > 315 || bearing <= 45) || (bearing > 135 && bearing <= 225) ? 'NS' : 'EW';
}

/**
 * For each navigated vehicle, look ahead along its route up to LOOKAHEAD_DISTANCE.
 * If it will arrive at a red signal, micro-adjust the signal's offset.
 */
export function applyVehicleAwareRefinement(
  vehicles: Map<string, Vehicle>,
  signals: Map<string, TrafficSignal>,
  graph: RoadGraph,
  _dt: number,
): void {
  for (const [, v] of vehicles) {
    if (!v.route || v.route.length < 2) continue;
    if (v.distanceTravelled < slaConfig.MIN_DISTANCE) continue;

    let cumDist = 0;

    for (let ri = v.routeIndex; ri < v.route.length - 1 && cumDist < refConfig.LOOKAHEAD_DISTANCE; ri++) {
      const edge = graph.edges.get(`${v.route[ri]}-${v.route[ri + 1]}`)
        || graph.edges.get(`${v.route[ri + 1]}-${v.route[ri]}`);
      if (!edge) break;

      const nextNodeId = v.route[ri + 1];
      const signal = signals.get(nextNodeId);
      if (signal) {
        const travelTime = edge.length / Math.max(v.speed / 3.6, 0.1);
        cumDist += edge.length;

        const arrivalTime = (signal.offset + cumDist / Math.max(v.speed / 3.6, 0.1)) % Math.max(signal.cycleLength, 1);
        const group = bearingToGroup(v.bearing);

        // Find the phase for this vehicle's approach group
        const phaseIdx = signal.phases.findIndex(p => p.group === group && p.color === 'RED');
        if (phaseIdx === -1) continue; // already green

        const phase = signal.phases[phaseIdx];
        const phaseStartTime = signal.phases.slice(0, phaseIdx).reduce((s, p) => s + p.duration + p.yellowDuration, 0);
        const phaseEndTime = phaseStartTime + phase.duration + phase.yellowDuration;

        // If arrival is within the red phase window
        if (arrivalTime >= phaseStartTime && arrivalTime < phaseEndTime) {
          const timeToRedEnd = phaseEndTime - arrivalTime;

          // Soft shift: adjust offset by up to MAX_OFFSET_SHIFT seconds
          if (timeToRedEnd < refConfig.EARLY_GREEN_THRESHOLD && timeToRedEnd > 0) {
            signal.offset = Math.max(0, (signal.offset - timeToRedEnd + signal.cycleLength) % signal.cycleLength);
          } else if (timeToRedEnd > signal.phases[phaseIdx].duration) {
            // Vehicle is arriving early — shift offset forward slightly
            signal.offset = (signal.offset + Math.min(refConfig.MAX_OFFSET_SHIFT, timeToRedEnd - signal.phases[phaseIdx].duration)) % signal.cycleLength;
          }
        }
      }

      if (cumDist >= refConfig.LOOKAHEAD_DISTANCE) break;
    }
  }
}
```

- [ ] **Step 2: Build check**

Run: `npm run build`
Expected: Compiles cleanly.

- [ ] **Step 3: Commit**

```bash
git add src/engine/vehicleAwareRefiner.ts
git commit -m "feat: add vehicle-aware refiner"
```

---

### Task 6: Wire into TrafficEngine

**Files:**
- Modify: `src/engine/TrafficEngine.ts`
- Modify: `src/engine/vehicleSim.ts`

**Interfaces:**
- Consumes: All four new subsystems
- Replaces: `coordinateGreenWave()` call with corridor + bandwidth allocator

- [ ] **Step 1: Add distance/time tracking to `updateVehicle` in `src/engine/vehicleSim.ts`**

Find the line `vehicle.speed = Math.max(0, Math.min(vehicle.targetSpeed * 1.1, vehicle.speed + accel * deltaTime * 3.6));` and the following `const moveDist = (vehicle.speed / 3.6) * deltaTime;`.

After `moveDist` is computed, add:

```typescript
  vehicle.distanceTravelled += moveDist;
  vehicle.timeTravelled += deltaTime;
```

- [ ] **Step 2: Wire subsystems into `src/engine/TrafficEngine.ts`**

Add imports at the top:

```typescript
import { computeSLAStats } from './slaMonitor';
import { detectCorridors } from './corridorDetector';
import { applyBandwidthAllocation } from './bandwidthAllocator';
import { applyVehicleAwareRefinement } from './vehicleAwareRefiner';
import type { SLAStats, CorridorInfo } from '../types';
```

Add fields to the `TrafficEngine` class after `private manualOverrideDuration = 30;`:

```typescript
  private slaStats: SLAStats = {
    fleetAvgSpeedKmh: 0, slaCompliant: false, vehicleCount: 0,
    emergencyAvgSpeedKmh: 0, emergencyCompliant: false,
  };
  private corridors: CorridorInfo[] = [];
  private corridorTimer = 0;
```

In the `update()` method, replace the adaptive signal block (lines 118-124):

```typescript
    // Adaptive signals
    if (!this.manualOverrideActive) {
      updateAdaptiveSignals(this.signals, this.vehicles, this.graph.nodes, this.graph, dt);
    }

    // SLA monitor
    this.slaStats = computeSLAStats(this.vehicles);

    // Corridor detection (every CORRIDOR_DETECT_INTERVAL seconds)
    this.corridorTimer += dt;
    if (this.corridorTimer >= SIGNAL_CONFIG.CORRIDOR.DETECT_INTERVAL && !this.manualOverrideActive) {
      this.corridorTimer = 0;
      this.corridors = detectCorridors(this.vehicles, this.graph, this.signals);
    }

    // Bandwidth allocation
    if (!this.manualOverrideActive && this.corridors.length > 0) {
      applyBandwidthAllocation(this.corridors, this.signals, this.graph, this.slaStats);
    }

    // Vehicle-aware refinement
    if (!this.manualOverrideActive) {
      applyVehicleAwareRefinement(this.vehicles, this.signals, this.graph, dt);
    }
```

Keep the emergency priority, optimizer, congestion, and stats code unchanged after.

Update the stats assignment to include new fields (find the `this.stats = computeStats(...)` line and change it to):

```typescript
    this.congestionZones = detectCongestionZones(this.vehicles, this.graph.nodes);
    this.stats = computeStats(this.vehicles, this.congestionZones);
    this.stats.slaSpeed = this.slaStats.fleetAvgSpeedKmh;
    this.stats.slaCompliant = this.slaStats.slaCompliant;
    this.stats.emergencySlaSpeed = this.slaStats.emergencyAvgSpeedKmh;
    this.stats.activeCorridors = this.corridors.length;
```

- [ ] **Step 3: Build check**

Run: `npm run build`
Expected: Compiles cleanly.

- [ ] **Step 4: Commit**

```bash
git add src/engine/TrafficEngine.ts src/engine/vehicleSim.ts
git commit -m "feat: wire corridor control into TrafficEngine"
```

---

### Task 7: Add SLA Dashboard to App.tsx

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add SLA indicators to the stats panel in `src/App.tsx`**

Find the stats footer area (the line with `{engineState.vehicleCount}v · {engineState.signalCount}s · {engineState.nodeCount}n` around line 395) and extend it:

Replace:
```typescript
          <div style={{ fontSize: 10, color: '#555', textAlign: 'center', fontFamily: 'monospace' }}>
            {engineState.vehicleCount}v · {engineState.signalCount}s · {engineState.nodeCount}n
          </div>
```

With:
```typescript
          <div style={{ fontSize: 10, color: '#555', textAlign: 'center', fontFamily: 'monospace' }}>
            {engineState.vehicleCount}v · {engineState.signalCount}s · {engineState.nodeCount}n
          </div>
          <div style={{ fontSize: 10, textAlign: 'center', fontFamily: 'monospace', marginTop: 2, display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center' }}>
            <span style={{ color: engineState.slaCompliant ? '#4CAF50' : engineState.slaSpeed >= 20 ? '#FF9800' : '#F44336' }}>
              {engineState.slaCompliant ? '✅' : '⚠️'} {engineState.slaSpeed.toFixed(1)} km/h
            </span>
            {engineState.activeCorridors > 0 && (
              <span style={{ color: '#4488FF' }}>🛣️ {engineState.activeCorridors} cor</span>
            )}
            {engineState.emergencySlaSpeed > 0 && (
              <span style={{ color: '#FF5252' }}>🚨 {engineState.emergencySlaSpeed.toFixed(1)} km/h</span>
            )}
          </div>
```

- [ ] **Step 2: Build check**

Run: `npm run build`
Expected: Compiles cleanly.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat: add SLA dashboard to stats panel"
```

---

### Task 8: Final build verification

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: `tsc -b && vite build` both pass with 0 errors.

- [ ] **Step 2: Lint check**

Run: `npm run lint`
Expected: 0 errors (pre-existing warnings only).
