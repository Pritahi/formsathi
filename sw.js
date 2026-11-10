/* FormSathi service worker — MVP feature 6 (offline-first).
 *
 * Strategy, chosen for a 2G village connection rather than for a lighthouse
 * score:
 *   • App shell (HTML/JS/CSS/manifest/icons): precached on install, served
 *     cache-first. Second launch is instant and works with the radio off.
 *   • Sample forms: cache-first too (they are the demo's raw material).
 *   • Everything else: stale-while-revalidate, so a returning user always gets
 *     the cached app instantly and the update lands next time.
 *   • NEVER cached: anything to Firebase (firestore, storage, AI Logic). Those
 *     must fail loudly so the app queues work instead of serving a stale lie.
 */

const VERSION = 'v1.0.2';
const SHELL_CACHE = `formsathi-shell-${VERSION}`;
const RUNTIME_CACHE = `formsathi-runtime-${VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './samples/scholarship-form.jpg',
  './samples/bank-form.jpg',
  './samples/scholarship-form-instructions.jpg',
];

/** Never cache these — a cached AI response or a cached Firestore read is a bug
 *  that looks like a feature. */
const NEVER_CACHE = [
  'firestore.googleapis.com',
  'firebasestorage.googleapis.com',
  'firebasevertexai.googleapis.com',
  'generativelanguage.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
];

/**
 * Precache the hashed build assets too.
 *
 * On the very first visit the worker is not yet controlling the page, so the
 * JS/CSS bundle fetch never passes through our fetch handler — meaning it would
 * NOT be in the cache when the user goes offline, and a cold offline launch
 * would render only the HTML skeleton. Vite hashes asset filenames, so the only
 * way to know them is to read index.html and follow its <script>/<link> tags.
 */
async function precacheBuildAssets(cache) {
  try {
    const res = await cache.match('./index.html');
    if (!res) return;
    const html = await res.text();
    const urls = new Set();

    // <script type="module" src="./assets/x.js">
    for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) urls.add(m[1]);
    // <link rel="stylesheet" href="..."> and <link rel="modulepreload" href="...">
    for (const m of html.matchAll(/<link[^>]+href="([^"]+\.(?:css|js))"/g)) urls.add(m[1]);
    // Preload the PDF worker lazily only when a PDF is used, but cache the
    // firebase chunk so a returning user's first live call is not a stall.
    for (const m of html.matchAll(/"(\.?\/?assets\/[^"]+\.(?:js|css))"/g)) urls.add(m[1]);

    // Store each asset under BOTH the absolute URL and its relative form.
    // Chrome resolves the module request from the document's base URI, so this
    // app's `./assets/x.js` can arrive as either ".../assets/x.js" or
    // "..././assets/x.js" depending on how it was requested — a cache miss on
    // that difference is exactly what breaks a cold offline launch.
    for (const u of urls) {
      const abs = new URL(u, self.registration.scope).href;
      const rel = abs.replace(self.registration.scope, './');
      try {
        const res = await fetch(abs, { cache: 'reload' });
        if (!res.ok) continue;
        const body = await res.clone().arrayBuffer();
        const contentType = res.headers.get('content-type') ?? '';
        const headers = contentType ? { 'Content-Type': contentType } : undefined;
        await cache.put(abs, new Response(body, { status: 200, headers }));
        if (rel !== abs) await cache.put(rel, new Response(body, { status: 200, headers }));
      } catch {
        /* one asset failing must not abort the rest */
      }
    }
  } catch {
    /* a failed precache must never break install */
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Individually so one 404 cannot fail the whole install.
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined),
        ),
      );
      await precacheBuildAssets(cache);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('formsathi-') && k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function shouldNeverCache(url) {
  return NEVER_CACHE.some((host) => url.includes(host));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (shouldNeverCache(url.href)) return; // let the network handle it
  if (url.origin !== self.location.origin) return; // no third-party caching

  // Navigations: network-first with an instant cache fallback, so a deploy is
  // picked up on the next online launch but a cold offline launch still works.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(SHELL_CACHE);
          cache.put('./index.html', fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match('./index.html')) ?? (await cache.match('./')) ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Samples + icons: cache-first.
  if (/\/samples\/|\/icons\//.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const fresh = await fetch(req);
          cache.put(req, fresh.clone());
          return fresh;
        } catch {
          return hit ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Hashed build assets: cache-first, they are immutable.
  if (/\/assets\//.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const shell = await caches.open(SHELL_CACHE);
        const shellHit = await shell.match(req);
        if (shellHit) return shellHit;

        const cache = await caches.open(RUNTIME_CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;

        try {
          const fresh = await fetch(req);
          if (fresh.ok) cache.put(req, fresh.clone());
          return fresh;
        } catch {
          // Last resort for a JS chunk we need offline: nothing sensible to
          // return, so surface a real network error rather than a broken module.
          return Response.error();
        }
      })(),
    );
    return;
  }

  // Everything else: stale-while-revalidate.
  event.respondWith(
    (async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      const hit = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit ?? Response.error());
      return hit ?? network;
    })(),
  );
});

/* Lets the app ask "are you the newest worker?" after a deploy. */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'VERSION') event.source?.postMessage({ type: 'VERSION', version: VERSION });
});
