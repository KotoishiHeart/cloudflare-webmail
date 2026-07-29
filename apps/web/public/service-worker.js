const CACHE = 'cf-webmail-shell-v4';
const SHELL = [
  '/',
  '/index.html',
  '/admin.html',
  '/app.js',
  '/admin.js',
  '/manifest.webmanifest',
  '/icons/webmail.svg',
  '/icons/webmail-192.png',
  '/icons/webmail-512.png',
  '/styles/base.css',
  '/styles/layout.css',
  '/styles/components.css',
  '/styles/responsive.css',
  '/styles/admin.css',
  '/ui/api.js',
  '/ui/admin-api.js',
  '/ui/admin-dom.js',
  '/ui/admin-events.js',
  '/ui/admin-mailboxes.js',
  '/ui/admin-retention.js',
  '/ui/admin-users.js',
  '/ui/bulk-controller.js',
  '/ui/compose.js',
  '/ui/compose-draft.js',
  '/ui/format.js',
  '/ui/message-detail.js',
  '/ui/message-actions-controller.js',
  '/ui/message-list.js',
  '/ui/mailbox-settings-controller.js',
  '/ui/pwa.js',
  '/ui/rule-controller.js',
  '/ui/search.js',
  '/ui/settings-labels.js',
  '/ui/settings-rules.js',
  '/ui/shell.js',
  '/ui/state.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(cacheShell());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith('cf-webmail-shell-') && key !== CACHE)
        .map((key) => caches.delete(key)),
    )),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, url.pathname === '/admin.html' ? '/admin.html' : '/index.html'));
    return;
  }
  if (SHELL.includes(url.pathname)) event.respondWith(networkFirst(request, url.pathname));
});

async function networkFirst(request, fallback) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(new Request(request, { cache: 'no-cache' }));
    if (response.ok) {
      await cache.put(fallback, response.clone());
    }
    return response;
  } catch {
    return (await cache.match(fallback)) || Response.error();
  }
}

async function cacheShell() {
  const cache = await caches.open(CACHE);
  await Promise.all(SHELL.map(async (path) => {
    const request = new Request(new URL(path, self.location.origin), {
      cache: 'reload',
      credentials: 'same-origin',
    });
    const response = await fetch(request);
    if (!response.ok) throw new Error(`Could not cache ${path}: ${response.status}`);
    await cache.put(path, response);
  }));
}
