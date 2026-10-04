// SkyShift service worker: offline-first app shell, fresh data, resilient
// fallbacks.  The build stamps BUILD so each deploy installs a new cache.
const BUILD = '__BUILD__';
const SHELL = `skyshift-shell-${BUILD}`;
const DATA = 'skyshift-data-v1';
const MEDIA = 'skyshift-media-v1';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/tm.js', 'js/fits.js', 'js/worker.js', 'js/data.js', 'js/render.js', 'js/sky.js',
  'js/orbits.js', 'js/charts.js', 'js/gif.js', 'js/store.js', 'js/util.js',
  'img/allsky.webp', 'img/allsky-1000.webp',
  ...['orion-nebula-m42', 'north-ecliptic-pole-deep-field', 'south-ecliptic-pole-deep-field', 'barnard-s-star', 'wise-0855-0714', 'luhman-16-brown-dwarfs', 'proxima-centauri', 'galactic-centre-sgr-a', 'cygnus-x-dr21', 'rho-ophiuchi-cloud', 'eagle-nebula-pillars-of-creation', 'andromeda-galaxy-m31', '30-doradus-tarantula', 'v1647-ori-mcneil-s-nebula', 'herbig-haro-1-2', 'eta-carinae', 'crab-nebula-m1', 'boyajian-s-star', 'whirlpool-galaxy-m51', 'pleiades-m45'].map(n => `img/thumbs/${n}.webp`), 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
];
const DATA_WARM = ['data/meta.json', 'data/coverage.json', 'data/movers.json', 'data/exoplanets.json', 'data/news.json', 'data/images.json', 'data/cad.json', 'data/ephem.json'];

self.addEventListener('install', e => {
  self.skipWaiting();   // new versions take over immediately
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })));
    const d = await caches.open(DATA);
    await Promise.all(DATA_WARM.map(u => fetch(u, { cache: 'no-store' }).then(r => r.ok && d.put(u, r)).catch(() => {})));
    // warm the asteroid/comet catalogue in the background (not required to install)
    for (const u of ['data/sso.json', 'data/spherex_orbit.bin']) fetch(u).then(r => r.ok && d.put(u, r)).catch(() => {});
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('skyshift-shell-') && k !== SHELL) await caches.delete(k);
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {});
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

async function networkFirst(req, cacheName, ms, preload) {
  const c = await caches.open(cacheName);
  try {
    const r = await Promise.race([preload || fetch(req), timeout(ms)]);
    if (r && r.ok) c.put(req, r.clone());
    if (r) return r;
    throw new Error('no response');
  } catch {
    const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await caches.match('index.html') : null);
    return hit || Response.error();
  }
}

async function staleWhileRevalidate(e, cacheName, key) {
  const c = await caches.open(cacheName);
  const hit = await c.match(key || e.request, { ignoreSearch: true });
  const net = fetch(e.request).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(key || e.request, r.clone()); return r; }).catch(() => null);
  if (hit) { e.waitUntil(net); return hit; }
  return (await net) || new Response('offline', { status: 503, statusText: 'offline' });
}

async function cacheFirstLimited(e, cacheName, max = 150) {
  const c = await caches.open(cacheName);
  const hit = await c.match(e.request);
  if (hit) return hit;
  try {
    const r = await fetch(e.request);
    if (r && (r.ok || r.type === 'opaque')) {
      c.put(e.request, r.clone());
      c.keys().then(ks => { if (ks.length > max) ks.slice(0, ks.length - max).forEach(k => c.delete(k)); });
    }
    return r;
  } catch { return Response.error(); }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;   // SPHEREx range reads go straight to NASA
  const url = new URL(req.url);
  if (url.pathname.includes('/download/') || url.pathname.includes('/.well-known/')) return;   // app downloads go straight to the network
  if (req.mode === 'navigate') { e.respondWith(networkFirst(req, SHELL, 3500, e.preloadResponse)); return; }
  if (url.origin === location.origin) {
    if (url.pathname.includes('/data/')) {
      const key = url.pathname.slice(url.pathname.indexOf('/data/') + 1);
      e.respondWith(staleWhileRevalidate(e, DATA, key));
      return;
    }
    // app code: newest from the network when online, offline copy otherwise
    e.respondWith(networkFirst(req, SHELL, 3000));
    return;
  }
  // redundant mirrors of the data branch
  if (url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'raw.githubusercontent.com') { e.respondWith(staleWhileRevalidate(e, DATA)); return; }
  // reference imagery & NASA media: cache for offline viewing
  if (url.hostname === 'alasky.cds.unistra.fr' || url.hostname === 'images-assets.nasa.gov' || /(^|\.)nasa\.gov$/.test(url.hostname) && req.destination === 'image') {
    e.respondWith(cacheFirstLimited(e, MEDIA));
  }
  // everything else (live archive listings, name resolver, live feeds) -> network
});
