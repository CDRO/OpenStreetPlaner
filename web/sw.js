// Service Worker: empfängt Push-Nachrichten und zeigt sie als Benachrichtigung.
// Klick öffnet den Entwurf beim betreffenden Kommentar.

// Offline-Schale: die App-Dateien werden beim Installieren gecacht (Liste und Version vom Server),
// Seitenaufrufe fallen ohne Netz auf die gecachte Startseite zurück. API, Kacheln und Dienste bleiben Netzwerk.
const SHELL_VERSION = '__SHELL_VERSION__';
const SHELL_CACHE = `shell-${SHELL_VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const res = await fetch('/api/shell', { cache: 'no-cache' });
      const manifest = res.ok ? await res.json() : { files: [] };
      const cache = await caches.open(SHELL_CACHE);
      // cache: 'reload' holt jede Datei frisch vom Server, nie aus dem HTTP-Cache des Browsers
      await cache.addAll(['/', ...(manifest.files || [])].map((f) => new Request(f, { cache: 'reload' })));
    } catch {
      // ohne Netz keine Schale; der nächste Start versucht es erneut
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // Seite: Netz zuerst, sonst die gecachte Startseite (Entwurf kommt aus der Arbeitskopie)
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        const cached = await caches.match('/');
        return cached || new Response('Offline – keine gecachte Startseite.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }
  if (url.pathname.startsWith('/static/')) {
    // App-Dateien: Cache zuerst (Version wechselt mit dem Build), sonst Netz
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(req, res.clone());
      }
      return res;
    })());
  }
  // alles andere (API, Kacheln, Dienste): Browser-Standard
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Stadtplaner', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Stadtplaner';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    data: { url: data.url || '/' },
    icon: '/static/icon-192.png',
    badge: '/static/icon-192.png',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (client.url.split('#')[0] === url.split('#')[0] && 'focus' in client) {
        await client.focus();
        client.postMessage({ type: 'open-comment', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
