import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BoxQrType } from '@surau/core';
import { randomToken, sha256hex } from '../auth/crypto.ts';
import { CODE_ALPHABET } from '../sync/sites.ts';

export const NONCE_TTL_MS = 10 * 60 * 1000;
const RECOVERY_LENGTH = 16; // 16 symbols x 5 bits = 80 bits
const RECOVERY_HASH_KEY = 'recovery_code_hash';

const NONCE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export type NonceResult = 'ok' | 'bad' | 'expired';

/**
 * A fresh QR nonce of the type. Only its sha256 is stored. An earlier unused nonce of the same type is expired
 * first, so one live nonce per type exists at a time.
 */
export function issueNonce(
  db: DatabaseSync,
  type: BoxQrType,
  now: Date,
  ttlMs: number = NONCE_TTL_MS,
): { nonce: string; expiresAt: string } {
  const nowIso = now.toISOString();
  const nonce = randomToken(32);
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE box_codes SET expires_at = ? WHERE type = ? AND used_at IS NULL AND expires_at > ?').run(
      nowIso,
      type,
      nowIso,
    );
    db.prepare('INSERT INTO box_codes (nonce_hash, type, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      sha256hex(nonce),
      type,
      nowIso,
      expiresAt,
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { nonce, expiresAt };
}

/**
 * Spend a nonce, right or wrong: one UPDATE ... WHERE used_at IS NULL, so two callers racing on one nonce get one
 * `ok`. Safe to call inside a transaction the caller owns. An expired unused nonce is burned as `expired`.
 */
export function consumeNonce(db: DatabaseSync, type: BoxQrType, nonce: string, ip: string, now: Date): NonceResult {
  const nowIso = now.toISOString();
  const hash = sha256hex(typeof nonce === 'string' ? nonce : '');
  const r = db
    .prepare(
      `UPDATE box_codes SET used_at = ?, used_ip = ?, outcome = 'ok'
       WHERE nonce_hash = ? AND type = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .run(nowIso, ip, hash, type, nowIso);
  if (Number(r.changes) === 1) return 'ok';
  const e = db
    .prepare(
      `UPDATE box_codes SET used_at = ?, used_ip = ?, outcome = 'expired'
       WHERE nonce_hash = ? AND type = ? AND used_at IS NULL`,
    )
    .run(nowIso, ip, hash, type);
  return Number(e.changes) === 1 ? 'expired' : 'bad';
}

export type NonceStatus = 'live' | 'expired' | 'bad';

/**
 * A read-only look at a nonce that spends nothing: `live` when a row of this type exists, is unspent and not
 * expired; `expired` when it is unspent but past its time; `bad` for a wrong shape, an unknown or a spent nonce.
 * Run before any slow work and before the shared limits are charged, so junk cannot use them up.
 */
export function peekNonce(db: DatabaseSync, type: BoxQrType, nonce: unknown, now: Date): NonceStatus {
  if (typeof nonce !== 'string' || !NONCE_SHAPE.test(nonce)) return 'bad';
  const row = db.prepare('SELECT used_at, expires_at FROM box_codes WHERE nonce_hash = ? AND type = ?').get(sha256hex(nonce), type);
  if (row === undefined || row.used_at !== null) return 'bad';
  return String(row.expires_at) > now.toISOString() ? 'live' : 'expired';
}

/** A thumbprint of a canonical public key (crv, kty, x, y): what a spent nonce remembers of the device. */
export function keyThumb(jwk: { crv?: string; kty?: string; x?: string; y?: string }): string {
  return sha256hex(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
}

/** On success, the device a spent nonce created (ids and key thumbprint, nothing secret). */
export function recordNonceDevice(db: DatabaseSync, nonce: string, deviceId: string, userId: string, thumb: string): void {
  db.prepare('UPDATE box_codes SET device_id = ?, user_id = ?, key_thumb = ? WHERE nonce_hash = ?').run(
    deviceId,
    userId,
    thumb,
    sha256hex(nonce),
  );
}

export interface ResumeRow {
  deviceId: string;
  userId: string;
  keyThumb: string;
}

/**
 * The device a nonce created, while a lost reply can still be resumed: the nonce was spent successfully
 * (`outcome` ok, a device recorded) no more than NONCE_TTL_MS ago. Read-only; the caller checks key, PIN and device.
 */
export function resumableNonce(db: DatabaseSync, type: BoxQrType, nonce: unknown, now: Date): ResumeRow | null {
  if (typeof nonce !== 'string' || !NONCE_SHAPE.test(nonce)) return null;
  const row = db
    .prepare(`SELECT used_at, outcome, device_id, user_id, key_thumb FROM box_codes WHERE nonce_hash = ? AND type = ?`)
    .get(sha256hex(nonce), type);
  if (row === undefined || row.used_at === null || row.outcome !== 'ok') return null;
  if (typeof row.device_id !== 'string' || typeof row.user_id !== 'string' || typeof row.key_thumb !== 'string') return null;
  if (new Date(String(row.used_at)).getTime() + NONCE_TTL_MS <= now.getTime()) return null;
  return { deviceId: row.device_id, userId: row.user_id, keyThumb: row.key_thumb };
}

/** True when this nonce was spent by a setup or recovery that created a device (even if it can no longer be resumed). */
export function nonceMadeDevice(db: DatabaseSync, type: BoxQrType, nonce: unknown): boolean {
  if (typeof nonce !== 'string' || !NONCE_SHAPE.test(nonce)) return false;
  const row = db.prepare('SELECT device_id FROM box_codes WHERE nonce_hash = ? AND type = ?').get(sha256hex(nonce), type);
  return row !== undefined && row.device_id !== null;
}

/** Re-label the outcome of a nonce that was just consumed (`bad_code`, `state`). */
export function setNonceOutcome(db: DatabaseSync, nonce: string, outcome: 'ok' | 'bad_code' | 'expired' | 'state'): void {
  db.prepare('UPDATE box_codes SET outcome = ? WHERE nonce_hash = ?').run(outcome, sha256hex(nonce));
}

/** Uppercase, spaces and dashes removed. */
export function normaliseRecoveryCode(raw: string): string {
  return typeof raw === 'string' ? raw.replace(/[\s-]+/g, '').toUpperCase() : '';
}

function validShape(code: string): boolean {
  return code.length === RECOVERY_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
}

/** A new recovery code. Only its sha256 is stored in `meta`; the old code dies. Returned as `XXXX-XXXX-XXXX-XXXX`. */
export function issueRecoveryCode(db: DatabaseSync): string {
  let code = '';
  for (const b of randomBytes(RECOVERY_LENGTH)) code += CODE_ALPHABET[b % 32]!;
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(RECOVERY_HASH_KEY, sha256hex(code));
  return code.match(/.{4}/g)!.join('-');
}

/** Whether a recovery code was ever issued (an upgraded box may have none). Reveals nothing about the code. */
export function recoveryCodeExists(db: DatabaseSync): boolean {
  return db.prepare('SELECT 1 AS ok FROM meta WHERE key = ?').get(RECOVERY_HASH_KEY) !== undefined;
}

/** Constant-time compare of hashes. False when no code was ever issued. */
export function verifyRecoveryCode(db: DatabaseSync, raw: string): boolean {
  const code = normaliseRecoveryCode(raw);
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(RECOVERY_HASH_KEY);
  const stored = typeof row?.value === 'string' ? row.value : '0'.repeat(64);
  const shaped = validShape(code);
  const a = Buffer.from(sha256hex(shaped ? code : '-'));
  const b = Buffer.from(stored);
  const same = a.length === b.length && timingSafeEqual(a, b);
  return same && row !== undefined && shaped;
}

/** Drop rows expired more than 24 h ago (used rows stay that long for the record). */
export function sweepBoxCodes(db: DatabaseSync, now: Date): void {
  db.prepare('DELETE FROM box_codes WHERE expires_at <= ?').run(new Date(now.getTime() - 24 * 3_600_000).toISOString());
}
