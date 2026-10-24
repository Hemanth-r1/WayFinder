/**
 * Where Bangalore's road data comes from:
 * 1. The snapshot bundled with the server (`data/bangalore-osm.json.gz`), built by
 *    `npm run build:osm` — fast, works offline, same network on every start.
 * 2. Live Overpass API (several mirrors, in tiles) if the snapshot is missing.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompactOsm, CompactWay } from './osmGraph.js';

/** Greater Bangalore: Yelahanka to Electronic City, Kengeri to Whitefield. [south, west, north, east] */
export const BANGALORE_BBOX: [number, number, number, number] = [12.80, 77.42, 13.20, 77.82];

export const SNAPSHOT_PATH = fileURLToPath(new URL('../data/bangalore-osm.json.gz', import.meta.url));

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
/** Every road a car, auto or bike can drive on (residential included) */
const ROAD_FILTER = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)(_link)?$';

interface OverpassElement {
  type: string; id: number; lat?: number; lon?: number;
  nodes?: number[]; tags?: Record<string, string>;
}

/** Overpass JSON → compact snapshot (only the tags the graph builder reads). */
export function compactFromOverpass(elements: OverpassElement[], source: string, bbox = BANGALORE_BBOX): CompactOsm {
  const nodes = new Map<number, [number, number, number]>();
  const signals = new Set<number>();
  const signalNames: Record<string, string> = {};
  const places: [string, number, number][] = [];
  const ways = new Map<number, CompactWay>();
  for (const el of elements) {
    if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
      nodes.set(el.id, [el.id, el.lat, el.lon]);
      const placeName = el.tags?.['name:en'] || el.tags?.name;
      if (el.tags?.place && placeName) places.push([placeName, el.lat, el.lon]);
      if (el.tags?.highway === 'traffic_signals') {
        signals.add(el.id);
        const name = el.tags['name:en'] || el.tags.name;
        if (name) signalNames[String(el.id)] = name;
      }
    } else if (el.type === 'way' && el.nodes && el.tags?.highway) {
      const t = el.tags;
      const w: CompactWay = { id: el.id, nodes: el.nodes, hw: t.highway };
      if (t.name) w.name = t['name:en'] || t.name;
      if (t.oneway) w.oneway = t.oneway;
      if (t.lanes) w.lanes = t.lanes;
      if (t.maxspeed) w.maxspeed = t.maxspeed;
      if (t.junction) w.junction = t.junction;
      if (t.bridge) w.bridge = t.bridge;
      if (t.layer) w.layer = t.layer;
      ways.set(el.id, w);
    }
  }
  // Signals are fetched for the whole box; keep only those on a fetched road
  const onRoad = new Set<number>();
  for (const w of ways.values()) for (const n of w.nodes) onRoad.add(n);
  return {
    source, fetchedAt: new Date().toISOString(), bbox,
    nodes: [...nodes.values()].filter(([id]) => onRoad.has(id)),
    ways: [...ways.values()],
    signals: [...signals].filter(id => onRoad.has(id)),
    signalNames,
    places,
  };
}

async function fetchTile(bbox: string, timeoutMs: number): Promise<OverpassElement[]> {
  const query = `[out:json][timeout:300];(way["highway"~"${ROAD_FILTER}"]["access"!~"^(private|no)$"](${bbox});)->.w;` +
    `node["highway"="traffic_signals"](${bbox})->.s;(.w;.s;);out body;.w >;out skel qt;`;
  return fetchQuery(query, timeoutMs);
}

/** Runs an Overpass query against each mirror in turn (two tries each). */
async function fetchQuery(query: string, timeoutMs: number): Promise<OverpassElement[]> {
  let lastErr: unknown;
  for (const url of OVERPASS_MIRRORS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          body: `data=${encodeURIComponent(query)}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        const data = await res.json() as { elements: OverpassElement[] };
        return data.elements;
      } catch (err) {
        lastErr = err;
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  throw lastErr;
}

/** Downloads Bangalore's main roads and signals from Overpass in a 2×2 grid of tiles. */
export async function fetchBangaloreFromOverpass(timeoutMs = 120_000): Promise<CompactOsm> {
  // 4×4 tiles: with residential streets a quarter of the city is too much for one query
  const [s, w, n, e] = BANGALORE_BBOX;
  const tiles: number[][] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    tiles.push([s + (n - s) * r / 4, w + (e - w) * c / 4, s + (n - s) * (r + 1) / 4, w + (e - w) * (c + 1) / 4]);
  }
  const elements: OverpassElement[] = [];
  // Neighbourhood names, for directions like "from Nagasandra"
  const [ps, pw, pn, pe] = BANGALORE_BBOX;
  try {
    elements.push(...await fetchQuery(
      `[out:json][timeout:120];node["place"~"^(suburb|neighbourhood|quarter|locality|village|town)$"]["name"](${ps},${pw},${pn},${pe});out body;`,
      timeoutMs));
  } catch (err) {
    console.warn('[OSM] Place names unavailable:', (err as Error).message);
  }
  for (const t of tiles) {
    const els = await fetchTile(t.join(','), timeoutMs);
    console.log(`[OSM] Tile ${t.map(v => v.toFixed(2)).join(',')}: ${els.length} elements`);
    elements.push(...els);
  }
  return compactFromOverpass(elements, 'Overpass API (live)');
}

export async function readSnapshot(path = SNAPSHOT_PATH): Promise<CompactOsm | null> {
  if (!existsSync(path)) return null;
  const buf = await readFile(path);
  return JSON.parse(gunzipSync(buf).toString('utf8')) as CompactOsm;
}

export async function writeSnapshot(osm: CompactOsm, path = SNAPSHOT_PATH): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  const gz = gzipSync(Buffer.from(JSON.stringify(osm)), { level: 9 });
  await writeFile(path, gz);
  return gz.length;
}
