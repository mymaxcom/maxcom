import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@surau/core';
import { pkiStatus } from '../tls.ts';
import type { TlsMaterial } from '../tls.ts';
import { bumpVersion, surauPublicInfo } from '../settingsStore.ts';
import { identityCan, tooMany } from './authz.ts';
import type { AuthContext, Limiters } from './authz.ts';
import { appLockEnabled, appLockRequiredFor } from './appLock.ts';
import { pinPepperOf, verifyPin } from './crypto.ts';
import { approvePairing, beginPairing, buildKioskCookie, listPendingPairings, pollPairing } from './pairing.ts';
import { createRateLimiter } from './ratelimit.ts';
import { beginEnrolment, completeEnrolmentAsync, getDeviceWithKey, listDevices, revokeDevice } from './devices.ts';
import { enrolCloudOrigin } from '../sync/sites.ts';
import { issueRecoveryCode, recoveryCodeExists } from '../setup/codes.ts';
import { leaveDevice } from './leave.ts';
import { issueChallenge, revokeSession, unlock } from './sessions.ts';
import type { UnlockInput } from './sessions.ts';
import {
  AuthError,
  MSG,
  activeAdminCount,
  activeSuperadminCount,
  checkRoles,
  createUser,
  deactivateUser,
  getAuthUser,
  listUsers,
  logChange,
  requireSuperadminTarget,
  revokeDeviceRow,
  setPin,
  setRoles,
  tx,
} from './users.ts';

export interface AuthRouteDeps {
  db: DatabaseSync;
  boxId: string;
  dataDir: string;
  now: () => Date;
  limiters: Limiters;
  tls: TlsMaterial | null;
  httpsPort: number;
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

/** The target of an action holds the Pentadbir MAXCOM role: the caller needs `superadmin:manage` for any change. */
function guardTarget(db: DatabaseSync, request: FastifyRequest, targetUserId: string): void {
  requireSuperadminTarget(db, targetUserId, identityCan(request.auth, 'superadmin:manage'));
}

const ENROL_TTLS: readonly number[] = [10, 30, 60];

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { db, boxId, dataDir, now, limiters } = deps;
  const actor = (request: FastifyRequest): string => `user:${userOf(request).userId}`;

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
    return { nonce, expiresAt, appLock: appLockRequiredFor(db, roles) };
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
    const out = approvePairing(db, { code: b.code, deviceName: b.deviceName }, a.userId, actor(request), now());
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

  app.get('/api/auth/me', async (request) => {
    const a = userOf(request);
    const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(a.userId);
    const device = db.prepare('SELECT id, name, platform FROM devices WHERE id = ?').get(a.deviceId);
    const session = db.prepare('SELECT expires_at FROM sessions WHERE id = ?').get(a.sessionId);
    return {
      user: { id: String(user?.id), name: String(user?.name) },
      device: { id: String(device?.id), name: String(device?.name), platform: String(device?.platform) },
      roles: a.roles,
      expiresAt: String(session?.expires_at),
      appLock: appLockRequiredFor(db, a.roles),
    };
  });

  app.put('/api/auth/pin', SMALL_BODY, async (request, reply) => {
    const a = userOf(request);
    // With the lock off there is no PIN to change; refuse before any rate-limit hit or PIN check.
    if (!appLockRequiredFor(db, a.roles)) throw new AuthError(409, 'app_lock_off', MSG.appLockOff);
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

  app.get('/api/users', async () => ({ users: listUsers(db) }));

  app.post('/api/users', SMALL_BODY, async (request, reply) => {
    const b = body(request);
    if (Array.isArray(b.roles)) requireSuperadminManage(request, [], b.roles as string[]);
    const user = createUser(db, { name: str(b.name), roles: b.roles as Role[] }, actor(request));
    return reply.code(201).send(user);
  });

  app.put('/api/users/:id/roles', SMALL_BODY, async (request) => {
    const { id } = request.params as { id: string };
    const b = body(request);
    const roles = checkRoles(b.roles);
    guardTarget(db, request, id);
    const target = listUsers(db).find((u) => u.id === id);
    requireSuperadminManage(request, target?.roles ?? [], roles);
    const keepsAdmin = roles.includes('admin') || roles.includes('superadmin');
    if (target?.active && (target.roles.includes('admin') || target.roles.includes('superadmin')) && !keepsAdmin && activeAdminCount(db) <= 1) {
      throw new AuthError(409, 'last_admin', 'Mesti ada sekurang-kurangnya seorang pentadbir aktif');
    }
    return setRoles(db, id, roles as Role[], actor(request));
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
    guardTarget(db, request, id);
    const revoked: string[] = [];
    tx(db, () => {
      const before = getAuthUser(db, id);
      if (before === undefined) throw new AuthError(404, 'user_not_found', 'Pengguna tidak dijumpai');
      const owned = new Set(listDevices(db, id).map((d) => d.id));
      if (!revokeIds.every((d) => owned.has(d))) throw new AuthError(400, 'bad_device', 'Peranti tidak sah untuk pengguna ini');
      const nowIso = new Date().toISOString();
      for (const d of revokeIds) if (revokeDeviceRow(db, d, by, nowIso)) revoked.push(d);
      const snap = { id: before.id, name: before.name, roles: before.roles, active: before.active };
      db.prepare(
        'UPDATE users SET pin_hash = NULL, pin_fail_count = 0, pin_locked_until = NULL, lock_round = 0 WHERE id = ?',
      ).run(id);
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(nowIso, id);
      logChange(db, by, 'users', id, { ...snap, hasPin: before.pinHash !== null }, { ...snap, hasPin: false, pinReset: true });
      bumpVersion(db);
    });
    const devices = listDevices(db, id).filter((d) => d.platform !== 'kiosk');
    return { ok: true, pinRequired: true, revoked, devices };
  });

  app.post('/api/users/:id/deactivate', SMALL_BODY, async (request) => {
    const { id } = request.params as { id: string };
    guardTarget(db, request, id);
    const target = listUsers(db).find((u) => u.id === id);
    if (target?.active && (target.roles.includes('admin') || target.roles.includes('superadmin')) && activeAdminCount(db) <= 1) {
      throw new AuthError(409, 'last_admin', 'Mesti ada sekurang-kurangnya seorang pentadbir aktif');
    }
    if (target?.active && target.roles.includes('superadmin') && activeSuperadminCount(db) <= 1) {
      throw new AuthError(409, 'last_superadmin', 'Mesti ada sekurang-kurangnya seorang Pentadbir MAXCOM aktif');
    }
    deactivateUser(db, id, actor(request));
    return { ok: true };
  });

  // ---- enrolment codes (users:manage) ----

  app.post('/api/enrol/begin', SMALL_BODY, async (request, reply) => {
    const b = body(request);
    const by = actor(request);
    const userId = str(b.userId);
    // The code lives 10 minutes unless the admin chooses 30 or 60 for this one code.
    const ttl = b.ttlMinutes === undefined ? 10 : b.ttlMinutes;
    if (typeof ttl !== 'number' || !ENROL_TTLS.includes(ttl)) throw new AuthError(400, 'bad_ttl', 'Tempoh kod tidak sah');
    const enrol = beginEnrolment(db, { userId, deviceName: str(b.deviceName), ttlMinutes: ttl }, by, {
      canManageSuperadmin: identityCan(request.auth, 'superadmin:manage'),
    });
    const user = listUsers(db).find((u) => u.id === userId);
    const ip = deps.tls?.ipSan.find((a) => a !== '127.0.0.1' && a !== '::1');
    const hostHeader = typeof request.headers.host === 'string' ? request.headers.host.replace(/:\d+$/, '') : 'localhost';
    const info = surauPublicInfo(db);
    const inviter = db.prepare('SELECT name FROM users WHERE id = ?').get(userOf(request).userId);
    const cloudOrigin = enrolCloudOrigin(db);
    const payload =
      'surau1:' +
      Buffer.from(
        JSON.stringify({
          v: 1,
          mode: deps.tls?.mode ?? 'ip',
          box: `https://${ip ?? hostHeader}:${deps.httpsPort}`,
          boxId,
          ...(cloudOrigin !== undefined ? { cloud: cloudOrigin } : {}),
          caSha256: rootCaFingerprint(dataDir),
          code: enrol.code,
          user: user?.name ?? '',
          pinSet: user !== undefined && !user.pinRequired,
          appLock: appLockRequiredFor(db, user?.roles ?? []),
          exp: new Date(enrol.expiresAt).getTime(),
          surau: { name: info.name, kind: info.kind },
          ...(info.help ? { help: info.help } : {}),
          roles: user?.roles ?? [],
          invitedBy: typeof inviter?.name === 'string' ? inviter.name : '',
        }),
      ).toString('base64url');
    reply.header('Cache-Control', 'no-store');
    return { code: enrol.code, expiresAt: enrol.expiresAt, payload };
  });

  // ---- devices (devices:manage) ----

  // A cancelled device or paired screen is never listed (operator rule 2026-11-06); the row
  // itself stays for signature checks, sync and audit.
  app.get('/api/devices', async () => ({ devices: listDevices(db) }));

  app.post('/api/devices/:id/revoke', SMALL_BODY, async (request) => {
    const { id } = request.params as { id: string };
    // The device's owner decides: a Pentadbir MAXCOM's phone is revoked only by superadmin:manage.
    const owner = getDeviceWithKey(db, id)?.userId;
    if (owner !== undefined) guardTarget(db, request, owner);
    revokeDevice(db, id, actor(request));
    return { ok: true };
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
        const snap = { id: who.userId, name: String(user.name), roles: who.roles, active: user.active === 1 };
        logChange(db, `user:${who.userId}`, 'users', who.userId, snap, { ...snap, recoveryCodeRotated: true });
        bumpVersion(db);
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
        `SELECT e.user_id, e.device_name, e.expires_at, e.used_at, u.name AS user_name
           FROM enrolments e LEFT JOIN users u ON u.id = e.user_id
          WHERE e.created_by = ? AND COALESCE(e.used_at, e.expires_at) >= ?
          ORDER BY e.expires_at DESC`,
      )
      .all(by, cutoff);
    const attempts = db.prepare(
      `SELECT COUNT(*) AS n FROM auth_log WHERE event = 'enrol' AND ok = 0 AND detail = 'kod sudah digunakan' AND user_id = ? AND at > ?`,
    );
    return {
      codes: rows.map((r) => ({
        userId: String(r.user_id),
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
    const where: string[] = [];
    const args: (string | number)[] = [];
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
                c.origin, c.op_id, c.edited_at, c.synced_at, c.rev, u.name AS user_name
           FROM change_log c LEFT JOIN users u ON c.actor = 'user:' || u.id
          ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY c.id DESC LIMIT ?`,
      )
      .all(...args, limit);
    // Device public keys travel in the change log for the sync; no audit reader needs them.
    const parse = (v: unknown): unknown => {
      if (typeof v !== 'string') return null;
      try {
        const j: unknown = JSON.parse(v);
        if (typeof j === 'object' && j !== null && !Array.isArray(j) && 'publicJwk' in j) {
          const { publicJwk: _key, ...rest } = j as Record<string, unknown>;
          return rest;
        }
        return j;
      } catch {
        return null;
      }
    };
    return {
      entries: rows.map((r) => ({
        id: Number(r.id),
        at: String(r.at),
        actor: String(r.actor),
        userName: typeof r.user_name === 'string' ? r.user_name : null,
        deviceId: typeof r.device_id === 'string' ? r.device_id : null,
        entity: String(r.entity),
        entityId: typeof r.entity_id === 'string' ? r.entity_id : null,
        before: parse(r.before_json),
        after: parse(r.after_json),
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
