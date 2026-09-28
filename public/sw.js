// Service worker volontairement minimal : il ne met en cache que l'habillage statique de
// l'application (JS, CSS, icônes), jamais les données. Les appels /api, /ical, /presence et
// /import passent toujours directement au réseau, pour ne jamais afficher une donnée familiale
// périmée ou masquer une erreur de connexion.
const CACHE_VERSION = 'mosaique-shell-v1';
const SHELL_URLS = [
  '/',
  '/css/styles.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isShellRequest(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ical/') || url.pathname.startsWith('/presence/') || url.pathname.startsWith('/import/')) return false;
  return url.pathname === '/' || url.pathname.startsWith('/js/') || url.pathname.startsWith('/css/') || url.pathname.startsWith('/icons/') || url.pathname.startsWith('/fonts/') || url.pathname === '/manifest.webmanifest';
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || !isShellRequest(url)) return; // laisse passer tout le reste tel quel (API, uploads...)

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/')))
  );
});

// Notifications push : le contenu vient toujours de notre propre serveur (voir server/push.js),
// jamais d'un tiers.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* payload non-JSON : on affiche un message générique */ }
  const title = data.title || 'Mosaïque';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { link: data.link || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '/';
  const url = self.location.origin + '/' + String(link).replace(/^\//, '');
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
      return self.clients.openWindow(url);
    })
  );
});
