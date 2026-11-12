import type { webcrypto } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
  verify,
} from 'node:crypto';

// Fixed scrypt cost. The stored string records it, but verification only accepts exactly
// these values so a tampered row cannot ask the box for an unbounded amount of memory/CPU.
export type JsonWebKey = webcrypto.JsonWebKey;

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_PARAMS = `N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}`;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2; // 64 MiB, 2x the 32 MiB the cost needs

/**
 * PIN pepper. The scrypt input is HMAC-SHA256(pepper, pin), where the pepper is derived from the
 * box master key (`box.key`, which is not stored in the database). A copy of the database alone
 * therefore cannot be used to guess the 6-digit PINs offline. The pepper belongs to a database
 * handle: `buildApp` attaches the one derived from box.key; a handle with none (unit tests) gets
 * a random per-handle pepper on first use.
 */
const peppers = new WeakMap<DatabaseSync, Buffer>();

/** Pepper from the 32-byte box master key. Separate domain from every other use of the key. */
export function derivePinPepper(boxKey: Buffer): Buffer {
  if (!Buffer.isBuffer(boxKey) || boxKey.length !== 32) throw new Error('auth: bad key');
  return createHmac('sha256', boxKey).update('surau-pin-pepper-v1').digest();
}

export function attachPinPepper(db: DatabaseSync, pepper: Buffer): void {
  peppers.set(db, pepper);
}

export function pinPepperOf(db: DatabaseSync): Buffer {
  let p = peppers.get(db);
  if (p === undefined) {
    p = randomBytes(32);
    peppers.set(db, p);
  }
  return p;
}

/** Stored-hash prefix. The old unpeppered `scrypt$` format is never accepted. */
const HASH_TAG = 'scrypt2';

function pepperedInput(pin: string, pepper: Buffer): Buffer {
  return createHmac('sha256', pepper).update(pin.normalize('NFKC')).digest();
}

function deriveKey(pin: string, pepper: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      pepperedInput(pin, pepper),
      salt,
      KEY_BYTES,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPin(pin: string, pepper: Buffer): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(pin, pepper, salt);
  return `${HASH_TAG}$${SCRYPT_PARAMS}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Synchronous variant for in-process tools and tests only; never call it on a request path. */
export function hashPinSyncWith(pin: string, pepper: Buffer): string {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(pepperedInput(pin, pepper), salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `${HASH_TAG}$${SCRYPT_PARAMS}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPin(pin: string, stored: string, pepper: Buffer): Promise<boolean> {
  try {
    if (typeof pin !== 'string' || typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== HASH_TAG || parts[1] !== SCRYPT_PARAMS) return false;
    const salt = Buffer.from(parts[2]!, 'base64');
    const expected = Buffer.from(parts[3]!, 'base64');
    if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;
    const actual = await deriveKey(pin, pepper, salt);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 6 ASCII digits, not all the same digit, not a straight ascending or descending run. */
export function isValidPin(pin: string): boolean {
  if (typeof pin !== 'string' || !/^[0-9]{6}$/.test(pin)) return false;
  if (/^(\d)\1{5}$/.test(pin)) return false;
  const d = [...pin].map(Number);
  const steps = d.slice(1).map((v, i) => v - d[i]!);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return false;
  return true;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256hex(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

const JWK_FIELDS = new Set(['kty', 'crv', 'x', 'y']);

/**
 * Verify an ECDSA P-256 / SHA-256 signature in IEEE P1363 (r||s, 64 bytes) form, as WebCrypto
 * produces it. Only a clean public key is accepted: kty EC, crv P-256, and no other members
 * (no private `d`, no `alg`/`key_ops` smuggling). Any failure returns false.
 */
export function verifyP256(publicJwk: JsonWebKey, message: Buffer, signatureDer: Buffer): boolean {
  try {
    if (publicJwk === null || typeof publicJwk !== 'object') return false;
    if (publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256') return false;
    if (typeof publicJwk.x !== 'string' || typeof publicJwk.y !== 'string') return false;
    for (const k of Object.keys(publicJwk)) if (!JWK_FIELDS.has(k)) return false;
    if (!Buffer.isBuffer(message) || !Buffer.isBuffer(signatureDer) || signatureDer.length !== 64) return false;
    const key = createPublicKey({ key: publicJwk, format: 'jwk' });
    return verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, signatureDer);
  } catch {
    return false;
  }
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM. Format `v1.<iv>.<ct>.<tag>`, each part base64url. Fresh random IV per call. */
export function sealSecret(key: Buffer, plaintext: string): string {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('auth: bad key');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join('.');
}

/** Throws `auth: ...` (never including secret material) when the value is malformed or tampered. */
export function openSecret(key: Buffer, sealed: string): string {
  try {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('key');
    const parts = typeof sealed === 'string' ? sealed.split('.') : [];
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('format');
    const iv = Buffer.from(parts[1]!, 'base64url');
    const ct = Buffer.from(parts[2]!, 'base64url');
    const tag = Buffer.from(parts[3]!, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('format');
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('auth: cannot open sealed secret');
  }
}
