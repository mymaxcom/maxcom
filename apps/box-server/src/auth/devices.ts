import { createPublicKey, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isoInstantMs } from '@surau/core';
import type { Role } from '@surau/core';
import { hashPin, hashPinSyncWith, isValidPin, pinPepperOf, randomToken, sha256hex } from './crypto.ts';
import type { JsonWebKey } from './crypto.ts';
import { bumpVersion } from '../settingsStore.ts';
import { appLockRequiredFor } from './appLock.ts';
import { AuthError, MSG, getUserRow, logChange, requireSuperadminTarget, revokeDeviceRow, stampRow, tx } from './users.ts';
import type { ChangeMeta } from '../sync/meta.ts';

export type Platform = 'android' | 'ios-web' | 'web' | 'kiosk';
export const PLATFORMS: readonly string[] = ['android', 'ios-web', 'web', 'kiosk'];

export interface Device {
  id: string;
  userId: string;
  name: string;
  platform: Platform;
  enrolledAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const MAX_OPEN_CODES = 3;

function newCode(): string {
  const bytes = randomBytes(12);
  let raw = '';
  for (const b of bytes) raw += B32[b & 31]; // 32 symbols: the mask is unbiased
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function normaliseCode(code: unknown): string {
  return typeof code === 'string' ? code.replace(/[\s-]/g, '').toUpperCase() : '';
}

export function cleanName(name: unknown, fallback: string): string {
  if (typeof name !== 'string') return fallback;
  const t = name.trim().slice(0, 80);
  return t.length > 0 ? t : fallback;
}

/** Accept only a clean P-256 public key; return it canonicalised (crv, kty, x, y). */
export function canonicalJwk(jwk: unknown): JsonWebKey {
  const bad = (): AuthError => new AuthError(400, 'bad_key', 'Kunci peranti tidak sah');
  if (jwk === null || typeof jwk !== 'object' || Array.isArray(jwk)) throw bad();
  const k = jwk as Record<string, unknown>;
  if (k.kty !== 'EC' || k.crv !== 'P-256') throw bad();
  if (typeof k.x !== 'string' || typeof k.y !== 'string') throw bad();
  if (!/^[A-Za-z0-9_-]{43}$/.test(k.x) || !/^[A-Za-z0-9_-]{43}$/.test(k.y)) throw bad();
  if ('d' in k) throw bad();
  const clean: JsonWebKey = { crv: 'P-256', kty: 'EC', x: k.x, y: k.y };
  try {
    createPublicKey({ key: clean, format: 'jwk' });
  } catch {
    throw bad();
  }
  return clean;
}

function toDevice(row: Record<string, unknown>): Device {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    platform: String(row.platform) as Platform,
    enrolledAt: String(row.enrolled_at),
    lastSeenAt: typeof row.last_seen_at === 'string' ? row.last_seen_at : null,
    revokedAt: typeof row.revoked_at === 'string' ? row.revoked_at : null,
  };
}

/**
 * Secret-free device snapshot for change_log. It carries the PUBLIC key (never anything secret) so an
 * enrolment can travel to the other side of the sync; only site feeds ever hand it out (feed.ts).
 */
function snap(d: Device, publicJwk: JsonWebKey): Record<string, unknown> {
  return {
    id: d.id,
    userId: d.userId,
    name: d.name,
    platform: d.platform,
    revoked: d.revokedAt !== null,
    publicJwk,
    enrolledAt: d.enrolledAt,
  };
}

function authLog(
  db: DatabaseSync,
  event: string,
  ok: boolean,
  fields: { userId?: string | null; deviceId?: string | null; ip?: string | null; detail?: string | null },
): void {
  db.prepare(
    `INSERT INTO auth_log (at, event, user_id, device_id, ip, ok, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    event,
    fields.userId ?? null,
    fields.deviceId ?? null,
    fields.ip ?? null,
    ok ? 1 : 0,
    fields.detail ?? null,
  );
}

/**
 * Create a single-use enrolment code (12 base32 chars, XXXX-XXXX-XXXX). Only its hash is stored. A Pentadbir MAXCOM
 * target is refused unless `caller.canManageSuperadmin` (so a new caller cannot forget the check).
 */
export function beginEnrolment(
  db: DatabaseSync,
  input: { userId: string; deviceName: string; ttlMinutes?: number },
  actor: string,
  caller: { canManageSuperadmin: boolean } = { canManageSuperadmin: false },
): { code: string; expiresAt: string } {
  const ttl = input.ttlMinutes ?? 10;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 60) {
    throw new AuthError(400, 'bad_ttl', 'Tempoh kod tidak sah');
  }
  const deviceName = cleanName(input.deviceName, 'Peranti');
  return tx(db, () => {
    const user = getUserRow(db, input.userId);
    if (user === undefined || !user.active) {
      throw new AuthError(404, 'user_not_found', 'Pengguna tidak dijumpai');
    }
    // A code for a Pentadbir MAXCOM is a way in as that user: only superadmin:manage may issue one (default: refused).
    requireSuperadminTarget(db, user.id, caller.canManageSuperadmin);
    const nowIso = new Date().toISOString();
    const open = db
      .prepare('SELECT COUNT(*) AS n FROM enrolments WHERE user_id = ? AND used_at IS NULL AND expires_at > ?')
      .get(user.id, nowIso);
    if (Number(open?.n ?? 0) >= MAX_OPEN_CODES) throw new AuthError(429, 'too_many_codes', MSG.tooMany);
    const code = newCode();
    const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();
    db.prepare(
      `INSERT INTO enrolments (code_hash, user_id, device_name, expires_at, created_by) VALUES (?, ?, ?, ?, ?)`,
    ).run(sha256hex(normaliseCode(code)), user.id, deviceName, expiresAt, actor);
    authLog(db, 'enrol-begin', true, { userId: user.id, detail: `by ${actor}` });
    return { code, expiresAt };
  });
}

export interface EnrolInput {
  code: string;
  publicJwk: JsonWebKey;
  deviceName?: string;
  platform: string;
  pin?: string;
}

export interface EnrolOutcome {
  deviceId: string;
  userId: string;
  roles: Role[];
  /** True only while the app lock is on and the user still has no PIN. */
  pinRequired: boolean;
  /** Whether the box has the app lock on, so the app knows whether to ask for a PIN. */
  appLock: boolean;
}

interface EnrolChecked {
  jwk: JsonWebKey;
  platform: Platform;
  codeHash: string;
}

const BAD_CODE = (): AuthError => new AuthError(401, 'bad_enrol_code', MSG.badEnrolCode);

/**
 * Cheap, read-only checks that run BEFORE any PIN hashing: key, platform, PIN policy, then the
 * enrolment code itself (unknown, used, expired, user inactive, PIN already set). A refusal is
 * written to auth_log here, outside any transaction, so the row survives the throw.
 */
function checkEnrolment(db: DatabaseSync, input: EnrolInput, ip: string): EnrolChecked {
  const jwk = canonicalJwk(input.publicJwk);
  if (!PLATFORMS.includes(input.platform)) throw new AuthError(400, 'bad_platform', 'Platform tidak sah');
  const platform = input.platform as Platform;
  if (input.pin !== undefined && !isValidPin(input.pin)) {
    throw new AuthError(400, 'pin_policy', 'PIN mesti 6 digit dan tidak mudah diteka');
  }
  const codeHash = sha256hex(normaliseCode(input.code));
  const now = new Date().toISOString();
  const enrol = db.prepare('SELECT * FROM enrolments WHERE code_hash = ?').get(codeHash);
  const expired = enrol !== undefined && String(enrol.expires_at) <= now;
  if (enrol !== undefined && enrol.used_at !== null) {
    // a code that was already used: logged against its user so the issuer can see "tried again" (GET /api/enrol/recent)
    authLog(db, 'enrol', false, { userId: String(enrol.user_id), ip, detail: 'kod sudah digunakan' });
    throw BAD_CODE();
  }
  if (enrol === undefined || expired) {
    authLog(db, 'enrol', false, { ip, detail: 'kod tidak sah atau tamat' });
    throw BAD_CODE();
  }
  const user = getUserRow(db, String(enrol.user_id));
  if (user === undefined || !user.active) {
    authLog(db, 'enrol', false, { userId: String(enrol.user_id), ip, detail: 'pengguna tidak aktif' });
    throw BAD_CODE();
  }
  if (input.pin !== undefined && !user.pinRequired) {
    throw new AuthError(400, 'pin_exists', 'PIN sudah ditetapkan untuk pengguna ini');
  }
  return { jwk, platform, codeHash };
}

/**
 * The tail every enrolment shares: insert the device row, set the PIN hash, write the change_log and auth_log rows,
 * bump the version. The caller owns the transaction and has already proved the right to enrol (a code, or the
 * box's own setup or recovery).
 */
function insertEnrolledDevice(
  db: DatabaseSync,
  user: { id: string; roles: Role[]; pinRequired: boolean },
  d: { jwk: JsonWebKey; platform: Platform; name: string; pinHash: string | null; ip: string; now: string },
): EnrolOutcome {
  const { jwk, platform, name, pinHash, ip, now } = d;
  const deviceId = randomToken(12);
  db.prepare(
    `INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(deviceId, user.id, name, platform, JSON.stringify(jwk), now);
  if (pinHash !== null) {
    db.prepare(
      `UPDATE users SET pin_hash = ?, pin_fail_count = 0, pin_locked_until = NULL, lock_round = 0 WHERE id = ?`,
    ).run(pinHash, user.id);
  }
  const device = toDevice(
    db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as Record<string, unknown>,
  );
  logChange(db, `user:${user.id}`, 'devices', deviceId, undefined, snap(device, jwk));
  if (pinHash !== null) {
    // A FULL user record: readers (phones, the cloud) replace their copy with `after`, so a fragment
    // without name/roles/active would leave them a nameless user (migration 018 repairs old ones).
    const row = getUserRow(db, user.id);
    const userSnap = { id: user.id, name: row?.name ?? '', roles: row?.roles ?? user.roles, active: row?.active ?? true };
    logChange(
      db,
      `user:${user.id}`,
      'users',
      user.id,
      { ...userSnap, hasPin: false },
      { ...userSnap, hasPin: true, pinChanged: true },
    );
  }
  authLog(db, 'enrol', true, { userId: user.id, deviceId, ip });
  bumpVersion(db);
  const appLock = appLockRequiredFor(db, user.roles);
  return {
    deviceId,
    userId: user.id,
    roles: user.roles,
    pinRequired: appLock && pinHash === null && user.pinRequired,
    appLock,
  };
}

/**
 * Register a device for an existing user without an enrolment code: the box's own first setup or a recovery
 * (Plan 14). The key, platform and name are cleaned here; the PIN hash is made by the caller outside the
 * transaction. The caller owns the transaction. A TV screen is never enrolled this way.
 */
export function enrolDeviceDirect(
  db: DatabaseSync,
  input: { userId: string; publicJwk: unknown; platform: string; deviceName: string; pinHash: string | null; ip: string },
): EnrolOutcome {
  const jwk = canonicalJwk(input.publicJwk);
  if (!PLATFORMS.includes(input.platform) || input.platform === 'kiosk') {
    throw new AuthError(400, 'bad_platform', 'Platform tidak sah');
  }
  const user = getUserRow(db, input.userId);
  if (user === undefined || !user.active) throw new AuthError(404, 'user_not_found', 'Pengguna tidak dijumpai');
  return insertEnrolledDevice(db, user, {
    jwk,
    platform: input.platform as Platform,
    name: cleanName(input.deviceName, 'Peranti'),
    pinHash: input.pinHash,
    ip: input.ip,
    now: new Date().toISOString(),
  });
}

/**
 * Redeem an enrolment code: registers the device key. Single use. This is the request-path
 * version: the PIN (if any) is hashed asynchronously and only after the code was validated.
 */
export async function completeEnrolmentAsync(db: DatabaseSync, input: EnrolInput, ip: string): Promise<EnrolOutcome> {
  const checked = checkEnrolment(db, input, ip);
  const pinHash = input.pin !== undefined ? await hashPin(input.pin, pinPepperOf(db)) : null;
  return finishEnrolment(db, input, checked, pinHash, ip);
}

/**
 * Synchronous variant for in-process tools and tests. It blocks the event loop while hashing, so
 * it must never run on a request path (the routes use completeEnrolmentAsync).
 */
export function completeEnrolment(db: DatabaseSync, input: EnrolInput, ip: string): EnrolOutcome {
  const checked = checkEnrolment(db, input, ip);
  const pinHash = input.pin !== undefined ? hashPinSyncWith(input.pin, pinPepperOf(db)) : null;
  return finishEnrolment(db, input, checked, pinHash, ip);
}

function finishEnrolment(
  db: DatabaseSync,
  input: EnrolInput,
  checked: EnrolChecked,
  pinHash: string | null,
  ip: string,
): EnrolOutcome {
  const { jwk, platform, codeHash } = checked;
  const now = new Date().toISOString();

  // A refusal found inside the transaction is returned, not thrown: a throw would roll back the
  // auth_log row that records it.
  const result = tx(db, (): EnrolOutcome | { refuse: AuthError; log: { userId?: string; detail: string } } => {
    const enrol = db.prepare('SELECT * FROM enrolments WHERE code_hash = ?').get(codeHash);
    const expired = enrol !== undefined && String(enrol.expires_at) <= now;
    if (enrol === undefined || enrol.used_at !== null || expired) {
      return { refuse: BAD_CODE(), log: { detail: 'kod tidak sah atau tamat' } };
    }
    const user = getUserRow(db, String(enrol.user_id));
    if (user === undefined || !user.active) {
      return { refuse: BAD_CODE(), log: { userId: String(enrol.user_id), detail: 'pengguna tidak aktif' } };
    }
    if (pinHash !== null && !user.pinRequired) {
      return { refuse: new AuthError(400, 'pin_exists', 'PIN sudah ditetapkan untuk pengguna ini'), log: { userId: user.id, detail: 'pin_exists' } };
    }
    const claimed = db
      .prepare('UPDATE enrolments SET used_at = ? WHERE code_hash = ? AND used_at IS NULL')
      .run(now, codeHash);
    if (Number(claimed.changes) !== 1) {
      return { refuse: BAD_CODE(), log: { userId: user.id, detail: 'kod sudah digunakan' } };
    }

    const name = cleanName(input.deviceName, cleanName(enrol.device_name, 'Peranti'));
    return insertEnrolledDevice(db, user, { jwk, platform, name, pinHash, ip, now });
  });
  if ('refuse' in result) {
    authLog(db, 'enrol', false, { ...result.log, ip });
    throw result.refuse;
  }
  return result;
}

const SYNCED_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Register a device that was enrolled on the other side of the sync (box or cloud), with its public key.
 * Only when the user exists and is active HERE; the key must be a clean P-256 public key (canonicalised).
 * The caller (applyFeedEntry) owns the transaction and has already decided the id is new. Throws AuthError.
 */
export function enrolDeviceSynced(
  db: DatabaseSync,
  input: { id: string; userId: string; name: string; platform: string; publicJwk: unknown; enrolledAt: string },
  actor: string,
  meta: ChangeMeta,
): void {
  if (!SYNCED_ID.test(input.id)) throw new AuthError(400, 'bad_device', 'Peranti tidak sah');
  if (!PLATFORMS.includes(input.platform)) throw new AuthError(400, 'bad_platform', 'Platform tidak sah');
  if (isoInstantMs(input.enrolledAt) === null) throw new AuthError(400, 'bad_time', 'Masa tidak sah');
  const jwk = canonicalJwk(input.publicJwk);
  const user = getUserRow(db, input.userId);
  if (user === undefined || !user.active) throw new AuthError(404, 'user_not_found', 'Pengguna tidak dijumpai');
  const name = cleanName(input.name, 'Peranti');
  db.prepare(
    `INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.id, user.id, name, input.platform, JSON.stringify(jwk), input.enrolledAt);
  stampRow(db, 'devices', input.id, meta);
  const device = toDevice(db.prepare('SELECT * FROM devices WHERE id = ?').get(input.id) as Record<string, unknown>);
  logChange(db, actor, 'devices', input.id, undefined, snap(device, jwk), meta);
  authLog(db, 'enrol-synced', true, { userId: user.id, deviceId: input.id, detail: meta.origin ?? null });
  bumpVersion(db);
}

/** Devices (never includes the public key). Revoked ones are excluded unless asked for. */
export function listDevices(
  db: DatabaseSync,
  userId?: string,
  opts: { includeRevoked?: boolean } = {},
): Device[] {
  const where: string[] = [];
  const args: string[] = [];
  if (userId !== undefined) {
    where.push('user_id = ?');
    args.push(userId);
  }
  if (opts.includeRevoked !== true) where.push('revoked_at IS NULL');
  const sql = `SELECT * FROM devices${where.length > 0 ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY enrolled_at, id`;
  return db.prepare(sql).all(...args).map(toDevice);
}

/** Device row including its public key, for the unlock handshake. */
export function getDeviceWithKey(
  db: DatabaseSync,
  id: string,
): (Device & { publicJwk: JsonWebKey | null }) | undefined {
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  if (row === undefined) return undefined;
  let publicJwk: JsonWebKey | null = null;
  try {
    publicJwk = typeof row.public_jwk === 'string' ? (JSON.parse(row.public_jwk) as JsonWebKey) : null;
  } catch {
    publicJwk = null;
  }
  return { ...toDevice(row), publicJwk };
}

/** Revoke a device and all its sessions at once. Idempotent; 404 for an unknown id. */
export function revokeDevice(db: DatabaseSync, id: string, actor: string, meta?: ChangeMeta): void {
  const now = new Date().toISOString();
  tx(db, () => {
    if (db.prepare('SELECT 1 AS x FROM devices WHERE id = ?').get(id) === undefined) {
      throw new AuthError(404, 'device_not_found', 'Peranti tidak dijumpai');
    }
    if (revokeDeviceRow(db, id, actor, now, meta)) bumpVersion(db);
  });
}

export function touchDevice(db: DatabaseSync, id: string): void {
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}
