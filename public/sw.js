// Service worker: receives web pushes and opens the right page when one is tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let msg = { title: 'Sauna', body: '' };
  try { msg = event.data.json(); } catch { if (event.data) msg.body = event.data.text(); }
  event.waitUntil(
    self.registration.showNotification(msg.title, {
      body: msg.body || undefined,
      tag: msg.tag,
      silent: !!msg.silent,
      icon: '/icon-192.png',
      data: { url: msg.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) { c.navigate(url); return c.focus(); }
      }
      return self.clients.openWindow(url);
    }),
  );
});
