const CACHE_PREFIX = 'wayfinder_';
const CACHE_VERSION = 'v1';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  version: string;
}

export class DataCache {
  private storage: Storage;

  constructor() {
    this.storage = window.localStorage;
  }

  set<T>(key: string, data: T, _ttl = 24 * 60 * 60 * 1000): void {
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      version: CACHE_VERSION,
    };
    try {
      this.storage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify(entry));
    } catch (err) {
      console.warn('[DataCache] Failed to set cache:', err);
    }
  }

  get<T>(key: string, ttl = 24 * 60 * 60 * 1000): T | null {
    try {
      const item = this.storage.getItem(`${CACHE_PREFIX}${key}`);
      if (!item) return null;

      const entry: CacheEntry<T> = JSON.parse(item);
      
      // Check version
      if (entry.version !== CACHE_VERSION) {
        this.remove(key);
        return null;
      }

      // Check TTL
      if (Date.now() - entry.timestamp > ttl) {
        this.remove(key);
        return null;
      }

      return entry.data;
    } catch (err) {
      console.warn('[DataCache] Failed to get cache:', err);
      return null;
    }
  }

  remove(key: string): void {
    try {
      this.storage.removeItem(`${CACHE_PREFIX}${key}`);
    } catch (err) {
      console.warn('[DataCache] Failed to remove cache:', err);
    }
  }

  clear(): void {
    try {
      const keys = Object.keys(this.storage);
      for (const key of keys) {
        if (key.startsWith(CACHE_PREFIX)) {
          this.storage.removeItem(key);
        }
      }
    } catch (err) {
      console.warn('[DataCache] Failed to clear cache:', err);
    }
  }
}

export const dataCache = new DataCache();
