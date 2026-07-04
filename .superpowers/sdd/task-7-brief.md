# Task 7: MapView enhancements — heatmap toggle, vehicle tooltips, route display

**Files:**
- Modify: `src/components/MapView.tsx`

## Requirements

### 1. Add `showHeatmap` and `routePolyline` props
Add to `MapViewProps` interface:
```typescript
showHeatmap?: boolean;
routePolyline?: [number, number][];
```

### 2. Conditional heatmap rendering
Wrap the congestion heatmap effect body so it returns early when `showHeatmap` is false:
```typescript
if (!showHeatmap) { layer.clearLayers(); return; }
```
(Place this after `layer.clearLayers()` or before the for loop — clear any existing circles when toggled off.)

### 3. Vehicle tooltips
In the vehicle update effect, add a tooltip when creating new markers:
```typescript
const tooltipText = `${v.type.toUpperCase()} · ${Math.round(v.speed)} km/h`;
const newMarker = L.marker([v.lat, v.lng], {
  icon: cachedIcon,
  zIndexOffset: v.type === 'emergency' ? 1000 : 0,
}).bindTooltip(tooltipText, {
  direction: 'top', offset: [0, -2], className: 'wf-tooltip',
}).addTo(layer);
```

Also update existing markers' tooltips when they move:
```typescript
existing.setLatLng([v.lat, v.lng]);
existing.setTooltipContent(`${v.type.toUpperCase()} · ${Math.round(v.speed)} km/h`);
```

### 4. Route display layer
Add a new ref:
```typescript
const routeLayerRef = useRef<L.LayerGroup | null>(null);
```
Initialize it after heatmapLayerRef in the init effect:
```typescript
routeLayerRef.current = L.layerGroup().addTo(map);
```

Add an effect to draw/clear the route polyline:
```typescript
useEffect(() => {
  const layer = routeLayerRef.current;
  if (!layer) return;
  layer.clearLayers();
  if (routePolyline && routePolyline.length > 1) {
    L.polyline(routePolyline, {
      color: '#4488FF', weight: 5, opacity: 0.8, dashArray: '12, 8',
    }).addTo(layer);
  }
}, [routePolyline]);
```

Run `npm run build` and `npm run lint` — both must pass. Commit.
