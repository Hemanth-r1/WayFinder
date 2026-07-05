import type { RoadNode, RoadEdge, TrafficSignal, SignalPhase, RoadGraph, SignalApproach } from '../types';

const CACHE_VERSION = 'v3';
const TTL_MS = 24 * 60 * 60 * 1e3;
const IDB_NAME = 'WayFinderCache';
const IDB_VERSION = 1;
const IDB_STORE = 'roadGraph';
const IDB_TTL = 7 * 24 * 60 * 60 * 1e3;
const MAX_GRAPH_NODES_IDB = 50000;

interface CachedGraph {
  timestamp: number;
  nodes: Array<[string, RoadNode]>;
  edges: Array<[string, RoadEdge]>;
  adjacencyKeys: string[];
  adjacencyNodeIds: string[];
  signals: Array<[string, {
    id: string; nodeId: string; phases: SignalPhase[]; currentPhaseIndex: number;
    timer: number; cycleLength: number; offset: number; congestionLevel: number;
    adaptiveTiming: boolean; approaches: SignalApproach[]; greenWaveDirection: string | null;
  }]>;
}

function cacheKey(lat: number, lng: number, radius: number): string {
  return `wayfinder_graph_${CACHE_VERSION}_${lat.toFixed(4)}_${lng.toFixed(4)}_${radius}`;
}

// ── IndexedDB operations ──────────────────────────────────────────────────────

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key: string, data: unknown): Promise<void> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(data, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(new Error('Transaction aborted')); };
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openIDB();
  return new Promise(resolve => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
    req.onsuccess = () => {
      db.close();
      const result = req.result as T | undefined;
      if (!result) { resolve(null); return; }
      resolve(result);
    };
    req.onerror = () => { db.close(); resolve(null); };
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// ── Serialization ─────────────────────────────────────────────────────────────

function serialize(graph: RoadGraph, signals: Map<string, TrafficSignal>): CachedGraph {
  const adjacencyKeys: string[] = [];
  const adjacencyNodeIds: string[] = [];
  for (const [nodeId, edges] of graph.adjacency) {
    for (const e of edges) {
      adjacencyNodeIds.push(nodeId);
      adjacencyKeys.push(e.id);
    }
  }
  return {
    timestamp: Date.now(),
    nodes: Array.from(graph.nodes.entries()),
    edges: Array.from(graph.edges.entries()),
    adjacencyKeys,
    adjacencyNodeIds,
    signals: Array.from(signals.entries()).map(([k, v]) => [k, {
      id: v.id, nodeId: v.nodeId, phases: v.phases,
      currentPhaseIndex: v.currentPhaseIndex, timer: v.timer,
      cycleLength: v.cycleLength, offset: v.offset,
      congestionLevel: v.congestionLevel, adaptiveTiming: v.adaptiveTiming,
      approaches: v.approaches ?? [],
      greenWaveDirection: v.greenWaveDirection ?? null,
    }]),
  };
}

function restore(data: CachedGraph): { graph: RoadGraph; signals: Map<string, TrafficSignal> } | null {
  try {
    const nodes = new Map<string, RoadNode>(data.nodes);
    const edges = new Map<string, RoadEdge>(data.edges);
    const adjacency = new Map<string, RoadEdge[]>();
    for (let i = 0; i < data.adjacencyNodeIds.length; i++) {
      const nodeId = data.adjacencyNodeIds[i];
      const edgeId = data.adjacencyKeys[i];
      const edge = edges.get(edgeId);
      if (!edge) continue;
      if (!adjacency.has(nodeId)) adjacency.set(nodeId, []);
      adjacency.get(nodeId)!.push(edge);
    }
    const signals = new Map<string, TrafficSignal>();
    for (const [k, v] of data.signals) {
      signals.set(k, {
        ...v,
        greenWaveDirection: (v as any).greenWaveDirection ?? null,
        approaches: v.approaches ?? [],
      });
    }
    return { graph: { nodes, edges, adjacency }, signals };
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function saveGraphToCache(
  lat: number, lng: number, radius: number,
  graph: RoadGraph,
  signals: Map<string, TrafficSignal>,
): Promise<void> {
  const key = cacheKey(lat, lng, radius);
  const payload = serialize(graph, signals);

  if (graph.nodes.size > MAX_GRAPH_NODES_IDB) {
    try {
      localStorage.removeItem(key);
    } catch { /* ignore */ }
    console.log(`[WayFinder] Graph too large (${graph.nodes.size}n), skipping IndexedDB cache`);
    return;
  }

  if (graph.nodes.size >= 1000) {
    try {
      await idbPut(key, { timestamp: Date.now(), data: payload });
      console.log(`[WayFinder] Cached ${graph.nodes.size} nodes to IndexedDB`);
      return;
    } catch (err) {
      console.warn('[WayFinder] IndexedDB write failed:', err);
    }
  }

  try {
    localStorage.setItem(key, JSON.stringify(payload));
    console.log('[WayFinder] Cached to localStorage');
  } catch (err) {
    console.warn('[WayFinder] localStorage write failed:', err);
  }
}

export async function loadGraphFromCache(
  lat: number, lng: number, radius: number,
): Promise<{ graph: RoadGraph; signals: Map<string, TrafficSignal> } | null> {
  const key = cacheKey(lat, lng, radius);

  try {
    const idbData = await idbGet<{ timestamp: number; data: CachedGraph }>(key);
    if (idbData) {
      if (Date.now() - idbData.timestamp > IDB_TTL) {
        await idbDelete(key);
      } else {
        const result = restore(idbData.data);
        if (result) {
          console.log(`[WayFinder] Loaded ${result.graph.nodes.size} nodes from IndexedDB cache`);
          return result;
        }
      }
    }
  } catch {
    // fall through
  }

  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const data: CachedGraph = JSON.parse(raw);
      const now = Date.now();
      if (now - data.timestamp > TTL_MS) {
        localStorage.removeItem(key);
      } else {
        const result = restore(data);
        if (result) {
          console.log(`[WayFinder] Loaded ${result.graph.nodes.size} nodes from localStorage cache`);
          return result;
        }
      }
    }
  } catch { /* localStorage unavailable */ }

  return null;
}

export async function clearGraphCache(lat: number, lng: number, radius: number): Promise<void> {
  const key = cacheKey(lat, lng, radius);
  localStorage.removeItem(key);
  try { await idbDelete(key); } catch { /* ignore */ }
  console.log('[WayFinder] Graph cache cleared');
}
