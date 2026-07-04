# Task 7 Report: MapView enhancements

**Status:** Complete

**Changes made to `src/components/MapView.tsx`:**
1. Added `routePolyline?: [number, number][]` to `MapViewProps` (line 43)
2. Made heatmap effect conditional — early return when `showHeatmap` is false (line 308); added `showHeatmap` to dep array
3. Added vehicle tooltips — `.bindTooltip(...)` on new markers (lines 291–297), `.setTooltipContent(...)` on existing markers (line 266)
4. Added `routeLayerRef`, initialized in init effect, and a new effect to draw/clear a dashed route polyline (lines 67, 319–329)

**Build:** `npm run build` — passed (tsc + vite)
**Lint:** `npm run lint` — passed (0 errors, 2 pre-existing warnings)

**Commit:** `66b27fb` — "Task 7: MapView enhancements — heatmap toggle, vehicle tooltips, route display"
