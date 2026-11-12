import { generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSecret, sealSecret } from '../auth/crypto.ts';
import type { JsonWebKey } from '../auth/crypto.ts';
import { loadBoxKey, secretDir } from '../auth/secrets.ts';

/**
 * The box's link to the cloud, kept sealed under `<dataDir>/secret/sync.key`.
 *
 * It holds the site key (the bearer the box sends to the cloud, whose sha256 alone the cloud stores), the
 * wake secret (HMAC key for `/wake` and `/dirty`, the Worker holds the same value) and the box's own sync
 * key pair (kept so a later version can sign batches without a new link). The file is sealed with a key
 * derived from `box.key` in its own HKDF domain; none of these values is ever logged or sent anywhere else.
 */
export interface SyncKeyData {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
  cloudUrl: string;
  siteToken: string;
  wakeSecret: string;
  /** The Worker's base URL when it differs from the cloud address (default: the same). */
  workerUrl?: string;
  siteName?: string;
  linkedAt: string;
}

export const SYNC_KEY_FILE = 'sync.key';

const syncKeyPath = (dataDir: string): string => join(secretDir(dataDir), SYNC_KEY_FILE);

/** Key for the sync key file: HKDF of the box master key, a separate domain from every other use of it. */
export function syncKeyEncryptionKey(boxKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', boxKey, Buffer.alloc(0), 'sync-key', 32));
}

/** A fresh P-256 key pair as JWKs. */
export function generateSyncKeyPair(): { privateJwk: JsonWebKey; publicJwk: JsonWebKey } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  return { privateJwk: priv as JsonWebKey, publicJwk: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y } as JsonWebKey };
}

/** An acceptable cloud or Worker base address: https, a host, no credentials, no query. Returned without a trailing slash. */
export function normaliseCloudUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname === '' || u.username !== '' || u.password !== '') return null;
  if (u.search !== '' || u.hash !== '') return null;
  return u.origin + u.pathname.replace(/\/+$/, '');
}

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function parse(text: string): SyncKeyData {
  const j = JSON.parse(text) as Record<string, unknown>;
  const cloudUrl = typeof j.cloudUrl === 'string' ? normaliseCloudUrl(j.cloudUrl) : null;
  if (
    cloudUrl === null ||
    !isText(j.siteToken, 200) ||
    !isText(j.wakeSecret, 200) ||
    !isText(j.linkedAt, 40) ||
    typeof j.privateJwk !== 'object' ||
    j.privateJwk === null ||
    typeof j.publicJwk !== 'object' ||
    j.publicJwk === null
  ) {
    throw new Error('sync key: bad content');
  }
  const workerUrl = typeof j.workerUrl === 'string' ? normaliseCloudUrl(j.workerUrl) : null;
  return {
    privateJwk: j.privateJwk as JsonWebKey,
    publicJwk: j.publicJwk as JsonWebKey,
    cloudUrl,
    siteToken: j.siteToken,
    wakeSecret: j.wakeSecret,
    ...(workerUrl !== null ? { workerUrl } : {}),
    ...(typeof j.siteName === 'string' ? { siteName: j.siteName.slice(0, 120) } : {}),
    linkedAt: j.linkedAt,
  };
}

/** Seal and store the link (atomic replace, mode 0600). */
export function saveSyncKey(dataDir: string, data: SyncKeyData): void {
  const boxKey = loadBoxKey(dataDir);
  mkdirSync(secretDir(dataDir), { recursive: true, mode: 0o700 });
  const path = syncKeyPath(dataDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, sealSecret(syncKeyEncryptionKey(boxKey), JSON.stringify(data)), { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* unsupported filesystem; on Windows the ACL is set by scripts/box-ca.ps1 */
  }
  renameSync(tmp, path);
}

/** The stored link, or null when the box was never linked. A damaged or foreign file throws (never with its content). */
export function loadSyncKey(dataDir: string): SyncKeyData | null {
  const path = syncKeyPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const sealed = readFileSync(path, 'utf8').trim();
    return parse(openSecret(syncKeyEncryptionKey(loadBoxKey(dataDir)), sealed));
  } catch {
    throw new Error('sync key: cannot open');
  }
}

// ---- the claim secret of an unlinked box (automatic link, `register.ts`) --------------------------------------

/**
 * `<dataDir>/secret/sync.claim`: 32 random bytes (64 hex) sealed like the link file (own HKDF domain), with the
 * cloud origin it was made for. Only its sha256 ever leaves the box at `/register`; the secret itself goes only
 * to that same origin's `/api/sync/claim`. A different origin gets a fresh secret, so a secret registered with
 * one cloud is never shown to another. Deleted once the box is linked.
 */
export const CLAIM_FILE = 'sync.claim';
const claimPath = (dataDir: string): string => join(secretDir(dataDir), CLAIM_FILE);
const CLAIM_RE = /^[0-9a-f]{64}$/;

function claimEncryptionKey(boxKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', boxKey, Buffer.alloc(0), 'sync-claim', 32));
}

function readClaim(dataDir: string): { claim: string; origin: string } | null {
  const path = claimPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(openSecret(claimEncryptionKey(loadBoxKey(dataDir)), readFileSync(path, 'utf8').trim())) as Record<string, unknown>;
    if (typeof j.claim !== 'string' || !CLAIM_RE.test(j.claim) || typeof j.origin !== 'string') return null;
    return { claim: j.claim, origin: j.origin };
  } catch {
    return null;
  }
}

/** The claim secret for `origin`, made (and sealed, mode 0600) on first need; kept across restarts. */
export function loadOrCreateClaim(dataDir: string, origin: string): string {
  const have = readClaim(dataDir);
  if (have !== null && have.origin === origin) return have.claim;
  const claim = randomBytes(32).toString('hex');
  const boxKey = loadBoxKey(dataDir);
  mkdirSync(secretDir(dataDir), { recursive: true, mode: 0o700 });
  const path = claimPath(dataDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, sealSecret(claimEncryptionKey(boxKey), JSON.stringify({ claim, origin })), { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* unsupported filesystem; on Windows the ACL is set by scripts/box-ca.ps1 */
  }
  renameSync(tmp, path);
  return claim;
}

/** Forget the claim secret (after linking). */
export function removeClaim(dataDir: string): void {
  rmSync(claimPath(dataDir), { force: true });
}

/** Remove the link file. True when there was one. */
export function removeSyncKey(dataDir: string): boolean {
  const path = syncKeyPath(dataDir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
