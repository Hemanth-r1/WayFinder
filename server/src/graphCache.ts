import { getDb } from './firebaseClient.js';
import { getStorage } from 'firebase-admin/storage';
import type { RoadGraph, TrafficSignal } from './types.js';

interface GraphCache {
  graph: RoadGraph;
  signals: TrafficSignal[];
  timestamp: number;
  version: number;
}

let cachedGraph: GraphCache | null = null;
let cacheVersion = 0;

const CENTER = { lat: 12.9716, lng: 77.5946 };
const RADIUS = 40000;
const CACHE_KEY = `bangalore_graph_${CENTER.lat}_${CENTER.lng}_${RADIUS}`;

export async function loadGraphFromCache(): Promise<GraphCache | null> {
  // Try memory cache first
  if (cachedGraph && Date.now() - cachedGraph.timestamp < 24 * 60 * 60 * 1000) {
    console.log('[GraphCache] Using memory cache');
    return cachedGraph;
  }

  // Try Firestore
  try {
    const db = getDb();
    if (!db) return null;
    
    const doc = await db.collection('roadCache').doc(CACHE_KEY).get();
    if (doc.exists) {
      const data = doc.data();
      if (data && data.graph) {
        const graph = data.graph as RoadGraph;
        const signals = data.signals as TrafficSignal[];
        cachedGraph = { 
          graph, 
          signals, 
          timestamp: data.timestamp || Date.now(), 
          version: data.version || 0 
        };
        console.log('[GraphCache] Loaded from Firestore');
        return cachedGraph;
      }
    }
  } catch (err: any) {
    console.warn('[GraphCache] Firestore cache miss:', err?.message || err);
  }

  // Try Firebase Storage
  try {
    const storage = getStorage();
    const bucket = storage.bucket();
    const file = bucket.file(`graphs/${CACHE_KEY}.json`);
    
    const [exists] = await file.exists();
    if (exists) {
      const [url] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 3600000 });
      const response = await fetch(url);
      const data = await response.json();
      cachedGraph = { 
        graph: data.graph as RoadGraph, 
        signals: data.signals as TrafficSignal[], 
        timestamp: Date.now(), 
        version: data.version || 0 
      };
      console.log('[GraphCache] Loaded from Firebase Storage');
      return cachedGraph;
    }
  } catch (err: any) {
    console.warn('[GraphCache] Storage cache miss:', err?.message || err);
  }

  return null;
}

export async function saveGraphToCache(graph: RoadGraph, signals: TrafficSignal[]): Promise<void> {
  cachedGraph = { 
    graph, 
    signals, 
    timestamp: Date.now(), 
    version: ++cacheVersion 
  };

  // Save to Firestore
  try {
    const db = getDb();
    if (db) {
      await db.collection('roadCache').doc(CACHE_KEY).set({
        graph,
        signals,
        timestamp: Date.now(),
        version: cacheVersion,
      });
      console.log('[GraphCache] Saved to Firestore');
    }
  } catch (err) {
    console.warn('[GraphCache] Failed to save to Firestore:', err);
  }

  // Save to Firebase Storage
  try {
    const storage = getStorage();
    const bucket = storage.bucket();
    const file = bucket.file(`graphs/${CACHE_KEY}.json`);
    await file.save(JSON.stringify({ graph, signals, version: cacheVersion }), { contentType: 'application/json' });
    console.log('[GraphCache] Saved to Firebase Storage');
  } catch (err) {
    console.warn('[GraphCache] Failed to save to Storage:', err);
  }
}

export function invalidateCache(): void {
  cachedGraph = null;
  console.log('[GraphCache] Cache invalidated');
}

export function getCacheVersion(): number {
  return cacheVersion;
}
