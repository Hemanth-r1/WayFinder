/**
 * Offline Bangalore: registers the service worker and downloads everything the map
 * needs for Greater Bangalore into the device cache — vector tiles (zoom 0–14; the map
 * over-zooms beyond), both map styles, their sprites and fonts (Latin + Kannada).
 * The road network, junctions and signals are kept in IndexedDB by the graph loader.
 */
import { MAP_STYLES } from '../components/mapLayers';

/** Same box the server simulates: [south, west, north, east]. */
const BBOX = [12.80, 77.42, 13.20, 77.82] as const;
const MAX_ZOOM = 14;
const MAP_CACHE = 'wf-map-v1';
/** Glyph ranges: Latin, Latin-extended, Kannada (U+0C80–0CFF), punctuation */
const GLYPH_RANGES = ['0-255', '256-511', '3072-3327', '8192-8447'];
const PARALLEL = 6;

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('[Offline] Service worker failed:', err));
  });
}

function lng2tile(lng: number, z: number) { return Math.floor((lng + 180) / 360 * 2 ** z); }
function lat2tile(lat: number, z: number) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z);
}

interface StyleJson {
  sources: Record<string, { url?: string; tiles?: string[] }>;
  sprite?: string;
  glyphs?: string;
  layers: { layout?: { 'text-font'?: string[] | unknown } }[];
}

/** Every URL the offline map needs. */
async function offlineUrls(): Promise<string[]> {
  const urls = new Set<string>();
  const tileTemplates = new Set<string>();
  for (const styleUrl of Object.values(MAP_STYLES)) {
    urls.add(styleUrl);
    const style = await (await fetch(styleUrl)).json() as StyleJson;
    for (const src of Object.values(style.sources)) {
      if (src.url) {
        urls.add(src.url);
        const tj = await (await fetch(src.url)).json() as { tiles?: string[]; maxzoom?: number };
        for (const t of tj.tiles ?? []) tileTemplates.add(t);
      }
      for (const t of src.tiles ?? []) tileTemplates.add(t);
    }
    if (style.sprite) {
      for (const suffix of ['', '@2x']) { urls.add(`${style.sprite}${suffix}.json`); urls.add(`${style.sprite}${suffix}.png`); }
    }
    if (style.glyphs) {
      const stacks = new Set<string>();
      for (const l of style.layers) {
        const f = l.layout?.['text-font'];
        if (Array.isArray(f) && f.every(x => typeof x === 'string')) stacks.add(f.join(','));
      }
      for (const stack of stacks) for (const range of GLYPH_RANGES) {
        urls.add(style.glyphs.replace('{fontstack}', encodeURIComponent(stack)).replace('{range}', range));
      }
    }
  }
  const [s, w, n, e] = BBOX;
  for (const template of tileTemplates) {
    for (let z = 0; z <= MAX_ZOOM; z++) {
      for (let x = lng2tile(w, z); x <= lng2tile(e, z); x++) {
        for (let y = lat2tile(n, z); y <= lat2tile(s, z); y++) {
          urls.add(template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
        }
      }
    }
  }
  return [...urls];
}

export interface OfflineProgress { done: number; total: number; failed: number; bytes: number }

/** Downloads (or tops up) the offline map. Already cached files are skipped. */
export async function downloadOfflineMap(onProgress: (p: OfflineProgress) => void, signal?: AbortSignal): Promise<OfflineProgress> {
  const cache = await caches.open(MAP_CACHE);
  const urls = await offlineUrls();
  const p: OfflineProgress = { done: 0, total: urls.length, failed: 0, bytes: 0 };
  let next = 0;
  const worker = async () => {
    while (next < urls.length && !signal?.aborted) {
      const url = urls[next++];
      try {
        if (!(await cache.match(url))) {
          const res = await fetch(url, { signal });
          if (res.ok) {
            const blob = await res.clone().blob();
            p.bytes += blob.size;
            await cache.put(url, res);
          } else if (res.status !== 204 && res.status !== 404) {
            p.failed++; // 404 = no tile there (empty area)
          }
        }
      } catch {
        if (!signal?.aborted) p.failed++;
      }
      p.done++;
      if (p.done % 20 === 0 || p.done === p.total) onProgress({ ...p });
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  onProgress({ ...p });
  localStorage.setItem('wf-offline-map', JSON.stringify({ at: Date.now(), total: p.total, failed: p.failed }));
  return p;
}

/** When the offline map was last downloaded (null if never). */
export function offlineMapInfo(): { at: number; total: number; failed: number } | null {
  try {
    const raw = localStorage.getItem('wf-offline-map');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Storage used by this site (MB), when the browser reports it. */
export async function storageUsedMb(): Promise<number | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    return est?.usage !== undefined ? Math.round(est.usage / 1e6) : null;
  } catch {
    return null;
  }
}
