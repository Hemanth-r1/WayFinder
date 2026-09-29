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
- Users can only *request* a role (the app writes `requestedRole`); `firestore.rules` forbid changing your own `role`
- To promote a user, an admin updates their Firestore document (console or Admin SDK):
  `users/{uid}` → set `role: "supporter"` or `role: "controller"`
- Role changes take effect on next page load (the server caches roles for 5 min)
- Demo mode (no Firebase): the role badge switches role locally so every panel can be tried

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
- Driver UI (`role === 'user'`): search box (`src/utils/places.ts` — road names from the loaded graph, plus OSM Nominatim for addresses, limited to Bangalore), GPS "My location", and an "Open in Google Maps" hand-off that passes 3 waypoints along the user's route. Operator overlays (stats HUD, legend, mini-map, floating nav panel) are hidden for drivers. Phones (≤768px, `useIsMobile`) get a bottom-sheet layout.
- Demo mode (no Firebase config) gives each browser its own `demo-…` user ID so route spreading can be tried with several tabs/devices.
- Traffic = simulated vehicles + navigating users. Simulated count follows the traffic level (light 60 / normal 150 / heavy 350); half of new simulated vehicles spawn on and keep to routes real users are driving, so users meet the traffic. On phones with location, the user's vehicle moves from GPS (`POST /api/user/:id/position`, map-matched to the route); desktops get a simulated drive.
- City-wide conditions (`server/src/conditionsService.ts`): live Bangalore rain from Open-Meteo (polled every 10 min) and the simulated traffic level; operators override them via `POST /api/conditions/weather` / `traffic`. Rain lowers speeds and capacity in simulation and ETAs.
- Crowd reports (`server/src/reportsService.ts`): drivers report 🚧 blocks (road segment, both directions), 🌊 waterlogging (150 m) and 🌧 heavy rain (1.5 km) via `POST /api/reports`. Unconfirmed reports only make roads costlier (block ×3); a report is confirmed by a 2nd person, a supporter/controller, or GPS showing a real driver stuck near it for 45 s — confirmed blocks are never routed. Reports clear on 2 "it's clear" votes (outnumbering confirmations), 2 real drivers passing through at speed, an operator, or expiry (45 min unconfirmed). Votes: `POST /api/reports/:id/vote`; drivers are prompted about reports within 1.5 km ahead.
- Server auth (`server/src/auth.ts`): with Firebase Admin configured, requests carry a Firebase ID token and roles come from Firestore; in demo mode `X-Demo-User`/`X-Demo-Role` headers are trusted. User endpoints require the caller to be that user; weather/traffic need supporter/controller; reports (6/10 min) and votes (30/10 min) are rate-limited in memory.
- Live traffic in routing = simulated congestion (BPR) + speeds measured from real drivers' GPS (last 3 min). Navigation updates carry a `reroute` offer when a block is ahead or a route saves ≥60 s and ≥10%; `POST /api/user/:id/reroute` accepts it. Leaving the route (2 GPS fixes >50 m off) reroutes automatically.
- Production: the client uses same-origin `/api` (Firebase Hosting rewrites to Cloud Run). Hosting doesn't carry WebSockets, so the client falls back to polling `GET /api/state`.
- The server listens on 8080 (matches Vite proxy, client default and Dockerfile); `CORS_ORIGIN` controls the allowed browser origin.
