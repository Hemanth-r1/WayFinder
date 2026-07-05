# Server/Client Split — WayFinder Backend Architecture

## Context

The WayFinder traffic simulation runs entirely client-side in the browser. Users
reported two performance issues:

1. **Slow initial load** — fetching road network from Overpass API, building the
   graph, and starting the engine takes significant time before the app is usable.
2. **Ongoing simulation lag** — with hundreds of vehicles, signals, and congestion
   zones, the per-frame computation affects rendering smoothness.

## Decision

After evaluating three approaches (full server simulation + WebSocket streaming,
hybrid server cache + lightweight client sim, Cloud Run microservice + SSE), we
chose **Approach 2: Hybrid**.

The server handles all heavy, infrequent computation. The client keeps a
lightweight vehicle movement engine for smooth 60fps rendering. Firestore serves
as the sync layer between them.

## Architecture

```
CLIENT (Vite + React)                    SERVER (Node.js + Express)
┌─────────────────────────────┐          ┌─────────────────────────────┐
│ Lightweight Sim Engine      │          │ Graph Cache Service         │
│ (vehicle movement, signal   │          │ (pre-fetched OSM,           │
│  phase display, rendering)  │          │  pre-built adjacency)       │
└──────────┬──────────────────┘          └──────────┬──────────────────┘
           │                                       │
┌──────────▼──────────────────┐    REST    ┌──────────▼──────────────────┐
│ Sync Layer                   │◄──────────┤ Heavy Computation API      │
│ (Firestore listeners +      │           │ /api/graph                 │
│  periodic polling)           │           │ /api/congestion            │
└─────────────────────────────┘           │ /api/sla                   │
                                          │ /api/corridors             │
                                          │ /api/route                 │
                                          └─────────────────────────────┘
```

## What Moves Server-Side

| Module | Frequency | Why |
|--------|-----------|-----|
| Graph building from OSM | Once per session | Pre-cached; client loads instantly |
| Congestion zone detection | Every 5-10s | Iterates all edges/vehicles — O(n) |
| SLA stats computation | Every 5s | Aggregation across all vehicles |
| Corridor detection | Every 10-15s | Graph-wide pattern analysis |
| A* pathfinding | On demand | Search can be large; cacheable per route |
| Signal coordination scoring | Every 5s | Global optimization function |

## What Stays Client-Side

| Module | Why |
|--------|-----|
| Vehicle position interpolation | Need 60fps smooth movement; cheap (<0.5ms) |
| Signal phase timer display | Visual only — phase transitions known from server |
| Leaflet map rendering | Map rendering must be client-side |
| Heatmap display | Visual rendering of pre-computed zone data |
| User interaction (clicks, menus) | Must be instant |

## Data Flow

### Initial Load
1. Client requests `GET /api/graph` → receives pre-built road graph JSON from
   server cache (or server builds from Overpass on first request and caches it).
2. Client renders roads immediately, starts local simulation with default
   vehicles spawning on the pre-loaded graph.
3. Server pushes initial congestion and signal state → client overlays on map.

### Steady State
- Client runs vehicle simulation locally at 60fps (movement along known edges).
- Server runs heavy analysis every 5-10s, writes results to Firestore.
- Client listens to Firestore for updated congestion/SLA/corridor data.
- Client sends commands (spawn vehicle, override signal, navigate) via Firestore
  writes; server picks them up via its own Firestore listener.

### Command Flow (Example: Spawn Vehicle)
```
User clicks "Spawn Vehicle"
  → Client writes { type: 'spawn', vehicleType: 'sedan', nodeId: '123' }
    to Firestore commands collection
  → Server's Firestore listener picks it up
  → Server processes spawn, updates global state,
    writes result back to Firestore
  → Client sees update via Firestore listener
```

## Firebase Services

| Service | Purpose |
|---------|---------|
| Firebase Hosting | Serves static client build (unchanged) |
| Firebase App Hosting | Hosts Node.js server on Cloud Run |
| Firestore | State sync — server→client heavy results,
                 client→server commands |
| Firebase Auth | Authentication (unchanged) |

## Implementation Order

1. **Server scaffolding** — Express app with `/api/graph` endpoint serving
   cached road network (extract graph building from `TrafficEngine.ts`).
2. **Server heavy API** — `/api/congestion`, `/api/sla`, `/api/corridors`,
   `/api/route` endpoints.
3. **Client sync layer** — Firestore listeners + periodic polling module.
4. **Client engine trim** — Strip heavy computation from `TrafficEngine.ts`;
   keep only vehicle movement + rendering.
5. **Firestore command bus** — Client writes commands to Firestore; server
   reads and processes them.
6. **Deploy** — Firebase App Hosting for server, Firebase Hosting for client.
7. **Tuning** — Polling frequencies, caching headers, edge cases.

## Conversation Record

- User reported: both initial loading AND ongoing simulation are slow.
- Three approaches presented: Full Server Sim + WebSocket, Hybrid
  (Recommended), Cloud Run Microservice + SSE.
- User selected **Hybrid** approach for instant load + responsive feel.
- Firestore chosen as sync layer (simpler than WebSocket, leverages existing
  Firebase setup).
- Vehicle movement stays client-side (essential for 60fps rendering).
