/**
 * indexedDBCache.ts
 * Persistent OSM graph storage via IndexedDB (browser-native, huge quota).
 * Used as primary cache for graphs too large for localStorage.
 */

const DB_NAME = 'WayFinderCache';
const DB_VERSION = 1;
const STORE_NAME = 'roadGraph';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveToIndexedDB(
  key: string,
  data: unknown,
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(data, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(new Error('Transaction aborted')); };
  });
}

export async function loadFromIndexedDB<T>(key: string): Promise<{ data: T; timestamp: number } | null> {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => {
      db.close();
      const result = req.result;
      if (!result) { resolve(null); return; }
      const data = result as { data: T; timestamp: number };
      if (Date.now() - data.timestamp > TTL_MS) {
        clearIndexedDB(key);
        resolve(null);
        return;
      }
      resolve(data);
    };
    req.onerror = () => { db.close(); resolve(null); };
  });
}

export async function clearIndexedDB(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
