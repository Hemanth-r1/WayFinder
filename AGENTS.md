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
src/                Browser app (map, panels); the simulation runs on the server
  components/       React UI (MapView + mapLayers, SignalCard, ConditionsPanel, NavigationGuide, …)
  roles/            Panels per role (UserPanel, SupporterPanel, JunctionPanel)
  services/         serverClient (API + live updates), progressiveLoader, offlineMap
  data/             IndexedDB cache of the road network
  config/           Firebase initialisation
  types/  utils/    Shared types; places search, signal timing, offline routing
server/src/         Simulation, routing, junctions, reports (Express + ws)
```

Entry: `src/main.tsx` → `src/App.tsx`; server `server/src/index.ts`.

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

- Road network: Greater Bangalore (bbox 12.80–13.20 N, 77.42–77.82 E), every drivable road (motorway … residential, living streets, service/frontage roads; no private/no-access, no parking aisles or driveways) and real OSM traffic signals, from the bundled snapshot `server/data/bangalore-osm.json.gz` (~263k junctions, ~640k road segments). Service roads come from a separate Overpass query (`highway=service` without a `service=*` subtype) saved next to the main tiles before `build:osm -- --from <dir>`. Node ids are `n` + OSM id (base 36) and junction ids `J` + OSM id of the main stop line — stable across refreshes. Server needs ~1.2 GB RAM (Cloud Run: 2 GiB, 2 CPU, exactly 1 instance, CPU always on — see deploy.yml). Refresh with `cd server && npm run build:osm` (Overpass; `-- --from <dir>` reads downloaded Overpass JSON) and commit the file. Without it the server tries live Overpass (mirrors, tiled), then a small synthetic grid. Overpass is often unreachable from Indian networks — `maps.mail.ru` mirror usually works.
- Graph builder (`server/src/osmGraph.ts`): nodes at junctions, way ends and signal stop lines; pass-through points where the same road continues are merged; lanes/one-way/roundabouts from tags; Bangalore free-flow speeds (primary 35, secondary 30, tertiary 25 km/h); largest strongly connected component only; known choke points (Silk Board, Hebbal, KR Puram, …) get reduced capacity. Signal stop lines within 60 m form one controller; approaches split into group A (along the main road) / B (cross road), cycles ~80–145 s, independent offsets.
- Inline styles throughout (no CSS modules, no Tailwind).
- Map: MapLibre GL on free OpenFreeMap vector tiles (no API key) — light style for drivers, dark for operators. WayFinder overlays are GeoJSON layers in `src/components/mapLayers.ts`: Google-style traffic colours per direction on every road in the browser graph (minor roads thinner, from zoom 13), carriageways at real width with lane markings from zoom 16.5 (`markingsData`, built for the viewport: centre line solid on 4+ lane roads, broken lane lines, edge lines; 3.2 m lanes matching the simulation), signals coloured by the main road's light, vehicles as oriented top-down boxes per type (drawn to canvas), animated between server frames. URL keeps the view (`#zoom/lat/lng`).
- Browser graph (`/api/graph`): every road except residential/living streets (service roads included; ~17 MB, ~4 MB gzipped); the server keeps the full network for routing and simulation, and routes use residential lanes and service roads only within 1.5 km of the start or end.
- Junctions / police view (`server/src/junctionService.ts`, `src/roles/JunctionPanel.tsx`): every junction with ID, name (OSM name or "Road A × Road B"), approaches (group A/B), live queue (vehicles, metres), arrivals/h, links to neighbouring junctions (following each approach road upstream ≤1.5 km). Recommended timing by Webster's method (saturation 1800 PCU/h/lane, cycle 60–180 s), spillback and green-wave advice. Endpoints: `GET /api/junctions`, `GET /api/junctions/:id` (supporters/controllers); `POST /api/junctions/:id/hold {group, seconds, coordinate}`, `/plan {greens}|{recommended:true}`, `/reset` (controllers only, simulation only, logged to `GET /api/control/log` and Firestore `signalControlLog`). A coordinated hold opens a green wave at downstream junctions (after the travel time) and cuts upstream greens feeding the stopped approaches to 60%. Police apply real changes in their own signal system.
- Intentional jams (`server/src/jamService.ts`, controllers): right-click a road → "Jam this road" (standstill) or "Slow this road"; `POST /api/jams {lat, lng, metres, minutes, severity}` puts a bumper-to-bumper queue behind the spot in each direction and a bottleneck on the segment (speed ×0.04 / ×0.25) for 20 min; `GET /api/jams`, `DELETE /api/jams/:id`. For studying spillback and the app's response.
- Signal directions and timings: every junction's arms (`TrafficSignal.arms`, built in `junctionService.describeArms`) say where traffic comes from and goes ("Tumkur Road from the north-west (… 2.1 km) → towards Chord Road"), naming the next/previous signalised junction within 5 km. Each arm's head is drawn where drivers look for it: across the junction on the left kerb of the road straight ahead, past the cross road (`signalHeadPosition`). Tapping any signal (all roles) opens `SignalCard`: each arm's light, countdown, green/red per cycle (`src/utils/signalTiming.ts`) and "switch off your engine" for reds ≥ 30 s; navigation shows the same advice near a red. The police view estimates each approach's wait for the last queued car and flags > 5 min (`MAX_WAIT_S`); recommendations give enough green to clear queues within two cycles, and holds warn when cross roads would pass the limit.
- Feeders and merges: for each approach the police view lists roads joining it within 1.2 km of the stop line (flyovers, slip roads, roads) with live flow, and roads joining each exit within 500 m after the junction. Flyovers are OSM bridges with layer ≥ 1 or roads named flyover/elevated (`RoadEdge.elevated`); a flyover landing on a slip road is traced back and named with the neighbourhood where it starts. Directions use OSM neighbourhood names (`CompactOsm.places`, ~1,500).
- Movement counts (`server/src/countsService.ts`): every vehicle crossing a signalised junction is counted by approach → exit (turn: left/right/straight/U-turn), vehicle type and source (sim × DEMAND_SCALE, real GPS users, simulated drives), with estimated people (occupancy per type) and wait on the approach, in 15-minute bins. 24 h kept in memory; finished bins go to Firestore `junctionCounts` (and NDJSON files when `COUNTS_DIR` is set). `GET /api/junctions/:id/movements?hours=1`, `GET /api/counts.csv?hours=24[&junction=ID]` (operators). Only aggregates are stored — no user identities.
- Signal heads: every approach has its own head (`SignalArm.lat/lng`, across the junction on the left kerb of the road straight ahead), drawn from zoom 16 in that approach's colour; below zoom 16 one dot per junction.
- Coordination reaches up to 5 junctions within 3 km (`coordinateNeighbours`): green waves pass downstream junction to junction by cumulative travel time; upstream junctions feeding stopped approaches cut that green to 60% (direct) / 80% (one further).
- Surge scenarios (`server/src/scenarioService.ts`, `scripts/scenarioGoraguntepalya.ts <today|signals|signals+navigation>`): fill every approach of a junction 600 m bumper-to-bumper, keep arrivals at 80% of capacity, and measure clearance with fixed timing vs WayFinder signals vs signals + 40% app users rerouted. Runs faster than real time on the full network.
- Performance: the simulation step yields to the event loop every 2,500 vehicles (requests answered between slices); the junction list is cached 8 s; the map draws main-road traffic once and redraws only slow/jammed roads.
- Firebase: WayFinder uses its own named Firestore database `wayfinder` and its own Hosting target `wayfinder` so it never touches other apps in the project (see docs/FIREBASE_SETUP.md).
- Driver behaviour in the simulation: by default everyone follows the road rules except a few wrong-way riders; operators switch behaviours in Road conditions (`POST /api/conditions/behaviour {redJumping, laneWeaving, wrongWay}`, defaults off/off/on). Per-driver temperament (gap, pickup, politeness), red-light jumping when on (bikes 12%, autos 8%, cars 3% of drivers, only seconds into red), short wrong-way stretches against one-ways (bikes, autos; drawn with a red ring, slow the real traffic; after one stretch a rider drives by the rules), BMTC bus stops (~700 m, 15–35 s) and auto pick-ups at the kerb, two-wheelers weaving across lanes and creeping over the stop line (when lane weaving is on). No overlaps: a vehicle joins the next road's lane table the moment it enters it, followers see leaders that just moved on, unsignalled junctions have give-way (smaller road yields to bigger, traffic from the right first on equal roads, right turns yield to oncoming; 10 s patience), and right turns on green yield to oncoming traffic of the same green. Road reports include 🌳 fallen tree (partial block; closes single-lane roads once confirmed).
- Offline: `public/sw.js` (production builds) serves map tiles/styles/fonts cache-first and the app + `/api/graph` network-first; "Download Bangalore for offline use" (`src/services/offlineMap.ts`) pre-caches all tiles z0–14 for the bbox (~50 MB). The road network is saved in IndexedDB (90 days) and used when the server is unreachable; routes are then planned on the device (`src/utils/offlineRoute.ts`, free-flow speeds, no live traffic).
- Live updates: clients send their viewport (`{type:'viewport', bbox, zoom}` over WebSocket, or `/api/state?bbox=w,s,e,n&zoom=z&traffic=1` when polling). Vehicles are sent only for zoom ≥ 13.5 inside the view, every 0.5 s — real drivers' cars look like any other car (id `nav_<hmac>`, no Firebase uid, not flagged as navigating); only the driver's own app learns its id (`vehicleId` in navigation responses); every signal's `[phaseIndex, timer]`; road traffic levels every 3 s. `/api/graph` is a compact, gzipped, cacheable format (reverse-direction geometry omitted). While a driver navigates, the camera follows their car (`vehicleId`), rotated to its heading and tilted; dragging pauses it until "Re-center". Needs WebGL. Operators get a second MapLibre instance as mini-map.
- User navigation routing runs on the server (`server/src/pathfindingService.ts`): time-based A* with live edge congestion, signal delay, and a penalty per other navigator already routed over an edge, so users with similar trips are spread across nearby routes. `POST /api/route` (signed in, 20 per 10 min) returns up to 3 options; `POST /api/user/start` accepts the chosen `edgeIds`. Searches run on worker threads (`server/src/routeWorkers.ts` + `routeWorker.ts`, one per spare CPU core, max 8): the graph is shared once as typed arrays (`SharedArrayBuffer`), live costs are refreshed every second, the simulation keeps the main thread. Keep the worker's cost model in step with `pathfindingService.ts`.
- Driver UI (`role === 'user'`): search box (`src/utils/places.ts` — road names from the loaded graph, plus OSM Nominatim for addresses, limited to Bangalore), GPS "My location", and an "Open in Google Maps" hand-off that passes 3 waypoints along the user's route. Operator overlays (stats HUD, legend, mini-map, floating nav panel) are hidden for drivers. Phones (≤768px, `useIsMobile`) get a bottom-sheet layout.
- Demo mode (no Firebase config) gives each browser its own `demo-…` user ID so route spreading can be tried with several tabs/devices.
- Simulation (`server/src/simulationEngine.ts`, 5 Hz): car following = IDM/ACC, lane changes = MOBIL (Treiber & Kesting, as on traffic-simulation.de; that project is GPL-3.0, so only its published models are used, no code). Bangalore mix: 44% bikes, 29% cars (hatchback, sedan, SUV, XUV), 11% autos, 5% BMTC buses, vans, tempos, mini trucks, and heavy goods (truck, lorry, tipper, trailer — kept off city roads 7–11 and 16–21 IST); each type has a top speed (bike 60, cars 70–80, auto 40, bus 50, lorry/tipper 40, trailer 35 km/h) on top of each driver's own speed factor; left-hand traffic (lane 0 = kerb, keep-left bias); red lights are stopped obstacles at the stop line; vehicles pick turn lanes before junctions. Up to 20,000 vehicles at peak, scaled by demand: 'auto' traffic mode follows the IST clock (peaks 8:30–11 and 17:30–21, lighter weekends); operators can pin light/normal/heavy. Each vehicle counts as 6 real ones (`DEMAND_SCALE`) in the road-load (BPR) model, smoothed over 30 s. Spawning favours arterials and the core. Navigating users count too; 30% of new vehicles spawn on users' routes. On phones with location, the user's vehicle moves from GPS (`POST /api/user/:id/position`, map-matched to the route); desktops get a simulated drive.
- City-wide conditions (`server/src/conditionsService.ts`): live Bangalore rain from Open-Meteo (polled every 10 min) and the simulated traffic level; operators override them via `POST /api/conditions/weather` / `traffic`. Rain lowers speeds and capacity in simulation and ETAs.
- Crowd reports (`server/src/reportsService.ts`): drivers report 🚧 blocks (road segment, both directions), 🌊 waterlogging (150 m) and 🌧 heavy rain (1.5 km) via `POST /api/reports`. Unconfirmed reports only make roads costlier (block ×3); a report is confirmed by a 2nd person, a supporter/controller, or GPS showing a real driver stuck near it for 45 s — confirmed blocks are never routed. Reports clear on 2 "it's clear" votes (outnumbering confirmations), 2 real drivers passing through at speed, an operator, or expiry (45 min unconfirmed). Votes: `POST /api/reports/:id/vote`; drivers are prompted about reports within 1.5 km ahead.
- Server auth (`server/src/auth.ts`): with Firebase Admin configured, requests carry a Firebase ID token and roles come from Firestore; in demo mode `X-Demo-User`/`X-Demo-Role` headers are trusted — so on Cloud Run (`K_SERVICE`) or with `NODE_ENV=production` the server refuses to start without Firebase (override: `ALLOW_DEMO_MODE=true`). User endpoints require the caller to be that user; weather/traffic need supporter/controller; reports (6/10 min) and votes (30/10 min) are rate-limited in memory.
- Live traffic in routing = simulated congestion (BPR) + speeds measured from real drivers' GPS (last 3 min). Navigation updates carry a `reroute` offer when a block is ahead or a route saves ≥60 s and ≥10%; `POST /api/user/:id/reroute` accepts it. Leaving the route (2 GPS fixes >50 m off) reroutes automatically.
- Production: the client uses same-origin `/api` (Firebase Hosting rewrites to Cloud Run). Hosting doesn't carry WebSockets, so the client falls back to polling `GET /api/state`.
- The server listens on 8080 (matches Vite proxy, client default and Dockerfile); `CORS_ORIGIN` controls the allowed browser origin.
