/**
 * MapLibre sources, layers and icons for WayFinder's overlay (traffic, signals,
 * vehicles, routes, reports) drawn on top of OpenFreeMap vector tiles.
 */
import type { Map as MLMap, GeoJSONSource, ExpressionSpecification } from 'maplibre-gl';
import type { FeatureCollection, Feature, Geometry } from 'geojson';
import type { RoadGraph, TrafficSignal, Vehicle, CongestionZone } from '../types';
import type { RoadReport } from '../services/serverClient';
import { REPORT_LABEL } from '../utils/reports';

/** Free vector map styles, no API key (https://openfreemap.org). */
export const MAP_STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
} as const;

export const SRC = {
  roads: 'wf-roads',
  traffic: 'wf-traffic',
  heat: 'wf-heat',
  alts: 'wf-alts',
  route: 'wf-route',
  reroute: 'wf-reroute',
  areas: 'wf-areas',
  blocks: 'wf-blocks',
  signals: 'wf-signals',
  vehicles: 'wf-vehicles',
  reportIcons: 'wf-report-icons',
} as const;

export const LAYER = {
  signals: 'wf-signals',
  vehicles: 'wf-vehicles',
} as const;

type Props = Record<string, unknown>;
type FC = FeatureCollection<Geometry, Props>;
type LatLng = [number, number];

const EMPTY: FC = { type: 'FeatureCollection', features: [] };

function fc(features: Feature<Geometry, Props>[]): FC {
  return { type: 'FeatureCollection', features };
}

function lineFeature(points: LatLng[], properties: Props = {}): Feature<Geometry, Props> {
  return { type: 'Feature', properties, geometry: { type: 'LineString', coordinates: points.map(([lat, lng]) => [lng, lat]) } };
}

function pointFeature(lat: number, lng: number, properties: Props): Feature<Geometry, Props> {
  return { type: 'Feature', properties, geometry: { type: 'Point', coordinates: [lng, lat] } };
}

/** Circle of `radiusM` metres as a polygon (MapLibre circles are sized in pixels). */
function circlePolygon(lat: number, lng: number, radiusM: number, properties: Props): Feature<Geometry, Props> {
  const steps = 48;
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [ring] } };
}

export function setSourceData(map: MLMap, id: string, data: FC): void {
  (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
}

// ── Icons ────────────────────────────────────────────────────────────────────
// Drawn to a canvas on first use (the style's sprite has none of these).
// Ids: `wf-veh:<type>:<colour>`, `wf-e:<css px>:<1 = "?" badge>:<emoji>`, `wf-puck`.

const PIXEL_RATIO = 2;

/** Top-down footprint per vehicle type in CSS px at icon-size 1 (exaggerated so it reads on a map). */
const VEHICLE_SHAPE: Record<string, { len: number; wid: number }> = {
  bike: { len: 8, wid: 3.5 },
  auto: { len: 10, wid: 6.5 },
  hatchback: { len: 13, wid: 6.5 },
  sedan: { len: 15, wid: 7 },
  suv: { len: 15.5, wid: 7.5 },
  van: { len: 16, wid: 7.5 },
  truck: { len: 24, wid: 8.5 },
  bus: { len: 30, wid: 9 },
  emergency: { len: 15, wid: 7 },
};

function vehicleIconId(type: string, color: string): string {
  return `wf-veh:${type in VEHICLE_SHAPE ? type : 'sedan'}:${color}`;
}

function emojiIconId(emoji: string, size: number, badge = false): string {
  return `wf-e:${size}:${badge ? 1 : 0}:${emoji}`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Vehicle seen from above, front pointing north (rotated by its bearing on the map). */
function drawVehicle(type: string, color: string): ImageData | null {
  const { len, wid } = VEHICLE_SHAPE[type] ?? VEHICLE_SHAPE.sedan;
  const pad = 1.5;
  const w = Math.ceil((wid + pad * 2) * PIXEL_RATIO), h = Math.ceil((len + pad * 2) * PIXEL_RATIO);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(PIXEL_RATIO, PIXEL_RATIO);
  const x = pad, y = pad;

  if (type === 'bike') {
    ctx.fillStyle = '#222';
    roundRect(ctx, x + wid * 0.25, y, wid * 0.5, len, wid * 0.25); ctx.fill();
    ctx.fillStyle = color; // rider
    ctx.beginPath(); ctx.arc(x + wid / 2, y + len * 0.55, wid * 0.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 0.6; ctx.stroke();
  } else {
    ctx.fillStyle = color;
    roundRect(ctx, x, y, wid, len, Math.min(wid, len) * (type === 'auto' ? 0.45 : 0.25)); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 0.7; ctx.stroke();
    // Windscreen near the front, and the roof
    ctx.fillStyle = 'rgba(20,30,45,0.75)';
    const glassY = y + len * (type === 'bus' || type === 'truck' ? 0.04 : 0.2);
    roundRect(ctx, x + wid * 0.15, glassY, wid * 0.7, len * (type === 'bus' ? 0.08 : 0.16), 1); ctx.fill();
    if (type === 'auto') { ctx.fillStyle = '#FDD835'; roundRect(ctx, x + wid * 0.15, y + len * 0.42, wid * 0.7, len * 0.45, 2); ctx.fill(); }
    if (type === 'truck') { ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(x + 0.5, y + len * 0.3, wid - 1, 0.8); }
  }
  return ctx.getImageData(0, 0, w, h);
}

function drawEmoji(emoji: string, size: number, badge: boolean): ImageData | null {
  const px = size * PIXEL_RATIO;
  const canvas = document.createElement('canvas');
  canvas.width = px; canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = `${Math.round(px * 0.78)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, px / 2, px / 2 + px * 0.04);
  if (badge) {
    const r = px * 0.2;
    ctx.fillStyle = '#333';
    ctx.beginPath(); ctx.arc(px - r, r, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(r * 1.5)}px sans-serif`;
    ctx.fillText('?', px - r, r + 1);
  }
  return ctx.getImageData(0, 0, px, px);
}

/** Navigation arrow for the driver's own car; points north, rotated by bearing. */
function drawPuck(): ImageData | null {
  const px = 36 * PIXEL_RATIO;
  const canvas = document.createElement('canvas');
  canvas.width = px; canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const c = px / 2;
  ctx.fillStyle = 'rgba(68,136,255,0.22)';
  ctx.beginPath(); ctx.arc(c, c, c, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(c, c, c * 0.62, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#2F6BFF';
  ctx.beginPath(); ctx.arc(c, c, c * 0.52, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(c, c - c * 0.34);
  ctx.lineTo(c + c * 0.24, c + c * 0.26);
  ctx.lineTo(c, c + c * 0.14);
  ctx.lineTo(c - c * 0.24, c + c * 0.26);
  ctx.closePath(); ctx.fill();
  return ctx.getImageData(0, 0, px, px);
}

/** Handler for the map's 'styleimagemissing' event: draws our icons on first use. */
export function addMissingImage(map: MLMap, id: string): void {
  if (map.hasImage(id)) return;
  let img: ImageData | null = null;
  if (id === 'wf-puck') {
    img = drawPuck();
  } else if (id.startsWith('wf-veh:')) {
    const [, type, color] = id.split(':');
    img = drawVehicle(type, color);
  } else if (id.startsWith('wf-e:')) {
    const [, size, badge, ...rest] = id.split(':');
    img = drawEmoji(rest.join(':'), Number(size), badge === '1');
  }
  if (img) map.addImage(id, img, { pixelRatio: PIXEL_RATIO });
}

// ── Layers ───────────────────────────────────────────────────────────────────

/** Google-style traffic colours: free, slow, heavy, jammed. */
export const TRAFFIC_COLORS = ['#34C759', '#FF9500', '#FF3B30', '#8E1B1B'];

/** Vehicles grow with zoom, about to scale from z17. */
const VEHICLE_SIZE: ExpressionSpecification = ['interpolate', ['exponential', 2], ['zoom'], 13, 0.3, 15, 0.55, 17, 1, 19, 2.4];

export function addOverlayLayers(map: MLMap, opts: { showRoads: boolean }): void {
  for (const id of Object.values(SRC)) map.addSource(id, { type: 'geojson', data: EMPTY });

  const round = { 'line-join': 'round', 'line-cap': 'round' } as const;

  // Operators: the simulated road network, faint, under everything
  map.addLayer({
    id: 'wf-roads', type: 'line', source: SRC.roads,
    layout: { ...round, visibility: opts.showRoads ? 'visible' : 'none' },
    paint: {
      'line-color': '#7C8DB5',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 15, 1.5, 18, 3],
      'line-opacity': 0.45,
    },
  });
  // Live traffic, each direction on its own side of the road (India drives on the left)
  map.addLayer({
    id: 'wf-traffic', type: 'line', source: SRC.traffic, layout: round,
    paint: {
      'line-color': ['match', ['get', 'level'], 1, TRAFFIC_COLORS[1], 2, TRAFFIC_COLORS[2], 3, TRAFFIC_COLORS[3], TRAFFIC_COLORS[0]],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 13, 2.5, 16, 4, 19, 7],
      'line-offset': ['interpolate', ['linear'], ['zoom'], 12, 0, 15, ['*', -2, ['get', 'tw']], 19, ['*', -6, ['get', 'tw']]],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.75, 17, 0.55],
    },
  });
  map.addLayer({
    id: 'wf-heat', type: 'circle', source: SRC.heat,
    paint: {
      'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'], 'circle-opacity': ['get', 'fill'],
      'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1, 'circle-stroke-opacity': 0.5,
    },
  });
  map.addLayer({
    id: 'wf-alts', type: 'line', source: SRC.alts, layout: round,
    paint: { 'line-color': '#8899AA', 'line-width': 5, 'line-opacity': 0.6 },
  });
  map.addLayer({
    id: 'wf-route-casing', type: 'line', source: SRC.route, layout: round,
    paint: { 'line-color': '#1F4FBF', 'line-width': 9, 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'wf-route', type: 'line', source: SRC.route, layout: round,
    paint: { 'line-color': '#4488FF', 'line-width': 6 },
  });
  map.addLayer({
    id: 'wf-reroute', type: 'line', source: SRC.reroute, layout: { 'line-join': 'round' },
    paint: { 'line-color': '#00E676', 'line-width': 6, 'line-opacity': 0.9, 'line-dasharray': [1.7, 1.3] },
  });
  map.addLayer({
    id: 'wf-areas', type: 'fill', source: SRC.areas,
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fill'] },
  });
  map.addLayer({
    id: 'wf-areas-line', type: 'line', source: SRC.areas, filter: ['==', ['get', 'confirmed'], true],
    paint: { 'line-color': ['get', 'color'], 'line-width': 1 },
  });
  map.addLayer({
    id: 'wf-areas-line-unconfirmed', type: 'line', source: SRC.areas, filter: ['==', ['get', 'confirmed'], false],
    paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-dasharray': [4, 4] },
  });
  map.addLayer({
    id: 'wf-blocks', type: 'line', source: SRC.blocks, layout: round, filter: ['==', ['get', 'confirmed'], true],
    paint: { 'line-color': '#FF1744', 'line-width': 7, 'line-opacity': 0.85 },
  });
  map.addLayer({
    id: 'wf-blocks-unconfirmed', type: 'line', source: SRC.blocks, filter: ['==', ['get', 'confirmed'], false],
    paint: { 'line-color': '#FF9100', 'line-width': 6, 'line-opacity': 0.7, 'line-dasharray': [1, 1] },
  });
  // Navigating users' vehicles get a blue halo
  map.addLayer({
    id: 'wf-vehicle-nav', type: 'circle', source: SRC.vehicles,
    filter: ['all', ['get', 'nav'], ['!', ['get', 'self']]],
    paint: { 'circle-radius': 11, 'circle-color': '#4488FF', 'circle-blur': 0.8, 'circle-opacity': 0.55 },
  });
  map.addLayer({
    id: LAYER.vehicles, type: 'symbol', source: SRC.vehicles, filter: ['!', ['get', 'self']],
    layout: {
      'icon-image': ['get', 'icon'], 'icon-size': VEHICLE_SIZE,
      'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
  });
  map.addLayer({
    id: LAYER.signals, type: 'circle', source: SRC.signals, minzoom: 12,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 15, 6, 18, 9],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#111', 'circle-stroke-width': 1.5,
    },
  });
  map.addLayer({
    id: 'wf-self', type: 'symbol', source: SRC.vehicles, filter: ['get', 'self'],
    layout: {
      'icon-image': 'wf-puck', 'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
  });
  map.addLayer({
    id: 'wf-report-icons', type: 'symbol', source: SRC.reportIcons,
    layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true },
    paint: { 'icon-opacity': ['case', ['get', 'confirmed'], 1, 0.65] },
  });
}

// ── GeoJSON builders ─────────────────────────────────────────────────────────

const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary']);

export function roadsData(graph: RoadGraph): FC {
  const drawn = new Set<string>();
  const features: Feature<Geometry, Props>[] = [];
  for (const edge of graph.edges.values()) {
    const key = edge.from < edge.to ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`;
    if (drawn.has(key)) continue;
    drawn.add(key);
    if (!edge.geometry || edge.geometry.length < 2) continue;
    features.push(lineFeature(edge.geometry.map(p => [p.lat, p.lng])));
  }
  return fc(features);
}

/**
 * Traffic per direction: main roads always (green when flowing), smaller roads only
 * when slow. `tw` = 1 on two-way roads so each direction is offset to its own side.
 */
export function trafficData(graph: RoadGraph, traffic: Map<string, number>): FC {
  const features: Feature<Geometry, Props>[] = [];
  for (const edge of graph.edges.values()) {
    const level = traffic.get(edge.id) ?? 0;
    if (level === 0 && !MAJOR.has(edge.roadType)) continue;
    if (!edge.geometry || edge.geometry.length < 2) continue;
    features.push(lineFeature(edge.geometry.map(p => [p.lat, p.lng]), { level, tw: edge.oneway ? 0 : 1 }));
  }
  // Slow roads on top of free-flowing ones
  features.sort((a, b) => (a.properties.level as number) - (b.properties.level as number));
  return fc(features);
}

/** Colour shown to the junction's main road (phase group 'A'; legacy graphs: 'NS'). */
export function signalColor(sig: TrafficSignal): string {
  const phase = sig.phases[sig.currentPhaseIndex];
  const main = sig.phases.some(p => p.group === 'A') ? 'A' : 'NS';
  if (!phase || phase.group !== main) return '#FF1744';
  return phase.color === 'GREEN' ? '#00E676' : phase.color === 'YELLOW' ? '#FFD600' : '#FF1744';
}

export function signalsData(signals: Map<string, TrafficSignal>, graph: RoadGraph): FC {
  const features: Feature<Geometry, Props>[] = [];
  for (const sig of signals.values()) {
    const node = graph.nodes.get(sig.nodeId);
    if (!node) continue;
    features.push(pointFeature(node.lat, node.lng, { id: sig.id, color: signalColor(sig) }));
  }
  return fc(features);
}

export function vehiclesData(vehicles: Iterable<Vehicle>, selfId: string | undefined): FC {
  const features: Feature<Geometry, Props>[] = [];
  for (const v of vehicles) {
    features.push(pointFeature(v.lat, v.lng, {
      id: v.id, icon: vehicleIconId(v.type, v.isNavigated ? '#4488FF' : v.color),
      nav: !!v.isNavigated, self: v.id === selfId, bearing: Number(v.bearing) || 0,
      label: `${v.type.toUpperCase()} · ${Math.round(v.speed)} km/h`,
    }));
  }
  return fc(features);
}

export function heatData(zones: CongestionZone[], show: boolean): FC {
  if (!show) return EMPTY;
  return fc(zones.map(z => pointFeature(z.centerLat, z.centerLng, {
    color: z.level > 0.7 ? '#FF1744' : z.level > 0.4 ? '#FF9100' : '#FFEB3B',
    r: Math.max(15, Math.min(50, z.vehicles * 5)),
    fill: z.level * 0.3,
  })));
}

export function linesData(lines: (LatLng[] | undefined)[]): FC {
  return fc(lines.filter((l): l is LatLng[] => !!l && l.length > 1).map(l => lineFeature(l)));
}

export function reportsData(reports: RoadReport[], graph: RoadGraph): { blocks: FC; areas: FC; icons: FC } {
  const blocks: Feature<Geometry, Props>[] = [];
  const areas: Feature<Geometry, Props>[] = [];
  const icons: Feature<Geometry, Props>[] = [];
  for (const r of reports) {
    const confirmed = r.status === 'confirmed';
    if (r.type === 'block') {
      for (const id of r.edgeIds) {
        const geom = graph.edges.get(id)?.geometry;
        if (geom && geom.length > 1) blocks.push(lineFeature(geom.map(p => [p.lat, p.lng]), { confirmed }));
      }
    } else {
      const rain = r.type === 'rain';
      areas.push(circlePolygon(r.lat, r.lng, r.radius, {
        confirmed,
        color: rain ? '#64B5F6' : '#2196F3',
        fill: (rain ? 0.08 : 0.22) * (confirmed ? 1 : 0.6),
      }));
    }
    icons.push(pointFeature(r.lat, r.lng, { confirmed, icon: emojiIconId(REPORT_LABEL[r.type].icon, 26, !confirmed) }));
  }
  return { blocks: fc(blocks), areas: fc(areas), icons: fc(icons) };
}
