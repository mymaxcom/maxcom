import { spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeedEntry, Role } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { beginEnrolment } from '../src/auth/devices.ts';
import { activeAdminCount, activeSuperadminCount, createUser, getUserRow, listUsers, promoteSuperadmin, setUsersRole } from '../src/auth/users.ts';
import { openDb } from '../src/db.ts';
import { applyFeedEntry } from '../src/sync/apply.ts';
import { readFeed } from '../src/sync/feed.ts';
import { loginAs } from './authHelpers.ts';
import { signOp } from './support/signOp.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp(role: 'box' | 'cloud'): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-sa-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir, role });
  apps.push(app);
  return app;
}

function memDb(role: 'box' | 'cloud'): DatabaseSync {
  const db = openDb(':memory:');
  setUsersRole(db, role);
  dbs.push(db);
  return db;
}

const putRoles = (app: FastifyInstance, headers: Record<string, string>, id: string, roles: Role[]) =>
  app.inject({ method: 'PUT', url: `/api/users/${id}/roles`, headers, payload: { roles } });

const logCount = (db: DatabaseSync, detail: string): number =>
  Number(db.prepare('SELECT COUNT(*) AS n FROM auth_log WHERE detail = ?').get(detail)?.n ?? 0);

const T = '2026-11-09T10:00:00.000Z';
function userEntry(id: string, origin: string, roles: Role[], name = 'Pentadbir Jauh'): FeedEntry {
  return {
    seq: 1, entity: 'user', entityId: id, rev: `${T}|dev-x`, editedAt: T, syncedAt: T, actor: 'user:x', deviceId: null, origin, opId: null,
    after: { name, roles, active: true },
  };
}
const ctx = (origin: string) => ({ now: new Date('2026-11-09T10:05:00.000Z'), origin, actor: 'user:x', dataDir: tmpdir() });

describe('superadmin membership is cloud-only', () => {
  it('a box refuses to add the role through the routes, even for a Pentadbir MAXCOM', async () => {
    const box = makeApp('box');
    const sup = await loginAs(box, 'superadmin');
    const other = await loginAs(box, 'media');
    const r = await putRoles(box, sup.headers, other.userId, ['admin', 'superadmin']);
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('superadmin_cloud_only');
    expect(getUserRow(box.surau.db, other.userId)!.roles).toEqual(['media']);
    const c = await box.inject({ method: 'POST', url: '/api/users', headers: sup.headers, payload: { name: 'Baru', roles: ['superadmin'] } });
    expect(c.statusCode).toBe(403);
    expect(c.json().code).toBe('superadmin_cloud_only');
  });

  it('the cloud needs superadmin:manage: an admin is refused, a Pentadbir MAXCOM succeeds', async () => {
    const cloud = makeApp('cloud');
    const admin = await loginAs(cloud, 'admin');
    const sup = await loginAs(cloud, 'superadmin');
    const target = await loginAs(cloud, 'media');
    const no = await putRoles(cloud, admin.headers, target.userId, ['media', 'superadmin']);
    expect(no.statusCode).toBe(403);
    expect(no.json().code).toBe('forbidden');
    expect((await cloud.inject({ method: 'POST', url: '/api/users', headers: admin.headers, payload: { name: 'X', roles: ['superadmin'] } })).statusCode).toBe(403);
    const ok = await putRoles(cloud, sup.headers, target.userId, ['media', 'superadmin']);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(getUserRow(cloud.surau.db, target.userId)!.roles).toEqual(['superadmin', 'media']);
    const made = await cloud.inject({ method: 'POST', url: '/api/users', headers: sup.headers, payload: { name: 'Pentadbir Dua', roles: ['superadmin'] } });
    expect(made.statusCode).toBe(201);
    // taking the role away is the same right; ordinary roles stay in the admin's hands
    expect((await putRoles(cloud, admin.headers, target.userId, ['media', 'ajk'])).statusCode).toBe(403);
    expect((await putRoles(cloud, admin.headers, (await loginAs(cloud, 'ajk')).userId, ['media'])).statusCode).toBe(200);
  });

  it('a signed user.put op cannot grant it without superadmin:manage, and a box refuses it outright', async () => {
    const cloud = makeApp('cloud');
    const admin = await loginAs(cloud, 'admin');
    const sup = await loginAs(cloud, 'superadmin');
    const target = await loginAs(cloud, 'media');
    const send = async (app: FastifyInstance, login: typeof admin, entityId: string, roles: Role[]) => {
      const op = await signOp(login, app.surau.boxId, {
        kind: 'user.put', entity: 'user', entityId, payload: { name: 'Sasaran', roles, active: true }, editedAt: new Date().toISOString(),
      });
      const r = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: login.headers, payload: { ops: [op] } });
      return r.json().results[0] as { status: string; reason: string | null };
    };
    expect(await send(cloud, admin, target.userId, ['media', 'superadmin'])).toMatchObject({ status: 'refused', reason: 'forbidden' });
    expect(logCount(cloud.surau.db, 'superadmin_manage')).toBe(1);
    expect(getUserRow(cloud.surau.db, target.userId)!.roles).toEqual(['media']);
    expect((await send(cloud, sup, target.userId, ['media', 'superadmin'])).status).toBe('applied');
    const box = makeApp('box');
    const bsup = await loginAs(box, 'superadmin');
    const btarget = await loginAs(box, 'media');
    expect(await send(box, bsup, btarget.userId, ['media', 'superadmin'])).toMatchObject({ status: 'refused', reason: 'forbidden' });
    expect(logCount(box.surau.db, 'superadmin_cloud_only')).toBe(1);
  });
});

describe('the last administrators', () => {
  it('the only Pentadbir MAXCOM cannot be demoted or deactivated (409 last_superadmin)', async () => {
    const cloud = makeApp('cloud');
    const sup = await loginAs(cloud, 'superadmin');
    await loginAs(cloud, 'admin'); // another admin, so last_admin is not what fires first
    const demote = await putRoles(cloud, sup.headers, sup.userId, ['ajk']);
    expect(demote.statusCode).toBe(409);
    expect(demote.json().code).toBe('last_superadmin');
    const off = await cloud.inject({ method: 'POST', url: `/api/users/${sup.userId}/deactivate`, headers: sup.headers });
    expect(off.statusCode).toBe(409);
    expect(off.json().code).toBe('last_superadmin');
    // with a second Pentadbir MAXCOM the first can step down
    const second = await cloud.inject({ method: 'POST', url: '/api/users', headers: sup.headers, payload: { name: 'Kedua', roles: ['superadmin'] } });
    expect(second.statusCode).toBe(201);
    expect((await putRoles(cloud, sup.headers, sup.userId, ['ajk'])).statusCode).toBe(200);
  });

  it('a Pentadbir MAXCOM counts as an administrator: the only one is last_admin', async () => {
    const box = makeApp('box');
    const solo = await loginAs(box, 'superadmin');
    expect(activeAdminCount(box.surau.db)).toBe(1);
    expect(activeSuperadminCount(box.surau.db)).toBe(1);
    const r = await box.inject({ method: 'POST', url: `/api/users/${solo.userId}/deactivate`, headers: solo.headers });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('last_admin');
    const both = await loginAs(box, ['admin']);
    expect(activeAdminCount(box.surau.db)).toBe(2);
    // an admin who is not a superadmin can go once another administrator remains
    const d = await box.inject({ method: 'POST', url: `/api/users/${both.userId}/deactivate`, headers: solo.headers });
    expect(d.statusCode, d.body).toBe(200);
  });
});

describe('replicated superadmin rows', () => {
  it('a cloud refuses every superadmin change that comes from a site, whatever the row origin says', () => {
    const cloud = memDb('cloud');
    // an ordinary admin replicated from the box; later promoted ON the cloud
    const e0 = userEntry('u-admin', 'box:b1', ['admin'], 'Pentadbir Surau');
    expect(applyFeedEntry(cloud, e0, ctx('box:b1'))).toEqual({ status: 'applied', reason: null });
    // 1. adding superadmin to a new user, or to an existing ordinary one
    expect(applyFeedEntry(cloud, userEntry('u-new', 'box:b1', ['superadmin'], 'Penyamar'), ctx('box:b1'))).toEqual({ status: 'refused', reason: 'forbidden' });
    expect(getUserRow(cloud, 'u-new')).toBeUndefined();
    const grant = userEntry('u-admin', 'box:b1', ['admin', 'superadmin'], 'Pentadbir Surau');
    grant.rev = '2026-11-09T10:01:00.000Z|dev-x';
    grant.editedAt = '2026-11-09T10:01:00.000Z';
    expect(applyFeedEntry(cloud, grant, ctx('box:b1'))).toEqual({ status: 'refused', reason: 'forbidden' });
    expect(getUserRow(cloud, 'u-admin')!.roles).toEqual(['admin']);
    expect(logCount(cloud, 'superadmin_cloud_only')).toBe(2);
    // the operator promotes on the cloud
    promoteSuperadmin(cloud, 'u-admin', 'local', 'MAXCOM SuperAdmin');
    let n = 2;
    for (const origin of ['local', 'box:b1', 'cloud']) {
      cloud.prepare('UPDATE users SET origin = ? WHERE id = ?').run(origin, 'u-admin');
      for (const [what, roles, active, name] of [
        ['rename', ['admin', 'superadmin'], true, 'Nama Lain'],
        ['same roles', ['admin', 'superadmin'], true, 'MAXCOM SuperAdmin'],
        ['demote', ['admin'], true, 'MAXCOM SuperAdmin'],
        ['deactivate', ['admin', 'superadmin'], false, 'MAXCOM SuperAdmin'],
      ] as const) {
        const e = userEntry('u-admin', 'box:b1', [...roles], name);
        e.after = { name, roles: [...roles], active };
        const at = `2026-11-09T11:${String(n).padStart(2, '0')}:00.000Z`;
        n += 1;
        e.rev = `${at}|dev-x`;
        e.editedAt = at;
        expect(applyFeedEntry(cloud, e, ctx('box:b1')), `${origin} ${what}`).toEqual({ status: 'refused', reason: 'forbidden' });
      }
      const row = getUserRow(cloud, 'u-admin')!;
      expect(row.name).toBe('MAXCOM SuperAdmin');
      expect(row.active).toBe(true);
      expect(row.roles).toEqual(['superadmin', 'admin']);
    }
    // the same, through the keys-accepting path of the cloud's site ingest
    const viaIngest = userEntry('u-admin', 'local', ['admin', 'superadmin'], 'Lain');
    viaIngest.rev = '2026-11-09T12:00:00.000Z|dev-x';
    viaIngest.editedAt = '2026-11-09T12:00:00.000Z';
    expect(applyFeedEntry(cloud, viaIngest, { ...ctx('box:b1'), acceptDeviceEnrolment: true })).toEqual({ status: 'refused', reason: 'forbidden' });
    // an ordinary user from the box still replicates, edits included
    const ordinary = userEntry('u-media', 'box:b1', ['media'], 'Media');
    expect(applyFeedEntry(cloud, ordinary, ctx('box:b1')).status).toBe('applied');
    const edit = userEntry('u-media', 'box:b1', ['media', 'ajk'], 'Media 2');
    edit.rev = '2026-11-09T10:09:00.000Z|dev-x';
    edit.editedAt = '2026-11-09T10:09:00.000Z';
    expect(applyFeedEntry(cloud, edit, ctx('box:b1')).status).toBe('applied');
    expect(getUserRow(cloud, 'u-media')!.name).toBe('Media 2');
  });

  it('a box takes a superadmin row from the cloud and refuses to lose its last one by replication', () => {
    const box = memDb('box');
    createUser(box, { name: 'Pentadbir Surau', roles: ['admin'] }, 'test');
    const e = userEntry('u-cloud', 'cloud', ['superadmin']);
    expect(applyFeedEntry(box, e, ctx('cloud'))).toEqual({ status: 'applied', reason: null });
    expect(getUserRow(box, 'u-cloud')!.roles).toEqual(['superadmin']);
    const demote = userEntry('u-cloud', 'cloud', ['ajk']);
    demote.rev = '2026-11-09T10:02:00.000Z|dev-y';
    demote.editedAt = '2026-11-09T10:02:00.000Z';
    expect(applyFeedEntry(box, demote, ctx('cloud'))).toEqual({ status: 'refused', reason: 'last_admin' });
    expect(logCount(box, 'last_superadmin')).toBe(1);
    expect(getUserRow(box, 'u-cloud')!.roles).toEqual(['superadmin']);
  });

  it('the first superadmin is made by promotion on the cloud and then replicates to the box', async () => {
    const cloud = memDb('cloud');
    const box = memDb('box');
    createUser(box, { name: 'Pentadbir Surau', roles: ['admin'] }, 'test');
    // the box's admin reaches the cloud as an ordinary user
    for (const e of readFeed(box, 0, 500, { users: true, devices: true }).entries) applyFeedEntry(cloud, e, ctx('box:b1'));
    const adminOnCloud = listUsers(cloud).find((u) => u.name === 'Pentadbir Surau')!;
    expect(adminOnCloud.roles).toEqual(['admin']);
    const before = readFeed(cloud, 0, 500, { users: true, devices: true }).head;
    await new Promise((r) => setTimeout(r, 15)); // the promotion is a later edit than the box's own
    const p = promoteSuperadmin(cloud, adminOnCloud.id, 'local', 'MAXCOM SuperAdmin');
    expect(p.roles).toEqual(['superadmin', 'admin']);
    // ... and the box takes it from the cloud
    const feed = readFeed(cloud, before, 500, { users: true, devices: true });
    expect(feed.entries.length).toBeGreaterThan(0);
    for (const e of feed.entries) expect(applyFeedEntry(box, e, { ...ctx('cloud'), now: new Date(Date.now() + 60_000) }).status).toBe('applied');
    const onBox = getUserRow(box, adminOnCloud.id)!;
    expect(onBox.roles).toEqual(['superadmin', 'admin']);
    expect(onBox.name).toBe('MAXCOM SuperAdmin');
  });

  it('promotion counts every superadmin row, active or not, as "one exists"', () => {
    const cloud = memDb('cloud');
    const a = createUser(cloud, { name: 'Pertama', roles: ['admin'] }, 'test');
    const b = createUser(cloud, { name: 'Kedua', roles: ['admin'] }, 'test');
    promoteSuperadmin(cloud, a.id, 'local');
    cloud.prepare('UPDATE users SET active = 0 WHERE id = ?').run(a.id);
    expect(activeSuperadminCount(cloud)).toBe(0);
    expect(() => promoteSuperadmin(cloud, b.id, 'local')).toThrowError(/sudah wujud/);
    expect(getUserRow(cloud, b.id)!.roles).toEqual(['admin']);
  });

  it('the promote step makes a superadmin at the database, and only while none exists', () => {
    const box = memDb('box');
    const u = createUser(box, { name: 'Pentadbir Ujian', roles: ['admin'] }, 'test');
    const p = promoteSuperadmin(box, u.id, 'local', 'MAXCOM SuperAdmin');
    expect(p.roles).toEqual(['superadmin', 'admin']);
    expect(p.name).toBe('MAXCOM SuperAdmin');
    const v = createUser(box, { name: 'Lain', roles: ['admin'] }, 'test');
    expect(() => promoteSuperadmin(box, v.id, 'local')).toThrowError(/sudah wujud/);
  });
});

describe('a device enrolment for a Pentadbir MAXCOM from a site', () => {
  async function key(): Promise<{ kty: string; crv: string; x: string; y: string }> {
    const k = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const j = await webcrypto.subtle.exportKey('jwk', k.publicKey);
    return { kty: String(j.kty), crv: String(j.crv), x: String(j.x), y: String(j.y) };
  }
  const enrolEntry = (id: string, userId: string, jwk: unknown): FeedEntry => ({
    seq: 2, entity: 'device', entityId: id, rev: `${T}|local`, editedAt: T, syncedAt: T, actor: `user:${userId}`, deviceId: null, origin: 'local', opId: null,
    after: { id, userId, name: 'Telefon', platform: 'android', revoked: false, publicJwk: jwk, enrolledAt: T },
  });

  it('is refused for any superadmin (whatever its row origin) and accepted for an ordinary admin', async () => {
    const cloud = memDb('cloud');
    const withKeys = { ...ctx('box:b1'), acceptDeviceEnrolment: true };
    applyFeedEntry(cloud, userEntry('u-admin', 'box:b1', ['admin'], 'Pentadbir Surau'), ctx('box:b1'));
    // an ordinary admin's device reaches the cloud (the road to the first promotion)
    expect(applyFeedEntry(cloud, enrolEntry('d-admin', 'u-admin', await key()), withKeys).status).toBe('applied');
    promoteSuperadmin(cloud, 'u-admin', 'local', 'MAXCOM SuperAdmin');
    for (const origin of ['box:b1', 'local']) {
      cloud.prepare('UPDATE users SET origin = ? WHERE id = ?').run(origin, 'u-admin');
      const id = `d-evil-${origin.replace(/\W/g, '')}`;
      expect(applyFeedEntry(cloud, enrolEntry(id, 'u-admin', await key()), withKeys), origin).toEqual({ status: 'refused', reason: 'forbidden' });
      expect(cloud.prepare('SELECT 1 AS x FROM devices WHERE id = ?').get(id)).toBeUndefined();
    }
    expect(logCount(cloud, 'superadmin_cloud_only')).toBe(2);
    // the superadmin's EXISTING device (it came in as an admin's) cannot be revoked from a site either
    const revokeEntry: FeedEntry = {
      seq: 3, entity: 'device', entityId: 'd-admin', rev: '2026-11-09T10:03:00.000Z|dev-x', editedAt: '2026-11-09T10:03:00.000Z', syncedAt: T,
      actor: 'user:x', deviceId: null, origin: 'box:b1', opId: null,
      after: { id: 'd-admin', userId: 'u-admin', name: 'Telefon', platform: 'android', revoked: true },
    };
    expect(applyFeedEntry(cloud, revokeEntry, withKeys)).toEqual({ status: 'refused', reason: 'forbidden' });
    expect(cloud.prepare('SELECT revoked_at FROM devices WHERE id = ?').get('d-admin')?.revoked_at).toBeNull();
    // an ordinary user's device still enrols and revokes
    applyFeedEntry(cloud, userEntry('u-media', 'box:b1', ['media'], 'Media'), ctx('box:b1'));
    expect(applyFeedEntry(cloud, enrolEntry('d-media', 'u-media', await key()), withKeys).status).toBe('applied');
    const revokeMedia: FeedEntry = { ...revokeEntry, entityId: 'd-media', after: { id: 'd-media', userId: 'u-media', name: 'Telefon', platform: 'android', revoked: true } };
    expect(applyFeedEntry(cloud, revokeMedia, withKeys).status).toBe('applied');
  });
});

describe('the Pentadbir MAXCOM device always asks for a PIN', () => {
  async function enrolWithoutPin(app: FastifyInstance, roles: Role[]) {
    const user = createUser(app.surau.db, { name: `U ${roles.join('+')}`, roles: roles.includes('superadmin') ? ['ajk'] : roles }, 'test');
    if (roles.includes('superadmin')) app.surau.db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(roles), user.id);
    const { code } = beginEnrolment(app.surau.db, { userId: user.id, deviceName: 'P' }, 'test', { canManageSuperadmin: true });
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
    const e = await app.inject({
      method: 'POST', url: '/api/enrol/complete', remoteAddress: '10.8.8.8',
      payload: { code, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, platform: 'android' },
    });
    expect(e.statusCode, e.body).toBe(200);
    const deviceId = String(e.json().deviceId);
    const attempt = async (extra: Record<string, string>) => {
      const ch = await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress: '10.8.8.8', payload: { deviceId } });
      const nonce = String(ch.json().nonce);
      const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(`surau-unlock\n${app.surau.boxId}\n${deviceId}\n${nonce}`));
      return {
        challenge: ch.json() as { appLock: boolean },
        res: await app.inject({ method: 'POST', url: '/api/auth/unlock', remoteAddress: '10.8.8.8', payload: { deviceId, nonce, signature: Buffer.from(sig).toString('base64url'), ...extra } }),
      };
    };
    return { enrol: e.json() as { pinRequired: boolean; appLock: boolean }, attempt, userId: user.id };
  }

  it('with the surau lock off: a superadmin needs a PIN, an admin does not', async () => {
    const app = makeApp('box');
    const sup = await enrolWithoutPin(app, ['superadmin']);
    expect(sup.enrol).toMatchObject({ pinRequired: true, appLock: true });
    const first = await sup.attempt({});
    expect(first.challenge.appLock).toBe(true);
    expect(first.res.statusCode).toBe(409);
    expect(first.res.json().pinRequired).toBe(true);
    const set = await sup.attempt({ newPin: '482916' });
    expect(set.res.statusCode, set.res.body).toBe(200);
    expect(set.res.json().user.roles).toEqual(['superadmin']);
    const bad = await sup.attempt({ pin: '111111' });
    expect(bad.res.statusCode).toBe(401);
    expect(Number(app.surau.db.prepare('SELECT pin_fail_count AS n FROM users WHERE id = ?').get(sup.userId)?.n)).toBe(1);
    expect((await sup.attempt({ pin: '482916' })).res.statusCode).toBe(200);
    // an ordinary admin on the same box: no PIN, the key alone opens it
    const adm = await enrolWithoutPin(app, ['admin']);
    expect(adm.enrol).toMatchObject({ pinRequired: false, appLock: false });
    const open = await adm.attempt({});
    expect(open.challenge.appLock).toBe(false);
    expect(open.res.statusCode).toBe(200);
  });
});

describe('enrolment code expiry', () => {
  it('10, 30 or 60 minutes; anything else is a 400; the default is 10', async () => {
    const app = makeApp('box');
    const admin = await loginAs(app, 'admin');
    const target = await loginAs(app, 'media');
    const begin = async (payload: object) =>
      app.inject({ method: 'POST', url: '/api/enrol/begin', headers: admin.headers, payload: { userId: target.userId, deviceName: 'iPad', ...payload } });
    const mins = (r: { json: () => { expiresAt: string } }): number => Math.round((Date.parse(r.json().expiresAt) - Date.now()) / 60_000);
    const d = await begin({});
    expect(d.statusCode).toBe(200);
    expect(mins(d)).toBe(10);
    // the account keeps at most three open codes: use them one expiry at a time
    expect(mins(await begin({ ttlMinutes: 60 }))).toBe(60);
    expect(mins(await begin({ ttlMinutes: 30 }))).toBe(30);
    for (const bad of [45, 0, 1440, '60', null, 10.5]) {
      const r = await begin({ ttlMinutes: bad });
      expect(r.statusCode, String(bad)).toBe(400);
    }
  });
});

describe('promote-superadmin on the command line', () => {
  const USERS = join(import.meta.dirname, '../src/cli/users.ts');
  const cli = (args: string[]): { code: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [USERS, ...args], { encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  it('promotes by exact name, renames, keeps admin, and refuses a second time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-clisa-'));
    dirs.push(dir);
    const dbPath = join(dir, 'surau.db');
    const db = openDb(dbPath);
    const u = createUser(db, { name: 'Pentadbir Ujian', roles: ['admin'] }, 'test');
    createUser(db, { name: 'Ustaz Ali', roles: ['admin'] }, 'test');
    db.close();
    expect(cli(['--db', dbPath, 'promote-superadmin', '--name', 'pentadbir ujian']).code).toBe(1); // the exact name only
    const r = cli(['--db', dbPath, 'promote-superadmin', '--name', 'Pentadbir Ujian', '--rename', 'MAXCOM SuperAdmin']);
    expect(r.code, r.stderr).toBe(0);
    const check = openDb(dbPath);
    const row = getUserRow(check, u.id)!;
    expect(row.roles).toEqual(['superadmin', 'admin']);
    expect(row.name).toBe('MAXCOM SuperAdmin');
    const logged = check.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'users' AND entity_id = ?").get(u.id);
    expect(Number(logged?.n)).toBeGreaterThanOrEqual(2);
    check.close();
    const again = cli(['--db', dbPath, 'promote-superadmin', '--name', 'Ustaz Ali']);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('Pentadbir MAXCOM sudah wujud');
  });
});
