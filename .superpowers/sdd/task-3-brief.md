# Task 3: Remove unused NYC constants

**Files:**
- Modify: `src/types/index.ts`

## Requirements

1. Delete `GRID_CENTER` and `GRID_BOUNDS` constants (lines 156-162) from `src/types/index.ts`. These point to NYC (~40.758, -73.986) but the app is centered on Bangalore (12.9716, 77.5946). They are unused in the actual simulation.

2. Run `npm run build` — must pass.

## Global Constraints
- `noUnusedLocals` / `noUnusedParameters` are errors
