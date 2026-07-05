# SLA-Driven Adaptive Corridor Control

**Date:** 2026-07-04
**Status:** Draft

## Problem

Vehicles do not reach destinations fast enough. There is no explicit SLA (service-level
agreement) enforcement in the signal control system, no corridor-level green-wave
coordination, and no mechanism to adjust timing based on real-time fleet average speed.

## SLA Target

| Metric | Target | Notes |
|--------|--------|-------|
| Fleet average speed | >= 24 km/h (1 km in < 2.5 min) | All regular vehicles |
| Emergency vehicle speed | >= 60 km/h (1 km in < 1 min) | Stricter target |
| Measurement | Rolling average over last 60 s | All vehicles with >= 100 m travelled |
| Compliance | Average across all vehicles | Not per-vehicle or percentile |

## Design

### Overview

Four new subsystems added to TrafficEngine, running in order each frame:

```
TrafficEngine.update()
  ├── SLA Monitor          ← tracks per-vehicle speed, computes fleet avg
  ├── Corridor Detector    ← finds top-K signal sequences by vehicle flow (every 10s)
  ├── Bandwidth Allocator  ← computes corridor offsets + green splits (replaces green wave)
  ├── Vehicle-Aware Refiner← micro-adjust for approaching vehicles on known routes
  ├── updateAdaptiveSignals() → existing (simplified)
```

### 1. SLA Monitor (`src/engine/slaMonitor.ts`)

Tracks every vehicle's travelled distance and elapsed time per frame. Exports:

```ts
interface SLAStats {
  fleetAvgSpeedKmh: number;       // mean speed across all vehicles
  slaCompliant: boolean;          // fleetAvgSpeedKmh >= 24
  vehicleCount: number;           // vehicles tracked
  emergencyAvgSpeedKmh: number;   // emergency mean speed
  emergencyCompliant: boolean;    // emergencyAvgSpeedKmh >= 60
}
```

Implementation:
- Each vehicle accumulates `distanceTravelled` (meters) and `timeTravelled` (seconds) in
  `updateVehicle()`.
- Every frame, the monitor iterates vehicles with `timeTravelled > 2`, computes
  `speedKmh = (d / t) * 3.6`, aggregates into a running mean (exponential moving
  average, α = 0.1, 60 s window).
- Separate tracking for `vehicle.type === 'emergency'`.

### 2. Corridor Detector (`src/engine/corridorDetector.ts`)

Runs every CORRIDOR_DETECT_INTERVAL (10 s). Detects the top K (K = 5) signal
corridors carrying the most vehicles.

Algorithm:

1. **Build edge flow map:** For each vehicle, find its current road edge via
   `graph.edges.get(vehicle.currentEdgeId)`. Count vehicles per edge in a
   `Map<string, number>`.

2. **Score each signal** by summing the flow of all incident edges.

3. **For each signal** (sorted by score descending), grow a corridor:
   - Start from the highest-flow incident edge direction.
   - Walk forward: find the next signal reachable via a connected edge
     within DISTANCE_LIMIT (800 m).
   - Walk backward: same in reverse.
   - A corridor = `[signalId_1, signalId_2, ..., signalId_N]` with N >= 3.
   - Corridor weight = sum of edge flows along the corridor.

4. **Take the top K corridors** by weight; avoid overlaps (signals in multiple
   corridors default to the highest-weight corridor).

5. **Assign each vehicle** to its nearest corridor (or none).

Output:

```ts
interface Corridor {
  id: string;
  signalIds: string[];
  directions: Direction[];   // dominant travel direction per segment
  weight: number;            // sum of vehicle counts
  avgSpeedKmh: number;       // current avg speed on this corridor
}
```

### 3. Bandwidth Allocator (`src/engine/bandwidthAllocator.ts`)

Replaces the existing `coordinateGreenWave()` function. Runs every frame but
recomputes offsets only when corridors change.

For each corridor:

1. **Compute ideal travel time** between consecutive signals:
   `travelTime[i] = edgeLength[i] / targetSpeed` where `targetSpeed = 24 km/h`
   (6.67 m/s) for regular corridors, 60 km/h (16.67 m/s) for emergency.

2. **Offset alignment:** Given the first signal's current offset as base:
   `offset[i] = (offset[i-1] + travelTime[i-1]) % cycleLength[i]`

3. **Green split allocation:**
   - Corridor direction gets `baseGreen + bonusGreen`
   - `bonusGreen = clamp(0, 15, (24 - corridorAvgSpeed) * 3)` when below SLA
   - Non-corridor direction gets `max(minGreen, cycleLength - corridorGreen - totalYellow)`
   - Clamped to `[minGreen, maxGreen]` per signal.

4. **Conflict resolution at intersections:**
   - A signal at the intersection of two corridors inherits the higher-weight
     corridor's offset.
   - The lower-weight corridor adjusts by extending its yellow (+1s) or
     shortening its green (−2s) to avoid conflict.

5. **Apply offsets** to each signal's `signal.offset` field. Set
   `signal.greenWaveDirection` to the corridor's dominant direction.

Signals not on any detected corridor fall back to the existing Webster adaptive
timing (unchanged).

### 4. Vehicle-Aware Refiner (`src/engine/vehicleAwareRefiner.ts`)

Fine-grained adjustment for vehicles on known navigation routes. Runs every frame
on vehicles with `routePath` set.

For each routed vehicle:

1. **Look ahead** along its route for the next 3 signals (`signalIds` that are
   within 500 m).

2. **For each upcoming signal**, compute expected arrival time:
   `arrival = now + sum(travelTime to each intermediate edge)` using current
   edge speed limit.

3. **If arrival falls within the signal's red phase** for the vehicle's
   approach direction:
   - **Soft shift:** Adjust the signal's offset by up to ±2 seconds
     (`offset = (offset + adjustment) % cycleLength`).
   - **Early green:** If the vehicle is < 5 s from the signal and the opposing
     direction has received at least `minGreen`, trigger an early phase
     transition (skip remaining green on opposing side).

4. **Constraints:**
   - Minimum green for any direction: 8 s (existing `SIGNAL_TIMING.minGreen`).
   - Maximum offset shift: ±2 s per frame, resets when corridor recomputes.
   - Only applies during `phase.color === 'RED'` for the vehicle's group.

### 5. SLA Dashboard

Add to the existing stats panel in `App.tsx`:

- **Fleet speed:** `{stats.slaSpeed.toFixed(1)} km/h` with green/yellow/red
  indicator (green >= 24, yellow >= 20, red < 20).
- **SLA status:** `"✅ SLA Met"` / `"⚠️ Below SLA"` badge.
- **Corridors active:** `"{corridorCount} corridors"` with expandable details.

## Files Changed

| File | Change |
|------|--------|
| `src/engine/slaMonitor.ts` | NEW — SLA tracking and stats |
| `src/engine/corridorDetector.ts` | NEW — corridor detection |
| `src/engine/bandwidthAllocator.ts` | NEW — offset/green-split computation |
| `src/engine/vehicleAwareRefiner.ts` | NEW — vehicle-aware micro-adjustment |
| `src/engine/TrafficEngine.ts` | Wire in all 4 subsystems; remove old green wave call |
| `src/engine/signalControl.ts` | Simplify: `coordinateGreenWave()` replaced, `updateAdaptiveSignals()` kept for non-corridor signals |
| `src/types/index.ts` | Add `SLAStats` interface, extend `EngineStats` |
| `src/engine/congestion.ts` | Add `computeSLAStats()` or integrate into `computeStats()` |
| `src/App.tsx` | Add SLA indicators to stats panel |
| `src/types.ts` | Add `distanceTravelled`, `timeTravelled` to Vehicle |

## Constants

| Constant | Value | Source |
|----------|-------|--------|
| `CORRIDOR_DETECT_INTERVAL` | 10 s | `config/index.ts` |
| `MAX_CORRIDORS` | 5 | config |
| `CORRIDOR_MIN_SIGNALS` | 3 | config |
| `CORRIDOR_MAX_SIGNAL_DISTANCE` | 800 m | config |
| `SLA_TARGET_SPEED` | 24 km/h | config |
| `EMERGENCY_SLA_TARGET` | 60 km/h | config |
| `SLA_ROLLING_WINDOW` | 60 s | config |
| `REFINER_MAX_OFFSET_SHIFT` | 2 s | config |
| `REFINER_LOOKAHEAD_DISTANCE` | 500 m | config |
| `REFINER_EARLY_GREEN_THRESHOLD` | 5 s | config |

## Open Questions

1. Corridor detection on the synthetic fallback grid — will the grid's regular
   structure make corridor detection trivial? Yes: the 10×10 grid has clear N-S
   and E-W corridors, which is fine.
2. How does this interact with manual override? During override, all corridor
   control is suspended (same as now).
