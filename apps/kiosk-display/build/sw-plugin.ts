import { createHash } from 'node:crypto';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';

const CACHE_PREFIX = 'surau-shell-';
const SW_FILE = 'sw.js';

/** URL paths to precache: every built file except the worker itself and anything under /api. */
export function buildFileList(files: readonly string[]): string[] {
  const urls = new Set<string>();
  for (const file of files) {
    const clean = file.split(sep).join('/').split('\\').join('/').replace(/^\/+/, '');
    if (clean === '' || clean === SW_FILE || clean.endsWith('.map')) continue;
    const url = `/${clean}`;
    if (url === '/api' || url.startsWith('/api/')) continue;
    urls.add(url);
  }
  return [...urls].sort();
}

/** Cache name derived from the file list: same list -> same name, any change -> new name. */
export function cacheNameFor(urls: readonly string[]): string {
  const hash = createHash('sha256').update([...urls].sort().join('\n')).digest('hex').slice(0, 12);
  return `${CACHE_PREFIX}${hash}`;
}

/** The worker source, with the precache list and cache name baked in. */
export function renderSw(urls: readonly string[]): string {
  const cacheName = cacheNameFor(urls);
  return `// Generated at build time. Do not edit.
const CACHE = ${JSON.stringify(cacheName)};
const PREFIX = ${JSON.stringify(CACHE_PREFIX)};
const FILES = ${JSON.stringify(urls, null, 2)};
const FILE_SET = new Set(FILES);
const NAV_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function fromCache(path) {
  const cache = await caches.open(CACHE);
  return cache.match(path, { ignoreSearch: true });
}

async function navigate(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAV_TIMEOUT_MS);
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (response.status < 500) return response;
  } catch {
    /* offline, refused or timed out: fall back to the cached shell */
  } finally {
    clearTimeout(timer);
  }
  const shell = await fromCache('/index.html');
  return shell || Response.error();
}

async function cacheFirst(request, path) {
  const hit = await fromCache(path);
  return hit || fetch(request);
}

// Pictures from the box (/assets/<sha256>, never changing for a given id) are kept as they are fetched, in a
// cache of their own that the shell clean-up above never deletes, so a poster or photo still shows offline.
const MEDIA = 'surau-media-v1';
const MEDIA_PATH = /^\\/assets\\/[0-9a-f]{64}$/;

const MEDIA_MAX = 300;
const MEDIA_ID = /^\\/assets\\/([0-9a-f]{64})$/;

// Keeps only the pictures the latest content uses (keepIds), then at most MEDIA_MAX, oldest first out.
async function pruneMedia(keepIds) {
  const cache = await caches.open(MEDIA);
  const keep = keepIds ? new Set(keepIds) : null;
  const live = [];
  for (const req of await cache.keys()) {
    const m = MEDIA_ID.exec(new URL(req.url).pathname);
    if (keep && (!m || !keep.has(m[1]))) await cache.delete(req);
    else live.push(req);
  }
  for (const req of live.slice(0, Math.max(0, live.length - MEDIA_MAX))) await cache.delete(req);
}

self.addEventListener('message', (event) => {
  const d = event.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'media-keep' && Array.isArray(d.ids)) {
    event.waitUntil(pruneMedia(d.ids.filter((x) => typeof x === 'string')));
  } else if (d.type === 'media-clear') {
    event.waitUntil(caches.delete(MEDIA));
  }
});

async function mediaFirst(request) {
  const cache = await caches.open(MEDIA);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    try {
      await cache.put(request.url, response.clone());
      await pruneMedia(null);
    } catch {
      /* storage full or a partial response: serve it without keeping it */
    }
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  // A request that carries credentials of its own (the admin app's preview) is never answered from, or kept in, a cache.
  if (request.headers.has('authorization')) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
    return;
  }
  if (FILE_SET.has(url.pathname)) {
    event.respondWith(cacheFirst(request, url.pathname));
    return;
  }
  if (MEDIA_PATH.test(url.pathname)) {
    event.respondWith(mediaFirst(request));
  }
});
`;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Vite plugin: after the bundle is written, emit dist/sw.js listing every built file. */
export function swPlugin(): Plugin {
  return {
    name: 'surau-sw',
    apply: 'build',
    enforce: 'post',
    writeBundle(options) {
      const dir = options.dir;
      if (!dir) return;
      const files = walk(dir).map((f) => relative(dir, f));
      writeFileSync(join(dir, SW_FILE), renderSw(buildFileList(files)));
    },
  };
}
