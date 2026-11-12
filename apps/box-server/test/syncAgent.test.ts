import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { getAssetPath, putAsset } from '../src/assets/store.ts';
import { putFeature } from '../src/settingsStore.ts';
import type { PrayerDay } from '@surau/core';
import { importDays } from '../src/prayerStore.ts';
import { getItem, putItem } from '../src/content/store.ts';
import { runCloudLink } from '../src/cli/cloudLink.ts';
import { assetIdsIn, BACKOFF_MS } from '../src/sync/agent.ts';
import { issueLinkCode } from '../src/sync/sites.ts';
import { loadSyncKey, saveSyncKey } from '../src/sync/syncKey.ts';
import { loginAs } from './authHelpers.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';
import { signOp } from './support/signOp.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

interface Pair {
  box: FastifyInstance;
  boxDir: string;
  boxId: string;
  cloud: TestCloud;
  worker: FakeWorker;
  sleeps: number[];
  /** Replaces the fetch the agent uses (for failure injection); default is the worker. */
  hook: { fetch: typeof fetch };
}

const pairs: Pair[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const p of pairs.splice(0)) {
    await p.box.close().catch(() => undefined);
    await p.cloud.close();
    rmSync(p.boxDir, { recursive: true, force: true });
  }
});

async function makePair(o: { onSleep?: (ms: number, p: Pair) => void; limits?: { push?: number } } = {}): Promise<Pair> {
  const boxDir = mkdtempSync(join(tmpdir(), 'surau-agentbox-'));
  const hook = { fetch: (undefined as unknown) as typeof fetch };
  const sleeps: number[] = [];
  let pair: Pair | undefined;
  const box = buildApp(join(boxDir, 'box.db'), {
    dataDir: boxDir,
    sync: {
      ...(o.limits ? { limits: o.limits } : {}),
      fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => hook.fetch(i, n)) as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (pair) o.onSleep?.(ms, pair);
      },
    },
  });
  const boxId = box.surau.boxId;
  const cloud = buildCloud(boxId);
  const worker = new FakeWorker(cloud.fetch);
  hook.fetch = worker.fetch;
  pair = { box, boxDir, boxId, cloud, worker, sleeps, hook };
  pairs.push(pair);

  const { code } = issueLinkCode({ db: cloud.app.surau.db, now: () => new Date() }, { boxId, name: 'Surau D\'Waqaf' });
  const lines: string[] = [];
  const exit = await runCloudLink(['--data', boxDir, '--db', join(boxDir, 'box.db'), 'link', CLOUD_URL, code], { out: (l) => lines.push(l), err: (l) => lines.push(l) }, worker.fetch);
  expect(lines.join('\n')).toContain('Dipautkan ke awan: Surau D\'Waqaf');
  expect(exit).toBe(0);
  worker.setSecret(boxId, loadSyncKey(boxDir)!.wakeSecret);
  return pair;
}

const count = (app: FastifyInstance, sql: string): number => Number(app.surau.db.prepare(sql).get()?.n ?? 0);
const feedCount = (app: FastifyInstance): number => count(app, "SELECT COUNT(*) AS n FROM change_log WHERE entity LIKE 'content:%'");
const agentOf = (p: Pair) => p.box.syncAgent!;

describe('link and the sealed sync key', () => {
  it('seals the site key and wake secret under secret/ (not readable as JSON) and a damaged file is refused', async () => {
    const p = await makePair();
    const key = loadSyncKey(p.boxDir)!;
    const text = readFileSync(join(p.boxDir, 'secret', 'sync.key'), 'utf8');
    expect(text.startsWith('v1.')).toBe(true);
    expect(text).not.toContain(key.siteToken);
    expect(text).not.toContain(key.wakeSecret);
    expect(key.cloudUrl).toBe(CLOUD_URL);
    expect(count(p.box, "SELECT COUNT(*) AS n FROM sync_state WHERE key = 'linked' AND value = '1'")).toBe(1);
    expect(p.box.surau.db.prepare("SELECT value FROM sync_state WHERE key = 'last_error'").get()).toBeUndefined();
    // the settings feature is switched on by the link
    expect(JSON.parse(String(p.box.surau.db.prepare("SELECT json FROM settings WHERE feature = 'cloudSync'").get()?.json))).toMatchObject({ enabled: true });
    writeFileSync(join(p.boxDir, 'secret', 'sync.key'), text.slice(0, -4) + 'AAAA');
    expect(() => loadSyncKey(p.boxDir)).toThrow('sync key: cannot open');
  });

  it('a wrong code does not link and leaves no key file', async () => {
    const boxDir = mkdtempSync(join(tmpdir(), 'surau-agentbox-'));
    const box = buildApp(join(boxDir, 'box.db'), { dataDir: boxDir });
    const cloud = buildCloud(box.surau.boxId);
    const lines: string[] = [];
    const exit = await runCloudLink(['--data', boxDir, 'link', CLOUD_URL, 'WRONGCODE234'], { out: (l) => lines.push(l), err: (l) => lines.push(l) }, cloud.fetch);
    expect(exit).toBe(1);
    expect(loadSyncKey(boxDir)).toBeNull();
    await box.close();
    await cloud.close();
    rmSync(boxDir, { recursive: true, force: true });
  });
});

describe('push and pull', () => {
  it('a pengumuman put on the box appears on the cloud with origin box:<id>, no op id and the same rev', async () => {
    const p = await makePair();
    putItem(p.box.surau.db, 'penceramah', { id: 'p1', name: 'Ustaz A' }, 'local');
    // the link switched cloudSync on (a settings change) and the item is the second
    expect(agentOf(p).status().pendingOut).toBe(2);
    await agentOf(p).runOnce();
    const st = agentOf(p).status();
    expect(st).toMatchObject({ linked: true, lastError: null, state: 'idle', pendingOut: 0 });
    expect(st.lastPush).not.toBeNull();
    expect(st.lastPull).not.toBeNull();
    const boxRev = p.box.surau.db.prepare("SELECT rev FROM content_items WHERE id = 'p1'").get()?.rev;
    const row = p.cloud.app.surau.db.prepare("SELECT rev, origin FROM content_items WHERE id = 'p1'").get();
    expect(row).toMatchObject({ rev: boxRev, origin: `box:${p.boxId}` });
    expect(p.cloud.app.surau.db.prepare("SELECT op_id, origin FROM change_log WHERE entity = 'content:penceramah'").get()).toMatchObject({ op_id: null, origin: `box:${p.boxId}` });
    expect(getItem(p.cloud.app.surau.db, 'penceramah', 'p1')).toMatchObject({ name: 'Ustaz A' });
  });

  it('a content op pushed by a device to the cloud lands on the box as origin app with its op id, and nothing bounces back', async () => {
    const p = await makePair();
    const login = await loginAs(p.cloud.app, 'admin');
    const op = await signOp(login, p.boxId, { kind: 'content.put', entity: 'content:penceramah', entityId: 'p2', payload: { name: 'Ustaz B' } });
    const res = await p.cloud.app.inject({ method: 'POST', url: '/api/sync/ops', headers: login.headers, payload: { ops: [op] } });
    expect(res.json().results[0].status).toBe('applied');
    await agentOf(p).runOnce();
    expect(p.box.surau.db.prepare("SELECT origin, op_id FROM change_log WHERE entity = 'content:penceramah'").get()).toMatchObject({ origin: 'app', op_id: op.opId });
    expect(getItem(p.box.surau.db, 'penceramah', 'p2')).toMatchObject({ name: 'Ustaz B' });
    const cloudBefore = feedCount(p.cloud.app);
    const boxBefore = feedCount(p.box);
    await agentOf(p).runOnce();
    await agentOf(p).runOnce();
    expect(feedCount(p.cloud.app)).toBe(cloudBefore);
    expect(feedCount(p.box)).toBe(boxBefore);
  });

  it('a device op the box itself accepted (origin app) is pushed up, once', async () => {
    const p = await makePair();
    const login = await loginAs(p.box, 'admin');
    const op = await signOp(login, p.boxId, { kind: 'content.put', entity: 'content:penceramah', entityId: 'p3', payload: { name: 'Ustaz C' } });
    expect((await p.box.inject({ method: 'POST', url: '/api/sync/ops', headers: login.headers, payload: { ops: [op] } })).json().results[0].status).toBe('applied');
    await agentOf(p).runOnce();
    expect(p.cloud.app.surau.db.prepare("SELECT origin, op_id FROM change_log WHERE entity = 'content:penceramah'").get()).toMatchObject({ origin: 'app', op_id: op.opId });
    const n = feedCount(p.cloud.app);
    await agentOf(p).runOnce();
    expect(feedCount(p.cloud.app)).toBe(n);
  });

  it('1,000 changes round trip without growth on either side', async () => {
    const p = await makePair();
    const db = p.box.surau.db;
    for (let i = 0; i < 1000; i++) putItem(db, 'penceramah', { id: `x${i}`, name: `Ustaz ${i}` }, 'local');
    await agentOf(p).runOnce();
    expect(count(p.cloud.app, "SELECT COUNT(*) AS n FROM content_items WHERE kind = 'penceramah'")).toBe(1000);
    const c1 = feedCount(p.cloud.app);
    const b1 = feedCount(p.box);
    await agentOf(p).runOnce();
    await agentOf(p).runOnce();
    expect(feedCount(p.cloud.app)).toBe(c1);
    expect(feedCount(p.box)).toBe(b1);
  }, 60_000);

  it('assets travel with the items that reference them: box to cloud and cloud to box, verified by sha256 = id', async () => {
    const p = await makePair();
    const id = putAsset(p.box.surau.db, p.boxDir, PNG, 'image/png', 'local').id;
    putItem(p.box.surau.db, 'penceramah', { id: 'pa', name: 'Dengan gambar', photoAssetId: id }, 'local');
    await agentOf(p).runOnce();
    const onCloud = getAssetPath(p.cloud.app.surau.db, p.cloud.dir, id);
    expect(onCloud).not.toBeNull();
    expect(sha(readFileSync(onCloud!.path))).toBe(id);

    const other = Buffer.from(PNG);
    other[other.length - 20] = (other[other.length - 20] ?? 0) ^ 0x01; // a different file (still a valid PNG header)
    const id2 = putAsset(p.cloud.app.surau.db, p.cloud.dir, other, 'image/png', 'local').id;
    putItem(p.cloud.app.surau.db, 'penceramah', { id: 'pb', name: 'Dari awan', photoAssetId: id2 }, 'local');
    await agentOf(p).runOnce();
    const onBox = getAssetPath(p.box.surau.db, p.boxDir, id2);
    expect(onBox).not.toBeNull();
    expect(sha(readFileSync(onBox!.path))).toBe(id2);
    expect(getItem(p.box.surau.db, 'penceramah', 'pb')).toMatchObject({ photoAssetId: id2 });
  });

  it('finds asset ids inside nested payloads and /assets/<id> paths only', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    expect([...assetIdsIn({ x: [{ y: a }], z: `/assets/${b}`, n: 'c'.repeat(63), q: `/other/${a}` })].sort()).toEqual([a, b]);
  });

  it('a device.revoke done on the cloud reaches the box on the next pull and the device session there is dead', async () => {
    const p = await makePair();
    const victim = await loginAs(p.box, 'ajk');
    // the cloud knows this user and device (it holds the same rows)
    for (const t of ['users', 'devices']) {
      const row = p.box.surau.db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(t === 'users' ? victim.userId : victim.deviceId) as Record<string, unknown>;
      const cols = Object.keys(row);
      p.cloud.app.surau.db.prepare(`INSERT OR REPLACE INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...(Object.values(row) as never[]));
    }
    expect((await p.box.inject({ method: 'GET', url: '/api/auth/me', headers: victim.headers })).statusCode).toBe(200);
    const admin = await loginAs(p.cloud.app, 'admin');
    const op = await signOp(admin, p.boxId, { kind: 'device.revoke', entity: 'device', entityId: victim.deviceId, payload: null, editedAt: new Date().toISOString() });
    expect((await p.cloud.app.inject({ method: 'POST', url: '/api/sync/ops', headers: admin.headers, payload: { ops: [op] } })).json().results[0].status).toBe('applied');
    await agentOf(p).runOnce();
    expect((await p.box.inject({ method: 'GET', url: '/api/auth/me', headers: victim.headers })).statusCode).toBe(401);
  });

  it('a snapshot apply after 410 merges without overwriting a newer box edit', async () => {
    const p = await makePair();
    const t1 = '2026-11-05T08:00:00.000Z';
    const t2 = '2026-11-05T09:00:00.000Z';
    putItem(p.cloud.app.surau.db, 'penceramah', { id: 'p1', name: 'Awan lama' }, 'local', { editedAt: t1 });
    putItem(p.cloud.app.surau.db, 'penceramah', { id: 'p2', name: 'Hanya di awan' }, 'local', { editedAt: t1 });
    putItem(p.box.surau.db, 'penceramah', { id: 'p1', name: 'Kotak baharu' }, 'local', { editedAt: t2 });
    // the box edit was already delivered some other way: only the pull matters here
    const head = Number(p.box.surau.db.prepare('SELECT MAX(id) AS m FROM change_log').get()?.m);
    p.box.surau.db.prepare("INSERT INTO sync_state (key, value) VALUES ('last_push_seq', ?)").run(String(head));
    p.cloud.app.surau.db.prepare("INSERT INTO sync_state (key, value) VALUES ('log_floor', '100000')").run();
    await agentOf(p).runOnce();
    expect(agentOf(p).status().lastError).toBeNull();
    expect(getItem(p.box.surau.db, 'penceramah', 'p1')).toMatchObject({ name: 'Kotak baharu' });
    expect(getItem(p.box.surau.db, 'penceramah', 'p2')).toMatchObject({ name: 'Hanya di awan' });
  });

  it('cloudSync switched off: runOnce touches nothing', async () => {
    const p = await makePair();
    putFeature(p.box.surau.db, 'cloudSync', { enabled: false }, 'local');
    putItem(p.box.surau.db, 'penceramah', { id: 'p1', name: 'A' }, 'local');
    const spy = vi.fn(p.worker.fetch);
    p.hook.fetch = spy as typeof fetch;
    await agentOf(p).runOnce();
    expect(spy).not.toHaveBeenCalled();
    expect(agentOf(p).status().state).toBe('idle');
    expect(count(p.cloud.app, "SELECT COUNT(*) AS n FROM content_items WHERE kind = 'penceramah'")).toBe(0);
  });
});

describe('failure, backoff and the box staying fast', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('5xx flips lastError to http_5xx and backs off 60 s, 2, 5, 15, 15 min; one success resets it to the check interval', async () => {
    const p = await makePair();
    putItem(p.box.surau.db, 'penceramah', { id: 'p1', name: 'A' }, 'local');
    p.hook.fetch = (async () => new Response('boom', { status: 502 })) as typeof fetch;
    const a = agentOf(p);
    a.start();
    const seen: (number | null)[] = [];
    for (let i = 0; i < 5; i++) {
      await a.runOnce();
      expect(a.status()).toMatchObject({ lastError: 'http_5xx', state: 'offline' });
      seen.push(a.nextDelayMs);
    }
    expect(seen).toEqual([60_000, 120_000, 300_000, 900_000, 900_000]);
    expect([...BACKOFF_MS]).toEqual([60_000, 120_000, 300_000, 900_000]);
    p.hook.fetch = p.worker.fetch;
    await a.runOnce();
    expect(a.status()).toMatchObject({ lastError: null, state: 'idle' });
    expect(a.nextDelayMs).toBe(120_000);
    a.stop();
  });

  it('an unreachable cloud, a TLS failure and a 401 are reasons, never bodies', async () => {
    const p = await makePair();
    putItem(p.box.surau.db, 'penceramah', { id: 'p1', name: 'A' }, 'local');
    const a = agentOf(p);
    p.hook.fetch = (async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND secret-host'), { code: 'ENOTFOUND' });
    }) as typeof fetch;
    await a.runOnce();
    expect(a.status().lastError).toBe('unreachable');
    p.hook.fetch = (async () => {
      throw Object.assign(new Error('x'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } });
    }) as typeof fetch;
    await a.runOnce();
    expect(a.status().lastError).toBe('tls');
    p.hook.fetch = (async () => new Response('{"errors":["internal detail"]}', { status: 401 })) as typeof fetch;
    await a.runOnce();
    expect(a.status().lastError).toBe('unauthorised');
  });

  it('while the cloud hangs, the kiosk bundle and the box API still answer fast', async () => {
    const p = await makePair();
    putItem(p.box.surau.db, 'penceramah', { id: 'p1', name: 'A' }, 'local');
    let release: (() => void) | undefined;
    p.hook.fetch = ((_i: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        release = () => reject(new Error('aborted'));
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const running = agentOf(p).runOnce();
    const t0 = Date.now();
    const bundle = await p.box.inject({ method: 'GET', url: '/api/kiosk/bundle' });
    const health = await p.box.inject({ method: 'GET', url: '/api/health' });
    expect(bundle.statusCode).toBe(200);
    expect(health.statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1000);
    release?.();
    await running;
    expect(agentOf(p).status().lastError).toBe('unreachable');
  });
});

describe('wake and dirty flag', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('a 503 waking calls a signed /wake, honours Retry-After and then syncs; nothing reached the cloud before it was up', async () => {
    const p = await makePair({
      onSleep: (_ms, pair) => {
        pair.worker.vm = 'up';
      },
    });
    p.worker.vm = 'down';
    putItem(p.box.surau.db, 'penceramah', { id: 'p1', name: 'A' }, 'local');
    const seenBefore = count(p.cloud.app, "SELECT COUNT(*) AS n FROM content_items WHERE kind = 'penceramah'");
    expect(seenBefore).toBe(0);
    await agentOf(p).runOnce();
    expect(p.worker.wakes).toBe(1);
    expect(p.sleeps).toEqual([60_000]);
    expect(agentOf(p).status()).toMatchObject({ lastError: null, state: 'idle' });
    expect(count(p.cloud.app, "SELECT COUNT(*) AS n FROM content_items WHERE kind = 'penceramah'")).toBe(1);
  });

  it('a cloud that never wakes ends as unreachable after five tries, still offline-normal', async () => {
    const p = await makePair();
    p.worker.vm = 'down';
    putItem(p.box.surau.db, 'penceramah', { id: 'p1', name: 'A' }, 'local');
    await agentOf(p).runOnce();
    expect(agentOf(p).status()).toMatchObject({ lastError: 'unreachable', state: 'offline' });
    expect(p.sleeps.length).toBe(4);
  });

  it('the dirty check is signed, never wakes the VM, and a clean answer does not sync', async () => {
    const p = await makePair();
    p.worker.vm = 'down';
    const a = agentOf(p);
    a.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.worker.dirtyChecks).toBe(1);
    expect(p.worker.wakes).toBe(0);
    expect(a.status().state).toBe('idle');
    expect(a.nextDelayMs).toBe(120_000);
    a.stop();
  });

  it('a raised dirty flag pulls and clears with the head the pull received, not the seq read earlier; a later change stays flagged', async () => {
    const p = await makePair();
    putItem(p.cloud.app.surau.db, 'penceramah', { id: 'c1', name: 'Dari awan' }, 'local');
    const head = Number(p.cloud.app.surau.db.prepare('SELECT MAX(id) AS m FROM change_log').get()?.m);
    // the Worker already saw a later change (head + 5) than the one the pull will deliver
    p.worker.dirty.set(p.boxId, head + 1000);
    const a = agentOf(p);
    a.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(p.worker.clears.length).toBe(1));
    await vi.waitFor(() => expect(a.agentState()).toBe('idle'));
    // the box's own pending setting went up first, so the cloud head moved: the clear carries the head the pull saw
    const cloudHead = Number(p.cloud.app.surau.db.prepare('SELECT MAX(id) AS m FROM change_log').get()?.m);
    expect(p.worker.clears).toEqual([cloudHead]);
    expect(getItem(p.box.surau.db, 'penceramah', 'c1')).toMatchObject({ name: 'Dari awan' });
    expect(p.worker.dirty.get(p.boxId)).toBe(head + 1000);
    // the next check pulls again and, with nothing newer, clears for real
    p.worker.dirty.set(p.boxId, cloudHead);
    await vi.advanceTimersByTimeAsync(125_000);
    await vi.waitFor(() => expect(p.worker.dirty.has(p.boxId)).toBe(false));
    a.stop();
  });

  it('an outbox change is pushed after the 30 s debounce, with no periodic sync before it', async () => {
    const p = await makePair();
    const a = agentOf(p);
    a.start();
    putItem(p.box.surau.db, 'penceramah', { id: 'p1', name: 'A' }, 'local');
    p.box.surau.db.exec('SELECT 1');
    // announce as the version poll would
    (a as unknown as { noteLocalChange: () => void }).noteLocalChange();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(count(p.cloud.app, "SELECT COUNT(*) AS n FROM content_items WHERE kind = 'penceramah'")).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(count(p.cloud.app, "SELECT COUNT(*) AS n FROM content_items WHERE kind = 'penceramah'")).toBe(1));
    a.stop();
  });
});

describe('the site key save', () => {
  it('saveSyncKey replaces the file atomically', async () => {
    const p = await makePair();
    const k = loadSyncKey(p.boxDir)!;
    saveSyncKey(p.boxDir, { ...k, siteName: 'Nama baharu' });
    expect(loadSyncKey(p.boxDir)!.siteName).toBe('Nama baharu');
  });
});

describe('push pages are cut by size (gate 13 item 4)', () => {
  const yearOf = (y: number, n = 365): PrayerDay[] => Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(y, 0, 1 + i)).toISOString().slice(0, 10), hijri: { y: 1448, m: 1, d: 1 },
    times: { imsak: '05:00', subuh: '05:10', syuruk: '06:20', zohor: '13:10', asar: '16:20', maghrib: '19:15', isyak: '20:25' },
  }));
  const pushes = (p: Pair): number[] => {
    const sizes: number[] = [];
    const inner = p.hook.fetch;
    p.hook.fetch = (async (i: Parameters<typeof fetch>[0], n?: RequestInit) => {
      if (String(i).includes('/api/sync/ops') && typeof n?.body === 'string') sizes.push(n.body.length);
      return inner(i, n);
    }) as typeof fetch;
    return sizes;
  };

  it('a page over the limit is split and every entry arrives in order', async () => {
    const p = await makePair({ limits: { push: 150_000 } });
    for (const y of [2026, 2027, 2028]) importDays(p.box.surau.db, 'SGR01', yearOf(y), 'tester');
    const sizes = pushes(p);
    await agentOf(p).runOnce();
    expect(agentOf(p).status()).toMatchObject({ lastError: null, pendingOut: 0 });
    expect(sizes.length).toBeGreaterThanOrEqual(2);
    for (const n of sizes) expect(n).toBeLessThanOrEqual(150_000);
    const got = p.cloud.app.surau.db.prepare("SELECT entity_id FROM change_log WHERE entity = 'prayer:official' ORDER BY id").all().map((r) => String(r.entity_id));
    expect(got).toEqual(['SGR01:2026', 'SGR01:2027', 'SGR01:2028']);
    expect(count(p.cloud.app, 'SELECT COUNT(*) AS n FROM prayer_days')).toBe(365 * 3);
  });

  it('one entry over the limit on its own does not stop the ones after it', async () => {
    const p = await makePair({ limits: { push: 60_000 } });
    importDays(p.box.surau.db, 'SGR01', yearOf(2026), 'tester');
    importDays(p.box.surau.db, 'SGR01', yearOf(2027, 5), 'tester');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await agentOf(p).runOnce();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(agentOf(p).status()).toMatchObject({ lastError: 'refused', pendingOut: 0 });
    const got = p.cloud.app.surau.db.prepare("SELECT entity_id FROM change_log WHERE entity = 'prayer:official' ORDER BY id").all().map((r) => String(r.entity_id));
    expect(got).toEqual(['SGR01:2027']);
    expect(p.box.surau.db.prepare("SELECT value FROM sync_state WHERE key = 'last_refusal'").get()?.value).toContain('entry_too_large');
  });
});

describe('a changes page is cut by size (gate 13 item 4, pull side)', () => {
  it('splits by bytes with next pointing on, and an entry over the cap alone is skipped', async () => {
    const { readFeed } = await import('../src/sync/feed.ts');
    const p = await makePair();
    const db = p.cloud.app.surau.db;
    const ins = db.prepare("INSERT INTO change_log (at, actor, entity, entity_id, after_json, edited_at, rev, origin) VALUES (?, 'x', 'prayer:official', ?, ?, ?, ?, 'local')");
    const at = '2026-11-10T00:00:00.000Z';
    const blob = (n: number): string => JSON.stringify({ pad: 'x'.repeat(n) });
    ins.run(at, 'A:1', blob(3000), at, `${at}|a`);
    ins.run(at, 'B:1', blob(3000), at, `${at}|b`);
    ins.run(at, 'C:1', blob(50_000), at, `${at}|c`); // alone over the cap
    ins.run(at, 'D:1', blob(3000), at, `${at}|d`);
    const scope = { users: true, devices: true };
    const since = Number(db.prepare("SELECT MIN(id) - 1 AS s FROM change_log WHERE entity_id = 'A:1'").get()!.s);
    const ids: string[] = [];
    let cursor = since;
    for (let i = 0; i < 10; i++) {
      const page = readFeed(db, cursor, 500, scope, 4000);
      ids.push(...page.entries.map((e) => e.entityId));
      if (page.next === null) break;
      cursor = page.next;
    }
    expect(ids).toEqual(['A:1', 'B:1', 'D:1']);
    expect(readFeed(db, since, 500, scope, 4000).entries.length).toBe(1);
    expect(readFeed(db, since, 500, scope).entries.map((e) => e.entityId)).toEqual(['A:1', 'B:1', 'C:1', 'D:1']);
  });
});
