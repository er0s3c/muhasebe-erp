const CACHE = 'erp-field-shell-v1';
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/offline.html', '/app-icon.svg', '/manifest.webmanifest'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'prepare') return;
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        const urls = ['/field-offline', '/favicon.png', '/theme-init.js', ...event.data.urls].filter((u) => {
          const url = new URL(u, self.location.origin);
          return url.origin === self.location.origin && !url.pathname.startsWith('/api/');
        });
        await Promise.all(
          urls.map(async (url) => {
            // The production SPA fallback only serves HTML when explicitly requested.
            const response = await fetch(url, ['/field-offline', '/offline-drafts'].includes(new URL(url, self.location.origin).pathname)
              ? { headers: { Accept: 'text/html' } }
              : undefined);
            if (!response.ok) throw new Error('cache failed');
            await cache.put(url, response);
          }),
        );
        event.ports[0]?.postMessage({ ok: true });
      } catch {
        event.ports[0]?.postMessage({ ok: false });
      }
    })(),
  );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  )
    return;
  event.respondWith(
    (async () => {
      try {
        return await fetch(event.request);
      } catch {
        const cache = await caches.open(CACHE);
        return (
          (await cache.match(event.request, {ignoreVary:true})) ||
          (event.request.mode === 'navigate' ? (['/field-offline', '/offline-drafts'].includes(url.pathname) ? await cache.match(url.pathname) : null) || await cache.match('/offline.html') : null) ||
          new Response('Çevrimdışı dosya bulunamadı', { status: 503 })
        );
      }
    })(),
  );
});
