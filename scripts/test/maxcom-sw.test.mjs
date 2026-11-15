import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const swPath = join(__dirname, '..', '..', 'apps', 'surau-app', 'web', 'maxcom_sw.js');
const swSource = readFileSync(swPath, 'utf8');

function makeResponse(url, options = {}) {
  return {
    url,
    ok: options.ok !== false,
    status: options.status || 200,
    type: options.type || 'basic',
    _source: options.source || 'network',
    clone() {
      return makeResponse(url, { ...options });
    },
  };
}

const calls = { skipWaiting: 0, claim: 0 };

function makeSelf(origin = 'https://box.example.com') {
  const listeners = {};
  return {
    location: { origin },
    addEventListener(type, handler) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(handler);
    },
    skipWaiting: () => {
      calls.skipWaiting++;
      return Promise.resolve();
    },
    clients: {
      claim: async () => {
        calls.claim++;
      },
    },
    _listeners: listeners,
  };
}

function makeCaches(self, fetch) {
  const store = new Map();
  return {
    _store: store,
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      const cache = store.get(name);
      return {
        async match(request) {
          const key = normalizeKey(request, self);
          return cache.get(key) || null;
        },
        async put(request, response) {
          const key = normalizeKey(request, self);
          response._cached = true;
          cache.set(key, response);
        },
        async addAll(urls) {
          for (const url of urls) {
            const fullUrl = self.location.origin + '/app/' + url;
            const response = await fetch(new Request(fullUrl));
            response._cached = true;
            cache.set(fullUrl, response);
          }
        },
      };
    },
    async keys() {
      return Array.from(store.keys());
    },
    async delete(name) {
      return store.delete(name);
    },
  };
}

function normalizeKey(request, self) {
  if (typeof request === 'string') {
    if (request.startsWith('/')) return self.location.origin + request;
    return self.location.origin + '/app/' + request;
  }
  return request.url;
}

function makeEvent() {
  const waits = [];
  return {
    waitUntil(p) {
      waits.push(p);
      return p;
    },
    _waits: waits,
  };
}

function makeFetchEvent(request, options = {}) {
  const calls = [];
  return {
    request,
    waitUntil() {},
    respondWith(response) {
      calls.push(response);
      if (options.respondWith) options.respondWith(response);
    },
    _respondWithCalls: calls,
  };
}

function makeRequest(url, options = {}) {
  return {
    url,
    method: options.method || 'GET',
    mode: options.mode || 'no-cors',
  };
}

class Request {
  constructor(url) {
    this.url = url;
  }
}

async function loadSw(build = 'test', files = ['index.html', 'manifest.json'], options = {}) {
  const self = makeSelf(options.origin);
  const fetchLog = [];
  const fetchImpl = {
    fn:
      options.fetchImpl ||
      (async (request) => makeResponse(typeof request === 'string' ? request : request.url)),
  };
  const fetch = async (request) => {
    fetchLog.push(typeof request === 'string' ? request : request.url);
    return fetchImpl.fn(request);
  };
  const caches = makeCaches(self, fetch);
  const clients = self.clients;

  const source = swSource
    .replace("__MAXCOM_BUILD__", build)
    .replace("__MAXCOM_FILES__", JSON.stringify(files));

  const fn = new Function('self', 'caches', 'fetch', 'clients', 'Request', source);
  fn(self, caches, fetch, clients, Request);

  return { self, caches, fetchLog, fetch, fetchImpl, clients };
}

async function dispatchInstall(env) {
  const event = makeEvent();
  for (const handler of env.self._listeners.install || []) {
    handler(event);
  }
  await Promise.all(event._waits);
}

async function dispatchActivate(env) {
  const event = makeEvent();
  for (const handler of env.self._listeners.activate || []) {
    handler(event);
  }
  await Promise.all(event._waits);
}

async function dispatchFetch(env, request, options = {}) {
  const event = makeFetchEvent(request, options);
  for (const handler of env.self._listeners.fetch || []) {
    handler(event);
  }
  if (event._respondWithCalls.length > 0) {
    return event._respondWithCalls[0];
  }
  return undefined;
}

test('precaches files on install', async () => {
  const env = await loadSw('v1', ['index.html', 'manifest.json']);
  await dispatchInstall(env);
  const cache = env.caches._store.get('maxcom-shell-v1');
  assert.ok(cache);
  assert.ok(cache.has('https://box.example.com/app/index.html'));
  assert.ok(cache.has('https://box.example.com/app/manifest.json'));
});

test('does not intercept /api/ requests', async () => {
  const env = await loadSw();
  await dispatchInstall(env);
  const req = makeRequest('https://box.example.com/api/foo');
  const responded = await dispatchFetch(env, req);
  assert.strictEqual(responded, undefined);
});

test('does not intercept other origins', async () => {
  const env = await loadSw();
  await dispatchInstall(env);
  const req = makeRequest('https://other.example.com/app/foo.js');
  const responded = await dispatchFetch(env, req);
  assert.strictEqual(responded, undefined);
});

test('does not intercept non-GET requests', async () => {
  const env = await loadSw();
  await dispatchInstall(env);
  const req = makeRequest('https://box.example.com/app/foo.js', { method: 'POST' });
  const responded = await dispatchFetch(env, req);
  assert.strictEqual(responded, undefined);
});

test('does not intercept /assets/, /surau-logo, or /islamic/', async () => {
  const env = await loadSw();
  await dispatchInstall(env);
  for (const path of ['/assets/logo.png', '/surau-logo', '/islamic/foo.png']) {
    const req = makeRequest('https://box.example.com' + path);
    const responded = await dispatchFetch(env, req);
    assert.strictEqual(responded, undefined, path);
  }
});

test('navigation falls back to cache when the network fails', async () => {
  const env = await loadSw('v1', ['index.html', 'manifest.json']);
  await dispatchInstall(env);
  env.fetchImpl.fn = async () => {
    throw new Error('network offline');
  };

  const req = makeRequest('https://box.example.com/app/', { mode: 'navigate' });
  const responded = await dispatchFetch(env, req);
  assert.ok(responded, 'should return cached response');
  assert.strictEqual(responded._source, 'network');
  assert.ok(responded._cached, 'response came from cache');
  assert.strictEqual(responded.url, 'https://box.example.com/app/index.html');
});

test('old caches are removed on activate', async () => {
  const env = await loadSw('v2', ['index.html']);
  await env.caches.open('maxcom-shell-v1');
  assert.ok(env.caches._store.has('maxcom-shell-v1'));
  await dispatchInstall(env);
  await dispatchActivate(env);
  assert.ok(!env.caches._store.has('maxcom-shell-v1'));
  assert.ok(env.caches._store.has('maxcom-shell-v2'));
});

test('cache-first serves shell files from cache', async () => {
  const env = await loadSw('v1', ['index.html', 'main.dart.js']);
  await dispatchInstall(env);
  const req = makeRequest('https://box.example.com/app/main.dart.js');
  const responded = await dispatchFetch(env, req);
  assert.ok(responded);
  assert.ok(responded._cached);
  assert.strictEqual(responded.url, 'https://box.example.com/app/main.dart.js');
});

test('install does not skipWaiting and activate does not claim', async () => {
  calls.skipWaiting = 0;
  calls.claim = 0;
  const env = await loadSw('v1', ['index.html']);
  await dispatchInstall(env);
  await dispatchActivate(env);
  assert.strictEqual(calls.skipWaiting, 0);
  assert.strictEqual(calls.claim, 0);
});

test('activate deletes every other cache, Flutter caches included', async () => {
  const env = await loadSw('v2', ['index.html']);
  await env.caches.open('flutter-app-cache');
  await env.caches.open('flutter-temp-cache');
  await env.caches.open('maxcom-shell-v1');
  await dispatchInstall(env);
  await dispatchActivate(env);
  assert.deepStrictEqual(Array.from(env.caches._store.keys()), ['maxcom-shell-v2']);
});

test('index, manifest, favicon and icons are network-first', async () => {
  const env = await loadSw('v1', ['index.html', 'manifest.json', 'favicon.png', 'icons/Icon-192.png']);
  await dispatchInstall(env);
  env.fetchImpl.fn = async (request) => makeResponse(request.url, { source: 'fresh' });
  for (const path of ['/app/index.html', '/app/manifest.json', '/app/favicon.png', '/app/icons/Icon-192.png']) {
    const responded = await dispatchFetch(env, makeRequest('https://box.example.com' + path));
    assert.strictEqual(responded._source, 'fresh', path);
  }
});

test('/app/ios and /app/ios.mobileconfig are never intercepted', async () => {
  const env = await loadSw('v1', ['index.html']);
  await dispatchInstall(env);
  for (const path of ['/app/ios', '/app/ios.mobileconfig']) {
    const responded = await dispatchFetch(env, makeRequest('https://box.example.com' + path, { mode: 'navigate' }));
    assert.strictEqual(responded, undefined, path);
  }
});

test('only 200 basic responses are cached', async () => {
  const env = await loadSw('v1', ['index.html']);
  await dispatchInstall(env);
  const cache = env.caches._store.get('maxcom-shell-v1');
  env.fetchImpl.fn = async (request) => makeResponse(request.url, { status: 206 });
  await dispatchFetch(env, makeRequest('https://box.example.com/app/a.js'));
  env.fetchImpl.fn = async (request) => makeResponse(request.url, { type: 'opaque' });
  await dispatchFetch(env, makeRequest('https://box.example.com/app/b.js'));
  env.fetchImpl.fn = async (request) => makeResponse(request.url);
  await dispatchFetch(env, makeRequest('https://box.example.com/app/c.js'));
  assert.ok(!cache.has('https://box.example.com/app/a.js'));
  assert.ok(!cache.has('https://box.example.com/app/b.js'));
  assert.ok(cache.has('https://box.example.com/app/c.js'));
});
