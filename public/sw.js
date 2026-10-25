/**
 * WayFinder service worker: keeps Bangalore usable offline.
 * - Map tiles, styles, sprites and fonts (OpenFreeMap): cache first — they rarely change,
 *   and "Download Bangalore for offline use" pre-fills this cache.
 * - Road tiles (/api/roads/<version>/…): cache first — their URLs change when the roads do.
 * - The app itself, /api/roads/meta and the full road network (/api/graph): network first, cached copy offline.
 * - Live data (/api/live/*, routes, reports…): network only — it must be fresh.
 */
const MAP_CACHE = 'wf-map-v1';
const APP_CACHE = 'wf-app-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([MAP_CACHE, APP_CACHE]);
    for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function cacheFirst(request) {
  const cache = await caches.open(MAP_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(APP_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(request) ?? (request.mode === 'navigate' ? await cache.match('/') : undefined);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.hostname === 'tiles.openfreemap.org') {
    event.respondWith(cacheFirst(request));
    return;
  }
  const ours = url.origin === self.location.origin || url.pathname.startsWith('/api/');
  if (!ours) return;
  if (url.pathname.startsWith('/api/')) {
    // Road tiles have the version in their URL and never change: keep them on the device
    if (url.pathname.startsWith('/api/roads/') && url.pathname !== '/api/roads/meta') event.respondWith(cacheFirst(request));
    else if (url.pathname === '/api/graph' || url.pathname === '/api/roads/meta') event.respondWith(networkFirst(request));
    return; // live data: straight to the network
  }
  event.respondWith(networkFirst(request));
});
