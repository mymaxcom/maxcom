import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerFactory } from 'fastify';
import { APP_DOWNLOAD_URL, defaultBoxName } from '@surau/core';
import type { BoxStateView } from '@surau/core';
import { boxId as boxIdOf } from '../auth/secrets.ts';
import { registerSecurityHeaders } from '../securityHeaders.ts';
import { boxVersion } from '../productVersion.ts';
import { hardenServer } from '../serverLimits.ts';
import { loadIdentity } from './identity.ts';
import { readBoxJson } from './state.ts';

/** True when an error from opening the database means the file itself is damaged (not a busy lock or a missing folder). */
export function isDatabaseDamage(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { message?: unknown; errcode?: unknown };
  if (e.errcode === 11 || e.errcode === 26) return true; // SQLITE_CORRUPT, SQLITE_NOTADB
  const m = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  return m.includes('malformed') || m.includes('not a database');
}

export interface DamagedAppOptions {
  dataDir: string;
  staticDir: string | null;
  /** Host names the Host allowlist accepts, besides loopback. */
  allowedHosts?: readonly string[];
  serverFactory?: FastifyServerFactory;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const hostSetters = new WeakMap<FastifyInstance, (hosts: readonly string[]) => void>();

/**
 * Replace the Host allowlist of a damaged-database app (a renewed certificate may name new hosts). Returns false
 * for an app that is not a damaged-database app, so the caller can use its own setter.
 */
export function setDamagedAllowedHosts(app: FastifyInstance, hosts: readonly string[]): boolean {
  const set = hostSetters.get(app);
  if (set === undefined) return false;
  set(hosts);
  return true;
}

/**
 * The minimal server for a box whose database cannot be opened: it serves the kiosk page and
 * `GET /api/box/info` and `/api/box/state` (state `recovery`, reason `db_damaged`), so the TV shows the
 * "data must be restored" screen instead of a blank browser. Every other API answers 503. It works without
 * the database: the box id comes from `box.key`, the names from the plain file `box.json`.
 */
export function buildDamagedApp(o: DamagedAppOptions): FastifyInstance {
  const app = Fastify({ logger: false, ...(o.serverFactory ? { serverFactory: o.serverFactory } : {}) });
  hardenServer(app.server);
  registerSecurityHeaders(app);
  let hosts = new Set([...LOOPBACK, ...(o.allowedHosts ?? [])]);
  hostSetters.set(app, (next) => {
    hosts = new Set([...LOOPBACK, ...next.map((h) => h.toLowerCase())]);
  });
  app.addHook('onRequest', async (request, reply) => {
    const h = String(request.headers.host ?? '').toLowerCase();
    const host = h.startsWith('[') ? h.slice(1, h.indexOf(']')) : h.replace(/:\d+$/, '');
    if (!hosts.has(host)) return reply.code(421).send({ errors: ['host not allowed'] });
    return undefined;
  });

  const boxId = boxIdOf(o.dataDir);
  const json = readBoxJson(o.dataDir);
  let identity: ReturnType<typeof loadIdentity> | null = null;
  try {
    identity = loadIdentity(o.dataDir);
  } catch {
    identity = null; // a damaged identity file is not worth blocking the screen
  }
  const view = (): BoxStateView => ({
    boxId,
    keyFp: identity?.keyFp ?? '0000000000000000',
    pub: { kty: 'EC', crv: 'P-256', x: identity?.publicJwk.x ?? '', y: identity?.publicJwk.y ?? '' },
    name: json?.boxName ? json.boxName : defaultBoxName(boxId),
    state: 'recovery',
    reason: 'db_damaged',
    linked: false,
    https: false,
    caSha256: null,
    serverTime: new Date().toISOString(),
    version: boxVersion(),
    surauName: json?.surauName ?? null,
    appDownloadUrl: APP_DOWNLOAD_URL,
  });
  app.get('/api/box/info', async (_r, reply) => {
    reply.header('Cache-Control', 'no-store');
    return view();
  });
  app.get('/api/box/state', async (_r, reply) => {
    reply.header('Cache-Control', 'no-store');
    return view();
  });

  if (o.staticDir !== null && existsSync(o.staticDir)) {
    app.register(fastifyStatic, {
      root: o.staticDir,
      prefix: '/',
      wildcard: true,
      index: ['index.html'],
      cacheControl: false,
      setHeaders: (res, filePath) => {
        const name = basename(filePath);
        res.header('Cache-Control', name === 'sw.js' || name === 'index.html' ? 'no-cache' : 'public, max-age=0');
      },
    });
  }
  app.setNotFoundHandler((request, reply) => {
    const path = (request.raw.url ?? '/').split('?')[0] ?? '/';
    if (path === '/api' || path.startsWith('/api/')) {
      return reply.code(503).header('Cache-Control', 'no-store').send({ errors: ['Pangkalan data rosak'] });
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && o.staticDir !== null && !/\.[A-Za-z0-9]+$/.test(path)) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ errors: ['not found'] });
  });
  return app;
}
