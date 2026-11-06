// sw.js — Service Worker برای PWA Chop
// استراتژی: navigation = network-first (UI همیشه تازه)، static = cache-first

const CACHE_NAME = 'chop-v2-' + '20261105';
const STATIC_ASSETS = [
  '/',
  '/dashboard',
  '/manifest.json',
  '/icon.svg',
  '/icon-maskable.svg',
  '/qrcode.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // addAll fails if any request fails, so use individual adds
      Promise.all(STATIC_ASSETS.map((url) =>
        cache.add(url).catch(() => {})
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // فقط درخواست‌های same-origin رو هندل کن
  if (url.origin !== self.location.origin) return;

  // WebSocket upgrade — هندل نکن
  if (req.method !== 'GET') return;

  // API calls: همیشه شبکه (network-only)
  if (url.pathname.startsWith('/api/')) return;

  // سابسکریپشن و webhook ربات: network-only
  if (url.pathname.startsWith('/sub/') || url.pathname.startsWith('/bot/')) return;

  // Navigation requests: network-first
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then((r) => r || caches.match('/'))
        )
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req).then((res) => {
          // فقط GET‌های موفق رو کش کن
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
    )
  );
});

// پیام از کلاینت برای skipWaiting
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
