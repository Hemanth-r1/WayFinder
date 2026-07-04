# Task 2 Report

**Status:** DONE

**Commits:**
- `02bdccb` Fix TrafficEngine bugs: spawnVehicleFromDirection uses direction param, manualOverrideSignal scoped to target signal

**Changes:**
1. `src/engine/TrafficEngine.ts:157` — Replaced `spawnVehicleFromDirection` body: now filters edge nodes by bearing matching the given direction (N/S/E/W), picks a random matching node, and spawns a vehicle there. Removed underscore prefix from `_direction` param. Added missing `this.signals` 4th arg to `spawnVehicleAt` call (brief's snippet was missing it — function expects 4 params).
2. `src/engine/TrafficEngine.ts:204` — Replaced `manualOverrideSignal` body: now only sets `adaptiveTiming = false` on the target signal (was setting it on ALL signals). Only iterates the target signal's phases instead of all signals' phases.

**Build:** `npm run build` — passed (tsc + vite build)
**Lint:** `npm run lint` — passed (1 pre-existing warning in AuthContext.tsx, 0 errors)
