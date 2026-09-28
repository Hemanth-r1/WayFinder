/**
 * Place search, road snapping and Google Maps hand-off for the navigation UI.
 */
import type { RoadGraph, RoadNode, GeoPoint } from '../types';

export interface Place {
  label: string;
  detail: string;
  lat: number;
  lng: number;
  source: 'road' | 'address' | 'gps' | 'map';
}

/** Bangalore bounding box used to keep geocoder results local. */
const BLR_VIEWBOX = { west: 77.35, north: 13.2, east: 77.85, south: 12.75 };
/** Farther than this from any road node counts as outside the covered area. */
const MAX_SNAP_METRES = 1500;

export function distanceMetres(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** Human-readable name for a road node, e.g. "MG Road & Brigade Rd". */
export function nodeLabel(graph: RoadGraph, nodeId: string): string {
  const names = [...new Set((graph.adjacency.get(nodeId) ?? []).map(e => e.name).filter(Boolean))] as string[];
  if (names.length === 0) return 'Unnamed road';
  return names.slice(0, 2).join(' & ');
}

/** Nearest routable node, or null when the point is outside the loaded road network. */
export function snapToRoad(graph: RoadGraph, lat: number, lng: number): RoadNode | null {
  let best: RoadNode | null = null;
  let bestDist = Infinity;
  for (const node of graph.nodes.values()) {
    if ((graph.adjacency.get(node.id)?.length ?? 0) === 0) continue;
    const d = (node.lat - lat) ** 2 + (node.lng - lng) ** 2;
    if (d < bestDist) { bestDist = d; best = node; }
  }
  if (!best || distanceMetres(best, { lat, lng }) > MAX_SNAP_METRES) return null;
  return best;
}

/** Roads in the loaded network whose name contains `query`, one result per road. */
function searchRoads(graph: RoadGraph, query: string, limit: number): Place[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const byName = new Map<string, GeoPoint[]>();
  for (const edge of graph.edges.values()) {
    if (!edge.name || !edge.name.toLowerCase().includes(q)) continue;
    const from = graph.nodes.get(edge.from);
    if (!from) continue;
    const pts = byName.get(edge.name);
    if (pts) pts.push(from); else byName.set(edge.name, [from]);
  }
  return [...byName]
    .sort(([a], [b]) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)) || a.localeCompare(b))
    .slice(0, limit)
    .map(([name, pts]) => {
      // Point on the road nearest its middle
      const mid = pts.reduce((s, p) => ({ lat: s.lat + p.lat / pts.length, lng: s.lng + p.lng / pts.length }), { lat: 0, lng: 0 });
      const at = pts.reduce((b, p) => distanceMetres(p, mid) < distanceMetres(b, mid) ? p : b);
      return { label: name, detail: 'Road', lat: at.lat, lng: at.lng, source: 'road' as const };
    });
}

interface NominatimResult { display_name: string; lat: string; lon: string; name?: string }

/** Addresses and landmarks from OpenStreetMap Nominatim, restricted to Bangalore. */
async function searchAddresses(query: string, signal?: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({
    q: query, format: 'jsonv2', limit: '5', countrycodes: 'in', bounded: '1', 'accept-language': 'en',
    viewbox: `${BLR_VIEWBOX.west},${BLR_VIEWBOX.north},${BLR_VIEWBOX.east},${BLR_VIEWBOX.south}`,
  });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { signal });
  if (!res.ok) return [];
  const results: NominatimResult[] = await res.json();
  return results.map(r => {
    const [first, ...rest] = r.display_name.split(', ');
    return {
      label: r.name || first,
      detail: rest.slice(0, 3).join(', '),
      lat: parseFloat(r.lat), lng: parseFloat(r.lon),
      source: 'address' as const,
    };
  });
}

/** Road-name matches first (instant, always available), then geocoder results. */
export async function searchPlaces(graph: RoadGraph, query: string, signal?: AbortSignal): Promise<Place[]> {
  const roads = searchRoads(graph, query, 4);
  if (query.trim().length < 3) return roads;
  let addresses: Place[] = [];
  try {
    addresses = await searchAddresses(query, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    // Geocoder unreachable — road matches still work
  }
  return [...roads, ...addresses];
}

/** Browser GPS position. */
export function currentPosition(): Promise<GeoPoint> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location is not available in this browser'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      err => reject(new Error(err.code === err.PERMISSION_DENIED
        ? 'Location permission was denied'
        : 'Could not get your location')),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  });
}

/**
 * Google Maps directions link that follows `geometry`. Google chooses its own roads
 * between waypoints, so a few evenly spaced points along this user's route keep it on
 * roughly the same path. Mobile browsers accept only a few waypoints.
 */
export function googleMapsUrl(geometry: GeoPoint[], opts: { waypoints?: number; navigate?: boolean } = {}): string | null {
  if (geometry.length < 2) return null;
  const count = opts.waypoints ?? 3;
  const cum = [0];
  for (let i = 1; i < geometry.length; i++) cum.push(cum[i - 1] + distanceMetres(geometry[i - 1], geometry[i]));
  const total = cum[cum.length - 1];

  const waypoints: GeoPoint[] = [];
  for (let k = 1; k <= count && total > 0; k++) {
    const target = (total * k) / (count + 1);
    const i = cum.findIndex(d => d >= target);
    if (i > 0) waypoints.push(geometry[i]);
  }
  const fmt = (p: GeoPoint) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const params = new URLSearchParams({
    api: '1',
    origin: fmt(geometry[0]),
    destination: fmt(geometry[geometry.length - 1]),
    travelmode: 'driving',
  });
  if (waypoints.length > 0) params.set('waypoints', waypoints.map(fmt).join('|'));
  if (opts.navigate) params.set('dir_action', 'navigate');
  return `https://www.google.com/maps/dir/?${params}`;
}
