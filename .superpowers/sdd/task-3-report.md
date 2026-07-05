# Task 3: Server Graph Service — Report

**Status:** DONE

## Files Created/Modified

| File | Action | Description |
|------|--------|-------------|
| `server/src/roadNetwork.ts` | Created | Full port of client `src/data/roadNetwork.ts` with all geometry helpers, OSM fetching (2×2 grid), graph building, and synthetic grid fallback |
| `server/src/graphService.ts` | Created | Cache wrapper — lazy-loads on first request, caches forever |
| `server/src/index.ts` | Modified | Added `GET /api/graph` route |
| `server/src/types.ts` | Modified | Added `approaches` field to `TrafficSignal` (required by graph building) |

## Port Details

- **Ported as-is:** `bearingFromDeg`, `haversineMeters`, `polylineLength`, `rdp`, `perpendicularDist`, `speedForHighway`, `lanesForHighway`, `roadTypeFromHighway`, `isOneway`, `isReverseOneway`, `deriveApproaches`, `createPhase`, `sleep`, `fetchOSMBbox`, `fetchOSMRoads`, `buildGraphFromOSM`, synthetic grid fallback
- **Removed (client-only):** `loadBangaloreNetwork`, `LoadPhase`, `LoadUpdate`, `tryLoadSignalPoints`, `findNearestNode`, `getEdgeNodes`, all cache imports (`graphCache`, `firebaseCache`, `signalStore`, `../config`, `../types`)
- **Type adaptations:** `RoadType` → `string`, `GeoPoint` → inline `{ lat, lng }`, `Direction` → `string`, `SignalApproach` → inline, `OSMNode`/`OSMWay`/`OSMResponse` remain inline interfaces
- **Map→Array conversion:** `buildSyntheticGrid` and `fetchFromOverpass` both call `toSerializable()` before returning

## Verification

```
cd server && npx tsc --noEmit
```

Result: No errors (clean compilation).

## Commits

- `0af7891` — `feat(server): graph building from Overpass with caching`
- `8d3ae9b` — `feat(server): add serializable shared types` (prior commit, base)

## Architecture

```
GET /api/graph
  → graphService.getGraph()
    → cache hit? return cached
    → cache miss? import roadNetwork.buildBangaloreNetwork()
      → try fetchFromOverpass() [Overpass API, 2×2 grid, 4 tiles]
        → fetchOSMRoads() → fetchOSMBbox() x4 (1s delay between)
        → buildGraphFromOSM() → toSerializable()
      → fallback buildSyntheticGrid() [8×8 synthetic grid]
        → toSerializable()
```

## Concerns

- `TrafficSignal.approaches` was added to server types (was missing from scaffold) — required because both OSM and synthetic grid paths create signals with approaches
- Server `RoadEdge` does not include `congestionWeight` or `oneway` fields present in client — these were omitted as they don't exist in the server type
- The report file is at `.superpowers/sdd/task-3-report.md`
