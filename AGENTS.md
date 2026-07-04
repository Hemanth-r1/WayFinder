# WayFinder

Traffic simulation and adaptive signal control system for Bangalore, India.

## Commands

| Command | Notes |
|---------|-------|
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc -b && vite build` — both must pass |
| `npm run lint` | Uses **oxlint** (not ESLint) |
| `npm run preview` | Vite preview |

No test framework exists. Do not attempt to run tests.

## TypeScript quirks

- `verbatimModuleSyntax: true` — always use `import type` for type-only imports
- `erasableSyntaxOnly: true` — no enums, no namespaces, no parameter properties
- `noUnusedLocals` / `noUnusedParameters` are errors
- `noEmit: true` — Vite handles transpilation
- `tsc -b` used in build (project references from root `tsconfig.json`)

## Architecture

```
src/
  engine/     Core simulation (TrafficEngine orchestrates signalControl, vehicleSim, congestion, pathfinding)
  components/ React UI (MapView, ControlPanel, NavigationPanel)
  data/       Road network loader — fetches live OSM data from Overpass API, falls back to synthetic grid
  config/     Firebase Firestore initialization (side-effect at import time)
  types/      All shared types and constants (physics tables, signal timing params)
  utils/      IDM car-following physics model
```

Entry: `src/main.tsx` → `src/App.tsx` → `src/engine/TrafficEngine.ts`

## Firebase

Config via `VITE_FIREBASE_*` env vars (see `.env.example`). Firestore is initialized at module import time in `src/config/firebase.ts`. The app may function without Firebase for local simulation.

## Runtime gotchas

- Road network fetches live from Overpass API (`overpass-api.de`) on first load — may fail or be slow. Falls back to a 10x10 synthetic grid centered on Bangalore (12.9716, 77.5946).
- Traffic simulation runs via `requestAnimationFrame` loop in `App.tsx` with a capped dt of 50ms.
- Manual signal override lasts 30 seconds, then resets all signals to adaptive mode.
- Inline styles throughout (no CSS modules, no Tailwind).
- Mini-map is a second Leaflet map instance drawing on `#mini-map`.
- Vehicle route-finding for spawn uses BFS, while the navigation panel uses A*.
