// Service worker for Revenue & Expenses dashboard.
// Caches the app shell so it loads instantly and works offline.
// Data (Supabase queries, fuel-prices.json, Anthropic API) always goes to the network.

const VERSION = 'v5';
const SHELL_CACHE = 'shell-' + VERSION;
const SHELL_ASSETS = [
  './',
  'index.html',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  // iOS launch splash screens — cached so first-run-after-install is instant.
  'icons/splash-1290x2796.png',
  'icons/splash-1179x2556.png',
  'icons/splash-1170x2532.png',
  'icons/splash-1125x2436.png',
  'icons/splash-1242x2688.png',
  'icons/splash-828x1792.png',
  'icons/splash-750x1334.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache cross-origin (Supabase, Anthropic, CDN scripts, fonts) — let the network handle them.
  // But fall back to cached shell assets when offline.
  if (url.origin !== self.location.origin) return;

  // Network-first for fuel-prices.json (so updates land immediately).
  if (url.pathname.endsWith('/data/fuel-prices.json')) {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Network-first for the HTML shell (index.html and the bare path that
  // serves it) — keeps online users on the latest code on every reload,
  // instead of one-reload-stale via stale-while-revalidate. Falls back
  // to the cached copy when offline so the dashboard still opens.
  if (req.mode === 'navigate' ||
      url.pathname === '/' ||
      url.pathname.endsWith('/') ||
      url.pathname.endsWith('/index.html')) {
    event.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req).then(c => c || caches.match('./')))
    );
    return;
  }

  // Stale-while-revalidate for the rest of the app shell.
  event.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
