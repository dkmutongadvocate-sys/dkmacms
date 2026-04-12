// DKMA CMS Service Worker — Background Push Notifications
// Deploy this as sw.js at the root of the CMS GitHub Pages site

const SW_VERSION = '1.0.0';

// ── INSTALL & ACTIVATE ────────────────────────────────────────────
self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// ── PUSH EVENT — fires even when tab is closed ────────────────────
self.addEventListener('push', e => {
  let payload = { title: '🚨 DKMA Alert', body: 'You have a new notification.', tag: 'dkma-alert', urgent: false };
  try { if (e.data) payload = { ...payload, ...e.data.json() }; } catch {}

  const options = {
    body: payload.body,
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    tag: payload.tag || 'dkma-alert',       // replaces previous notification with same tag
    renotify: true,
    requireInteraction: payload.urgent,      // stays on screen until dismissed for SOS
    vibrate: payload.urgent ? [200, 100, 200, 100, 400] : [200],
    data: { url: payload.url || '/', urgent: payload.urgent },
    actions: payload.urgent
      ? [{ action: 'open', title: '🚨 Open CMS' }]
      : [{ action: 'open', title: 'View' }]
  };

  e.waitUntil(self.registration.showNotification(payload.title, options));
});

// ── NOTIFICATION CLICK — focus or open the CMS tab ───────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = e.notification.data?.url || '/';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Find an existing CMS tab and focus it
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          client.postMessage({ type: 'NOTIFICATION_CLICK', url: targetUrl });
          return;
        }
      }
      // No tab open — open a new one
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// ── PERIODIC BACKGROUND SYNC (Chrome only, bonus) ─────────────────
// Registered from the CMS page; fires roughly every 5 mins in background
self.addEventListener('periodicsync', e => {
  if (e.tag === 'dkma-panic-check') {
    e.waitUntil(checkForPanicAlerts());
  }
});

async function checkForPanicAlerts() {
  // SW has no access to the page's JS variables, so we read config from IndexedDB
  // (the CMS page writes SUPABASE_URL + KEY + session token there on login)
  try {
    const config = await readSwConfig();
    if (!config?.url || !config?.key || !config?.token) return;

    const res = await fetch(`${config.url}/rest/v1/panic_alerts?resolved=eq.false&acknowledged=eq.false&select=id,triggered_at,situation,client_id&order=triggered_at.desc&limit=5`, {
      headers: {
        'apikey': config.key,
        'Authorization': `Bearer ${config.token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) return;
    const alerts = await res.json();
    if (!alerts?.length) return;

    // Check if we've already notified about these
    const knownIds = await readKnownAlertIds();
    const newAlerts = alerts.filter(a => !knownIds.has(a.id));
    if (!newAlerts.length) return;

    // Store new IDs so we don't re-notify
    await writeKnownAlertIds(new Set([...knownIds, ...newAlerts.map(a => a.id)]));

    // Fire notification for each new alert
    for (const alert of newAlerts) {
      await self.registration.showNotification('🚨 CLIENT EMERGENCY — DKMA', {
        body: `Emergency alert received. Open CMS immediately.`,
        tag: `panic-${alert.id}`,
        requireInteraction: true,
        vibrate: [200, 100, 200, 100, 400],
        renotify: true,
        data: { url: '/', urgent: true }
      });
    }
  } catch (err) {
    console.warn('[DKMA SW] Panic check failed:', err);
  }
}

// ── INDEXEDDB HELPERS (SW ↔ CMS page communication) ──────────────
function openDb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('dkma-sw-store', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('kv');
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror = () => rej(req.error);
  });
}

async function dbGet(key) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function dbSet(key, value) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function readSwConfig() {
  return await dbGet('swConfig');
}

async function readKnownAlertIds() {
  const ids = await dbGet('knownAlertIds');
  return new Set(ids || []);
}

async function writeKnownAlertIds(idSet) {
  // Keep only the last 100 to avoid unbounded growth
  const arr = [...idSet].slice(-100);
  await dbSet('knownAlertIds', arr);
}
