# 🚦 WayFinder

Real-time traffic signal control and simulation system for Bangalore, India.

Fetches live road data from OpenStreetMap, simulates vehicles with realistic physics, manages adaptive signals using Webster's formula, and provides role-based dashboards for Users, Supporters, and Controllers.

---

## Features

| Feature | Description |
|---|---|
| **Live OSM Roads** | 40km radius of real Bangalore road network via Overpass API |
| **Vehicle Simulation** | 9 vehicle types with IDM physics, driver aggression, response delays |
| **Adaptive Signals** | Webster's optimal cycle length + proportional green split |
| **Green Wave** | Coordinated signal offsets along dominant flow corridors |
| **Congestion Heatmap** | Real-time hotspot detection and map overlay |
| **A\* Navigation** | Signal delay + congestion penalty aware routing |
| **Time-of-Day** | Simulated clock (8am start, 2× speed) modulates traffic volume and signal timing |
| **Emergency Priority** | Emergency vehicles auto-force nearby signals GREEN in their direction |
| **Role System** | User · Supporter · Controller with permission gates |
| **Export Stats** | Download current simulation state as JSON |

---

## Roles

| Role | Capabilities |
|---|---|
| **User** | Set source/destination, calculate routes, submit for analytics |
| **Supporter** | Identify signal coverage gaps, add new signals to the map |
| **Controller** | Override signals (individual or route-wide), spawn emergency vehicles, view analytics, export stats |

---

## Getting Started

```bash
npm install
npm run dev
# Opens at http://localhost:5173
```

No API keys required — uses OpenStreetMap (free) and Leaflet (free).

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` / `P` | Pause / Resume simulation |
| `E` | Spawn emergency vehicle |
| `Esc` | Cancel active manual override |

---

## Architecture

```
src/
├── App.tsx                    # Root: engine boot, game loop, keyboard shortcuts
├── components/
│   ├── MapView.tsx             # Leaflet map + live stats HUD + override banner
│   ├── RoleSelector.tsx        # Role switcher dropdown
│   ├── ErrorBoundary.tsx       # React error boundary with graceful fallback
│   └── LoadingSpinner.tsx      # Loading overlay component
├── context/
│   ├── AuthContext.tsx         # Role + permission state provider
│   └── useAuth.ts              # useAuth hook (separate file for Fast Refresh)
├── config/
│   └── index.ts                # Centralized constants (map, simulation, signals, UI)
├── engine/
│   ├── TrafficEngine.ts        # Orchestrator: update loop, spawn, overrides
│   ├── vehicleSim.ts           # IDM vehicle movement + BFS routing
│   ├── signalControl.ts        # Webster's timing + green wave coordination
│   ├── pathfinding.ts          # A* with signal delay + congestion cost
│   ├── congestion.ts           # Hotspot detection + stats
│   ├── timeOfDay.ts            # Sim clock + traffic volume profiles
│   └── emergencyPriority.ts    # Emergency vehicle signal preemption
├── data/
│   └── roadNetwork.ts          # OSM Overpass fetcher + graph builder + fallback grid
├── roles/
│   ├── UserPanel.tsx           # Route navigation UI
│   ├── SupporterPanel.tsx      # Signal gap coverage UI
│   └── ControllerPanel.tsx     # Override dashboard + search + analytics + export
├── types/
│   ├── index.ts                # Core interfaces + vehicle/signal constants
│   └── roles.ts                # AppRole types, permissions, role metadata
└── utils/
    ├── physics.ts              # IDM math (calculateAcceleration, getSafeDistance)
    ├── index.ts                # Shared helpers (distance, format, color, id gen)
    ├── auth.ts                 # Auth helpers (generateUserId, isValidRole)
    ├── rolePermissions.ts      # ROLE_PERMISSIONS map (separated for Fast Refresh)
    └── exportStats.ts          # JSON export builder + browser download trigger
```

---

## Algorithms

### IDM (Intelligent Driver Model)
```
dv/dt = a × [1 − (v/v₀)⁴ − (s*(v,Δv)/s)²]
s*(v,Δv) = s₀ + max(0, vT + vΔv / (2√(ab)))
```

### Webster's Optimal Cycle
```
C_opt = (1.5L + 5) / (1 − Y)
g_i = (y_i / Y) × (C_opt − L)
```

### A* Cost Function
```
g(n) = travel_time + signal_delay + congestion_penalty + turn_penalty
h(n) = haversine(n, goal)
```

---

## Scripts

```bash
npm run dev          # Development server
npm run build        # TypeScript check + production build
npm run lint         # Oxlint code quality check
npm run test         # Vitest test suite (watch mode)
npm run test -- --run  # Single test run
npm run type-check   # TypeScript type-check only
```

---

## Configuration

All constants live in `src/config/index.ts`:

| Constant group | Key values |
|---|---|
| `MAP_CONFIG` | Center (12.9716, 77.5946), zoom levels, OSM tile URL |
| `ROAD_CONFIG` | Fetch radius 40km, road type colors |
| `SIMULATION_CONFIG` | Max 120 vehicles, spawn interval 200–800ms, initial 20 |
| `SIGNAL_CONFIG` | Min green 8s, max green 45s, yellow 3s, lost time 2s |
| `UI_CONFIG` | Sidebar 340px, brand colors |
| `FEATURE_FLAGS` | Firebase/Google Maps/analytics toggles |
