# WayFinder — Complete Project Documentation

## Overview

WayFinder is a traffic simulation and adaptive signal control system for Bangalore, India. It fetches real road data from OpenStreetMap (Overpass API), simulates vehicle movement using the Intelligent Driver Model (IDM), and controls traffic signals adaptively based on real-time vehicle volumes.

**Live URL:** https://project-7d0d26b8-5887-43f6-804.web.app  
**Project ID:** `project-7d0d26b8-5887-43f6-804`  
**Hosting:** Firebase Hosting (`dist/` directory)  
**Auth:** Firebase Authentication (Email/Password)  
**Database:** Firestore (auth rules, overrides, road cache)

---

## Architecture

```
src/
  engine/               Core simulation
    TrafficEngine.ts      — Orchestrator: init, update loop, vehicle spawning, signal coordination
    signalControl.ts      — Adaptive signal timing (Webster's formula), multi-directional green wave
    vehicleSim.ts         — IDM physics, edge walking, lane assignment, signal checks (axis-matched)
    pathfinding.ts        — A* routing with signal delay estimation
    congestion.ts         — Congestion zone detection, stats computation
    emergencyPriority.ts  — Emergency vehicle signal preemption
    optimizer.ts          — Network-wide signal plan optimizer
    timeOfDay.ts          — Simulation clock with time-of-day profiles (early_morning, morning_rush, midday, evening_rush, night)

  data/                 Data pipeline
    roadNetwork.ts        — OSM fetch (4×4 grid), graph builder, fallback synthetic grid
    graphCache.ts         — IndexedDB + localStorage cache (unified async interface)
    indexedDBCache.ts     — IndexedDB open/get/put/delete wrapper
    firebaseCache.ts      — Firestore cache for raw OSM data (chunked, 600KB per doc)
    signalStore.ts        — Signal position export to JSON / import from signals.json

  components/           React UI
    MapView.tsx           — Leaflet map: roads, signal circles (LOD), vehicles, context menu
    NavigationPanel.tsx   — Origin/dest selection, route info, Start Navigation
    MapContextMenu.tsx     — Right-click: Set Origin/Dest, Spawn, Add Signal
    ControlPanel.tsx      — Pause, heatmap, speed controls
    RoleSelector.tsx       — Role badge + promotion dropdown
    LoadingSpinner.tsx     — Loading overlay component
    Toast.tsx             — Toast notification container
    ErrorBoundary.tsx     — React error boundary

  types/
    index.ts              — All shared types and constants (Vehicle, RoadGraph, TrafficSignal, SIGNAL_TIMING, etc.)

  config/
    firebase.ts           — Firebase init (side-effect import)
    index.ts              — ROAD_CONFIG, SIGNAL_CONFIG, SIMULATION_CONFIG

  roles/
    UserPanel.tsx          — End-user navigation panel
    SupporterPanel.tsx     — Signal management panel
    ControllerPanel.tsx    — Controller dashboard: overrides, exports, signal list

  context/
    AuthContext.tsx        — Firebase Auth + role management, promoteRole()
    useAuth.ts             — Auth context consumer hook

  utils/
    physics.ts            — IDM physics helpers
    geo.ts                — Haversine, bearing helpers
    exportStats.ts        — Stats JSON export

  App.tsx                 — Main wiring: engine lifecycle, keyboard shortcuts, layout
  main.tsx                — Entry point
```

---

## Data Pipeline

### Loading Order (Fast → Slow)

1. **IndexedDB cache** (`graphCache.ts` → `indexedDBCache.ts`) — Full processed graph. ~10ms load. 7-day TTL.
2. **Firebase cache** (`firebaseCache.ts`) — Raw OSM nodes/ways stored in Firestore. ~500ms load. Falls back to Overpass if empty.
3. **Overpass API** (`roadNetwork.ts`) — 4×4 grid fetch (16 tiles, 3s delay each). ~120s worst case. Saves to IndexedDB + Firebase after success.
4. **signals.json** — Pre-exported signal positions. Instant load, no road data.
5. **Synthetic grid** — 10×10 fallback with Bangalore street names. No network required.

### OSM Fetch Strategy

- 4×4 bbox grid covering 40km radius around Bangalore (12.9716, 77.5946)
- Center 4 tiles: all road types (motorway, trunk, primary, secondary, tertiary, residential, unclassified)
- Outer 12 tiles: major roads only (motorway, trunk, primary, secondary, tertiary)
- 3-second delay between tiles to avoid Overpass rate limiting
- Ramer-Douglas-Peucker simplification (ε=5m) on intermediate geometry

### Graph Building

- Intersection nodes created at OSM nodes with ≥2 ways
- Full geometry preserved on every edge (simplified)
- One-way streets respected (no reverse edge created)
- Signals placed only at major-road intersections (≥3 edges, at least one major road type)
- 4-phase cycle: NS_GREEN, NS_YELLOW, EW_GREEN, EW_YELLOW

---

## Signal System

### Phase Structure (Collision Avoidance)

| Index | Group | Color | Duration | Description |
|-------|-------|-------|----------|-------------|
| 0 | NS | GREEN | 8–45s (adaptive) | North-South traffic flows |
| 1 | NS | YELLOW | 5s (FIXED) | NS clearing interval |
| 2 | EW | GREEN | 8–45s (adaptive) | East-West traffic flows |
| 3 | EW | YELLOW | 5s (FIXED) | EW clearing interval |

### Vehicle Signal Logic

- Vehicle bearing → axis group: bearing 315-45 or 135-225 = NS, else EW
- GREEN + matching group → proceed
- GREEN + wrong group → STOP
- YELLOW + matching group + past stop line (>0.85) → proceed (clear intersection)
- YELLOW + matching group + before stop line → STOP
- RED → STOP (unless past stop line)

### Adaptive Timing (Webster's Formula)

- Per-approach vehicle counting within 200m detection radius
- Edge-to-bearing mapping for accurate direction detection
- Green split proportional to per-direction vehicle counts
- Cycle length: `(1.5 × lostTime + 5) / (1 - criticalFlowRatio)`
- Min green: 8s, max green: 45s per phase
- Yellow: fixed 5s (not adjustable)

### Multi-Directional Green Wave

- For each signal: find upstream signals in ALL directions (within 2km)
- Compute ideal offset: `(upstreamOffset + distance / avgSpeed) % cycleLength`
- Weight by upstream signal's volume in same direction
- Set offset to weighted average of arrival times
- Top 2 busiest directions coordinated independently

---

## Vehicle Simulation

### IDM Car-Following Model

- Acceleration: `a × (1 - (v/v₀)⁴)` when no lead vehicle
- Safe distance: `s₀ + vT + vΔv / (2√(a×b))`
- Deceleration when following too closely
- Per-vehicle aggression multiplier (0.7–1.1)

### Navigation Vehicle

- User picks origin/dest via right-click context menu
- A* routing with signal delay, turn penalty, congestion weight
- "Start Navigation" button spawns a blue-highlighted sedan
- Vehicle follows route, respects all signals and physics
- Auto-removed on destination arrival

### Spawning

- Random vehicles spawn at edge nodes (degree 1-2)
- Destination is another edge node at distance 0.003-0.05 degrees
- Types: sedan, suv, hatchback, bus, truck, bike, auto, van, emergency
- Rate adapts to time-of-day profile

---

## User Roles

| Role | Capabilities |
|------|-------------|
| user | Navigation (set origin/dest, compute route, spawn nav vehicle) |
| supporter | All user features + Add signals at nodes |
| controller | All supporter features + Signal overrides, export signals/stats, run optimizer, refresh road data |

### Role Promotion

First signup → `role: "user"`. To promote, update Firestore:
`users/{uid}` → set `role: "supporter"` or `role: "controller"`

### Firestore Collections

| Collection | Access | Description |
|-----------|--------|-------------|
| `users/{uid}` | Own user only | Profile and role |
| `routes/{routeId}` | Own user only | Submitted navigation routes |
| `signals/{signalId}` | All read, supporters+ write | Community-added signals |
| `overrides/{overrideId}` | All read, controllers write | Active signal overrides |
| `roadCache/{docId}` | All read, write on fetch | Cached OSM road data (chunks) |

---

## Caching Strategy

### Local (Browser)

| Cache | Store | Threshold | TTL |
|-------|-------|-----------|-----|
| IndexedDB | Processed graph (Map → Array serialized) | ≥10k nodes | 7 days |
| localStorage | Processed graph | <10k nodes | 24 hours |
| signals.json | Pre-exported signal positions | Always | Static |

### Remote (Firebase)

| Cache | Format | Chunk Size | TTL |
|-------|--------|-----------|-----|
| `roadCache/meta_*` | Manifest (counts, timestamp) | <1KB | 7 days |
| `roadCache/chunk_*` | Raw OSM nodes + ways (compact arrays) | ~600KB each | 7 days |

### Check Order

1. IndexedDB (fastest, full graph ready)
2. Firebase (raw OSM → build graph)
3. Overpass API (fetch OSM → build graph → save to IndexedDB + Firebase)
4. signals.json (fallback — signal markers only)
5. Synthetic grid (fallback — no real data)

---

## Commands

| Command | Notes |
|---------|-------|
| `npm run dev` | Vite dev server (port 5173) |
| `npm run build` | `tsc -b && vite build` |
| `npm run lint` | oxlint (not ESLint) |
| `npm run preview` | Vite preview of dist/ |
| `firebase deploy --only hosting` | Deploy to WayFinder project |
| `graphify . --update` | Update codebase knowledge graph |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space/P | Pause/resume simulation |
| S | Spawn random vehicle |
| E | Spawn emergency vehicle |
| H | Toggle congestion heatmap |
| 1-4 | Set speed (0.5×, 1×, 2×, 4×) |
| Esc | Cancel manual override |
| ? | Toggle hotkeys reference |

---

## Deployment

**Project:** `project-7d0d26b8-5887-43f6-804`  
**Firebase alias:** `wayfinder`  
**Hosting URL:** https://project-7d0d26b8-5887-43f6-804.web.app

```bash
# Build
npm run build

# Deploy to WayFinder (uses active project)
firebase deploy --only hosting

# Or specify project explicitly
firebase deploy --only hosting --project project-7d0d26b8-5887-43f6-804
```

### Firestore Rules

Deploy rules when changed:
```bash
firebase deploy --only firestore:rules
```

---

## Dependencies

| Package | Purpose |
|---------|---------|
| React 18 | UI framework |
| Leaflet + react-leaflet | Map rendering |
| Firebase | Auth, Firestore, Hosting |
| TypeScript | Type safety |
| Vite | Build tool |
| oxlint | Linter |

---

## Future Features

See [docs/REQUIREMENTS.md](./REQUIREMENTS.md) section 9 for detailed specs on:
- Lane-changing behavior
- Dynamic rerouting
- Incidents & road closures
- Pedestrian crossings
- Bus lanes & public transport
- UI/UX improvements (signal dashboard, search, mobile responsive, hotkeys panel)
