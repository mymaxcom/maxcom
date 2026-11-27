import { createReadStream } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { serveVideo } from '../assets/videoServe.ts';
import type { ChangeBus } from '../events.ts';
import { securityHeaders } from '../securityHeaders.ts';
import { assetKey, themeKey } from './cache.ts';
import type { CachedFile, FileKind, FollowCache } from './cache.ts';
import { ASSET_PATH_RE, THEME_PATH_RE } from './mirror.ts';
import type { Mirror } from './mirror.ts';
import type { FollowStore } from './store.ts';
import { forwardWhep } from './whep.ts';
import type { WhepClient } from './whep.ts';

/**
 * In follower mode the box's own TV page asks this box for what it asks any box: the bundle, the content, the live
 * state, the event stream, the pictures and videos by id, the theme files, the logo. This hook answers each of them
 * from the mirror's stored copy in the same shapes the master's routes use, and takes what is not stored from the
 * master (streamed through, and kept when it fits). It is an `onRequest` hook placed right after the authorisation
 * hook, so `request.auth` is set; on a box that follows nobody it returns at once.
 */

export interface FollowerKioskHookDeps {
  follow: FollowStore;
  mirror: Mirror;
  cache: FollowCache;
  client: WhepClient;
  /** This box's own bus (the mirror emits on it). Without it `/api/kiosk/events` is left to the ordinary route. */
  bus?: ChangeBus;
  heartbeatMs?: number;
  maxSseClients?: number;
}

export type FollowerKioskHook = ((request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>) & {
  /** Ends every open event stream (the server is closing). */
  close(): void;
};

const ISLAMIC_AUDIO_RE = /^\/islamic\/audio\/[A-Za-z0-9_-]{1,40}\/[0-9]{1,3}\/[0-9]{1,3}\.mp3$/;
const LIVE_OFF = { live: false, since: null, kuliah: null, audio: false, volume: 0 };
const KEEP_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified'] as const;
const MAX_SSE = 16;
const ASSET_CACHE = 'public, max-age=31536000, immutable';
const THEME_CACHE = 'private, max-age=31536000, immutable';

function refuse(reply: FastifyReply, status: number, code: string, extra: Record<string, string> = {}): FastifyReply {
  for (const [k, v] of Object.entries(extra)) reply.header(k, v);
  return reply.code(status).header('Cache-Control', 'no-store').type('application/json; charset=utf-8').send({ code, errors: [code] });
}

/** The extra fields of `GET /api/box/state` on a follower (the TV page shows a corner mark after 10 minutes away). */
export function followerBoxState(
  follow: FollowStore,
  mirror: Mirror,
  now: () => Date = () => new Date(),
): { mode: 'follower'; master: { name: string }; connected: boolean; awayMinutes: number; needsUpdate: boolean } | null {
  if (!follow.present()) return null;
  const rec = follow.read();
  const st = mirror.state();
  const since = st.lastOkAt === null ? null : Date.parse(st.lastOkAt);
  const away = st.connected || since === null ? 0 : Math.max(0, Math.floor((now().getTime() - since) / 60_000));
  return { mode: 'follower', master: { name: rec === null ? '' : rec.masterName }, connected: st.connected, awayMinutes: away, needsUpdate: st.needsUpdate };
}

/** A follower tells its TV that the master has been silent when it has not answered for this long (O23). */
export const MASTER_UNREACHABLE_MS = 6 * 3_600_000;

/**
 * The time of the last answer of the master (ISO) when the master has not answered for 6 hours, else null. A box that
 * never had an answer counts from the day of the link. This only informs: the follower keeps retrying and never
 * empties itself (the way out is the box's own maintenance screen).
 */
export function masterUnreachableSince(follow: FollowStore, mirror: Mirror, now: () => Date = () => new Date()): string | null {
  if (!follow.present()) return null;
  const st = mirror.state();
  if (st.connected || st.removed) return null;
  const rec = follow.read();
  const from = st.lastOkAt ?? rec?.linkedAt ?? null;
  const ms = from === null ? Number.NaN : Date.parse(from);
  if (Number.isNaN(ms) || now().getTime() - ms < MASTER_UNREACHABLE_MS) return null;
  return new Date(ms).toISOString();
}

export function followerKioskHook(d: FollowerKioskHookDeps): FollowerKioskHook {
  const whep = forwardWhep({ follow: d.follow, client: d.client, origin: () => d.mirror.origin() });
  const sseClose = new Set<() => void>();

  const serveFile = (request: FastifyRequest, reply: FastifyReply, f: CachedFile, cacheControl: string): FastifyReply => {
    if (f.kind === 'video') {
      reply.header('X-Content-Type-Options', 'nosniff');
      return serveVideo(request, reply, f.path);
    }
    reply.header('Content-Type', f.mime).header('Cache-Control', cacheControl).header('X-Content-Type-Options', 'nosniff').header('Content-Length', f.size);
    if (f.etag !== null) reply.header('ETag', f.etag);
    return reply.send(createReadStream(f.path));
  };

  /**
   * The master's own answer for a file this box does not hold, streamed to the TV. A whole file (no range) that
   * verifies and fits is kept for next time while it streams.
   */
  const proxy = async (
    request: FastifyRequest, reply: FastifyReply, path: string, keep: { key: string; sha256?: string; kindOf: (mime: string) => FileKind } | null,
  ): Promise<FastifyReply> => {
    const rec = d.follow.read();
    if (rec === null) return refuse(reply, 503, 'mirror_empty', { 'Retry-After': '5' });
    const range = typeof request.headers.range === 'string' ? request.headers.range : null;
    const first = d.mirror.origin();
    const order = first !== null && rec.addresses.includes(first) ? [first, ...rec.addresses.filter((a) => a !== first)] : rec.addresses;
    let res: IncomingMessage | null = null;
    for (const origin of order) {
      try {
        res = await d.client.request(origin, rec.masterCa, {
          path, timeoutMs: 15_000, headers: { cookie: `surau_kiosk=${rec.token}`, ...(range !== null ? { range } : {}) },
        });
        break;
      } catch {
        // next address
      }
    }
    if (res === null) return refuse(reply, 503, 'master_unreachable', { 'Retry-After': '5' });
    const status = res.statusCode ?? 502;
    if (status === 401 || status === 403) {
      res.resume();
      return refuse(reply, 502, 'master_refused');
    }
    reply.code(status);
    for (const h of KEEP_HEADERS) {
      const v = res.headers[h];
      if (typeof v === 'string') reply.header(h, v);
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    const out = new PassThrough();
    // A master that drops the connection mid-file must end this answer, never the process: `pipe` forwards no error.
    const copies: PassThrough[] = [out];
    res.on('error', () => {
      for (const c of copies) c.destroy();
    });
    res.on('aborted', () => {
      for (const c of copies) c.destroy();
    });
    res.pipe(out);
    const type = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : 'application/octet-stream';
    if (keep !== null && status === 200 && range === null) {
      const toCache = new PassThrough();
      copies.push(toCache);
      res.pipe(toCache);
      const len = typeof res.headers['content-length'] === 'string' && /^\d{1,12}$/.test(res.headers['content-length']) ? Number(res.headers['content-length']) : null;
      const etag = typeof res.headers.etag === 'string' ? res.headers.etag : null;
      void d.cache.putFile(keep.key, { kind: keep.kindOf(type), mime: type, ...(keep.sha256 !== undefined ? { sha256: keep.sha256 } : {}), length: len, etag }, toCache).catch(() => undefined);
    }
    return reply.send(out);
  };

  const serveJson = (reply: FastifyReply, name: string): FastifyReply => {
    const v = d.cache.getJson(name);
    if (v === null) {
      if (name === 'live') return reply.header('Cache-Control', 'no-store').send(LIVE_OFF);
      return refuse(reply, 503, 'mirror_empty', { 'Retry-After': '5' });
    }
    return reply.header('Cache-Control', 'no-store').send(v);
  };

  /** The event stream of this box's own TV, from this box's own bus: the mirror re-emits what the master says. */
  const serveEvents = (request: FastifyRequest, reply: FastifyReply, bus: ChangeBus): void => {
    if (sseClose.size >= (d.maxSseClients ?? MAX_SSE)) {
      refuse(reply, 503, 'busy');
      return;
    }
    const res = reply.raw;
    reply.hijack();
    res.writeHead(200, {
      ...securityHeaders((request.raw.socket as { encrypted?: boolean }).encrypted === true),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.socket?.setNoDelay(true);
    const write = (event: string, data: unknown): void => {
      if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const bundle = d.cache.getJson<{ version?: unknown }>('bundle');
    if (bundle !== null && typeof bundle.version === 'number') write('changed', { version: bundle.version });
    write('live', d.cache.getJson('live') ?? LIVE_OFF);
    const off = [
      bus.on((version) => write('changed', { version })),
      bus.onLive((live) => write('live', live)),
      bus.onPlayNow((itemId) => write('play-now', { itemId })),
    ];
    const timer = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': hb\n\n');
    }, d.heartbeatMs ?? 25_000);
    timer.unref();
    let done = false;
    const cleanup = (): void => {
      if (done) return;
      done = true;
      for (const f of off) f();
      clearInterval(timer);
      sseClose.delete(cleanup);
      if (!res.writableEnded && !res.destroyed) res.end();
    };
    sseClose.add(cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  };

  const hook = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    if (!d.follow.present()) return undefined;
    const method = request.method;
    const path = (request.raw.url ?? '').split('?')[0] ?? '';
    const read = method === 'GET' || method === 'HEAD';

    // Public, like the master's own route: the logo.
    if (read && path === '/surau-logo') {
      const bundle = d.cache.getJson<{ settings?: { surauInfo?: { logo?: unknown } } }>('bundle');
      const id = bundle?.settings?.surauInfo?.logo;
      if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) return refuse(reply, 404, 'not_found');
      const etag = `"logo-${id}"`;
      const query = (request.raw.url ?? '').includes('?') ? (request.raw.url ?? '').split('?')[1] ?? '' : '';
      reply.header('ETag', etag).header('Cache-Control', /(?:^|&)v=[0-9a-f]{1,64}(?:&|$)/.test(query) ? ASSET_CACHE : 'no-cache');
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      const f = d.cache.open(assetKey(id));
      if (f !== null) return serveFile(request, reply, { ...f, etag }, reply.getHeader('Cache-Control') as string);
      return proxy(request, reply, `/assets/${id}`, { key: assetKey(id), sha256: id, kindOf: () => 'image' });
    }

    const isWhep = whep.matches(method, path);
    const ours =
      isWhep ||
      (read && (path === '/api/kiosk/bundle' || path === '/api/kiosk/content' || path === '/api/kiosk/live' || path === '/api/kiosk/events' ||
        ASSET_PATH_RE.test(path) || THEME_PATH_RE.test(path) || ISLAMIC_AUDIO_RE.test(path)));
    if (!ours) return undefined;
    if (path === '/api/kiosk/events' && d.bus === undefined) return undefined;

    // The same identity the master's routes ask for: a kiosk. The authorisation hook has set it; nothing else is served.
    if (request.auth?.kind !== 'kiosk') {
      return refuse(reply, request.auth === null || request.auth === undefined ? 401 : 403, request.auth ? 'forbidden' : 'sign_in');
    }

    if (isWhep) return whep.handle(request, reply, path);
    if (path === '/api/kiosk/bundle') return serveJson(reply, 'bundle');
    if (path === '/api/kiosk/content') return serveJson(reply, 'content');
    if (path === '/api/kiosk/live') return serveJson(reply, 'live');
    if (path === '/api/kiosk/events') {
      serveEvents(request, reply, d.bus!);
      return reply;
    }
    const asset = ASSET_PATH_RE.exec(path);
    if (asset !== null) {
      const id = asset[1]!;
      const f = d.cache.open(assetKey(id));
      if (f !== null) return serveFile(request, reply, f, ASSET_CACHE);
      return proxy(request, reply, path, { key: assetKey(id), sha256: id, kindOf: (m) => (m.startsWith('video/') ? 'video' : m.startsWith('image/') ? 'image' : 'other') });
    }
    if (THEME_PATH_RE.test(path)) {
      const key = themeKey(path);
      const f = d.cache.open(key);
      if (f !== null) return serveFile(request, reply, f, THEME_CACHE);
      return proxy(request, reply, path, { key, kindOf: () => 'theme' });
    }
    // The reference recitation audio is large and played rarely: streamed from the master, not kept.
    return proxy(request, reply, path, null);
  };

  return Object.assign(hook, {
    close(): void {
      for (const f of [...sseClose]) f();
    },
  });
}
