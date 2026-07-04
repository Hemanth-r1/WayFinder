# WayFinder — Implementation Reference

## Stack

| Layer | Technology |
|---|---|
| Framework | React 19 + TypeScript 6 |
| Build | Vite 8 |
| Map | Leaflet 1.9 + OpenStreetMap tiles |
| Lint | Oxlint |
| Tests | Vitest 3 + jsdom |

---

## Module Breakdown

### `src/data/roadNetwork.ts`
Fetches real Bangalore road data from the OSM Overpass API. For radii > 10km it tiles 4 sub-queries to stay within the API timeout limit. Builds a `RoadGraph` (nodes, edges, adjacency list) and auto-places `TrafficSignal` objects at intersections with ≥3 connections. Falls back to a synthetic 8×8 grid if the API is unreachable.

### `src/engine/TrafficEngine.ts`
The main orchestrator. On each `update(dt)`:
1. Advances the simulation clock (`timeOfDay.ts`)
2. Adjusts `maxVehicles` to the time-of-day volume multiplier
3. Spawns vehicles via `vehicleSim.ts`
4. Moves all vehicles (IDM physics)
5. Applies emergency vehicle priority (`emergencyPriority.ts`)
6. Runs adaptive signal control and green wave (`signalControl.ts`)
7. Detects congestion zones (`congestion.ts`)
8. Computes aggregate stats

### `src/engine/vehicleSim.ts`
Each vehicle follows the IDM acceleration model. Lead-vehicle detection searches for the nearest vehicle on the same edge within 100m in the forward hemisphere. Signal compliance stops vehicles at RED/YELLOW unless they are past 80% edge progress. BFS routing assigns a path on spawn.

### `src/engine/signalControl.ts`
`updateAdaptiveSignals` runs Webster's formula every tick using the directional vehicle density within 150m of each signal. `coordinateGreenWave` sorts signals along the dominant flow axis and computes offsets based on inter-signal distance / avg speed.

### `src/engine/pathfinding.ts`
A* with priority queue over all graph nodes. Cost function: `travel_time + signal_delay + congestion_penalty + turn_penalty`. Heuristic is the admissible haversine distance. Used by the User panel for route display and the Controller panel for cascade override selection.

### `src/engine/timeOfDay.ts`
Simulated clock advancing at 2 sim-minutes per real second (configurable). Classifies the current hour into one of 5 profiles (`early_morning`, `morning_rush`, `midday`, `evening_rush`, `night`) that control traffic volume, signal cycle length, driver compliance, and congestion sensitivity.

### `src/engine/emergencyPriority.ts`
Scans emergency-type vehicles each tick. Any within 200m of a signal forces that signal GREEN in the vehicle's bearing direction for 15 seconds, then restores adaptive timing.

### `src/engine/congestion.ts`
Iterates all graph nodes; if ≥5 vehicles are within ~55m of an intersection, it creates a `CongestionZone`. Level is computed as `min(1, count/15) × (1 − avgSpeed/60)`.

### `src/utils/physics.ts`
Stateless IDM math: `calculateAcceleration(v, s, dv, v0, T, a, b, s0)` and `getSafeDistance(v, T, s0)`.

### `src/utils/exportStats.ts`
Builds an `ExportPayload` snapshot (stats, zones, routes, clock) and triggers a browser download as JSON.

### `src/config/index.ts`
Single source of truth for all numeric constants. Referenced by the engine and panels — nothing is hardcoded in logic files.

### `src/context/AuthContext.tsx` + `src/context/useAuth.ts`
React context for role state (`user | supporter | controller`). Split into two files so the Fast Refresh boundary is respected: the context file exports only the `AuthProvider` component; `useAuth.ts` exports only the hook.

---

## Data Flow

```
Overpass API ──► roadNetwork.ts ──► TrafficEngine.init()
                                        │
                              RoadGraph + TrafficSignal[]
                                        │
requestAnimationFrame loop ◄────────────┘
    │
    ▼
TrafficEngine.update(dt)
    ├── tickClock()               → simTime, timeOfDay
    ├── spawnVehicles()           → volume × profile.multiplier
    ├── updateVehicle() × N       → IDM physics, BFS routes
    ├── applyEmergencyPriority()  → signal preemption
    ├── updateAdaptiveSignals()   → Webster's per signal
    ├── coordinateGreenWave()     → offset sync
    ├── detectCongestionZones()   → hotspot clustering
    └── computeStats()            → aggregate metrics
            │
            ▼
React state ──► MapView (roads, signals, vehicles, heatmap, HUD)
            └── Role panels (UserPanel / SupporterPanel / ControllerPanel)
```

---

## Testing

```bash
npm run test -- --run   # 25 tests across 4 suites
```

| Suite | Coverage |
|---|---|
| `utils/index.test.ts` | haversine, format helpers, clamp, random, id gen |
| `utils/physics.test.ts` | IDM acceleration, safe distance, edge cases |
| `engine/timeOfDay.test.ts` | hour classification, clock tick, time format, profiles |
| `utils/exportStats.test.ts` | payload structure, ISO date validity |

---

## Known Limitations

- OSM fetch for 40km radius may timeout on slow connections (fallback activates automatically)
- Vehicle routing uses BFS on spawn, not live A* replanning — congestion is not re-routed in real time
- Signal yellow phase is modelled in duration but not visually distinct on the map circle color from RED in all cases
- Firebase and Google Maps SDK are installed as dependencies but not yet wired up (feature flags in `config/index.ts`)
