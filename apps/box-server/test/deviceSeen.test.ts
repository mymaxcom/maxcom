import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { peopleActivity } from '../src/auth/activity.ts';
import { createUser } from '../src/auth/users.ts';
import { runCloudLink } from '../src/cli/cloudLink.ts';
import { mergeDeviceSeen } from '../src/sync/deviceSeen.ts';
import { issueLinkCode } from '../src/sync/sites.ts';
import { loadSyncKey } from '../src/sync/syncKey.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { loginAs } from './authHelpers.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';
import { insertSite } from './support/sites.ts';
import { ensureSurau } from './support/surauRow.ts';

const clouds: TestCloud[] = [];
const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const c of clouds.splice(0)) await c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = new Date('2026-11-18T08:00:00.000Z');
const ago = (days: number, from: Date = NOW): string => new Date(from.getTime() - days * 86_400_000).toISOString();

function makeCloud(boxId = 'ab'.repeat(8)): TestCloud {
  const c = buildCloud(boxId);
  clouds.push(c);
  ensureSurau(c.app.surau.db, 'sdm');
  ensureSurau(c.app.surau.db, 'surau-lain', 'Surau Lain Contoh');
  return c;
}
const setSeen = (db: DatabaseSync, id: string, at: string | null): void => void db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(at, id);
const seenOf = (db: DatabaseSync, id: string): unknown => db.prepare('SELECT last_seen_at FROM devices WHERE id = ?').get(id)?.last_seen_at;
const call = (c: TestCloud, headers: Record<string, string>) => c.app.inject({ method: 'GET', url: '/api/sync/device-seen', headers });

describe('[PP-S7] GET /api/sync/device-seen on the cloud', () => {
  it('[PP-S7] lists only the site surau, only live non-TV devices with a time, never a Pentadbir MAXCOM device', async () => {
    const c = makeCloud();
    const db = c.app.surau.db;
    const mine = await loginAs(c.app, 'ajk');
    const idle = await loginAs(c.app, 'treasurer');
    const gone = await loginAs(c.app, 'media');
    const other = await loginAs(c.app, 'ajk', undefined, 'surau-lain');
    const star = await loginAs(c.app, 'superadmin');
    const admin = await loginAs(c.app, 'admin');
    setSeen(db, mine.deviceId, ago(2));
    setSeen(db, other.deviceId, ago(2));
    setSeen(db, star.deviceId, ago(2));
    setSeen(db, gone.deviceId, ago(2));
    setSeen(db, admin.deviceId, ago(1));
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(ago(1), gone.deviceId);
    setSeen(db, idle.deviceId, null);
    const tv = db.prepare("UPDATE devices SET platform = 'kiosk' WHERE id = ?");
    const site = insertSite(db, { boxId: 'cd'.repeat(8), surauId: 'sdm' });
    const r = await call(c, site.headers);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const ids = (r.json().seen as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(mine.deviceId);
    expect(ids).toContain(admin.deviceId);
    for (const x of [other.deviceId, star.deviceId, gone.deviceId, idle.deviceId]) expect(ids, x).not.toContain(x);
    expect(r.json().seen.find((s: { id: string }) => s.id === mine.deviceId).lastSeenAt).toBe(ago(2));
    tv.run(mine.deviceId);
    expect(((await call(c, site.headers)).json().seen as Array<{ id: string }>).map((s) => s.id)).not.toContain(mine.deviceId);
    // the other surau's site sees its own device only
    const siteB = insertSite(db, { boxId: 'ee'.repeat(8), surauId: 'surau-lain' });
    expect(((await call(c, siteB.headers)).json().seen as Array<{ id: string }>).map((s) => s.id)).toEqual([other.deviceId]);
  });

  it('[PP-S7] a user session gets 404 (not a site), no token 401, a box has no such route (404)', async () => {
    const c = makeCloud();
    const admin = await loginAs(c.app, 'admin');
    expect((await call(c, admin.headers)).statusCode).toBe(404);
    expect((await c.app.inject({ method: 'GET', url: '/api/sync/device-seen', remoteAddress: '10.4.4.4' })).statusCode).toBe(401);
    const dir = mkdtempSync(join(tmpdir(), 'surau-s7-'));
    dirs.push(dir);
    const box = buildApp(join(dir, 'b.db'), { dataDir: dir });
    apps.push(box);
    const onBox = await loginAs(box, 'admin');
    expect((await box.inject({ method: 'GET', url: '/api/sync/device-seen', headers: onBox.headers })).statusCode).toBe(404);
  });

  it('[PP-S7] the answer carries the highest box-series numbers and the box role', async () => {
    const c = makeCloud();
    const db = c.app.surau.db;
    const u = createUser(db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', 'sdm');
    const v = createUser(db, { name: 'Haji Osman', roles: ['ajk'] }, 'test', 'sdm');
    db.prepare("UPDATE users SET no = 7, no_src = 'b' WHERE id = ?").run(u.id);
    db.prepare("UPDATE users SET no = 9, no_src = 'c' WHERE id = ?").run(v.id);
    const a = await loginAs(c.app, 'ajk');
    db.prepare("UPDATE devices SET no = 3, no_src = 'b' WHERE id = ?").run(a.deviceId);
    const site = insertSite(db, { boxId: 'cd'.repeat(8), surauId: 'sdm' });
    expect((await call(c, site.headers)).json()).toMatchObject({ maxNo: { user: 7, device: 3 }, role: 'primary' });
    db.prepare("UPDATE sites SET role = 'secondary' WHERE box_id = ?").run(site.boxId);
    expect((await call(c, site.headers)).json().role).toBe('secondary');
    const empty = insertSite(db, { boxId: 'ef'.repeat(8), surauId: 'surau-lain' });
    expect((await call(c, empty.headers)).json().maxNo).toEqual({ user: 0, device: 0 });
  });
});

describe('[PP-S7] mergeDeviceSeen on the box', () => {
  function box(): FastifyInstance {
    const dir = mkdtempSync(join(tmpdir(), 'surau-s7b-'));
    dirs.push(dir);
    const app = buildApp(join(dir, 'b.db'), { dataDir: dir });
    apps.push(app);
    return app;
  }

  it('[PP-S7] moves last_seen_at forward only, never backward, and writes no log row or version', async () => {
    const app = box();
    const a = await loginAs(app, 'ajk');
    const db = app.surau.db;
    setSeen(db, a.deviceId, ago(30));
    const log = Number(db.prepare('SELECT COUNT(*) AS n FROM change_log').get()?.n);
    const ver = db.prepare("SELECT value FROM sync_state WHERE key = 'version'").get();
    expect(mergeDeviceSeen(db, [{ id: a.deviceId, lastSeenAt: ago(2) }], NOW)).toBe(1);
    expect(seenOf(db, a.deviceId)).toBe(ago(2));
    expect(mergeDeviceSeen(db, [{ id: a.deviceId, lastSeenAt: ago(20) }], NOW)).toBe(0);
    expect(seenOf(db, a.deviceId)).toBe(ago(2));
    expect(mergeDeviceSeen(db, [{ id: a.deviceId, lastSeenAt: ago(2) }], NOW)).toBe(0);
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM change_log').get()?.n)).toBe(log);
    expect(db.prepare("SELECT value FROM sync_state WHERE key = 'version'").get()).toEqual(ver);
  });

  it('[PP-S7] a never-seen phone takes the time; a revoked device and a TV never do', async () => {
    const app = box();
    const a = await loginAs(app, 'ajk');
    const gone = await loginAs(app, 'treasurer');
    const tv = await loginAs(app, 'media');
    const db = app.surau.db;
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(ago(1), gone.deviceId);
    db.prepare("UPDATE devices SET platform = 'kiosk' WHERE id = ?").run(tv.deviceId);
    for (const id of [a.deviceId, gone.deviceId, tv.deviceId]) setSeen(db, id, null);
    expect(mergeDeviceSeen(db, [a, gone, tv].map((l) => ({ id: l.deviceId, lastSeenAt: ago(1) })), NOW)).toBe(1);
    expect(seenOf(db, a.deviceId)).toBe(ago(1));
    expect(seenOf(db, gone.deviceId)).toBeNull();
    expect(seenOf(db, tv.deviceId)).toBeNull();
  });

  it('[PP-S7] a time far in the future, a malformed row and an unknown id change nothing', async () => {
    const app = box();
    const a = await loginAs(app, 'ajk');
    const db = app.surau.db;
    setSeen(db, a.deviceId, ago(10));
    const bad: unknown[] = [
      { id: a.deviceId, lastSeenAt: new Date(NOW.getTime() + 6 * 60_000).toISOString() },
      { id: a.deviceId, lastSeenAt: 'yesterday' },
      { id: a.deviceId, lastSeenAt: 12345 },
      { id: a.deviceId },
      { id: 7, lastSeenAt: ago(1) },
      { id: "x' OR 1=1 --", lastSeenAt: ago(1) },
      { id: 'no-such-device', lastSeenAt: ago(1) },
      null,
      'text',
    ];
    expect(mergeDeviceSeen(db, bad, NOW)).toBe(0);
    expect(mergeDeviceSeen(db, 'nope', NOW)).toBe(0);
    expect(mergeDeviceSeen(db, { id: a.deviceId }, NOW)).toBe(0);
    expect(seenOf(db, a.deviceId)).toBe(ago(10));
    // 4 minutes ahead is clock slack and is taken
    expect(mergeDeviceSeen(db, [{ id: a.deviceId, lastSeenAt: new Date(NOW.getTime() + 4 * 60_000).toISOString() }], NOW)).toBe(1);
  });

  it('[PP-S7] after the merge peopleActivity no longer flags a phone used only through the cloud', async () => {
    const app = box();
    const a = await loginAs(app, 'ajk');
    const db = app.surau.db;
    setSeen(db, a.deviceId, ago(100));
    expect(peopleActivity(db, LOCAL_SURAU_ID, NOW, 'box', false).devices.find((d) => d.id === a.deviceId)?.inactive).toBe(true);
    expect(peopleActivity(db, LOCAL_SURAU_ID, NOW, 'box', false).users.find((u) => u.id === a.userId)?.suggestDeactivate).toBe(true);
    mergeDeviceSeen(db, [{ id: a.deviceId, lastSeenAt: ago(3) }], NOW);
    const after = peopleActivity(db, LOCAL_SURAU_ID, NOW, 'box', false);
    expect(after.devices.find((d) => d.id === a.deviceId)).toMatchObject({ inactive: false, idleDays: 3 });
    expect(after.users.find((u) => u.id === a.userId)?.suggestDeactivate).toBe(false);
  });
});

describe('[PP-S7] the box agent asks once an hour and survives a failure', () => {
  interface Pair { box: FastifyInstance; cloud: TestCloud; calls: string[]; mode: { fetch: 'ok' | '404' | 'down' } }
  async function pair(): Promise<Pair> {
    const dir = mkdtempSync(join(tmpdir(), 'surau-s7a-'));
    dirs.push(dir);
    const calls: string[] = [];
    const mode: Pair['mode'] = { fetch: 'ok' };
    let worker!: FakeWorker;
    const box = buildApp(join(dir, 'box.db'), {
      dataDir: dir,
      sync: {
        fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => {
          const url = String(i);
          if (url.endsWith('/api/sync/device-seen')) {
            calls.push(url);
            if (mode.fetch === 'down') return Promise.reject(new TypeError('network down'));
            if (mode.fetch === '404') return Promise.resolve(new Response('{}', { status: 404 }));
          }
          return worker.fetch(i, n);
        }) as typeof fetch,
        sleep: async () => undefined,
      },
    });
    apps.push(box);
    const cloud = buildCloud(box.surau.boxId);
    clouds.push(cloud);
    worker = new FakeWorker(cloud.fetch);
    const { code } = issueLinkCode({ db: cloud.app.surau.db, now: () => new Date() }, { boxId: box.surau.boxId, name: 'Surau Perintis Contoh', target: { surauId: ensureSurau(cloud.app.surau.db) } });
    const lines: string[] = [];
    expect(await runCloudLink(['--data', dir, '--db', join(dir, 'box.db'), 'link', CLOUD_URL, code], { out: (l) => lines.push(l), err: (l) => lines.push(l) }, worker.fetch), lines.join('\n')).toBe(0);
    worker.setSecret(box.surau.boxId, loadSyncKey(dir)!.wakeSecret);
    return { box, cloud, calls, mode };
  }
  const state = (db: DatabaseSync, key: string): string | undefined => {
    const r = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
    return r === undefined ? undefined : String(r.value);
  };

  it('[PP-S7] a phone used through the cloud is merged into the box, at most once an hour', async () => {
    const p = await pair();
    // the same phone on both sides: the cloud saw it today, the box not for 100 days
    const u = createUser(p.box.surau.db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', 'sdm');
    const row = { id: 'dev-s7-phone', name: 'Telefon Kak Siti', platform: 'android', enrolled: ago(200, new Date()) };
    p.box.surau.db.prepare('INSERT INTO devices (id, user_id, name, platform, enrolled_at, last_seen_at, surau_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.id, u.id, row.name, row.platform, row.enrolled, ago(100, new Date()), 'sdm');
    const cu = createUser(p.cloud.app.surau.db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', 'sdm');
    const seenToday = new Date(Date.now() - 3600_000).toISOString();
    p.cloud.app.surau.db.prepare('INSERT INTO devices (id, user_id, name, platform, enrolled_at, last_seen_at, surau_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.id, cu.id, row.name, row.platform, row.enrolled, seenToday, 'sdm');

    await p.box.syncAgent!.runOnce();
    expect(p.calls.length).toBe(1);
    expect(seenOf(p.box.surau.db, row.id)).toBe(seenToday);
    expect(state(p.box.surau.db, 'device_seen_at')).toBeDefined();
    await p.box.syncAgent!.runOnce();
    await p.box.syncAgent!.runOnce();
    expect(p.calls.length).toBe(1);
    // an hour and a bit later it asks again
    p.box.surau.db.prepare("UPDATE sync_state SET value = ? WHERE key = 'device_seen_try_at'").run(new Date(Date.now() - 61 * 60_000).toISOString());
    await p.box.syncAgent!.runOnce();
    expect(p.calls.length).toBe(2);
  });

  it('[PP-S7] an older cloud (404) and a network error do not break the round and do not stamp device_seen_at', async () => {
    const p = await pair();
    p.mode.fetch = '404';
    await p.box.syncAgent!.runOnce();
    expect(p.box.syncAgent!.status()).toMatchObject({ lastError: null, state: 'idle' });
    expect(state(p.box.surau.db, 'device_seen_at')).toBeUndefined();
    p.box.surau.db.prepare("UPDATE sync_state SET value = ? WHERE key = 'device_seen_try_at'").run(new Date(Date.now() - 2 * 3600_000).toISOString());
    p.mode.fetch = 'down';
    await p.box.syncAgent!.runOnce();
    expect(p.calls.length).toBe(2);
    expect(state(p.box.surau.db, 'device_seen_at')).toBeUndefined();
    expect(p.box.syncAgent!.status().lastError).toBeNull();
  });
});
