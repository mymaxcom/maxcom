const BUILD = '__MAXCOM_BUILD__';
const FILES = __MAXCOM_FILES__;

const SHELL_CACHE = 'maxcom-shell-' + BUILD;
const NAVIGATION_TIMEOUT_MS = 4000;

// Files that change with the surau (logo, short name) or with a release: always
// ask the network first, the cache is only the offline fallback.
function isNetworkFirstPath(path) {
  return (
    path === '/app/' ||
    path === '/app/index.html' ||
    path === '/app/manifest.json' ||
    path === '/app/favicon.png' ||
    path.startsWith('/app/icons/')
  );
}

// The iOS help page and the profile are served by the box, never by the app
// shell: no cached index may stand in for them.
function isIosPath(path) {
  return path === '/app/ios' || path === '/app/ios.mobileconfig';
}

// No skipWaiting: a new build waits and takes over at the next launch, so a
// running session never swaps its files underneath itself.
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(FILES)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // Every other cache (older shells, Flutter's own flutter-app-cache and
      // friends) is dropped so the storage is reclaimed.
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))))
    // clients.claim() is left out on purpose: the page that registered this
    // worker keeps working from the network until its next launch.
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only same-origin GETs under /app/ are this worker's business.
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  if (!path.startsWith('/app/')) return;
  if (isIosPath(path)) return;

  if (request.mode === 'navigate' || isNetworkFirstPath(path)) {
    event.respondWith(networkFirstWithTimeout(event, request, SHELL_CACHE, NAVIGATION_TIMEOUT_MS));
  } else {
    event.respondWith(cacheFirst(event, request, SHELL_CACHE));
  }
});

function cacheable(response) {
  return response && response.status === 200 && response.type === 'basic';
}

function store(event, cache, request, response) {
  if (!cacheable(response)) return;
  event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
}

async function networkFirstWithTimeout(event, request, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);

  let networkResolved = false;
  let networkError = null;
  const networkPromise = fetch(request)
    .then((response) => {
      networkResolved = true;
      store(event, cache, request, response);
      return response;
    })
    .catch((error) => {
      networkError = error;
      return null;
    });

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve(null), timeoutMs);
  });

  const networkResponse = await Promise.race([networkPromise, timeoutPromise]);
  if (networkResponse) {
    return networkResponse;
  }

  const fallbackRequest = request.mode === 'navigate' ? 'index.html' : request;
  const cachedResponse = await cache.match(fallbackRequest);
  if (cachedResponse) {
    return cachedResponse;
  }

  if (!networkResolved) {
    return networkPromise;
  }

  throw networkError || new Error('Network request failed');
}

async function cacheFirst(event, request, cacheName) {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  const networkResponse = await fetch(request);
  store(event, cache, request, networkResponse);
  return networkResponse;
}
