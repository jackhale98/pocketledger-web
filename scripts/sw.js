// @ts-nocheck (template: the build fills in __VERSION__, __FILES__, __ENGINE__)
// PocketLedger's service worker: the app opens with no connection.
// - The app shell (pages, hashed JS/CSS, icons, manifest) is precached on install.
// - The hledger engine is runtime-cached under its content-addressed name, so an
//   engine update is atomic: a new name, a new cache entry.
// - Journals live in IndexedDB, not here. Requests to other origins (Dropbox,
//   GitHub, the git proxy) are never touched.

const VERSION = '__VERSION__';
const FILES = __FILES__;
const ENGINE = '__ENGINE__';
const SHELL = `pl-shell-${VERSION}`;
const ENGINE_CACHE = 'pl-engine';
const NETWORK_WAIT = 3500;
const MATCH = { ignoreVary: true, ignoreSearch: true };

const scope = new URL(self.registration.scope);
const url = (path) => new URL(path, scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await cache.addAll(FILES.map(url));
      // Fetch the engine during install too, so the first offline open works.
      const engine = await caches.open(ENGINE_CACHE);
      if (!(await engine.match(url(ENGINE)))) {
        try {
          await engine.add(url(ENGINE));
        } catch {
          /* fetched on first use instead */
        }
      }
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith('pl-shell-') && k !== SHELL) await caches.delete(k);
      const engine = await caches.open(ENGINE_CACHE);
      for (const req of await engine.keys()) if (req.url !== url(ENGINE)) await engine.delete(req);
      await self.clients.claim();
    })(),
  );
});

function pageKey(requestUrl) {
  const u = new URL(requestUrl);
  const path = u.pathname.slice(scope.pathname.length).replace(/\/?$/, '/');
  if (path.startsWith('app/')) return url('app/');
  if (path === '/' || path === '') return url('./');
  return null;
}

async function page(request) {
  const key = pageKey(request.url);
  const network = fetch(request).then(async (response) => {
    if (key && response.ok) await (await caches.open(SHELL)).put(key, response.clone());
    return response;
  });
  if (!key) return network;
  const match = await caches.match(key, MATCH);
  if (!match) return network;
  const stored = match.redirected ? new Response(match.body, match) : match;
  const late = new Promise((resolve) => setTimeout(() => resolve(stored), NETWORK_WAIT));
  return Promise.race([network.catch(() => stored), late]);
}

async function engineFile(request) {
  const cache = await caches.open(ENGINE_CACHE);
  const hit = await cache.match(request, MATCH);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function file(request) {
  const stored = await caches.match(request, MATCH);
  if (stored) return stored;
  const response = await fetch(request);
  if (response.ok && new URL(request.url).pathname.includes('/_astro/'))
    await (await caches.open(SHELL)).put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const u = new URL(request.url);
  if (u.origin !== scope.origin || !u.pathname.startsWith(scope.pathname)) return;
  if (u.pathname.startsWith(`${scope.pathname}auth/`)) return;
  if (u.pathname.endsWith('.wasm')) return event.respondWith(engineFile(request));
  event.respondWith(request.mode === 'navigate' ? page(request) : file(request));
});
