/**
 * The user's own data, kept on the device first and synced to their account:
 * - saved places (home, work, favourites): localStorage, and Firestore
 *   `users/{uid}/places/{id}` when signed in with Firebase (newest change wins);
 * - files (report photos, documents): stored by the server, opened once and then served
 *   from the browser cache (the server marks them immutable);
 * - device storage: asks the browser to keep WayFinder's data (maps, road tiles) instead of
 *   clearing it when space runs low, and reports how much is used.
 */
import { collection, doc, getDocs, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../config/firebase';
import { serverClient, type FileMeta, type FilePurpose } from './serverClient';
import { clearIndexedDBPrefix } from '../data/indexedDBCache';

export interface SavedPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
  kind: 'home' | 'work' | 'favourite';
  updatedAt: number;
}

const placesKey = (uid: string) => `wayfinder_places_${uid}`;

function readLocal(uid: string): SavedPlace[] {
  try { return JSON.parse(localStorage.getItem(placesKey(uid)) ?? '[]'); } catch { return []; }
}

function writeLocal(uid: string, places: SavedPlace[]): void {
  try { localStorage.setItem(placesKey(uid), JSON.stringify(places)); } catch { /* storage full or blocked */ }
}

/** Saved places: from the device at once, then merged with the account copy (newest wins). */
export async function loadPlaces(uid: string): Promise<SavedPlace[]> {
  const local = readLocal(uid);
  if (!db) return local;
  try {
    const snap = await getDocs(collection(db, 'users', uid, 'places'));
    const merged = new Map(local.map(p => [p.id, p]));
    snap.forEach(d => {
      const p = { id: d.id, ...d.data() } as SavedPlace;
      const mine = merged.get(p.id);
      if (!mine || p.updatedAt >= mine.updatedAt) merged.set(p.id, p);
    });
    const list = [...merged.values()];
    writeLocal(uid, list);
    return list;
  } catch {
    return local; // offline: the device copy
  }
}

/** Saves a place (home and work replace the previous one). */
export async function savePlace(uid: string, place: Omit<SavedPlace, 'id' | 'updatedAt'>): Promise<SavedPlace[]> {
  const id = place.kind === 'favourite' ? `fav-${Date.now().toString(36)}` : place.kind;
  const p: SavedPlace = { ...place, id, updatedAt: Date.now() };
  const list = [...readLocal(uid).filter(x => x.id !== id), p];
  writeLocal(uid, list);
  if (db) {
    const { id: _id, ...data } = p;
    await setDoc(doc(db, 'users', uid, 'places', id), data).catch(() => { /* synced next time */ });
  }
  return list;
}

export async function removePlace(uid: string, id: string): Promise<SavedPlace[]> {
  const list = readLocal(uid).filter(x => x.id !== id);
  writeLocal(uid, list);
  if (db) await deleteDoc(doc(db, 'users', uid, 'places', id)).catch(() => {});
  return list;
}

// ── Files ──────────────────────────────────────────────────────────────────────

const MAX_IMAGE_SIDE = 1600;

/** Photos are shrunk on the device before upload (≤ 1600 px, JPEG): faster and lighter. */
async function shrinkImage(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise(resolve => canvas.toBlob(b => resolve(b ?? file), 'image/jpeg', 0.82));
}

export async function uploadFile(file: File, purpose: FilePurpose, reportId?: string): Promise<FileMeta> {
  const body = await shrinkImage(file);
  const name = body === file ? file.name : file.name.replace(/\.\w+$/, '') + '.jpg';
  return serverClient.uploadFile(body, name, purpose, reportId);
}

const urls = new Map<string, string>();
/** A local URL for showing a file (downloaded once; the browser keeps it). */
export async function fileUrl(id: string): Promise<string> {
  const known = urls.get(id);
  if (known) return known;
  const url = URL.createObjectURL(await serverClient.fileBlob(id));
  urls.set(id, url);
  return url;
}

// ── Device storage ─────────────────────────────────────────────────────────────

/** Asks the browser to keep WayFinder's stored maps and roads (true when granted). */
export async function keepDataOnDevice(): Promise<boolean> {
  try { return (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false; } catch { return false; }
}

export async function deviceStorage(): Promise<{ usedMB: number; quotaMB: number; persisted: boolean } | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est) return null;
    return {
      usedMB: Math.round((est.usage ?? 0) / 1e5) / 10, quotaMB: Math.round((est.quota ?? 0) / 1e6),
      persisted: (await navigator.storage.persisted?.()) ?? false,
    };
  } catch { return null; }
}

/** Frees space: drops saved road tiles (the offline map and saved places stay). */
export async function clearRoadTiles(): Promise<void> {
  await clearIndexedDBPrefix('roads:', 'roads:/keep-nothing/');
}
