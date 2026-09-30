// Service Worker: empfängt Push-Nachrichten und zeigt sie als Benachrichtigung.
// Klick öffnet den Entwurf beim betreffenden Kommentar.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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
