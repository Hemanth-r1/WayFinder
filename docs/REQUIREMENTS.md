# WayFinder — Requirements & Implementation

## 0. Collision Avoidance — Signal Phase Safety (REQ-CA)

### Problem
Yellow light was invisible (color stayed GREEN during the yellow clearance interval). Vehicles approaching from conflicting directions could enter the intersection simultaneously. Yellow duration was 3s instead of mandated 5s.

### Phase Design
Each signal cycles through 4 phases:

| # | Group | Color | Duration | Yellow | Description |
|---|-------|-------|----------|--------|-------------|
| 0 | NS | GREEN | Adaptive (8–45s) | 5s fixed | North-South flows |
| 1 | NS | YELLOW | 5s fixed | 0s | NS clearing interval |
| 2 | EW | GREEN | Adaptive (8–45s) | 5s fixed | East-West flows |
| 3 | EW | YELLOW | 5s fixed | 0s | EW clearing interval |

### Vehicle Signal Logic
- Vehicle bearing → group (`'NS'` if moving N/S, `'EW'` if moving E/W)
- `checkCanProceed`: vehicle stops if phase group doesn't match its travel axis, OR if phase is YELLOW and not past stop line (edgeProgress > 0.85), OR if phase is RED
- Vehicles already past the stop line always clear the intersection

### Type Changes
- `SignalPhase.direction: Direction` → `SignalPhase.group: 'NS' | 'EW'`
- `SIGNAL_TIMING.yellowDuration: 3` → `5`

### Implementation
- `src/types/index.ts` — `SignalPhase.group`, `yellowDuration: 5`
- `src/data/roadNetwork.ts` — `createPhase()` produces 4-phase cycle
- `src/engine/signalControl.ts` — adaptive timing skips YELLOW phases, adjusts GREEN only
- `src/engine/vehicleSim.ts` — `bearingToGroup()`, axis-matched `checkCanProceed()`
- `src/engine/TrafficEngine.ts` — `manualOverrideSignal()` uses `phase.group`
- `src/engine/emergencyPriority.ts` — converted to `phase.group`
- `src/engine/optimizer.ts` — converted to `phase.group`

---

## 1. Persistent OSM Cache (IndexedDB) (REQ-PC)

### Problem
OSM road data (188k nodes, 374k edges) exceeds localStorage's ~5MB limit. Every page load re-fetches from Overpass, hitting rate limits (429) and timeouts (504).

### Solution
Two-tier caching:
- **IndexedDB** (`WayFinderCache.roadGraph`): For large graphs (≥10k nodes). 7-day TTL. Key: `graph_v2_{lat}_{lng}_{radius}`.
- **localStorage**: For small graphs (<10k nodes). 24-hour TTL. Same key format.

### Cache Check Order
1. IndexedDB → if found and not expired → restore graph
2. localStorage → if found and not expired → restore graph
3. OSM fetch → on success, cache to IndexedDB or localStorage

### Files
- `src/data/indexedDBCache.ts` — open/get/put/delete wrapper
- `src/data/graphCache.ts` — unified `loadGraphFromCache()` / `saveGraphToCache()` (both async)

---

## 2. Navigation Vehicle (Click-to-Drive) (REQ-NV)

### Problem
Users could set source/destination on the map but no vehicle actually drove the route.

### Solution
- Right-click node → "Set Origin" / "Set Destination" (via `MapContextMenu`)
- `NavigationPanel` shows route info (segments, distance, ETA, road names) and "Start Navigation" button
- `spawnNavigatedVehicle(sourceId, destId)` — uses A* → creates a `sedan` with `isNavigated: true` and blue highlight
- Navigated vehicle respects all traffic signals and car-following physics
- On destination arrival, vehicle is removed automatically
- Map renders navigated vehicle with blue glow (`box-shadow`)

### Files
- `src/engine/vehicleSim.ts` — `spawnNavigatedVehicle()`
- `src/engine/TrafficEngine.ts` — `spawnNavigatedVehicle()`, `computeRoute()`
- `src/components/NavigationPanel.tsx` — full nav UI with route info
- `src/components/MapView.tsx` — blue glow for `isNavigated` vehicles

### Vehicle Type
```typescript
export interface Vehicle {
  ...
  isNavigated?: boolean;  // spawned by user navigation request
}
```

---

## 3. Volume-Adaptive Signals (REQ-VA)

### Implementation
- Per-approach vehicle counting via `getDirectionalDensity()`:
  - Collects edge bearings for all edges heading TOWARD the signal node
  - Counts vehicles within 200m detection radius
  - Maps each vehicle's approach bearing to N/S/E/W cardinal direction
- Green split computed from direction-specific vehicle counts:
  - NS vs EW ratio determines green time allocation
  - Within each group, proportional to sub-direction volumes
- Webster's optimal cycle length formula
- Min green: 8s, Max green: 45s per phase
- Yellow: fixed 5s (not adjustable by adaptive timing)

### Files
- `src/engine/signalControl.ts` — `updateAdaptiveSignals()`

---

## 4. Multi-Directional Green Wave (REQ-GW)

### Algorithm
1. For each signal, compute per-direction vehicle counts
2. For each signal, sort directions by traffic volume (descending)
3. Coordinate top 2 directions independently:
   - Find upstream signals in each direction (within 2km)
   - Compute travel-time-based ideal offset: `(upstreamOffset + distance / avgSpeed) % cycleLength`
   - Weight by upstream signal's volume in same direction
   - Set signal offset to weighted average of arrival times
4. Each signal's `greenWaveDirection` tracks which direction is coordinated

### Benefits
- Reduces stops for vehicles in ALL flow directions
- Smoother traffic through fewer red-light arrivals
- No hardcoded "dominant direction" — adapts to actual traffic patterns

### Files
- `src/engine/signalControl.ts` — `coordinateGreenWave()`

---

## 5. Signal Circles & Zoom LOD (REQ-SC)

### Signal Rendering
- Pure colored circles (no text labels): GREEN=#00E676, YELLOW=#FFD600, RED=#FF1744
- Click opens popup with: signal ID, phase color/group, timer, cycle length, congestion %, edge count, green wave direction

### Level-of-Detail
| Zoom Level | Min Edge Count |
|-----------|----------------|
| ≤13 | 4 (major intersections only) |
| 14–15 | 3 |
| ≥16 | 2 (all signals visible) |

### Files
- `src/components/MapView.tsx` — signal rendering with LOD filter, popup details

---

## 6. OSM Grid Fetching (REQ-OSM)

### Strategy
- 4×4 grid of bbox-based tiles (~10km each) covering 40km radius around Bangalore center (12.9716, 77.5946)
- Center 4 tiles: all road types (motorway through residential)
- Outer 12 tiles: major roads only (motorway, trunk, primary, secondary, tertiary)
- 3s delay between tile requests to avoid Overpass rate limiting
- Fallback: 10×10 synthetic grid with Bangalore street names

### Files
- `src/data/roadNetwork.ts` — `fetchOSMBbox()`, `fetchOSMRoads()`, `buildGraphFromOSM()`

---

## 7. User Roles & Signal Export (REQ-UR)

### Flow
- Three roles: `user` (basic), `supporter` (add signals), `controller` (override signals)
- First signup → `role: "user"`. Promote via Firestore: `users/{uid} → role: "supporter"|"controller"`
- `signals.json` export: Controller panel "Export Signals" button creates downloadable JSON of all signal positions
- `signals.json` import: On OSM fetch failure, loads pre-exported signal positions as fallback

### Files
- `src/context/AuthContext.tsx` — `promoteRole()`
- `src/components/RoleSelector.tsx` — badge + promotion dropdown
- `src/data/signalStore.ts` — export/import signal positions
- `src/roles/ControllerPanel.tsx` — export button
- `public/signals.json` — pre-exported signal positions

---

## 8. Architecture Reference

### File Map
```
src/
  engine/
    TrafficEngine.ts      — Orchestrator: init, update loop, vehicle spawning, signal coordination
    signalControl.ts      — Adaptive signal timing, multi-directional green wave
    vehicleSim.ts         — IDM physics, edge walking, lane assignment, signal checks
    pathfinding.ts        — A* routing with signal delay estimation
    congestion.ts         — Congestion zone detection, stats computation
    emergencyPriority.ts  — Emergency vehicle signal preemption
    optimizer.ts          — Network-wide signal plan optimizer
    timeOfDay.ts          — Simulation clock with time-of-day profiles
  data/
    roadNetwork.ts        — OSM fetch, graph builder, fallback grid
    graphCache.ts         — IndexedDB + localStorage cache
    indexedDBCache.ts     — IndexedDB wrapper
    signalStore.ts        — Signal position export/import
  components/
    MapView.tsx           — Leaflet map: roads, signals (circles), vehicles, navigation, context menu
    NavigationPanel.tsx   — Origin/dest selection, route info, Start Navigation button
    MapContextMenu.tsx     — Right-click menu: Set Origin/Dest, Spawn, Add Signal
    ControlPanel.tsx      — Simulation controls
    RoleSelector.tsx       — Role badge + promotion UI
  types/
    index.ts              — All shared types and constants
  App.tsx                 — Main app wiring, engine lifecycle, keyboard shortcuts
```

---

## 9. Future Features (Brainstormed)

### 9a. Lane-Changing
- Vehicles evaluate adjacent lane availability every frame
- If lead vehicle is significantly slower (>10 km/h delta) and adjacent lane is clear (no vehicle within safe distance), gradually shift lanes over ~2s
- `desiredLane` based on upcoming turn: left lane for left turn, right lane for right turn, middle for straight

### 9b. Dynamic Rerouting
- Periodically (every 30-60s), check if each vehicle's speed is <20% of expected
- If slow, recompute A* route from current position using updated congestion weights
- Uses existing `stuckTime` / `rerouted` mechanism but with proactive trigger

### 9c. Incidents & Road Closures
- Controller-placed incidents via context menu or panel
- `Incident` type: `{ id, nodeId?, edgeId?, type, severity, timer, lanesBlocked }`
- Reduces effective lane count, multiplies congestion weight, drops speed limit
- Auto-reroute approaching vehicles
- Auto-clear after configurable timer

### 9d. Pedestrian Crossings
- Crosswalks at signalized intersections (white-striped polylines)
- Pedestrian "walk" interval (5-10s) where all vehicle traffic is red
- Pedestrians accumulate at rate based on road type (higher on commercial/primary)
- If pedestrians waiting and parallel vehicular phase has been green >30s, trigger walk interval

### 9e. Bus Lanes & Public Transport
- Dedicated bus routes with bus stops
- Buses follow fixed routes and stop at designated nodes for ~10s
- Preferential signal timing for buses when detected

### 9f. UI/UX Improvements
- **Loading progress**: Tile-by-tile progress bar during OSM fetch
- **Signal dashboard**: Scrollable list of all signals sorted/filtered by ID, congestion, phase
- **Search**: Search roads by name, signals by ID
- **Mobile responsive**: Sidebar collapses to thin strip on <768px
- **Hotkeys panel**: `?` toggles hotkey reference overlay
- **Speed presets**: 0.5×, 1×, 2×, 4×, 8× buttons
