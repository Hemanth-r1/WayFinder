# Controller Manager — Unified Signal Control

**Date:** 2026-07-04
**Status:** Draft

## Problem

Signal timing decisions are scattered across 5+ independent subsystems
(`signalControl.ts`, `emergencyPriority.ts`, `bandwidthAllocator.ts`,
`vehicleAwareRefiner.ts`, `optimizer.ts`), all mutating the same
`Map<string, TrafficSignal>` in-place with no clear authority.

There is no unified override mechanism usable by UI, keyboard shortcuts, or
Firestore sync. No single entity owns the decision. The system is hard to
reason about, debug, or extend.

## Solution

A single **Controller Manager** that is the sole authority over all signal
timing. It accepts external override requests and otherwise decides
autonomously using a 4-layer solver combining max-pressure theory with a
weighted cost function.

## Architecture

```
src/engine/controller/
  ├── ControllerManager.ts    Orchestrates solve() pipeline L1→L2→L3→L4
  ├── types.ts                OverrideRequest, SolverContext, config
  ├── L1_emergencyPreemption.ts
  ├── L2_overrideQueue.ts
  ├── L3_maxPressure.ts
  └── L4_costRefinement.ts
```

The `L` prefix makes priority order unambiguous in the filesystem. Each
layer can *lock* a signal so lower layers skip it.

### Data Flow

```
TrafficEngine.update(dt)
  ├─ tickClock()
  ├─ spawnVehicles()
  ├─ updateVehicles()
  │
  ├─ controllerManager.enqueueRequest(req)   ← called by UI/Firestore/keyboard
  ├─ controllerManager.solve(signals, vehicles, graph, dt)
  │   ├─ L1: Emergency Preemption            → locks preempted signals
  │   ├─ L2: Override Queue                  → locks overridden signals
  │   ├─ L3: Max-Pressure Allocation         → skipped on locked signals
  │   └─ L4: Cost Refinement                 → skipped on locked signals
  │
  ├─ detectCongestionZones()
  ├─ computeStats()
  └─ ...
```

`controllerManager.solve()` is the **only** code path that modifies signal
phases, timers, offsets, or cycle lengths.

## Override Request Model

```typescript
interface OverrideRequest {
  id: string;
  signalId: string;
  targetGroup: 'NS' | 'EW';
  targetColor: 'GREEN' | 'RED';
  duration: number;          // seconds the override lasts
  priority: number;          // 0–100 (higher = more urgent)
  source: 'user' | 'controller' | 'supporter';
  expiresAt: number;         // engine sim time
  createdAt: number;
}
```

### Sources

| Source | Delivery | Example |
|--------|----------|---------|
| User (keyboard) | direct call to `enqueueRequest()` | Press `1` to force NS green |
| Controller (ControlPanel) | UI button → `enqueueRequest()` | "Override Junction 5 → EW" |
| Supporter (Firestore) | `overrides` collection listener → sync to queue | Community override |

### Processing (L2)

1. Each tick, prune requests where `simTime >= expiresAt`
2. Sort active requests by `priority` descending
3. For each request: force the target signal's phase, mark signal as
   `overridden = true`
4. Lower layers (L3, L4) skip overridden signals and restore them to their
   adaptive baseline when the override expires

## Solver — 4 Layers

### L1: Emergency Preemption

Scans emergency vehicles within EMERGENCY_RADIUS (200 m) of each signal.

- If an emergency vehicle approaches in direction D, force GREEN for group(D),
  RED for the cross group
- 15-second hold timer per signal (reset if still present)
- Marks signal as `preempted = true`

### L2: Override Queue

Processes the request queue (see above). Marks signal as `overridden = true`.

### L3: Max-Pressure Allocation

Core allocation for all non-locked signals. Based on max-pressure theory:

```
For each signal at node j:
  pressure_NS = sum(queue on NS approaches to j) - sum(capacity on NS out-edges from j)
  pressure_EW = sum(queue on EW approaches to j) - sum(capacity on EW out-edges from j)

  greenSplit = pressure_NS / (pressure_NS + pressure_EW)   [if both > 0]
  green_NS = cycleLength * greenSplit
  green_EW = cycleLength - green_NS - totalYellow
```

Pressure is capped at MAX_PRESSURE_CAP (30) vehicles per approach.

The time-of-day cycle multiplier from `timeOfDay.ts` is applied to `cycleLength`
before splitting.

### L4: Cost Refinement

Evaluates small perturbations (±REFINEMENT_DELTA = 2 s) to L3's green
allocations. Cost function evaluated per signal:

```
cost = w_delay * estimatedDelay
     + w_throughput * (1 / throughput)
     + w_queue * maxQueueLength
     + w_fairness * fairnessPenalty

fairnessPenalty = max(0, green_NS / green_EW - 2)²  [if green_NS > 2 * green_EW]
                + max(0, green_EW / green_NS - 2)²  [if green_EW > 2 * green_NS]
```

Picks the perturbation that minimizes cost. This prevents starvation and
improves delay without fighting L3's throughput-maximizing baseline.

### Solver Config

```typescript
CONTROLLER = {
  WEIGHTS: {
    delay: 1.0,
    throughput: 0.5,
    queue: 0.8,
    fairness: 0.3,
  },
  MAX_PRESSURE_CAP: 30,
  REFINEMENT_DELTA: 2,    // ±seconds
  EMERGENCY_HOLD_TIME: 15,
  EMERGENCY_RADIUS: 200,
}
```

## Files Changed

### Create

| File | Purpose |
|------|---------|
| `src/engine/controller/ControllerManager.ts` | Orchestrator: `solve()`, `enqueueRequest()`, `getActiveOverrides()` |
| `src/engine/controller/types.ts` | `OverrideRequest`, `SolverContext`, controller config |
| `src/engine/controller/L1_emergencyPreemption.ts` | Emergency vehicle preemption |
| `src/engine/controller/L2_overrideQueue.ts` | Request queue CRUD + processing |
| `src/engine/controller/L3_maxPressure.ts` | Max-pressure green allocation |
| `src/engine/controller/L4_costRefinement.ts` | Weighted cost fine-tune |

### Remove

| File | Replaced By |
|------|-------------|
| `src/engine/emergencyPriority.ts` | L1 |
| `src/engine/signalControl.ts` | L3 + L4 (keep `getDirectionalDensity` if reused) |
| `src/engine/bandwidthAllocator.ts` | L3 pressure dynamics |
| `src/engine/vehicleAwareRefiner.ts` | L4 |
| `src/engine/optimizer.ts` | L3 + L4 per-tick solving |

### Modify

| File | Change |
|------|--------|
| `src/engine/TrafficEngine.ts` | Replace pipeline with `controllerManager.solve()`; remove old subsystem calls; add `enqueueRequest()` passthrough |
| `src/config/index.ts` | Add `CONTROLLER` config block |
| `src/components/ControlPanel.tsx` | Wire UI buttons to `enqueueRequest()` |
| `src/App.tsx` | Wire keyboard shortcuts to `enqueueRequest()` |
| `src/data/signalStore.ts` | Optional: sync override queue to/from Firestore |

## Constants

| Key | Value | Layer |
|-----|-------|-------|
| `EMERGENCY_HOLD_TIME` | 15 s | L1 |
| `EMERGENCY_RADIUS` | 200 m | L1 |
| `MAX_PRESSURE_CAP` | 30 vehicles | L3 |
| `REFINEMENT_DELTA` | 2 s | L4 |
| `WEIGHTS.delay` | 1.0 | L4 |
| `WEIGHTS.throughput` | 0.5 | L4 |
| `WEIGHTS.queue` | 0.8 | L4 |
| `WEIGHTS.fairness` | 0.3 | L4 |

## Approaches Considered

Three approaches were evaluated during design:

### Approach 1: Weighted Cost Function (recommended)

A single `solve()` per tick computes scalar cost
`w1*delay + w2*(1/thru) + w3*queue + w4*fairness` for each
possible timing configuration and picks the minimum.

**Pros:** Simple, transparent, easy to tune via config.
**Cons:** May not maximize throughput as well as pressure-based methods.

### Approach 2: Priority-Layered Solver

Each objective is a layer processed in strict priority order
(emergency → throughput → delay → queue → fairness). Higher layers can
override lower ones.

**Pros:** Predictable per-objective behavior.
**Cons:** Hard to reason about cross-layer interactions.

### Approach 3: Max-Pressure / Back-Pressure Algorithm

Treats traffic as a fluid network. Each junction adjusts green time
proportionally to pressure differential (upstream queue − downstream
capacity). Mathematically proven to maximize throughput.

**Pros:** Proven throughput optimality.
**Cons:** Hard to tune for multi-objective (emergency, fairness).

### Final: Blended (selected)

A hybrid of all three: L2 priority-layered (emergency + overrides), L3
max-pressure backbone, L4 cost refinement. Each compensates for the
others' weaknesses.
