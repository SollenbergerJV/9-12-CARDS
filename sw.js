/* ============================================================
   The service worker: what makes this installable, and what
   lets the app open when the network is not there.

   Only the shell is cached. A game needs the server by
   definition, so there is nothing to gain from caching one and
   a great deal to lose from serving a stale board.
   ============================================================ */
const CACHE = 'ginco-shell-v1.4.0';
const SHELL = [
  '/', '/index.html', '/app.css',
  '/shared/engine.js', '/shared/kic.js',
  '/net.js', '/media.js', '/ui.js', '/kic-ui.js', '/online.js', '/boot.js',
  '/manifest.webmanifest', '/icons/icon.svg',
  '/icons/icon-192.png', '/icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      // one missing file must not fail the whole install
      .then(function (c) { return Promise.allSettled(SHELL.map(function (u) { return c.add(u); })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;          // fonts and the like: leave alone
  if (url.pathname === '/healthz') return;

  /* Network first, so an updated app reaches a player who already installed
     it; the cache is the fallback for being offline, not the default. */
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match('/index.html');
      });
    })
  );
});
