import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SURAU_ID_RE, parseRef } from '@surau/core';
import type { Role } from '@surau/core';
import { pkiStatus } from '../tls.ts';
import { boxNameOf, lanIpv4Of } from '../boxName.ts';
import type { TlsMaterial } from '../tls.ts';
import { surauPublicInfo } from '../settingsStore.ts';
import { reqSurau } from '../reqSurau.ts';
import { LOCAL_SURAU_ID, SURAU_HEADER } from '../tenant.ts';
import { identityCan, tooMany } from './authz.ts';
import type { AuthContext, Limiters } from './authz.ts';
import { appLockEnabled, appLockRequiredFor } from './appLock.ts';
import { pinPepperOf, verifyPin } from './crypto.ts';
import { approvePairing, beginPairing, buildKioskCookie, listPendingPairings, pollPairing } from './pairing.ts';
import { createRateLimiter } from './ratelimit.ts';
import { adminPhoneGuard, beginEnrolment, completeEnrolmentAsync, deactivateUserGuarded, deleteUserGuarded, getDeviceInTenant, getDeviceWithKey, listDevices, renameDevice, revokeDeviceGuarded } from './devices.ts';
import { holdsOpsRole } from './opsDevice.ts';
import { isIdleDevice, peopleActivity } from './activity.ts';
import { globalRefMap, refLookup, refOfRow } from './ids.ts';
import { enrolCloudOrigin } from '../sync/sites.ts';
import type { User } from './users.ts';
import { issueRecoveryCode, recoveryCodeExists } from '../setup/codes.ts';
import { leaveDevice } from './leave.ts';
import { authLog, issueChallenge, revokeSession, unlock } from './sessions.ts';
import type { UnlockInput } from './sessions.ts';
import {
  AuthError,
  MSG,
  activeAdminCount,
  serverRoleOf,
  activeSuperadminCount,
  bumpFor,
  checkRoles,
  createUser,
  activateUser,
  deviceSurau,
  announceSurau,
  getAuthUser,
  getUserInTenant,
  isStarUser,
  listUsers,
  notStarChangeSql,
  renameUser,
  restoreUser,
  checkOptionalPhone,
  setUserPhone,
  logChange,
  requireSuperadminTarget,
  revokeDeviceRow,
  setPin,
  setRoles,
  tx,
  unlockUserPin,
  userSurau,
} from './users.ts';

export interface AuthRouteDeps {
  db: DatabaseSync;
  boxId: string;
  dataDir: string;
  now: () => Date;
  limiters: Limiters;
  tls: TlsMaterial | null;
  /** The live TLS material: follows a certificate reload. Defaults to `tls`. */
  tlsNow?: () => TlsMaterial | null;
  httpsPort: number;
  /** Which side this server is: the cloud makes no device codes for a surau's people. Defaults to the box. */
  role?: 'box' | 'cloud';
}

/** Routes that only ever take a few short fields refuse bigger bodies (the app-wide limit is 2 MB). */
const SMALL_BODY = { bodyLimit: 8 * 1024 } as const;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function userOf(request: FastifyRequest): AuthContext {
  const a = request.auth;
  if (a === null || a.kind !== 'user') throw new AuthError(401, 'no_session', MSG.sessionExpired);
  return a;
}

function body(request: FastifyRequest): Record<string, unknown> {
  if (!isPlain(request.body)) throw new AuthError(400, 'bad_body', 'Permintaan tidak sah');
  return request.body;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** SHA-256 (hex) of the root CA certificate (DER or PEM) in `<dataDir>/pki`, or null. */
export function rootCaFingerprint(dataDir: string): string | null {
  const path = join(dataDir, 'pki', 'root-ca.cer');
  if (!existsSync(path)) return null;
  try {
    const bytes = readFileSync(path);
    const der = bytes.includes('BEGIN CERTIFICATE') ? new X509Certificate(bytes).raw : bytes;
    return createHash('sha256').update(der).digest('hex');
  } catch {
    return null;
  }
}

/** Granting or taking away the Pentadbir MAXCOM role needs `superadmin:manage`, whatever else the caller may do. */
function requireSuperadminManage(request: FastifyRequest, before: readonly string[], after: readonly string[]): void {
  if (before.includes('superadmin') === after.includes('superadmin')) return;
  if (!identityCan(request.auth, 'superadmin:manage')) throw new AuthError(403, 'forbidden', MSG.forbidden);
}

/**
 * Operator decision 2026-11-12: Pentadbir MAXCOM is one person and the `superadmin` and `support` roles are granted or
 * removed only by the CLI, never through the API, even by a superadmin on an ops device. One auth_log row per refusal.
 */
function requireOpsRolesCliOnly(db: DatabaseSync, request: FastifyRequest, before: readonly string[], after: readonly string[]): void {
  const changed = ['superadmin', 'support'].some((r) => before.includes(r) !== after.includes(r));
  if (!changed) return;
  const a = request.auth;
  authLog(db, new Date(), 'role_refused', false, {
    userId: a?.kind === 'user' ? a.userId : null,
    deviceId: a?.kind === 'user' ? a.deviceId : null,
    detail: 'superadmin_cli_only',
  });
  throw new AuthError(403, 'superadmin_cli_only', 'Peranan ini hanya boleh diurus melalui CLI MAXCOM');
}

/** Whether a user (as listed for the tenant) is one of the surau's administrators: a Pentadbir MAXCOM is, on a box only. */
const countsAsSurauAdmin = (db: DatabaseSync, roles: readonly string[]): boolean =>
  roles.includes('admin') || (roles.includes('superadmin') && serverRoleOf(db) === 'box');

/** The target of an action holds the Pentadbir MAXCOM role: the caller needs `superadmin:manage` for any change. */
function guardTarget(db: DatabaseSync, request: FastifyRequest, targetUserId: string): void {
  requireSuperadminTarget(db, targetUserId, identityCan(request.auth, 'superadmin:manage'));
}

const ENROL_TTLS: readonly number[] = [10, 30, 60];

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { db, boxId, dataDir, now, limiters } = deps;
  const actor = (request: FastifyRequest): string => `user:${userOf(request).userId}`;
  /** The roles stored for the user (not the session's effective roles): for the PIN rule and replicated rows. */
  const realRoles = (userId: string): Role[] => getAuthUser(db, userId)?.roles ?? [];
  /** Only an ops-device session may see or touch the Pentadbir MAXCOM rows (operator decisions 21 and 22). */
  const opsSession = (request: FastifyRequest): boolean => request.auth != null && request.auth.kind === 'user' && request.auth.ops === true;
  const refuseStar = (request: FastifyRequest, detail: string): void => {
    const a = request.auth != null && request.auth.kind === 'user' ? request.auth : null;
    authLog(db, now(), 'star_target_refused', false, { userId: a?.userId ?? null, deviceId: a?.deviceId ?? null, ip: request.ip, detail });
  };
  /**
   * A user of the caller's surau; any other id does not exist for this caller, and neither does a Pentadbir MAXCOM
   * (`*`) unless the session is an ops device: the same 404 as an unknown id, with one auth_log row when it was one.
   */
  const tenantUser = (request: FastifyRequest, id: string): User => {
    const u = getUserInTenant(db, id, reqSurau(request), opsSession(request));
    if (u === undefined) {
      if (isStarUser(db, id)) refuseStar(request, 'star_user');
      throw new AuthError(404, 'not_found', 'Tidak dijumpai');
    }
    return u;
  };
  /** The scope the PIN rule and the app lock of a device read: its surau (the local one for an ops device). */
  const lockScopeOfDevice = (deviceId: string): string => announceSurau(deviceSurau(db, deviceId));

  // ---- public, rate limited ----

  const limitAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const ip = limiters.authIp.hit(request.ip);
    if (!ip.ok) return tooMany(reply, ip.retryAfterSec);
    const deviceId = isPlain(request.body) ? str(request.body.deviceId) : '';
    if (deviceId.length > 0 && deviceId.length <= 100) {
      const dev = limiters.authDevice.hit(deviceId);
      if (!dev.ok) return tooMany(reply, dev.retryAfterSec);
    }
    return undefined;
  };

  app.post('/api/enrol/complete', {
    ...SMALL_BODY,
    preHandler: async (request, reply) => {
      const hit = limiters.enrolIp.hit(request.ip);
      return hit.ok ? undefined : tooMany(reply, hit.retryAfterSec);
    },
  }, async (request) => {
    const b = body(request);
    return completeEnrolmentAsync(
      db,
      {
        code: str(b.code),
        publicJwk: b.publicJwk as never,
        platform: str(b.platform),
        ...(typeof b.deviceName === 'string' ? { deviceName: b.deviceName } : {}),
        ...(b.pin !== undefined ? { pin: str(b.pin) } : {}),
        // the ops build's mistake guard: exactly the string 'ops', nothing else is forwarded
        ...(b.client === 'ops' ? { client: 'ops' as const } : {}),
      },
      request.ip,
    );
  });

  app.post('/api/auth/challenge', { ...SMALL_BODY, preHandler: limitAuth }, async (request) => {
    const b = body(request);
    const { nonce, expiresAt } = issueChallenge(db, str(b.deviceId), now());
    // Only a live, enrolled device gets an answer at all, so this tells an outsider nothing.
    // The Pentadbir MAXCOM's device always asks for a PIN: tell it so even when the surau lock is off.
    const dev = getDeviceWithKey(db, str(b.deviceId));
    const roles = dev === undefined ? [] : getAuthUser(db, dev.userId)?.roles ?? [];
    return { nonce, expiresAt, appLock: appLockRequiredFor(db, roles, dev === undefined ? LOCAL_SURAU_ID : lockScopeOfDevice(dev.id)) };
  });

  app.post('/api/auth/unlock', { ...SMALL_BODY, preHandler: limitAuth }, async (request, reply) => {
    const b = body(request);
    const input: UnlockInput = { deviceId: str(b.deviceId), nonce: str(b.nonce), signature: str(b.signature), pin: str(b.pin) };
    if (b.newPin !== undefined) input.newPin = str(b.newPin);
    reply.header('Cache-Control', 'no-store');
    try {
      return await unlock(db, boxId, input, request.ip, now());
    } catch (error) {
      // Reached only after the device signature verified: tells the app to ask for a new PIN.
      if (error instanceof AuthError && error.code === 'pin_required') {
        return reply.code(409).send({ errors: [error.message], pinRequired: true });
      }
      throw error;
    }
  });

  // ---- kiosk pairing ----

  const approveLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 10 });

  app.post('/api/kiosk/pair/begin', {
    ...SMALL_BODY,
    preHandler: async (request, reply) => {
      const hit = limiters.pairBegin.hit(request.ip);
      return hit.ok ? undefined : tooMany(reply, hit.retryAfterSec);
    },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return beginPairing(db, request.ip, now());
  });

  app.post('/api/kiosk/pair/poll', SMALL_BODY, async (request, reply) => {
    const b = body(request);
    const out = pollPairing(db, b.pollToken, now());
    reply.header('Cache-Control', 'no-store');
    if (out.status === 'pending') return out;
    const secure = (request.raw.socket as { encrypted?: boolean }).encrypted === true;
    reply.header('Set-Cookie', buildKioskCookie(out.cookieToken, secure));
    return { status: 'approved' };
  });

  app.post('/api/kiosk/pair/approve', SMALL_BODY, async (request, reply) => {
    const a = userOf(request);
    const hit = approveLimiter.hit(a.userId);
    if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
    const b = body(request);
    const out = approvePairing(db, { code: b.code, deviceName: b.deviceName }, a.userId, actor(request), now(), reqSurau(request));
    reply.header('Cache-Control', 'no-store');
    return { ok: true, deviceId: out.deviceId, name: out.name, requesterIp: out.requesterIp, codeAgeSeconds: out.codeAgeSeconds };
  });

  // Where the waiting codes came from and how old they are (the codes themselves are never listed).
  app.get('/api/kiosk/pair/pending', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { pairings: listPendingPairings(db, now()) };
  });

  // ---- any signed-in user ----

  app.post('/api/auth/logout', SMALL_BODY, async (request) => {
    revokeSession(db, userOf(request).sessionId);
    return { ok: true };
  });

  // A phone leaves its surau (revokes its own device); the last Pentadbir device may not.
  app.post('/api/auth/leave', SMALL_BODY, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    leaveDevice(db, userOf(request), now());
    return { ok: true };
  });

  // A signed-in person names their own phone: exactly the device of this session, never another.
  app.put('/api/auth/device/name', SMALL_BODY, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const a = userOf(request);
    const hit = limiters.deviceName.hit(a.userId);
    if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
    const b = body(request);
    return { ok: true, device: renameDevice(db, a.deviceId, b.name as string, actor(request)) };
  });

  app.get('/api/auth/me', async (request) => {
    const a = userOf(request);
    const user = db.prepare('SELECT id, name, no, no_src, phone FROM users WHERE id = ?').get(a.userId);
    const device = db.prepare('SELECT id, name, platform, no, no_src FROM devices WHERE id = ?').get(a.deviceId);
    const session = db.prepare('SELECT expires_at FROM sessions WHERE id = ?').get(a.sessionId);
    // Plan 14 Task 10: the surau this session works in, and its scope. Only an ops-device session on the cloud sees
    // every surau (`all`) and acts for the one its X-Maxcom-Surau header names; every other session (a surau role, a
    // Pentadbir MAXCOM on a public device, any box session) is its device's own surau, whatever header it sends.
    const cloud = serverRoleOf(db) === 'cloud';
    const scope: 'surau' | 'all' = cloud && a.ops === true ? 'all' : 'surau';
    let surauId: string | null = LOCAL_SURAU_ID;
    if (cloud && scope === 'all') {
      const h = request.headers[SURAU_HEADER];
      surauId = typeof h === 'string' && SURAU_ID_RE.test(h) && db.prepare('SELECT 1 AS x FROM suraus WHERE id = ?').get(h) !== undefined ? h : null;
    } else if (cloud) {
      const own = db.prepare('SELECT surau_id FROM devices WHERE id = ?').get(a.deviceId)?.surau_id;
      surauId = typeof own === 'string' && SURAU_ID_RE.test(own) ? own : null;
    }
    const surauName = (id: string): string => {
      const row = db.prepare('SELECT name FROM suraus WHERE id = ?').get(id);
      return row !== undefined ? String(row.name) : surauPublicInfo(db, now(), id).name;
    };
    return {
      user: { id: String(user?.id), name: String(user?.name), ref: user === undefined ? null : refOfRow(user, 'user'), phone: typeof user?.phone === 'string' ? user.phone : null },
      device: { id: String(device?.id), name: String(device?.name), platform: String(device?.platform), ref: device === undefined ? null : refOfRow(device, 'device') },
      // the effective roles only: a public app never learns the account holds an ops role
      roles: a.roles,
      ops: a.ops,
      surau: surauId === null ? null : { id: surauId, name: surauName(surauId) },
      // the cloud has shut this surau out (every other call answers 403 surau_suspended); a box never is
      suspended: cloud && surauId !== null && db.prepare('SELECT 1 AS x FROM suraus WHERE id = ? AND suspended_at IS NOT NULL').get(surauId) !== undefined,
      scope,
      expiresAt: String(session?.expires_at),
      // the PIN rule reads the real roles (a Pentadbir MAXCOM keeps it on a public device too)
      appLock: appLockRequiredFor(db, realRoles(a.userId), lockScopeOfDevice(a.deviceId)),
    };
  });

  app.put('/api/auth/pin', SMALL_BODY, async (request, reply) => {
    const a = userOf(request);
    // With the lock off there is no PIN to change; refuse before any rate-limit hit or PIN check.
    if (!appLockRequiredFor(db, realRoles(a.userId), lockScopeOfDevice(a.deviceId))) throw new AuthError(409, 'app_lock_off', MSG.appLockOff);
    const b = body(request);
    const currentPin = str(b.currentPin);
    const newPin = str(b.newPin);
    if (currentPin === '' || newPin === '') throw new AuthError(400, 'bad_body', 'PIN semasa dan PIN baharu diperlukan');
    // Every check of the current PIN counts, so a stolen unlocked device cannot guess it.
    const hit = limiters.pinChange.hit(a.userId);
    if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
    const user = getAuthUser(db, a.userId);
    if (user === undefined || !user.active) throw new AuthError(401, 'no_session', MSG.sessionExpired);
    if (user.pinLockedUntil !== null && user.pinLockedUntil > now().toISOString()) {
      const secs = Math.max(60, Math.ceil((Date.parse(user.pinLockedUntil) - now().getTime()) / 1000));
      throw new AuthError(423, 'locked', MSG.locked(Math.ceil(secs / 60)), secs);
    }
    if (user.pinHash === null || !(await verifyPin(currentPin, user.pinHash, pinPepperOf(db)))) {
      throw new AuthError(401, 'wrong_pin', MSG.wrongPin);
    }
    await setPin(db, a.userId, newPin, actor(request));
    return { ok: true };
  });

  // ---- users (users:manage) ----

  app.get('/api/users', async (request) => {
    const users = listUsers(db, reqSurau(request), opsSession(request));
    if (!opsSession(request)) return { users };
    const g = globalRefMap(db, 'user');
    return { users: users.map((u) => ({ ...u, globalRef: g.get(u.id) ?? null })) };
  });

  app.post('/api/users', SMALL_BODY, async (request, reply) => {
    const b = body(request);
    if (Array.isArray(b.roles)) {
      requireSuperadminManage(request, [], b.roles as string[]);
      requireOpsRolesCliOnly(db, request, [], b.roles as string[]);
    }
    // The phone number is optional: absent, null or blank adds the person with none. A given one is E.164 (Malaysia by
    // default) and a refusal never echoes it.
    const phone = checkOptionalPhone(b.phone);
    const user = createUser(db, { name: str(b.name), roles: b.roles as Role[], phone }, actor(request), reqSurau(request));
    return reply.code(201).send(user);
  });

  app.put('/api/users/:id/roles', SMALL_BODY, async (request) => {
    const { id } = request.params as { id: string };
    const b = body(request);
    const roles = checkRoles(b.roles);
    const target = tenantUser(request, id);
    guardTarget(db, request, id);
    requireSuperadminManage(request, target.roles, roles);
    requireOpsRolesCliOnly(db, request, target.roles, roles);
    const keepsAdmin = roles.includes('admin') || roles.includes('superadmin');
    if (target.active && countsAsSurauAdmin(db, target.roles) && !keepsAdmin && activeAdminCount(db, reqSurau(request)) <= 1) {
      throw new AuthError(409, 'last_admin', 'Mesti ada sekurang-kurangnya seorang pentadbir aktif');
    }
    return setRoles(db, id, roles as Role[], actor(request));
  });

  // Nombor telefon: Pentadbir only (users:manage). A null or blank `phone` clears the number; a body without the key
  // is refused, so an empty request never erases a number. 400 bad_phone, 409 phone_taken with the other person's ID only.
  app.put('/api/users/:id/phone', SMALL_BODY, async (request) => {
    const { id } = request.params as { id: string };
    const b = body(request);
    if (!Object.hasOwn(b, 'phone')) throw new AuthError(400, 'bad_phone', 'Nombor telefon tidak sah');
    tenantUser(request, id);
    guardTarget(db, request, id);
    return setUserPhone(db, id, b.phone, actor(request));
  });

  app.put('/api/users/:id/name', SMALL_BODY, async (request) => {
    const { id } = request.params as { id: string };
    const b = body(request);
    tenantUser(request, id);
    guardTarget(db, request, id);
    return renameUser(db, id, b.name as string, actor(request));
  });

  /**
   * Admin PIN reset. Body (optional): { revokeDeviceIds: string[] } - devices of THIS user to
   * revoke in the same step. A device that is still enrolled can set the new PIN on the next
   * unlock, so a lost phone must be revoked before (or with) the reset. The answer lists the
   * user's remaining active devices so the admin sees what can still set a PIN.
   */
  app.put('/api/users/:id/pin', SMALL_BODY, async (request) => {
    const { id } = request.params as { id: string };
    const by = actor(request);
    const rawIds = isPlain(request.body) ? request.body.revokeDeviceIds : undefined;
    if (rawIds !== undefined && (!Array.isArray(rawIds) || rawIds.length > 50 || !rawIds.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 100))) {
      throw new AuthError(400, 'bad_body', 'Permintaan tidak sah');
    }
    const revokeIds = [...new Set((rawIds ?? []) as string[])];
    const surauId = reqSurau(request);
    tenantUser(request, id);
    guardTarget(db, request, id);
    const revoked: string[] = [];
    tx(db, () => {
      const before = getAuthUser(db, id);
      if (before === undefined) throw new AuthError(404, 'user_not_found', 'Pengguna tidak dijumpai');
      const owned = new Set(listDevices(db, id, undefined, surauId).map((d) => d.id));
      if (!revokeIds.every((d) => owned.has(d))) throw new AuthError(400, 'bad_device', 'Peranti tidak sah untuk pengguna ini');
      const nowIso = new Date().toISOString();
      const phoneLeft = adminPhoneGuard(db, surauId);
      for (const d of revokeIds) if (revokeDeviceRow(db, d, by, nowIso)) revoked.push(d);
      phoneLeft();
      const snap = { id: before.id, name: before.name, roles: before.roles, active: before.active };
      db.prepare(
        'UPDATE users SET pin_hash = NULL, pin_fail_count = 0, pin_locked_until = NULL, lock_round = 0 WHERE id = ?',
      ).run(id);
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(nowIso, id);
      logChange(db, by, 'users', id, { ...snap, hasPin: before.pinHash !== null }, { ...snap, hasPin: false, pinReset: true }, undefined, userSurau(db, id));
      bumpFor(db, userSurau(db, id));
    });
    const devices = listDevices(db, id, undefined, surauId).filter((d) => d.platform !== 'kiosk');
    return { ok: true, pinRequired: true, revoked, devices };
  });

  // Buka kunci: clears the wrong-PIN count and the lock; the PIN stays.
  app.post('/api/users/:id/unlock', SMALL_BODY, async (request) => {
    const { id } = request.params as { id: string };
    tenantUser(request, id);
    guardTarget(db, request, id);
    const was = unlockUserPin(db, id, actor(request));
    if (was) authLog(db, now(), 'pin_unlock', true, { userId: id, ip: request.ip, detail: `by:${userOf(request).userId}` });
    return { ok: true };
  });

  // Aktifkan semula: the person is active again with no devices; they enrol again with a new code.
  app.post('/api/users/:id/activate', SMALL_BODY, async (request) => {
    const { id } = request.params as { id: string };
    tenantUser(request, id);
    guardTarget(db, request, id);
    return activateUser(db, id, actor(request));
  });

  // Padam: a soft delete. The body must carry the person's ID (`ref`), compared here against the row the id names, so a
  // wrong row can never be deleted by a list position or a similar name. For a person who still has no ID the body
  // carries the user's own id instead.
  app.post('/api/users/:id/delete', SMALL_BODY, async (request) => {
    const { id } = request.params as { id: string };
    const target = tenantUser(request, id);
    // A Pentadbir MAXCOM or Sokongan MAXCOM is never deleted through the API, not even from an ops session (CLI only).
    if (target.deleted || isStarUser(db, id)) throw new AuthError(404, 'not_found', 'Tidak dijumpai');
    guardTarget(db, request, id);
    const given = str(body(request).ref);
    const p = parseRef(given);
    const surau = reqSurau(request);
    const named =
      target.no !== null && target.noSrc !== null
        ? p !== null && p.kind === 'user' && p.no === target.no && p.src === target.noSrc && (p.surauId === null || p.surauId === surau)
        : given === target.id;
    if (!named) throw new AuthError(400, 'ref_mismatch', 'ID pengguna tidak sepadan. Buka semula halaman pengguna dan cuba lagi');
    if (userOf(request).userId === id) throw new AuthError(409, 'own_account', 'Anda tidak boleh memadam akaun sendiri');
    if (target.active && countsAsSurauAdmin(db, target.roles) && activeAdminCount(db, surau) <= 1) {
      throw new AuthError(409, 'last_admin', 'Mesti ada sekurang-kurangnya seorang pentadbir aktif');
    }
    if (target.active && target.roles.includes('superadmin') && activeSuperadminCount(db) <= 1) {
      throw new AuthError(409, 'last_superadmin', 'Mesti ada sekurang-kurangnya seorang Pentadbir MAXCOM aktif');
    }
    deleteUserGuarded(db, id, actor(request), surau);
    return { ok: true };
  });

  // Pulihkan: from the delete's own line in Log perubahan. The person comes back deactivated with no devices.
  app.post('/api/users/:id/restore', SMALL_BODY, async (request) => {
    const { id } = request.params as { id: string };
    const row = db.prepare('SELECT id, surau_id, deleted_at FROM users WHERE id = ? AND surau_id = ?').get(id, reqSurau(request));
    if (row === undefined || typeof row.deleted_at !== 'string') {
      if (isStarUser(db, id)) refuseStar(request, 'star_user');
      throw new AuthError(404, 'not_found', 'Tidak dijumpai');
    }
    return restoreUser(db, id, actor(request));
  });

  app.post('/api/users/:id/deactivate', SMALL_BODY, async (request) => {
    const { id } = request.params as { id: string };
    const target = tenantUser(request, id);
    guardTarget(db, request, id);
    if (target.active && countsAsSurauAdmin(db, target.roles) && activeAdminCount(db, reqSurau(request)) <= 1) {
      throw new AuthError(409, 'last_admin', 'Mesti ada sekurang-kurangnya seorang pentadbir aktif');
    }
    if (target.active && target.roles.includes('superadmin') && activeSuperadminCount(db) <= 1) {
      throw new AuthError(409, 'last_superadmin', 'Mesti ada sekurang-kurangnya seorang Pentadbir MAXCOM aktif');
    }
    deactivateUserGuarded(db, id, actor(request), reqSurau(request));
    return { ok: true };
  });

  // ---- enrolment codes (users:manage) ----

  app.post('/api/enrol/begin', SMALL_BODY, async (request, reply) => {
    const b = body(request);
    const by = actor(request);
    const userId = str(b.userId);
    const surauId = reqSurau(request);
    // Only a user of the issuing admin's surau: the device it enrols belongs to that surau.
    const user = tenantUser(request, userId);
    // The code lives 10 minutes unless the admin chooses 30 or 60 for this one code.
    const ttl = b.ttlMinutes === undefined ? 10 : b.ttlMinutes;
    // A code made on the cloud never reaches the surau box, so it cannot enrol a device for a surau's person on the
    // surau Wi-Fi: 409 box_only. An ops/support target (Pentadbir MAXCOM) falls through to beginEnrolment, which
    // refuses it with ops_cli_only (Plan 14 section 3.4): their codes come only from the CLI, never from a route.
    if (deps.role === 'cloud' && !holdsOpsRole(user.roles)) {
      throw new AuthError(409, 'box_only', 'Kod peranti mesti dibuat oleh MAXCOM di surau. Gunakan telefon Pentadbir Surau di Wi-Fi surau.');
    }
    if (typeof ttl !== 'number' || !ENROL_TTLS.includes(ttl)) throw new AuthError(400, 'bad_ttl', 'Tempoh kod tidak sah');
    const enrol = beginEnrolment(db, { userId, deviceName: str(b.deviceName), ttlMinutes: ttl }, by, {
      canManageSuperadmin: identityCan(request.auth, 'superadmin:manage'),
    });
    const tlsLive = deps.tlsNow !== undefined ? deps.tlsNow() : deps.tls;
    const ip = tlsLive?.ipSan.find((a) => a !== '127.0.0.1' && a !== '::1');
    const localName = boxNameOf(tlsLive);
    const lanIps = lanIpv4Of(tlsLive);
    const hostHeader = typeof request.headers.host === 'string' ? request.headers.host.replace(/:\d+$/, '') : 'localhost';
    const info = surauPublicInfo(db, undefined, surauId);
    const inviter = db.prepare('SELECT name FROM users WHERE id = ?').get(userOf(request).userId);
    const cloudOrigin = enrolCloudOrigin(db);
    const payload =
      'surau1:' +
      Buffer.from(
        JSON.stringify({
          v: 1,
          mode: tlsLive?.mode ?? 'ip',
          box: `https://${ip ?? hostHeader}:${deps.httpsPort}`,
          ...(localName !== null ? { name: localName } : {}),
          ...(lanIps.length > 0 ? { ips: lanIps } : {}),
          boxId,
          ...(cloudOrigin !== undefined ? { cloud: cloudOrigin } : {}),
          caSha256: rootCaFingerprint(dataDir),
          code: enrol.code,
          user: user.name,
          pinSet: !user.pinRequired,
          appLock: appLockRequiredFor(db, user.roles, surauId),
          exp: new Date(enrol.expiresAt).getTime(),
          surau: { name: info.name, kind: info.kind },
          ...(info.help ? { help: info.help } : {}),
          roles: user.roles,
          invitedBy: typeof inviter?.name === 'string' ? inviter.name : '',
        }),
      ).toString('base64url');
    // The text a Pentadbir hands over in a message: the same code, but no LAN address, roles, inviter, help or
    // cloud address. It exists only when the box has its numbered local name (the app offers no "Kongsi" without it).
    // A Pentadbir (or Pentadbir MAXCOM) code is not handed round in a message while the app lock is off.
    const sharePayload =
      localName !== null && !((user.roles.includes('admin') || user.roles.includes('superadmin')) && !appLockEnabled(db, surauId))
        ? 'surau1:' +
          Buffer.from(
            JSON.stringify({
              v: 1,
              mode: tlsLive?.mode ?? 'ip',
              box: `https://${localName}:${deps.httpsPort}`,
              name: localName,
              boxId,
              caSha256: rootCaFingerprint(dataDir),
              code: enrol.code,
              user: user.name,
              pinSet: !user.pinRequired,
              appLock: appLockRequiredFor(db, user.roles, surauId),
              exp: new Date(enrol.expiresAt).getTime(),
              surau: { name: info.name, kind: info.kind },
            }),
          ).toString('base64url')
        : undefined;
    reply.header('Cache-Control', 'no-store');
    return { id: enrol.id, code: enrol.code, expiresAt: enrol.expiresAt, payload, ...(sharePayload !== undefined ? { sharePayload } : {}) };
  });

  const userRefOf = refLookup(db, 'user', false);
  const deviceRefOf = refLookup(db, 'device', false);

  // Every open code of the surau (unused, not expired, not ended): the Peranti tab lists them with "Tamatkan kod".
  // Never the code itself or its hash, never a Pentadbir MAXCOM's.
  app.get('/api/enrol/open', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const rows = db
      .prepare(
        `SELECT e.rowid AS id, e.user_id, e.device_name, e.expires_at, e.created_by, u.name AS user_name, c.name AS creator_name
           FROM enrolments e
           JOIN users u ON u.id = e.user_id
           LEFT JOIN users c ON ('user:' || c.id) = e.created_by
          WHERE e.used_at IS NULL AND e.cancelled_at IS NULL AND e.expires_at > ? AND e.ops = 0
            AND u.surau_id = ? AND u.surau_id <> '*' AND u.deleted_at IS NULL
          ORDER BY e.expires_at, e.rowid`,
      )
      .all(now().toISOString(), reqSurau(request));
    return {
      codes: rows.map((r) => ({
        id: Number(r.id),
        userId: String(r.user_id),
        userRef: userRefOf(String(r.user_id)),
        userName: typeof r.user_name === 'string' ? r.user_name : '',
        deviceName: typeof r.device_name === 'string' ? r.device_name : '',
        expiresAt: String(r.expires_at),
        createdByName: typeof r.creator_name === 'string' ? r.creator_name : '',
      })),
    };
  });

  // "Tamatkan kod": ends an open code at once. The id must belong to the user named in the body.
  app.post('/api/enrol/cancel', SMALL_BODY, async (request) => {
    const b = body(request);
    if (typeof b.id !== 'number' || !Number.isInteger(b.id) || b.id < 1 || typeof b.userId !== 'string') {
      throw new AuthError(400, 'bad_body', 'Permintaan tidak sah');
    }
    const user = tenantUser(request, b.userId);
    guardTarget(db, request, user.id);
    const at = now().toISOString();
    const done = db
      .prepare('UPDATE enrolments SET used_at = ?, cancelled_at = ? WHERE rowid = ? AND user_id = ? AND used_at IS NULL')
      .run(at, at, b.id, user.id);
    const cancelled = Number(done.changes) === 1;
    if (cancelled) authLog(db, now(), 'enrol_cancel', true, { userId: user.id, ip: request.ip, detail: `by:${userOf(request).userId}` });
    return { ok: true, cancelled };
  });

  // ---- devices (devices:manage) ----

  // A cancelled device or paired screen is never listed (operator rule 2026-11-06); the row
  // itself stays for signature checks, sync and audit.
  app.get('/api/devices', async (request) => {
    const devices = listDevices(db, undefined, { includeStar: opsSession(request), includeRevoked: opsSession(request) }, reqSurau(request));
    if (!opsSession(request)) return { devices };
    const g = globalRefMap(db, 'device');
    return { devices: devices.map((d) => ({ ...d, revoked: d.revokedAt !== null, globalRef: g.get(d.id) ?? null })) };
  });

  app.put('/api/devices/:id/name', SMALL_BODY, async (request) => {
    const { id } = request.params as { id: string };
    const b = body(request);
    const mine = getDeviceInTenant(db, id, reqSurau(request), opsSession(request));
    if (mine === undefined) {
      if (getDeviceWithKey(db, id) !== undefined && !opsSession(request)) refuseStar(request, 'star_device');
      throw new AuthError(404, 'not_found', 'Tidak dijumpai');
    }
    guardTarget(db, request, mine.userId);
    return { ok: true, device: renameDevice(db, id, b.name as string, actor(request)) };
  });

  app.post('/api/devices/:id/revoke', SMALL_BODY, async (request) => {
    const { id } = request.params as { id: string };
    // The device's owner decides: a Pentadbir MAXCOM's phone is revoked only by superadmin:manage.
    // A device of another surau does not exist for this caller.
    const mine = getDeviceInTenant(db, id, reqSurau(request), opsSession(request));
    if (mine === undefined) {
      if (getDeviceWithKey(db, id) !== undefined && !opsSession(request)) refuseStar(request, 'star_device');
      throw new AuthError(404, 'not_found', 'Tidak dijumpai');
    }
    guardTarget(db, request, mine.userId);
    revokeDeviceGuarded(db, id, actor(request));
    return { ok: true };
  });

  // One-tap removal of unused phones, tablets and computers: every id is re-checked here against the server's clock,
  // so a stale list on the phone can never remove a device that is in use (it is skipped with a reason).
  app.post('/api/devices/revoke-inactive', SMALL_BODY, async (request) => {
    if (deps.role === 'cloud') throw new AuthError(409, 'box_only', 'Hanya boleh dibuat di Wi-Fi surau');
    const b = body(request);
    const ids = b.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || ids.some((i) => typeof i !== 'string' || i.length === 0 || i.length > 100)) {
      throw new AuthError(400, 'bad_body', 'Senarai peranti tidak sah');
    }
    const mineDeviceId = userOf(request).deviceId;
    const revoked: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of [...new Set(ids as string[])]) {
      const skip = (reason: string): void => void skipped.push({ id, reason });
      const d = getDeviceInTenant(db, id, reqSurau(request), opsSession(request));
      if (d === undefined) {
        if (getDeviceWithKey(db, id) !== undefined && !opsSession(request)) refuseStar(request, 'star_device');
        skip('not_found');
        continue;
      }
      try {
        guardTarget(db, request, d.userId);
      } catch {
        skip('not_found');
        continue;
      }
      if (d.platform === 'kiosk') skip('is_tv');
      else if (d.id === mineDeviceId) skip('own_device');
      else if (d.revokedAt !== null) skip('not_found');
      else if (!isIdleDevice(d, now())) skip('in_use');
      else {
        try {
          revokeDeviceGuarded(db, id, actor(request));
          revoked.push(id);
        } catch (e) {
          if (e instanceof AuthError && e.code === 'last_admin_device') skip('last_admin_device');
          else throw e;
        }
      }
    }
    return { revoked, skipped };
  });

  // Every clean-up flag, computed from the server's clock (the phone's clock is never used).
  app.get('/api/people/activity', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return peopleActivity(db, reqSurau(request), now(), deps.role === 'cloud' ? 'cloud' : 'box', opsSession(request));
  });

  // ---- recovery code and enrolment code status (users:manage) ----

  // Whether a recovery code exists, for the Pentadbir's warning on a box upgraded from before codes existed.
  app.get('/api/recovery/status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { recoveryCodeSet: recoveryCodeExists(db) };
  });

  const rotateDay = createRateLimiter({ windowMs: 24 * 3_600_000, max: 3 });
  app.post(
    '/api/recovery/code',
    {
      ...SMALL_BODY,
      preHandler: async (request, reply) => {
        const a = request.auth;
        const hit = rotateDay.hit(a !== null && a.kind === 'user' ? a.userId : request.ip);
        return hit.ok ? undefined : tooMany(reply, hit.retryAfterSec);
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const who = userOf(request);
      const user = db.prepare('SELECT id, name, roles_json, active FROM users WHERE id = ?').get(who.userId);
      if (user === undefined) throw new AuthError(404, 'user_not_found', 'Pengguna tidak dijumpai');
      // the new code is returned once; only its hash is stored, and the old code dies with this write
      const recoveryCode = tx(db, () => {
        const code = issueRecoveryCode(db);
        // the stored roles, never the session's effective ones: this row replicates
        const snap = { id: who.userId, name: String(user.name), roles: realRoles(who.userId), active: user.active === 1 };
        logChange(db, `user:${who.userId}`, 'users', who.userId, snap, { ...snap, recoveryCodeRotated: true }, undefined, userSurau(db, who.userId));
        bumpFor(db, userSurau(db, who.userId));
        return code;
      });
      return { recoveryCode };
    },
  );

  // The caller's own enrolment codes of the last 24 hours: when they expire, whether and when they were used,
  // and how many later attempts met a used code. Never the code itself.
  app.get('/api/enrol/recent', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const by = actor(request);
    const cutoff = new Date(now().getTime() - 24 * 3_600_000).toISOString();
    const rows = db
      .prepare(
        `SELECT e.rowid AS id, e.user_id, e.device_name, e.expires_at, e.used_at, e.cancelled_at, u.name AS user_name,
                d.id AS dev_id, d.name AS dev_name, d.platform AS dev_platform, d.enrolled_at AS dev_enrolled_at
           FROM enrolments e LEFT JOIN users u ON u.id = e.user_id
           LEFT JOIN devices d ON d.id = e.device_id AND e.cancelled_at IS NULL
          WHERE e.created_by = ? AND COALESCE(e.used_at, e.expires_at) >= ? AND (u.id IS NULL OR u.deleted_at IS NULL)
          ORDER BY e.expires_at DESC`,
      )
      .all(by, cutoff);
    const attempts = db.prepare(
      `SELECT COUNT(*) AS n FROM auth_log WHERE event = 'enrol' AND ok = 0 AND detail = 'kod sudah digunakan' AND user_id = ? AND at > ?`,
    );
    return {
      codes: rows.map((r) => ({
        id: Number(r.id),
        cancelledAt: typeof r.cancelled_at === 'string' ? r.cancelled_at : null,
        device:
          typeof r.dev_id === 'string'
            ? { id: r.dev_id, name: String(r.dev_name), platform: String(r.dev_platform), enrolledAt: String(r.dev_enrolled_at), ref: deviceRefOf(r.dev_id) }
            : null,
        userId: String(r.user_id),
        userRef: userRefOf(String(r.user_id)),
        userName: typeof r.user_name === 'string' ? r.user_name : '',
        deviceName: typeof r.device_name === 'string' ? r.device_name : '',
        expiresAt: String(r.expires_at),
        usedAt: typeof r.used_at === 'string' ? r.used_at : null,
        reuseAttempts: typeof r.used_at === 'string' ? Number(attempts.get(String(r.user_id), r.used_at)?.n ?? 0) : 0,
      })),
    };
  });

  // ---- audit (audit:read) ----

  app.get('/api/audit', async (request) => {
    const q = request.query as { limit?: string; since?: string; entity?: string };
    const n = Number(q.limit ?? 200);
    const limit = Number.isInteger(n) ? Math.min(Math.max(n, 1), 1000) : 200;
    const since = Number(q.since ?? 0);
    // Only the request's surau (Plan 14 section 3.1); a surau session never sees a Pentadbir MAXCOM row (decision 22).
    // An ops-device session acting in the surau sees all of that surau's rows (rows filed under '*' are no surau's).
    const where: string[] = ['c.surau_id = ?'];
    const args: (string | number)[] = [reqSurau(request)];
    if (!opsSession(request)) where.push(notStarChangeSql('c'));
    if (Number.isInteger(since) && since > 0) {
      where.push('c.id > ?');
      args.push(since);
    }
    if (typeof q.entity === 'string' && q.entity !== '') {
      // A prefix match; LIKE wildcards in the filter are matched literally.
      where.push("c.entity LIKE ? ESCAPE '!'");
      args.push(`${q.entity.slice(0, 100).replace(/[!%_]/g, (m) => '!' + m)}%`);
    }
    const rows = db
      .prepare(
        `SELECT c.id, c.at, c.actor, c.entity, c.entity_id, c.before_json, c.after_json, c.device_id,
                c.origin, c.op_id, c.edited_at, c.synced_at, c.rev, COALESCE(c.actor_name, u.name) AS user_name
           FROM change_log c LEFT JOIN users u ON c.actor = 'user:' || u.id
          WHERE ${where.join(' AND ')}
          ORDER BY c.id DESC LIMIT ?`,
      )
      .all(...args, limit);
    // Device public keys travel in the change log for the sync; no audit reader needs them.
    const parse = (v: unknown): unknown => {
      if (typeof v !== 'string') return null;
      try {
        const j: unknown = JSON.parse(v);
        if (typeof j === 'object' && j !== null && !Array.isArray(j) && ('publicJwk' in j || 'phone' in j)) {
          // no key material and no phone number in an audit answer (the number is personal data)
          const { publicJwk: _key, phone: _phone, ...rest } = j as Record<string, unknown>;
          return rest;
        }
        return j;
      } catch {
        return null;
      }
    };
    const phoneOf = (v: unknown): unknown => {
      if (typeof v !== 'string') return undefined;
      try {
        const j: unknown = JSON.parse(v);
        return typeof j === 'object' && j !== null && !Array.isArray(j) ? (j as Record<string, unknown>).phone : undefined;
      } catch {
        return undefined;
      }
    };
    const uref = refLookup(db, 'user', opsSession(request));
    const dref = refLookup(db, 'device', opsSession(request));
    const deletedIds = new Set(db.prepare('SELECT id FROM users WHERE deleted_at IS NOT NULL AND surau_id = ?').all(reqSurau(request)).map((x) => String(x.id)));
    const isDeleted = (id: string): boolean => deletedIds.has(id);
    return {
      entries: rows.map((r) => ({
        id: Number(r.id),
        at: String(r.at),
        actor: String(r.actor),
        userName: typeof r.user_name === 'string' ? r.user_name : null,
        actorRef: String(r.actor).startsWith('user:') ? uref(String(r.actor).slice(5)) : null,
        entityDeleted: r.entity === 'users' && typeof r.entity_id === 'string' ? isDeleted(r.entity_id) : false,
        entityRef: r.entity === 'users' ? uref(typeof r.entity_id === 'string' ? r.entity_id : null) : r.entity === 'devices' ? dref(typeof r.entity_id === 'string' ? r.entity_id : null) : null,
        deviceId: typeof r.device_id === 'string' ? r.device_id : null,
        entity: String(r.entity),
        entityId: typeof r.entity_id === 'string' ? r.entity_id : null,
        before: parse(r.before_json),
        after: parse(r.after_json),
        ...(r.entity === 'users' && phoneOf(r.before_json) !== phoneOf(r.after_json) ? { phoneChanged: true } : {}),
        origin: typeof r.origin === 'string' ? r.origin : 'local',
        opId: typeof r.op_id === 'string' ? r.op_id : null,
        editedAt: typeof r.edited_at === 'string' ? r.edited_at : String(r.at),
        syncedAt: typeof r.synced_at === 'string' ? r.synced_at : null,
        rev: typeof r.rev === 'string' ? r.rev : null,
      })),
    };
  });

  // ---- PKI (public) ----

  app.get('/api/pki/root.cer', async (request, reply) => {
    const path = join(dataDir, 'pki', 'root-ca.cer');
    if (deps.tls?.mode === 'domain' || !existsSync(path)) {
      return reply.code(404).send({ errors: ['tiada sijil akar'] });
    }
    const bytes = readFileSync(path);
    const der = bytes.includes('BEGIN CERTIFICATE') ? new X509Certificate(bytes).raw : bytes;
    void request;
    return reply.header('Content-Type', 'application/pkix-cert').header('Cache-Control', 'no-store').send(der);
  });

  // Certificate expiry and the last automatic renewal, for the admin warning in the app (admins only).
  app.get('/api/pki/status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return pkiStatus(dataDir, now());
  });
}
