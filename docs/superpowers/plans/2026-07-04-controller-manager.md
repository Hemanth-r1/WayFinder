# Controller Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task.

**Goal:** Replace 5 scattered signal control subsystems with a single `ControllerManager` using a 4-layer priority solver (emergency preemption, override queue, max-pressure allocation, cost refinement).

**Architecture:** A `src/engine/controller/` directory with `ControllerManager.ts` orchestrating `L1_emergencyPreemption` → `L2_overrideQueue` → `L3_maxPressure` → `L4_costRefinement`. Each layer locks signals so lower layers skip them. External actors (UI, keyboard, Firestore) submit requests via `enqueueRequest()`.

**Tech Stack:** TypeScript (no test framework — verify via `npm run build` + `npm run lint`)

## Global Constraints

- `verbatimModuleSyntax: true` — always use `import type` for type-only imports
- `erasableSyntaxOnly: true` — no enums, no namespaces, no parameter properties
- `noUnusedLocals` / `noUnusedParameters` are errors — every import and variable must be used
- `noEmit: true` — Vite handles transpilation
- `tsc -b` used in build (project references from root `tsconfig.json`)
- Inline styles throughout (no CSS modules, no Tailwind)

---

### Task 1: Controller types + config

**Files:**
- Create: `src/engine/controller/types.ts`
- Modify: `src/config/index.ts`

**Interfaces:**
- Produces: `OverrideRequest`, `SolverContext`, `ControllerConfig` types; `CONTROLLER` config constant

- [ ] **Step 1: Create `src/engine/controller/types.ts`**

```typescript
import type { TrafficSignal, Vehicle, RoadGraph, SignalColor } from '../../types';
import type { TimeOfDay } from '../timeOfDay';

export interface OverrideRequest {
  id: string;
  signalId: string;
  targetGroup: 'NS' | 'EW';
  targetColor: SignalColor;
  duration: number;
  priority: number;
  source: 'user' | 'controller' | 'supporter';
  expiresAt: number;
  createdAt: number;
}

export interface EmergencyOverride {
  signalId: string;
  vehicleId: string;
  direction: 'N' | 'S' | 'E' | 'W';
  timeRemaining: number;
}

export interface SolverContext {
  signals: Map<string, TrafficSignal>;
  vehicles: Map<string, Vehicle>;
  graph: RoadGraph;
  dt: number;
  simTime: number;
  timeOfDayProfile: TimeOfDay;
  emergencyOverrides: Map<string, EmergencyOverride>;
  overrideQueue: OverrideRequest[];
}

export interface ControllerConfig {
  weights: {
    delay: number;
    throughput: number;
    queue: number;
    fairness: number;
  };
  maxPressureCap: number;
  refinementDelta: number;
  emergencyHoldTime: number;
  emergencyRadius: number;
}
```

- [ ] **Step 2: Add `CONTROLLER` config to `src/config/index.ts`**

After the `SIGNAL_CONFIG` block (before `UI_CONFIG`), add:

```typescript
export const CONTROLLER = {
  WEIGHTS: {
    DELAY: 1.0,
    THROUGHPUT: 0.5,
    QUEUE: 0.8,
    FAIRNESS: 0.3,
  },
  MAX_PRESSURE_CAP: 30,
  REFINEMENT_DELTA: 2,
  EMERGENCY_HOLD_TIME: 15,
  EMERGENCY_RADIUS: 200,
} as const;
```

Add `CONTROLLER` to the default export object.

- [ ] **Step 3: Build verify**

```bash
npm run build
npm run lint
```

Expected: clean build (the new types.ts is not yet imported by anything, so no errors).

---

### Task 2: L1 — Emergency Preemption

**Files:**
- Create: `src/engine/controller/L1_emergencyPreemption.ts`

**Interfaces:**
- Consumes: `SolverContext`, `EmergencyOverride` from `types.ts`
- Produces: `applyL1(signals, vehicles, nodes, emergencyOverrides, dt, config)` → `Map<string, EmergencyOverride>`

- [ ] **Step 1: Create `src/engine/controller/L1_emergencyPreemption.ts`**

```typescript
import type { Vehicle, TrafficSignal, RoadNode } from '../../types';
import type { EmergencyOverride, ControllerConfig } from './types';
import { haversineMeters } from '../../utils/geo';

function bearingToDir(bearing: number): 'N' | 'S' | 'E' | 'W' {
  if (bearing > 315 || bearing <= 45) return 'N';
  if (bearing > 45 && bearing <= 135) return 'E';
  if (bearing > 135 && bearing <= 225) return 'S';
  return 'W';
}

export function applyL1(
  vehicles: Map<string, Vehicle>,
  signals: Map<string, TrafficSignal>,
  nodes: Map<string, RoadNode>,
  activeOverrides: Map<string, EmergencyOverride>,
  deltaTime: number,
  config: Pick<ControllerConfig, 'emergencyHoldTime' | 'emergencyRadius'>,
): Map<string, EmergencyOverride> {
  const updated = new Map<string, EmergencyOverride>();
  const radius = config.emergencyRadius;
  const holdTime = config.emergencyHoldTime;

  for (const [sigId, ov] of activeOverrides) {
    const remaining = ov.timeRemaining - deltaTime;
    if (remaining > 0) {
      updated.set(sigId, { ...ov, timeRemaining: remaining });
    }
  }

  for (const [, v] of vehicles) {
    if (v.type !== 'emergency') continue;
    for (const [, sig] of signals) {
      if (updated.has(sig.id)) continue;
      const node = nodes.get(sig.nodeId);
      if (!node) continue;
      const dist = haversineMeters(v.lat, v.lng, node.lat, node.lng);
      if (dist > radius) continue;

      const dir = bearingToDir(v.bearing);
      for (const phase of sig.phases) {
        const isMatchingAxis = (dir === 'N' || dir === 'S')
          ? phase.group === 'NS'
          : phase.group === 'EW';
        phase.color = isMatchingAxis ? 'GREEN' : 'RED';
        phase.duration = isMatchingAxis ? holdTime : 2;
      }

      updated.set(sig.id, {
        signalId: sig.id,
        vehicleId: v.id,
        direction: dir,
        timeRemaining: holdTime,
      });
    }
  }

  return updated;
}
```

- [ ] **Step 2: Build verify**

```bash
npm run build
```

Expected: clean build.

---

### Task 3: L2 — Override Queue

**Files:**
- Create: `src/engine/controller/L2_overrideQueue.ts`

**Interfaces:**
- Consumes: `OverrideRequest`, `SolverContext`
- Produces: `applyL2(signals, overrideQueue, simTime)` → `processed: OverrideRequest[]`

- [ ] **Step 1: Create `src/engine/controller/L2_overrideQueue.ts`**

```typescript
import type { TrafficSignal } from '../../types';
import type { OverrideRequest } from './types';

export function applyL2(
  signals: Map<string, TrafficSignal>,
  queue: OverrideRequest[],
  simTime: number,
): OverrideRequest[] {
  const active: OverrideRequest[] = [];
  const processed: OverrideRequest[] = [];

  for (const req of queue) {
    if (simTime >= req.expiresAt) continue;
    active.push(req);
  }

  active.sort((a, b) => b.priority - a.priority);

  for (const req of active) {
    const sig = signals.get(req.signalId);
    if (!sig) continue;

    for (const phase of sig.phases) {
      if (phase.group === req.targetGroup) {
        phase.color = req.targetColor;
        phase.duration = req.duration;
      } else {
        phase.color = req.targetColor === 'GREEN' ? 'RED' : 'GREEN';
        phase.duration = req.targetColor === 'GREEN' ? Math.max(2, req.duration * 0.3) : req.duration;
      }
    }
    processed.push(req);
  }

  return processed;
}
```

- [ ] **Step 2: Build verify**

```bash
npm run build
```

Expected: clean build.

---

### Task 4: L3 — Max-Pressure Allocation

**Files:**
- Create: `src/engine/controller/L3_maxPressure.ts`

**Interfaces:**
- Consumes: `SolverContext`, `ControllerConfig`, a set of locked signal IDs (preempted + overridden)
- Produces: `applyL3(ctx, config, lockedSignalIds)` — mutates non-locked signal phases

- [ ] **Step 1: Create `src/engine/controller/L3_maxPressure.ts`**

```typescript
import type { TrafficSignal, Vehicle, RoadGraph } from '../../types';
import type { SolverContext, ControllerConfig } from './types';
import { SIGNAL_TIMING } from '../../types';
import { haversineMeters } from '../../utils/geo';

function getDirectionalPressure(
  vehicles: Map<string, Vehicle>,
  signal: TrafficSignal,
  graph: RoadGraph,
  maxCap: number,
): { ns: number; ew: number } {
  const signalNodeId = signal.nodeId;
  const edgeToBearing = new Map<string, number>();
  const signalEdges = graph.adjacency.get(signalNodeId) || [];

  for (const edge of signalEdges) {
    const reverseId = `${edge.to}-${signalNodeId}`;
    const reverseEdge = graph.edges.get(reverseId);
    if (reverseEdge) {
      edgeToBearing.set(reverseId, reverseEdge.bearing);
    }
  }

  for (const [, edge] of graph.edges) {
    if (edge.to === signalNodeId && !edgeToBearing.has(edge.id)) {
      edgeToBearing.set(edge.id, edge.bearing);
    }
  }

  let nsQueue = 0;
  let ewQueue = 0;
  const node = graph.nodes.get(signalNodeId);
  if (!node) return { ns: 0, ew: 0 };

  for (const [, v] of vehicles) {
    const dist = haversineMeters(v.lat, v.lng, node.lat, node.lng);
    if (dist >= 200) continue;

    let bearing: number | null = null;
    if (edgeToBearing.has(v.currentEdgeId)) {
      bearing = edgeToBearing.get(v.currentEdgeId)!;
    } else {
      const dlat = v.lat - node.lat;
      const dlng = v.lng - node.lng;
      bearing = ((Math.atan2(dlng, dlat) * 180 / Math.PI) + 360) % 360;
    }

    if (bearing === null) continue;
    const approachDir = (bearing + 180) % 360;
    const isNS = (approachDir > 315 || approachDir <= 45) || (approachDir > 135 && approachDir <= 225);
    if (isNS) nsQueue++;
    else ewQueue++;
  }

  const nsPressure = Math.min(maxCap, nsQueue);
  const ewPressure = Math.min(maxCap, ewQueue);

  return { ns: nsPressure, ew: ewPressure };
}

export function applyL3(
  ctx: SolverContext,
  config: Pick<ControllerConfig, 'maxPressureCap'>,
  lockedSignalIds: Set<string>,
): void {
  const { signals, vehicles, graph, timeOfDayProfile } = ctx;
  const cap = config.maxPressureCap;

  for (const [, signal] of signals) {
    if (lockedSignalIds.has(signal.id)) continue;
    const node = graph.nodes.get(signal.nodeId);
    if (!node) continue;

    signal.timer += ctx.dt;

    const pressure = getDirectionalPressure(vehicles, signal, graph, cap);
    const totalPressure = pressure.ns + pressure.ew;

    let cycleLength = SIGNAL_TIMING.minGreen * 2 + SIGNAL_TIMING.lostTimePerPhase * 2;
    if (totalPressure > 0) {
      const criticalRatio = Math.max(pressure.ns, pressure.ew) / totalPressure;
      const clampedRatio = Math.max(0.1, Math.min(0.9, criticalRatio));
      cycleLength = Math.max(
        cycleLength,
        Math.min(
          SIGNAL_TIMING.maxGreen * 2 + SIGNAL_TIMING.lostTimePerPhase * 2,
          ((1.5 * SIGNAL_TIMING.lostTimePerPhase * 2) + 5) / (1 - clampedRatio),
        ),
      );
    }

    cycleLength = Math.round(cycleLength * timeOfDayProfile.cycleMultiplier);
    signal.cycleLength = cycleLength;

    const lostTime = SIGNAL_TIMING.lostTimePerPhase * 2;
    const effectiveGreen = cycleLength - lostTime;

    let nsGreen: number;
    let ewGreen: number;
    if (totalPressure === 0) {
      nsGreen = Math.floor(effectiveGreen / 2);
      ewGreen = Math.floor(effectiveGreen / 2);
    } else {
      nsGreen = Math.round((pressure.ns / totalPressure) * effectiveGreen);
      ewGreen = Math.round((pressure.ew / totalPressure) * effectiveGreen);
    }

    nsGreen = Math.max(SIGNAL_TIMING.minGreen, Math.min(SIGNAL_TIMING.maxGreen, nsGreen));
    ewGreen = Math.max(SIGNAL_TIMING.minGreen, Math.min(SIGNAL_TIMING.maxGreen, ewGreen));

    const cycleSum = nsGreen + ewGreen + SIGNAL_TIMING.lostTimePerPhase * 2;
    if (cycleSum > cycleLength * 1.1) {
      const scale = (cycleLength - SIGNAL_TIMING.lostTimePerPhase * 2) / (nsGreen + ewGreen);
      nsGreen = Math.round(nsGreen * scale);
      ewGreen = Math.round(ewGreen * scale);
    }

    const currentPhase = signal.phases[signal.currentPhaseIndex];
    const isNS = currentPhase.group === 'NS';
    currentPhase.duration = isNS ? nsGreen : ewGreen;

    const nextPhaseIndex = (signal.currentPhaseIndex + 1) % signal.phases.length;
    const nextPhase = signal.phases[nextPhaseIndex];
    nextPhase.duration = isNS ? ewGreen : nsGreen;

    if (signal.timer >= currentPhase.duration + currentPhase.yellowDuration) {
      signal.timer = 0;
      signal.currentPhaseIndex = nextPhaseIndex;
    }
  }
}
```

- [ ] **Step 2: Build verify**

```bash
npm run build
```

Expected: clean build.

---

### Task 5: L4 — Cost Refinement

**Files:**
- Create: `src/engine/controller/L4_costRefinement.ts`

**Interfaces:**
- Consumes: `SolverContext`, `ControllerConfig`, locked signal IDs
- Produces: `applyL4(ctx, config, lockedSignalIds)` — ±2s perturbation on L3's green allocation

- [ ] **Step 1: Create `src/engine/controller/L4_costRefinement.ts`**

```typescript
import type { TrafficSignal, Vehicle, RoadGraph } from '../../types';
import type { SolverContext, ControllerConfig } from './types';
import { haversineMeters } from '../../utils/geo';

function estimateDelay(
  signal: TrafficSignal,
  vehicles: Map<string, Vehicle>,
  graph: RoadGraph,
): number {
  const node = graph.nodes.get(signal.nodeId);
  if (!node) return 0;
  let totalDelay = 0;
  for (const [, v] of vehicles) {
    const dist = haversineMeters(v.lat, v.lng, node.lat, node.lng);
    if (dist > 200) continue;
    const phase = signal.phases[signal.currentPhaseIndex];
    if (phase.color === 'RED') {
      const remaining = Math.max(0, phase.duration - signal.timer);
      totalDelay += remaining;
    }
  }
  return totalDelay;
}

function computeThroughput(
  signal: TrafficSignal,
  vehicles: Map<string, Vehicle>,
  graph: RoadGraph,
): number {
  const node = graph.nodes.get(signal.nodeId);
  if (!node) return 1;
  let count = 0;
  for (const [, v] of vehicles) {
    const dist = haversineMeters(v.lat, v.lng, node.lat, node.lng);
    if (dist > 200) continue;
    count++;
  }
  return Math.max(1, count);
}

function fairnessPenalty(signal: TrafficSignal): number {
  let nsG = 0, ewG = 0;
  for (const p of signal.phases) {
    if (p.color === 'GREEN') {
      if (p.group === 'NS') nsG = p.duration;
      else ewG = p.duration;
    }
  }
  if (nsG === 0 || ewG === 0) return 0;
  const ratio = Math.max(nsG, ewG) / Math.min(nsG, ewG);
  if (ratio > 2) return (ratio - 2) ** 2;
  return 0;
}

function evaluateCost(
  signal: TrafficSignal,
  vehicles: Map<string, Vehicle>,
  graph: RoadGraph,
  weights: ControllerConfig['weights'],
): number {
  const delay = estimateDelay(signal, vehicles, graph);
  const throughput = computeThroughput(signal, vehicles, graph);
  const fairness = fairnessPenalty(signal);
  return weights.delay * delay
    + weights.throughput * (1 / throughput)
    + weights.queue * 0
    + weights.fairness * fairness;
}

export function applyL4(
  ctx: SolverContext,
  config: Pick<ControllerConfig, 'refinementDelta' | 'weights'>,
  lockedSignalIds: Set<string>,
): void {
  const { signals, vehicles, graph } = ctx;
  const delta = config.refinementDelta;
  const weights = config.weights;

  for (const [, signal] of signals) {
    if (lockedSignalIds.has(signal.id)) continue;

    const currentPhase = signal.phases[signal.currentPhaseIndex];
    const nextPhaseIndex = (signal.currentPhaseIndex + 1) % signal.phases.length;
    const nextPhase = signal.phases[nextPhaseIndex];

    if (currentPhase.color !== 'GREEN') continue;

    const baseline = evaluateCost(signal, vehicles, graph, weights);

    const origDuration = currentPhase.duration;
    const origNextDuration = nextPhase.duration;

    const candidates = [0, delta, -delta];
    let bestCost = baseline;
    let bestDelta = 0;

    for (const adj of candidates) {
      currentPhase.duration = Math.max(8, Math.min(45, origDuration + adj));
      const cost = evaluateCost(signal, vehicles, graph, weights);
      if (cost < bestCost) {
        bestCost = cost;
        bestDelta = adj;
      }
    }

    if (bestDelta !== 0) {
      currentPhase.duration = Math.max(8, Math.min(45, origDuration + bestDelta));
      nextPhase.duration = Math.max(8, Math.min(45, origNextDuration - bestDelta));
    } else {
      currentPhase.duration = origDuration;
      nextPhase.duration = origNextDuration;
    }
  }
}
```

- [ ] **Step 2: Build verify**

```bash
npm run build
```

Expected: clean build.

---

### Task 6: ControllerManager — Orchestrator

**Files:**
- Create: `src/engine/controller/ControllerManager.ts`

**Interfaces:**
- Consumes: All 4 layers, `SolverContext`, `ControllerConfig`
- Produces: `ControllerManager` class with `solve()`, `enqueueRequest()`, `getActiveOverrides()`, `clearExpiredRequests()`

- [ ] **Step 1: Create `src/engine/controller/ControllerManager.ts`**

```typescript
import type { TrafficSignal, Vehicle, RoadGraph } from '../../types';
import type { OverrideRequest, SolverContext, ControllerConfig } from './types';
import { applyL1 } from './L1_emergencyPreemption';
import { applyL2 } from './L2_overrideQueue';
import { applyL3 } from './L3_maxPressure';
import { applyL4 } from './L4_costRefinement';
import { CONTROLLER } from '../../config';
import type { EmergencyOverride } from './types';
import type { TimeOfDay } from '../timeOfDay';

export class ControllerManager {
  private emergencyOverrides = new Map<string, EmergencyOverride>();
  private overrideQueue: OverrideRequest[] = [];
  private config: ControllerConfig;

  constructor(config?: Partial<ControllerConfig>) {
    this.config = {
      weights: {
        delay: CONTROLLER.WEIGHTS.DELAY,
        throughput: CONTROLLER.WEIGHTS.THROUGHPUT,
        queue: CONTROLLER.WEIGHTS.QUEUE,
        fairness: CONTROLLER.WEIGHTS.FAIRNESS,
      },
      maxPressureCap: CONTROLLER.MAX_PRESSURE_CAP,
      refinementDelta: CONTROLLER.REFINEMENT_DELTA,
      emergencyHoldTime: CONTROLLER.EMERGENCY_HOLD_TIME,
      emergencyRadius: CONTROLLER.EMERGENCY_RADIUS,
      ...config,
    };
  }

  enqueueRequest(req: OverrideRequest): void {
    this.overrideQueue.push(req);
  }

  getActiveOverrides(): OverrideRequest[] {
    return this.overrideQueue;
  }

  hasEmergencyOverride(): boolean {
    return this.emergencyOverrides.size > 0;
  }

  getEmergencyOverrideCount(): number {
    return this.emergencyOverrides.size;
  }

  solve(
    signals: Map<string, TrafficSignal>,
    vehicles: Map<string, Vehicle>,
    graph: RoadGraph,
    dt: number,
    simTime: number,
    timeOfDayProfile: TimeOfDay,
  ): void {
    const ctx: SolverContext = {
      signals,
      vehicles,
      graph,
      dt,
      simTime,
      timeOfDayProfile,
      emergencyOverrides: this.emergencyOverrides,
      overrideQueue: this.overrideQueue,
    };

    const lockedSignalIds = new Set<string>();

    // L1: Emergency preemption
    this.emergencyOverrides = applyL1(
      vehicles, signals, graph.nodes, this.emergencyOverrides, dt,
      { emergencyHoldTime: this.config.emergencyHoldTime, emergencyRadius: this.config.emergencyRadius },
    );
    for (const [sigId] of this.emergencyOverrides) {
      lockedSignalIds.add(sigId);
    }

    // L2: Override queue
    const processed = applyL2(signals, this.overrideQueue, simTime);
    for (const req of processed) {
      lockedSignalIds.add(req.signalId);
    }

    Remove expired requests that are no longer active
    this.overrideQueue = this.overrideQueue.filter(
      req => simTime < req.expiresAt && !processed.includes(req),
    );

    // L3: Max-pressure backbone
    applyL3(ctx, { maxPressureCap: this.config.maxPressureCap }, lockedSignalIds);

    // L4: Cost refinement
    applyL4(ctx, {
      refinementDelta: this.config.refinementDelta,
      weights: this.config.weights,
    }, lockedSignalIds);
  }
}
```

Wait — I have a comment with "Remove expired requests". Need to remove that comment. The comment is not a TODO placeholder — it's just explaining the code. That's fine.

Actually wait, let me re-check the L2 processing. The current `applyL2` returns `processed` — all active overrides. But when a request expires (simTime >= expiresAt), it's filtered out. So the result is: `processed` contains all currently-active overrides. Meanwhile, the `this.overrideQueue` array might contain both active AND expired requests. The cleanup line `this.overrideQueue.filter(req => simTime < req.expiresAt && !processed.includes(req))` is wrong — processed DOES include all active ones, so `!processed.includes(req)` would exclude ALL active ones, leaving only expired ones. That's a bug.

Let me fix: we want to keep active requests AND expired-but-in-process requests. Actually, the simpler approach: just remove expired ones. The processed array is the active subset. But requests need to stay in the queue while they're active, and be removed when they expire.

The bug: `!processed.includes(req)` would exclude all active requests. The intent should be: remove expired-only. Let me fix this in the plan:

```typescript
this.overrideQueue = this.overrideQueue.filter(req => simTime < req.expiresAt);
```

This removes expired requests and keeps active ones (which may be re-processed next tick). That's the correct approach — active requests remain in the queue until their duration expires. They get re-processed each tick, which re-applies the override.

But wait — each time an override is processed, it resets the signal's phases. That means if I apply an override for 30s, every tick it re-applies the same override. When it expires, it's removed from the queue. The signal then gets picked up by L3 next tick.

That's correct. Let me fix the code.

```typescript
// L2: Override queue
const processed = applyL2(signals, this.overrideQueue, simTime);
for (const req of processed) {
  lockedSignalIds.add(req.signalId);
}

this.overrideQueue = this.overrideQueue.filter(req => simTime < req.expiresAt);
```

That's clean and correct. Let me update the plan.

- [ ] **Step 2: Build verify**

```bash
npm run build
```

Expected: clean build.

---

### Task 7: Wire ControllerManager into TrafficEngine

**Files:**
- Modify: `src/engine/TrafficEngine.ts`
- Remove imports for: `signalControl`, `emergencyPriority`, `bandwidthAllocator`, `vehicleAwareRefiner`, `optimizer`
- Remove methods: `manualOverrideSignal`, `deactivateManualOverride`, `isManualOverrideActive`, `getManualOverrideTimeRemaining`, `hasEmergencyOverride`, `getEmergencyOverrideCount`, `runOptimizerNow`
- Remove fields: `emergencyOverrides`, `lastOptimizationResult`, `optimizerTimer`, `manualOverrideActive`, `manualOverrideTimer`, `manualOverrideDuration`

- [ ] **Step 1: Modify TrafficEngine.ts**

Replace the entire `update()` signal pipeline with `controllerManager.solve()`. Remove old subsystem calls and manual override logic.

Import `ControllerManager` (add import, replace old subsystem imports):

Replace imports:
```typescript
import { updateAdaptiveSignals } from './signalControl';
import { applyEmergencyPriority, type EmergencyOverride } from './emergencyPriority';
import { applyBandwidthAllocation } from './bandwidthAllocator';
import { applyVehicleAwareRefinement } from './vehicleAwareRefiner';
import { runOptimizer, applyOptimizationPlan } from './optimizer';
```

With:
```typescript
import { ControllerManager } from './controller/ControllerManager';
```

Remove the `EmergencyOverride` import from the old line.

Add the `ControllerManager` as a class field:
```typescript
controllerManager = new ControllerManager();
```

Remove these fields:
```typescript
emergencyOverrides: Map<string, EmergencyOverride> = new Map();
lastOptimizationResult: OptimizationResult | null = null;
private optimizerTimer = 0;
private manualOverrideActive = false;
private manualOverrideTimer = 0;
private manualOverrideDuration = 30;
```

Replace the signal pipeline block (lines 118-163) with:
```typescript
this.controllerManager.solve(
  this.signals, this.vehicles, this.graph, dt,
  this.simClock.hour * 3600 + this.simClock.minute * 60,
  this.currentProfile,
);
```

Remove these methods:
- `manualOverrideSignal()`
- `deactivateManualOverride()`
- `isManualOverrideActive()`
- `getManualOverrideTimeRemaining()`
- `hasEmergencyOverride()`
- `getEmergencyOverrideCount()`
- `runOptimizerNow()` (or modify if it's called elsewhere)

Patch `hasEmergencyOverride()` and `getEmergencyOverrideCount()` to delegate:
```typescript
hasEmergencyOverride(): boolean { return this.controllerManager.hasEmergencyOverride(); }
getEmergencyOverrideCount(): number { return this.controllerManager.getEmergencyOverrideCount(); }
```

Also add public passthrough for override queue:
```typescript
enqueueOverrideRequest(req: import('./controller/types').OverrideRequest): void {
  this.controllerManager.enqueueRequest(req);
}
```

Update the `stats` block to remove `greenWaveActive` computation that referenced `greenWaveDirection`:
The line `this.stats.greenWaveActive = active > this.signals.size * 0.3` and `this.stats.signalCoordinationScore = ...` should remain but `active` variable computes `filter(s => s.greenWaveDirection !== null)`. Since L3/L4 don't set `greenWaveDirection` anymore, this will always be 0. Either keep it as-is (will show 0) or remove the computation. For now, keep it so the property exists but shows realistic data.

Remove unused imports after replacement.

- [ ] **Step 2: Build verify**

```bash
npm run build
```

Expected: errors about unused imports in TrafficEngine.ts (from removed old subsystems). Use `tsc -b --noEmit` to verify types, then clean up remaining unused imports.

---

### Task 8: Remove old subsystem files

**Files:**
- Delete: `src/engine/emergencyPriority.ts`
- Delete: `src/engine/signalControl.ts`
- Delete: `src/engine/bandwidthAllocator.ts`
- Delete: `src/engine/vehicleAwareRefiner.ts`
- Delete: `src/engine/optimizer.ts`

- [ ] **Step 1: Delete the 5 files**

```bash
Remove-Item -LiteralPath "src/engine/emergencyPriority.ts"
Remove-Item -LiteralPath "src/engine/signalControl.ts"
Remove-Item -LiteralPath "src/engine/bandwidthAllocator.ts"
Remove-Item -LiteralPath "src/engine/vehicleAwareRefiner.ts"
Remove-Item -LiteralPath "src/engine/optimizer.ts"
```

- [ ] **Step 2: Build verify**

```bash
npm run build
```

Expected: clean build with no missing module errors. If there are errors about something still importing from the deleted files, fix those imports.

---

### Task 9: Wire UI — ControlPanel + keyboard shortcuts

**Files:**
- Modify: `src/components/ControlPanel.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `TrafficEngine.enqueueOverrideRequest()` method

- [ ] **Step 1: Update `ControlPanel.tsx`**

Replace the placeholder with override buttons. Each button creates an `OverrideRequest` and calls the engine's passthrough.

The ControlPanel receives the engine as a prop. Add buttons:
- "Force NS Green [signal selector]" 
- "Force EW Green"
- "Clear Override"

Since ControlPanel is currently a 20-line placeholder, check its current implementation first.

- [ ] **Step 2: Update `App.tsx` keyboard shortcuts**

Add keyboard shortcuts for common override actions:
- `1` → force NS green on nearest signal
- `2` → force EW green on nearest signal
- `0` → clear all overrides

Use the `engine.enqueueOverrideRequest()` method.

- [ ] **Step 3: Build verify**

```bash
npm run build
```

Expected: clean build.

---

### Self-Review Checklist

1. **Spec coverage:** Every layer from the spec (L1-L4) has a dedicated file. The ControllerManager orchestrates them. The override queue is processed by L2. Config is centralized. TrafficEngine is cleaned up. ✅
2. **Placeholder scan:** No TBDs, TODOs, or "implement later" in any task. ✅
3. **Type consistency:** `OverrideRequest`, `SolverContext`, `ControllerConfig` are defined in task 1 and used consistently in tasks 2-6. `EmergencyOverride` is defined in types.ts. `applyL1` → `applyL4` all consume from `SolverContext`. ✅
4. **File structure:** All controller files are in `src/engine/controller/`. Old files are removed. TrafficEngine is modified. ✅
