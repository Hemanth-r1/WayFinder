# Fix: OSM Road Loading, Vehicle Rendering, and Role Promotion

## Problem

Three issues in the deployed WayFinder app:

1. **OSM HTTP 504** — Overpass API returns Gateway Timeout when fetching roads. Root cause: `RADIUS=40000` (40km) overwhelms the API. The original working commit (3ed314e) used `RADIUS=2000` (2km).

2. **Vehicles not rendering** — `setEngineState` in `App.tsx` skips state updates when `vehicleCount`, `avgSpeed`, `signalCount`, and `nodeCount` are all unchanged. If 20 vehicles all hold steady speed, avgSpeed stabilizes, updates stop, and `vehicleVersion` stops incrementing — MapView never re-renders markers.

3. **No role promotion UI** — AuthContext creates all users with `role: "user"`. Promoting requires manual Firestore console editing. No in-app mechanism exists.

## Solution

### 1. OSM Road Loading — 4×4 Bbox Grid

Replace the current single-query-with-fallback with a **4×4 grid of Overpass bbox queries** covering the full 40km radius:

- Compute bounding box for 40km radius centered on Bangalore (12.9716, 77.5946)
- Split into 4×4 = 16 tiles, each ~10km × 10km
- Each tile uses `[bbox:south,north,west,east]` filter (faster than `around:radius`)
- Fetch **all road types** in each tile: `motorway|trunk|primary|secondary|tertiary|residential|unclassified`
- Queries run sequentially (avoids rate limiting)
- Results merged into single `{nodes, ways}` set (deduped by OSM node/way ID)
- Same graph builder with full geometry polylines, RDP simplification, one-way detection
- Cached in localStorage via existing `graphCache.ts` (24h TTL)
- Fallback to stale cache if any sub-query fails, then to synthetic grid

**Key code change**: Replace `fetchOSMChunk` / `fetchOSMRoads` with `fetchOSMGrid(centerLat, centerLng, radius, gridSize=4)`.

### 2. Vehicle Rendering — Frame Counter

Add a `tick: number` field to the `engineState` object that increments every update cycle. This ensures React detects state changes even when vehicle count / avgSpeed / signal count are stable.

Change the skip condition in `App.tsx` to always return `next` (the frame counter guarantee already provides the update signal, or simply don't skip at all — the tick is cheap).

### 3. Role Promotion UI

Add a small settings panel accessible from the `RoleSelector` dropdown (or as a collapsible section in the sidebar) that lets authenticated users promote themselves:

- **User sees**: "Your role: user. Want to become a supporter?" with a button
- **Supporter sees**: "Your role: supporter. Request controller promotion?"
- **Controller sees**: "Your role: controller"
- Writes to Firestore `users/{uid}` → sets `role: "supporter"` or `role: "controller"`
- Simple button + confirmation dialog (no admin approval gate for v1)

## Files Changed

| File | Change |
|------|--------|
| `src/data/roadNetwork.ts` | Replace `fetchOSMChunk`/`fetchOSMRoads` with grid-based `fetchOSMGrid` using bbox tiling |
| `src/App.tsx` | Add `tick` counter to `engineState`, remove/simplify skip condition |
| `src/components/RoleSelector.tsx` | Add promotion UI section |
| `src/context/AuthContext.tsx` | Add `setRole` function to update Firestore |

## Success Criteria

- App loads OSM roads for 40km radius around Bangalore without 504 errors
- Roads rendered as polylines on the map (not synthetic grid)
- Vehicles visible and moving on the map
- User can promote their role from the UI
- `npm run build` passes (tsc + vite)
