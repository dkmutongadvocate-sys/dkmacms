// DKMA Service Worker — handles PWA install, offline shell caching, push notifications
const CACHE_NAME = 'dkma-v1';
// Derive base path dynamically so this SW works in any GitHub Pages repo
const SW_BASE = self.location.pathname.replace(/sw\.js$/, '');
const PORTAL_SHELL = SW_BASE;
const CMS_SHELL = SW_BASE;  // both apps are index.html in their respective repos

// ── Install: pre-cache both app shells ────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll([PORTAL_SHELL, CMS_SHELL]).catch(() => {})
      // Silently fail if offline during install — PWA will still work when online
    )
  );
  self.skipWaiting();
});

// ── Activate: clear old caches ─────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first for API/Supabase, cache-first for shells ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always network-first for Supabase, fonts, CDN
  if (
    url.hostname.includes('supabase') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('jsdelivr') ||
    url.hostname.includes('accounts.google') ||
    event.request.method !== 'GET'
  ) {
    return; // Let browser handle
  }

  // For navigation requests to the app shells — serve from cache if offline
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Update cache with fresh version
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request).then(r => r || caches.match(SW_BASE)))
    );
  }
});

// ── Push Notifications ─────────────────────────────────────────────
// Receives push payloads sent from Supabase Edge Functions or your backend.
// Payload format: { title, body, icon, url, tag }
self.addEventListener('push', event => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); }
  catch { payload = { title: 'DKMA', body: event.data.text() }; }

  const options = {
    body: payload.body || '',
    icon: payload.icon || SW_BASE + 'icons/icon-192.png',
    badge: SW_BASE + 'icons/badge-72.png',
    tag: payload.tag || 'dkma-notification',
    data: { url: payload.url || '/dkmaclient/' },
    requireInteraction: false,
    actions: payload.actions || [],
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'DKMA', options)
  );
});

// ── Notification click: focus or open the app ─────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || SW_BASE;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Focus existing tab if open
      for (const client of windowClients) {
        if (client.url.includes(SW_BASE) && 'focus' in client) {
          client.postMessage({ type: 'NOTIFICATION_CLICK', url: targetUrl });
          return client.focus();
        }
      }
      // Otherwise open new window
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
