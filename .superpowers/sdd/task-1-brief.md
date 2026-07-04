# Task 1: Extract shared geo utility

**Files:**
- Create: `src/utils/geo.ts`
- Modify: `src/engine/congestion.ts`, `src/engine/signalControl.ts`, `src/engine/vehicleSim.ts`

## Requirements

1. Create `src/utils/geo.ts` with:
   - `haversineMeters(lat1, lng1, lat2, lng2): number` — compute distance in meters between two lat/lng points using the Haversine formula (Earth radius = 6371000m)
   - `bearingBetween(lat1, lng1, lat2, lng2): number` — compute bearing in degrees (0-360) between two points

2. In `src/engine/congestion.ts`:
   - Add `import { haversineMeters } from '../utils/geo';`
   - Remove the local `haversineMeters` function (lines 5-10)
   - Remove the unused `EARTH_RADIUS_M` constant (line 3)

3. In `src/engine/signalControl.ts`:
   - Add `import { haversineMeters } from '../utils/geo';`
   - Remove the local `haversineMeters` function (lines 6-11)
   - Remove the unused `EARTH_RADIUS_M` constant (line 4)

4. In `src/engine/vehicleSim.ts`:
   - Add `import { haversineMeters } from '../utils/geo';`
   - Remove the local `haversineMeters` function (lines 164-170)

5. Run `npm run build` and `npm run lint` — both must pass
