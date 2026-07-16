/* TeamHub service worker — Web Push (browser notifications, even when the tab
   is closed). Kept intentionally minimal. */

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data && event.data.text() }; }
  const title = payload.title || 'TeamHub';
  const options = {
    body: payload.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.data && payload.data.tag ? String(payload.data.tag) : undefined,
    data: payload.data || {},
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  // Deep-link hint the app can read off the URL hash when it focuses/opens.
  const url = data.channel_id ? `/#channel-${data.channel_id}` : (data.task_id ? `/#task-${data.task_id}` : '/');
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if ('focus' in client) { client.focus(); if ('navigate' in client) client.navigate(url).catch(() => {}); return; }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
