import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { defaultBoxName, validateFeatureSettings } from '@surau/core';
import { canonicalJwk, enrolDeviceDirect, PLATFORMS } from '../auth/devices.ts';
import type { EnrolOutcome } from '../auth/devices.ts';
import { appLockRequiredFor } from '../auth/appLock.ts';
import { hashPin, isValidPin, pinPepperOf, verifyPin } from '../auth/crypto.ts';
import type { JsonWebKey } from '../auth/crypto.ts';
import { authLog } from '../auth/sessions.ts';
import { AuthError, checkName, createUserIn, getUserRow, tx } from '../auth/users.ts';
import type { User } from '../auth/users.ts';
import { bumpVersion, getSettings, putFeatureIn } from '../settingsStore.ts';
import {
  consumeNonce,
  issueRecoveryCode,
  keyThumb,
  nonceMadeDevice,
  peekNonce,
  recordNonceDevice,
  resumableNonce,
  setNonceOutcome,
  verifyRecoveryCode,
} from './codes.ts';
import type { NonceStatus } from './codes.ts';
import { boxName as boxNameOf, boxState, checkBoxName, setBoxNameIn, writeBoxJson } from './state.ts';

export interface JoinInput {
  nonce: string;
  adminName: string;
  deviceName: string;
  publicJwk: unknown;
  platform: string;
  pin: string;
}
export interface SetupInput extends JoinInput {
  surauName: string;
  boxName: string;
}
export interface RecoveryInput extends JoinInput {
  recoveryCode: string;
}

export type SetupOutcome = EnrolOutcome & { recoveryCode: string; surauId: string; boxName: string; surauName: string };
export type RecoveryOutcome = EnrolOutcome & { recoveryCode: string };

const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const SURAU_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** 12 lower-case base32 characters from a CSPRNG (unbiased: 256 is a multiple of 32). */
function newSurauId(): string {
  let id = '';
  for (const b of randomBytes(12)) id += SURAU_ID_ALPHABET[b & 31];
  return id;
}

const bad = (code: string, message: string, status: 400 | 401 | 409 = 400): AuthError => new AuthError(status, code, message);
const BAD_CODE = (): AuthError => bad('bad_code', 'Kod tidak sah atau telah tamat', 401);

const NOT_IN_RECOVERY = (): AuthError => bad('not_in_recovery', 'MAXCOM ini sudah ada Pentadbir aktif', 409);
const BOX_LOCKED = (): AuthError => bad('box_locked', 'MAXCOM ini telah digantung. Sila hubungi pemasang MAXCOM.', 409);

/** True only while the box has users and no active Pentadbir device. */
export function inRecovery(db: DatabaseSync): boolean {
  const st = boxState(db);
  return st.state === 'recovery' && st.reason === 'no_admin';
}

/** The true reason recovery is refused: a suspended box is locked, any other box simply has a Pentadbir. */
function notInRecovery(db: DatabaseSync): { refuse: AuthError; detail: string } {
  return boxState(db).state === 'locked'
    ? { refuse: BOX_LOCKED(), detail: 'box_locked' }
    : { refuse: NOT_IN_RECOVERY(), detail: 'not_in_recovery' };
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Cheap shape checks shared by setup and recovery; nothing here touches the database. */
function checkJoin(input: JoinInput): { adminName: string; deviceName: string; jwk: JsonWebKey; platform: string } {
  if (typeof input !== 'object' || input === null) throw bad('bad_body', 'Permintaan tidak sah');
  const adminName = checkName(input.adminName);
  const deviceName = text(input.deviceName).trim();
  if (deviceName.length < 1 || deviceName.length > 80) throw bad('bad_device_name', 'Nama peranti mesti 1 hingga 80 aksara');
  const jwk = canonicalJwk(input.publicJwk);
  if (!PLATFORMS.includes(input.platform) || input.platform === 'kiosk') throw bad('bad_platform', 'Platform tidak sah');
  if (!isValidPin(input.pin)) throw bad('pin_policy', 'PIN mesti 6 digit dan tidak mudah diteka');
  return { adminName, deviceName, jwk, platform: input.platform };
}

type Refusal = { refuse: AuthError; detail: string };

/**
 * A lost reply must not strand the box: the same nonce, the same public key and the right PIN, within the nonce's
 * ten minutes of its first use and while that device is still active, gets the same device back and a freshly
 * issued recovery code (the earlier one was never seen; issuing replaces it). Anything else returns null and the
 * normal path decides. Checked BEFORE the state check: the box is by then already set up or recovered.
 */
async function tryResume(
  db: DatabaseSync,
  type: 'setup' | 'recovery',
  nonce: string,
  jwk: JsonWebKey,
  pin: string,
  ip: string,
  now: Date,
): Promise<(EnrolOutcome & { recoveryCode: string }) | null> {
  const row = resumableNonce(db, type, nonce, now);
  if (row === null || row.keyThumb !== keyThumb(jwk)) return null;
  const live = (): { roles: EnrolOutcome['roles'] } | null => {
    const d = db.prepare('SELECT user_id FROM devices WHERE id = ? AND revoked_at IS NULL').get(row.deviceId);
    const u = getUserRow(db, row.userId);
    return d !== undefined && String(d.user_id) === row.userId && u !== undefined && u.active ? { roles: u.roles } : null;
  };
  if (live() === null) return null;
  const stored = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(row.userId)?.pin_hash;
  if (typeof stored !== 'string' || !(await verifyPin(pin, stored, pinPepperOf(db)))) return null;
  const out = tx(db, (): (EnrolOutcome & { recoveryCode: string }) | null => {
    const l = live();
    if (l === null || resumableNonce(db, type, nonce, now) === null) return null;
    const recoveryCode = issueRecoveryCode(db);
    bumpVersion(db);
    return {
      deviceId: row.deviceId,
      userId: row.userId,
      roles: l.roles,
      pinRequired: false,
      appLock: appLockRequiredFor(db, l.roles),
      recoveryCode,
    };
  });
  if (out !== null) authLog(db, now, `${type}_resume`, true, { userId: out.userId, deviceId: out.deviceId, ip, detail: 'ok' });
  return out;
}

/** Log a dead nonce (unknown, spent, malformed or expired) and answer 401 `bad_code`. Spends and charges nothing. */
export function refuseDeadNonce(db: DatabaseSync, event: 'setup' | 'recovery', status: NonceStatus, ip: string, now: Date): never {
  authLog(db, now, event, false, { ip, detail: status === 'expired' ? 'expired' : 'bad_code' });
  throw BAD_CODE();
}

/**
 * First setup: the first phone to scan the setup QR names the surau and becomes its first Pentadbir. One
 * transaction: the nonce is spent, the box must still have no users, the user, device, surau name, box name,
 * surau id and recovery code are written together. Two phones racing get one winner.
 */
export async function setupComplete(
  db: DatabaseSync,
  dataDir: string,
  boxId: string,
  input: SetupInput,
  ip: string,
  now: Date,
): Promise<SetupOutcome> {
  const j = checkJoin(input);
  const surau = text(input.surauName).trim();
  const sv = validateFeatureSettings('surauInfo', { name: surau });
  if (surau === '' || !sv.ok) throw bad('bad_surau_name', 'Nama surau tidak sah');
  const name = checkBoxName(input.boxName);
  const nonce = text(input.nonce);
  const resumed = await tryResume(db, 'setup', nonce, j.jwk, input.pin, ip, now);
  if (resumed !== null) {
    const sid = db.prepare("SELECT value FROM meta WHERE key = 'surau_id'").get()?.value;
    return { ...resumed, surauId: typeof sid === 'string' ? sid : '', boxName: boxNameOf(db, boxId), surauName: getSettings(db).surauInfo.name };
  }
  // a dead nonce is refused before the slow PIN hash
  const live = peekNonce(db, 'setup', nonce, now);
  if (live !== 'live') refuseDeadNonce(db, 'setup', live, ip, now);
  // the PIN is hashed outside the transaction (slow), after the cheap checks
  const pinHash = await hashPin(input.pin, pinPepperOf(db));

  const result = tx(db, (): SetupOutcome | Refusal => {
    const spent = NONCE_RE.test(nonce) ? consumeNonce(db, 'setup', nonce, ip, now) : 'bad';
    if (spent !== 'ok') {
      // The loser of a race for one setup nonce: the winner has just set the box up, so say so (a resume was
      // already looked for above, before the nonce was spent).
      if (spent === 'bad' && boxState(db).state !== 'setup') {
        return { refuse: bad('already_set_up', 'MAXCOM ini sudah disediakan', 409), detail: 'already_set_up' };
      }
      return { refuse: BAD_CODE(), detail: spent === 'expired' ? 'expired' : 'bad_code' };
    }
    if (boxState(db).state !== 'setup') {
      return { refuse: bad('already_set_up', 'MAXCOM ini sudah disediakan', 409), detail: 'already_set_up' };
    }
    const user = createUserIn(db, { name: j.adminName, roles: ['admin'] }, 'system:setup');
    const device = enrolDeviceDirect(db, {
      userId: user.id,
      publicJwk: j.jwk,
      platform: j.platform,
      deviceName: j.deviceName,
      pinHash,
      ip,
    });
    putFeatureIn(db, 'surauInfo', { name: surau }, 'system:setup');
    setBoxNameIn(db, boxId, name, 'system:setup');
    const surauId = newSurauId();
    db.prepare("INSERT INTO meta (key, value) VALUES ('surau_id', ?) ON CONFLICT(key) DO NOTHING").run(surauId);
    const recoveryCode = issueRecoveryCode(db);
    recordNonceDevice(db, nonce, device.deviceId, device.userId, keyThumb(j.jwk));
    bumpVersion(db);
    return { ...device, recoveryCode, surauId, boxName: name, surauName: surau };
  });

  if ('refuse' in result) {
    authLog(db, now, 'setup', false, { ip, detail: result.detail });
    throw result.refuse;
  }
  writeBoxJson(dataDir, { boxName: result.boxName, surauName: result.surauName });
  authLog(db, now, 'setup', true, { userId: result.userId, deviceId: result.deviceId, ip, detail: 'ok' });
  return result;
}

/**
 * Recovery by the recovery code, only while no active Pentadbir device exists. The nonce is spent right or wrong;
 * a wrong code never works again with the same QR. A recovery creates a NEW Pentadbir (it never gives an existing
 * user's identity to a new phone) and replaces the recovery code, so a second loss is survivable.
 */
export async function recoveryComplete(
  db: DatabaseSync,
  _dataDir: string,
  _boxId: string,
  input: RecoveryInput,
  ip: string,
  now: Date,
): Promise<RecoveryOutcome> {
  const j = checkJoin(input);
  const nonce = text(input.nonce);
  const code = text(input.recoveryCode);
  const resumed = await tryResume(db, 'recovery', nonce, j.jwk, input.pin, ip, now);
  if (resumed !== null) return resumed;
  // state first: an active box answers 409 without spending a nonce or hashing a PIN
  if (!inRecovery(db)) {
    // a nonce that already made a device and cannot be resumed is dead, not a question about the state
    if (nonceMadeDevice(db, 'recovery', nonce)) refuseDeadNonce(db, 'recovery', 'bad', ip, now);
    const r = notInRecovery(db);
    authLog(db, now, 'recovery', false, { ip, detail: r.detail });
    throw r.refuse;
  }
  const live = peekNonce(db, 'recovery', nonce, now);
  if (live !== 'live') refuseDeadNonce(db, 'recovery', live, ip, now);
  const pinHash = await hashPin(input.pin, pinPepperOf(db));

  const result = tx(db, (): RecoveryOutcome | Refusal => {
    if (!inRecovery(db)) return notInRecovery(db);
    const spent = NONCE_RE.test(nonce) ? consumeNonce(db, 'recovery', nonce, ip, now) : 'bad';
    if (spent !== 'ok') return { refuse: BAD_CODE(), detail: spent === 'expired' ? 'expired' : 'bad_code' };
    if (!verifyRecoveryCode(db, code)) {
      setNonceOutcome(db, nonce, 'bad_code');
      return { refuse: bad('bad_code', 'Kod pemulihan salah', 401), detail: 'bad_code' };
    }
    const user = createUserIn(db, { name: j.adminName, roles: ['admin'] }, 'system:recovery');
    const device = enrolDeviceDirect(db, {
      userId: user.id,
      publicJwk: j.jwk,
      platform: j.platform,
      deviceName: j.deviceName,
      pinHash,
      ip,
    });
    const recoveryCode = issueRecoveryCode(db);
    recordNonceDevice(db, nonce, device.deviceId, device.userId, keyThumb(j.jwk));
    bumpVersion(db);
    return { ...device, recoveryCode };
  });

  if ('refuse' in result) {
    authLog(db, now, 'recovery', false, { ip, detail: result.detail });
    throw result.refuse;
  }
  authLog(db, now, 'recovery', true, { userId: result.userId, deviceId: result.deviceId, ip, detail: 'ok' });
  return result;
}

/** A phone proved it can reach the box: spends a probe nonce and leaves an `auth_log` row the network check reads. */
export function recordProbe(db: DatabaseSync, nonce: string, ip: string, now: Date): boolean {
  if (!NONCE_RE.test(text(nonce))) return false;
  const ok = tx(db, () => consumeNonce(db, 'probe', nonce, ip, now) === 'ok');
  if (ok) authLog(db, now, 'net_probe', true, { ip, detail: 'ok' });
  return ok;
}

/**
 * The development bootstrap (`cli/bootstrap.ts`) on the same core as the setup QR: the first admin user, the surau
 * and box names, the surau id and the recovery code in one transaction, only while the box has no users. The CLI
 * issues the enrolment code itself afterwards (there is no phone to hand a device key over yet).
 */
export function setupFromCli(
  db: DatabaseSync,
  dataDir: string,
  boxId: string,
  input: { adminName: string; surauName?: string; boxName?: string },
): { user: User; recoveryCode: string; surauId: string } {
  const surau = input.surauName === undefined ? undefined : input.surauName.trim();
  if (surau !== undefined) {
    const sv = validateFeatureSettings('surauInfo', { name: surau });
    if (surau === '' || !sv.ok) throw bad('bad_surau_name', 'Nama surau tidak sah');
  }
  const name = input.boxName === undefined ? undefined : checkBoxName(input.boxName);
  const out = tx(db, () => {
    if (Number(db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n ?? 0) !== 0) {
      throw bad('already_set_up', 'MAXCOM ini sudah disediakan', 409);
    }
    const user = createUserIn(db, { name: input.adminName, roles: ['admin'] }, 'local');
    if (surau !== undefined) putFeatureIn(db, 'surauInfo', { name: surau }, 'local');
    if (name !== undefined) setBoxNameIn(db, boxId, name, 'local');
    const surauId = newSurauId();
    db.prepare("INSERT INTO meta (key, value) VALUES ('surau_id', ?) ON CONFLICT(key) DO NOTHING").run(surauId);
    const recoveryCode = issueRecoveryCode(db);
    bumpVersion(db);
    return { user, recoveryCode, surauId };
  });
  writeBoxJson(dataDir, {
    boxName: name ?? defaultBoxName(boxId),
    surauName: surau ?? null,
  });
  return out;
}
