import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeedEntry } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { autoCleanPeople, cloudSeenFresh } from '../src/auth/activity.ts';
import { activateUser, deactivateUser, restoreUser } from '../src/auth/users.ts';
import { applyFeedEntry } from '../src/sync/apply.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { loginAs } from './authHelpers.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp(opts: Parameters<typeof buildApp>[1] = {}): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-clean-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir, ...opts });
  apps.push(app);
  return app;
}

const NOW = new Date('2026-11-18T08:00:00.000Z');
const DAY = 86_400_000;
const ago = (n: number, from: Date = NOW): string => new Date(from.getTime() - n * DAY).toISOString();
const seen = (db: DatabaseSync, id: string, at: string | null, enrolled = ago(500)): void =>
  void db.prepare('UPDATE devices SET last_seen_at = ?, enrolled_at = ? WHERE id = ?').run(at, enrolled, id);
const revoked = (db: DatabaseSync, id: string): boolean => db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(id)?.revoked_at !== null;
/** Forget the clean-up's safety memory and record activity at `at`, so a test that moves the clock is a normal day. */
const normalDay = (db: DatabaseSync, at: Date): void => {
  db.prepare("DELETE FROM sync_state WHERE key IN ('clean_last_run_at', 'clean_grace_until')").run();
  db.prepare("INSERT INTO auth_log (at, event, ok) VALUES (?, 'test_activity', 1)").run(at.toISOString());
};
/** Like normalDay but leaves the grace key, so a test can watch the grace run out. */
const normalDayKeepGrace = (db: DatabaseSync, at: Date): void => {
  db.prepare("DELETE FROM sync_state WHERE key = 'clean_last_run_at'").run();
  db.prepare("INSERT INTO auth_log (at, event, ok) VALUES (?, 'test_activity', 1)").run(at.toISOString());
};
const urow = (db: DatabaseSync, id: string): Record<string, unknown> => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown>;
const off = (db: DatabaseSync, id: string, at: string): void => void db.prepare('UPDATE users SET active = 0, deactivated_at = ? WHERE id = ?').run(at, id);

describe('[PP-S9] automatic clean-up of devices', () => {
  it('[PP-S9] a phone idle 179 days stays, 180 goes with actor system and its own change row; a TV is never auto-revoked', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'admin');
    const stay = await loginAs(app, 'ajk');
    const go = await loginAs(app, 'treasurer');
    const db = app.surau.db;
    const b = (await app.inject({ method: 'POST', url: '/api/kiosk/pair/begin', remoteAddress: '10.168.1.77' })).json() as { code: string };
    const tv = String((await app.inject({ method: 'POST', url: '/api/kiosk/pair/approve', remoteAddress: '10.9.9.9', headers: a.headers, payload: { code: b.code, deviceName: 'TV surau' } })).json().deviceId);
    seen(db, a.deviceId, ago(1));
    seen(db, stay.deviceId, ago(179));
    seen(db, go.deviceId, ago(180));
    seen(db, tv, ago(180));
    const out = autoCleanPeople(db, NOW, 'box', true);
    expect(out.devices).toEqual([go.deviceId]);
    expect(revoked(db, stay.deviceId)).toBe(false);
    expect(revoked(db, go.deviceId)).toBe(true);
    expect(revoked(db, tv)).toBe(false);
    const log = db.prepare("SELECT actor FROM change_log WHERE entity = 'devices' AND entity_id = ? AND after_json LIKE '%\"revoked\":true%'").get(go.deviceId);
    expect(log?.actor).toBe('system');
    // never enrolled-and-seen: counted from the enrolment date
    seen(db, stay.deviceId, null, ago(180));
    expect(autoCleanPeople(db, NOW, 'box', true).devices).toEqual([stay.deviceId]);
  });

  it('[PP-S9] the last Pentadbir phone idle 400 days stays', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'admin');
    const db = app.surau.db;
    seen(db, a.deviceId, ago(400));
    expect(autoCleanPeople(db, NOW, 'box', true).devices).toEqual([]);
    expect(revoked(db, a.deviceId)).toBe(false);
    // with a second Pentadbir phone the idle one may go
    const b = await loginAs(app, 'admin');
    seen(db, b.deviceId, ago(1));
    expect(autoCleanPeople(db, NOW, 'box', true).devices).toEqual([a.deviceId]);
  });

  it('[PP-S9] a linked box with no fresh cloud-seen deletes no device; the cloud does nothing at all', async () => {
    const app = makeApp();
    await loginAs(app, 'admin');
    const stale = await loginAs(app, 'ajk');
    const db = app.surau.db;
    seen(db, stale.deviceId, ago(400));
    db.prepare("INSERT INTO sync_state (key, value) VALUES ('linked', '1')").run();
    expect(cloudSeenFresh(db, NOW)).toBe(false);
    expect(autoCleanPeople(db, NOW, 'box', cloudSeenFresh(db, NOW)).devices).toEqual([]);
    db.prepare("INSERT INTO sync_state (key, value) VALUES ('device_seen_at', ?)").run(ago(8));
    expect(cloudSeenFresh(db, NOW)).toBe(false);
    db.prepare("UPDATE sync_state SET value = ? WHERE key = 'device_seen_at'").run(ago(6));
    expect(cloudSeenFresh(db, NOW)).toBe(true);
    expect(autoCleanPeople(db, NOW, 'box', cloudSeenFresh(db, NOW)).devices).toEqual([stale.deviceId]);
    const cloud = makeApp({ role: 'cloud' });
    const c = await loginAs(cloud, 'ajk');
    seen(cloud.surau.db, c.deviceId, ago(900));
    off(cloud.surau.db, c.userId, ago(900));
    expect(autoCleanPeople(cloud.surau.db, NOW, 'cloud', true)).toEqual({ devices: [], users: [] });
    expect(revoked(cloud.surau.db, c.deviceId)).toBe(false);
  });
});

describe('[PP-S9] automatic clean-up of long-deactivated people', () => {
  it('[PP-S9] deactivated 364 days stays, 365 is soft-deleted by system; an active person with no device for two years is untouched', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'admin');
    const x = await loginAs(app, 'ajk');
    const y = await loginAs(app, 'treasurer');
    const idle = await loginAs(app, 'media');
    const db = app.surau.db;
    seen(db, idle.deviceId, ago(800)); // only its phone is old: devices go, the active person stays
    deactivateUser(db, x.userId, 'test');
    deactivateUser(db, y.userId, 'test');
    off(db, x.userId, ago(364));
    off(db, y.userId, ago(365));
    seen(db, a.deviceId, ago(1));
    const out = autoCleanPeople(db, NOW, 'box', true);
    expect(out.users).toEqual([y.userId]);
    expect(urow(db, y.userId).deleted_at).toBe(NOW.toISOString());
    expect(urow(db, y.userId).deleted_by).toBe('system');
    expect(urow(db, x.userId).deleted_at).toBeNull();
    expect(urow(db, idle.userId)).toMatchObject({ active: 1, deleted_at: null });
    expect(urow(db, a.userId)).toMatchObject({ active: 1, deleted_at: null });
    // a person with no deactivation time is skipped
    db.prepare('UPDATE users SET deactivated_at = NULL WHERE id = ?').run(x.userId);
    normalDay(db, new Date(NOW.getTime() + 900 * DAY));
    expect(autoCleanPeople(db, new Date(NOW.getTime() + 900 * DAY), 'box', true).users).toEqual([]);
  });

  it('[PP-S9c] deactivated 400 days ago, auto-deleted, then restored: not deleted again by the next run nor 364 days later, deleted 365 days after the restore', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'admin');
    const x = await loginAs(app, 'ajk');
    const db = app.surau.db;
    seen(db, a.deviceId, ago(1));
    deactivateUser(db, x.userId, 'test');
    off(db, x.userId, ago(400));
    expect(autoCleanPeople(db, NOW, 'box', true).users).toEqual([x.userId]);
    restoreUser(db, x.userId, `user:${a.userId}`);
    const restoredAt = Date.parse(String(urow(db, x.userId).deactivated_at));
    expect(urow(db, x.userId)).toMatchObject({ deleted_at: null, active: 0 });
    const at = (days: number): Date => new Date(restoredAt + days * DAY);
    normalDay(db, at(0));
    expect(autoCleanPeople(db, new Date(restoredAt + 3_600_000), 'box', true).users).toEqual([]);
    normalDay(db, at(364));
    expect(autoCleanPeople(db, at(364), 'box', true).users).toEqual([]);
    expect(urow(db, x.userId).deleted_at).toBeNull();
    normalDay(db, at(365));
    expect(autoCleanPeople(db, at(365), 'box', true).users).toEqual([x.userId]);
  });

  it('[PP-S9c] deactivated 400 days ago, activated, deactivated today: not deleted (the old date is gone)', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'admin');
    const x = await loginAs(app, 'ajk');
    const db = app.surau.db;
    seen(db, a.deviceId, ago(1));
    deactivateUser(db, x.userId, 'test');
    off(db, x.userId, ago(400));
    activateUser(db, x.userId, 'test');
    expect(urow(db, x.userId).deactivated_at).toBeNull();
    expect(autoCleanPeople(db, NOW, 'box', true).users).toEqual([]);
    deactivateUser(db, x.userId, 'test');
    expect(Date.parse(String(urow(db, x.userId).deactivated_at))).toBeGreaterThan(Date.now() - 60_000);
    expect(autoCleanPeople(db, new Date(), 'box', true).users).toEqual([]);
    normalDay(db, new Date(Date.now() + 364 * DAY));
    expect(autoCleanPeople(db, new Date(Date.now() + 364 * DAY), 'box', true).users).toEqual([]);
  });

  it('[PP-S9c] a restore or an activation that arrives by sync resets the date the same way', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'admin');
    const x = await loginAs(app, 'ajk');
    const y = await loginAs(app, 'treasurer');
    const db = app.surau.db;
    seen(db, a.deviceId, ago(1));
    const name = (id: string): string => String(urow(db, id).name);
    const entry = (id: string, after: Record<string, unknown>, ms: number): FeedEntry => {
      const at = new Date(Date.now() + ms).toISOString();
      return { seq: 1, entity: 'user', entityId: id, rev: `${at}|dev-x`, editedAt: at, syncedAt: at, actor: 'user:x', deviceId: null, origin: 'local', opId: null, after };
    };
    const ctx = { surauId: LOCAL_SURAU_ID, now: new Date(Date.now() + 3600_000), origin: 'box:b1', actor: 'user:x', dataDir: tmpdir() };
    // x: deleted long ago, restored by sync
    deactivateUser(db, x.userId, 'test');
    off(db, x.userId, ago(400));
    autoCleanPeople(db, NOW, 'box', true);
    expect(urow(db, x.userId).deleted_at).not.toBeNull();
    expect(applyFeedEntry(db, entry(x.userId, { id: x.userId, name: name(x.userId), roles: ['ajk'], active: false, deleted: false }, 10_000), ctx).status).toBe('applied');
    expect(autoCleanPeople(db, new Date(Date.now() + 3_600_000), 'box', true).users).toEqual([]);
    // y: deactivated long ago, activated by sync, then deactivated by sync today
    deactivateUser(db, y.userId, 'test');
    off(db, y.userId, ago(400));
    expect(applyFeedEntry(db, entry(y.userId, { id: y.userId, name: name(y.userId), roles: ['treasurer'], active: true }, 20_000), ctx).status).toBe('applied');
    expect(urow(db, y.userId).deactivated_at).toBeNull();
    expect(applyFeedEntry(db, entry(y.userId, { id: y.userId, name: name(y.userId), roles: ['treasurer'], active: false }, 30_000), ctx).status).toBe('applied');
    expect(autoCleanPeople(db, new Date(Date.now() + 3_600_000), 'box', true).users).toEqual([]);
  });
});

describe('[G-S1] the automatic clean-up never acts on a stale or odd clock', () => {
  async function fleet(app: FastifyInstance, idleDays: number): Promise<{ db: DatabaseSync; idle: string; ok: string }> {
    const a = await loginAs(app, 'admin');
    const b = await loginAs(app, 'admin');
    const idle = await loginAs(app, 'ajk');
    const db = app.surau.db;
    seen(db, a.deviceId, ago(1));
    seen(db, b.deviceId, ago(1));
    seen(db, idle.deviceId, ago(idleDays));
    return { db, idle: idle.deviceId, ok: a.deviceId };
  }

  it('[G-S1] a box that was off for 200 days revokes nothing on its first run and starts a 30 day grace', async () => {
    const app = makeApp();
    const { db, idle } = await fleet(app, 400);
    db.prepare("INSERT INTO sync_state (key, value) VALUES ('clean_last_run_at', ?)").run(ago(200));
    expect(autoCleanPeople(db, NOW, 'box', true).devices).toEqual([]);
    expect(revoked(db, idle)).toBe(false);
    expect(db.prepare("SELECT value FROM sync_state WHERE key = 'clean_grace_until'").get()?.value).toBe(new Date(NOW.getTime() + 30 * DAY).toISOString());
    // inside the grace the daily runs still revoke nothing, and a run after it does
    const day2 = new Date(NOW.getTime() + DAY);
    normalDayKeepGrace(db, day2);
    expect(autoCleanPeople(db, day2, 'box', true).devices).toEqual([]);
    const after = new Date(NOW.getTime() + 31 * DAY);
    for (let d = 2; d <= 31; d++) {
      const t = new Date(NOW.getTime() + d * DAY);
      normalDayKeepGrace(db, t);
      autoCleanPeople(db, t, 'box', true);
    }
    expect(revoked(db, idle)).toBe(true);
    expect(after.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('[G-S1] a clock that jumps forward, or runs backwards, revokes nothing', async () => {
    const app = makeApp();
    const { db, idle } = await fleet(app, 181);
    const later = new Date(Date.now() + 100 * DAY);
    expect(autoCleanPeople(db, later, 'box', true).devices).toEqual([]);
    expect(revoked(db, idle)).toBe(false);
    const app2 = makeApp();
    const f = await fleet(app2, 181);
    f.db.prepare("INSERT INTO sync_state (key, value) VALUES ('clean_last_run_at', ?)").run(new Date(NOW.getTime() + 5 * DAY).toISOString());
    expect(autoCleanPeople(f.db, NOW, 'box', true).devices).toEqual([]);
    expect(revoked(f.db, f.idle)).toBe(false);
  });

  it('[G-S1] a forward jump also skips the automatic delete of long-deactivated people', async () => {
    const app = makeApp();
    const { db } = await fleet(app, 1);
    const x = await loginAs(app, 'treasurer');
    deactivateUser(db, x.userId, 'test');
    off(db, x.userId, ago(500));
    expect(autoCleanPeople(db, new Date(Date.now() + 100 * DAY), 'box', true).users).toEqual([]);
    expect(urow(db, x.userId).deleted_at).toBeNull();
  });

  it('[G-S1] normal daily runs still revoke a phone idle 181 days', async () => {
    const app = makeApp();
    const { db, idle } = await fleet(app, 181);
    expect(autoCleanPeople(db, NOW, 'box', true).devices).toEqual([idle]);
    expect(revoked(db, idle)).toBe(true);
  });

  it('[G-S1] more than half of the phones of a surau idle revokes none and leaves one note', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'admin');
    const b = await loginAs(app, 'ajk');
    const c = await loginAs(app, 'treasurer');
    const db = app.surau.db;
    seen(db, a.deviceId, ago(1));
    seen(db, b.deviceId, ago(300));
    seen(db, c.deviceId, ago(300));
    expect(autoCleanPeople(db, NOW, 'box', true).devices).toEqual([]);
    expect(revoked(db, b.deviceId)).toBe(false);
    expect(revoked(db, c.deviceId)).toBe(false);
    autoCleanPeople(db, new Date(NOW.getTime() + 3_600_000), 'box', true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE event = 'auto_clean_skipped'").get()?.n).toBe(1);
    // exactly half is allowed
    seen(db, c.deviceId, ago(1));
    seen(db, a.deviceId, ago(1));
    const d = await loginAs(app, 'media');
    seen(db, d.deviceId, ago(1));
    expect(autoCleanPeople(db, new Date(NOW.getTime() + 2 * 3_600_000), 'box', true).devices).toEqual([b.deviceId]);
  });
});
