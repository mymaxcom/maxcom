import { randomInt } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyRequest } from 'fastify';
import { randomToken, sha256hex } from './crypto.ts';
import type { KioskAuth } from './authz.ts';
import { AuthError, MSG, logChange, revokeDeviceRow, tx } from './users.ts';

/** Name of the pairing cookie. */
export const KIOSK_COOKIE = 'surau_kiosk';
/** The on-screen code lives 10 minutes; the cookie lives 10 years (until revoked). */
export const PAIR_TTL_MS = 10 * 60_000;
export const COOKIE_TTL_MS = 3650 * 24 * 3600_000;
/** Cap on codes waiting for approval, so a flood of begin calls cannot crowd out the 6-digit space. */
const MAX_OPEN_PAIRINGS = 20;
/** ... and from one address, so a single host cannot use up the global cap. */
const MAX_OPEN_PAIRINGS_PER_IP = 3;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const LAST_SEEN_EVERY_MS = 5 * 60_000;

export const MSG_BAD_PAIR_CODE = 'Kod pasangan tidak sah atau telah tamat';
const MSG_PAIR_GONE = 'Pasangan tamat. Mulakan semula';

/** Six random digits (uniform: randomInt rejects modulo bias). */
export function newPairCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function normalisePairCode(code: unknown): string {
  return typeof code === 'string' ? code.replace(/[\s-]/g, '') : '';
}

export function beginPairing(
  db: DatabaseSync,
  ip: string,
  now: Date,
): { code: string; pollToken: string; expiresAt: string } {
  const nowIso = now.toISOString();
  return tx(db, () => {
    // Tidy: drop pairings that expired a day ago (used ones stay that long for the record).
    // A device approved for a pairing nobody claimed is revoked first, so it cannot linger.
    revokeOrphanKioskDevices(db, nowIso);
    db.prepare('DELETE FROM kiosk_pairings WHERE expires_at < ?').run(
      new Date(now.getTime() - 24 * 3600_000).toISOString(),
    );
    const open = db
      .prepare('SELECT COUNT(*) AS n FROM kiosk_pairings WHERE approved_by IS NULL AND claimed_at IS NULL AND expires_at > ?')
      .get(nowIso);
    if (Number(open?.n ?? 0) >= MAX_OPEN_PAIRINGS) throw new AuthError(429, 'too_many_pairings', MSG.tooMany);
    const openHere = db
      .prepare('SELECT COUNT(*) AS n FROM kiosk_pairings WHERE ip = ? AND approved_by IS NULL AND claimed_at IS NULL AND expires_at > ?')
      .get(ip, nowIso);
    if (Number(openHere?.n ?? 0) >= MAX_OPEN_PAIRINGS_PER_IP) throw new AuthError(429, 'too_many_pairings', MSG.tooMany);
    const expiresAt = new Date(now.getTime() + PAIR_TTL_MS).toISOString();
    const pollToken = randomToken(32);
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = newPairCode();
      const codeHash = sha256hex(code);
      // A live code must be unambiguous: skip one that is still in use.
      const clash = db
        .prepare('SELECT 1 AS x FROM kiosk_pairings WHERE code_hash = ? AND expires_at > ? AND claimed_at IS NULL')
        .get(codeHash, nowIso);
      if (clash !== undefined) continue;
      db.prepare('DELETE FROM kiosk_pairings WHERE code_hash = ?').run(codeHash); // stale row with the same code
      db.prepare(
        'INSERT INTO kiosk_pairings (code_hash, poll_token_hash, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      ).run(codeHash, sha256hex(pollToken), ip, nowIso, expiresAt);
      return { code, pollToken, expiresAt };
    }
    throw new AuthError(429, 'too_many_pairings', MSG.tooMany);
  });
}

/**
 * An admin approves the code shown on the kiosk. Creates the kiosk's device record (platform
 * `kiosk`, owned by the approver) so the existing device list and revoke work on it.
 */
export function approvePairing(
  db: DatabaseSync,
  input: { code: unknown; deviceName?: unknown },
  approverId: string,
  actor: string,
  now: Date,
): { deviceId: string; name: string; requesterIp: string | null; codeAgeSeconds: number } {
  const code = normalisePairCode(input.code);
  if (!/^[0-9]{6}$/.test(code)) throw new AuthError(404, 'bad_pair_code', MSG_BAD_PAIR_CODE);
  const rawName = typeof input.deviceName === 'string' ? input.deviceName.trim().slice(0, 80) : '';
  const name = rawName.length > 0 ? rawName : 'Paparan surau';
  const nowIso = now.toISOString();
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM kiosk_pairings WHERE code_hash = ?').get(sha256hex(code));
    if (row === undefined || row.approved_by !== null || row.claimed_at !== null || String(row.expires_at) <= nowIso) {
      throw new AuthError(404, 'bad_pair_code', MSG_BAD_PAIR_CODE);
    }
    const deviceId = randomToken(12);
    db.prepare(
      `INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at) VALUES (?, ?, ?, 'kiosk', NULL, ?)`,
    ).run(deviceId, approverId, name, nowIso);
    const upd = db
      .prepare('UPDATE kiosk_pairings SET approved_by = ?, device_id = ? WHERE code_hash = ? AND approved_by IS NULL')
      .run(approverId, deviceId, String(row.code_hash));
    if (Number(upd.changes) !== 1) throw new AuthError(404, 'bad_pair_code', MSG_BAD_PAIR_CODE);
    logChange(db, actor, 'devices', deviceId, undefined, {
      id: deviceId,
      userId: approverId,
      name,
      platform: 'kiosk',
      revoked: false,
    });
    return {
      deviceId,
      name,
      requesterIp: typeof row.ip === 'string' ? row.ip : null,
      codeAgeSeconds: Math.max(0, Math.round((now.getTime() - Date.parse(String(row.created_at))) / 1000)),
    };
  });
}

export interface PendingPairing {
  /** Address that asked for the code (what the box saw); null if unknown. */
  requesterIp: string | null;
  createdAt: string;
  expiresAt: string;
  codeAgeSeconds: number;
}

/**
 * Codes waiting for approval, newest first, WITHOUT the code itself (only its hash is stored).
 * Lets the approving admin see where a request came from and how old it is before typing a code.
 */
export function listPendingPairings(db: DatabaseSync, now: Date): PendingPairing[] {
  const nowIso = now.toISOString();
  return db
    .prepare(
      'SELECT ip, created_at, expires_at FROM kiosk_pairings WHERE approved_by IS NULL AND claimed_at IS NULL AND expires_at > ? ORDER BY created_at DESC',
    )
    .all(nowIso)
    .map((r) => ({
      requesterIp: typeof r.ip === 'string' ? r.ip : null,
      createdAt: String(r.created_at),
      expiresAt: String(r.expires_at),
      codeAgeSeconds: Math.max(0, Math.round((now.getTime() - Date.parse(String(r.created_at))) / 1000)),
    }));
}

/**
 * Revoke kiosk devices that were approved for a pairing which expired before the kiosk claimed
 * it (no cookie was ever issued). Caller owns the transaction.
 */
export function revokeOrphanKioskDevices(db: DatabaseSync, nowIso: string): void {
  const rows = db
    .prepare(
      `SELECT p.device_id AS device_id FROM kiosk_pairings p
        WHERE p.approved_by IS NOT NULL AND p.claimed_at IS NULL AND p.expires_at <= ? AND p.device_id IS NOT NULL`,
    )
    .all(nowIso);
  for (const r of rows) revokeDeviceRow(db, String(r.device_id), 'system', nowIso);
}

export type PollResult =
  | { status: 'pending'; expiresAt: string }
  | { status: 'approved'; cookieToken: string; deviceId: string };

/**
 * The kiosk asks whether its code was approved. On approval the cookie token is minted ONCE (the
 * pairing is marked claimed in the same transaction); only its hash is stored.
 */
export function pollPairing(db: DatabaseSync, pollToken: unknown, now: Date): PollResult {
  if (typeof pollToken !== 'string' || !TOKEN_RE.test(pollToken)) {
    throw new AuthError(404, 'pair_gone', MSG_PAIR_GONE);
  }
  const nowIso = now.toISOString();
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM kiosk_pairings WHERE poll_token_hash = ?').get(sha256hex(pollToken));
    if (row === undefined || row.claimed_at !== null || String(row.expires_at) <= nowIso) {
      throw new AuthError(404, 'pair_gone', MSG_PAIR_GONE);
    }
    if (row.approved_by === null || typeof row.device_id !== 'string') {
      return { status: 'pending', expiresAt: String(row.expires_at) };
    }
    const dev = db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(row.device_id);
    if (dev === undefined || dev.revoked_at !== null) throw new AuthError(404, 'pair_gone', MSG_PAIR_GONE);
    const claimed = db
      .prepare('UPDATE kiosk_pairings SET claimed_at = ? WHERE poll_token_hash = ? AND claimed_at IS NULL')
      .run(nowIso, String(row.poll_token_hash));
    if (Number(claimed.changes) !== 1) throw new AuthError(404, 'pair_gone', MSG_PAIR_GONE);
    const cookieToken = randomToken(32);
    db.prepare('INSERT INTO kiosk_cookies (token_hash, device_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      sha256hex(cookieToken),
      row.device_id,
      nowIso,
      new Date(now.getTime() + COOKIE_TTL_MS).toISOString(),
    );
    return { status: 'approved', cookieToken, deviceId: row.device_id };
  });
}

/** `Set-Cookie` value: HttpOnly, SameSite=Strict, 10 years, `Secure` when the request was HTTPS. */
export function buildKioskCookie(token: string, secure: boolean): string {
  return (
    `${KIOSK_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(COOKIE_TTL_MS / 1000)}; HttpOnly; SameSite=Strict` +
    (secure ? '; Secure' : '')
  );
}

export function cookieToken(header: string | undefined): string | null {
  if (typeof header !== 'string' || header.length > 4096) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== KIOSK_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return TOKEN_RE.test(value) ? value : null;
  }
  return null;
}

/**
 * `AppOptions.resolveKiosk`: a valid, unexpired cookie whose device is not revoked is the kiosk
 * (`kiosk:read` only). Revoking the device (or deactivating its owner) ends access on the next
 * request, because every request re-checks the device row.
 */
export function createKioskResolver(
  db: DatabaseSync,
  now: () => Date,
): (request: FastifyRequest) => KioskAuth | null {
  return (request) => {
    const token = cookieToken(request.headers.cookie);
    if (token === null) return null;
    const at = now();
    const row = db
      .prepare(
        `SELECT c.device_id AS device_id, d.last_seen_at AS last_seen_at
           FROM kiosk_cookies c JOIN devices d ON d.id = c.device_id
          WHERE c.token_hash = ? AND c.expires_at > ? AND d.revoked_at IS NULL AND d.platform = 'kiosk'`,
      )
      .get(sha256hex(token), at.toISOString());
    if (row === undefined) return null;
    const deviceId = String(row.device_id);
    const seen = typeof row.last_seen_at === 'string' ? Date.parse(row.last_seen_at) : 0;
    if (!(at.getTime() - seen < LAST_SEEN_EVERY_MS)) {
      db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(at.toISOString(), deviceId);
    }
    return { kind: 'kiosk', deviceId, via: 'cookie' };
  };
}
