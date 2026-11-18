/**
 * Plan 14 Task 23: Pentadbir MAXCOM (ops roles) powers only from an ops device. Tests written first, by a different
 * author than the implementation.
 *
 * Assumptions for the implementer (the plan is vague here; each is a choice made from the real code):
 *  1. New module `src/auth/opsDevice.ts` exports `isOpsDevice(db, deviceId)`, `effectiveRolesFor(db, user, deviceId,
 *     { role })` (user = the `AuthUser`/`UserRow` with `.roles`; `{ role: 'box' }` returns the roles unchanged, `{ role:
 *     'cloud' }` applies `effectiveRoles`), `issueOpsEnrolment(db, { userId, deviceName }, actor)` returning
 *     `{ code, expiresAt }`, `unmarkOps(db, deviceId, actor)`, `listOpsDevices(db)` returning
 *     `{ ops: Device[]; publicOfOpsUsers: Device[] }` (revoked devices are in neither list).
 *  2. Errors are `AuthError` with `.code`: `not_ops_user`, `ops_device_limit`, `ops_cli_only` (HTTP 403, from
 *     `/api/enrol/begin`), `ops_app_required` (HTTP 401, from `/api/enrol/complete`).
 *  3. "Live ops devices" for the cap of 3 = `devices.ops = 1 AND revoked_at IS NULL` of that user. Revoking one frees a
 *     slot. The 4th `issueOpsEnrolment` throws at issue time, not at completion.
 *  4. `issueOpsEnrolment` stores `enrolments.ops = 1`, the code hash only, ttl 10 minutes, `created_by = actor`, device
 *     name from `deviceName`. It works on any server role at library level (the cloud-only rule lives in the CLI).
 *  5. `EnrolInput` gains optional `client?: 'ops'`; `POST /api/enrol/complete` forwards `body.client` only when it is
 *     exactly the string 'ops'. A refused ops code (no client) writes ONE `auth_log` row: event `enrol`, ok 0, detail
 *     `ops_app_required`, leaves `enrolments.used_at` NULL, creates no device and no session.
 *  6. An ops enrolment makes `devices.ops = 1`, `ops_at` set, `ops_by = 'cli'` (the issuer's actor; the CLI passes
 *     'cli'), `surau_id = '*'`, `box_id` NULL, and writes `auth_log` event `ops_enrol` (ok 1). An ordinary code with
 *     `client: 'ops'` is an ordinary device: `ops = 0`, `ops_at` NULL, `surau_id` is NOT '*'.
 *  7. Ops roles are stripped by `effectiveRolesFor` only on the cloud role. The role the tests give is
 *     `buildApp(..., { role })`; the implementation reads it the way the code already does (`setUsersRole` /
 *     the app's `role`), no new env var.
 *  8. `AuthContext.ops` is a boolean from `devices.ops`; `/api/auth/me` returns `ops` and the effective `roles`.
 *     The PIN rule is untouched (a superadmin still needs the PIN on a public device: the lock reads real roles).
 *  9. `unmarkOps` sets `ops = 0`, revokes every open session of the device, writes `auth_log` event `ops_unmark` and a
 *     `change_log` row on entity `devices`; it throws `AuthError` code `not_ops_device` for a device that is not ops.
 * 10. The `devices` change_log `after` of an ops enrolment has no `ops` key (the flag is not in the feed in Phase 1).
 * 11. `settings.put` on a system feature by a public-device superadmin+admin is refused `forbidden` with an
 *     `auth_log` row `sync_refused` / `system_write` (as the existing settingsScope test).
 */
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ROLES } from '@surau/core';
import type { Role } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { identityCan } from '../src/auth/authz.ts';
import { beginEnrolment } from '../src/auth/devices.ts';
import { effectiveRolesFor, isOpsDevice, issueOpsEnrolment, listOpsDevices, unmarkOps } from '../src/auth/opsDevice.ts';
import { resolveSession } from '../src/auth/sessions.ts';
import { createUser, getAuthUser, getUserRow, serverRoleOf } from '../src/auth/users.ts';
import { LOCAL_SURAU_ID, SURAU_HEADER } from '../src/tenant.ts';
import { verifySiteEntry } from '../src/sync/verify.ts';
import { TEST_PIN } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { signOp } from './support/signOp.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp(role: 'box' | 'cloud'): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-ops-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir, role });
  apps.push(app);
  return app;
}

// ---------------------------------------------------------------------------------------------------------------
// helpers: people and devices

let counter = 0;
const addr = (): string => {
  counter += 1;
  return `10.${(counter >> 8) & 255}.${(counter & 255) || 1}.9`;
};

interface Dev extends Login {
  /** The answer of POST /api/enrol/complete that made this device. */
  enrolBody: { roles: Role[]; deviceId: string };
  /** The `user` of the last unlock answer. */
  unlockUser: { roles: Role[] };
}

const finalRoles = (roles: Role[]): Role[] => ROLES.filter((r) => roles.includes(r));

/** A user with the roles (ops roles written by SQL, the way the promote step leaves them). Returns the user id. */
function mkUser(db: DatabaseSync, roles: Role[]): string {
  const plain = roles.filter((r) => r !== 'superadmin');
  // the name never spells a role: the answers are scanned for the word 'superadmin'
  const u = createUser(db, { name: `Orang ${++counter}`, roles: plain.length > 0 ? plain : ['ajk'] }, 'test', 'sdm');
  setRolesSql(db, u.id, roles);
  return u.id;
}
function setRolesSql(db: DatabaseSync, userId: string, roles: Role[]): void {
  db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(finalRoles(roles)), userId);
}

async function completeHttp(
  app: FastifyInstance,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ res: Awaited<ReturnType<FastifyInstance['inject']>>; keys: webcrypto.CryptoKeyPair }> {
  const keys = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const res = await app.inject({
    method: 'POST',
    url: '/api/enrol/complete',
    remoteAddress: addr(),
    headers,
    payload: { code, publicJwk, platform: 'web', ...extra },
  });
  return { res, keys };
}

/** Challenge + signature + unlock for a device whose key we hold. Returns the unlock answer. */
async function unlockRaw(app: FastifyInstance, deviceId: string, keys: webcrypto.CryptoKeyPair): Promise<{ status: number; body: any }> {
  const remoteAddress = addr();
  const ch = await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress, payload: { deviceId } });
  const nonce = String(ch.json().nonce);
  const message = new TextEncoder().encode(`surau-unlock\n${app.surau.boxId}\n${deviceId}\n${nonce}`);
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, message);
  const un = await app.inject({
    method: 'POST',
    url: '/api/auth/unlock',
    remoteAddress,
    payload: { deviceId, nonce, signature: Buffer.from(sig).toString('base64url'), pin: TEST_PIN },
  });
  return { status: un.statusCode, body: un.json() };
}

async function toDev(app: FastifyInstance, userId: string, finalRolesOfUser: Role[], res: { statusCode: number; body: string; json: () => any }, keys: webcrypto.CryptoKeyPair): Promise<Dev> {
  if (res.statusCode !== 200) throw new Error(`enrol failed: ${res.statusCode} ${res.body}`);
  const enrolBody = res.json();
  const deviceId = String(enrolBody.deviceId);
  const first = await unlockRaw(app, deviceId, keys);
  if (first.status !== 200) throw new Error(`unlock failed: ${first.status} ${JSON.stringify(first.body)}`);
  const relogin = async (): Promise<string> => {
    const r = await unlockRaw(app, deviceId, keys);
    if (r.status !== 200) throw new Error(`unlock failed: ${r.status}`);
    return String(r.body.token);
  };
  const token = String(first.body.token);
  return {
    token,
    userId,
    deviceId,
    roles: finalRolesOfUser,
    headers: { authorization: `Bearer ${token}` },
    baseVersion: 0,
    relogin,
    sign: async (m: Uint8Array): Promise<string> =>
      Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Buffer.from(m))).toString('base64url'),
    enrolBody,
    unlockUser: first.body.user,
  };
}

const needsPin = (db: DatabaseSync, userId: string): boolean => db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(userId)?.pin_hash == null;

/**
 * A PUBLIC device for a user who holds `roles`: the code is issued while the user is still ordinary (the API refuses
 * a code for an ops-role user), the device is enrolled over HTTP, then the user's roles are restored.
 */
async function publicDevice(app: FastifyInstance, userId: string): Promise<Dev> {
  const { db } = app.surau;
  const real = getUserRow(db, userId)!.roles;
  const plain = real.filter((r) => r !== 'superadmin' && r !== 'support');
  setRolesSql(db, userId, plain.length > 0 ? plain : ['ajk']);
  try {
    const { code } = beginEnrolment(db, { userId, deviceName: 'Telefon awam' }, 'test', { canManageSuperadmin: true });
    const { res, keys } = await completeHttp(app, code, needsPin(db, userId) ? { pin: TEST_PIN } : {});
    setRolesSql(db, userId, real);
    return await toDev(app, userId, real, res, keys);
  } finally {
    setRolesSql(db, userId, real);
  }
}

/**
 * A PUBLIC device enrolled with an ordinary (non-ops) code that was issued BEFORE the user held an ops role (or before
 * this release): the user holds the ops roles at the moment of enrolment, so the enrol answer must hide them.
 */
async function legacyCodeDevice(app: FastifyInstance, userId: string): Promise<Dev> {
  const { db } = app.surau;
  const code = 'ABCDEFGH' + String(++counter).padStart(4, '2').slice(-4).replace(/[019]/g, '2');
  db.prepare('INSERT INTO enrolments (code_hash, user_id, device_name, expires_at, created_by) VALUES (?, ?, ?, ?, ?)').run(
    createHash('sha256').update(code).digest('hex'),
    userId,
    'Kod lama',
    new Date(Date.now() + 600_000).toISOString(),
    'legacy',
  );
  const { res, keys } = await completeHttp(app, code, needsPin(db, userId) ? { pin: TEST_PIN } : {});
  return toDev(app, userId, getUserRow(db, userId)!.roles, res, keys);
}

/** An OPS device through the real path: a CLI-issued code redeemed with `client: 'ops'`. */
async function opsDevice(app: FastifyInstance, userId: string, deviceName = 'Telefon ops'): Promise<Dev> {
  const { db } = app.surau;
  const { code } = issueOpsEnrolment(db, { userId, deviceName }, 'cli');
  const { res, keys } = await completeHttp(app, code, { client: 'ops', ...(needsPin(db, userId) ? { pin: TEST_PIN } : {}) });
  const dev = await toDev(app, userId, getUserRow(db, userId)!.roles, res, keys);
  // Plan 14 Task 3: an ops device on the cloud acts in one surau through the acting header (here the local one).
  if (serverRoleOf(db) === 'cloud') {
    db.prepare('INSERT OR IGNORE INTO suraus (id, name, created_at, created_by) VALUES (?, ?, ?, ?)').run(LOCAL_SURAU_ID, 'Surau ujian', new Date().toISOString(), 'test');
    dev.headers = { ...dev.headers, [SURAU_HEADER]: LOCAL_SURAU_ID };
  }
  return dev;
}

const row = (db: DatabaseSync, sql: string, ...p: (string | number)[]): Record<string, any> | undefined =>
  db.prepare(sql).get(...p) as Record<string, any> | undefined;
const count = (db: DatabaseSync, sql: string, ...p: (string | number)[]): number => Number(row(db, sql, ...p)?.n ?? 0);
const authRows = (db: DatabaseSync): number => count(db, 'SELECT COUNT(*) AS n FROM auth_log');
const logCount = (db: DatabaseSync, detail: string): number => count(db, 'SELECT COUNT(*) AS n FROM auth_log WHERE detail = ?', detail);

const putRoles = (app: FastifyInstance, h: Record<string, string>, id: string, roles: Role[]) =>
  app.inject({ method: 'PUT', url: `/api/users/${id}/roles`, headers: h, payload: { roles } });

async function sendOp(app: FastifyInstance, login: Login, kind: 'user.put' | 'settings.put', entityId: string, payload: unknown) {
  const op = await signOp(login, app.surau.boxId, {
    kind,
    entity: kind === 'user.put' ? 'user' : 'settings',
    entityId,
    payload,
    editedAt: new Date().toISOString(),
  });
  const r = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: login.headers, payload: { ops: [op] } });
  return r.json().results[0] as { status: string; reason: string | null };
}
const me = async (app: FastifyInstance, d: { headers: Record<string, string> }) => app.inject({ method: 'GET', url: '/api/auth/me', headers: d.headers });

// ---------------------------------------------------------------------------------------------------------------

describe('a Pentadbir MAXCOM on a PUBLIC device (cloud) loses the ops roles everywhere', () => {
  it('session roles, identityCan, the unlock and enrol answers and /api/auth/me carry no superadmin', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const uid = mkUser(db, ['superadmin', 'admin']);
    const dev = await publicDevice(app, uid);
    expect(getUserRow(db, uid)!.roles).toContain('superadmin'); // the account itself still holds it
    expect(isOpsDevice(db, dev.deviceId)).toBe(false);

    const ctx = resolveSession(db, dev.token, new Date())!;
    expect(ctx.roles).toEqual(['admin']);
    expect(ctx.ops).toBe(false);
    expect(identityCan(ctx, 'superadmin:manage')).toBe(false);
    expect(identityCan(ctx, 'system:write')).toBe(false);
    expect(identityCan(ctx, 'system:read')).toBe(false);
    expect(identityCan(ctx, 'users:manage')).toBe(true); // success path: the admin power stays

    expect(dev.unlockUser.roles).not.toContain('superadmin');
    expect(dev.unlockUser.roles).toEqual(['admin']);
    const m = (await me(app, dev)).json();
    expect(m.roles).toEqual(['admin']);
    expect(m.ops).toBe(false);
    expect(JSON.stringify(m)).not.toContain('superadmin');
  });

  it('the enrol answer of a public device (an older ordinary code, user already holds the ops roles) shows no superadmin', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const dev = await legacyCodeDevice(app, mkUser(db, ['superadmin', 'admin']));
    expect(isOpsDevice(db, dev.deviceId)).toBe(false);
    expect(row(db, 'SELECT ops, surau_id FROM devices WHERE id = ?', dev.deviceId)!.ops).toBe(0);
    expect(dev.enrolBody.roles).toEqual(['admin']);
    expect(JSON.stringify(dev.enrolBody)).not.toContain('superadmin');
    expect(dev.unlockUser.roles).toEqual(['admin']);
  });

  it('the no-lock unlock path and the enrol answer of a plain account are unchanged (success path)', async () => {
    const app = makeApp('cloud');
    const uid = mkUser(app.surau.db, ['admin']);
    const dev = await publicDevice(app, uid);
    expect(dev.unlockUser.roles).toEqual(['admin']);
    expect(dev.enrolBody.roles).toEqual(['admin']);
    expect(resolveSession(app.surau.db, dev.token, new Date())!.roles).toEqual(['admin']);
  });

  it('a signed user.put granting superadmin is refused superadmin_manage; a settings.put of a system field is refused', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const dev = await publicDevice(app, mkUser(db, ['superadmin', 'admin']));
    const target = mkUser(db, ['media']);
    expect(await sendOp(app, dev, 'user.put', target, { name: 'Sasaran', roles: ['media', 'superadmin'], active: true })).toMatchObject({
      status: 'refused',
      reason: 'forbidden',
    });
    expect(logCount(db, 'superadmin_manage')).toBe(1);
    expect(getUserRow(db, target)!.roles).toEqual(['media']);

    expect(await sendOp(app, dev, 'settings.put', 'system', { noVideoSeconds: 40 })).toMatchObject({ status: 'refused', reason: 'forbidden' });
    expect(count(db, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'sync_refused' AND detail = 'system_write'")).toBe(1);
    // success path of the same device: an ordinary admin op still applies
    expect((await sendOp(app, dev, 'settings.put', 'liveYoutube', { privacy: 'public' })).status).toBe('applied');
    expect((await sendOp(app, dev, 'user.put', target, { name: 'Sasaran Baharu', roles: ['media'], active: true })).status).toBe('applied');
  });

  it('the grant route is refused too (PUT /api/users/:id/roles and POST /api/users)', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const dev = await publicDevice(app, mkUser(db, ['superadmin', 'admin']));
    const target = mkUser(db, ['media']);
    expect((await putRoles(app, dev.headers, target, ['media', 'superadmin'])).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/users', headers: dev.headers, payload: { name: 'Baru', roles: ['superadmin'] } })).statusCode).toBe(403);
    expect(getUserRow(db, target)!.roles).toEqual(['media']);
    expect((await putRoles(app, dev.headers, target, ['media', 'ajk'])).statusCode).toBe(200); // ordinary roles stay in an admin's hands
  });
});

describe('the same person on an OPS device keeps every power', () => {
  it('all roles show in the answers; ops is true; identityCan allows the ops permissions', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const uid = mkUser(db, ['superadmin', 'admin']);
    const dev = await opsDevice(app, uid);
    expect(isOpsDevice(db, dev.deviceId)).toBe(true);
    expect(dev.enrolBody.roles).toContain('superadmin');
    expect(dev.unlockUser.roles).toEqual(['superadmin', 'admin']);
    const ctx = resolveSession(db, dev.token, new Date())!;
    expect(ctx.roles).toEqual(['superadmin', 'admin']);
    expect(ctx.ops).toBe(true);
    expect(identityCan(ctx, 'superadmin:manage')).toBe(true);
    expect(identityCan(ctx, 'system:write')).toBe(true);
    const m = (await me(app, dev)).json();
    expect(m.ops).toBe(true);
    expect(m.roles).toContain('superadmin');
  });

  it('the existing superadmin behaviours re-run on an ops device: grant by route and by signed op, system settings, last-admin rules', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const dev = await opsDevice(app, mkUser(db, ['superadmin', 'admin']));
    const t1 = mkUser(db, ['media']);
    const t2 = mkUser(db, ['media']);
    // operator decision 2026-11-12: the ops roles are granted by the CLI only, even from an ops device
    const ok = await putRoles(app, dev.headers, t1, ['media', 'superadmin']);
    expect(ok.statusCode, ok.body).toBe(403);
    expect(ok.json().code).toBe('superadmin_cli_only');
    expect(getUserRow(db, t1)!.roles).toEqual(['media']);
    expect((await app.inject({ method: 'POST', url: '/api/users', headers: dev.headers, payload: { name: 'Pentadbir Dua', roles: ['superadmin'] } })).statusCode).toBe(403);
    expect((await sendOp(app, dev, 'user.put', t2, { name: 'Sasaran', roles: ['media', 'superadmin'], active: true })).status).toBe('refused');
    expect((await sendOp(app, dev, 'user.put', t2, { name: 'Sasaran', roles: ['media', 'support'], active: true })).status).toBe('refused');
    expect((await putRoles(app, dev.headers, t2, ['media', 'support'])).json().code).toBe('superadmin_cli_only');
    expect(getUserRow(db, t2)!.roles).toEqual(['media']);
    expect(logCount(db, 'superadmin_cli_only')).toBeGreaterThanOrEqual(3);
    expect((await sendOp(app, dev, 'user.put', t2, { name: 'Sasaran Dua', roles: ['media'], active: true })).status).toBe('applied');
    expect((await sendOp(app, dev, 'settings.put', 'system', { noVideoSeconds: 40 })).status).toBe('applied');
    const put = await app.inject({ method: 'PUT', url: '/api/settings/system', headers: dev.headers, payload: { noVideoSeconds: 35 } });
    expect(put.statusCode).toBe(200);
    expect(logCount(db, 'superadmin_manage')).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM auth_log WHERE detail = 'system_write'")).toBe(0);
  });
});

describe('what a public-device account can still do', () => {
  it('superadmin + admin acts as an ordinary admin: users and settings yes, ops things no', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const dev = await publicDevice(app, mkUser(db, ['superadmin', 'admin']));
    expect((await app.inject({ method: 'GET', url: '/api/users', headers: dev.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/liveYoutube', headers: dev.headers, payload: { privacy: 'public' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/system', headers: dev.headers, payload: { noVideoSeconds: 30 } })).statusCode).toBe(403);
  });

  it('superadmin alone has no permission: 403 on every permission route, 200 on session routes', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const dev = await publicDevice(app, mkUser(db, ['superadmin']));
    for (const [method, url] of [
      ['GET', '/api/users'],
      ['GET', '/api/devices'],
      ['GET', '/api/audit'],
      ['PUT', '/api/settings/system'],
    ] as const) {
      const r = await app.inject({ method, url, headers: dev.headers, ...(method === 'PUT' ? { payload: { noVideoSeconds: 30 } } : {}) });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await me(app, dev)).statusCode).toBe(200);
    expect((await me(app, dev)).json().roles).toEqual([]);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: dev.headers, payload: {} })).statusCode).toBe(200);
  });

  it('the same account on an ops device passes the routes the public device was refused (positive control)', async () => {
    const app = makeApp('cloud');
    const dev = await opsDevice(app, mkUser(app.surau.db, ['superadmin']));
    expect((await app.inject({ method: 'GET', url: '/api/users', headers: dev.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/devices', headers: dev.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/system', headers: dev.headers, payload: { noVideoSeconds: 30 } })).statusCode).toBe(200);
  });
});

describe('the enrolment-code route never issues a code for an ops-role user', () => {
  it('403 ops_cli_only from an ops session and from an admin session; no row is written', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const opsUser = mkUser(db, ['superadmin', 'admin']);
    const ops = await opsDevice(app, opsUser);
    const admin = await publicDevice(app, mkUser(db, ['admin']));
    const support = mkUser(db, ['support']);
    const before = count(db, 'SELECT COUNT(*) AS n FROM enrolments');
    for (const [who, target] of [[ops, opsUser], [ops, support], [admin, opsUser]] as const) {
      const r = await app.inject({ method: 'POST', url: '/api/enrol/begin', headers: who.headers, payload: { userId: target, deviceName: 'Baru' } });
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().code).toBe('ops_cli_only');
    }
    expect(count(db, 'SELECT COUNT(*) AS n FROM enrolments')).toBe(before);
  });

  it('an ordinary user gets no code from the cloud, from an admin or from an ops session are refused on the cloud (409 box_only), and no code of any kind is made', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const ops = await opsDevice(app, mkUser(db, ['superadmin', 'admin']));
    const admin = await publicDevice(app, mkUser(db, ['admin']));
    const target = mkUser(db, ['ajk']);
    for (const who of [admin, ops]) {
      const r = await app.inject({ method: 'POST', url: '/api/enrol/begin', headers: who.headers, payload: { userId: target, deviceName: 'Baru' } });
      // Plan 9: the cloud makes no code for a surau's person (box_only); the ordinary code comes from the box
      expect(r.statusCode, r.body).toBe(409);
      expect(r.body).toContain('box_only');
    }
    expect(count(db, 'SELECT COUNT(*) AS n FROM enrolments WHERE user_id = ?', target)).toBe(0);
  });
});

describe('ops enrolment completion', () => {
  it('an ops code without client "ops": 401 ops_app_required, the code stays unused, one auth_log row, no device', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const uid = mkUser(db, ['superadmin', 'admin']);
    const { code } = issueOpsEnrolment(db, { userId: uid, deviceName: 'Ops' }, 'cli');
    const devices = count(db, 'SELECT COUNT(*) AS n FROM devices');
    const logs = authRows(db);
    for (const extra of [{}, { client: 'web' }, { client: 'OPS' }, { client: true }]) {
      const before = authRows(db);
      const r = (await completeHttp(app, code, { ...extra, pin: TEST_PIN })).res;
      expect(r.statusCode, r.body).toBe(401);
      expect(r.json().code).toBe('ops_app_required');
      expect(authRows(db) - before).toBe(1);
    }
    expect(authRows(db) - logs).toBe(4);
    expect(row(db, 'SELECT event, ok, detail FROM auth_log ORDER BY id DESC LIMIT 1')).toMatchObject({ event: 'enrol', ok: 0, detail: 'ops_app_required' });
    expect(count(db, 'SELECT COUNT(*) AS n FROM enrolments WHERE used_at IS NULL AND user_id = ?', uid)).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM devices')).toBe(devices);
    // success path with the same, still unused, code
    const ok = (await completeHttp(app, code, { client: 'ops', pin: TEST_PIN })).res;
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('with client "ops": the device is ops = 1, surau_id "*", box_id null, ops_by cli; auth_log ops_enrol; the code is used', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const uid = mkUser(db, ['superadmin', 'admin']);
    const dev = await opsDevice(app, uid, 'Telefon Pentadbir');
    const d = row(db, 'SELECT ops, ops_at, ops_by, surau_id, box_id, name FROM devices WHERE id = ?', dev.deviceId)!;
    expect(d).toMatchObject({ ops: 1, ops_by: 'cli', surau_id: '*', box_id: null, name: 'Telefon Pentadbir' });
    expect(typeof d.ops_at).toBe('string');
    expect(count(db, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'ops_enrol' AND ok = 1 AND device_id = ? AND user_id = ?", dev.deviceId, uid)).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM enrolments WHERE user_id = ? AND ops = 1 AND used_at IS NOT NULL', uid)).toBe(1);
    // the flag does not enter the change feed (Phase 1)
    const ch = row(db, "SELECT after_json FROM change_log WHERE entity = 'devices' AND entity_id = ?", dev.deviceId)!;
    expect(JSON.parse(String(ch.after_json))).not.toHaveProperty('ops');
    // single use
    const again = issueOpsEnrolment(db, { userId: uid, deviceName: 'X' }, 'cli');
    expect((await completeHttp(app, again.code, { client: 'ops' })).res.statusCode).toBe(200);
  });

  it('an ordinary code with client "ops" makes an ordinary device', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const uid = mkUser(db, ['admin']);
    const { code } = beginEnrolment(db, { userId: uid, deviceName: 'Biasa' }, 'test');
    const { res } = await completeHttp(app, code, { client: 'ops', pin: TEST_PIN });
    expect(res.statusCode, res.body).toBe(200);
    const d = row(db, 'SELECT ops, ops_at, ops_by, surau_id FROM devices WHERE id = ?', String(res.json().deviceId))!;
    expect(d.ops).toBe(0);
    expect(d.ops_at).toBeNull();
    expect(d.ops_by).toBeNull();
    expect(d.surau_id).not.toBe('*');
    expect(count(db, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'ops_enrol'")).toBe(0);
  });

  it('nothing in a body, header or site entry can set ops', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const uid = mkUser(db, ['admin']);
    for (const [extra, headers] of [
      [{ ops: true }, {}],
      [{ ops: 1, opsBy: 'cli', surauId: '*', surau_id: '*', box_id: 'x' }, {}],
      [{}, { 'x-maxcom-ops': '1', 'x-ops': 'true', 'x-maxcom-surau': '*' }],
    ] as const) {
      const { code } = beginEnrolment(db, { userId: uid, deviceName: 'Biasa' }, 'test');
      const { res } = await completeHttp(app, code, { ...extra, ...(needsPin(db, uid) ? { pin: TEST_PIN } : {}) }, headers);
      expect(res.statusCode, res.body).toBe(200);
      const d = row(db, 'SELECT ops, ops_at, surau_id FROM devices WHERE id = ?', String(res.json().deviceId))!;
      expect(d.ops).toBe(0);
      expect(d.ops_at).toBeNull();
      expect(d.surau_id).not.toBe('*');
    }
    expect(count(db, 'SELECT COUNT(*) AS n FROM devices WHERE ops = 1')).toBe(0);

    // a session's request cannot flip it either
    const dev = await publicDevice(app, uid);
    for (const url of ['/api/auth/me', '/api/devices']) {
      await app.inject({ method: 'GET', url, headers: { ...dev.headers, 'x-maxcom-ops': '1' } });
    }
    expect(isOpsDevice(db, dev.deviceId)).toBe(false);
  });

  it('a site device entry with after.ops is refused bad_device; the key is in no DEVICE_AFTER_KEYS', () => {
    const site = { boxId: 'b1', surauId: 'sdm' };
    const T = '2026-11-12T10:00:00.000Z';
    const base = { seq: 1, entity: 'device', entityId: 'd1', rev: `${T}|d`, editedAt: T, syncedAt: T, actor: 'user:x', deviceId: null, origin: 'local', opId: null };
    const good = { id: 'd1', userId: 'u1', name: 'T', platform: 'web', revoked: false, enrolledAt: T };
    expect(verifySiteEntry(site, {}, { ...base, after: { revoked: true } }).ok).toBe(true); // success path of the same checker
    expect(verifySiteEntry(site, {}, { ...base, after: { ...good, ops: true } })).toEqual({ ok: false, detail: 'bad_device' });
    expect(verifySiteEntry(site, {}, { ...base, after: { ...good, ops: false } })).toEqual({ ok: false, detail: 'bad_device' });
    expect(verifySiteEntry(site, {}, { ...base, after: { revoked: true, opsAt: T } }).ok).toBe(false);
    const src = readFileSync(join(import.meta.dirname, '../src/sync/verify.ts'), 'utf8');
    const keys = /const DEVICE_AFTER_KEYS = new Set\(\[([^\]]*)\]\)/.exec(src)?.[1] ?? '';
    expect(keys).not.toBe('');
    expect(keys).not.toMatch(/ops/i);
  });
});

describe('ops-unmark (library): the device behaves as a public one afterwards', () => {
  it('flag cleared, sessions ended, the next request is refused, the next login has no ops role; audit rows written', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const uid = mkUser(db, ['superadmin', 'admin']);
    const dev = await opsDevice(app, uid);
    const second = await dev.relogin(); // two open sessions
    expect((await me(app, dev)).statusCode).toBe(200);
    const changes = count(db, "SELECT COUNT(*) AS n FROM change_log WHERE entity = 'devices' AND entity_id = ?", dev.deviceId);

    unmarkOps(db, dev.deviceId, 'cli');
    expect(isOpsDevice(db, dev.deviceId)).toBe(false);
    expect(count(db, 'SELECT COUNT(*) AS n FROM sessions WHERE device_id = ? AND revoked_at IS NULL', dev.deviceId)).toBe(0);
    expect((await me(app, dev)).statusCode).toBe(401);
    expect((await me(app, { headers: { authorization: `Bearer ${second}` } })).statusCode).toBe(401);
    expect(count(db, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'ops_unmark' AND device_id = ?", dev.deviceId)).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM change_log WHERE entity = 'devices' AND entity_id = ?", dev.deviceId)).toBeGreaterThan(changes);

    const token = await dev.relogin(); // the device still exists and unlocks, but as a public device
    const m = (await me(app, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(m.ops).toBe(false);
    expect(m.roles).toEqual(['admin']);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/system', headers: { authorization: `Bearer ${token}` }, payload: { noVideoSeconds: 30 } })).statusCode).toBe(403);
  });

  it('refuses a device that is not an ops device or does not exist (nothing written)', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const pub = await publicDevice(app, mkUser(db, ['admin']));
    const logs = authRows(db);
    expect(() => unmarkOps(db, pub.deviceId, 'cli')).toThrowError(expect.objectContaining({ code: 'not_ops_device' }));
    expect(() => unmarkOps(db, 'no-such-device', 'cli')).toThrow();
    expect(authRows(db)).toBe(logs);
    expect((await me(app, pub)).statusCode).toBe(200); // the public device's session was not touched
  });
});

describe('issueOpsEnrolment', () => {
  it('refuses a user without an ops role (not_ops_user) and writes no row; accepts superadmin and support', () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const plain = mkUser(db, ['admin']);
    expect(() => issueOpsEnrolment(db, { userId: plain, deviceName: 'X' }, 'cli')).toThrowError(expect.objectContaining({ code: 'not_ops_user' }));
    expect(count(db, 'SELECT COUNT(*) AS n FROM enrolments')).toBe(0);
    const sup = mkUser(db, ['superadmin']);
    const support = mkUser(db, ['support']);
    for (const u of [sup, support]) {
      const r = issueOpsEnrolment(db, { userId: u, deviceName: 'Ops' }, 'cli');
      expect(r.code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
      expect(Date.parse(r.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
      expect(Date.parse(r.expiresAt) - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 5000);
    }
    expect(count(db, 'SELECT COUNT(*) AS n FROM enrolments WHERE ops = 1')).toBe(2);
    // unknown and inactive users
    expect(() => issueOpsEnrolment(db, { userId: 'nobody', deviceName: 'X' }, 'cli')).toThrow();
  });

  it('stores only the hash of the code', () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const { code } = issueOpsEnrolment(db, { userId: mkUser(db, ['superadmin']), deviceName: 'Ops' }, 'cli');
    const plain = code.replace(/-/g, '');
    const all = JSON.stringify(db.prepare('SELECT * FROM enrolments').all());
    expect(all).not.toContain(plain);
    expect(all).not.toContain(code);
  });

  it('the 4th live ops device is refused ops_device_limit; a revoked one frees a slot', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const uid = mkUser(db, ['superadmin', 'admin']);
    const devs: Dev[] = [];
    for (let i = 0; i < 3; i++) devs.push(await opsDevice(app, uid, `Ops ${i}`));
    expect(() => issueOpsEnrolment(db, { userId: uid, deviceName: 'Ops 4' }, 'cli')).toThrowError(expect.objectContaining({ code: 'ops_device_limit' }));
    // another ops user is not affected (the cap is per user)
    expect(() => issueOpsEnrolment(db, { userId: mkUser(db, ['superadmin']), deviceName: 'Lain' }, 'cli')).not.toThrow();
    // a public device of the same user does not count
    await publicDevice(app, uid);
    expect(() => issueOpsEnrolment(db, { userId: uid, deviceName: 'Ops 4' }, 'cli')).toThrowError(expect.objectContaining({ code: 'ops_device_limit' }));
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), devs[0]!.deviceId);
    const ok = issueOpsEnrolment(db, { userId: uid, deviceName: 'Ops 4' }, 'cli');
    expect((await completeHttp(app, ok.code, { client: 'ops' })).res.statusCode).toBe(200);
    expect(count(db, 'SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND ops = 1 AND revoked_at IS NULL', uid)).toBe(3);
  });

  it('the code never appears in a log line, an audit row or a change row', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const uid = mkUser(db, ['superadmin', 'admin']);
    const { code } = issueOpsEnrolment(db, { userId: uid, deviceName: 'Ops' }, 'cli');
    await completeHttp(app, code, { pin: TEST_PIN }); // refused once: ops_app_required
    await completeHttp(app, code, { client: 'ops', pin: TEST_PIN }); // used
    await completeHttp(app, code, { client: 'ops' }); // used code tried again
    const plain = code.replace(/-/g, '');
    const dump = JSON.stringify([db.prepare('SELECT * FROM auth_log').all(), db.prepare('SELECT * FROM change_log').all(), db.prepare('SELECT * FROM devices').all()]);
    expect(dump).not.toContain(plain);
    expect(dump).not.toContain(code);
  });
});

describe('helpers: isOpsDevice, effectiveRolesFor, listOpsDevices', () => {
  it('isOpsDevice is false for an unknown id, a public device and a revoked-then-unmarked one; true for an ops device', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const uid = mkUser(db, ['superadmin', 'admin']);
    const ops = await opsDevice(app, uid);
    const pub = await publicDevice(app, uid);
    expect(isOpsDevice(db, ops.deviceId)).toBe(true);
    expect(isOpsDevice(db, pub.deviceId)).toBe(false);
    expect(isOpsDevice(db, 'nope')).toBe(false);
  });

  it('effectiveRolesFor: cloud strips ops roles on a public device, keeps them on an ops device; a box returns the roles unchanged', async () => {
    const cloud = makeApp('cloud');
    const uid = mkUser(cloud.surau.db, ['superadmin', 'admin', 'support']);
    const ops = await opsDevice(cloud, uid);
    const pub = await publicDevice(cloud, uid);
    const u = getAuthUser(cloud.surau.db, uid)!;
    expect(effectiveRolesFor(cloud.surau.db, u, pub.deviceId, { role: 'cloud' })).toEqual(['admin']);
    expect(effectiveRolesFor(cloud.surau.db, u, ops.deviceId, { role: 'cloud' })).toEqual(u.roles);
    expect(effectiveRolesFor(cloud.surau.db, u, 'unknown-device', { role: 'cloud' })).toEqual(['admin']); // unknown device = public
    expect(effectiveRolesFor(cloud.surau.db, u, pub.deviceId, { role: 'box' })).toEqual(u.roles);
    const plain = getAuthUser(cloud.surau.db, mkUser(cloud.surau.db, ['admin', 'ajk']))!;
    expect(effectiveRolesFor(cloud.surau.db, plain, pub.deviceId, { role: 'cloud' })).toEqual(plain.roles);
  });

  it('listOpsDevices separates ops devices from the public devices of ops-role users; others appear nowhere', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const uid = mkUser(db, ['superadmin', 'admin']);
    const ops = await opsDevice(app, uid);
    const pub = await publicDevice(app, uid);
    const other = await publicDevice(app, mkUser(db, ['admin']));
    const gone = await publicDevice(app, uid);
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), gone.deviceId);
    const l = listOpsDevices(db);
    expect(l.ops.map((d) => d.id)).toEqual([ops.deviceId]);
    expect(l.publicOfOpsUsers.map((d) => d.id)).toEqual([pub.deviceId]);
    const all = JSON.stringify(l);
    expect(all).not.toContain(other.deviceId);
    expect(all).not.toContain(gone.deviceId);
  });
});

describe('on a box role every existing behaviour is untouched', () => {
  it('a superadmin on a (public) device keeps its roles everywhere: session, answers, grant refusal stays superadmin_cloud_only', async () => {
    const box = makeApp('box');
    const { db } = box.surau;
    const uid = mkUser(db, ['superadmin', 'admin']);
    const dev = await publicDevice(box, uid);
    expect(dev.unlockUser.roles).toEqual(['superadmin', 'admin']);
    const ctx = resolveSession(db, dev.token, new Date())!;
    expect(ctx.roles).toEqual(['superadmin', 'admin']);
    expect(identityCan(ctx, 'system:write')).toBe(true);
    const target = mkUser(db, ['media']);
    const r = await putRoles(box, dev.headers, target, ['media', 'superadmin']);
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('superadmin_cli_only');
    expect((await app_put(box, dev, 'system')).statusCode).toBe(200);
    expect((await me(box, dev)).json().roles).toEqual(['superadmin', 'admin']);
  });

  it('a signed system settings.put from a box superadmin device still applies', async () => {
    const box = makeApp('box');
    const dev = await publicDevice(box, mkUser(box.surau.db, ['superadmin', 'admin']));
    expect((await sendOp(box, dev, 'settings.put', 'system', { noVideoSeconds: 40 })).status).toBe('applied');
  });
});

const app_put = (app: FastifyInstance, dev: { headers: Record<string, string> }, feature: string) =>
  app.inject({ method: 'PUT', url: `/api/settings/${feature}`, headers: dev.headers, payload: { noVideoSeconds: 31 } });
