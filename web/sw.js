// Service Worker: Offline-Betrieb und Push-Benachrichtigungen
const CACHE = 'athan-v1.3.1';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/praytimes.js', 'js/store.js', 'js/audio.js', 'js/platform.js', 'js/astro.js', 'js/hijri.js', 'js/sky.js', 'js/palette.js',
  'widget/athan-widget.js',
  'muezzins.json', 'config.json', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/badge-96.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;       // Ortssuche, Audioquellen: direkt
  if (url.pathname.includes('/api/') || url.pathname.includes('/audio/')) return;  // Server-API und Audio (Range-Anfragen)
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('index.html', copy)); return r; })
      .catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => {
    const net = fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; });
    return hit || net;
  }));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Athan', body: e.data?.text() || '' }; }
  const title = d.title || 'Athan';
  const opts = {
    body: d.body || '', tag: d.tag || 'athan', renotify: true, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png',
    data: { url: d.url || './', prayer: d.prayer, at: d.at }, requireInteraction: !!d.athan, vibrate: [180, 90, 180],
  };
  e.waitUntil((async () => {
    await self.registration.showNotification(title, opts);
    if (d.athan && d.prayer) {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clients) if (c.visibilityState === 'visible') c.postMessage({ type: 'athan', prayer: d.prayer, at: d.at });
    }
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  const url = new URL(d.url || './', self.registration.scope);
  if (d.prayer && d.at) { url.searchParams.set('athan', d.prayer); url.searchParams.set('at', String(d.at)); }
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        if (d.prayer && d.at) c.postMessage({ type: 'athan', prayer: d.prayer, at: d.at, fromTap: true });
        return c.focus();
      }
    }
    return self.clients.openWindow(url.href);
  })());
});
