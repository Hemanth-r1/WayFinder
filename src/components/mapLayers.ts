/**
 * MapLibre sources, layers and icons for WayFinder's overlay (traffic, signals,
 * vehicles, routes, reports) drawn on top of OpenFreeMap vector tiles.
 */
import type { Map as MLMap, GeoJSONSource, ExpressionSpecification } from 'maplibre-gl';
import type { FeatureCollection, Feature, Geometry } from 'geojson';
import type { RoadGraph, RoadEdge, TrafficSignal, Vehicle, CongestionZone } from '../types';
import type { RoadReport } from '../services/serverClient';
import { REPORT_LABEL } from '../utils/reports';

/** Free vector map styles, no API key (https://openfreemap.org). */
export const MAP_STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
} as const;

export const SRC = {
  roads: 'wf-roads',
  marks: 'wf-marks',
  trafficBase: 'wf-traffic-base',
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
  coord: 'wf-coord',
  emergency: 'wf-emergency',
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
  xuv: { len: 16, wid: 7.8 },
  tempo: { len: 15, wid: 7.5 },
  minitruck: { len: 17, wid: 7.8 },
  truck: { len: 24, wid: 8.5 },
  lorry: { len: 28, wid: 9 },
  tipper: { len: 25, wid: 9 },
  trailer: { len: 40, wid: 9.5 },
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
/** Real vehicle lengths (m), as in the simulation. */
const REAL_LENGTH: Record<string, number> = {
  bike: 2, auto: 2.8, hatchback: 3.8, sedan: 4.5, suv: 4.4, xuv: 4.9, van: 5, tempo: 4.6, minitruck: 5.5,
  truck: 8, lorry: 10, tipper: 8.5, trailer: 16, bus: 12, emergency: 5,
};
/** Icon scale that draws a vehicle at its real length (k = real metres / icon px). */
function realScale(type: string): number {
  const shape = VEHICLE_SHAPE[type] ?? VEHICLE_SHAPE.sedan;
  return (REAL_LENGTH[type] ?? 4.5) / shape.len;
}
/** Px per metre at zoom 16 in Bangalore (512 px tiles, latitude ~13°). */
const ICON_PX_PER_M_Z16 = (65536 * 512) / (40075016 * Math.cos(12.97 * Math.PI / 180));
// Zoomed out: enlarged so vehicles stay visible. From zoom 17: true size, so the gaps
// between queued vehicles are real (enlarged icons looked like collisions)
const VEHICLE_SIZE = ['interpolate', ['exponential', 2], ['zoom'],
  13, 0.3, 16, 0.45,
  17, ['*', ['get', 'k'], ICON_PX_PER_M_Z16 * 2],
  22, ['*', ['get', 'k'], ICON_PX_PER_M_Z16 * 64]] as unknown as ExpressionSpecification;

export function addOverlayLayers(map: MLMap, opts: { showRoads: boolean }): void {
  // maxzoom 15: MapLibre cuts tiles up to zoom 15 and over-zooms beyond (default 18 re-cuts
  // at every level — slower, and the ~0.1 m precision at 15 is plenty)
  for (const id of Object.values(SRC)) map.addSource(id, { type: 'geojson', data: EMPTY, maxzoom: 15 });

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
  // Zoomed in: carriageway at its real width with lane markings, matching the lanes the
  // simulation drives in (3.2 m each; a two-way road's directions either side of the centre)
  const metres = (prop: string) => ['interpolate', ['exponential', 2], ['zoom'],
    16, ['*', ['get', prop], PX_PER_METRE_Z16], 22, ['*', ['get', prop], PX_PER_METRE_Z16 * 64]] as never;
  map.addLayer({
    id: 'wf-carriageway', type: 'line', source: SRC.marks, minzoom: 16.5, filter: ['==', ['get', 'k'], 'road'],
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: { 'line-color': '#5F6670', 'line-width': metres('w'), 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'wf-mark-edge', type: 'line', source: SRC.marks, minzoom: 16.5, filter: ['==', ['get', 'k'], 'edge'],
    paint: { 'line-color': '#F5F5F5', 'line-width': 1.2, 'line-offset': metres('m'), 'line-opacity': 0.85 },
  });
  map.addLayer({
    id: 'wf-mark-centre', type: 'line', source: SRC.marks, minzoom: 16.5, filter: ['==', ['get', 'k'], 'centre'],
    paint: { 'line-color': '#FFFFFF', 'line-width': ['interpolate', ['linear'], ['zoom'], 17, 1.5, 20, 3], 'line-opacity': 0.95 },
  });
  map.addLayer({
    id: 'wf-mark-centre-dash', type: 'line', source: SRC.marks, minzoom: 16.5, filter: ['==', ['get', 'k'], 'centre-dash'],
    paint: { 'line-color': '#FFFFFF', 'line-width': ['interpolate', ['linear'], ['zoom'], 17, 1.3, 20, 2.5], 'line-dasharray': [4, 4], 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'wf-mark-lane', type: 'line', source: SRC.marks, minzoom: 16.5, filter: ['==', ['get', 'k'], 'lane'],
    paint: { 'line-color': '#FFFFFF', 'line-width': ['interpolate', ['linear'], ['zoom'], 17, 1, 20, 2], 'line-dasharray': [3, 5], 'line-offset': metres('m'), 'line-opacity': 0.8 },
  });

  // Live traffic, each direction on its own side of the road (India drives on the left)
  // Every road the browser has, drawn once (minor roads thinner, from zoom 13); slow and
  // jammed stretches are drawn over them
  const minor = (major: number, small: number) => ['case', ['==', ['get', 'mn'], 1], small, major];
  map.addLayer({
    id: 'wf-traffic-base', type: 'line', source: SRC.trafficBase, layout: round,
    paint: {
      'line-color': TRAFFIC_COLORS[0],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, minor(1.2, 0.4), 13, minor(2.5, 1.2), 16, minor(4, 2.5), 19, minor(7, 4)] as never,
      'line-offset': ['interpolate', ['linear'], ['zoom'], 12, 0, 15, ['*', -2, ['get', 'tw']], 19, ['*', -6, ['get', 'tw']]],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, minor(0.75, 0), 13, minor(0.75, 0.6), 17, 0.55, 19, 0.45] as never,
    },
  });
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
  // Wrong-way riders (red) and red-light jumpers (orange)
  map.addLayer({
    id: 'wf-vehicle-flag', type: 'circle', source: SRC.vehicles, minzoom: 14,
    filter: ['!=', ['get', 'flag'], ''],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 6, 18, 14],
      'circle-color': ['match', ['get', 'flag'], 'wrong', '#FF1744', 'emg', '#2979FF', '#FF9100'],
      'circle-opacity': 0.35, 'circle-stroke-width': 1.5,
      'circle-stroke-color': ['match', ['get', 'flag'], 'wrong', '#FF1744', 'emg', '#FF1744', '#FF9100'],
    },
  });
  map.addLayer({
    id: LAYER.vehicles, type: 'symbol', source: SRC.vehicles, filter: ['!', ['get', 'self']],
    layout: {
      'icon-image': ['get', 'icon'], 'icon-size': VEHICLE_SIZE,
      'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
  });
  // Stop lines: where each approach waits, coloured by its light (from zoom 16)
  map.addLayer({
    id: 'wf-stoplines', type: 'line', source: SRC.signals, minzoom: 16, filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'butt' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 16, 2.5, 19, 7], 'line-opacity': 0.95 },
  });
  // Zoomed out: one dot per junction (main road's light). Zoomed in: every signal head.
  map.addLayer({
    id: LAYER.signals, type: 'circle', source: SRC.signals, minzoom: 12, filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      // Zoom must be the outer expression in MapLibre; per-feature size inside it
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        12, ['case', ['get', 'head'], 2, 3],
        15, ['case', ['get', 'head'], 4, 6],
        16, ['case', ['get', 'head'], 5, 7],
        19, ['case', ['get', 'head'], 9, 10]],
      'circle-color': ['get', 'color'],
      'circle-opacity': ['step', ['zoom'], ['case', ['get', 'head'], 0, 1], 16, ['case', ['get', 'head'], 1, 0]],
      'circle-stroke-opacity': ['step', ['zoom'], ['case', ['get', 'head'], 0, 1], 16, ['case', ['get', 'head'], 1, 0]],
      'circle-stroke-color': '#111', 'circle-stroke-width': ['case', ['get', 'head'], 2.5, 1.5],
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
  // Emergency runs: the vehicle's route, and the signals on it (green once cleared for it)
  map.addLayer({
    id: 'wf-emergency-route', type: 'line', source: SRC.emergency, filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#FF1744', 'line-width': 5, 'line-opacity': 0.75, 'line-dasharray': [1.5, 1] },
  });
  map.addLayer({
    id: 'wf-emergency-signal', type: 'circle', source: SRC.emergency, filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': ['case', ['get', 'vehicle'], 11, 8],
      'circle-color': ['match', ['get', 'state'], 'green', '#00E676', 'passed', '#555555', 'vehicle', '#FF1744', '#FF9100'],
      'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': 2, 'circle-opacity': 0.9,
    },
  });
  // Coordination preview: what a green at one junction does to its neighbours
  map.addLayer({
    id: 'wf-coord-line', type: 'line', source: SRC.coord, filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.9, 'line-dasharray': [2, 1.5] },
  });
  map.addLayer({
    id: 'wf-coord-dot', type: 'circle', source: SRC.coord, filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': ['case', ['get', 'centre'], 13, 10], 'circle-color': ['get', 'color'], 'circle-opacity': 0.25,
      'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 3,
    },
  });
  map.addLayer({
    id: 'wf-coord-label', type: 'symbol', source: SRC.coord, filter: ['==', ['geometry-type'], 'Point'],
    layout: {
      'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 12,
      'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-allow-overlap': true, 'text-max-width': 14,
    },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.5 },
  });
}

/** Active emergency runs: route lines, their signals and the vehicles. */
export function emergencyData(corridors: { status: string; geometry: { lat: number; lng: number }[]; signals: { lat: number; lng: number; state: string }[]; position?: { lat: number; lng: number } }[]): FC {
  const features: Feature<Geometry, Props>[] = [];
  for (const c of corridors) {
    if (c.status !== 'active') continue;
    features.push(lineFeature(c.geometry.map(p => [p.lat, p.lng] as LatLng), {}));
    for (const s of c.signals) features.push(pointFeature(s.lat, s.lng, { state: s.state, vehicle: false }));
    if (c.position) features.push(pointFeature(c.position.lat, c.position.lng, { state: 'vehicle', vehicle: true }));
  }
  return fc(features);
}

/** Colours of coordination actions on the map and in the console. */
export const COORD_COLOR = { centre: '#00E676', 'wave-out': '#4FC3F7', 'wave-in': '#B388FF', gate: '#FF9100' } as const;

/** A coordination plan drawn as the junction, its affected neighbours and a line to each. */
export function coordinationData(plan: {
  lat: number; lng: number; holdSeconds: number; road: string;
  actions: { kind: 'wave-out' | 'wave-in' | 'gate'; lat: number; lng: number; name: string; startIn: number; seconds: number; factor?: number }[];
} | null): FC {
  if (!plan) return EMPTY;
  const features: Feature<Geometry, Props>[] = [];
  for (const a of plan.actions) {
    const color = COORD_COLOR[a.kind];
    const ends: LatLng[] = a.kind === 'wave-out' ? [[plan.lat, plan.lng], [a.lat, a.lng]] : [[a.lat, a.lng], [plan.lat, plan.lng]];
    features.push(lineFeature(ends, { color }));
    const what = a.kind === 'gate' ? `green ${Math.round((a.factor ?? 0.6) * 100)}% for ${a.seconds}s`
      : a.startIn > 0 ? `green in ${a.startIn}s for ${a.seconds}s` : `green ${a.seconds}s`;
    features.push(pointFeature(a.lat, a.lng, { color, label: `${a.name}\n${what}`, centre: false }));
  }
  features.push(pointFeature(plan.lat, plan.lng, { color: COORD_COLOR.centre, label: `${plan.road}\ngreen ${plan.holdSeconds}s`, centre: true }));
  return fc(features);
}

// ── GeoJSON builders ─────────────────────────────────────────────────────────

const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary']);

/** Screen pixels per metre at zoom 16 in Bangalore (512 px tiles, latitude ~13°). */
const PX_PER_METRE_Z16 = (65536 * 512) / (40075016 * Math.cos(12.97 * Math.PI / 180));
const LANE_M = 3.2;

/**
 * Carriageways and lane markings for the roads in view (zoom ≥ 16.5): centre line on
 * two-way roads (solid on multi-lane roads, broken on narrow ones), broken lines between
 * lanes, solid edge lines. Offsets are in metres (+ = right of the drawn direction).
 */
export function markingsData(graph: RoadGraph, bbox: [number, number, number, number]): FC {
  const [w, s, e, n] = bbox;
  const features: Feature<Geometry, Props>[] = [];
  const drawn = new Set<string>();
  for (const edge of graph.edges.values()) {
    const g = edge.geometry;
    if (!g || g.length < 2) continue;
    if (!g.some(p => p.lng >= w && p.lng <= e && p.lat >= s && p.lat <= n)) continue;
    const key = edge.from < edge.to ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`;
    if (drawn.has(key)) continue;
    drawn.add(key);
    const line = g.map(p => [p.lat, p.lng] as LatLng);
    const add = (k: string, props: Props = {}) => features.push(lineFeature(line, { k, ...props }));
    const fwd = Math.max(1, edge.lanes);
    if (edge.oneway) {
      add('road', { w: fwd * LANE_M + 0.6 });
      for (let k = 0; k <= fwd; k++) add(k === 0 || k === fwd ? 'edge' : 'lane', { m: -(fwd / 2 - k) * LANE_M });
      continue;
    }
    const rev = Math.max(1, (graph.adjacency.get(edge.to) ?? []).find(r => r.to === edge.from)?.lanes ?? fwd);
    // Lanes of this direction lie left of the centre, the other direction's right of it
    const half = Math.max(fwd, rev);
    add('road', { w: half * 2 * LANE_M + 0.6 });
    add(fwd + rev >= 4 ? 'centre' : 'centre-dash');
    for (let k = 1; k < fwd; k++) add('lane', { m: -k * LANE_M });
    for (let k = 1; k < rev; k++) add('lane', { m: k * LANE_M });
    add('edge', { m: -fwd * LANE_M });
    add('edge', { m: rev * LANE_M });
  }
  return fc(features);
}

type BBox = [number, number, number, number];

/** True if any point of the shape lies in the box. */
function inBox(g: { lat: number; lng: number }[], [w, s, e, n]: BBox): boolean {
  for (const p of g) if (p.lng >= w && p.lng <= e && p.lat >= s && p.lat <= n) return true;
  return false;
}

export function roadsData(graph: RoadGraph, bbox: BBox): FC {
  const drawn = new Set<string>();
  const features: Feature<Geometry, Props>[] = [];
  for (const edge of graph.edges.values()) {
    if (!edge.geometry || !inBox(edge.geometry, bbox)) continue;
    const key = edge.from < edge.to ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`;
    if (drawn.has(key)) continue;
    drawn.add(key);
    if (!edge.geometry || edge.geometry.length < 2) continue;
    features.push(lineFeature(edge.geometry.map(p => [p.lat, p.lng])));
  }
  return fc(features);
}

/**
 * Roads in the view (plus margin), each direction (`tw` = 1 on two-way roads so each direction sits on its
 * own side). Built once per road network: this is the green "flowing" layer.
 */
export function trafficBaseData(graph: RoadGraph, bbox: BBox, zoom: number): FC {
  const features: Feature<Geometry, Props>[] = [];
  for (const edge of graph.edges.values()) {
    if (!edge.geometry || edge.geometry.length < 2) continue;
    // Zoomed out: main roads only (smaller ones are hidden there anyway)
    if (zoom < 13 && !MAJOR.has(edge.roadType)) continue;
    if (!inBox(edge.geometry, bbox)) continue;
    features.push(lineFeature(edge.geometry.map(p => [p.lat, p.lng]), { tw: edge.oneway ? 0 : 1, mn: MAJOR.has(edge.roadType) ? 0 : 1 }));
  }
  return fc(features);
}

/** Only the slow and jammed stretches (a few hundred), redrawn every few seconds. */
export function trafficData(graph: RoadGraph, traffic: Map<string, number>): FC {
  const features: Feature<Geometry, Props>[] = [];
  for (const [id, level] of traffic) {
    if (level <= 0) continue;
    const edge = graph.edges.get(id);
    if (!edge?.geometry || edge.geometry.length < 2) continue;
    features.push(lineFeature(edge.geometry.map(p => [p.lat, p.lng]), { level, tw: edge.oneway ? 0 : 1 }));
  }
  features.sort((a, b) => (a.properties.level as number) - (b.properties.level as number));
  return fc(features);
}

/** Colour a phase group sees now. */
function groupColor(sig: TrafficSignal, group: string): string {
  const phase = sig.phases[sig.currentPhaseIndex];
  if (!phase || phase.group !== group) return '#FF1744';
  return phase.color === 'GREEN' ? '#00E676' : phase.color === 'YELLOW' ? '#FFD600' : '#FF1744';
}

/** Colour shown to the junction's main road (phase group 'A'; legacy graphs: 'NS'). */
export function signalColor(sig: TrafficSignal): string {
  return groupColor(sig, sig.phases.some(p => p.group === 'A') ? 'A' : 'NS');
}

/**
 * Stop line of an approach: across its lanes, 1.5 m before the end of the road, on the left
 * half of a two-way road (India drives on the left) or across a one-way road.
 */
function stopLine(edge: RoadEdge, graph: RoadGraph): LatLng[] | null {
  const g = edge.geometry;
  if (!g || g.length < 2) return null;
  const p = g[g.length - 1], q = g[g.length - 2];
  const kx = 111320 * Math.cos(p.lat * Math.PI / 180), ky = 111320;
  const de = (p.lng - q.lng) * kx, dn = (p.lat - q.lat) * ky, len = Math.hypot(de, dn) || 1;
  const ue = de / len, un = dn / len;          // along the road
  const le = -un, ln = ue;                      // to its left
  const lanes = Math.max(1, edge.lanes) * 3.2;
  const twoWay = !edge.oneway && graph.edges.has(`${edge.to}-${edge.from}`);
  const [a, b] = twoWay ? [0.3, lanes] : [-lanes / 2, lanes / 2];
  const back = Math.min(1.5, len * 0.5);
  const at = (o: number): LatLng => [p.lat + (-un * back + ln * o) / ky, p.lng + (-ue * back + le * o) / kx];
  return [at(a), at(b)];
}

export function signalsData(signals: Map<string, TrafficSignal>, graph: RoadGraph): FC {
  const features: Feature<Geometry, Props>[] = [];
  for (const sig of signals.values()) {
    const node = graph.nodes.get(sig.nodeId) ?? (sig.lat !== undefined && sig.lng !== undefined ? { lat: sig.lat, lng: sig.lng } : null);
    if (!node) continue;
    features.push(pointFeature(node.lat, node.lng, { id: sig.id, color: signalColor(sig), head: false }));
    // One head per approach (across the junction, facing it) and a stop line across the
    // approach's lanes, both in that approach's colour
    for (const arm of sig.arms ?? []) {
      const color = groupColor(sig, arm.group);
      features.push(pointFeature(arm.lat, arm.lng, { id: sig.id, color, head: true }));
      const edge = graph.edges.get(arm.edgeId);
      const line = edge && stopLine(edge, graph);
      if (line) features.push(lineFeature(line, { id: sig.id, color, stop: true }));
    }
  }
  return fc(features);
}

export function vehiclesData(vehicles: Iterable<Vehicle>, selfId: string | undefined): FC {
  const features: Feature<Geometry, Props>[] = [];
  for (const v of vehicles) {
    features.push(pointFeature(v.lat, v.lng, {
      id: v.id, icon: vehicleIconId(v.type, v.isNavigated ? '#4488FF' : v.color), k: realScale(v.type),
      nav: !!v.isNavigated, self: v.id === selfId, bearing: Number(v.bearing) || 0,
      flag: v.emergency ? 'emg' : v.wrongWay ? 'wrong' : v.violation ? 'red' : '',
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
    if (r.type === 'block' || r.type === 'tree') {
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
