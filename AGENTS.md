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

- Road network: Greater Bangalore (bbox 12.80–13.20 N, 77.42–77.82 E), every drivable road (motorway … residential, living streets; no private/no-access) and real OSM traffic signals, from the bundled snapshot `server/data/bangalore-osm.json.gz` (~220k junctions, ~540k road segments). Node ids are `n` + OSM id (base 36) and junction ids `J` + OSM id of the main stop line — stable across refreshes. Server needs ~1.2 GB RAM (Cloud Run: 2 GiB, 2 CPU, exactly 1 instance, CPU always on — see deploy.yml). Refresh with `cd server && npm run build:osm` (Overpass; `-- --from <dir>` reads downloaded Overpass JSON) and commit the file. Without it the server tries live Overpass (mirrors, tiled), then a small synthetic grid. Overpass is often unreachable from Indian networks — `maps.mail.ru` mirror usually works.
- Graph builder (`server/src/osmGraph.ts`): nodes at junctions, way ends and signal stop lines; pass-through points where the same road continues are merged; lanes/one-way/roundabouts from tags; Bangalore free-flow speeds (primary 35, secondary 30, tertiary 25 km/h); largest strongly connected component only; known choke points (Silk Board, Hebbal, KR Puram, …) get reduced capacity. Signal stop lines within 60 m form one controller; approaches split into group A (along the main road) / B (cross road), cycles ~80–145 s, independent offsets.
- Inline styles throughout (no CSS modules, no Tailwind).
- Map: MapLibre GL on free OpenFreeMap vector tiles (no API key) — light style for drivers, dark for operators. WayFinder overlays are GeoJSON layers in `src/components/mapLayers.ts`: Google-style traffic colours per direction (main roads always, smaller roads when slow), signals coloured by the main road's light, vehicles as oriented top-down boxes per type (drawn to canvas), animated between server frames. URL keeps the view (`#zoom/lat/lng`).
- Browser graph (`/api/graph`): every road except residential/living streets (~85k segments, a few MB gzipped); the server keeps the full network for routing and simulation, and routes use residential lanes only within 1.5 km of the start or end.
- Junctions / police view (`server/src/junctionService.ts`, `src/roles/JunctionPanel.tsx`): every junction with ID, name (OSM name or "Road A × Road B"), approaches (group A/B), live queue (vehicles, metres), arrivals/h, links to neighbouring junctions (following each approach road upstream ≤1.5 km). Recommended timing by Webster's method (saturation 1800 PCU/h/lane, cycle 60–180 s), spillback and green-wave advice. Endpoints: `GET /api/junctions`, `GET /api/junctions/:id` (supporters/controllers); `POST /api/junctions/:id/hold {group, seconds, coordinate}`, `/plan {greens}|{recommended:true}`, `/reset` (controllers only, simulation only, logged to `GET /api/control/log` and Firestore `signalControlLog`). A coordinated hold opens a green wave at downstream junctions (after the travel time) and cuts upstream greens feeding the stopped approaches to 60%. Police apply real changes in their own signal system.
- Signal directions and timings: every junction's arms (`TrafficSignal.arms`, built in `junctionService.describeArms`) say where traffic comes from and goes ("Tumkur Road from the north-west (… 2.1 km) → towards Chord Road"), naming the next/previous signalised junction within 5 km. Tapping any signal (all roles) opens `SignalCard`: each arm's light, countdown, green/red per cycle (`src/utils/signalTiming.ts`) and "switch off your engine" for reds ≥ 30 s; navigation shows the same advice near a red. The police view estimates each approach's wait for the last queued car and flags > 5 min (`MAX_WAIT_S`); recommendations give enough green to clear queues within two cycles, and holds warn when cross roads would pass the limit.
- Driver behaviour in the simulation: per-driver temperament (gap, pickup, politeness), red-light jumping (bikes 12%, autos 8%, cars 3% of drivers, only seconds into red), short wrong-way stretches against one-ways (bikes, autos; drawn with a red ring, slow the real traffic), BMTC bus stops (~700 m, 15–35 s) and auto pick-ups at the kerb, two-wheelers weaving across lanes and creeping to the stop line. Road reports include 🌳 fallen tree (partial block; closes single-lane roads once confirmed).
- Offline: `public/sw.js` (production builds) serves map tiles/styles/fonts cache-first and the app + `/api/graph` network-first; "Download Bangalore for offline use" (`src/services/offlineMap.ts`) pre-caches all tiles z0–14 for the bbox (~50 MB). The road network is saved in IndexedDB (90 days) and used when the server is unreachable; routes are then planned on the device (`src/utils/offlineRoute.ts`, free-flow speeds, no live traffic).
- Live updates: clients send their viewport (`{type:'viewport', bbox, zoom}` over WebSocket, or `/api/state?bbox=w,s,e,n&zoom=z&traffic=1` when polling). Vehicles are sent only for zoom ≥ 13.5 inside the view (plus all navigating users), every 0.5 s; every signal's `[phaseIndex, timer]`; road traffic levels every 3 s. `/api/graph` is a compact, gzipped, cacheable format (reverse-direction geometry omitted). While a driver navigates, the camera follows their car (`user_<uid>`), rotated to its heading and tilted; dragging pauses it until "Re-center". Needs WebGL. Operators get a second MapLibre instance as mini-map.
- User navigation routing runs on the server (`server/src/pathfindingService.ts`): time-based A* with live edge congestion, signal delay, and a penalty per other navigator already routed over an edge, so users with similar trips are spread across nearby routes. `POST /api/route` returns up to 3 options; `POST /api/user/start` accepts the chosen `edgeIds`.
- Driver UI (`role === 'user'`): search box (`src/utils/places.ts` — road names from the loaded graph, plus OSM Nominatim for addresses, limited to Bangalore), GPS "My location", and an "Open in Google Maps" hand-off that passes 3 waypoints along the user's route. Operator overlays (stats HUD, legend, mini-map, floating nav panel) are hidden for drivers. Phones (≤768px, `useIsMobile`) get a bottom-sheet layout.
- Demo mode (no Firebase config) gives each browser its own `demo-…` user ID so route spreading can be tried with several tabs/devices.
- Simulation (`server/src/simulationEngine.ts`, 5 Hz): car following = IDM/ACC, lane changes = MOBIL (Treiber & Kesting, as on traffic-simulation.de; that project is GPL-3.0, so only its published models are used, no code). Bangalore mix: 46% bikes, 30% cars, 12% autos, 5% BMTC buses, trucks/vans; left-hand traffic (lane 0 = kerb, keep-left bias); red lights are stopped obstacles at the stop line; vehicles pick turn lanes before junctions. Up to 20,000 vehicles at peak, scaled by demand: 'auto' traffic mode follows the IST clock (peaks 8:30–11 and 17:30–21, lighter weekends); operators can pin light/normal/heavy. Each vehicle counts as 6 real ones (`DEMAND_SCALE`) in the road-load (BPR) model, smoothed over 30 s. Spawning favours arterials and the core. Navigating users count too; 30% of new vehicles spawn on users' routes. On phones with location, the user's vehicle moves from GPS (`POST /api/user/:id/position`, map-matched to the route); desktops get a simulated drive.
- City-wide conditions (`server/src/conditionsService.ts`): live Bangalore rain from Open-Meteo (polled every 10 min) and the simulated traffic level; operators override them via `POST /api/conditions/weather` / `traffic`. Rain lowers speeds and capacity in simulation and ETAs.
- Crowd reports (`server/src/reportsService.ts`): drivers report 🚧 blocks (road segment, both directions), 🌊 waterlogging (150 m) and 🌧 heavy rain (1.5 km) via `POST /api/reports`. Unconfirmed reports only make roads costlier (block ×3); a report is confirmed by a 2nd person, a supporter/controller, or GPS showing a real driver stuck near it for 45 s — confirmed blocks are never routed. Reports clear on 2 "it's clear" votes (outnumbering confirmations), 2 real drivers passing through at speed, an operator, or expiry (45 min unconfirmed). Votes: `POST /api/reports/:id/vote`; drivers are prompted about reports within 1.5 km ahead.
- Server auth (`server/src/auth.ts`): with Firebase Admin configured, requests carry a Firebase ID token and roles come from Firestore; in demo mode `X-Demo-User`/`X-Demo-Role` headers are trusted. User endpoints require the caller to be that user; weather/traffic need supporter/controller; reports (6/10 min) and votes (30/10 min) are rate-limited in memory.
- Live traffic in routing = simulated congestion (BPR) + speeds measured from real drivers' GPS (last 3 min). Navigation updates carry a `reroute` offer when a block is ahead or a route saves ≥60 s and ≥10%; `POST /api/user/:id/reroute` accepts it. Leaving the route (2 GPS fixes >50 m off) reroutes automatically.
- Production: the client uses same-origin `/api` (Firebase Hosting rewrites to Cloud Run). Hosting doesn't carry WebSockets, so the client falls back to polling `GET /api/state`.
- The server listens on 8080 (matches Vite proxy, client default and Dockerfile); `CORS_ORIGIN` controls the allowed browser origin.
