/*
 * Konso — offline cache of the web version (service worker).
 *
 * tools/build-web.js fills in VERSION (a hash of every file of the site) and FILES (the list of those
 * files, relative to this script) when it builds the site. The browser installs a new version of this
 * worker whenever a file changes, because VERSION then changes too.
 *
 * - install: every file of the app is downloaded into a cache named after the scope and the version,
 *   so Konso, the OCR engine included, works without internet from then on;
 * - activate: the caches of older versions of this same site are deleted (a test build published in
 *   /test/<branch>/ has its own scope, so its caches are never touched, and the other way round);
 * - fetch: the app's own files come from the cache; anything else goes to the network as usual.
 */
const VERSION = "e2e1a39eddd3";
const FILES = ["app.css","app.js","i18n.js","icons/apple-touch-icon.png","icons/icon-192.png","icons/icon-512.png","icons/icon.svg","icons/maskable-512.png","index.html","manifest.webmanifest","parse.js","vendor/LICENSE","vendor/LICENSE-leaflet.txt","vendor/LICENSE.md","vendor/lang/fra.traineddata.gz","vendor/leaflet.css","vendor/leaflet.js","vendor/tesseract-core-simd-lstm.wasm.js","vendor/tesseract.min.js","vendor/worker.min.js"];

const SCOPE = self.registration.scope; // e.g. https://example.github.io/Konso/
const PREFIX = 'konso ' + SCOPE + ' ';
const CACHE = PREFIX + VERSION;

self.addEventListener('install', e => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith(SCOPE)) return;
  const rel = new URL(req.url).pathname.slice(new URL(SCOPE).pathname.length);
  // The start page: the root of the site (with or without index.html).
  const file = req.mode === 'navigate' && (rel === '' || rel === 'index.html') ? 'index.html' : rel;
  if (!FILES.includes(file)) return;
  // caches.match with cacheName never creates a cache (caches.open would re-create a deleted one).
  e.respondWith(caches.match(file, { cacheName: CACHE, ignoreSearch: true }).then(r => r || fetch(req)));
});
