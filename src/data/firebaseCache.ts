import { db, storage } from '../config/firebase';
import { doc, getDoc, setDoc, writeBatch } from 'firebase/firestore';
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage';

const CACHE_VERSION = 'v3';
const CHUNK_TARGET_BYTES = 600 * 1024;

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

function storagePath(lat: number, lng: number, radius: number): string {
  return `roadCache/${cacheKey(lat, lng, radius)}.json`;
}

function serializeRaw(data: RawOSMData): { nodes: Array<[number, number, number]>; ways: Array<[number, number[], Record<string, string>]> } {
  const nodes: Array<[number, number, number]> = [];
  for (const [id, n] of data.nodes) nodes.push([id, n.lat, n.lng]);
  const ways: Array<[number, number[], Record<string, string>]> = [];
  for (const w of data.ways) ways.push([w.id, w.nodes, w.tags]);
  return { nodes, ways };
}

function deserializeRaw(data: { nodes: Array<[number, number, number]>; ways: Array<[number, number[], Record<string, string>]> }): RawOSMData {
  const nodes = new Map<number, RawOSMNode>();
  for (const [id, lat, lng] of data.nodes) nodes.set(id, { id, lat, lng });
  const ways: RawOSMWay[] = data.ways.map(([id, nodeIds, tags]) => ({ id, nodes: nodeIds, tags }));
  return { nodes, ways };
}

function estimateSize(obj: unknown): number {
  return JSON.stringify(obj).length;
}

// ── Firestore ───────────────────────────────────────────────────────────────

export async function saveOSMToFirebase(
  lat: number, lng: number, radius: number,
  rawData: RawOSMData,
): Promise<void> {
  try {
    const serialized = serializeRaw(rawData);
    const serializedStr = JSON.stringify(serialized);

    if (serializedStr.length < 800 * 1024) {
      await setDoc(doc(db, 'roadCache', metaDocId(lat, lng, radius)), {
        timestamp: Date.now(),
        totalNodes: rawData.nodes.size,
        totalWays: rawData.ways.length,
        chunkCount: 1,
        data: serialized,
      });
      console.log(`[FirebaseCache] Saved ${rawData.nodes.size} nodes (single doc, ${(serializedStr.length / 1024).toFixed(0)}KB)`);
      return;
    }

    const allNodes = serialized.nodes;
    const allWays = serialized.ways;
    const chunks: Array<{ nodes: typeof allNodes; ways: typeof allWays }> = [];
    let currentChunk: { nodes: typeof allNodes; ways: typeof allWays } = { nodes: [], ways: [] };
    let currentSize = 0;

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

    const batch = writeBatch(db);
    batch.set(doc(db, 'roadCache', metaDocId(lat, lng, radius)), {
      timestamp: Date.now(),
      totalNodes: rawData.nodes.size,
      totalWays: rawData.ways.length,
      chunkCount: chunks.length,
    });

    for (let i = 0; i < chunks.length; i++) {
      batch.set(doc(db, 'roadCache', chunkDocId(lat, lng, radius, i)), {
        index: i,
        ...chunks[i],
      });
    }

    await batch.commit();
    console.log(`[FirebaseCache] Saved ${rawData.nodes.size} nodes (${chunks.length} chunks)`);
  } catch (e) {
    console.warn('[FirebaseCache] Save failed:', e);
  }
}

export async function loadOSMFromFirebase(
  lat: number, lng: number, radius: number,
): Promise<RawOSMData | null> {
  try {
    const metaSnap = await getDoc(doc(db, 'roadCache', metaDocId(lat, lng, radius)));
    if (!metaSnap.exists()) return null;
    const meta = metaSnap.data() as MetaDoc & { data?: any };

    if (meta.data) {
      const result = deserializeRaw(meta.data);
      console.log(`[FirebaseCache] Loaded ${result.nodes.size} nodes from single doc`);
      return result;
    }

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
    console.log(`[FirebaseCache] Loaded ${result.nodes.size} nodes (${CHUNK_COUNT} chunks)`);
    return result;
  } catch (e) {
    console.warn('[FirebaseCache] Load failed:', e);
    return null;
  }
}

// ── Firebase Storage ────────────────────────────────────────────────────────

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

// ── Cache cleanup ──────────────────────────────────────────────────────────

export async function clearStorageCache(
  lat: number, lng: number, radius: number,
): Promise<void> {
  try {
    const storageRef = ref(storage, storagePath(lat, lng, radius));
    await deleteObject(storageRef);
    console.log('[FirebaseCache] Storage cache cleared');
  } catch { /* ignore */ }
}

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
