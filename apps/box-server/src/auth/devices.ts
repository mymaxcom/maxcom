import { createPublicKey, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isoInstantMs } from '@surau/core';
import type { Role } from '@surau/core';
import { hashPin, hashPinSyncWith, isValidPin, pinPepperOf, randomToken, sha256hex } from './crypto.ts';
import type { JsonWebKey } from './crypto.ts';
import { appLockRequiredFor } from './appLock.ts';
import { AuthError, MSG, bumpFor, cleanNameText, deactivateUserIn, deleteUserIn, deviceSurau, announceSurau, getUserRow, logChange, requireSuperadminTarget, revokeDeviceRow, serverBoxIdOf, serverRoleOf, stampRow, tx, userSurau } from './users.ts';
import { MAX_OPS_DEVICES, effectiveRolesFor, holdsOpsRole } from './opsDevice.ts';
import { assignNewNo, refOfRow } from './ids.ts';
import type { ChangeMeta } from '../sync/meta.ts';
import { LOCAL_SURAU_ID } from '../tenant.ts';

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
  /** The allocated ID number and series (null while the device waits for one) and its short form (`D-0001`). */
  no: number | null;
  noSrc: 'b' | 'c' | null;
  ref: string | null;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const MAX_OPEN_CODES = 3;

export function newCode(): string {
  const bytes = randomBytes(12);
  let raw = '';
  for (const b of bytes) raw += B32[b & 31]; // 32 symbols: the mask is unbiased
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export function normaliseCode(code: unknown): string {
  return typeof code === 'string' ? code.replace(/[\s-]/g, '').toUpperCase() : '';
}

export function cleanName(name: unknown, fallback: string): string {
  if (typeof name !== 'string') return fallback;
  return cleanNameText(name) ?? fallback;
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

export function deviceFromRow(row: Record<string, unknown>): Device {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    platform: String(row.platform) as Platform,
    enrolledAt: String(row.enrolled_at),
    lastSeenAt: typeof row.last_seen_at === 'string' ? row.last_seen_at : null,
    revokedAt: typeof row.revoked_at === 'string' ? row.revoked_at : null,
    no: Number.isInteger(row.no) ? Number(row.no) : null,
    noSrc: row.no_src === 'b' || row.no_src === 'c' ? row.no_src : null,
    ref: refOfRow(row, 'device'),
  };
}

/**
 * Secret-free device snapshot for change_log. It carries the PUBLIC key (never anything secret) so an
 * enrolment can travel to the other side of the sync; only site feeds ever hand it out (feed.ts).
 */
export function snap(d: Device, publicJwk: JsonWebKey, homeBox: string | null = null): Record<string, unknown> {
  return {
    ...(d.no !== null && d.noSrc !== null ? { no: d.no, noSrc: d.noSrc } : {}),
    id: d.id,
    userId: d.userId,
    name: d.name,
    platform: d.platform,
    revoked: d.revokedAt !== null,
    publicJwk,
    enrolledAt: d.enrolledAt,
    // Only a box names the home box, and only on the way up: the cloud never sends `boxId` down (an unmodified box
    // refuses a device entry with an unknown key, plan section 11 item 10).
    ...(homeBox !== null ? { boxId: homeBox } : {}),
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
 *
 * On the cloud, a user holding an ops role (Pentadbir MAXCOM, support) gets no ordinary code at all
 * (`ops_cli_only`, Plan 14 section 3.4): only `caller.opsCli`, set by `issueOpsEnrolment` for the cloud CLI and
 * never from a request, issues one, and that code is an ops code (`enrolments.ops = 1`).
 */
export function beginEnrolment(
  db: DatabaseSync,
  input: { userId: string; deviceName: string; ttlMinutes?: number },
  actor: string,
  caller: { canManageSuperadmin: boolean; opsCli?: boolean } = { canManageSuperadmin: false },
): { code: string; expiresAt: string; id: number } {
  const ttl = input.ttlMinutes ?? 10;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 60) {
    throw new AuthError(400, 'bad_ttl', 'Tempoh kod tidak sah');
  }
  const deviceName = cleanName(input.deviceName, 'Peranti');
  const opsCli = caller.opsCli === true;
  const cloud = serverRoleOf(db) === 'cloud';
  // Checked first and logged outside the transaction, so the refusal row survives the throw.
  if (!opsCli && cloud && holdsOpsRole(getUserRow(db, input.userId)?.roles ?? [])) {
    authLog(db, 'enrol-begin', false, { userId: input.userId, detail: 'ops_cli_only' });
    throw new AuthError(403, 'ops_cli_only', 'Peranti MAXCOM Ops didaftarkan melalui awan MAXCOM sahaja');
  }
  return tx(db, () => {
    const user = getUserRow(db, input.userId);
    if (user === undefined || !user.active || user.deleted) {
      throw new AuthError(404, 'user_not_found', 'Pengguna tidak dijumpai');
    }
    const opsUser = holdsOpsRole(user.roles);
    if (!opsCli && cloud && opsUser) {
      throw new AuthError(403, 'ops_cli_only', 'Peranti MAXCOM Ops didaftarkan melalui awan MAXCOM sahaja');
    }
    const nowIso = new Date().toISOString();
    if (opsCli) {
      if (!opsUser) throw new AuthError(403, 'not_ops_user', 'Pengguna ini tiada peranan MAXCOM Ops');
      // live ops devices plus open ops codes: issuing many codes first cannot outrun the cap
      const live = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND ops = 1 AND revoked_at IS NULL').get(user.id);
      const pending = db
        .prepare('SELECT COUNT(*) AS n FROM enrolments WHERE user_id = ? AND ops = 1 AND used_at IS NULL AND expires_at > ?')
        .get(user.id, nowIso);
      if (Number(live?.n ?? 0) + Number(pending?.n ?? 0) >= MAX_OPS_DEVICES) {
        throw new AuthError(409, 'ops_device_limit', `Had ${MAX_OPS_DEVICES} peranti MAXCOM Ops bagi pengguna ini telah dicapai`);
      }
    } else {
      // A code for a Pentadbir MAXCOM is a way in as that user: only superadmin:manage may issue one (default: refused).
      requireSuperadminTarget(db, user.id, caller.canManageSuperadmin);
    }
    const open = db
      .prepare('SELECT COUNT(*) AS n FROM enrolments WHERE user_id = ? AND used_at IS NULL AND expires_at > ?')
      .get(user.id, nowIso);
    if (Number(open?.n ?? 0) >= MAX_OPEN_CODES) throw new AuthError(429, 'too_many_codes', MSG.tooMany);
    const code = newCode();
    const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();
    const inserted = db.prepare(
      `INSERT INTO enrolments (code_hash, user_id, device_name, expires_at, created_by, ops) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sha256hex(normaliseCode(code)), user.id, deviceName, expiresAt, actor, opsCli ? 1 : 0);
    authLog(db, 'enrol-begin', true, { userId: user.id, detail: opsCli ? 'ops_code' : `by ${actor}` });
    return { code, expiresAt, id: Number(inserted.lastInsertRowid) };
  });
}

export interface EnrolInput {
  code: string;
  publicJwk: JsonWebKey;
  deviceName?: string;
  platform: string;
  pin?: string;
  /** `'ops'` only from the MAXCOM Ops build; an ops code without it is refused (`ops_app_required`). */
  client?: 'ops';
}

const OPS_APP_MSG = 'Kod ini untuk aplikasi MAXCOM Ops sahaja';

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

/** The three ways a code is refused, each with its own code so the app can say which (finding A10). */
const CODE_UNKNOWN = (): AuthError => new AuthError(401, 'enrol_code_unknown', 'Kod pendaftaran tidak sah');
const CODE_EXPIRED = (): AuthError => new AuthError(401, 'enrol_code_expired', 'Kod pendaftaran telah tamat');
const CODE_USED = (): AuthError => new AuthError(401, 'enrol_code_used', 'Kod pendaftaran sudah digunakan');

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
    throw CODE_USED();
  }
  if (enrol === undefined || expired) {
    authLog(db, 'enrol', false, { ip, detail: 'kod tidak sah atau tamat' });
    throw enrol === undefined ? CODE_UNKNOWN() : CODE_EXPIRED();
  }
  const user = getUserRow(db, String(enrol.user_id));
  if (user === undefined || !user.active) {
    authLog(db, 'enrol', false, { userId: String(enrol.user_id), ip, detail: 'pengguna tidak aktif' });
    throw CODE_UNKNOWN();
  }
  // Mistake guard (not security): an ops code typed into the public app is refused and stays unused.
  if (Number(enrol.ops) === 1 && input.client !== 'ops') {
    authLog(db, 'enrol', false, { userId: user.id, ip, detail: 'ops_app_required' });
    throw new AuthError(401, 'ops_app_required', OPS_APP_MSG);
  }
  if (input.pin !== undefined && !user.pinRequired) {
    throw new AuthError(400, 'pin_exists', 'PIN sudah ditetapkan untuk pengguna ini');
  }
  return { jwk, platform, codeHash };
}

/**
 * The surau an ordinary device enrolled for this user belongs to: the surau the enrolment was issued in, which is
 * the surau of the user it was issued for (a code is only issued for a user of the issuing admin's surau). A box
 * is one surau, the local one.
 */
function enrolSurauOf(db: DatabaseSync, userId: string): string {
  if (serverRoleOf(db) !== 'cloud') return LOCAL_SURAU_ID;
  const surau = userSurau(db, userId);
  // A non-ops code for a Pentadbir MAXCOM can only be one issued before the account held an ops role (the pilot's
  // only Pentadbir): its device stays in the local surau, a public device.
  return surau === '*' ? LOCAL_SURAU_ID : surau;
}

/**
 * The tail every enrolment shares: insert the device row, set the PIN hash, write the change_log and auth_log rows,
 * bump the version. The caller owns the transaction and has already proved the right to enrol (a code, or the
 * box's own setup or recovery).
 */
function insertEnrolledDevice(
  db: DatabaseSync,
  user: { id: string; roles: Role[]; pinRequired: boolean },
  d: { jwk: JsonWebKey; platform: Platform; name: string; pinHash: string | null; ip: string; now: string; ops?: { by: string } },
): EnrolOutcome {
  const { jwk, platform, name, pinHash, ip, now } = d;
  const deviceId = randomToken(12);
  // A box is the phone's home box: it signs with this box's id (Plan 14 Task 7). A device enrolled on the cloud
  // itself, and every ops device, keeps NULL and verifies against the cloud's own id.
  const homeBox = d.ops === undefined && serverRoleOf(db) === 'box' ? serverBoxIdOf(db) : null;
  if (d.ops !== undefined) {
    // An ops device: born from a CLI ops code only. Works in every surau (`*`); signatures verify against this
    // server's own id (no home box).
    db.prepare(
      `INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at, ops, ops_at, ops_by, surau_id, box_id)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, '*', NULL)`,
    ).run(deviceId, user.id, name, platform, JSON.stringify(jwk), now, now, d.ops.by);
  } else {
    db.prepare(
      `INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at, surau_id, box_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(deviceId, user.id, name, platform, JSON.stringify(jwk), now, enrolSurauOf(db, user.id), homeBox);
  }
  const deviceScope = deviceSurau(db, deviceId);
  assignNewNo(db, 'device', deviceId, deviceScope);
  if (pinHash !== null) {
    db.prepare(
      `UPDATE users SET pin_hash = ?, pin_fail_count = 0, pin_locked_until = NULL, lock_round = 0 WHERE id = ?`,
    ).run(pinHash, user.id);
  }
  const device = deviceFromRow(
    db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as Record<string, unknown>,
  );
  logChange(db, `user:${user.id}`, 'devices', deviceId, undefined, snap(device, jwk, homeBox), undefined, deviceScope);
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
      { ...userSnap, hasPin: true, pinChanged: true }, undefined, userSurau(db, user.id),
    );
  }
  authLog(db, 'enrol', true, { userId: user.id, deviceId, ip });
  if (d.ops !== undefined) authLog(db, 'ops_enrol', true, { userId: user.id, deviceId, ip, detail: 'ops_enrol' });
  bumpFor(db, deviceScope);
  // The PIN rule reads the real roles (stricter); the answer carries only the roles this device acts with.
  const appLock = appLockRequiredFor(db, user.roles, announceSurau(deviceScope));
  return {
    deviceId,
    userId: user.id,
    roles: effectiveRolesFor(db, user, deviceId, { role: serverRoleOf(db) }),
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
      const refuse = enrol === undefined ? CODE_UNKNOWN() : enrol.used_at !== null ? CODE_USED() : CODE_EXPIRED();
      return { refuse, log: { detail: 'kod tidak sah atau tamat' } };
    }
    const user = getUserRow(db, String(enrol.user_id));
    if (user === undefined || !user.active) {
      return { refuse: CODE_UNKNOWN(), log: { userId: String(enrol.user_id), detail: 'pengguna tidak aktif' } };
    }
    const opsCode = Number(enrol.ops) === 1;
    if (opsCode && input.client !== 'ops') {
      return { refuse: new AuthError(401, 'ops_app_required', OPS_APP_MSG), log: { userId: user.id, detail: 'ops_app_required' } };
    }
    if (pinHash !== null && !user.pinRequired) {
      return { refuse: new AuthError(400, 'pin_exists', 'PIN sudah ditetapkan untuk pengguna ini'), log: { userId: user.id, detail: 'pin_exists' } };
    }
    const claimed = db
      .prepare('UPDATE enrolments SET used_at = ? WHERE code_hash = ? AND used_at IS NULL')
      .run(now, codeHash);
    if (Number(claimed.changes) !== 1) {
      return { refuse: CODE_USED(), log: { userId: user.id, detail: 'kod sudah digunakan' } };
    }

    const name = cleanName(input.deviceName, cleanName(enrol.device_name, 'Peranti'));
    // An ops code stays an ops code only for a user who still holds an ops role; ops_by names the issuer.
    const ops = opsCode && holdsOpsRole(user.roles) ? { by: String(enrol.created_by) } : undefined;
    const outcome = insertEnrolledDevice(db, user, { jwk, platform, name, pinHash, ip, now, ...(ops !== undefined ? { ops } : {}) });
    // which device used the code: the Pentadbir's page names it at once
    db.prepare('UPDATE enrolments SET device_id = ? WHERE code_hash = ?').run(outcome.deviceId, codeHash);
    return outcome;
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
  /** The box the device signs for: on the cloud, the SENDING site's own box id (never a value from the entry). */
  homeBox: string | null = null,
  /** On the cloud, the SENDING site's surau (the tenant of the ingest). A `'*'` user's device takes it, never `'*'`. */
  siteSurau?: string,
): void {
  if (!SYNCED_ID.test(input.id)) throw new AuthError(400, 'bad_device', 'Peranti tidak sah');
  if (!PLATFORMS.includes(input.platform)) throw new AuthError(400, 'bad_platform', 'Platform tidak sah');
  if (isoInstantMs(input.enrolledAt) === null) throw new AuthError(400, 'bad_time', 'Masa tidak sah');
  const jwk = canonicalJwk(input.publicJwk);
  const user = getUserRow(db, input.userId);
  if (user === undefined || !user.active) throw new AuthError(404, 'user_not_found', 'Pengguna tidak dijumpai');
  const name = cleanName(input.name, 'Peranti');
  // The device belongs to the surau of its user (the surau it was enrolled in on the other side). A device of a
  // `'*'` user enrolled at a site is a public device of that site's surau (as `enrolSurauOf` for the local path):
  // only `ops-enrol` on the cloud files a device under `'*'`.
  const owner = serverRoleOf(db) === 'cloud' ? userSurau(db, user.id) : LOCAL_SURAU_ID;
  const deviceScope = owner === '*' ? (siteSurau !== undefined && siteSurau !== '*' ? siteSurau : LOCAL_SURAU_ID) : owner;
  db.prepare(
    `INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at, surau_id, box_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(input.id, user.id, name, input.platform, JSON.stringify(jwk), input.enrolledAt, deviceScope, homeBox);
  stampRow(db, 'devices', input.id, meta);
  const device = deviceFromRow(db.prepare('SELECT * FROM devices WHERE id = ?').get(input.id) as Record<string, unknown>);
  logChange(db, actor, 'devices', input.id, undefined, snap(device, jwk), meta, deviceScope);
  authLog(db, 'enrol-synced', true, { userId: user.id, deviceId: input.id, detail: meta.origin ?? null });
  bumpFor(db, deviceScope);
}

/**
 * Devices of one surau, plus the ops devices filed under `'*'` (never includes the public key). Revoked ones are
 * excluded unless asked for.
 */
export function listDevices(
  db: DatabaseSync,
  userId: string | undefined,
  opts: { includeRevoked?: boolean; includeStar?: boolean } = {},
  surauId: string,
): Device[] {
  const where: string[] = [opts.includeStar === true ? "surau_id IN (?, '*')" : STAR_FREE_DEVICE];
  const args: string[] = [surauId];
  if (userId !== undefined) {
    where.push('user_id = ?');
    args.push(userId);
  }
  if (opts.includeRevoked !== true) where.push('revoked_at IS NULL');
  const sql = `SELECT * FROM devices${where.length > 0 ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY enrolled_at, id`;
  return db.prepare(sql).all(...args).map(deviceFromRow);
}

/**
 * A device of a surau that is not a Pentadbir MAXCOM's: the surau's own and not an ops device, and its user not a
 * `'*'` user (on a box a superadmin's public device keeps the local surau).
 */
const STAR_FREE_DEVICE = "(surau_id = ? AND user_id NOT IN (SELECT id FROM users WHERE surau_id = '*'))";

/** A device as one surau sees it: by id, in the surau and not a Pentadbir MAXCOM's, unless `includeStar` (ops session). */
export function getDeviceInTenant(db: DatabaseSync, id: string, surauId: string, includeStar = false): Device | undefined {
  const row = includeStar
    ? db.prepare(`SELECT * FROM devices WHERE id = ? AND surau_id IN (?, '*')`).get(id, surauId)
    : db.prepare(`SELECT * FROM devices WHERE id = ? AND ${STAR_FREE_DEVICE}`).get(id, surauId);
  return row === undefined ? undefined : deviceFromRow(row);
}

/**
 * Active users holding `admin` (or `superadmin`), by their real roles in the database, with at least one unrevoked
 * device of this surau that is not a TV screen. Counted per surau.
 */
export function activeAdminDeviceCount(db: DatabaseSync, surauId: string): number {
  const rows = db
    .prepare(
      `SELECT u.roles_json AS roles FROM users u
       WHERE u.active = 1
         AND u.deleted_at IS NULL AND u.surau_id = ?
         AND EXISTS (SELECT 1 FROM devices d WHERE d.user_id = u.id AND d.surau_id = ? AND d.revoked_at IS NULL AND d.platform <> 'kiosk')`,
    )
    .all(surauId, surauId);
  let n = 0;
  for (const r of rows) {
    try {
      const roles = JSON.parse(String(r.roles)) as unknown;
      if (Array.isArray(roles) && (roles.includes('admin') || roles.includes('superadmin'))) n++;
    } catch {
      /* unreadable roles never count */
    }
  }
  return n;
}

/** Device row including its public key, home box and surau, for the unlock handshake and op verification. */
export function getDeviceWithKey(
  db: DatabaseSync,
  id: string,
): (Device & { publicJwk: JsonWebKey | null; boxId: string | null; surauId: string }) | undefined {
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  if (row === undefined) return undefined;
  let publicJwk: JsonWebKey | null = null;
  try {
    publicJwk = typeof row.public_jwk === 'string' ? (JSON.parse(row.public_jwk) as JsonWebKey) : null;
  } catch {
    publicJwk = null;
  }
  const boxId = typeof row.box_id === 'string' && row.box_id.length > 0 ? row.box_id : null;
  return { ...deviceFromRow(row), publicJwk, boxId, surauId: String(row.surau_id) };
}

/**
 * The box id a device's signatures must name (Plan 14 Task 7): its home box (`devices.box_id`), else this server's
 * own id (a device enrolled on the cloud itself, every ops device, a box device enrolled before Task 7). On the
 * cloud a home box counts only while it is a `sites` row of the device's own surau; otherwise null, and the
 * device can neither unlock nor sign an op (`box_mismatch`).
 */
export function expectedBoxId(
  db: DatabaseSync,
  device: { boxId: string | null; surauId: string },
  server: { boxId: string; role: 'box' | 'cloud' },
): string | null {
  if (device.boxId === null) return server.boxId;
  if (server.role !== 'cloud') return device.boxId;
  const site = db.prepare('SELECT 1 AS x FROM sites WHERE box_id = ? AND surau_id = ?').get(device.boxId, device.surauId);
  return site === undefined ? null : device.boxId;
}

/** Revoke a device and all its sessions at once. Idempotent; 404 for an unknown id. */
export function revokeDevice(db: DatabaseSync, id: string, actor: string, meta?: ChangeMeta): void {
  const now = new Date().toISOString();
  tx(db, () => {
    if (db.prepare('SELECT 1 AS x FROM devices WHERE id = ?').get(id) === undefined) {
      throw new AuthError(404, 'device_not_found', 'Peranti tidak dijumpai');
    }
    if (revokeDeviceRow(db, id, actor, now, meta)) bumpFor(db, deviceSurau(db, id));
  });
}

/** A device name: the same rule as a user's name (trimmed, one space between words, 1 to 80, no control or direction characters). */
export function checkDeviceName(name: unknown): string {
  const clean = cleanNameText(name);
  if (clean === null) throw new AuthError(400, 'bad_name', 'Nama tidak sah');
  return clean;
}

/**
 * Rename a device (phone, tablet, computer or TV screen). A revoked device cannot be renamed (409); the same name
 * after cleaning is a no-op with no log row. Caller checked the tenant and the owner.
 */
export function renameDevice(db: DatabaseSync, id: string, name: string, actor: string, meta?: ChangeMeta): Device {
  const clean = checkDeviceName(name);
  return tx(db, () => renameDeviceRows(db, id, clean, actor, meta));
}

/** The body of `renameDevice` for a caller that owns the transaction (a replicated rename). `clean` is already checked. */
export function renameDeviceRows(db: DatabaseSync, id: string, clean: string, actor: string, meta?: ChangeMeta): Device {
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  if (row === undefined) throw new AuthError(404, 'device_not_found', 'Peranti tidak dijumpai');
  const before = deviceFromRow(row);
  if (before.revokedAt !== null) throw new AuthError(409, 'device_revoked', 'Peranti ini sudah dipadam');
  if (before.name === clean) return before;
  db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(clean, id);
  stampRow(db, 'devices', id, meta);
  const base = { id: before.id, userId: before.userId, platform: before.platform, revoked: false };
  const surau = String(row.surau_id);
  logChange(db, actor, 'devices', id, { ...base, name: before.name }, { ...base, name: clean }, meta, surau);
  bumpFor(db, surau);
  return { ...before, name: clean };
}

/** Refuse (409) a change that took a surau's Pentadbir phones from one or more to none. Caller owns the tx. */
function assertAdminPhoneLeft(db: DatabaseSync, surauId: string, countBefore: number): void {
  if (countBefore >= 1 && activeAdminDeviceCount(db, surauId) === 0) {
    throw new AuthError(409, 'last_admin_device', 'Daftar peranti Pentadbir lain dahulu');
  }
}

/**
 * Revoke a device as a Pentadbir's removal does: the last Pentadbir phone of the surau is never removed. Counted
 * before and after inside one transaction (as the phone's own leave does): a change from one or more to none rolls
 * the revoke back. A surau that already has none (the recovery state) is not blocked. The sync paths do not use this.
 */
export function revokeDeviceGuarded(db: DatabaseSync, id: string, actor: string): void {
  const now = new Date().toISOString();
  tx(db, () => {
    const row = db.prepare('SELECT surau_id FROM devices WHERE id = ?').get(id);
    if (row === undefined) throw new AuthError(404, 'device_not_found', 'Peranti tidak dijumpai');
    const surau = String(row.surau_id);
    const before = surau === '*' ? 0 : activeAdminDeviceCount(db, surau);
    if (revokeDeviceRow(db, id, actor, now)) bumpFor(db, deviceSurau(db, id));
    if (surau !== '*') assertAdminPhoneLeft(db, surau, before);
  });
}

/** Deactivate a user with the same guard: it may not leave the surau without a Pentadbir phone. */
export function deactivateUserGuarded(db: DatabaseSync, id: string, actor: string, surauId: string): void {
  tx(db, () => {
    const before = activeAdminDeviceCount(db, surauId);
    deactivateUserIn(db, id, actor);
    assertAdminPhoneLeft(db, surauId, before);
  });
}

/** Delete a user with the same guard: it may not leave the surau without a Pentadbir phone (rolls back). */
export function deleteUserGuarded(db: DatabaseSync, id: string, actor: string, surauId: string): void {
  tx(db, () => {
    const before = activeAdminDeviceCount(db, surauId);
    deleteUserIn(db, id, actor);
    assertAdminPhoneLeft(db, surauId, before);
  });
}

/** Before and after counts for a caller that revokes devices inside its own transaction (the PIN reset). */
export function adminPhoneGuard(db: DatabaseSync, surauId: string): () => void {
  const before = activeAdminDeviceCount(db, surauId);
  return () => assertAdminPhoneLeft(db, surauId, before);
}

export function touchDevice(db: DatabaseSync, id: string): void {
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}
