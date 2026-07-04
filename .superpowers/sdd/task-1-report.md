# Task 1 Report: Extract shared geo utility

## Status: DONE

## Changes

| File | Action |
|------|--------|
| `src/utils/geo.ts` | Created — `haversineMeters` + `bearingBetween` exported |
| `src/engine/signalControl.ts` | Removed local `haversineMeters` (was duplicated), added `import { haversineMeters }` |
| `src/engine/vehicleSim.ts` | Removed local `haversineMeters` + `bearingBetween` (both duplicated), added `import { haversineMeters, bearingBetween }`, updated all call sites to use flat lat/lng params |
| `src/engine/congestion.ts` | Unchanged — did **not** have a duplicate of `haversineMeters` or any unused constant; the brief was based on an older file state |
| `src/components/MapView.tsx` | Fixed pre-existing TS error: cast `existing` to `any` for `_lastIconKey` access |
| `src/engine/TrafficEngine.ts` | Fixed pre-existing TS error: removed unused `adj` variable |

## Commit

`031655a` — Extract haversineMeters + bearingBetween to src/utils/geo.ts

## Verification

- `npm run build` ✅ (tsc -b + vite build, 0 errors)
- `npm run lint` ✅ (0 errors, 1 pre-existing warning about AuthContext)
