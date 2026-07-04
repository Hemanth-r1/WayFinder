# WayFinder: Bug Fixes, UX Overhaul & Feature Additions

## 1. Bug Fixes

| Bug | Fix |
|-----|-----|
| Panels overlap (both `top:12;right:12`) | NavPanel goes top-left, ControlPanel stays top-right, stats bar top-center below override banner |
| RAF loop runs while paused | `cancelAnimationFrame` when paused, restart on resume |
| Manual override disables all signals | Only disable `adaptiveTiming` on the target signal |
| `spawnVehicleFromDirection` ignores `_direction` | Use the direction param to select spawn edge |
| `haversineMeters` duplicated in 3 engine files | Extract to `src/utils/geo.ts`, import everywhere |

## 2. UX Overhaul

- **Layout**: No overlapping panels. NavPanel left, ControlPanel right, stats bar top-center.
- **Re-renders**: Memoize stats display. Only call `setTick` when paused actually changes.
- **Loading screen**: Step-by-step progress (network → signals → vehicles → ready).
- **Toast system**: Bottom-left toast stack for signal overrides, congestion alerts.
- **Vehicle tooltips**: Show speed, type, ETA on hover via Leaflet tooltip.

## 3. Features

- **Keyboard shortcuts**: Space=pause, S=spawn, O=cancel override, 1-4=speed, H=toggle heatmap, Esc=clear route.
- **Speed control**: 0.5×/1×/2×/4× slider in ControlPanel, multiplies deltaTime.
- **Heatmap toggle**: Button to show/hide congestion zone circles.
- **Vehicle list panel**: Collapsible drawer listing vehicles with type/speed/ETA; click to center map.
- **Route display**: Draw A* path as polyline on map when route is calculated.
- **GRID_CENTER/GRID_BOUNDS**: Delete unused NYC constants from types/index.ts.

## 4. Files touched

```
src/utils/geo.ts           (new — haversineMeters, bearing helpers)
src/engine/congestion.ts    (remove duplicate haversine)
src/engine/signalControl.ts (remove duplicate haversine)
src/engine/vehicleSim.ts    (remove duplicate haversine)
src/engine/TrafficEngine.ts (fix direction param, manual override scope, pause RAF)
src/types/index.ts          (remove GRID_CENTER/GRID_BOUNDS)
src/App.tsx                 (pause RAF management, speed multiplier, toast state)
src/components/MapView.tsx  (layout fix, tooltips, route polyline, heatmap toggle)
src/components/ControlPanel.tsx (speed slider, keyboard registration, vehicle list)
src/components/NavigationPanel.tsx (layout reposition to left)
```
