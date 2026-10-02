// Offline support for Template Maker.
//
// - This app's own files (page, scripts, styles, icons): always checked with
//   the server when online, so updates arrive on the next open; the stored
//   copy is used when offline.
// - Pinned-version libraries and models from jsDelivr (≈60 MB the first time)
//   and Google Fonts files: stored on first use and served from storage after
//   that, online or not. Their URLs carry exact versions, so they never change.
// Anything else (cloud saving, sign-in) goes straight to the network.

const APP = 'tm-app';
const LIB = 'tm-lib-v1';
const SCOPE = new URL(self.registration.scope).pathname;

// On install, store the app itself: the page plus every file it lists
// (scripts, styles, icons, and the module URLs in its import map), so it opens
// offline even if the first visit ended before this worker took over.
self.addEventListener('install', (e) => e.waitUntil((async () => {
  const cache = await caches.open(APP);
  const page = await fetch(SCOPE, { cache: 'no-cache' });
  if (!page.ok) return self.skipWaiting();
  const html = await page.clone().text();
  await cache.put(SCOPE, page);
  const urls = new Set(); const libs = new Set();
  for (const m of html.matchAll(/(?:src|href)="([^"#]+)"|"(\.\/[\w.-]+\.js\?v=[^"]+)"/g)) {
    const u = new URL((m[1] || m[2]).replace(/&amp;/g, '&'), self.registration.scope);
    if (u.origin === self.location.origin && u.pathname.startsWith(SCOPE)) urls.add(u.href);
    else if ((u.hostname === 'cdn.jsdelivr.net' && /@\d/.test(u.pathname)) || u.hostname === 'fonts.googleapis.com') libs.add(u.href);
  }
  urls.add(new URL('manifest.webmanifest', self.registration.scope).href);
  const lib = await caches.open(LIB);
  await Promise.all([
    ...[...urls].map(async (u) => {
      try { const r = await fetch(u, { cache: 'no-cache' }); if (r.ok) await cache.put(u, r); } catch { /* stored on first use instead */ }
    }),
    // Libraries the page loads directly (they may load before this worker takes over).
    ...[...libs].map(async (u) => {
      try { if (!(await lib.match(u))) { const r = await fetch(u, { mode: 'cors' }); if (r.ok) await lib.put(u, r); } } catch { /* stored on first use instead */ }
    }),
  ]);
  await self.skipWaiting();
})()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith(SCOPE)) e.respondWith(fresh(req));
  } else if (url.hostname === 'cdn.jsdelivr.net' && /@\d/.test(url.pathname)) {
    e.respondWith(stored(req));
  } else if (url.hostname === 'fonts.gstatic.com') {
    e.respondWith(stored(req));
  } else if (url.hostname === 'fonts.googleapis.com') {
    e.respondWith(fresh(req, LIB));
  }
});

/** Server first (skipping the browser's short-term cache), stored copy when offline. */
async function fresh(req, name = APP) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) {
      await cache.put(req, res.clone());
      if (name === APP) prune(cache, req.url);
    }
    return res;
  } catch (err) {
    const hit = await cache.match(req) || (req.mode === 'navigate' ? await cache.match(SCOPE) || await cache.match(req, { ignoreSearch: true }) : null);
    if (hit) return hit;
    throw err;
  }
}

/** Stored copy if there is one; otherwise download, store and return it. */
async function stored(req) {
  const cache = await caches.open(LIB);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && (res.type === 'cors' || res.type === 'basic')) cache.put(req, res.clone());
  return res;
}

/** Drop older versions of the same file (app.js?v=old) once a new one is stored. */
async function prune(cache, url) {
  const u = new URL(url);
  if (!u.search) return;
  for (const key of await cache.keys()) {
    const k = new URL(key.url);
    if (k.pathname === u.pathname && k.search !== u.search) cache.delete(key);
  }
}
