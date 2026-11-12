import { createPrivateKey, hkdfSync, sign } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { boxQrMessage, encodeBoxQr, keyFingerprint } from '@surau/core';
import type { BoxQrPayload } from '@surau/core';
import { openSecret, sealSecret } from '../auth/crypto.ts';
import type { JsonWebKey } from '../auth/crypto.ts';
import { loadBoxKey, secretDir } from '../auth/secrets.ts';
import { generateSyncKeyPair } from '../sync/syncKey.ts';

/**
 * The box's long-lived identity key (P-256), sealed under `<dataDir>/secret/identity.key`. Its public key
 * fingerprint is printed under every box QR and checked by the phone. It signs box QR payloads and nothing else:
 * it is not the sync key and not the TLS key.
 */
export interface BoxIdentity {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
  /** First 16 hex of sha256 of the canonical public key. */
  keyFp: string;
}

export const IDENTITY_KEY_FILE = 'identity.key';
const path = (dataDir: string): string => join(secretDir(dataDir), IDENTITY_KEY_FILE);

/** Own HKDF domain, apart from sync.key and every other use of box.key. */
function identityEncryptionKey(boxKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', boxKey, Buffer.alloc(0), 'box-identity', 32));
}

function restrict(p: string, mode: number): void {
  try {
    chmodSync(p, mode);
  } catch {
    /* unsupported filesystem; on Windows the ACL is set by scripts/box-ca.ps1 */
  }
}

function open(dataDir: string, boxKey: Buffer): BoxIdentity {
  try {
    const j = JSON.parse(openSecret(identityEncryptionKey(boxKey), readFileSync(path(dataDir), 'utf8').trim())) as {
      privateJwk?: JsonWebKey;
      publicJwk?: JsonWebKey;
    };
    const { privateJwk, publicJwk } = j;
    if (
      privateJwk === undefined || publicJwk === undefined ||
      publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256' ||
      typeof publicJwk.x !== 'string' || typeof publicJwk.y !== 'string' || typeof privateJwk.d !== 'string'
    ) throw new Error('shape');
    return { privateJwk, publicJwk, keyFp: keyFingerprint({ kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y }) };
  } catch {
    throw new Error('identity key: cannot open');
  }
}

/** Created on first call (exclusive create, mode 0600). A damaged or foreign file throws, never with its content. */
export function loadIdentity(dataDir: string): BoxIdentity {
  const boxKey = loadBoxKey(dataDir);
  if (!existsSync(path(dataDir))) {
    mkdirSync(secretDir(dataDir), { recursive: true, mode: 0o700 });
    const { privateJwk, publicJwk } = generateSyncKeyPair();
    try {
      const fd = openSync(path(dataDir), 'wx', 0o600);
      try {
        writeSync(
          fd,
          sealSecret(
            identityEncryptionKey(boxKey),
            JSON.stringify({ privateJwk, publicJwk, createdAt: new Date().toISOString() }),
          ),
        );
      } finally {
        closeSync(fd);
      }
      restrict(path(dataDir), 0o600);
    } catch (e) {
      // lost a creation race: read the winner's file
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('identity key: cannot create');
    }
  }
  return open(dataDir, boxKey);
}

/** A throwaway identity for a box with no data folder (in-memory test databases). Never written anywhere. */
export function ephemeralIdentity(): BoxIdentity {
  const { privateJwk, publicJwk } = generateSyncKeyPair();
  return { privateJwk, publicJwk, keyFp: keyFingerprint({ kty: 'EC', crv: 'P-256', x: publicJwk.x!, y: publicJwk.y! }) };
}

/** base64url ECDSA P-256 / SHA-256 signature (r||s) over `boxQrMessage(p)`. */
export function signBoxQr(identity: BoxIdentity, p: Omit<BoxQrPayload, 'sig'>): string {
  const key = createPrivateKey({ key: identity.privateJwk, format: 'jwk' });
  return sign('sha256', Buffer.from(boxQrMessage(p)), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}

export type BoxQrFields = Omit<BoxQrPayload, 'v' | 'pub' | 'keyFp' | 'sig'>;

/** The `maxcom1:` text for a box QR: the identity adds `v`, `pub`, `keyFp` and the signature. */
export function buildBoxQr(identity: BoxIdentity, fields: BoxQrFields): string {
  const pub = { kty: 'EC', crv: 'P-256', x: identity.publicJwk.x!, y: identity.publicJwk.y! } as const;
  const unsigned: Omit<BoxQrPayload, 'sig'> = { v: 1, ...fields, keyFp: identity.keyFp, pub };
  return encodeBoxQr({ ...unsigned, sig: signBoxQr(identity, unsigned) });
}
