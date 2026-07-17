'use strict';
/* AD.Talewyn — офлайн-оболочка. Книги живут в IndexedDB, здесь кэшируем
   только файлы приложения. Стратегия — network-first: при живом сервере
   всегда свежие файлы, без сети — копия из кэша. */
const CACHE = 'talewyn-v149';
const SHELL = [
  './', './index.html', './app.css?v=143', './app.js?v=147', './importers.js?v=22', './edge-tts.js?v=1',
  './jsmediatags.min.js?v=1', './fonts.css?v=9',
  './fonts/spectral-normal-400-cyrillic.woff2', './fonts/spectral-normal-400-latin.woff2',
  './fonts/spectral-normal-500-cyrillic.woff2', './fonts/spectral-normal-500-latin.woff2',
  './fonts/spectral-normal-600-cyrillic.woff2', './fonts/spectral-normal-600-latin.woff2',
  './fonts/spectral-normal-700-cyrillic.woff2', './fonts/spectral-normal-700-latin.woff2',
  './fonts/spectral-italic-400-cyrillic.woff2', './fonts/spectral-italic-400-latin.woff2',
  './fonts/spectral-italic-600-cyrillic.woff2', './fonts/spectral-italic-600-latin.woff2',
  './fonts/nunitosans-normal-400-cyrillic.woff2', './fonts/nunitosans-normal-400-latin.woff2',
  './fonts/nunitosans-normal-600-cyrillic.woff2', './fonts/nunitosans-normal-600-latin.woff2',
  './fonts/nunitosans-normal-700-cyrillic.woff2', './fonts/nunitosans-normal-700-latin.woff2',
  './fonts/nunitosans-normal-800-cyrillic.woff2', './fonts/nunitosans-normal-800-latin.woff2',
  './fonts/lora-cyrillic-400-normal.woff2', './fonts/lora-latin-400-normal.woff2',
  './fonts/lora-cyrillic-700-normal.woff2', './fonts/lora-latin-700-normal.woff2',
  './fonts/pt-serif-cyrillic-400-normal.woff2', './fonts/pt-serif-latin-400-normal.woff2',
  './fonts/pt-serif-cyrillic-700-normal.woff2', './fonts/pt-serif-latin-700-normal.woff2',
  './fonts/literata-cyrillic-400-normal.woff2', './fonts/literata-latin-400-normal.woff2',
  './fonts/literata-cyrillic-700-normal.woff2', './fonts/literata-latin-700-normal.woff2',
  './manifest.webmanifest', './icon.svg', './logo.png',
  './icon-180.png', './icon-192.png', './icon-512.png', './icon-512-maskable.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys())
      if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/api/')) return;   // озвучка всегда идёт в сеть
  e.respondWith((async () => {
    try {
      const resp = await fetch(e.request);
      if (resp.ok) {
        const c = await caches.open(CACHE);
        c.put(e.request, resp.clone());
      }
      return resp;
    } catch (err) {
      const hit = await caches.match(e.request, { ignoreSearch: false });
      if (hit) return hit;
      if (e.request.mode === 'navigate') {
        const shell = await caches.match('./');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
