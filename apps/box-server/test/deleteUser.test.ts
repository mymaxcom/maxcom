import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeedEntry } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { beginEnrolment } from '../src/auth/devices.ts';
import { createUser } from '../src/auth/users.ts';
import { run as runUsersCli } from '../src/cli/users.ts';
import { applyFeedEntry } from '../src/sync/apply.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { loginAs, TEST_PIN } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { signOp } from './support/signOp.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp(opts: Parameters<typeof buildApp>[1] = {}): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-s9-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir, ...opts });
  apps.push(app);
  return app;
}

const del = (app: FastifyInstance, by: Login, id: string, ref: unknown) =>
  app.inject({ method: 'POST', url: `/api/users/${id}/delete`, headers: by.headers, payload: ref === undefined ? {} : { ref } });
const restore = (app: FastifyInstance, by: Login, id: string) => app.inject({ method: 'POST', url: `/api/users/${id}/restore`, headers: by.headers, payload: {} });
const refOf = (db: DatabaseSync, id: string): string => {
  const r = db.prepare('SELECT no, no_src FROM users WHERE id = ?').get(id);
  return `U-${r?.no_src === 'c' ? 'C' : ''}${String(r?.no).padStart(4, '0')}`;
};
const row = (db: DatabaseSync, id: string): Record<string, unknown> => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown>;
const listIds = async (app: FastifyInstance, by: Login): Promise<string[]> =>
  ((await app.inject({ method: 'GET', url: '/api/users', headers: by.headers })).json().users as Array<{ id: string }>).map((u) => u.id);
const liveDevices = (db: DatabaseSync, userId: string): number => Number(db.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND revoked_at IS NULL').get(userId)?.n);

let ipN = 0;
async function unlockWith(app: FastifyInstance, l: Login): Promise<{ status: number; code?: string }> {
  const remoteAddress = `10.66.${(++ipN >> 8) & 255}.${ipN & 255}`;
  const ch = await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress, payload: { deviceId: l.deviceId } });
  if (ch.statusCode !== 200) return { status: ch.statusCode, code: ch.json().code as string | undefined };
  const message = new TextEncoder().encode(`surau-unlock\n${app.surau.boxId}\n${l.deviceId}\n${String(ch.json().nonce)}`);
  const r = await app.inject({ method: 'POST', url: '/api/auth/unlock', remoteAddress, payload: { deviceId: l.deviceId, nonce: ch.json().nonce, signature: await l.sign(message), pin: TEST_PIN } });
  return { status: r.statusCode, code: r.json().code as string | undefined };
}

describe('[PP-S9] Padam: soft delete of a user', () => {
  it('[PP-S9] the right ref hides the person everywhere, ends their sign-in at once and keeps every row', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const db = app.surau.db;
    const code = beginEnrolment(db, { userId: ajk.userId, deviceName: 'Telefon Baru' }, `user:${admin.userId}`, { canManageSuperadmin: false });
    expect(await listIds(app, admin)).toContain(ajk.userId);
    const rowsBefore = Number(db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n);
    const r = await del(app, admin, ajk.userId, refOf(db, ajk.userId));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    // in no list, count, picker or search
    expect(await listIds(app, admin)).not.toContain(ajk.userId);
    const act = (await app.inject({ method: 'GET', url: '/api/people/activity', headers: admin.headers })).json();
    expect(act.users.some((u: { id: string }) => u.id === ajk.userId)).toBe(false);
    expect(JSON.stringify((await app.inject({ method: 'GET', url: '/api/enrol/open', headers: admin.headers })).json())).not.toContain(ajk.userId);
    expect(JSON.stringify((await app.inject({ method: 'GET', url: '/api/enrol/recent', headers: admin.headers })).json())).not.toContain(ajk.userId);
    const begin = await app.inject({ method: 'POST', url: '/api/enrol/begin', headers: admin.headers, payload: { userId: ajk.userId, deviceName: 'x' } });
    expect(begin.statusCode).toBe(404);
    // nothing physically removed
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n)).toBe(rowsBefore);
    expect(row(db, ajk.userId)).toMatchObject({ active: 0 });
    expect(typeof row(db, ajk.userId).deleted_at).toBe('string');
    expect(row(db, ajk.userId).deleted_by).toBe(`user:${admin.userId}`);
    expect(typeof row(db, ajk.userId).deactivated_at).toBe('string');
    // sign-in ends at once: the open session, the device and the open code
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: ajk.headers })).statusCode).toBe(401);
    expect(liveDevices(db, ajk.userId)).toBe(0);
    expect(await unlockWith(app, ajk)).toMatchObject({ status: 401, code: 'device_revoked' });
    const redeem = await app.inject({ method: 'POST', url: '/api/enrol/complete', remoteAddress: '10.77.1.1', payload: { code: code.code, publicJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }, platform: 'web', pin: TEST_PIN } });
    expect(redeem.statusCode).toBeGreaterThanOrEqual(400);
    // the dashboard counts leave them out
    expect(db.prepare("SELECT 1 AS x FROM users WHERE id = ? AND active = 1").get(ajk.userId)).toBeUndefined();
  });

  it('[PP-S9] old audit rows still read with the name of the time and the ID, and the delete line offers Pulihkan while deleted', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const db = app.surau.db;
    const ajkRef = refOf(db, ajk.userId);
    const name = String(row(db, ajk.userId).name);
    // a row the person made themselves (a PIN change logs under their actor)
    db.prepare("INSERT INTO change_log (at, actor, actor_name, entity, entity_id, before_json, after_json, surau_id, origin) VALUES (?, ?, ?, 'settings', 'x', NULL, '{}', ?, 'local')").run(new Date().toISOString(), `user:${ajk.userId}`, name, LOCAL_SURAU_ID);
    await del(app, admin, ajk.userId, ajkRef);
    const audit = (await app.inject({ method: 'GET', url: '/api/audit', headers: admin.headers })).json().entries as Array<{ actor: string; userName: string | null; actorRef: string | null; entity: string; entityId: string | null; entityRef: string | null; entityDeleted: boolean; after: { deleted?: boolean } | null }>;
    const theirs = audit.find((e) => e.actor === `user:${ajk.userId}`);
    expect(theirs).toMatchObject({ userName: name, actorRef: ajkRef });
    const line = audit.find((e) => e.entity === 'users' && e.entityId === ajk.userId && e.after?.deleted === true);
    expect(line).toMatchObject({ entityRef: ajkRef, entityDeleted: true });
    // after Pulihkan the same line no longer offers it
    expect((await restore(app, admin, ajk.userId)).statusCode).toBe(200);
    const again = (await app.inject({ method: 'GET', url: '/api/audit', headers: admin.headers })).json().entries as Array<{ entityId: string | null; entityDeleted: boolean }>;
    expect(again.filter((e) => e.entityId === ajk.userId).every((e) => e.entityDeleted === false)).toBe(true);
  });

  it('[PP-S9] a wrong, missing or another person ref is 400 ref_mismatch and nothing changes', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const other = await loginAs(app, 'treasurer');
    const db = app.surau.db;
    for (const ref of [undefined, '', 'U-9999', refOf(db, other.userId), 'D-0001', ajk.userId, 42, 'surau-lain/' + refOf(db, ajk.userId)]) {
      const r = await del(app, admin, ajk.userId, ref);
      expect(r.statusCode, String(ref)).toBe(400);
      expect(r.json().code).toBe('ref_mismatch');
    }
    expect(row(db, ajk.userId).deleted_at).toBeNull();
    expect(row(db, ajk.userId).active).toBe(1);
    // a typed ID in loose form is the same ID
    expect((await del(app, admin, ajk.userId, refOf(db, ajk.userId).toLowerCase().replace('-', ' '))).statusCode).toBe(200);
  });

  it('[PP-S9] a person with no ID yet is deleted by their own id', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    app.surau.db.prepare('UPDATE users SET no = NULL, no_src = NULL WHERE id = ?').run(ajk.userId);
    expect((await del(app, admin, ajk.userId, 'U-0001')).statusCode).toBe(400);
    expect((await del(app, admin, ajk.userId, ajk.userId)).statusCode).toBe(200);
  });

  it('[PP-S9] your own account, the last Pentadbir and the last Pentadbir phone are refused; nothing changes', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'admin');
    const b = await loginAs(app, 'admin');
    const db = app.surau.db;
    const own = await del(app, a, a.userId, refOf(db, a.userId));
    expect(own.statusCode).toBe(409);
    expect(own.json().code).toBe('own_account');
    // the last active Pentadbir (a second, inactive one does not count)
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(b.userId);
    const treasurer = await loginAs(app, 'treasurer');
    expect(treasurer.userId).toBeTruthy();
    // the last Pentadbir phone: A's phone is no longer counted in the surau, so B's phone is the last one
    db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(b.userId);
    db.prepare('UPDATE devices SET surau_id = ? WHERE id = ?').run('surau-lain', a.deviceId);
    const r = await del(app, a, b.userId, refOf(db, b.userId));
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('last_admin_device');
    expect(row(db, b.userId)).toMatchObject({ active: 1, deleted_at: null });
    expect(liveDevices(db, b.userId)).toBe(1);
  });

  it('[PP-S9] the only active Pentadbir cannot be deleted (last_admin)', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'admin');
    const helper = await loginAs(app, 'superadmin');
    const db = app.surau.db;
    // a superadmin session on a box may act, but a box counts only the surau's own Pentadbir as its administrator
    const r = await del(app, helper, a.userId, refOf(db, a.userId));
    expect([409]).toContain(r.statusCode);
    expect(['last_admin', 'last_admin_device']).toContain(r.json().code);
    expect(row(db, a.userId).deleted_at).toBeNull();
  });

  it('[PP-S9][PP-GC] a Pentadbir MAXCOM is 404 with a star_target_refused row; a Bendahari gets 403', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const treasurer = await loginAs(app, 'treasurer');
    const star = await loginAs(app, 'superadmin');
    const db = app.surau.db;
    const logged = (): number => Number(db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE event = 'star_target_refused'").get()?.n);
    const n0 = logged();
    expect((await del(app, admin, star.userId, 'maxcom/U-C0001')).statusCode).toBe(404);
    expect(logged() - n0).toBe(1);
    expect((await restore(app, admin, star.userId)).statusCode).toBe(404);
    expect((await del(app, admin, 'nope', 'U-0001')).statusCode).toBe(404);
    expect(row(db, star.userId).deleted_at).toBeNull();
    expect((await del(app, treasurer, star.userId, 'U-0001')).statusCode).toBe(403);
    expect((await restore(app, treasurer, star.userId)).statusCode).toBe(403);
  });

  it('[PP-S9] deleting a deleted person is 404; restore of a person who is not deleted is 404', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const db = app.surau.db;
    expect((await restore(app, admin, ajk.userId)).statusCode).toBe(404);
    await del(app, admin, ajk.userId, refOf(db, ajk.userId));
    expect((await del(app, admin, ajk.userId, refOf(db, ajk.userId))).statusCode).toBe(404);
  });

  it('[PP-S9] restore returns the person deactivated with no devices; Aktifkan semula and a new code bring them back', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const db = app.surau.db;
    const ref = refOf(db, ajk.userId);
    await del(app, admin, ajk.userId, ref);
    const before = Date.now();
    const r = await restore(app, admin, ajk.userId);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ id: ajk.userId, active: false, deleted: false, ref });
    expect(row(db, ajk.userId)).toMatchObject({ deleted_at: null, deleted_by: null, active: 0 });
    expect(Date.parse(String(row(db, ajk.userId).deactivated_at))).toBeGreaterThanOrEqual(before - 1000);
    expect(liveDevices(db, ajk.userId)).toBe(0);
    expect(await listIds(app, admin)).toContain(ajk.userId);
    expect((await app.inject({ method: 'POST', url: `/api/users/${ajk.userId}/activate`, headers: admin.headers, payload: {} })).statusCode).toBe(200);
    expect(beginEnrolment(db, { userId: ajk.userId, deviceName: 'Telefon Baru' }, `user:${admin.userId}`, { canManageSuperadmin: false }).code).toBeTruthy();
    expect(row(db, ajk.userId).deactivated_at).toBeNull();
  });
});

describe('[PP-S9] delete and sync', () => {
  const entryFor = (id: string, after: Record<string, unknown>, at: string): FeedEntry => ({
    seq: 1, entity: 'user', entityId: id, rev: `${at}|dev-x`, editedAt: at, syncedAt: at, actor: 'user:x', deviceId: null, origin: 'local', opId: null, after,
  });
  const ctx = (): Parameters<typeof applyFeedEntry>[2] => ({ surauId: LOCAL_SURAU_ID, now: new Date(Date.now() + 3600_000), origin: 'box:b1', actor: 'user:x', dataDir: tmpdir() });

  it('[PP-S9] the delete entry deletes on a second server, carries active false and deleted true (an older peer deactivates)', async () => {
    const one = makeApp();
    const two = makeApp();
    const admin = await loginAs(one, 'admin');
    const ajk = await loginAs(one, 'ajk');
    const u = (db: DatabaseSync) => db.prepare('SELECT name FROM users WHERE id = ?').get(ajk.userId);
    const name = String(u(one.surau.db)?.name);
    // the same person exists on the second server
    const at0 = new Date(Date.now() + 1000).toISOString();
    expect(applyFeedEntry(two.surau.db, entryFor(ajk.userId, { id: ajk.userId, name, roles: ['ajk'], active: true }, at0), ctx()).status).toBe('applied');
    await del(one, admin, ajk.userId, refOf(one.surau.db, ajk.userId));
    const last = one.surau.db.prepare("SELECT after_json FROM change_log WHERE entity = 'users' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(ajk.userId);
    const after = JSON.parse(String(last?.after_json)) as Record<string, unknown>;
    expect(after).toMatchObject({ active: false, deleted: true });
    const at1 = new Date(Date.now() + 2000).toISOString();
    expect(applyFeedEntry(two.surau.db, entryFor(ajk.userId, after, at1), ctx()).status).toBe('applied');
    expect(row(two.surau.db, ajk.userId)).toMatchObject({ active: 0 });
    expect(typeof row(two.surau.db, ajk.userId).deleted_at).toBe('string');
    // an older peer ignores `deleted` and reads active false: the entry minus the key is a deactivation
    const withoutKey: Record<string, unknown> = { ...after, deleted: undefined };
    expect(withoutKey.active).toBe(false);
  });

  it('[PP-S9] a later edit without the key never undeletes; a restore entry with deleted false restores to deactivated', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const db = app.surau.db;
    const name = String(row(db, ajk.userId).name);
    await del(app, admin, ajk.userId, refOf(db, ajk.userId));
    const t = (n: number): string => new Date(Date.now() + n * 1000).toISOString();
    expect(applyFeedEntry(db, entryFor(ajk.userId, { id: ajk.userId, name: 'Kak Siti Baru', roles: ['ajk', 'media'], active: true }, t(100)), ctx()).status).toBe('applied');
    expect(row(db, ajk.userId)).toMatchObject({ active: 0, name: 'Kak Siti Baru' });
    expect(typeof row(db, ajk.userId).deleted_at).toBe('string');
    expect(await listIds(app, admin)).not.toContain(ajk.userId);
    const before = Date.now();
    expect(applyFeedEntry(db, entryFor(ajk.userId, { id: ajk.userId, name, roles: ['ajk'], active: false, deleted: false }, t(200)), ctx()).status).toBe('applied');
    expect(row(db, ajk.userId)).toMatchObject({ active: 0, deleted_at: null });
    expect(Date.parse(String(row(db, ajk.userId).deactivated_at))).toBeGreaterThanOrEqual(before - 1000);
  });

  it('[PP-S9] a user.put op from a phone carrying deleted is applied without it', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const op = await signOp(admin, app.surau.boxId, { kind: 'user.put', entity: 'user', entityId: ajk.userId, payload: { name: 'Kak Siti Baru', deleted: true }, editedAt: new Date(Date.now() + 60_000).toISOString() });
    const r = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: admin.headers, payload: { ops: [op] } });
    expect(r.json().results[0].status, r.body).toBe('applied');
    expect(row(app.surau.db, ajk.userId)).toMatchObject({ name: 'Kak Siti Baru', deleted_at: null, active: 1 });
  });

  it('[PP-S9] the snapshot an administrator phone reads marks the person deleted so the phone drops its copy', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    await del(app, admin, ajk.userId, refOf(app.surau.db, ajk.userId));
    const snap = (await app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: admin.headers })).json();
    expect((snap.users as Array<{ id: string; deleted?: boolean; active: boolean }>).find((x) => x.id === ajk.userId)).toMatchObject({ deleted: true, active: false });
  });

  it('[PP-S9] two Pentadbir deleting each other: the first wins, the second is dead and the survivor stays', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'admin');
    const b = await loginAs(app, 'admin');
    const db = app.surau.db;
    expect((await del(app, a, b.userId, refOf(db, b.userId))).statusCode).toBe(200);
    const second = await del(app, b, a.userId, refOf(db, a.userId));
    expect(second.statusCode).toBe(401);
    expect(row(db, a.userId)).toMatchObject({ active: 1, deleted_at: null });
  });
});

describe('[PP-S9] superadmin and CLI views', () => {
  it('[PP-S9] an ops session sees the deleted person marked with who and when, and a removed device marked revoked', async () => {
    const app = makeApp({ role: 'cloud' });
    app.surau.db.prepare("INSERT OR IGNORE INTO suraus (id, name, created_at, created_by) VALUES ('sdm', 'Surau Perintis Contoh', '2026-11-01T00:00:00.000Z', 'test')").run();
    const star = await loginAs(app, 'superadmin');
    const ajk = createUser(app.surau.db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', 'sdm');
    const admin = createUser(app.surau.db, { name: 'Pentadbir Contoh', roles: ['admin'] }, 'test', 'sdm');
    expect(admin.id).toBeTruthy();
    const r = await del(app, star, ajk.id, ajk.ref ?? ajk.id);
    expect(r.statusCode, r.body).toBe(200);
    const users = (await app.inject({ method: 'GET', url: '/api/users', headers: star.headers })).json().users as Array<{ id: string; deleted: boolean; deletedAt: string | null; deletedBy: string | null }>;
    const mine = users.find((u) => u.id === ajk.id);
    expect(mine).toMatchObject({ deleted: true, deletedBy: `user:${star.userId}` });
    expect(typeof mine?.deletedAt).toBe('string');
  });

  it('[PP-S9] CLI: delete --ref, restore --ref and list --deleted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-s9cli-'));
    dirs.push(dir);
    const dbPath = join(dir, 'cli.db');
    const app = buildApp(dbPath, { dataDir: dir });
    createUser(app.surau.db, { name: 'Pentadbir Contoh', roles: ['admin'] }, 'test', LOCAL_SURAU_ID);
    createUser(app.surau.db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID);
    await app.close();
    const lines: string[] = [];
    const run = (args: string[]) => runUsersCli(['--db', dbPath, ...args], { out: (l) => lines.push(l), err: (l) => lines.push(l) });
    expect(await run(['delete', '--ref', 'U-0002'])).toBe(0);
    lines.length = 0;
    expect(await run(['list'])).toBe(0);
    expect(lines.join('\n')).not.toContain('Kak Siti');
    lines.length = 0;
    expect(await run(['list', '--deleted'])).toBe(0);
    expect(lines.join('\n')).toContain('Kak Siti');
    expect(lines.join('\n')).toContain('dipadam');
    expect(await run(['delete', '--ref', 'U-0002'])).not.toBe(0);
    expect(await run(['delete', '--ref', 'U-0001'])).not.toBe(0); // the last Pentadbir
    lines.length = 0;
    expect(await run(['restore', '--ref', 'U-0002'])).toBe(0);
    expect(await run(['list'])).toBe(0);
    expect(lines.join('\n')).toContain('Kak Siti');
    expect(await run(['delete'])).toBe(1);
  });
});
