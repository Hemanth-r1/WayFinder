import { serverClient } from './serverClient.ts';
import { dataCache } from './dataCache.ts';
import { saveToIndexedDB, loadFromIndexedDB, clearIndexedDBPrefix } from '../data/indexedDBCache';
import type { RoadGraph, RoadNode, TrafficSignal, RoadType, GeoPoint } from '../types';

/**
 * Road data as the server sends it (format 2): nodes as [id, lat, lng]; edges as
 * [id, from, to, name, roadType, speedLimit, lanes, length, bearing, geometry | null, oneway?].
 * A null geometry is the reverse direction of a two-way road: reuse the other one reversed.
 */
interface RawRoads {
  format: 2;
  nodes: [string, number, number][];
  edges: [string, string, string, string, string, number, number, number, number, [number, number][] | null, number?][];
}
interface RawGraphData extends RawRoads {
  signals: TrafficSignal[];
  source: string;
  version?: string;
}

/** IndexedDB key for the full road network saved for offline use. */
const GRAPH_KEY = 'bangalore-graph-v2';
/** Road tiles kept on the device: 'roads:/api/roads/<version>/…' (dropped when the version changes) */
const TILE_PREFIX = 'roads:';
/** The last road version seen, to open from the device when the server is slow */
const LAST_META_KEY = 'roads-meta-last';
/** Same grid as the server's road tiles (degrees). */
const CELL_DEG = 0.02;
/** Below this zoom only the main roads are needed (they come with the first load). */
const CELL_MIN_ZOOM = 13;
/** Extra margin around the view, so roads just off screen are there when you pan. */
const VIEW_MARGIN = 0.1;
const MAX_CELLS = 40;
/** If the server hasn't sent the roads by then, open from the copy saved on this device. */
const SLOW_START_MS = 3000;
/** Retries (every 5 s) while waiting for a sleeping or unreachable server. */
const ONLINE_RETRIES = 24;

export type LoadPhase = 'empty' | 'map' | 'roads' | 'signals' | 'vehicles' | 'full';

export interface LoadUpdate {
  phase: LoadPhase;
  source: string;
  graph?: RoadGraph;
  signals?: Map<string, TrafficSignal>;
  vehicles?: Map<string, any>;
  stats?: any;
}

/**
 * Loads the road network piece by piece: at start only the signals and the main roads
 * (small), then the ~2 km cells around what's on screen (plus a 10% margin) as the map
 * moves. Cells have fixed URLs, so the browser and CDN keep them; nothing is sent twice.
 * The whole network is downloaded only for offline use.
 */
export class ProgressiveLoader {
  private updateCallbacks: Set<(update: LoadUpdate) => void> = new Set();
  private currentPhase: LoadPhase = 'empty';
  private graph: RoadGraph = { nodes: new Map(), edges: new Map(), adjacency: new Map() };
  private signals = new Map<string, TrafficSignal>();
  private version = '';
  private source = '';
  private cells = new Set<string>();
  /** The whole network for this version is on the device: no road tiles are needed */
  private fullLocal = false;
  private view: { bbox: [number, number, number, number]; zoom: number } | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  onUpdate(callback: (update: LoadUpdate) => void): void {
    this.updateCallbacks.add(callback);
  }

  removeUpdateCallback(callback: (update: LoadUpdate) => void): void {
    this.updateCallbacks.delete(callback);
  }

  private notify(update: LoadUpdate): void {
    this.currentPhase = update.phase;
    for (const callback of this.updateCallbacks) callback(update);
  }

  /** Adds roads to the graph (the same Map objects, so the app keeps one graph). */
  private merge(raw: RawRoads): void {
    const { nodes, edges, adjacency } = this.graph;
    for (const [id, lat, lng] of raw.nodes) if (!nodes.has(id)) nodes.set(id, { id, lat, lng, isIntersection: true } as RoadNode);
    const shapes = new Map<string, GeoPoint[]>();
    for (const e of raw.edges) if (e[9]) shapes.set(e[0], e[9].map(([lat, lng]) => ({ lat, lng })));
    for (const [id, from, to, name, roadType, speedLimit, lanes, length, bearing, , oneway] of raw.edges) {
      if (edges.has(id)) continue;
      const reverse = edges.get(`${to}-${from}`);
      const geometry = shapes.get(id) ?? (reverse ? [...reverse.geometry].reverse() : [...(shapes.get(`${to}-${from}`) ?? [])].reverse());
      const edge = {
        id, from, to, name, roadType: roadType as RoadType, speedLimit, lanes, length, bearing,
        geometry: geometry.length >= 2 ? geometry : [nodes.get(from)!, nodes.get(to)!],
        congestionWeight: 0,
        oneway: oneway === undefined ? false : oneway === 1,
      };
      edges.set(id, edge);
      (adjacency.get(from) ?? adjacency.set(from, []).get(from)!).push(edge);
    }
    // Older full-graph format without the one-way flag: a road is one-way when no reverse exists
    if (raw.edges.length && raw.edges[0][10] === undefined) {
      for (const e of edges.values()) e.oneway = !edges.has(`${e.to}-${e.from}`);
    }
  }

  /** Tells the app the graph grew (batched: several cells arriving together → one redraw). */
  private changed(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.notify({ phase: 'full', source: this.source, graph: this.graph }); // more roads, not a loading step
    }, 50);
  }

  private async getJson<T>(path: string): Promise<T> {
    return serverClient.fetchRoads(path) as Promise<T>;
  }

  /**
   * A versioned road tile: from this device if saved before, else from the server (then
   * saved). Versioned tiles never change, so each is downloaded once per device.
   */
  private async tile<T>(path: string): Promise<T> {
    const saved = await loadFromIndexedDB<T>(TILE_PREFIX + path).catch(() => null);
    if (saved) return saved.data;
    const data = await this.getJson<T>(path);
    saveToIndexedDB(TILE_PREFIX + path, { data, timestamp: Date.now() }).catch(() => { /* storage full: still works online */ });
    return data;
  }

  /** Roads from the server: version, signals and main roads. Resolves once all have arrived. */
  private async loadOnline(): Promise<{ version: string; source: string; signals: TrafficSignal[]; main: RawRoads | null }> {
    const meta = await this.getJson<{ version: string; source: string }>('/api/roads/meta');
    saveToIndexedDB(LAST_META_KEY, { data: meta, timestamp: Date.now() }).catch(() => {});
    clearIndexedDBPrefix(TILE_PREFIX, `${TILE_PREFIX}/api/roads/${meta.version}/`).catch(() => {});
    // The full network of this very version is saved (offline download): roads come from it
    const saved = await loadFromIndexedDB<RawGraphData>(GRAPH_KEY).catch(() => null);
    if (saved?.data.format === 2 && saved.data.version === meta.version) {
      if (!this.fullLocal) this.merge(saved.data);
      this.fullLocal = true;
      return { ...meta, signals: saved.data.signals, main: null };
    }
    const [signals, main] = await Promise.all([
      this.tile<TrafficSignal[]>(`/api/roads/${meta.version}/signals`),
      this.tile<RawRoads>(`/api/roads/${meta.version}/main`),
    ]);
    return { ...meta, signals, main };
  }

  /** The full network saved on this device (offline download), if any. */
  private async loadSaved(): Promise<boolean> {
    const saved = await loadFromIndexedDB<RawGraphData>(GRAPH_KEY).catch(() => null);
    if (!saved || saved.data.format !== 2) return this.loadSavedTiles();
    this.merge(saved.data);
    this.signals = new Map(saved.data.signals.map(s => [s.id, { ...s, approaches: s.approaches ?? [] }]));
    this.source = `${saved.data.source} (saved on this device)`;
    return true;
  }

  /** No full download: the signals and main roads of the last version, if this device has them. */
  private async loadSavedTiles(): Promise<boolean> {
    const meta = await loadFromIndexedDB<{ version: string; source: string }>(LAST_META_KEY).catch(() => null);
    if (!meta) return false;
    const base = `${TILE_PREFIX}/api/roads/${meta.data.version}/`;
    const [signals, main] = await Promise.all([
      loadFromIndexedDB<TrafficSignal[]>(base + 'signals').catch(() => null),
      loadFromIndexedDB<RawRoads>(base + 'main').catch(() => null),
    ]);
    if (!signals || !main) return false;
    this.merge(main.data);
    this.signals = new Map(signals.data.map(s => [s.id, { ...s, approaches: s.approaches ?? [] }]));
    this.source = `${meta.data.source} (main roads saved on this device)`;
    return true;
  }

  private ready(): void {
    this.notify({ phase: 'roads', source: this.source, graph: this.graph, signals: this.signals });
    this.notify({ phase: 'signals', source: this.source, signals: this.signals });
    this.notify({ phase: 'full', source: this.source });
    if (this.view) this.loadView(this.view.bbox, this.view.zoom);
  }

  /**
   * Starts from the server; if it hasn't answered within SLOW_START_MS (it sleeps when
   * nobody uses it and takes a while to wake) or can't be reached, opens from the copy
   * saved on this device and switches to the server's roads and live data once it answers.
   */
  async load(): Promise<void> {
    this.notify({ phase: 'map', source: 'tiles' });
    dataCache.remove('graph'); // drop graphs cached by older versions (could be the demo grid)
    let online = this.loadOnline();
    const first = await Promise.race([
      online.then(() => 'online' as const, () => 'failed' as const),
      new Promise<'slow'>(r => setTimeout(() => r('slow'), SLOW_START_MS)),
    ]);
    let fromDevice = false;
    if (first !== 'online') {
      fromDevice = await this.loadSaved();
      if (fromDevice) {
        console.warn(`[ProgressiveLoader] Server ${first === 'slow' ? 'slow to answer (waking up?)' : 'unreachable'} — opened from the map saved on this device`);
        this.source += ' — live traffic starting…';
        this.ready();
      }
    }
    // Keep trying the server; switch to its roads and live data when it answers
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await online;
        this.version = r.version;
        this.source = r.source;
        this.signals = new Map(r.signals.map(s => [s.id, { ...s, approaches: s.approaches ?? [] }]));
        if (r.main) this.merge(r.main);
        this.ready();
        return;
      } catch (err) {
        if (!fromDevice && attempt === 0) {
          console.error('[ProgressiveLoader] Failed to load roads:', err);
          this.notify({ phase: 'full', source: 'error', graph: this.graph, signals: this.signals });
        }
        if (attempt >= ONLINE_RETRIES) return;
        await new Promise(r => setTimeout(r, 5000));
        online = this.loadOnline();
      }
    }
  }

  /** Loads the road cells covering the view plus a 10% margin (zoomed in only). */
  loadView(bbox: [number, number, number, number], zoom: number): void {
    this.view = { bbox, zoom };
    if (!this.version || this.fullLocal || zoom < CELL_MIN_ZOOM) return;
    const [w, s, e, n] = bbox;
    const dx = (e - w) * VIEW_MARGIN, dy = (n - s) * VIEW_MARGIN;
    const x0 = Math.floor((w - dx) / CELL_DEG), x1 = Math.floor((e + dx) / CELL_DEG);
    const y0 = Math.floor((s - dy) / CELL_DEG), y1 = Math.floor((n + dy) / CELL_DEG);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS) return;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x}_${y}`;
        if (this.cells.has(key)) continue;
        this.cells.add(key);
        this.tile<RawRoads>(`/api/roads/${this.version}/cell/${x}/${y}`)
          .then(raw => { this.merge(raw); this.changed(); })
          .catch(() => this.cells.delete(key)); // try again next time the view moves
      }
    }
  }

  /** The whole road network, saved on this device for offline use (~4 MB compressed). */
  async downloadForOffline(): Promise<void> {
    const raw = await serverClient.fetchGraph() as RawGraphData;
    if (raw.format !== 2) throw new Error('Unexpected road network format');
    await saveToIndexedDB(GRAPH_KEY, { data: raw, timestamp: Date.now() });
    this.merge(raw);
    if (raw.version && raw.version === this.version) this.fullLocal = true; // no more road tiles needed
    this.changed();
  }

  getCurrentPhase(): LoadPhase {
    return this.currentPhase;
  }
}

export const progressiveLoader = new ProgressiveLoader();
