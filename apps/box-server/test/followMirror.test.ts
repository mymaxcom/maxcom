import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_CONTRACT } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { createChangeBus } from '../src/events.ts';
import { assetKey, createFollowCache } from '../src/follow/cache.ts';
import type { FollowCache } from '../src/follow/cache.ts';
import { assetIdsOf, createMirror } from '../src/follow/mirror.ts';
import type { Mirror } from '../src/follow/mirror.ts';
import type { FollowRecord, FollowStore } from '../src/follow/store.ts';

const TOKEN = 'Zq9XsecretTVtokenValueForTestsOnly0123456789';
const MASTER_CA = 'ab'.repeat(32);
const A1 = 'https://10.168.50.10:8443';
const A2 = 'https://10.168.50.11:8443';
const SURAU = '-';

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

const record = (addresses = [A1, A2]): FollowRecord => ({
  v: 1,
  linkId: 'a'.repeat(32),
  masterBoxId: 'b'.repeat(16),
  masterKeyFp: 'c'.repeat(16),
  masterPub: { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) },
  masterCa: MASTER_CA,
  masterName: 'Surau Al-Hidayah',
  addresses,
  token: TOKEN,
  deviceId: 'device-ruang-muslimat',
  linkedAt: '2026-11-20T10:00:00.000Z',
  hadStore: false,
});

function followStub(rec: FollowRecord | null) {
  const write = vi.fn<(r: FollowRecord) => void>();
  const setAddresses = vi.fn<(a: string[]) => void>();
  const clear = vi.fn<() => void>();
  const store: FollowStore = { read: () => rec, present: () => rec !== null, write, setAddresses, clear };
  return Object.assign(store, { write, setAddresses, clear });
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

const ORDER_PATH = '/api/link/peer/order';

function asResponse(r: Resp): IncomingMessage {
  const buf = r.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(r.body) ? r.body : Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  const headers: Record<string, string> = { ...(typeof r.body === 'object' && !Buffer.isBuffer(r.body) ? { 'content-type': 'application/json' } : {}), ...(r.headers ?? {}) };
  if (!('content-length' in headers) && r.body !== undefined) headers['content-length'] = String(buf.length);
  return Object.assign(Readable.from(buf.length > 0 ? [buf] : []), { statusCode: r.status, headers }) as unknown as IncomingMessage;
}

async function readAll(res: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of res) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

/** A master over `app.inject` (when given), with the failures and answers a test needs to stage by hand. */
function fakeMaster(app: FastifyInstance | null) {
  const calls: Call[] = [];
  const down = new Set<string>();
  const over = new Map<string, (c: Call) => Resp>();
  const streams: PassThrough[] = [];
  const state = { revoked: false };

  const respond = async (c: Call): Promise<IncomingMessage> => {
    const o = over.get(c.path);
    if (c.path === ORDER_PATH) return asResponse(o ? o(c) : { status: 404, body: { code: 'not_found' } });
    if (state.revoked) return asResponse({ status: 401, body: { errors: ['sign in'] } });
    if (o) return asResponse(o(c));
    if (c.path === '/api/kiosk/events') {
      const s = new PassThrough();
      streams.push(s);
      return Object.assign(s, { statusCode: 200, headers: { 'content-type': 'text/event-stream' } }) as unknown as IncomingMessage;
    }
    if (app === null) return asResponse({ status: 404 });
    const r = await app.inject({ method: 'GET', url: c.path, remoteAddress: '127.0.0.1' });
    return asResponse({ status: r.statusCode, headers: { 'content-type': String(r.headers['content-type'] ?? 'application/json') }, body: r.rawPayload });
  };

  const client = {
    async request(origin: string, _ca: string, req: { method?: string; path: string; headers?: Record<string, string>; body?: string | Uint8Array }): Promise<IncomingMessage> {
      const c: Call = { origin, method: req.method ?? 'GET', path: req.path, headers: req.headers ?? {}, body: req.body === undefined ? undefined : String(req.body) };
      calls.push(c);
      if (down.has(origin)) throw new Error('unreachable');
      return respond(c);
    },
    async json(origin: string, ca: string, req: { method?: string; path: string; headers?: Record<string, string>; body?: string | Uint8Array }) {
      const res = await client.request(origin, ca, req);
      const raw = await readAll(res);
      let json: unknown = null;
      try {
        json = JSON.parse(raw.toString('utf8'));
      } catch {
        json = null;
      }
      return { status: res.statusCode ?? 502, json };
    },
    post: async () => ({ status: 500, json: null }),
  };
  const count = (path: string): number => calls.filter((c) => c.path === path).length;
  const push = (i: number, event: string, data: unknown): void => {
    streams[i]!.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  return { client, calls, down, over, streams, state, count, push };
}

const bundleOf = (version: number, settings: Record<string, unknown> = {}): Record<string, unknown> => ({
  version, zone: 'WLY01', days: [], prayer: {}, settings: { surauInfo: { logo: '' }, ...settings }, logo: null, serverTime: '2026-11-22T01:00:00.000Z',
});
const contentOf = (version: number, content: Record<string, unknown> = {}): Record<string, unknown> => ({ version, serverTime: '2026-11-22T01:00:00.000Z', content });

/** A sleep the test releases by hand, so nothing ever spins. */
function manualSleep() {
  const waiting: { ms: number; resolve: () => void }[] = [];
  const asked: number[] = [];
  return {
    asked,
    waiting,
    sleep: (ms: number, signal?: AbortSignal): Promise<void> =>
      new Promise<void>((resolve) => {
        asked.push(ms);
        waiting.push({ ms, resolve });
        signal?.addEventListener('abort', () => resolve(), { once: true });
      }),
    release(): void {
      waiting.shift()?.resolve();
    },
  };
}

let dir = '';
let cache: FollowCache;
let mirrors: Mirror[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'follow-mirror-'));
  cache = createFollowCache({ dir, freeBytes: () => 10 ** 12 });
  mirrors = [];
});
afterEach(async () => {
  for (const m of mirrors) await m.stop();
  rmSync(dir, { recursive: true, force: true });
});

function build(o: {
  master: ReturnType<typeof fakeMaster>;
  follow?: FollowStore;
  sleeper?: ReturnType<typeof manualSleep>;
  onOrder?: (order: unknown) => boolean;
  retryMs?: number;
  cache?: FollowCache;
}) {
  const bus = createChangeBus();
  const logs: [string, unknown][] = [];
  const sleeper = o.sleeper ?? manualSleep();
  const follow = o.follow ?? followStub(record());
  const mirror = createMirror({
    follow, client: o.master.client, cache: o.cache ?? cache, bus, boxId: 'd'.repeat(16),
    now: () => new Date(), sleep: sleeper.sleep, random: () => 0.5, retryMs: o.retryMs ?? 60_000,
    log: (event, detail) => logs.push([event, detail]),
    ...(o.onOrder ? { onOrder: o.onOrder } : {}),
  });
  mirrors.push(mirror);
  return { mirror, bus, logs, sleeper, follow };
}

describe('mirror: master down at start', () => {
  it('backs off 1 s doubling to 60 s, never a busy loop, and the stored copy is untouched', async () => {
    cache.putJson('bundle', bundleOf(4));
    cache.putJson('content', contentOf(4));
    const master = fakeMaster(null);
    master.down.add(A1);
    master.down.add(A2);
    const { mirror, sleeper } = build({ master });
    mirror.start();
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      await vi.waitFor(() => expect(sleeper.waiting.length).toBe(1));
      delays.push(sleeper.waiting[0]!.ms);
      sleeper.release();
      await vi.waitFor(() => expect(sleeper.asked.length).toBe(i + 2));
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    expect(mirror.state()).toMatchObject({ connected: false, removed: false, masterVersion: 4 });
    expect(cache.getJson('bundle')).toEqual(bundleOf(4));
    // each round tried both addresses once and nothing else
    expect(master.calls.length).toBe(9 * 2 + 2);
  });

  it('the delay carries jitter', async () => {
    const master = fakeMaster(null);
    master.down.add(A1);
    master.down.add(A2);
    const bus = createChangeBus();
    const s = manualSleep();
    const m = createMirror({
      follow: followStub(record()), client: master.client, cache, bus, boxId: 'd'.repeat(16), now: () => new Date(), sleep: s.sleep,
      random: () => 1, log: () => undefined,
    });
    mirrors.push(m);
    m.start();
    await vi.waitFor(() => expect(s.waiting.length).toBe(1));
    expect(s.waiting[0]!.ms).toBe(1250);
  });
});

describe('mirror: syncing from the master', () => {
  it('stores the bundle and content exactly as the master answers, asking with the TV cookie', async () => {
    const app = buildApp(':memory:');
    try {
      const master = fakeMaster(app);
      const { mirror } = build({ master });
      mirror.start();
      await vi.waitFor(() => expect(master.streams.length).toBe(1));
      const own = JSON.parse((await app.inject({ method: 'GET', url: '/api/kiosk/bundle', remoteAddress: '127.0.0.1' })).body) as { version: number };
      master.push(0, 'changed', { version: own.version });
      await vi.waitFor(() => expect(cache.getJson('content')).not.toBeNull());
      const b = cache.getJson<Record<string, unknown>>('bundle')!;
      const c = cache.getJson<Record<string, unknown>>('content')!;
      const masterB = JSON.parse((await app.inject({ method: 'GET', url: '/api/kiosk/bundle', remoteAddress: '127.0.0.1' })).body) as Record<string, unknown>;
      const masterC = JSON.parse((await app.inject({ method: 'GET', url: '/api/kiosk/content', remoteAddress: '127.0.0.1' })).body) as Record<string, unknown>;
      expect({ ...b, serverTime: 0 }).toEqual({ ...masterB, serverTime: 0 });
      expect({ ...c, serverTime: 0 }).toEqual({ ...masterC, serverTime: 0 });
      expect(mirror.state()).toMatchObject({ connected: true, masterVersion: own.version, needsUpdate: false, removed: false });
      expect(mirror.state().lastOkAt).not.toBeNull();
      for (const call of master.calls) expect(call.headers.cookie).toBe(`surau_kiosk=${TOKEN}`);
      expect(master.calls.every((x) => x.origin === A1)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('an event from the master is re-emitted on this box\'s own bus', async () => {
    const master = fakeMaster(null);
    master.over.set('/api/kiosk/bundle', () => ({ status: 200, body: bundleOf(5) }));
    master.over.set('/api/kiosk/content', () => ({ status: 200, body: contentOf(5) }));
    const { mirror, bus } = build({ master });
    const changed: number[] = [];
    const lives: unknown[] = [];
    const played: string[] = [];
    bus.on((v) => changed.push(v));
    bus.onLive((l) => lives.push(l));
    bus.onPlayNow((id) => played.push(id));
    mirror.start();
    await vi.waitFor(() => expect(master.streams.length).toBe(1));
    master.push(0, 'changed', { version: 5 });
    await vi.waitFor(() => expect(changed).toEqual([5]));
    master.push(0, 'live', { live: true, since: '2026-11-22T01:00:00.000Z', kuliah: null, audio: true, volume: 60 });
    await vi.waitFor(() => expect(lives).toHaveLength(1));
    expect(lives[0]).toMatchObject({ live: true, audio: true, volume: 60 });
    expect(cache.getJson('live')).toMatchObject({ live: true, volume: 60 });
    master.push(0, 'play-now', { itemId: 'item-1' });
    await vi.waitFor(() => expect(played).toEqual(['item-1']));
    // a new version: the stored copy changes first, then the bus says so
    master.over.set('/api/kiosk/bundle', () => ({ status: 200, body: bundleOf(6) }));
    master.over.set('/api/kiosk/content', () => ({ status: 200, body: contentOf(6) }));
    master.push(0, 'changed', { version: 6 });
    await vi.waitFor(() => expect(changed).toEqual([5, 6]));
    expect((cache.getJson('bundle') as { version: number }).version).toBe(6);
    expect(mirror.state().masterVersion).toBe(6);
  });

  it('on reconnect the version number is compared and nothing is fetched again when it is the same', async () => {
    const master = fakeMaster(null);
    master.over.set('/api/kiosk/bundle', () => ({ status: 200, body: bundleOf(5) }));
    master.over.set('/api/kiosk/content', () => ({ status: 200, body: contentOf(5) }));
    const { mirror, sleeper } = build({ master });
    mirror.start();
    await vi.waitFor(() => expect(master.streams.length).toBe(1));
    master.push(0, 'changed', { version: 5 });
    await vi.waitFor(() => expect(master.count('/api/kiosk/content')).toBe(1));
    // the stream drops; the master comes back on the next try with the same version
    master.streams[0]!.end();
    await vi.waitFor(() => expect(mirror.state().connected).toBe(false));
    await vi.waitFor(() => expect(sleeper.waiting.length).toBe(1));
    sleeper.release();
    await vi.waitFor(() => expect(master.streams.length).toBe(2));
    master.push(1, 'changed', { version: 5 });
    master.push(1, 'live', { live: false, since: null, kuliah: null, audio: false, volume: 0 });
    await vi.waitFor(() => expect(cache.getJson('live')).not.toBeNull());
    expect(master.count('/api/kiosk/bundle')).toBe(1);
    expect(master.count('/api/kiosk/content')).toBe(1);
    // a different version is fetched
    master.over.set('/api/kiosk/bundle', () => ({ status: 200, body: bundleOf(6) }));
    master.over.set('/api/kiosk/content', () => ({ status: 200, body: contentOf(6) }));
    master.push(1, 'changed', { version: 6 });
    await vi.waitFor(() => expect(master.count('/api/kiosk/bundle')).toBe(2));
  });

  it('a master that moved to its second address is reached there; the stored addresses are not rewritten', async () => {
    const master = fakeMaster(null);
    master.down.add(A1);
    master.over.set('/api/kiosk/bundle', () => ({ status: 200, body: bundleOf(2) }));
    master.over.set('/api/kiosk/content', () => ({ status: 200, body: contentOf(2) }));
    const follow = followStub(record());
    const { mirror, sleeper } = build({ master, follow });
    mirror.start();
    await vi.waitFor(() => expect(master.streams.length).toBe(1));
    expect(mirror.origin()).toBe(A2);
    master.push(0, 'changed', { version: 2 });
    await vi.waitFor(() => expect(mirror.state().masterVersion).toBe(2));
    expect(master.calls.filter((c) => c.origin === A2).length).toBeGreaterThan(0);
    expect(follow.setAddresses).not.toHaveBeenCalled();
    expect(follow.write).not.toHaveBeenCalled();
    // after a drop the address that worked is tried first
    master.down.delete(A1);
    master.streams[0]!.end();
    await vi.waitFor(() => expect(sleeper.waiting.length).toBe(1));
    sleeper.release();
    await vi.waitFor(() => expect(master.streams.length).toBe(2));
    expect(master.calls.filter((c) => c.path === '/api/kiosk/events').at(-1)?.origin).toBe(A2);
    expect(follow.setAddresses).not.toHaveBeenCalled();
  });
});

describe('mirror: files', () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(300, 9)]);
  const pngId = sha(png);

  it('a picture that arrives corrupt is refused, not stored, and fetched again later', async () => {
    const master = fakeMaster(null);
    master.over.set('/api/kiosk/bundle', () => ({ status: 200, body: bundleOf(3) }));
    master.over.set('/api/kiosk/content', () => ({ status: 200, body: contentOf(3, { posters: [{ id: 'p1', image: pngId }] }) }));
    let tries = 0;
    master.over.set(`/assets/${pngId}`, () => {
      tries++;
      return tries === 1 ? { status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.alloc(png.length, 1) } : { status: 200, headers: { 'content-type': 'image/png' }, body: png };
    });
    const { mirror, logs } = build({ master, retryMs: 10 });
    mirror.start();
    await vi.waitFor(() => expect(master.streams.length).toBe(1));
    master.push(0, 'changed', { version: 3 });
    await vi.waitFor(() => expect(tries).toBeGreaterThanOrEqual(1));
    await vi.waitFor(() => expect(logs.some(([e, d]) => e === 'file_refused' && (d as { reason: string }).reason === 'corrupt')).toBe(true));
    // the retry brings the right bytes
    await vi.waitFor(() => expect(cache.info(assetKey(pngId))).not.toBeNull());
    expect(tries).toBe(2);
    expect(cache.info(assetKey(pngId))?.hashChecked).toBe(true);
  });

  it('disk nearly full: the video is not written, the bundle and content still are, and it is not asked for again', async () => {
    const video = Buffer.alloc(2000, 3);
    const vid = sha(video);
    const small = createFollowCache({ dir: join(dir, 'small'), floorBytes: 1000, freeBytes: () => 1100 });
    const master = fakeMaster(null);
    master.over.set('/api/kiosk/bundle', () => ({ status: 200, body: bundleOf(3) }));
    master.over.set('/api/kiosk/content', () => ({ status: 200, body: contentOf(3, { videos: [{ id: 'v1', file: vid }] }) }));
    master.over.set(`/assets/${vid}`, () => ({ status: 200, headers: { 'content-type': 'video/mp4' }, body: video }));
    const { mirror } = build({ master, cache: small, retryMs: 10 });
    mirror.start();
    await vi.waitFor(() => expect(master.streams.length).toBe(1));
    master.push(0, 'changed', { version: 3 });
    await vi.waitFor(() => expect(master.count(`/assets/${vid}`)).toBe(1));
    await vi.waitFor(() => expect(small.getJson('content')).not.toBeNull());
    expect(small.info(assetKey(vid))).toBeNull();
    expect(small.getJson('bundle')).toEqual(bundleOf(3));
    await new Promise((r) => setTimeout(r, 80));
    expect(master.count(`/assets/${vid}`)).toBe(1);
  });

  it('a theme pack: its stylesheet and the files it names are mirrored, the pack file itself is not asked for', async () => {
    const packId = 'a'.repeat(64);
    const base = `/themes/hijau-siti/${'a'.repeat(16)}-2`;
    const css = `.x{background:url(${base}/images/semua.png)}`;
    const master = fakeMaster(null);
    master.over.set('/api/kiosk/bundle', () => ({
      status: 200,
      body: bundleOf(3, { themeStyle: { packs: { 'hijau-siti': { assetId: packId, version: 1, title: 'Hijau', base: 'default', contract: 1, bytes: 10, fonts: [], screens: [], images: { semua: 'png' }, defaults: {} } } } }),
    }));
    master.over.set('/api/kiosk/content', () => ({ status: 200, body: contentOf(3) }));
    master.over.set(`${base}/bundle.css`, () => ({ status: 200, headers: { 'content-type': 'text/css' }, body: css }));
    master.over.set(`${base}/images/semua.png`, () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: png }));
    const { mirror } = build({ master });
    mirror.start();
    await vi.waitFor(() => expect(master.streams.length).toBe(1));
    master.push(0, 'changed', { version: 3 });
    await vi.waitFor(() => expect(master.count(`${base}/images/semua.png`)).toBeGreaterThan(0));
    await vi.waitFor(() => expect(cache.stats().files).toBe(2));
    expect(master.count(`/assets/${packId}`)).toBe(0);
    // each theme file was asked for once, the one the stylesheet names too
    expect(master.count(`${base}/images/semua.png`)).toBe(1);
  });

  it('names the asset ids a bundle and content hold, without the pack files', () => {
    const packId = 'e'.repeat(64);
    const ids = assetIdsOf(
      bundleOf(1, { surauInfo: { logo: pngId }, themeStyle: { packs: { 'hijau-siti': { assetId: packId, contract: 1 } } } }),
      contentOf(1, { a: [{ x: pngId }, { y: 'f'.repeat(64) }], notAnId: 'F'.repeat(64) }),
    );
    expect(ids.sort()).toEqual([pngId, 'f'.repeat(64)].sort());
  });
});

describe('mirror: contracts', () => {
  it('a master with a newer theme contract sets needsUpdate and the stored copy keeps being served', async () => {
    const master = fakeMaster(null);
    const newer = bundleOf(7, { themeStyle: { packs: { 'hijau-siti': { assetId: 'a'.repeat(64), contract: THEME_CONTRACT + 1 } } } });
    master.over.set('/api/kiosk/bundle', () => ({ status: 200, body: newer }));
    master.over.set('/api/kiosk/content', () => ({ status: 200, body: contentOf(7) }));
    const { mirror } = build({ master });
    mirror.start();
    await vi.waitFor(() => expect(master.streams.length).toBe(1));
    expect(mirror.state().needsUpdate).toBe(false);
    master.push(0, 'changed', { version: 7 });
    await vi.waitFor(() => expect(mirror.state().needsUpdate).toBe(true));
    expect((cache.getJson('bundle') as { version: number }).version).toBe(7);
  });

  it('needsUpdate is known again after a restart, from the stored copy', () => {
    cache.putJson('bundle', bundleOf(7, { themeStyle: { packs: { x: { assetId: 'a'.repeat(64), contract: THEME_CONTRACT + 1 } } } }));
    const { mirror } = build({ master: fakeMaster(null) });
    expect(mirror.state().needsUpdate).toBe(true);
    expect(mirror.state().masterVersion).toBe(7);
  });
});

describe('mirror: token revoked', () => {
  it('asks for the order once, hands it to onOrder, stops fetching, wipes nothing itself', async () => {
    const master = fakeMaster(null);
    master.state.revoked = true;
    const order = { order: 'forget', body: { boxId: 'd'.repeat(16), linkId: 'a'.repeat(32), masterBoxId: 'b'.repeat(16) }, sig: 'sig' };
    master.over.set(ORDER_PATH, () => ({ status: 200, body: order }));
    const onOrder = vi.fn<(o: unknown) => boolean>(() => true);
    const follow = followStub(record());
    const { mirror } = build({ master, follow, onOrder });
    mirror.start();
    await vi.waitFor(() => expect(mirror.state().removed).toBe(true));
    expect(onOrder).toHaveBeenCalledTimes(1);
    expect(onOrder).toHaveBeenCalledWith(order);
    const ask = master.calls.find((c) => c.path === ORDER_PATH)!;
    expect(ask.method).toBe('POST');
    expect(JSON.parse(ask.body!)).toEqual({ boxId: 'd'.repeat(16), linkId: 'a'.repeat(32) });
    expect(ask.headers.cookie).toBeUndefined();
    await new Promise((r) => setTimeout(r, 60));
    const total = master.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(master.calls.length).toBe(total);
    expect(master.count(ORDER_PATH)).toBe(1);
    expect(follow.clear).not.toHaveBeenCalled();
    expect(follow.write).not.toHaveBeenCalled();
    await mirror.stop();
    mirror.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(master.calls.length).toBe(total);
  });

  it('a refused token with no order from the master is not "removed": the mirror waits and asks again later', async () => {
    const master = fakeMaster(null);
    master.state.revoked = true;
    master.over.set(ORDER_PATH, () => ({ status: 200, body: { order: null } }));
    const onOrder = vi.fn<(o: unknown) => boolean>(() => true);
    const { mirror, sleeper } = build({ master, onOrder });
    mirror.start();
    await vi.waitFor(() => expect(sleeper.waiting.length).toBe(1));
    expect(mirror.state().removed).toBe(false);
    expect(onOrder).not.toHaveBeenCalled();
    sleeper.release();
    await vi.waitFor(() => expect(master.count(ORDER_PATH)).toBe(2));
  });

  it('a token refused while the stream is open (revoked later) ends in the same place', async () => {
    const master = fakeMaster(null);
    master.over.set('/api/kiosk/bundle', () => (master.state.revoked ? { status: 403 } : { status: 200, body: bundleOf(5) }));
    master.over.set('/api/kiosk/content', () => ({ status: 200, body: contentOf(5) }));
    master.over.set(ORDER_PATH, () => ({ status: 200, body: { order: 'forget', body: {}, sig: 's' } }));
    const onOrder = vi.fn<(o: unknown) => boolean>(() => true);
    const { mirror } = build({ master, onOrder });
    mirror.start();
    await vi.waitFor(() => expect(master.streams.length).toBe(1));
    master.state.revoked = true;
    master.push(0, 'changed', { version: 5 });
    await vi.waitFor(() => expect(mirror.state().removed).toBe(true));
    expect(onOrder).toHaveBeenCalledTimes(1);
  });

  it('onOrder returns false: not removed, the mirror keeps running and asks for the order again after the back-off', async () => {
    const master = fakeMaster(null);
    master.state.revoked = true;
    master.over.set(ORDER_PATH, () => ({ status: 200, body: { order: 'forget', body: {}, sig: 'bad' } }));
    const onOrder = vi.fn<(o: unknown) => boolean>(() => false);
    const { mirror, sleeper, logs } = build({ master, onOrder });
    mirror.start();
    await vi.waitFor(() => expect(sleeper.waiting.length).toBe(1));
    expect(onOrder).toHaveBeenCalledTimes(1);
    expect(mirror.state().removed).toBe(false);
    expect(logs.some(([e]) => e === 'order_not_accepted')).toBe(true);
    expect(master.count(ORDER_PATH)).toBe(1);
    sleeper.release();
    await vi.waitFor(() => expect(master.count(ORDER_PATH)).toBe(2));
    expect(onOrder).toHaveBeenCalledTimes(2);
    expect(mirror.state().removed).toBe(false);
    // the next wait is longer: the back-off doubled
    await vi.waitFor(() => expect(sleeper.waiting.length).toBe(1));
    expect(sleeper.asked[1]!).toBeGreaterThan(sleeper.asked[0]!);
  });

  it('onOrder throws: same as false, the mirror is not removed and asks again', async () => {
    const master = fakeMaster(null);
    master.state.revoked = true;
    master.over.set(ORDER_PATH, () => ({ status: 200, body: { order: 'forget', body: {}, sig: 'x' } }));
    const onOrder = vi.fn<(o: unknown) => boolean>(() => {
      throw new Error('boom');
    });
    const { mirror, sleeper, logs } = build({ master, onOrder });
    mirror.start();
    await vi.waitFor(() => expect(sleeper.waiting.length).toBe(1));
    expect(mirror.state().removed).toBe(false);
    expect(logs.some(([e]) => e === 'order_not_accepted')).toBe(true);
    sleeper.release();
    await vi.waitFor(() => expect(master.count(ORDER_PATH)).toBe(2));
    expect(onOrder).toHaveBeenCalledTimes(2);
    expect(mirror.state().removed).toBe(false);
  });
});

describe('mirror: the token is never logged', () => {
  it('neither the log callback nor the console ever sees the token or the cookie', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    try {
      const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(100, 5)]);
      const id = sha(png);
      const master = fakeMaster(null);
      master.down.add(A1);
      master.over.set('/api/kiosk/bundle', () => ({ status: 200, body: bundleOf(2) }));
      master.over.set('/api/kiosk/content', () => ({ status: 200, body: contentOf(2, { x: id }) }));
      master.over.set(`/assets/${id}`, () => ({ status: 200, body: Buffer.alloc(100, 1), headers: { 'content-type': 'image/png' } }));
      const { mirror, logs } = build({ master, retryMs: 5 });
      mirror.start();
      await vi.waitFor(() => expect(master.streams.length).toBe(1));
      master.push(0, 'changed', { version: 2 });
      await vi.waitFor(() => expect(logs.some(([e]) => e === 'file_refused')).toBe(true));
      master.state.revoked = true;
      master.streams[0]!.end();
      master.over.set(ORDER_PATH, () => ({ status: 200, body: { order: 'forget', body: {}, sig: 's' } }));
      await vi.waitFor(() => expect(logs.length).toBeGreaterThan(4));
      const seen = JSON.stringify(logs) + JSON.stringify(spies.map((s) => s.mock.calls));
      expect(seen).not.toContain(TOKEN);
      expect(seen).not.toContain('surau_kiosk');
      expect(seen).not.toContain('cookie');
      // the cookie did go on the wire, so the check above is not trivially true
      expect(master.calls.some((c) => c.headers.cookie === `surau_kiosk=${TOKEN}`)).toBe(true);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

// 2026.11.15, Lane A task A7 (K3): a follower never keeps showing a live its master no longer confirms.
describe('K3: the follower clears its cached live', () => {
  const LIVE_ON = { live: true, since: '2026-11-22T01:00:00.000Z', kuliah: null, audio: true, volume: 60 };

  it('a live:true left on disk by an earlier run is cleared when the mirror starts, before the master says anything', async () => {
    cache.putJson('live', LIVE_ON);
    const master = fakeMaster(null);
    master.down.add(A1);
    master.down.add(A2);
    const { mirror, bus } = build({ master });
    const lives: Array<{ live: boolean }> = [];
    bus.onLive((l) => lives.push(l));
    mirror.start();
    await vi.waitFor(() => expect(cache.getJson('live')).toMatchObject({ live: false }));
    expect(lives).toEqual([expect.objectContaining({ live: false })]);
  });

  it('the stream to the master drops mid-live: the TV is told live:false, and the live returns when the master says so again (success path)', async () => {
    const master = fakeMaster(null);
    master.over.set('/api/kiosk/bundle', () => ({ status: 200, body: bundleOf(5) }));
    master.over.set('/api/kiosk/content', () => ({ status: 200, body: contentOf(5) }));
    const { mirror, bus, sleeper } = build({ master });
    const lives: Array<{ live: boolean }> = [];
    bus.onLive((l) => lives.push(l));
    mirror.start();
    await vi.waitFor(() => expect(master.streams.length).toBe(1));
    master.push(0, 'live', LIVE_ON);
    await vi.waitFor(() => expect(cache.getJson('live')).toMatchObject({ live: true }));
    // the master restarts
    master.streams[0]!.end();
    await vi.waitFor(() => expect(mirror.state().connected).toBe(false));
    await vi.waitFor(() => expect(cache.getJson('live')).toMatchObject({ live: false }));
    expect(lives.map((l) => l.live)).toEqual([true, false]);
    // it comes back and its live is still on
    await vi.waitFor(() => expect(sleeper.waiting.length).toBe(1));
    sleeper.release();
    await vi.waitFor(() => expect(master.streams.length).toBe(2));
    master.push(1, 'live', LIVE_ON);
    await vi.waitFor(() => expect(lives.map((l) => l.live)).toEqual([true, false, true]));
    expect(cache.getJson('live')).toMatchObject({ live: true, volume: 60 });
  });

  it('a cached live:false is left as it is: no extra event at start or on a drop', async () => {
    cache.putJson('live', { live: false, since: null, kuliah: null, audio: false, volume: 0 });
    const master = fakeMaster(null);
    const { mirror, bus } = build({ master });
    const lives: unknown[] = [];
    bus.onLive((l) => lives.push(l));
    mirror.start();
    await vi.waitFor(() => expect(master.streams.length).toBe(1));
    master.streams[0]!.end();
    await vi.waitFor(() => expect(mirror.state().connected).toBe(false));
    expect(lives).toEqual([]);
  });
});
