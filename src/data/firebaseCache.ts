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
