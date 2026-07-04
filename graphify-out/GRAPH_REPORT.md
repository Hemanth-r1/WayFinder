# Graph Report - .  (2026-07-04)

## Corpus Check
- Corpus is ~24,478 words - fits in a single context window. You may not need a graph.

## Summary
- 592 nodes · 1077 edges · 46 communities (28 shown, 18 thin omitted)
- Extraction: 61% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 4,832 input · 8,120 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Core Traffic Engine & App|Core Traffic Engine & App]]
- [[_COMMUNITY_Testing & Build Tools|Testing & Build Tools]]
- [[_COMMUNITY_Auth & Role System|Auth & Role System]]
- [[_COMMUNITY_Type System & UI Panels|Type System & UI Panels]]
- [[_COMMUNITY_React Components & Context|React Components & Context]]
- [[_COMMUNITY_Road Network & OSM Data|Road Network & OSM Data]]
- [[_COMMUNITY_Routing & Vehicle Simulation|Routing & Vehicle Simulation]]
- [[_COMMUNITY_External Dependencies|External Dependencies]]
- [[_COMMUNITY_TypeScript App Config|TypeScript App Config]]
- [[_COMMUNITY_Utility Functions|Utility Functions]]
- [[_COMMUNITY_Road Network Concepts|Road Network Concepts]]
- [[_COMMUNITY_Engine Concepts|Engine Concepts]]
- [[_COMMUNITY_TypeScript Node Config|TypeScript Node Config]]
- [[_COMMUNITY_Road Network Functions|Road Network Functions]]
- [[_COMMUNITY_Signal Optimization|Signal Optimization]]
- [[_COMMUNITY_Vehicle & Type Definitions|Vehicle & Type Definitions]]
- [[_COMMUNITY_Vehicle Movement|Vehicle Movement]]
- [[_COMMUNITY_Error Boundary|Error Boundary]]
- [[_COMMUNITY_Configuration Module|Configuration Module]]
- [[_COMMUNITY_Configuration Concepts|Configuration Concepts]]
- [[_COMMUNITY_Map Components|Map Components]]
- [[_COMMUNITY_Social Icons|Social Icons]]
- [[_COMMUNITY_Time of Day System|Time of Day System]]
- [[_COMMUNITY_Future Features (Planned)|Future Features (Planned)]]
- [[_COMMUNITY_Linter Config|Linter Config]]
- [[_COMMUNITY_IDM Physics Model|IDM Physics Model]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]

## God Nodes (most connected - your core abstractions)
1. `TrafficEngine` - 29 edges
2. `TrafficSignal` - 18 edges
3. `compilerOptions` - 17 edges
4. `compilerOptions` - 15 edges
5. `RoadGraph` - 14 edges
6. `buildGraphFromOSM()` - 12 edges
7. `scripts` - 11 edges
8. `aStarRoute()` - 11 edges
9. `CongestionZone` - 11 edges
10. `updateVehicle()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `AppContent()` --calls--> `useAuth()`  [EXTRACTED]
  src/App.tsx → src/context/useAuth.ts
- `MapContextMenuProps` --references--> `VehicleType`  [EXTRACTED]
  src/components/MapContextMenu.tsx → src/types/index.ts
- `RoleSelector()` --calls--> `useAuth()`  [EXTRACTED]
  src/components/RoleSelector.tsx → src/context/useAuth.ts
- `UserPanel()` --calls--> `aStarRoute()`  [EXTRACTED]
  src/roles/UserPanel.tsx → src/engine/pathfinding.ts
- `Props` --references--> `RoadGraph`  [EXTRACTED]
  src/roles/SupporterPanel.tsx → src/types/index.ts

## Import Cycles
- None detected.

## Communities (46 total, 18 thin omitted)

### Community 0 - "Core Traffic Engine & App"
Cohesion: 0.06
Nodes (60): MapContextMenuProps, VEHICLE_TYPES, ContextMenuState, MAP_CENTER, MapViewProps, VEHICLE_ICONS, computeStats(), detectCongestionZones() (+52 more)

### Community 1 - "Testing & Build Tools"
Cohesion: 0.05
Nodes (38): VehiclePhysics.calculateAcceleration, VehiclePhysics.getSafeDistance, jsdom, devDependencies, jsdom, @testing-library/jest-dom, @testing-library/react, @types/leaflet (+30 more)

### Community 2 - "Auth & Role System"
Cohesion: 0.07
Nodes (47): App, AppContent, AppRole, AppRole, AuthContext, utils/auth.ts, AuthProvider, AuthState (+39 more)

### Community 3 - "Type System & UI Panels"
Cohesion: 0.10
Nodes (39): A* Pathfinding Algorithm, A* Cost Function - g(n) + h(n) with haversine heuristic, aStarRoute, buildExportPayload, CongestionZone, ControllerPanel, Direction, downloadStatsJSON (+31 more)

### Community 4 - "React Components & Context"
Cohesion: 0.09
Nodes (25): LoadingOverlay(), LoadingSpinnerProps, RoleSelector(), AuthContext, AuthProvider(), AuthState, useAuth(), index.html - Entry Point (+17 more)

### Community 5 - "Road Network & OSM Data"
Cohesion: 0.10
Nodes (33): CachedGraph, cacheKey(), clearGraphCache(), loadGraphFromCache(), saveGraphToCache(), bearingFromDeg(), buildGraphFromOSM(), CENTER (+25 more)

### Community 6 - "Routing & Vehicle Simulation"
Cohesion: 0.10
Nodes (26): getEdgeNodes(), aStarRoute(), edgeCost(), estimateSignalDelay(), findRouteForNavigation(), haversine(), reconstructPath(), advanceToNextEdge() (+18 more)

### Community 7 - "External Dependencies"
Cohesion: 0.08
Nodes (24): Firebase, @google/genai, Leaflet, dependencies, firebase, @google/genai, leaflet, react (+16 more)

### Community 8 - "TypeScript App Config"
Cohesion: 0.11
Nodes (18): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, jsx, lib, module, moduleDetection, moduleResolution (+10 more)

### Community 9 - "Utility Functions"
Cohesion: 0.16
Nodes (18): calculateBearing, clamp, ColorUtils, debounce, deepClone, formatCoordinate, formatDistance, formatFileSize (+10 more)

### Community 10 - "Road Network Concepts"
Cohesion: 0.15
Nodes (17): BFS Routing - Vehicle Spawn Path Assignment, graphCache, Lane Index - Vehicle Lane Assignment, LaneManager - Lane Assignment + Perpendicular Offset, LANE_WIDTH = 3.5m (~0.0000315° lat), localStorage - Browser Persistence API, Oneway Tag Parsing (OSM), OpenStreetMap (+9 more)

### Community 11 - "Engine Concepts"
Cohesion: 0.15
Nodes (17): clearGraphCache, computeStats, Congestion Heatmap Hotspot Detection, Congestion - Hotspot Detection + Stats, CongestionZone, detectCongestionZones, Emergency Vehicle Signal Preemption, EmergencyPriority - Emergency Vehicle Signal Preemption (+9 more)

### Community 12 - "TypeScript Node Config"
Cohesion: 0.12
Nodes (16): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleDetection, noEmit, noFallthroughCasesInSwitch (+8 more)

### Community 13 - "Road Network Functions"
Cohesion: 0.14
Nodes (16): bearingFromDeg, buildGraphFromOSM, CachedGraph, createPhase, deriveApproaches, fetchOSMChunk, fetchOSMRoads, lanesForHighway (+8 more)

### Community 14 - "Signal Optimization"
Cohesion: 0.20
Nodes (12): applyGreenWaveConstraint, applyOptimizationPlan, buildInitialPlan, computeGreenSplit, Direction, estimateDelay, getDominantFlowDirection, mutatePlan (+4 more)

### Community 15 - "Vehicle & Type Definitions"
Cohesion: 0.24
Nodes (11): aStarRoute, applyEmergencyPriority, congestion, createVehicle, emergencyPriority, getEdgeNodes, LoadingSpinner, spawnRandomVehicle (+3 more)

### Community 16 - "Vehicle Movement"
Cohesion: 0.18
Nodes (11): advanceToNextEdge, applyLaneOffset, checkCanProceed, coordinateGreenWave, findLeadVehicle, GeoPoint, haversineMeters (roadNetwork), LANE_WIDTH_DEG (+3 more)

### Community 17 - "Error Boundary"
Cohesion: 0.22
Nodes (4): ErrorBoundary, Props, State, styles

### Community 18 - "Configuration Module"
Cohesion: 0.22
Nodes (8): APP_INFO, ENV, FEATURE_FLAGS, MAP_CONFIG, ROAD_CONFIG, SIGNAL_CONFIG, SIMULATION_CONFIG, UI_CONFIG

### Community 19 - "Configuration Concepts"
Cohesion: 0.25
Nodes (7): Config - Centralized Constants, FEATURE_FLAGS, MAP_CONFIG, ROAD_CONFIG, SIGNAL_CONFIG, SIMULATION_CONFIG, UI_CONFIG

### Community 20 - "Map Components"
Cohesion: 0.32
Nodes (8): findNearestNode, MapContextMenu, MapView, SignalApproach, SignalPhase, TrafficSignal, Vehicle, VehicleType

### Community 21 - "Social Icons"
Cohesion: 0.29
Nodes (7): Bluesky Social Icon, Discord Social Icon, Documentation Icon, GitHub Social Icon, Icons SVG - Social Media Icons, Social Media Icon, X/Twitter Social Icon

### Community 22 - "Time of Day System"
Cohesion: 0.38
Nodes (7): classifyHour, createSimClock, getCurrentProfile, SimClock, TimeOfDay, TimeProfile, TIME_PROFILES

### Community 23 - "Future Features (Planned)"
Cohesion: 0.33
Nodes (6): Cell Transmission Model (CTM), Genetic Algorithm (Planned Optimization), Lighthill-Whitham-Richards Model, optimizer, SignalPlan - Per-signal Timing Assignment, Simulated Annealing Optimization

### Community 24 - "Linter Config"
Cohesion: 0.33
Nodes (5): plugins, rules, react/only-export-components, react/rules-of-hooks, $schema

### Community 25 - "IDM Physics Model"
Cohesion: 0.40
Nodes (5): Intelligent Driver Model (IDM), calculateAcceleration - IDM Physics Function, IDM Formula - dv/dt = a * [1 - (v/v0)^4 - (s*(v,dv)/s)^2], Physics Utils - IDM Math (calculateAcceleration, getSafeDistance), getSafeDistance - IDM Safe Distance Function

### Community 27 - "Community 27"
Cohesion: 1.00
Nodes (3): tsconfig.app.json, tsconfig.node.json, tsconfig.json

## Knowledge Gaps
- **92 isolated node(s):** `$schema`, `plugins`, `react/rules-of-hooks`, `react/only-export-components`, `name` (+87 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **18 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `devDependencies` connect `Testing & Build Tools` to `Auth & Role System`, `External Dependencies`?**
  _High betweenness centrality (0.042) - this node is a cross-community bridge._
- **Why does `TrafficEngine` connect `Core Traffic Engine & App` to `Road Network & OSM Data`, `Routing & Vehicle Simulation`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **What connects `$schema`, `plugins`, `react/rules-of-hooks` to the rest of the system?**
  _92 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Core Traffic Engine & App` be split into smaller, more focused modules?**
  _Cohesion score 0.055822466254861584 - nodes in this community are weakly interconnected._
- **Should `Testing & Build Tools` be split into smaller, more focused modules?**
  _Cohesion score 0.05102040816326531 - nodes in this community are weakly interconnected._
- **Should `Auth & Role System` be split into smaller, more focused modules?**
  _Cohesion score 0.0666049953746531 - nodes in this community are weakly interconnected._
- **Should `Type System & UI Panels` be split into smaller, more focused modules?**
  _Cohesion score 0.10256410256410256 - nodes in this community are weakly interconnected._