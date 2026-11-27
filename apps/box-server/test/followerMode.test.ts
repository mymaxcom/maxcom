import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { boxId as boxIdOf } from '../src/auth/secrets.ts';
import { createFollowStore } from '../src/follow/store.ts';
import type { FollowRecord } from '../src/follow/store.ts';
import { readJournal } from '../src/link/journal.ts';
import { applyLinkJournalAtBoot } from '../src/link/setAside.ts';
import { identityPub, signLink } from '../src/link/sign.ts';
import { ephemeralIdentity, loadIdentity } from '../src/setup/identity.ts';
import type { BoxIdentity } from '../src/setup/identity.ts';

/**
 * A follower box (kotak pengikut) end to end: a real `buildApp` on a real data folder that holds a follow record,
 * with the master replaced by a fake channel (`link.mirrorClient`). Covers what a follower starts and does not start,
 * what its own TV is told, and above all which orders to forget the surau it obeys.
 */

const MASTER_ORIGIN = 'https://10.168.50.10:8443';
const MASTER_CA = 'ab'.repeat(32);
const MASTER_BOX = 'b'.repeat(16);
const LINK = 'a'.repeat(32);
const TOKEN = `Zq9X${'a1'.repeat(19)}b`;
const ORDER_PATH = '/api/link/peer/order';
const LOOPBACK = '127.0.0.1';
const LAN = '10.168.50.20';

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'maxcom-follower-'));
  dirs.push(d);
  return d;
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
  const headers: Record<string, string> = { ...(typeof r.body === 'object' && !Buffer.isBuffer(r.body) ? { 'content-type': 'application/json' } : {}), ...(r.headers ?? {}) };
  if (!('content-length' in headers) && r.body !== undefined) headers['content-length'] = String(buf.length);
  return Object.assign(Readable.from(buf.length > 0 ? [buf] : []), { statusCode: r.status, headers }) as unknown as IncomingMessage;
}

async function readAll(res: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of res) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

/** The master as the follower's channel sees it: kiosk routes with the TV cookie, one event stream, the order route. */
function fakeMaster() {
  const calls: Call[] = [];
  const over = new Map<string, (c: Call) => Resp>();
  const streams: PassThrough[] = [];
  const state = { revoked: false };

  const respond = (c: Call): IncomingMessage => {
    const o = over.get(c.path);
    if (c.path === ORDER_PATH) return asResponse(o ? o(c) : { status: 200, body: { order: null } });
    if (state.revoked) return asResponse({ status: 401, body: { errors: ['sign in'] } });
    if (o) return asResponse(o(c));
    if (c.path === '/api/kiosk/events') {
      const s = new PassThrough();
      streams.push(s);
      return Object.assign(s, { statusCode: 200, headers: { 'content-type': 'text/event-stream' } }) as unknown as IncomingMessage;
    }
    return asResponse({ status: 404, body: { code: 'not_found' } });
  };

  const client = {
    async request(origin: string, _ca: string, req: { method?: string; path: string; headers?: Record<string, string>; body?: string | Uint8Array }): Promise<IncomingMessage> {
      const c: Call = { origin, method: req.method ?? 'GET', path: req.path, headers: req.headers ?? {}, body: req.body === undefined ? undefined : String(req.body) };
      calls.push(c);
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
  return { client, calls, over, streams, state, count, push };
}

/** A sleep the test releases by hand, so the mirror never spins. */
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

const bundleOf = (version: number, name = 'Surau Al-Hidayah'): Record<string, unknown> => ({
  version, zone: 'WLY01', days: [], prayer: {}, settings: { surauInfo: { name, logo: '' } }, logo: null, serverTime: '2026-11-22T01:00:00.000Z',
});
const contentOf = (version: number): Record<string, unknown> => ({ version, serverTime: '2026-11-22T01:00:00.000Z', content: { announcements: [] } });

interface Follower {
  dir: string;
  app: FastifyInstance;
  master: ReturnType<typeof fakeMaster>;
  masterId: BoxIdentity;
  sleeper: ReturnType<typeof manualSleep>;
  restart: ReturnType<typeof vi.fn>;
  boxId: string;
  rec: FollowRecord;
}

/** Makes the data folder of a follower (its identity, its sealed follow record), then starts the app on it. */
async function startFollower(o: { revoked?: boolean; order?: (f: Follower) => Record<string, unknown> } = {}): Promise<Follower> {
  const dir = tempDir();
  const identity = loadIdentity(dir);
  const boxId = boxIdOf(dir);
  const masterId = ephemeralIdentity();
  const rec: FollowRecord = {
    v: 1,
    linkId: LINK,
    masterBoxId: MASTER_BOX,
    masterKeyFp: masterId.keyFp,
    masterPub: identityPub(masterId),
    masterCa: MASTER_CA,
    masterName: 'Surau Al-Hidayah',
    addresses: [MASTER_ORIGIN],
    token: TOKEN,
    deviceId: 'device-ruang-muslimat',
    linkedAt: '2026-11-20T10:00:00.000Z',
    hadStore: false,
  };
  createFollowStore(dir, identity, boxId).write(rec);

  const master = fakeMaster();
  master.state.revoked = o.revoked === true;
  const sleeper = manualSleep();
  const restart = vi.fn();
  const app = buildApp(join(dir, 'surau.db'), {
    dataDir: dir,
    liveTools: { dir: join(dir, 'tools'), spawn: { exe: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, apiPort: 1, webrtcPort: 1 },
    link: { mirrorClient: master.client, restart, mirror: { sleep: sleeper.sleep, refreshMs: 3_600_000, retryMs: 3_600_000, idleMs: 3_600_000 } },
  });
  apps.push(app);
  const f: Follower = { dir, app, master, masterId, sleeper, restart, boxId, rec };
  // The answer is staged before the mirror starts (it starts on ready and asks at once).
  if (o.order !== undefined) master.over.set(ORDER_PATH, () => ({ status: 200, body: o.order!(f) }));
  await app.ready();
  return f;
}

const kiosk = (app: FastifyInstance, url: string) => app.inject({ method: 'GET', url, remoteAddress: LOOPBACK });

describe('a follower box: what it does not start', () => {
  it('has no sync agent and no live runtime, even when live tools are offered', async () => {
    const f = await startFollower();
    expect(f.app.syncAgent).toBeNull();
    expect(f.app.liveRuntime).toBeNull();
    expect(f.app.link!.follow.present()).toBe(true);
  });

  it('a normal box in its own folder is "main", has a sync agent and the same state fields as before', async () => {
    const dir = tempDir();
    const app = buildApp(join(dir, 'surau.db'), { dataDir: dir });
    apps.push(app);
    await app.ready();
    expect(app.syncAgent).not.toBeNull();
    const info = (await kiosk(app, '/api/box/info')).json();
    expect(info.mode).toBe('main');
    expect(info.state).toBe('setup');
    const state = (await kiosk(app, '/api/box/state')).json();
    expect(state.mode).toBe('main');
    expect(state.master).toBeUndefined();
    expect(state.connected).toBeUndefined();
    expect(state.awayMinutes).toBeUndefined();
    expect(state.needsUpdate).toBeUndefined();
    // a box that is waiting to be set up shows its setup QR on its own screen
    expect(state.qr).toBeDefined();
  });
});

describe('a follower box: what its own TV is told', () => {
  it('/api/box/info and /api/box/state say active, follower, the master name, and never a QR', async () => {
    const f = await startFollower();
    const info = (await kiosk(f.app, '/api/box/info')).json();
    expect(info).toMatchObject({ state: 'active', reason: 'none', mode: 'follower' });
    const state = (await kiosk(f.app, '/api/box/state')).json();
    expect(state).toMatchObject({ state: 'active', reason: 'none', mode: 'follower', master: { name: 'Surau Al-Hidayah' }, needsUpdate: false, awayMinutes: 0 });
    expect(typeof state.connected).toBe('boolean');
    expect(state.qr).toBeUndefined();
    // no name before the first answer of the master
    expect(state.surauName).toBeNull();
    // the same for a loopback kiosk with the per-start token
    expect(JSON.stringify(state)).not.toContain('maxcom1:');
  });

  it('the surau name comes from the stored bundle once the mirror has one', async () => {
    const f = await startFollower();
    f.master.over.set('/api/kiosk/bundle', () => ({ status: 200, body: bundleOf(5) }));
    f.master.over.set('/api/kiosk/content', () => ({ status: 200, body: contentOf(5) }));
    await vi.waitFor(() => expect(f.master.streams.length).toBe(1));
    expect((await kiosk(f.app, '/api/box/state')).json().connected).toBe(true);
    f.master.push(0, 'changed', { version: 5 });
    await vi.waitFor(async () => expect((await kiosk(f.app, '/api/box/state')).json().surauName).toBe('Surau Al-Hidayah'));
  });

  it('/api/kiosk/bundle is 503 mirror_empty before the first copy, then the master\'s bundle', async () => {
    const f = await startFollower();
    const empty = await kiosk(f.app, '/api/kiosk/bundle');
    expect(empty.statusCode).toBe(503);
    expect(empty.json().code).toBe('mirror_empty');
    expect((await kiosk(f.app, '/api/kiosk/content')).statusCode).toBe(503);

    f.master.over.set('/api/kiosk/bundle', () => ({ status: 200, body: bundleOf(7) }));
    f.master.over.set('/api/kiosk/content', () => ({ status: 200, body: contentOf(7) }));
    await vi.waitFor(() => expect(f.master.streams.length).toBe(1));
    f.master.push(0, 'changed', { version: 7 });
    await vi.waitFor(async () => expect((await kiosk(f.app, '/api/kiosk/bundle')).statusCode).toBe(200));
    const b = (await kiosk(f.app, '/api/kiosk/bundle')).json();
    expect(b).toEqual(bundleOf(7));
    expect((await kiosk(f.app, '/api/kiosk/content')).json()).toEqual(contentOf(7));
    // the mirror asked the master with the TV cookie and nothing else
    for (const c of f.master.calls.filter((x) => x.path !== ORDER_PATH)) expect(c.headers.cookie).toBe(`surau_kiosk=${TOKEN}`);
  });
});

describe('a follower box: the gate', () => {
  it('an admin route answers 409 follower with the master name; pairing and renaming are shut too', async () => {
    const f = await startFollower();
    const settings = await f.app.inject({ method: 'GET', url: '/api/settings', remoteAddress: LAN });
    expect(settings.statusCode).toBe(409);
    expect(settings.json().code).toBe('follower');
    expect(settings.json().master).toEqual({ name: 'Surau Al-Hidayah', boxId: MASTER_BOX, addresses: [MASTER_ORIGIN], caSha256: MASTER_CA });
    const begin = await f.app.inject({ method: 'POST', url: '/api/kiosk/pair/begin', remoteAddress: LOOPBACK, payload: {} });
    expect(begin.statusCode).toBe(409);
    expect(begin.json().code).toBe('follower');
    const name = await f.app.inject({ method: 'PUT', url: '/api/box/name', remoteAddress: LAN, payload: { name: 'Dewan Utama' } });
    expect(name.statusCode).toBe(409);
    expect(name.json().code).toBe('follower');
    // the TV and the box state are still answered
    expect((await kiosk(f.app, '/api/box/state')).statusCode).toBe(200);
  });
});

/** An order the way the master signs it. */
const orderOf = (
  f: Follower,
  o: { signer?: BoxIdentity; step?: 'order-forget' | 'commit'; body?: Record<string, unknown>; sigLinkId?: string } = {},
): Record<string, unknown> => {
  const body = o.body ?? { boxId: f.boxId, linkId: LINK, masterBoxId: MASTER_BOX };
  return { order: 'forget', body, sig: signLink(o.signer ?? f.masterId, o.step ?? 'order-forget', o.sigLinkId ?? String((body as { linkId?: unknown }).linkId ?? LINK), body) };
};

describe('a follower box: the order to forget the surau (security)', () => {
  it('a correctly signed order plans the wipe for the next start, restarts once, and the next start returns the box to first setup', async () => {
    const f = await startFollower({ revoked: true, order: (x) => orderOf(x) });
    await vi.waitFor(() => expect(f.restart).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(readJournal(f.dir)).toMatchObject({ v: 1, op: 'forget', linkId: LINK });
    // the plan only; the start does the wipe
    expect(f.app.link!.follow.present()).toBe(true);
    expect(existsSync(join(f.dir, 'secret', 'follow.json'))).toBe(true);
    // the mirror took the order and stopped asking
    expect(f.master.count(ORDER_PATH)).toBe(1);
    expect(f.sleeper.asked).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(f.restart).toHaveBeenCalledTimes(1);
    expect(f.master.count(ORDER_PATH)).toBe(1);

    const keyBefore = readFileSync(join(f.dir, 'secret', 'box.key'));
    const idBefore = readFileSync(join(f.dir, 'secret', 'identity.key'));
    await f.app.close();
    expect(applyLinkJournalAtBoot(f.dir)).toBe('forget');
    expect(existsSync(join(f.dir, 'secret', 'follow.json'))).toBe(false);
    expect(existsSync(join(f.dir, 'surau.db'))).toBe(false);
    expect(existsSync(join(f.dir, 'follow'))).toBe(false);
    expect(existsSync(join(f.dir, 'link.json'))).toBe(false);
    // the keys stay: the box keeps its identity
    expect(readFileSync(join(f.dir, 'secret', 'box.key')).equals(keyBefore)).toBe(true);
    expect(readFileSync(join(f.dir, 'secret', 'identity.key')).equals(idBefore)).toBe(true);

    // started again it is a box nobody has set up
    const again = buildApp(join(f.dir, 'surau.db'), { dataDir: f.dir });
    apps.push(again);
    await again.ready();
    expect(again.link!.follow.present()).toBe(false);
    const info = (await kiosk(again, '/api/box/info')).json();
    expect(info).toMatchObject({ state: 'setup', mode: 'main' });
  });

  const WRONG: [string, (f: Follower) => Record<string, unknown>][] = [
    ['signed by another key', (f) => orderOf(f, { signer: ephemeralIdentity() })],
    ['right signature but the box id of another box', (f) => orderOf(f, { body: { boxId: 'e'.repeat(16), linkId: LINK, masterBoxId: MASTER_BOX } })],
    ['another link id', (f) => orderOf(f, { body: { boxId: f.boxId, linkId: 'f'.repeat(32), masterBoxId: MASTER_BOX } })],
    ['another master box id', (f) => orderOf(f, { body: { boxId: f.boxId, linkId: LINK, masterBoxId: 'd'.repeat(16) } })],
    ['an extra field in the body', (f) => orderOf(f, { body: { boxId: f.boxId, linkId: LINK, masterBoxId: MASTER_BOX, extra: 1 } })],
    ['no signature', (f) => ({ order: 'forget', body: { boxId: f.boxId, linkId: LINK, masterBoxId: MASTER_BOX } })],
    ['a signature that is not a string', (f) => ({ order: 'forget', body: { boxId: f.boxId, linkId: LINK, masterBoxId: MASTER_BOX }, sig: 12 })],
    ['order null', () => ({ order: null })],
    ['a signature made for the step commit', (f) => orderOf(f, { step: 'commit' })],
    ['a body that is not an object', () => ({ order: 'forget', body: 'x', sig: 'y' })],
  ];

  it.each(WRONG)('%s: nothing changes and the mirror keeps asking', async (_name, make) => {
    const f = await startFollower({ revoked: true, order: make });
    // the mirror got the answer and is waiting out its back-off
    await vi.waitFor(() => expect(f.sleeper.waiting.length).toBe(1));
    expect(f.master.count(ORDER_PATH)).toBe(1);
    expect(existsSync(join(f.dir, 'link.json'))).toBe(false);
    expect(f.restart).not.toHaveBeenCalled();
    expect(f.app.link!.follow.present()).toBe(true);
    // not removed: after the back-off it asks again
    f.sleeper.release();
    await vi.waitFor(() => expect(f.master.count(ORDER_PATH)).toBe(2));
    await vi.waitFor(() => expect(f.sleeper.waiting.length).toBe(1));
    expect(existsSync(join(f.dir, 'link.json'))).toBe(false);
    await new Promise((r) => setTimeout(r, 900));
    expect(f.restart).not.toHaveBeenCalled();
    expect(readJournal(f.dir)).toBeNull();
    expect(existsSync(join(f.dir, 'secret', 'follow.json'))).toBe(true);
  });

  it('a master that answers 401 and says nothing else leaves the box as it is', async () => {
    const f = await startFollower({ revoked: true });
    await vi.waitFor(() => expect(f.sleeper.waiting.length).toBe(1));
    expect(f.master.count(ORDER_PATH)).toBe(1);
    expect(existsSync(join(f.dir, 'link.json'))).toBe(false);
    expect(f.restart).not.toHaveBeenCalled();
    expect((await kiosk(f.app, '/api/box/state')).json().mode).toBe('follower');
  });
});
