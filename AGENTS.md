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

Real authentication and data persistence via Firebase Auth + Firestore.

### Setup

1. Create a Firebase project at https://console.firebase.google.com
2. Enable **Authentication → Sign-in method → Email/Password**
3. Create a **Firestore Database** (start in test mode, then apply rules)
4. Copy `.env.example` → `.env` and fill in your Firebase project config values
5. Deploy Firestore security rules from `firestore.rules`:
   - Via Firebase Console → Firestore → Rules tab, or
   - Via Firebase CLI: `firebase deploy --only firestore:rules`

### Roles

- Users start with `role: "user"` on first sign-up
- To promote a user, update their Firestore document:
  `users/{uid}` → set `role: "supporter"` or `role: "controller"`
- Role changes take effect on next page load

### Firestore Collections

| Collection | Access | Description |
|-----------|--------|-------------|
| `users/{uid}` | Own user only | Profile and role |
| `routes/{routeId}` | Own user only | Submitted navigation routes (persistent) |
| `signals/{signalId}` | All authenticated users read, supporters+ write | Community-added traffic signals (real-time) |
| `overrides/{overrideId}` | All authenticated users read, controllers write | Active signal overrides (real-time) |

## Runtime gotchas

- Road network fetches live from Overpass API (`overpass-api.de`) on first load — may fail or be slow. Falls back to a 10x10 synthetic grid centered on Bangalore (12.9716, 77.5946).
- Traffic simulation runs via `requestAnimationFrame` loop in `App.tsx` with a capped dt of 50ms.
- Manual signal override lasts 30 seconds, then resets all signals to adaptive mode.
- Inline styles throughout (no CSS modules, no Tailwind).
- Mini-map is a second Leaflet map instance drawing on `#mini-map`.
- User navigation routing runs on the server (`server/src/pathfindingService.ts`): time-based A* with live edge congestion, signal delay, and a penalty per other navigator already routed over an edge, so users with similar trips are spread across nearby routes. `POST /api/route` returns up to 3 options; `POST /api/user/start` accepts the chosen `edgeIds`.
- The server listens on 8080 (matches Vite proxy, client default and Dockerfile); `CORS_ORIGIN` controls the allowed browser origin.
