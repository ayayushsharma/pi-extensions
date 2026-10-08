// Tau Service Worker — minimal, just enables PWA install
// No aggressive caching since Tau connects to a live local server

const CACHE_NAME = 'tau-v1';

// Served for navigations that hit an auth challenge: unregisters workers
// and reloads without interception so the browser prompts for login.
const TAU_AUTH_RECOVERY_PAGE = '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width"><title>Tau \u2014 login required</title><style>body{display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#131316;color:#fff;font-family:-apple-system,sans-serif}</style></head><body><p>Login required \u2014 refreshing\u2026</p><script>navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));}).then(function(){location.reload();}).catch(function(){location.reload();});</script></body></html>';

// Cache only the app shell on install
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Tolerate partial precache (e.g. HTTP Basic Auth challenges a
      // subresource with 401) — a failed addAll must not kill install.
      return cache.addAll([
        '/',
        '/style.css',
        '/app.js',
        '/state.js',
        '/themes.js',
        '/markdown.js',
        '/message-renderer.js',
        '/tool-card.js',
        '/dialogs.js',
        '/session-sidebar.js',
        '/websocket-client.js',
        '/manifest.json',
      ]).catch(() => {});
    })
  );
  self.skipWaiting();
});

// Clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// Network-first strategy — always try live server, fall back to cache
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Don't cache API/WebSocket requests
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
    return;
  }

  // Navigations need special care: only a real network navigation lets the
  // browser show its native HTTP Basic Auth login dialog — a worker-served
  // 401 never prompts, leaving the cached shell talking to failing APIs.
  // On 401, serve a recovery page that drops stuck workers and reloads
  // natively so the login prompt appears. Offline still falls back to cache.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.status === 401) return new Response(TAU_AUTH_RECOVERY_PAGE, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
          if (response.ok && event.request.method === 'GET') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          return caches.match(event.request).then((cached) => {
            return cached || new Response('Tau is offline — start your pi session to connect.', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' },
            });
          });
        })
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Update cache with fresh response
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Offline — serve from cache
        return caches.match(event.request).then((cached) => {
          return cached || new Response('Tau is offline — start your pi session to connect.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
          });
        });
      })
  );
});
