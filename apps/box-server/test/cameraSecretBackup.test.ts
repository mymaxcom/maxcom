import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { klInstant } from '@surau/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraStore } from '../src/live/camera.ts';
import { CameraSecretSync } from '../src/sync/cameraSecretBox.ts';
import { generateSyncKeyPair, saveSyncKey } from '../src/sync/syncKey.ts';
import { loginAs } from './authHelpers.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';
import { insertSite } from './support/sites.ts';
import type { TestSite } from './support/sites.ts';

const LAN = '10.168.1.40';
const PASSWORD = 'lihat123Rahsia';
const ADDRESS = `rtsp://viewer:${PASSWORD}@10.168.1.20:554/main`;
const ROUTE = '/api/sync/camera-secret';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) await c();
});

interface Box {
  h: LiveHarness;
  site: TestSite;
  hook: { impl: typeof fetch };
}

interface Rig {
  cloud: TestCloud;
  clock: { t: number; now: () => Date };
  a: Box;
  logs: string[];
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function makeBox(cloud: TestCloud, boxIdOfSite: string): Promise<Box> {
  const hook = { impl: cloud.fetch };
  const h = await startLiveHarness({
    app: { cloud: { url: CLOUD_URL }, sync: { auto: false, fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => hook.impl(i, n)) as typeof fetch } },
  });
  closers.push(h.close);
  const site = insertSite(cloud.app.surau.db, { boxId: boxIdOfSite, surauId: 'sdm' });
  saveSyncKey(h.dataDir, { ...generateSyncKeyPair(), cloudUrl: CLOUD_URL, siteToken: site.token, wakeSecret: 'wake-secret-1', linkedAt: '2026-11-05T00:00:00.000Z' });
  return { h, site, hook };
}

async function rig(): Promise<Rig> {
  const clock = { t: klInstant('2026-11-17', '19:00').getTime(), now: (): Date => new Date(clock.t) };
  const cloud = buildCloud('boxid0001', { now: clock.now });
  closers.push(cloud.close);
  const logs: string[] = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  }
  const a = await makeBox(cloud, 'aaaa000000000001');
  return { cloud, clock, a, logs };
}

const cloudDb = (r: Rig) => r.cloud.app.surau.db;
const rows = (r: Rig): number => Number(cloudDb(r).prepare('SELECT COUNT(*) AS n FROM camera_secrets').get()?.n ?? 0);
const pendingOf = (b: Box): boolean => b.h.app.surau.db.prepare("SELECT 1 AS x FROM sync_state WHERE key = 'camera_secret_pending'").get() !== undefined;

async function saveOnBox(b: Box, payload: object = { url: ADDRESS }) {
  const live = await loginAs(b.h.app, 'live');
  return b.h.app.inject({ method: 'PUT', url: '/api/live/camera', headers: live.headers, remoteAddress: LAN, payload });
}
async function clearOnBox(b: Box) {
  const live = await loginAs(b.h.app, 'live');
  return b.h.app.inject({ method: 'DELETE', url: '/api/live/camera', headers: live.headers, remoteAddress: LAN });
}

/** A site of another surau, called straight at the cloud. */
function otherSurau(r: Rig): TestSite {
  const db = cloudDb(r);
  db.prepare("INSERT OR IGNORE INTO suraus (id, name, created_at, created_by) VALUES ('kolej', 'Kolej', '2026-11-01T00:00:00.000Z', 'test')").run();
  return insertSite(db, { boxId: 'bbbb000000000002', surauId: 'kolej' });
}
const siteCall = (r: Rig, site: TestSite, method: 'GET' | 'PUT' | 'DELETE', payload?: unknown) =>
  r.cloud.app.inject({ method, url: ROUTE, headers: site.headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe('B5 camera address backup', () => {
  it('a saved camera reaches the cloud, and the stored value does not show the address or the password', async () => {
    const r = await rig();
    expect((await saveOnBox(r.a)).statusCode).toBe(200);
    await until(() => rows(r) === 1 && !pendingOf(r.a));

    const text = JSON.stringify(cloudDb(r).prepare('SELECT * FROM camera_secrets').all());
    for (const secret of [PASSWORD, '10.168.1.20', 'viewer', 'rtsp://']) expect(text).not.toContain(secret);
    // the whole database file too (change history, WAL and all)
    cloudDb(r).exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const file = readFileSync(join(r.cloud.dir, 'cloud.db')).toString('latin1');
    expect(file).not.toContain(PASSWORD);
    expect(file).not.toContain('10.168.1.20');
  });

  it('a replaced box of the same surau restores the camera; another surau gets 404 and cannot touch it', async () => {
    const r = await rig();
    await saveOnBox(r.a);
    await until(() => rows(r) === 1);

    // the new box (new box id, same surau) has no camera and asks the cloud
    const b = await makeBox(r.cloud, 'cccc000000000003');
    expect(new CameraStore(b.h.dataDir).get()).toBeNull();
    const sync = new CameraSecretSync({ db: b.h.app.surau.db, dataDir: b.h.dataDir, now: r.clock.now, boxIps: [LAN], fetchImpl: b.hook.impl, auto: false });
    expect(await sync.restore()).toBe('restored');
    expect(new CameraStore(b.h.dataDir).get()).toEqual({ url: ADDRESS });
    // read back through the box API: masked, as always
    const live = await loginAs(b.h.app, 'live');
    const masked = (await b.h.app.inject({ method: 'GET', url: '/api/live/camera', headers: live.headers, remoteAddress: LAN })).json();
    expect(JSON.stringify(masked)).not.toContain(PASSWORD);

    // another surau
    const k = otherSurau(r);
    expect((await siteCall(r, k, 'GET')).statusCode).toBe(404);
    expect((await siteCall(r, k, 'DELETE')).json()).toEqual({ removed: false });
    expect(rows(r)).toBe(1);
    // its own backup is its own, and does not replace sdm's
    expect((await siteCall(r, k, 'PUT', { url: 'rtsp://10.0.0.7:554/live' })).statusCode).toBe(200);
    expect(rows(r)).toBe(2);
    expect((await siteCall(r, k, 'GET')).json()).toEqual({ url: 'rtsp://10.0.0.7:554/live' });
    expect((await siteCall(r, r.a.site, 'GET')).json()).toEqual({ url: ADDRESS });
  });

  it('a record with a separate username and password round-trips', async () => {
    const r = await rig();
    await saveOnBox(r.a, { url: 'rtsp://10.168.1.20:554/main', username: 'viewer', password: PASSWORD });
    await until(() => rows(r) === 1 && !pendingOf(r.a));
    const got = (await siteCall(r, r.a.site, 'GET')).json();
    expect(got).toEqual({ url: 'rtsp://10.168.1.20:554/main', username: 'viewer', password: PASSWORD });
    const b = await makeBox(r.cloud, 'cccc000000000003');
    const sync = new CameraSecretSync({ db: b.h.app.surau.db, dataDir: b.h.dataDir, now: r.clock.now, boxIps: [LAN], fetchImpl: b.hook.impl, auto: false });
    expect(await sync.restore()).toBe('restored');
    expect(new CameraStore(b.h.dataDir).get()).toEqual({ url: 'rtsp://10.168.1.20:554/main', username: 'viewer', password: PASSWORD });
  });

  it('clearing the camera on the box removes it from the cloud, and a restore then finds nothing', async () => {
    const r = await rig();
    await saveOnBox(r.a);
    await until(() => rows(r) === 1);
    expect((await clearOnBox(r.a)).statusCode).toBe(200);
    await until(() => rows(r) === 0 && !pendingOf(r.a));
    const b = await makeBox(r.cloud, 'cccc000000000003');
    const sync = new CameraSecretSync({ db: b.h.app.surau.db, dataDir: b.h.dataDir, now: r.clock.now, boxIps: [LAN], fetchImpl: b.hook.impl, auto: false });
    expect(await sync.restore()).toBe('none');
    expect(new CameraStore(b.h.dataDir).get()).toBeNull();
  });

  it('an unreachable cloud leaves a pending mark; no restore while it is set (a cleared camera is not resurrected); the next round delivers', async () => {
    const r = await rig();
    await saveOnBox(r.a);
    await until(() => rows(r) === 1 && !pendingOf(r.a));
    r.a.hook.impl = (async () => {
      throw new Error('down');
    }) as typeof fetch;
    await clearOnBox(r.a);
    await until(() => pendingOf(r.a));
    expect(rows(r)).toBe(1);

    const sync = new CameraSecretSync({ db: r.a.h.app.surau.db, dataDir: r.a.h.dataDir, now: r.clock.now, boxIps: [LAN], fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => r.a.hook.impl(i, n)) as typeof fetch, auto: false });
    expect(await sync.restore()).toBe('skipped');
    expect(new CameraStore(r.a.h.dataDir).get()).toBeNull();

    r.a.hook.impl = r.cloud.fetch;
    await sync.tick();
    expect(rows(r)).toBe(0);
    expect(pendingOf(r.a)).toBe(false);
  });

  it('a box with a camera of its own is not overwritten by a restore, and pushes it once after start', async () => {
    const r = await rig();
    new CameraStore(r.a.h.dataDir, { boxIps: [LAN] }).save({ url: ADDRESS });
    const sync = new CameraSecretSync({ db: r.a.h.app.surau.db, dataDir: r.a.h.dataDir, now: r.clock.now, boxIps: [LAN], fetchImpl: r.a.hook.impl, auto: false });
    expect(await sync.restore()).toBe('skipped');
    await sync.tick();
    expect(rows(r)).toBe(1);
    expect((await siteCall(r, r.a.site, 'GET')).json()).toEqual({ url: ADDRESS });
  });

  it('only the linked site may use the routes: a person, no session and a box get 404 or 401', async () => {
    const r = await rig();
    const admin = await loginAs(r.cloud.app, 'admin');
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const res = await r.cloud.app.inject({ method, url: ROUTE, headers: admin.headers, ...(method === 'PUT' ? { payload: { url: ADDRESS } } : {}) });
      expect(res.statusCode, `admin ${method}`).toBe(404);
      const anon = await r.cloud.app.inject({ method, url: ROUTE, ...(method === 'PUT' ? { payload: { url: ADDRESS } } : {}) });
      expect([401, 403], `anon ${method}`).toContain(anon.statusCode);
    }
    expect(rows(r)).toBe(0);
    // on a box the routes do not exist
    const live = await loginAs(r.a.h.app, 'admin');
    expect((await r.a.h.app.inject({ method: 'GET', url: ROUTE, headers: live.headers })).statusCode).toBe(404);
  });

  it('size and shape limits, and a rate limit per site', async () => {
    const r = await rig();
    const bad: unknown[] = [
      null,
      [],
      {},
      { url: 'http://10.168.1.20/x' },
      { url: 'rtsp://8.8.8.8:554/x' },
      { url: 'rtsp://127.0.0.1/x' },
      { url: `rtsp://10.168.1.20/${'a'.repeat(500)}` },
      { url: ADDRESS, extra: 'x' },
      { url: ADDRESS, password: 'p'.repeat(129) },
      { url: ADDRESS, username: 'u\nx' },
      { url: ADDRESS, password: 5 },
    ];
    for (const b of bad) {
      const res = await r.cloud.app.inject({ method: 'PUT', url: ROUTE, headers: r.a.site.headers, ...(b === null ? {} : { payload: b as object }) });
      expect(res.statusCode, JSON.stringify(b)?.slice(0, 60)).toBe(400);
    }
    expect(rows(r)).toBe(0);
    let last = 0;
    for (let i = 0; i < 14; i++) last = (await siteCall(r, r.a.site, 'PUT', { url: ADDRESS })).statusCode;
    expect(last).toBe(429);
    const limited = await siteCall(r, r.a.site, 'PUT', { url: ADDRESS });
    expect(limited.headers['retry-after']).toBeDefined();
    // another site has its own allowance
    expect((await siteCall(r, otherSurau(r), 'PUT', { url: 'rtsp://10.0.0.7/x' })).statusCode).toBe(200);
  });

  it('a stored row moved to another surau does not open', async () => {
    const r = await rig();
    await siteCall(r, r.a.site, 'PUT', { url: ADDRESS });
    const k = otherSurau(r);
    const row = cloudDb(r).prepare("SELECT sealed FROM camera_secrets WHERE surau_id = 'sdm'").get()!;
    cloudDb(r).prepare("INSERT INTO camera_secrets (surau_id, sealed, box_id, updated_at) VALUES ('kolej', ?, 'x', 'x')").run(String(row.sealed));
    expect((await siteCall(r, k, 'GET')).statusCode).toBe(404);
  });

  it('the login is in no log, no change history and no answer other than the sealed GET', async () => {
    const r = await rig();
    const res = await saveOnBox(r.a);
    expect(JSON.stringify(res.json())).not.toContain(PASSWORD);
    await until(() => rows(r) === 1 && !pendingOf(r.a));
    await clearOnBox(r.a);
    await until(() => rows(r) === 0);
    const history = (db: ReturnType<typeof cloudDb>): string => JSON.stringify([db.prepare('SELECT * FROM change_log').all(), db.prepare('SELECT * FROM auth_log').all(), db.prepare('SELECT * FROM sync_state').all()]);
    // the box's own history keeps the masked address (as before this task); the cloud's and the logs keep nothing
    for (const text of [history(cloudDb(r)), history(r.a.h.app.surau.db), r.logs.join('\n')]) expect(text).not.toContain(PASSWORD);
    for (const text of [history(cloudDb(r)), r.logs.join('\n')]) expect(text).not.toContain('10.168.1.20');
    // the cloud's history says that a backup was stored and removed, by which box
    const events = cloudDb(r).prepare("SELECT actor, entity_id, after_json FROM change_log WHERE entity = 'live-camera/cloud-backup' ORDER BY id").all();
    expect(events.map((e) => e.entity_id)).toEqual(['put', 'delete']);
    expect(events[0]!.actor).toBe('site:aaaa000000000001');
  });
});
