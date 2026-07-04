import { doc, getDoc, setDoc, writeBatch } from 'firebase/firestore';
import { ref, getBytes, uploadBytes } from 'firebase/storage';
import { db, storage, isFirebaseReady } from '../config/firebase';

const CACHE_VERSION = 'v3';
const CHUNK_SIZE = 600 * 1024;

interface OSMNode {
  id: number; lat: number; lng: number;
}

interface OSMWay {
  id: number; nodes: number[]; tags: Record<string, string>;
}

interface StoredData {
  nodes: [number, number, number][]; // [id, lat, lng]
  ways: [number, number[], Record<string, string>][]; // [id, nodeIds, tags]
}

function storagePath(centerLat: number, centerLng: number, radius: number): string {
  return `roadCache/${CACHE_VERSION}_${centerLat.toFixed(4)}_${centerLng.toFixed(4)}_${radius}.json`;
}

function firestoreMetaId(centerLat: number, centerLng: number, radius: number): string {
  return `meta_${CACHE_VERSION}_${centerLat.toFixed(4)}_${centerLng.toFixed(4)}_${radius}`;
}

function firestoreChunkId(centerLat: number, centerLng: number, radius: number, index: number): string {
  return `chunk_${CACHE_VERSION}_${centerLat.toFixed(4)}_${centerLng.toFixed(4)}_${radius}_${index}`;
}

// ── Serialization ─────────────────────────────────────────────────────────────

function packData(nodes: Map<number, OSMNode>, ways: OSMWay[]): StoredData {
  const nodeArray: [number, number, number][] = [];
  for (const [id, n] of nodes) nodeArray.push([id, n.lat, n.lng]);
  const wayArray: [number, number[], Record<string, string>][] = [];
  for (const w of ways) wayArray.push([w.id, w.nodes, w.tags]);
  return { nodes: nodeArray, ways: wayArray };
}

function unpackData(data: StoredData): { nodes: Map<number, OSMNode>; ways: OSMWay[] } {
  const nodes = new Map<number, OSMNode>();
  for (const [id, lat, lng] of data.nodes) nodes.set(id, { id, lat, lng });
  const ways = data.ways.map(([id, nodeIds, tags]) => ({ id, nodes: nodeIds, tags }));
  return { nodes, ways };
}

// ── Firebase Storage ──────────────────────────────────────────────────────────

export async function saveOSMToStorage(
  centerLat: number, centerLng: number, radius: number,
  nodes: Map<number, OSMNode>, ways: OSMWay[],
): Promise<boolean> {
  if (!isFirebaseReady || !storage) return false;
  try {
    const data = packData(nodes, ways);
    const json = JSON.stringify({ timestamp: Date.now(), data });
    const storageRef = ref(storage, storagePath(centerLat, centerLng, radius));
    await uploadBytes(storageRef, new TextEncoder().encode(json));
    console.log(`[FirebaseCache] Saved ${nodes.size} nodes to Storage (${(json.length / 1024).toFixed(0)}KB)`);
    return true;
  } catch (err) {
    console.warn('[FirebaseCache] Storage save failed:', err);
/**
 * firebaseCache.ts
 * Stores raw OSM data in Firebase Storage + Firestore as persistent backup caches.
 * Checked before Overpass API calls:
 *   1. Firebase Storage — single blob download (fastest remote)
 *   2. Firestore chunks — fallback if Storage unavailable
 *
 * Storage: roadCache/{key}.json
 * Firestore collection: roadCache
 *   meta_{key} — manifest doc (timestamp, counts)
 *   chunk_{key}_{N} — data chunks (nodes, ways arrays)
 */
import { db, storage } from '../config/firebase';
import { doc, getDoc, setDoc, writeBatch } from 'firebase/firestore';
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage';

const CACHE_VERSION = 'v3';
const CHUNK_TARGET_BYTES = 600 * 1024; // ~600KB per chunk (safe under 1MB limit)

interface RawOSMNode { id: number; lat: number; lng: number }
interface RawOSMWay { id: number; nodes: number[]; tags: Record<string, string> }
export interface RawOSMData { nodes: Map<number, RawOSMNode>; ways: RawOSMWay[] }

interface MetaDoc {
  timestamp: number;
  totalNodes: number;
  totalWays: number;
  chunkCount: number;
}

function cacheKey(lat: number, lng: number, radius: number): string {
  return `${CACHE_VERSION}_${lat.toFixed(4)}_${lng.toFixed(4)}_${radius}`;
}

function metaDocId(lat: number, lng: number, radius: number): string {
  return `meta_${cacheKey(lat, lng, radius)}`;
}

function chunkDocId(lat: number, lng: number, radius: number, index: number): string {
  return `chunk_${cacheKey(lat, lng, radius)}_${index}`;
}

/** Convert RawOSMData to a compact serializable format */
function serializeRaw(data: RawOSMData): { nodes: Array<[number, number, number]>; ways: Array<[number, number[], Record<string, string>]> } {
  const nodes: Array<[number, number, number]> = [];
  for (const [id, n] of data.nodes) nodes.push([id, n.lat, n.lng]);
  const ways: Array<[number, number[], Record<string, string>]> = [];
  for (const w of data.ways) ways.push([w.id, w.nodes, w.tags]);
  return { nodes, ways };
}

/** Convert compact serialized format back to RawOSMData */
function deserializeRaw(data: { nodes: Array<[number, number, number]>; ways: Array<[number, number[], Record<string, string>]> }): RawOSMData {
  const nodes = new Map<number, RawOSMNode>();
  for (const [id, lat, lng] of data.nodes) nodes.set(id, { id, lat, lng });
  const ways: RawOSMWay[] = data.ways.map(([id, nodeIds, tags]) => ({ id, nodes: nodeIds, tags }));
  return { nodes, ways };
}

/** Estimate byte size of a value for chunking */
function estimateSize(obj: unknown): number {
  return JSON.stringify(obj).length;
}

/**
 * Save raw OSM data to Firestore. Splits into chunks to stay under 1MB.
 */
export async function saveOSMToFirebase(
  lat: number, lng: number, radius: number,
  rawData: RawOSMData,
): Promise<void> {
  try {
    const serialized = serializeRaw(rawData);
    const serializedStr = JSON.stringify(serialized);

    // If small enough, store as single doc
    if (serializedStr.length < 800 * 1024) {
      await setDoc(doc(db, 'roadCache', metaDocId(lat, lng, radius)), {
        timestamp: Date.now(),
        totalNodes: rawData.nodes.size,
        totalWays: rawData.ways.length,
        chunkCount: 1,
        data: serialized,
      });
      console.log(`[FirebaseCache] Saved ${rawData.nodes.size} nodes, ${rawData.ways.length} ways (single doc, ${(serializedStr.length / 1024).toFixed(0)}KB)`);
      return;
    }

    // Split into chunks
    const allNodes = serialized.nodes;
    const allWays = serialized.ways;
    const chunks: Array<{ nodes: typeof allNodes; ways: typeof allWays }> = [];
    let currentChunk: { nodes: typeof allNodes; ways: typeof allWays } = { nodes: [], ways: [] };
    let currentSize = 0;

    // Add nodes in batches
    for (const n of allNodes) {
      const itemSize = estimateSize(n);
      if (currentSize + itemSize > CHUNK_TARGET_BYTES && currentChunk.nodes.length > 0) {
        chunks.push(currentChunk);
        currentChunk = { nodes: [], ways: [] };
        currentSize = 0;
      }
      currentChunk.nodes.push(n);
      currentSize += itemSize;
    }
    // Add ways to the last chunk (or distribute if needed)
    for (const w of allWays) {
      const itemSize = estimateSize(w);
      if (currentSize + itemSize > CHUNK_TARGET_BYTES && (currentChunk.nodes.length > 0 || currentChunk.ways.length > 0)) {
        chunks.push(currentChunk);
        currentChunk = { nodes: [], ways: [] };
        currentSize = 0;
      }
      currentChunk.ways.push(w);
      currentSize += itemSize;
    }
    if (currentChunk.nodes.length > 0 || currentChunk.ways.length > 0) {
      chunks.push(currentChunk);
    }

    // Write manifest
    const batch = writeBatch(db);
    batch.set(doc(db, 'roadCache', metaDocId(lat, lng, radius)), {
      timestamp: Date.now(),
      totalNodes: rawData.nodes.size,
      totalWays: rawData.ways.length,
      chunkCount: chunks.length,
    });

    // Write each chunk
    for (let i = 0; i < chunks.length; i++) {
      batch.set(doc(db, 'roadCache', chunkDocId(lat, lng, radius, i)), {
        index: i,
        ...chunks[i],
      });
    }

    await batch.commit();
    console.log(`[FirebaseCache] Saved ${rawData.nodes.size} nodes, ${rawData.ways.length} ways (${chunks.length} chunks)`);
  } catch (e) {
    console.warn('[FirebaseCache] Save failed:', e);
  }
}

/**
 * Load raw OSM data from Firestore. Returns null if not found.
 */
export async function loadOSMFromFirebase(
  lat: number, lng: number, radius: number,
): Promise<RawOSMData | null> {
  try {
    const metaSnap = await getDoc(doc(db, 'roadCache', metaDocId(lat, lng, radius)));
    if (!metaSnap.exists()) return null;
    const meta = metaSnap.data() as MetaDoc & { data?: any };

    // Single-doc format
    if (meta.data) {
      const result = deserializeRaw(meta.data);
      console.log(`[FirebaseCache] Loaded ${result.nodes.size} nodes from single doc`);
      return result;
    }

    // Multi-chunk format
    const allNodes: Array<[number, number, number]> = [];
    const allWays: Array<[number, number[], Record<string, string>]> = [];

    const CHUNK_COUNT = meta.chunkCount ?? 0;
    if (CHUNK_COUNT === 0) return null;

    for (let i = 0; i < CHUNK_COUNT; i++) {
      const chunkSnap = await getDoc(doc(db, 'roadCache', chunkDocId(lat, lng, radius, i)));
      if (!chunkSnap.exists()) {
        console.warn(`[FirebaseCache] Missing chunk ${i}/${CHUNK_COUNT}, aborting`);
        return null;
      }
      const chunk = chunkSnap.data() as { nodes?: Array<[number, number, number]>; ways?: Array<[number, number[], Record<string, string>]> };
      if (chunk.nodes) allNodes.push(...chunk.nodes);
      if (chunk.ways) allWays.push(...chunk.ways);
    }

    const result = deserializeRaw({ nodes: allNodes, ways: allWays });
    console.log(`[FirebaseCache] Loaded ${result.nodes.size} nodes, ${result.ways.length} ways (${CHUNK_COUNT} chunks)`);
    return result;
  } catch (e) {
    console.warn('[FirebaseCache] Load failed:', e);
    return null;
  }
}

// ── Firebase Storage (single blob, no chunking) ────────────────────────────

function storagePath(lat: number, lng: number, radius: number): string {
  return `roadCache/${cacheKey(lat, lng, radius)}.json`;
}

/**
 * Save raw OSM data to Firebase Storage as a single JSON blob.
 * Firestore chunk fallback if Storage is unavailable.
 */
export async function saveOSMToStorage(
  lat: number, lng: number, radius: number,
  rawData: RawOSMData,
): Promise<boolean> {
  try {
    const serialized = serializeRaw(rawData);
    const json = JSON.stringify({ timestamp: Date.now(), data: serialized });
    const storageRef = ref(storage, storagePath(lat, lng, radius));
    await uploadBytes(storageRef, new TextEncoder().encode(json));
    console.log(`[FirebaseCache] Saved ${rawData.nodes.size} nodes to Storage (${(json.length / 1024).toFixed(0)}KB)`);
    return true;
  } catch (e) {
    console.warn('[FirebaseCache] Storage save failed, falling back to Firestore:', e);
    return false;
  }
}

export async function loadOSMFromStorage(
  centerLat: number, centerLng: number, radius: number,
  signal?: AbortSignal,
): Promise<{ nodes: Map<number, OSMNode>; ways: OSMWay[] } | null> {
  if (!isFirebaseReady || !storage) return null;
  try {
    const storageRef = ref(storage, storagePath(centerLat, centerLng, radius));
    const bytes = signal
      ? await Promise.race([
          getBytes(storageRef),
          new Promise<never>((_, reject) => { signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))); }),
        ])
      : await getBytes(storageRef);
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json);
    if (!parsed.data) return null;
    const result = unpackData(parsed.data);
    console.log(`[FirebaseCache] Loaded ${result.nodes.size} nodes from Storage`);
    return result;
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    const code = (err as { code?: string })?.code;
    if (code !== 'storage/object-not-found') {
      console.warn('[FirebaseCache] Storage load failed:', (err as Error)?.message || err);
    }
/**
 * Load raw OSM data from Firebase Storage. Returns null if not found.
 */
export async function loadOSMFromStorage(
  lat: number, lng: number, radius: number,
): Promise<RawOSMData | null> {
  try {
    const storageRef = ref(storage, storagePath(lat, lng, radius));
    const bytes = await getBytes(storageRef);
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    if (!parsed.data) return null;
    const result = deserializeRaw(parsed.data);
    console.log(`[FirebaseCache] Loaded ${result.nodes.size} nodes from Storage`);
    return result;
  } catch (e) {
    if ((e as any)?.code === 'storage/object-not-found') return null;
    console.warn('[FirebaseCache] Storage load failed:', e);
    return null;
  }
}

// ── Firestore fallback ────────────────────────────────────────────────────────

export async function saveOSMToFirestore(
  centerLat: number, centerLng: number, radius: number,
  nodes: Map<number, OSMNode>, ways: OSMWay[],
): Promise<void> {
  if (!isFirebaseReady || !db) return;
  try {
    const data = packData(nodes, ways);
    const json = JSON.stringify(data);
    const metaRef = doc(db, 'roadCache', firestoreMetaId(centerLat, centerLng, radius));

    if (json.length < 800 * 1024) {
      await setDoc(metaRef, { timestamp: Date.now(), totalNodes: nodes.size, totalWays: ways.length, chunkCount: 1, data });
      console.log(`[FirebaseCache] Saved ${nodes.size} nodes to Firestore (single doc)`);
      return;
    }

    const batch = writeBatch(db);
    batch.set(metaRef, { timestamp: Date.now(), totalNodes: nodes.size, totalWays: ways.length, chunkCount: 0 });
    const nodeArray = data.nodes;
    const wayArray = data.ways;
    const chunks: { nodes: typeof nodeArray; ways: typeof wayArray }[] = [];
    let currentChunk: { nodes: typeof nodeArray; ways: typeof wayArray } = { nodes: [], ways: [] };
    let size = 0;

    for (const entry of nodeArray) {
      const entrySize = JSON.stringify(entry).length;
      if (size + entrySize > CHUNK_SIZE && currentChunk.nodes.length > 0) {
        chunks.push(currentChunk);
        currentChunk = { nodes: [], ways: [] };
        size = 0;
      }
      currentChunk.nodes.push(entry);
      size += entrySize;
    }
    for (const entry of wayArray) {
      const entrySize = JSON.stringify(entry).length;
      if (size + entrySize > CHUNK_SIZE && (currentChunk.nodes.length > 0 || currentChunk.ways.length > 0)) {
        chunks.push(currentChunk);
        currentChunk = { nodes: [], ways: [] };
        size = 0;
      }
      currentChunk.ways.push(entry);
      size += entrySize;
    }
    if (currentChunk.nodes.length > 0 || currentChunk.ways.length > 0) chunks.push(currentChunk);

    batch.update(metaRef, { chunkCount: chunks.length });
    for (let i = 0; i < chunks.length; i++) {
      const chunkRef = doc(db, 'roadCache', firestoreChunkId(centerLat, centerLng, radius, i));
      batch.set(chunkRef, { index: i, ...chunks[i] });
    }
    await batch.commit();
    console.log(`[FirebaseCache] Saved ${nodes.size} nodes to Firestore (${chunks.length} chunks)`);
  } catch (err) {
    console.warn('[FirebaseCache] Firestore save failed:', err);
  }
}

export async function loadOSMFromFirestore(
  centerLat: number, centerLng: number, radius: number,
): Promise<{ nodes: Map<number, OSMNode>; ways: OSMWay[] } | null> {
  if (!isFirebaseReady || !db) return null;
  try {
    const metaRef = doc(db, 'roadCache', firestoreMetaId(centerLat, centerLng, radius));
    const metaSnap = await getDoc(metaRef);
    if (!metaSnap.exists()) return null;

    const meta = metaSnap.data() as { chunkCount: number; data?: StoredData };

    if (meta.data) {
      const result = unpackData(meta.data);
      console.log(`[FirebaseCache] Loaded ${result.nodes.size} nodes from Firestore (single doc)`);
      return result;
    }

    const chunkCount = meta.chunkCount ?? 0;
    if (chunkCount === 0) return null;

    const allNodes: [number, number, number][] = [];
    const allWays: [number, number[], Record<string, string>][] = [];
    for (let i = 0; i < chunkCount; i++) {
      const chunkRef = doc(db, 'roadCache', firestoreChunkId(centerLat, centerLng, radius, i));
      const chunkSnap = await getDoc(chunkRef);
      if (!chunkSnap.exists()) {
        console.warn(`[FirebaseCache] Missing chunk ${i}/${chunkCount}`);
        return null;
      }
      const chunk = chunkSnap.data() as { nodes?: typeof allNodes; ways?: typeof allWays };
      if (chunk.nodes) allNodes.push(...chunk.nodes);
      if (chunk.ways) allWays.push(...chunk.ways);
    }
    const result = unpackData({ nodes: allNodes, ways: allWays });
    console.log(`[FirebaseCache] Loaded ${result.nodes.size} nodes from Firestore (${chunkCount} chunks)`);
    return result;
  } catch (err) {
    console.warn('[FirebaseCache] Firestore load failed:', err);
    return null;
  }
}

export async function clearStorageCache(
  _centerLat: number, _centerLng: number, _radius: number,
): Promise<void> {
}
/**
 * Delete cached OSM data from Storage.
 */
export async function clearStorageCache(
  lat: number, lng: number, radius: number,
): Promise<void> {
  try {
    const storageRef = ref(storage, storagePath(lat, lng, radius));
    await deleteObject(storageRef);
    console.log('[FirebaseCache] Storage cache cleared');
  } catch { /* ignore */ }
}

/**
 * Delete cached OSM data from Firestore.
 */
export async function clearFirebaseCache(
  lat: number, lng: number, radius: number,
): Promise<void> {
  try {
    const metaSnap = await getDoc(doc(db, 'roadCache', metaDocId(lat, lng, radius)));
    if (!metaSnap.exists()) return;
    const meta = metaSnap.data() as MetaDoc;
    const batch = writeBatch(db);
    batch.delete(doc(db, 'roadCache', metaDocId(lat, lng, radius)));
    const CHUNK_COUNT = meta.chunkCount ?? 0;
    for (let i = 0; i < CHUNK_COUNT; i++) {
      batch.delete(doc(db, 'roadCache', chunkDocId(lat, lng, radius, i)));
    }
    await batch.commit();
    console.log('[FirebaseCache] Cleared');
  } catch (e) {
    console.warn('[FirebaseCache] Clear failed:', e);
  }
}
