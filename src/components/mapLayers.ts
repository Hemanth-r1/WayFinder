/**
 * MapLibre sources, layers and icons for WayFinder's overlay
 * (roads, traffic, routes, reports) drawn on top of OpenFreeMap vector tiles.
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

const VEHICLE_ICONS: Record<string, string> = {
  sedan: '🚗', suv: '🚙', hatchback: '🚗', truck: '🚚',
  bus: '🚌', emergency: '🚨', bike: '🛵', auto: '🛺', van: '📦',
};

export const SRC = {
  roads: 'wf-roads',
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
// Emoji can't come from the style's font server, so they are drawn to a canvas
// on demand. Icon ids: `wf-e:<css px>:<1 = "?" badge>:<emoji>` and `wf-puck`.

const PIXEL_RATIO = 2;

function emojiIconId(emoji: string, size: number, badge = false): string {
  return `wf-e:${size}:${badge ? 1 : 0}:${emoji}`;
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
  } else if (id.startsWith('wf-e:')) {
    const [, size, badge, ...rest] = id.split(':');
    img = drawEmoji(rest.join(':'), Number(size), badge === '1');
  }
  if (img) map.addImage(id, img, { pixelRatio: PIXEL_RATIO });
}

// ── Layers ───────────────────────────────────────────────────────────────────

/** Signals thin out as you zoom in: all junctions below z14, 2+ roads to z16, then 3+. */
const SIGNAL_OPACITY: ExpressionSpecification = [
  'step', ['zoom'],
  0.9,
  14, ['case', ['>=', ['get', 'deg'], 2], 0.9, 0],
  16, ['case', ['>=', ['get', 'deg'], 3], 0.9, 0],
];

export function addOverlayLayers(map: MLMap, opts: { showRoads: boolean }): void {
  for (const id of Object.values(SRC)) map.addSource(id, { type: 'geojson', data: EMPTY });

  const round = { 'line-join': 'round', 'line-cap': 'round' } as const;

  map.addLayer({
    id: 'wf-roads', type: 'line', source: SRC.roads,
    layout: { ...round, visibility: opts.showRoads ? 'visible' : 'none' },
    paint: {
      'line-color': ['match', ['get', 'cls'], 'primary', '#FF6D00', 'secondary', '#FF9100', '#FFAB40'],
      'line-width': ['match', ['get', 'cls'], 'primary', 4, 'secondary', 3, 1.5],
      'line-opacity': ['match', ['get', 'cls'], 'primary', 0.85, 'secondary', 0.65, 0.4],
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
  map.addLayer({
    id: LAYER.signals, type: 'circle', source: SRC.signals,
    paint: {
      'circle-radius': ['get', 'r'], 'circle-color': ['get', 'color'],
      'circle-opacity': SIGNAL_OPACITY, 'circle-stroke-opacity': SIGNAL_OPACITY,
      'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'wf-vehicle-glow', type: 'circle', source: SRC.vehicles, filter: ['!', ['get', 'self']],
    paint: {
      'circle-radius': ['case', ['get', 'nav'], 12, 8],
      'circle-color': ['case', ['get', 'nav'], '#4488FF', ['get', 'color']],
      'circle-blur': 0.8, 'circle-opacity': 0.5,
    },
  });
  map.addLayer({
    id: LAYER.vehicles, type: 'symbol', source: SRC.vehicles, filter: ['!', ['get', 'self']],
    layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true },
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

export function roadsData(graph: RoadGraph): FC {
  const drawn = new Set<string>();
  const features: Feature<Geometry, Props>[] = [];
  for (const edge of graph.edges.values()) {
    const key = [edge.from, edge.to].sort().join('|');
    if (drawn.has(key)) continue;
    drawn.add(key);
    if (!edge.geometry || edge.geometry.length < 2) continue;
    const cls = edge.roadType === 'primary' || edge.roadType === 'motorway' || edge.roadType === 'trunk'
      ? 'primary' : edge.roadType === 'secondary' ? 'secondary' : 'minor';
    features.push(lineFeature(edge.geometry.map(p => [p.lat, p.lng]), { cls }));
  }
  return fc(features);
}

export function signalsData(signals: Map<string, TrafficSignal>, graph: RoadGraph): FC {
  const hasRoads = graph.edges.size > 0;
  const features: Feature<Geometry, Props>[] = [];
  for (const sig of signals.values()) {
    const node = graph.nodes.get(sig.nodeId);
    if (!node) continue;
    const phase = sig.phases[sig.currentPhaseIndex];
    const color = phase.color === 'GREEN' ? '#00E676' : phase.color === 'YELLOW' ? '#FFD600' : '#FF1744';
    features.push(pointFeature(node.lat, node.lng, {
      id: sig.id, color, r: phase.color === 'GREEN' ? 7 : 5.5,
      // Without roads there's nothing to compare against, so show every signal
      deg: hasRoads ? (graph.adjacency.get(sig.nodeId)?.length ?? 0) : 99,
    }));
  }
  return fc(features);
}

export function vehiclesData(vehicles: Map<string, Vehicle>, selfId: string | undefined): FC {
  const features: Feature<Geometry, Props>[] = [];
  for (const v of vehicles.values()) {
    features.push(pointFeature(v.lat, v.lng, {
      id: v.id, icon: emojiIconId(VEHICLE_ICONS[v.type] ?? '🚗', 20), color: v.color,
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
