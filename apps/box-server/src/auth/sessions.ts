import type { DatabaseSync } from 'node:sqlite';
import type { Role } from '@surau/core';
import { hashPin, isValidPin, pinPepperOf, randomToken, sha256hex, verifyP256, verifyPin } from './crypto.ts';
import { appLockRequiredFor } from './appLock.ts';
import { getDeviceWithKey } from './devices.ts';
import { revokeOrphanKioskDevices } from './pairing.ts';
import { bumpVersion } from '../settingsStore.ts';
import { AuthError, MSG, getAuthUser, getUserRow, logChange, tx } from './users.ts';

export const CHALLENGE_TTL_MS = 60_000;
export const MAX_LIVE_NONCES = 5;
export const SESSION_ABSOLUTE_MS = 12 * 3_600_000;
export const SESSION_IDLE_MS = 2 * 3_600_000;
export const TOUCH_INTERVAL_MS = 60_000;
export const PIN_MAX_FAILS = 5;
export const LOCK_BASE_MINUTES = 15;
export const LOCK_MAX_MINUTES = 24 * 60;
/** auth_log rows older than this are trimmed by purgeExpired. */
export const AUTH_LOG_KEEP_DAYS = 180;

export interface AuthContext {
  kind: 'user';
  userId: string;
  deviceId: string;
  roles: Role[];
  sessionId: string;
}

/** A linked site (a box talking to the cloud), authenticated by its site key. */
export interface SiteAuth {
  kind: 'site';
  boxId: string;
  surauId: string;
}

export interface UnlockInput {
  deviceId: string;
  nonce: string;
  /** base64url, IEEE P1363 (r||s, 64 bytes). */
  signature: string;
  /** The current PIN. Ignored when `newPin` is present. */
  pin?: string;
  /**
   * Set the first PIN after an admin reset. Accepted only for a user with NO PIN and only after
   * the device signature verified; a user who has a PIN gets 400 and the normal path applies.
   */
  newPin?: string;
}

const NONCE_MSG = 'Cabaran (nonce) tidak sah, telah digunakan atau tamat';
const SIG_MSG = 'Tandatangan peranti tidak sah';

export function authLog(
  db: DatabaseSync,
  now: Date,
  event: string,
  ok: boolean,
  f: { userId?: string | null; deviceId?: string | null; ip?: string | null; detail?: string },
): void {
  // detail is always a fixed reason code; it never carries the PIN, nonce, signature or token.
  db.prepare(
    `INSERT INTO auth_log (at, event, user_id, device_id, ip, ok, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(now.toISOString(), event, f.userId ?? null, f.deviceId ?? null, f.ip ?? null, ok ? 1 : 0, f.detail ?? null);
}

function fail(
  db: DatabaseSync,
  now: Date,
  ip: string,
  f: { userId?: string | null; deviceId?: string | null },
  reason: string,
  status: 401 | 423,
  message: string,
  retryAfterSec?: number,
): never {
  authLog(db, now, 'unlock', false, { ...f, ip, detail: reason });
  throw new AuthError(status, reason, message, retryAfterSec);
}

/** Issue a single-use nonce (60 s) for a live device. At most 5 live nonces per device. */
export function issueChallenge(db: DatabaseSync, deviceId: string, now: Date): { nonce: string; expiresAt: string } {
  const device = typeof deviceId === 'string' && deviceId.length <= 100 ? getDeviceWithKey(db, deviceId) : undefined;
  // Unknown and revoked devices get the same answer.
  if (device === undefined || device.revokedAt !== null) {
    throw new AuthError(401, 'device_revoked', MSG.deviceRevoked);
  }
  const nowIso = now.toISOString();
  const nonce = randomToken(32);
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString();
  tx(db, () => {
    db.prepare('DELETE FROM challenges WHERE device_id = ? AND (expires_at <= ? OR used_at IS NOT NULL)').run(
      device.id,
      nowIso,
    );
    // Keep the newest (MAX-1) live ones so that, with the new nonce, there are at most MAX.
    db.prepare(
      `DELETE FROM challenges WHERE device_id = ? AND nonce NOT IN (
         SELECT nonce FROM challenges WHERE device_id = ? ORDER BY expires_at DESC, rowid DESC LIMIT ?
       )`,
    ).run(device.id, device.id, MAX_LIVE_NONCES - 1);
    db.prepare('INSERT INTO challenges (nonce, device_id, expires_at) VALUES (?, ?, ?)').run(
      nonce,
      device.id,
      expiresAt,
    );
  });
  return { nonce, expiresAt };
}

function lockMinutes(round: number): number {
  const r = Math.max(0, Math.min(round, 12));
  return Math.min(LOCK_BASE_MINUTES * 2 ** r, LOCK_MAX_MINUTES);
}

function minutesLeft(untilIso: string, now: Date): number {
  return Math.max(1, Math.ceil((new Date(untilIso).getTime() - now.getTime()) / 60_000));
}

/** Dummy hash so an account with no PIN costs the same as one with a PIN. Never matches. */
const NO_PIN_HASH =
  'scrypt2$N=32768,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/**
 * Challenge-response unlock. Cheap checks run first; the lockout state (persisted in SQLite) is
 * checked, and the attempt counted, BEFORE the expensive PIN verification, so parallel guesses
 * cannot outrun the limit.
 */
export async function unlock(
  db: DatabaseSync,
  boxId: string,
  input: UnlockInput,
  ip: string,
  now: Date,
): Promise<{ token: string; expiresAt: string; user: { id: string; name: string; roles: Role[] } }> {
  const deviceId = typeof input?.deviceId === 'string' ? input.deviceId : '';
  const nonce = typeof input?.nonce === 'string' ? input.nonce : '';
  const sigText = typeof input?.signature === 'string' ? input.signature : '';
  const pin = typeof input?.pin === 'string' ? input.pin : '';
  const settingNew = input?.newPin !== undefined && input?.newPin !== null;
  const newPin = typeof input?.newPin === 'string' ? input.newPin : '';
  const nowIso = now.toISOString();

  // 1. Device live.
  const device = deviceId.length > 0 && deviceId.length <= 100 ? getDeviceWithKey(db, deviceId) : undefined;
  if (device === undefined || device.revokedAt !== null || device.publicJwk === null) {
    return fail(db, now, ip, { deviceId: device?.id ?? null }, 'device_revoked', 401, MSG.deviceRevoked);
  }
  const who = { userId: device.userId, deviceId: device.id };

  // 2. Nonce live, for this device, unused: claimed atomically (single use).
  const claimed =
    nonce.length > 0 && nonce.length <= 100
      ? db
          .prepare(
            `UPDATE challenges SET used_at = ?
             WHERE nonce = ? AND device_id = ? AND used_at IS NULL AND expires_at > ?`,
          )
          .run(nowIso, nonce, device.id, nowIso)
      : { changes: 0 };
  if (Number(claimed.changes) !== 1) return fail(db, now, ip, who, 'bad_nonce', 401, NONCE_MSG);

  // 3. Signature over the nonce, device and box (the nonce stays used on failure).
  const message = Buffer.from(`surau-unlock\n${boxId}\n${device.id}\n${nonce}`, 'utf8');
  const sig = /^[A-Za-z0-9_-]{86}$/.test(sigText) ? Buffer.from(sigText, 'base64url') : Buffer.alloc(0);
  if (!verifyP256(device.publicJwk, message, sig)) return fail(db, now, ip, who, 'bad_signature', 401, SIG_MSG);

  // 3a. App lock off: the device key is the single factor. The nonce, signature, device and user
  // checks above and below are exactly the ones used with the lock on; only the PIN step is gone.
  // PIN state (hash, counter, lockout) is neither read nor changed, `pin` and `newPin` are ignored.
  if (!appLockRequiredFor(db, getUserRow(db, device.userId)?.roles ?? [])) {
    type Open =
      | { state: 'ok'; token: string; expiresAt: string; roles: Role[] }
      | { state: 'user_gone' }
      | { state: 'device_gone' };
    const opened = tx(db, (): Open => {
      const user = getAuthUser(db, device.userId);
      if (user === undefined || !user.active) return { state: 'user_gone' };
      const dev = db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(device.id);
      if (dev === undefined || dev.revoked_at !== null) return { state: 'device_gone' };
      const token = randomToken(32);
      const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS).toISOString();
      db.prepare(
        `INSERT INTO sessions (id, token_hash, device_id, user_id, created_at, expires_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(randomToken(12), sha256hex(token), device.id, user.id, nowIso, expiresAt, nowIso);
      db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(nowIso, device.id);
      authLog(db, now, 'unlock', true, { ...who, ip, detail: 'no_pin' });
      return { state: 'ok', token, expiresAt, roles: user.roles };
    });
    if (opened.state === 'user_gone') return fail(db, now, ip, who, 'user_inactive', 401, MSG.deviceRevoked);
    if (opened.state === 'device_gone') return fail(db, now, ip, who, 'device_revoked', 401, MSG.deviceRevoked);
    const row = getUserRow(db, device.userId)!;
    return { token: opened.token, expiresAt: opened.expiresAt, user: { id: row.id, name: row.name, roles: opened.roles } };
  }

  // 3b. A weak or malformed new PIN is a 400. Only the holder of the device key reaches this
  // point, and it is not a guess at an existing secret, so it is not counted as a failed PIN.
  if (settingNew && !isValidPin(newPin)) {
    authLog(db, now, 'unlock', false, { ...who, ip, detail: 'weak_new_pin' });
    throw new AuthError(400, 'pin_policy', MSG.pinPolicy);
  }

  // 4. User active, not locked; count this attempt before the slow hash runs.
  type Reserve =
    | { state: 'ok'; pinHash: string | null; name: string }
    | { state: 'locked'; minutes: number }
    | { state: 'pin_exists' }
    | { state: 'pin_required' }
    | { state: 'pin_missing' }
    | { state: 'gone' };
  const reserved = tx(db, (): Reserve => {
    const user = getAuthUser(db, device.userId);
    if (user === undefined || !user.active) return { state: 'gone' };
    if (user.pinLockedUntil !== null && user.pinLockedUntil > nowIso) {
      return { state: 'locked', minutes: minutesLeft(user.pinLockedUntil, now) };
    }
    // Count at the limit with no lock: the 5th attempt is still in flight, or its outcome was never
    // recorded (a crash between the reservation and the outcome). Impose the real lock now so the
    // account can never stay stuck at "locked for 1 minute" with nothing to end it.
    if (user.pinFailCount >= PIN_MAX_FAILS) {
      const minutes = lockMinutes(user.lockRound);
      const until = new Date(now.getTime() + minutes * 60_000).toISOString();
      db.prepare(
        'UPDATE users SET pin_fail_count = 0, pin_locked_until = ?, lock_round = lock_round + 1 WHERE id = ?',
      ).run(until, user.id);
      return { state: 'locked', minutes };
    }
    // Only the device-key holder gets here, so these two answers reveal nothing to an outsider.
    // Neither is a guess at the PIN, so neither is counted.
    if (settingNew && user.pinHash !== null) return { state: 'pin_exists' };
    if (!settingNew && user.pinHash === null) return { state: 'pin_required' };
    // An empty PIN is not a guess: say so without counting an attempt (the nonce stays spent).
    if (!settingNew && pin === '') return { state: 'pin_missing' };
    db.prepare('UPDATE users SET pin_fail_count = pin_fail_count + 1, pin_locked_until = NULL WHERE id = ?').run(
      user.id,
    );
    return { state: 'ok', pinHash: user.pinHash, name: user.name };
  });
  if (reserved.state === 'gone') return fail(db, now, ip, who, 'user_inactive', 401, MSG.deviceRevoked);
  if (reserved.state === 'locked') {
    return fail(db, now, ip, who, 'locked', 423, MSG.locked(reserved.minutes), reserved.minutes * 60);
  }

  if (reserved.state === 'pin_exists') {
    authLog(db, now, 'unlock', false, { ...who, ip, detail: 'pin_exists' });
    throw new AuthError(400, 'pin_exists', MSG.pinExists);
  }
  if (reserved.state === 'pin_required') {
    authLog(db, now, 'unlock', false, { ...who, ip, detail: 'pin_required' });
    throw new AuthError(409, 'pin_required', MSG.pinRequired);
  }
  if (reserved.state === 'pin_missing') {
    authLog(db, now, 'unlock', false, { ...who, ip, detail: 'pin_missing' });
    throw new AuthError(401, 'pin_missing', MSG.pinMissing);
  }

  // 5. PIN. A missing hash is verified against a dummy so the cost is the same.
  const newHash = settingNew ? await hashPin(newPin, pinPepperOf(db)) : null;
  const pinOk = settingNew ? false : await verifyPin(pin, reserved.pinHash ?? NO_PIN_HASH, pinPepperOf(db));
  const good = settingNew ? newHash !== null : pinOk && reserved.pinHash !== null;

  type Outcome =
    | { state: 'ok'; token: string; expiresAt: string; roles: Role[] }
    | { state: 'wrong' }
    | { state: 'pin_exists' }
    | { state: 'locked'; minutes: number }
    | { state: 'gone' };
  const outcome = tx(db, (): Outcome => {
    const user = getAuthUser(db, device.userId);
    const dev = db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(device.id);
    if (user === undefined || !user.active || dev === undefined || dev.revoked_at !== null) {
      return { state: 'gone' };
    }
    if (good) {
      // A lock imposed by a parallel attempt while we were hashing still wins.
      if (user.pinLockedUntil !== null && user.pinLockedUntil > nowIso) {
        authLog(db, now, 'unlock', false, { ...who, ip, detail: 'locked' });
        return { state: 'locked', minutes: minutesLeft(user.pinLockedUntil, now) };
      }
      if (newHash !== null) {
        // Set only while there is still no PIN: of two parallel requests exactly one wins.
        const set = db
          .prepare(
            `UPDATE users SET pin_hash = ?, pin_fail_count = 0, pin_locked_until = NULL, lock_round = 0
             WHERE id = ? AND pin_hash IS NULL`,
          )
          .run(newHash, user.id);
        if (Number(set.changes) !== 1) {
          authLog(db, now, 'unlock', false, { ...who, ip, detail: 'pin_exists' });
          return { state: 'pin_exists' };
        }
        const snap = { id: user.id, name: user.name, roles: user.roles, active: user.active };
        logChange(db, `user:${user.id}`, 'users', user.id, { ...snap, hasPin: false }, { ...snap, hasPin: true, pinChanged: true });
        bumpVersion(db);
      } else {
        db.prepare(
          'UPDATE users SET pin_fail_count = 0, pin_locked_until = NULL, lock_round = 0 WHERE id = ?',
        ).run(user.id);
      }
      const token = randomToken(32);
      const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS).toISOString();
      db.prepare(
        `INSERT INTO sessions (id, token_hash, device_id, user_id, created_at, expires_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(randomToken(12), sha256hex(token), device.id, user.id, nowIso, expiresAt, nowIso);
      db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(nowIso, device.id);
      authLog(db, now, 'unlock', true, { ...who, ip });
      return { state: 'ok', token, expiresAt, roles: user.roles };
    }
    // Wrong PIN. The attempt was already counted in step 4; lock at the limit.
    if (user.pinFailCount >= PIN_MAX_FAILS) {
      const minutes = lockMinutes(user.lockRound);
      const until = new Date(now.getTime() + minutes * 60_000).toISOString();
      db.prepare(
        'UPDATE users SET pin_fail_count = 0, pin_locked_until = ?, lock_round = lock_round + 1 WHERE id = ?',
      ).run(until, user.id);
      authLog(db, now, 'unlock', false, { ...who, ip, detail: 'locked' });
      return { state: 'locked', minutes };
    }
    authLog(db, now, 'unlock', false, { ...who, ip, detail: 'wrong_pin' });
    return { state: 'wrong' };
  });

  if (outcome.state === 'ok') {
    const user = getUserRow(db, device.userId)!;
    return { token: outcome.token, expiresAt: outcome.expiresAt, user: { id: user.id, name: user.name, roles: outcome.roles } };
  }
  if (outcome.state === 'gone') return fail(db, now, ip, who, 'device_revoked', 401, MSG.deviceRevoked);
  if (outcome.state === 'pin_exists') throw new AuthError(400, 'pin_exists', MSG.pinExists);
  if (outcome.state === 'locked') throw new AuthError(423, 'locked', MSG.locked(outcome.minutes), outcome.minutes * 60);
  throw new AuthError(401, 'wrong_pin', MSG.wrongPin);
}

/**
 * Resolve a bearer token to its context, or null. Dead when missing, revoked, past the absolute
 * or idle expiry, its device is revoked, or its user is inactive. `last_used_at` is bumped at
 * most once a minute and never moves backwards, so a clock that steps back cannot extend a
 * session; a session created "in the future" (clock stepped back since) is refused.
 */
export function resolveSession(db: DatabaseSync, token: string, now: Date, touch = true): AuthContext | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 200) return null;
  const row = db
    .prepare(
      `SELECT s.id, s.user_id, s.device_id, s.created_at, s.expires_at, s.last_used_at, s.revoked_at,
              d.revoked_at AS device_revoked_at
         FROM sessions s JOIN devices d ON d.id = s.device_id
        WHERE s.token_hash = ?`,
    )
    .get(sha256hex(token));
  if (row === undefined) return null;
  if (row.revoked_at !== null || row.device_revoked_at !== null) return null;
  const t = now.getTime();
  const nowIso = now.toISOString();
  if (String(row.expires_at) <= nowIso) return null;
  const created = new Date(String(row.created_at)).getTime();
  const last = new Date(String(row.last_used_at)).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(last)) return null;
  if (t < created) return null;
  if (t - last >= SESSION_IDLE_MS) return null;
  const user = getUserRow(db, String(row.user_id));
  if (user === undefined || !user.active) return null;
  // `touch = false` is a pure validity check (an open event stream must not keep a session alive).
  if (touch && t - last >= TOUCH_INTERVAL_MS) {
    db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ? AND last_used_at < ?').run(
      nowIso,
      String(row.id),
      nowIso,
    );
  }
  return {
    kind: 'user',
    userId: user.id,
    deviceId: String(row.device_id),
    roles: user.roles,
    sessionId: String(row.id),
  };
}

/**
 * Resolve a site key (bearer token) to its site, or null. Dead when unknown, not linked, or revoked.
 * Only the SHA-256 of the key is stored. `last_seen_at` is bumped at most once a minute.
 */
export function resolveSite(db: DatabaseSync, token: string, now: Date): SiteAuth | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 200) return null;
  const row = db
    .prepare(
      `SELECT box_id, surau_id, last_seen_at FROM sites
        WHERE token_hash = ? AND revoked_at IS NULL AND linked_at IS NOT NULL`,
    )
    .get(sha256hex(token));
  if (row === undefined) return null;
  const last = typeof row.last_seen_at === 'string' ? new Date(row.last_seen_at).getTime() : 0;
  if (!(now.getTime() - last < TOUCH_INTERVAL_MS)) {
    db.prepare('UPDATE sites SET last_seen_at = ? WHERE box_id = ?').run(now.toISOString(), String(row.box_id));
  }
  return { kind: 'site', boxId: String(row.box_id), surauId: String(row.surau_id) };
}

/**
 * For a bearer token that no longer resolves: the user and device of a still-unexpired session whose DEVICE
 * has been revoked, else null. Used only to tell a revoked device's sync batch why it was refused.
 */
export function deviceRevokedForToken(
  db: DatabaseSync,
  token: string,
  now: Date,
): { userId: string; deviceId: string } | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 200) return null;
  const row = db
    .prepare(
      `SELECT s.user_id, s.device_id FROM sessions s JOIN devices d ON d.id = s.device_id
        WHERE s.token_hash = ? AND d.revoked_at IS NOT NULL AND s.expires_at > ?`,
    )
    .get(sha256hex(token), now.toISOString());
  return row === undefined ? null : { userId: String(row.user_id), deviceId: String(row.device_id) };
}

export function revokeSession(db: DatabaseSync, id: string): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
    new Date().toISOString(),
    id,
  );
}

export function revokeUserSessions(db: DatabaseSync, userId: string): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(
    new Date().toISOString(),
    userId,
  );
}

/** Delete dead challenges, sessions, enrolments, kiosk pairings and cookies, and old auth_log rows. Called hourly by main. */
export function purgeExpired(db: DatabaseSync, now: Date): void {
  const nowIso = now.toISOString();
  const idleCut = new Date(now.getTime() - SESSION_IDLE_MS).toISOString();
  tx(db, () => {
    db.prepare('DELETE FROM challenges WHERE expires_at <= ? OR used_at IS NOT NULL AND used_at <= ?').run(
      nowIso,
      nowIso,
    );
    db.prepare(
      'DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL OR last_used_at <= ?',
    ).run(nowIso, idleCut);
    // A used or expired code stays a day: the issuer's list of recent codes (GET /api/enrol/recent) reads it.
    db.prepare('DELETE FROM enrolments WHERE COALESCE(used_at, expires_at) <= ?').run(
      new Date(now.getTime() - 24 * 3_600_000).toISOString(),
    );
    // A pairing that was approved but never claimed leaves a device row without a cookie.
    revokeOrphanKioskDevices(db, nowIso);
    db.prepare('DELETE FROM kiosk_pairings WHERE expires_at <= ?').run(nowIso);
    // Box QR codes: used rows stay a day for the record.
    db.prepare('DELETE FROM box_codes WHERE expires_at <= ?').run(
      new Date(now.getTime() - 24 * 3_600_000).toISOString(),
    );
    // Cookies of revoked devices and expired cookies are dead weight.
    db.prepare(
      'DELETE FROM kiosk_cookies WHERE expires_at <= ? OR device_id IN (SELECT id FROM devices WHERE revoked_at IS NOT NULL)',
    ).run(nowIso);
    db.prepare('DELETE FROM auth_log WHERE at < ?').run(
      new Date(now.getTime() - AUTH_LOG_KEEP_DAYS * 24 * 3_600_000).toISOString(),
    );
  });
}
