import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createChangeBus } from '../src/events.ts';
import type { ChangeBus } from '../src/events.ts';
import { assetKey, createFollowCache, themeKey } from '../src/follow/cache.ts';
import type { FollowCache } from '../src/follow/cache.ts';
import { followerBoxState, followerKioskHook } from '../src/follow/kioskHook.ts';
import type { FollowerKioskHook } from '../src/follow/kioskHook.ts';
import { createMirror } from '../src/follow/mirror.ts';
import type { MirrorDeps } from '../src/follow/mirror.ts';
import { createPinnedClient } from '../src/link/peerClient.ts';
import type { WhepClient } from '../src/follow/whep.ts';
import type { Mirror, MirrorState } from '../src/follow/mirror.ts';
import type { FollowRecord, FollowStore } from '../src/follow/store.ts';

const TOKEN = 'Zq9XsecretTVtokenValueForTestsOnly0123456789';
const A1 = 'https://10.168.50.10:8443';
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

const record = (): FollowRecord => ({
  v: 1,
  linkId: 'a'.repeat(32),
  masterBoxId: 'b'.repeat(16),
  masterKeyFp: 'c'.repeat(16),
  masterPub: { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) },
  masterCa: 'ab'.repeat(32),
  masterName: 'Surau Al-Hidayah',
  addresses: [A1],
  token: TOKEN,
  deviceId: 'device-dewan-utama',
  linkedAt: '2026-11-20T10:00:00.000Z',
  hadStore: false,
});

function followStub(rec: FollowRecord | null) {
  const read = vi.fn(() => rec);
  const present = vi.fn(() => rec !== null);
  const store: FollowStore = { read, present, write: vi.fn(), setAddresses: vi.fn(), clear: vi.fn() };
  return { store, read, present };
}

function mirrorStub(state: Partial<MirrorState> = {}): Mirror {
  const s: MirrorState = { connected: true, lastOkAt: null, masterVersion: null, needsUpdate: false, removed: false, ...state };
  return { start: vi.fn(), stop: async () => undefined, state: () => s, origin: () => A1 };
}

interface Call {
  origin: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | undefined;
}
interface Resp {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | string | object;
}

function asResponse(r: Resp): IncomingMessage {
  const buf = r.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(r.body) ? r.body : Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  const headers: Record<string, string> = { ...(r.headers ?? {}) };
  if (!('content-length' in headers) && r.body !== undefined) headers['content-length'] = String(buf.length);
  if (!('content-type' in headers) && typeof r.body === 'object' && !Buffer.isBuffer(r.body)) headers['content-type'] = 'application/json';
  return Object.assign(Readable.from(buf.length > 0 ? [buf] : []), { statusCode: r.status, headers }) as unknown as IncomingMessage;
}

/** A client whose answers a test writes by hand; every request is recorded. */
function stubClient(handler: (c: Call) => Resp | 'down') {
  const calls: Call[] = [];
  const client = {
    async request(origin: string, _ca: string, req: { method?: string; path: string; headers?: Record<string, string>; body?: string | Uint8Array }): Promise<IncomingMessage> {
      const c: Call = { origin, method: req.method ?? 'GET', path: req.path, headers: req.headers ?? {}, body: req.body === undefined ? undefined : String(req.body) };
      calls.push(c);
      const r = handler(c);
      if (r === 'down') throw new Error('unreachable');
      return asResponse(r);
    },
    async json(): Promise<{ status: number; json: unknown }> {
      return { status: 500, json: null };
    },
    post: async () => ({ status: 500, json: null }),
  };
  return { client, calls };
}

const KIOSK = { 'x-test-auth': 'kiosk' };

let dir = '';
let cache: FollowCache;
let apps: FastifyInstance[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'follow-kiosk-'));
  cache = createFollowCache({ dir, freeBytes: () => 10 ** 12 });
  apps = [];
});
afterEach(async () => {
  for (const a of apps) await a.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A bare server: a stand-in authorisation hook (as the real one sets `request.auth`), then the follower hook, then an ordinary route. */
async function serverWith(o: { follow: FollowStore; mirror?: Mirror; client?: ReturnType<typeof stubClient>['client']; bus?: ChangeBus; heartbeatMs?: number }): Promise<{ app: FastifyInstance; hook: FollowerKioskHook }> {
  const app = Fastify();
  apps.push(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    const a = request.headers['x-test-auth'];
    request.auth = a === 'kiosk' ? { kind: 'kiosk', deviceId: null, via: 'loopback' } : a === 'site' ? { kind: 'site', boxId: 'x', surauId: 'y' } : null;
  });
  const hook = followerKioskHook({
    follow: o.follow, mirror: o.mirror ?? mirrorStub(), cache, client: o.client ?? stubClient(() => 'down').client,
    ...(o.bus ? { bus: o.bus } : {}), ...(o.heartbeatMs ? { heartbeatMs: o.heartbeatMs } : {}),
  });
  app.addHook('onRequest', hook);
  app.addHook('onClose', async () => hook.close());
  app.all('/*', async () => ({ ordinary: true }));
  await app.ready();
  return { app, hook };
}

const bundleOf = (version: number, logo = ''): Record<string, unknown> => ({
  version, zone: 'WLY01', days: [], prayer: {}, settings: { surauInfo: { logo } }, logo: null, serverTime: '2026-11-22T01:00:00.000Z',
});
const contentOf = (version: number): Record<string, unknown> => ({ version, serverTime: '2026-11-22T01:00:00.000Z', content: { announcements: [] } });

const stream = (b: Buffer): Readable => Readable.from([b]);

describe('follower kiosk hook: a normal box', () => {
  it('is inert: it returns at once and touches neither the record nor the cache', async () => {
    const f = followStub(null);
    const getJson = vi.spyOn(cache, 'getJson');
    const open = vi.spyOn(cache, 'open');
    const { app } = await serverWith({ follow: f.store });
    for (const url of ['/api/kiosk/bundle', '/api/kiosk/content', '/api/kiosk/live', '/api/kiosk/events', `/assets/${'a'.repeat(64)}`, '/surau-logo', '/themes/x/0123456789abcdef-2/bundle.css']) {
      const r = await app.inject({ method: 'GET', url, headers: KIOSK });
      expect(JSON.parse(r.body)).toEqual({ ordinary: true });
    }
    const w = await app.inject({ method: 'POST', url: '/api/kiosk/live/whep', headers: { ...KIOSK, 'content-type': 'application/json' }, payload: '{}' });
    expect(JSON.parse(w.body)).toEqual({ ordinary: true });
    expect(f.read).not.toHaveBeenCalled();
    expect(getJson).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});

describe('follower kiosk hook: who may ask', () => {
  it('serves nothing to a caller that is not a kiosk', async () => {
    cache.putJson('bundle', bundleOf(3));
    cache.putJson('content', contentOf(3));
    const id = sha('x');
    cache.putJson('live', { live: false });
    await cache.putFile(assetKey(id), { kind: 'image', mime: 'image/png', length: 1 }, stream(Buffer.from('x')));
    const calls = stubClient(() => ({ status: 200, body: 'no' }));
    const { app } = await serverWith({ follow: followStub(record()).store, client: calls.client, bus: createChangeBus() });
    for (const url of ['/api/kiosk/bundle', '/api/kiosk/content', '/api/kiosk/live', '/api/kiosk/events', `/assets/${id}`, `/assets/${'b'.repeat(64)}`, '/themes/x/0123456789abcdef-2/bundle.css', '/islamic/audio/r/001/001.mp3']) {
      const none = await app.inject({ method: 'GET', url });
      expect(none.statusCode, url).toBe(401);
      expect(JSON.parse(none.body)).toEqual({ code: 'sign_in', errors: ['sign_in'] });
      const other = await app.inject({ method: 'GET', url, headers: { 'x-test-auth': 'site' } });
      expect(other.statusCode, url).toBe(403);
    }
    const w = await app.inject({ method: 'POST', url: '/api/kiosk/live/whep', headers: { 'content-type': 'application/sdp' }, payload: 'v=0' });
    expect(w.statusCode).toBe(401);
    const d = await app.inject({ method: 'DELETE', url: '/api/kiosk/live/whep/abc', headers: { 'x-test-auth': 'site' } });
    expect(d.statusCode).toBe(403);
    expect(calls.calls).toEqual([]);
  });
});

describe('follower kiosk hook: from the stored copy', () => {
  it('master down at start: the stored bundle, content and live state are served as stored', async () => {
    cache.putJson('bundle', bundleOf(9));
    cache.putJson('content', contentOf(9));
    cache.putJson('live', { live: true, since: null, kuliah: null, audio: false, volume: 40 });
    const down = stubClient(() => 'down');
    const { app } = await serverWith({ follow: followStub(record()).store, client: down.client, mirror: mirrorStub({ connected: false }) });
    const b = await app.inject({ method: 'GET', url: '/api/kiosk/bundle', headers: KIOSK });
    expect(b.statusCode).toBe(200);
    expect(b.headers['content-type']).toContain('application/json');
    expect(b.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(b.body)).toEqual(bundleOf(9));
    const c = await app.inject({ method: 'GET', url: '/api/kiosk/content', headers: KIOSK });
    expect(JSON.parse(c.body)).toEqual(contentOf(9));
    const l = await app.inject({ method: 'GET', url: '/api/kiosk/live', headers: KIOSK });
    expect(JSON.parse(l.body)).toMatchObject({ live: true, volume: 40 });
    expect(down.calls).toEqual([]);
  });

  it('nothing stored yet: 503 with a code and a retry hint; the live state reads as off', async () => {
    const { app } = await serverWith({ follow: followStub(record()).store });
    const b = await app.inject({ method: 'GET', url: '/api/kiosk/bundle', headers: KIOSK });
    expect(b.statusCode).toBe(503);
    expect(JSON.parse(b.body)).toEqual({ code: 'mirror_empty', errors: ['mirror_empty'] });
    expect(b.headers['retry-after']).toBe('5');
    const l = await app.inject({ method: 'GET', url: '/api/kiosk/live', headers: KIOSK });
    expect(JSON.parse(l.body)).toMatchObject({ live: false, kuliah: null });
  });

  it('answers the same shapes as the master: bundle and content mirrored from a real master are served unchanged', async () => {
    const master = buildApp(':memory:');
    apps.push(master);
    const origin = A1;
    const client = {
      async request(o: string, _ca: string, req: { path: string }): Promise<IncomingMessage> {
        if (o !== origin) throw new Error('unreachable');
        if (req.path === '/api/kiosk/events') {
          const s = new PassThrough();
          setImmediate(() => s.write('event: changed\ndata: {"version":0}\n\n'));
          return Object.assign(s, { statusCode: 200, headers: {} }) as unknown as IncomingMessage;
        }
        const r = await master.inject({ method: 'GET', url: req.path, remoteAddress: '127.0.0.1' });
        return asResponse({ status: r.statusCode, headers: { 'content-type': String(r.headers['content-type']) }, body: r.rawPayload });
      },
      async json(o: string, ca: string, req: { path: string }): Promise<{ status: number; json: unknown }> {
        const res = await client.request(o, ca, req);
        const parts: Buffer[] = [];
        for await (const ch of res) parts.push(ch as Buffer);
        return { status: res.statusCode ?? 502, json: JSON.parse(Buffer.concat(parts).toString('utf8')) };
      },
      post: async () => ({ status: 500, json: null }),
    };
    const follow = followStub(record());
    const mirror = createMirror({
      follow: follow.store, client, cache, bus: createChangeBus(), boxId: 'd'.repeat(16), now: () => new Date(),
      sleep: () => new Promise<void>(() => undefined), log: () => undefined, retryMs: 60_000,
    });
    try {
      mirror.start();
      await vi.waitFor(() => expect(cache.getJson('content')).not.toBeNull());
      const { app } = await serverWith({ follow: follow.store, mirror });
      const own = async (url: string): Promise<Record<string, unknown>> => JSON.parse((await master.inject({ method: 'GET', url, remoteAddress: '127.0.0.1' })).body) as Record<string, unknown>;
      const strip = (o: Record<string, unknown>): Record<string, unknown> => ({ ...o, serverTime: 0 });
      const b = await app.inject({ method: 'GET', url: '/api/kiosk/bundle', headers: KIOSK });
      const c = await app.inject({ method: 'GET', url: '/api/kiosk/content', headers: KIOSK });
      expect(strip(JSON.parse(b.body) as Record<string, unknown>)).toEqual(strip(await own('/api/kiosk/bundle')));
      expect(strip(JSON.parse(c.body) as Record<string, unknown>)).toEqual(strip(await own('/api/kiosk/content')));
      expect(Object.keys(JSON.parse(b.body) as object).sort()).toEqual(Object.keys(await own('/api/kiosk/bundle')).sort());
    } finally {
      await mirror.stop();
    }
  });

  it('a stored picture is served by id with the master\'s headers', async () => {
    const b = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200, 4)]);
    const id = sha(b);
    await cache.putFile(assetKey(id), { kind: 'image', mime: 'image/png', sha256: id, length: b.length }, stream(b));
    const down = stubClient(() => 'down');
    const { app } = await serverWith({ follow: followStub(record()).store, client: down.client });
    const r = await app.inject({ method: 'GET', url: `/assets/${id}`, headers: KIOSK });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.rawPayload.equals(b)).toBe(true);
    expect(down.calls).toEqual([]);
  });

  it('a stored theme file is served with the theme headers', async () => {
    const path = '/themes/hijau-siti/0123456789abcdef-2/bundle.css';
    await cache.putFile(themeKey(path), { kind: 'theme', mime: 'text/css', length: 12 }, stream(Buffer.from('.a{color:red')));
    const { app } = await serverWith({ follow: followStub(record()).store });
    const r = await app.inject({ method: 'GET', url: path, headers: KIOSK });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/css');
    expect(r.headers['cache-control']).toBe('private, max-age=31536000, immutable');
  });

  it('a range request on a stored video: 206 with the slice, 416 outside the file', async () => {
    const video = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
    const id = sha(video);
    await cache.putFile(assetKey(id), { kind: 'video', mime: 'video/mp4', sha256: id, length: 1000 }, stream(video));
    const { app } = await serverWith({ follow: followStub(record()).store, client: stubClient(() => 'down').client });
    const whole = await app.inject({ method: 'GET', url: `/assets/${id}`, headers: KIOSK });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.headers['content-type']).toBe('video/mp4');
    expect(whole.rawPayload.equals(video)).toBe(true);
    const part = await app.inject({ method: 'GET', url: `/assets/${id}`, headers: { ...KIOSK, range: 'bytes=100-199' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 100-199/1000');
    expect(part.headers['content-length']).toBe('100');
    expect(part.rawPayload.equals(video.subarray(100, 200))).toBe(true);
    const tail = await app.inject({ method: 'GET', url: `/assets/${id}`, headers: { ...KIOSK, range: 'bytes=-50' } });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.equals(video.subarray(950))).toBe(true);
    const bad = await app.inject({ method: 'GET', url: `/assets/${id}`, headers: { ...KIOSK, range: 'bytes=5000-6000' } });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers['content-range']).toBe('bytes */1000');
  });

  it('the logo: served from the stored copy by the id the bundle names, with an etag; none set is a 404', async () => {
    const b = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(80, 6)]);
    const id = sha(b);
    await cache.putFile(assetKey(id), { kind: 'image', mime: 'image/png', sha256: id, length: b.length }, stream(b));
    const { app } = await serverWith({ follow: followStub(record()).store });
    cache.putJson('bundle', bundleOf(1, ''));
    expect((await app.inject({ method: 'GET', url: '/surau-logo' })).statusCode).toBe(404);
    cache.putJson('bundle', bundleOf(1, id));
    const r = await app.inject({ method: 'GET', url: `/surau-logo?v=${id.slice(0, 12)}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(r.rawPayload.equals(b)).toBe(true);
    const etag = String(r.headers.etag);
    expect((await app.inject({ method: 'GET', url: '/surau-logo', headers: { 'if-none-match': etag } })).statusCode).toBe(304);
    expect((await app.inject({ method: 'GET', url: '/surau-logo' })).headers['cache-control']).toBe('no-cache');
  });
});

describe('follower kiosk hook: what is not stored comes from the master', () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 8)]);
  const id = sha(png);

  it('streams the file through with the TV cookie and keeps it once it verifies', async () => {
    const stub = stubClient(() => ({ status: 200, headers: { 'content-type': 'image/png' }, body: png }));
    const { app } = await serverWith({ follow: followStub(record()).store, client: stub.client });
    const r = await app.inject({ method: 'GET', url: `/assets/${id}`, headers: KIOSK });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.rawPayload.equals(png)).toBe(true);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({ origin: A1, path: `/assets/${id}` });
    expect(stub.calls[0]!.headers.cookie).toBe(`surau_kiosk=${TOKEN}`);
    await vi.waitFor(() => expect(cache.info(assetKey(id))).not.toBeNull());
    expect(cache.info(assetKey(id))?.hashChecked).toBe(true);
    // the next ask is answered from disk
    const again = await app.inject({ method: 'GET', url: `/assets/${id}`, headers: KIOSK });
    expect(again.rawPayload.equals(png)).toBe(true);
    expect(stub.calls).toHaveLength(1);
  });

  it('bytes that do not hash to their id are streamed but never kept', async () => {
    const stub = stubClient(() => ({ status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.alloc(png.length, 1) }));
    const { app } = await serverWith({ follow: followStub(record()).store, client: stub.client });
    const r = await app.inject({ method: 'GET', url: `/assets/${id}`, headers: KIOSK });
    expect(r.statusCode).toBe(200);
    await new Promise((res) => setTimeout(res, 60));
    expect(cache.info(assetKey(id))).toBeNull();
    expect(cache.stats().files).toBe(0);
  });

  it('a range request is passed on to the master and its 206 comes back; nothing is kept', async () => {
    const video = Buffer.alloc(500, 5);
    const vid = sha(video);
    const stub = stubClient((c) => ({
      status: 206, headers: { 'content-type': 'video/mp4', 'content-range': `bytes 0-99/500`, 'accept-ranges': 'bytes', 'content-length': '100' }, body: video.subarray(0, 100), ...(c.headers.range ? {} : {}),
    }));
    const { app } = await serverWith({ follow: followStub(record()).store, client: stub.client });
    const r = await app.inject({ method: 'GET', url: `/assets/${vid}`, headers: { ...KIOSK, range: 'bytes=0-99' } });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 0-99/500');
    expect(stub.calls[0]!.headers.range).toBe('bytes=0-99');
    await new Promise((res) => setTimeout(res, 40));
    expect(cache.info(assetKey(vid))).toBeNull();
  });

  it('master away and nothing stored: 503 with a code, not a hang', async () => {
    const { app } = await serverWith({ follow: followStub(record()).store, client: stubClient(() => 'down').client });
    const r = await app.inject({ method: 'GET', url: `/assets/${id}`, headers: KIOSK });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.body)).toEqual({ code: 'master_unreachable', errors: ['master_unreachable'] });
  });

  it('a master that refuses the token is shown to the page as a code, never as the master\'s answer', async () => {
    const stub = stubClient(() => ({ status: 401, body: { errors: ['sign in again'] } }));
    const { app } = await serverWith({ follow: followStub(record()).store, client: stub.client });
    const r = await app.inject({ method: 'GET', url: `/assets/${id}`, headers: KIOSK });
    expect(r.statusCode).toBe(502);
    expect(JSON.parse(r.body)).toEqual({ code: 'master_refused', errors: ['master_refused'] });
  });

  it('only fixed shapes are passed on: a made-up theme or audio path is left to the ordinary routes', async () => {
    const stub = stubClient(() => ({ status: 200, body: 'x' }));
    const { app } = await serverWith({ follow: followStub(record()).store, client: stub.client });
    for (const url of ['/themes/x/not-a-hash/bundle.css', '/themes/x/0123456789abcdef-2/../../etc/passwd', '/themes/x/0123456789abcdef-2/other.js', '/islamic/audio/r/1/1.wav', '/assets/short']) {
      const r = await app.inject({ method: 'GET', url, headers: KIOSK });
      expect(JSON.parse(r.body), url).toEqual({ ordinary: true });
    }
    expect(stub.calls).toEqual([]);
  });

  it('the recitation audio is streamed from the master and not kept', async () => {
    const stub = stubClient(() => ({ status: 200, headers: { 'content-type': 'audio/mpeg' }, body: Buffer.alloc(64, 2) }));
    const { app } = await serverWith({ follow: followStub(record()).store, client: stub.client });
    const r = await app.inject({ method: 'GET', url: '/islamic/audio/alafasy/001/001.mp3', headers: KIOSK });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('audio/mpeg');
    expect(stub.calls[0]!.path).toBe('/islamic/audio/alafasy/001/001.mp3');
    expect(cache.stats().files).toBe(0);
  });
});

describe('follower kiosk hook: the event stream', () => {
  it('is served from this box\'s own bus: the stored version first, then every event the mirror emits', async () => {
    cache.putJson('bundle', bundleOf(12));
    const bus = createChangeBus();
    const { app, hook } = await serverWith({ follow: followStub(record()).store, bus, heartbeatMs: 40 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    let text = '';
    const req = http.get({ host: '127.0.0.1', port, path: '/api/kiosk/events', headers: KIOSK }, (res) => {
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        text += c;
      });
    });
    try {
      await vi.waitFor(() => expect(text).toContain('event: live'));
      expect(text).toContain('event: changed\ndata: {"version":12}');
      bus.emit(13, 'any');
      bus.emitLive({ live: true, since: null, kuliah: null, audio: true, volume: 70 }, 'any');
      bus.emitPlayNow('item-7', 'any');
      await vi.waitFor(() => expect(text).toContain('event: play-now\ndata: {"itemId":"item-7"}'));
      expect(text).toContain('event: changed\ndata: {"version":13}');
      expect(text).toContain('"volume":70');
      await vi.waitFor(() => expect(text).toContain(': hb'));
    } finally {
      hook.close();
      req.destroy();
    }
  });

  it('without a bus the path is left to the ordinary route', async () => {
    const { app } = await serverWith({ follow: followStub(record()).store });
    const r = await app.inject({ method: 'GET', url: '/api/kiosk/events', headers: KIOSK });
    expect(JSON.parse(r.body)).toEqual({ ordinary: true });
  });
});

describe('follower kiosk hook: the live picture (WHEP)', () => {
  const offer = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n';

  it('forwards the offer with the TV cookie only, and returns the answer and the Location unchanged', async () => {
    const stub = stubClient((c) => (c.method === 'POST'
      ? { status: 201, headers: { 'content-type': 'application/sdp', location: '/api/kiosk/live/whep/res-1' }, body: 'v=0\r\nanswer\r\n' }
      : { status: 204 }));
    const { app } = await serverWith({ follow: followStub(record()).store, client: stub.client });
    const r = await app.inject({
      method: 'POST', url: '/api/kiosk/live/whep', payload: offer,
      headers: { ...KIOSK, 'content-type': 'application/sdp', cookie: 'page=cookie', authorization: 'Bearer page-token' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.headers['content-type']).toBe('application/sdp');
    expect(r.headers.location).toBe('/api/kiosk/live/whep/res-1');
    expect(r.body).toBe('v=0\r\nanswer\r\n');
    expect(stub.calls[0]).toMatchObject({ method: 'POST', path: '/api/kiosk/live/whep', origin: A1, body: offer });
    expect(stub.calls[0]!.headers).toEqual({ cookie: `surau_kiosk=${TOKEN}`, 'content-type': 'application/sdp' });
    const d = await app.inject({ method: 'DELETE', url: '/api/kiosk/live/whep/res-1', headers: KIOSK });
    expect(d.statusCode).toBe(204);
    expect(stub.calls[1]).toMatchObject({ method: 'DELETE', path: '/api/kiosk/live/whep/res-1' });
    expect(stub.calls[1]!.headers).toEqual({ cookie: `surau_kiosk=${TOKEN}` });
  });

  it('K1: the TV page\'s "still watching" is forwarded to the master with the TV cookie only; a bad id is not', async () => {
    const stub = stubClient(() => ({ status: 204 }));
    const { app } = await serverWith({ follow: followStub(record()).store, client: stub.client });
    const r = await app.inject({ method: 'POST', url: '/api/kiosk/live/whep/res-1/alive', headers: { ...KIOSK, cookie: 'page=cookie' } });
    expect(r.statusCode).toBe(204);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({ method: 'POST', path: '/api/kiosk/live/whep/res-1/alive', origin: A1 });
    expect(stub.calls[0]!.headers).toEqual({ cookie: `surau_kiosk=${TOKEN}` });
    await app.inject({ method: 'POST', url: '/api/kiosk/live/whep/res-1/other', headers: KIOSK });
    await app.inject({ method: 'POST', url: '/api/kiosk/live/whep/a%2Fb/alive', headers: KIOSK });
    expect(stub.calls).toHaveLength(1);
  });

  it('the master\'s own refusal (no stream, this TV has live off) reaches the page as it is', async () => {
    const stub = stubClient(() => ({ status: 403, body: { errors: ['tv_live_off'], code: 'tv_live_off' } }));
    const { app } = await serverWith({ follow: followStub(record()).store, client: stub.client });
    const r = await app.inject({ method: 'POST', url: '/api/kiosk/live/whep', payload: offer, headers: { ...KIOSK, 'content-type': 'application/sdp' } });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ errors: ['tv_live_off'], code: 'tv_live_off' });
  });

  it('refuses what is not an SDP offer, an empty or huge one, a bad id, and a Location that is not a WHEP resource', async () => {
    const stub = stubClient((c) => ({ status: 201, headers: { 'content-type': 'application/sdp', location: c.path.includes('evil') ? '/x' : 'https://elsewhere.example/steal' }, body: 'a' }));
    const { app } = await serverWith({ follow: followStub(record()).store, client: stub.client });
    expect((await app.inject({ method: 'POST', url: '/api/kiosk/live/whep', payload: '{}', headers: { ...KIOSK, 'content-type': 'application/json' } })).statusCode).toBe(415);
    expect((await app.inject({ method: 'POST', url: '/api/kiosk/live/whep', payload: '  ', headers: { ...KIOSK, 'content-type': 'application/sdp' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/kiosk/live/whep', payload: 'a'.repeat(70 * 1024), headers: { ...KIOSK, 'content-type': 'application/sdp' } })).statusCode).toBe(413);
    const bad = await app.inject({ method: 'POST', url: '/api/kiosk/live/whep', payload: offer, headers: { ...KIOSK, 'content-type': 'application/sdp' } });
    expect(bad.statusCode).toBe(502);
    expect(JSON.parse(bad.body)).toEqual({ code: 'bad_location', errors: ['bad_location'] });
    const odd = await app.inject({ method: 'DELETE', url: '/api/kiosk/live/whep/a%20b', headers: KIOSK });
    expect(JSON.parse(odd.body)).toEqual({ ordinary: true });
  });

  it('master away: 502 with a code', async () => {
    const { app } = await serverWith({ follow: followStub(record()).store, client: stubClient(() => 'down').client });
    const r = await app.inject({ method: 'POST', url: '/api/kiosk/live/whep', payload: offer, headers: { ...KIOSK, 'content-type': 'application/sdp' } });
    expect(r.statusCode).toBe(502);
    expect(JSON.parse(r.body)).toEqual({ code: 'master_unreachable', errors: ['master_unreachable'] });
  });
});

describe('follower box state', () => {
  const at = new Date('2026-11-22T10:30:00.000Z');

  it('is null on a box that follows nobody', () => {
    expect(followerBoxState(followStub(null).store, mirrorStub(), () => at)).toBeNull();
  });

  it('a connected follower: the master\'s name and no minutes away', () => {
    expect(followerBoxState(followStub(record()).store, mirrorStub({ connected: true, lastOkAt: '2026-11-22T10:29:00.000Z' }), () => at)).toEqual({
      mode: 'follower', master: { name: 'Surau Al-Hidayah' }, connected: true, awayMinutes: 0, needsUpdate: false,
    });
  });

  it('away: whole minutes since the last contact, and the needs-update flag', () => {
    expect(followerBoxState(followStub(record()).store, mirrorStub({ connected: false, lastOkAt: '2026-11-22T10:04:30.000Z', needsUpdate: true }), () => at)).toEqual({
      mode: 'follower', master: { name: 'Surau Al-Hidayah' }, connected: false, awayMinutes: 25, needsUpdate: true,
    });
  });

  it('never in contact yet: no minutes are made up', () => {
    expect(followerBoxState(followStub(record()).store, mirrorStub({ connected: false, lastOkAt: null }), () => at)?.awayMinutes).toBe(0);
  });
});

describe('wiring types', () => {
  it('the real pinned client fits the mirror and the hook', () => {
    const real = createPinnedClient();
    const forMirror: MirrorDeps['client'] = real;
    const forHook: WhepClient = real;
    expect(typeof forMirror.request).toBe('function');
    expect(typeof forHook.request).toBe('function');
  });
});
