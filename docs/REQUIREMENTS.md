# WayFinder — Full Requirements Document (v2)

## 1. Problem Statement

The current implementation has fundamental correctness gaps:

| Problem | Impact |
|---|---|
| Road edges are straight lines (intermediate geometry discarded) | Vehicles teleport through curves; roads don't match real streets |
| No road graph persistence | Full 40km OSM re-fetch on every page reload (slow, API-abusive) |
| Vehicles linearly interpolate node-to-node | No road-following; vehicles fly over buildings |
| No lane assignment or offset | All vehicles stack on the same pixel; no overtaking |
| No clear start/end lifecycle | Vehicles despawn silently mid-edge |
| No one-way road support | Bidirectional traffic on one-way streets |
| Signal phases don't match intersection geometry | Cardinal-phase model breaks at diagonal/T junctions |
| Map click has no context menu | No way to add signals or spawn vehicles interactively |
| Controller uses only Webster's formula | No network-level optimization across Bangalore |

---

## 2. Functional Requirements

### 2.1 Road Network — Geometry Preservation (REQ-G)

**REQ-G1**: `RoadEdge` MUST store a `geometry: GeoPoint[]` field containing ALL intermediate OSM node coordinates for that way segment, not just start/end intersections.

**REQ-G2**: The graph builder MUST NOT discard intermediate geometry nodes. They are retained as sub-edge waypoints, not as separate graph nodes, to keep the graph traversable.

**REQ-G3**: Road rendering MUST use the full `geometry` polyline, not a straight line between `from` and `to` nodes.

**REQ-G4**: One-way streets MUST be respected: parse the OSM `oneway` tag; only create the reverse edge when `oneway !== 'yes'` (and its variants: `-1`, `true`, `1`).

**REQ-G5**: The road graph MUST be persisted to `localStorage` with a 24-hour TTL (keyed by Bangalore center + radius). On load, if a valid cached graph exists, skip the Overpass fetch.

**REQ-G6**: A cache invalidation button MUST exist in the UI (Controller panel) to force a fresh fetch.

---

### 2.2 Vehicle Movement — Road-Following (REQ-V)

**REQ-V1**: Vehicles MUST follow the full `geometry` polyline of each edge. Position is computed by walking the geometry segments proportionally to `edgeProgress`.

**REQ-V2**: Vehicle `bearing` MUST be updated per geometry segment (the angle between consecutive geometry points), not fixed to a single edge bearing.

**REQ-V3**: Each vehicle MUST have a `laneIndex: number` (0-based, from left) assigned at spawn. Lane index MUST be capped to `edge.lanes - 1`.

**REQ-V4**: Vehicle lat/lng MUST be offset perpendicular to the current segment bearing by `(laneIndex + 0.5) × LANE_WIDTH_DEG`, so vehicles in different lanes occupy different pixels.

**REQ-V5**: Vehicles MUST have a defined `destinationNodeId`. When a vehicle reaches its destination, it MUST be removed from the simulation cleanly (not silently on edge-advance failure).

**REQ-V6**: Vehicle spawn points MUST be edge-of-network nodes only (degree-1 or degree-2 nodes) representing city entry/exit points. City-center nodes MUST NOT be used as spawn points.

**REQ-V7**: Lead-vehicle detection MUST be lane-aware: only vehicles in the same lane on the same edge are considered lead vehicles.

**REQ-V8**: Vehicles stuck for >10 seconds MUST be rerouted via A* (not BFS). If no route exists after 3 attempts, the vehicle is removed.

**REQ-V9**: Routing MUST use A* (not BFS) for all vehicles, not just user navigation.

---

### 2.3 Traffic Signals — Geometry-Aware Phases (REQ-S)

**REQ-S1**: Signal phases MUST be derived from the actual bearings of connecting edges at each intersection node, not assumed to be cardinal N/S/E/W.

**REQ-S2**: Phases MUST be grouped by approach direction: edges within 45° of each other share a phase. This correctly handles T-junctions, diagonal crossings, and 5-way intersections.

**REQ-S3**: The stop-line position for a signal MUST be the last geometry point of an approaching edge before the intersection node, not 80% of `edgeProgress`.

**REQ-S4**: Signal state MUST be keyed per-approach-direction, not per cardinal direction. Each approach can be GREEN, YELLOW, or RED independently.

---

### 2.4 Map Interaction — Context Menu on Click (REQ-M)

**REQ-M1**: Clicking anywhere on the map MUST show a context popup at the clicked location with these actions:
- **Add Signal** — places a new signal at the nearest intersection node
- **Spawn Vehicle** — opens a vehicle type picker then spawns at the nearest node
- **Set as Source** (User role only)
- **Set as Destination** (User role only)
- **View Node Info** — shows node ID, degree, road names

**REQ-M2**: The popup MUST be dismissible by clicking elsewhere or pressing Escape.

**REQ-M3**: Supporter role sees "Add Signal" and "View Node Info" in the popup.
**REQ-M4**: Controller role sees all options.
**REQ-M5**: User role sees "Set as Source", "Set as Destination", "Spawn Vehicle".

---

### 2.5 Controller — Network-Level Congestion Optimization (REQ-C)

**REQ-C1**: The controller MUST implement a **global congestion optimizer** that runs every 30 seconds and computes the optimal signal timing plan for the entire network.

**REQ-C2**: The optimizer MUST use the **Cell Transmission Model (CTM)** or a simplified **link-based LWR (Lighthill-Whitham-Richards)** model to predict traffic propagation across the network given current signal plans.

**REQ-C3**: The optimization objective MUST be: minimize total vehicle delay across all monitored hotspot zones (not just one signal in isolation).

**REQ-C4**: The optimizer output is a `SignalPlan`: a per-signal assignment of `{ greenTime: number, offset: number, cycleLength: number }` that, when applied, reduces total delay.

**REQ-C5**: The optimizer MUST use a **genetic algorithm or simulated annealing** approach over the signal plan space, running for a fixed budget (≤200ms wall clock per optimization cycle).

**REQ-C6**: The Controller panel MUST display:
- Current optimization score (total estimated delay in vehicle-seconds)
- Δ vs. Webster's baseline
- Last optimization run time
- Number of signals in the current plan
- A "Run Optimizer Now" button for manual trigger

**REQ-C7**: When the optimizer finds a plan that reduces total delay by >10%, it MUST auto-apply the plan unless a manual override is active.

**REQ-C8**: The optimizer MUST consider green wave corridors: signals on the same corridor MUST have coordinated offsets (travel time between consecutive signals).

---

### 2.6 Persistence (REQ-P)

**REQ-P1**: Road graph (nodes, edges with geometry, signals) MUST be cached in `localStorage` with key `wayfinder_graph_v2_{lat}_{lng}_{radius}`.

**REQ-P2**: Cache MUST store: timestamp, graph as JSON, signal base configuration.

**REQ-P3**: Cache TTL: 24 hours. Expired cache triggers a fresh fetch on next load.

**REQ-P4**: User-added signals (from Supporter panel) MUST be persisted in `localStorage` under `wayfinder_user_signals`.

**REQ-P5**: User routes (from User panel) MUST be persisted in `localStorage` under `wayfinder_user_routes`, max 100 entries, FIFO eviction.

---

### 2.7 Performance (REQ-PERF)

**REQ-PERF1**: OSM geometry nodes MUST be simplified using the Ramer-Douglas-Peucker algorithm (ε = 0.00005°, ~5m) before storage to limit array size.

**REQ-PERF2**: Vehicle position update (all vehicles) MUST complete in <5ms per frame at 120 vehicles.

**REQ-PERF3**: Congestion optimizer MUST NOT block the main thread; it MUST run in a `requestIdleCallback` or a `setTimeout(0)` budget loop.

**REQ-PERF4**: Map rendering MUST reuse Leaflet marker objects (already implemented) and MUST NOT recreate signal markers every frame — signal layer only updates when phase changes.

---

## 3. Architecture Changes

```
src/
├── data/
│   ├── roadNetwork.ts         # + geometry preservation, oneway parsing, RDP simplification
│   └── graphCache.ts          # NEW: localStorage R/W with TTL, serialization
├── engine/
│   ├── vehicleSim.ts          # + geometry walking, lane offset, A* routing, lifecycle
│   ├── signalControl.ts       # + geometry-aware phase derivation
│   ├── pathfinding.ts         # + used for all vehicles (not just user nav)
│   ├── optimizer.ts           # NEW: global congestion optimizer (simulated annealing)
│   └── laneManager.ts         # NEW: lane assignment and perpendicular offset computation
├── components/
│   ├── MapView.tsx            # + geometry polylines, rotated markers, context menu popup
│   └── MapContextMenu.tsx     # NEW: click popup with role-aware actions
├── types/
│   └── index.ts               # + geometry field on RoadEdge, laneIndex on Vehicle
```

---

## 4. Congestion Optimization Algorithm

### Simulated Annealing Signal Plan

```
State S = { signalId → { greenNS, greenEW, offset } }

E(S) = Σ_vehicle estimated_delay(vehicle, S)
     = Σ_signal Σ_approach queue_length(approach) × expected_wait(approach, S)

Neighbour(S):
  - Pick random signal
  - Randomly mutate: ±2s on greenNS, greenEW, or ±1s on offset
  - Clamp to [minGreen, maxGreen]

Accept(ΔE, T) = ΔE < 0 ? true : Math.random() < Math.exp(-ΔE / T)

Temperature schedule: T = T0 × 0.95^k (cooling per iteration)
Budget: max 500 iterations OR 150ms wall clock

Apply if E(S_final) < E(S_current) × 0.90  (>10% improvement)
```

### Cell Transmission Model (Simplified)

Each edge is treated as a cell with:
- `density`: vehicles / km
- `flow`: vehicles / second
- `capacity`: lanes × jam_density × free_flow_speed

Per signal tick:
```
inflow(cell) = min(upstream.flow, signal.greenFraction × capacity)
outflow(cell) = min(density × freeFlowSpeed, capacity)
density += (inflow - outflow) × dt / length
```

This predicts how congestion propagates upstream when a signal is RED, allowing the optimizer to score plans before applying them.

---

## 5. Lane Discipline

```
Lane offset (perpendicular displacement):
  LANE_WIDTH = 3.5m = ~0.0000315° lat ≈ 0.0000350° lng (at 12.97°N)
  offset_lat = -sin(bearing_rad) × LANE_WIDTH_DEG × (laneIndex + 0.5)
  offset_lng =  cos(bearing_rad) × LANE_WIDTH_DEG × (laneIndex + 0.5)

  vehicle.lat = geometry_lat + offset_lat
  vehicle.lng = geometry_lng + offset_lng
```

Lane assignment rules:
- Bike/auto: lanes 0 (leftmost, Bangalore drives on left)
- Sedan/hatchback/suv: lanes 1..n-1
- Bus/truck: lane n-1 (rightmost, slow lane)
- Emergency: any lane, overrides all

---

## 6. Acceptance Criteria

| Requirement | Test |
|---|---|
| REQ-G1 | Edge geometry array has >2 points for curved roads in OSM data |
| REQ-G5 | Second page load uses cache (no network request to Overpass) |
| REQ-V1 | Vehicle follows road curve visible on map |
| REQ-V3 | Two vehicles on same edge in different lanes are visually separated |
| REQ-V5 | Vehicle removed on reaching destination node |
| REQ-M1 | Right-click / single-click shows context popup |
| REQ-C5 | Optimizer runs <200ms and produces lower-delay plan |
| REQ-C7 | Auto-apply fires when improvement >10% |
| REQ-P1 | `localStorage.getItem('wayfinder_graph_v2_...')` returns non-null after first load |
