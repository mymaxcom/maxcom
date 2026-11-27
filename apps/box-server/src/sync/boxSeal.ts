import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import type { JsonWebKey } from '../auth/crypto.ts';

/**
 * A value sealed to ONE box: ECIES on the box's own P-256 sync key pair (the public half is on the cloud's site row,
 * the private half is sealed in the box's `sync.key`). SECURITY code, shared by every use:
 *
 *  - the camera address a phone sends through the cloud (`cameraRelayCrypto.ts`, label `maxcom-camera-relay-v1`);
 *  - the OAuth client the cloud delivers to a linked box for YouTube (`youtubeBoxCloud.ts`, label
 *    `maxcom-youtube-client-v1`). (Until 2026.11.15 a YouTube grant the cloud held was handed over too, under a label
 *    of its own; the cloud holds none now.)
 *
 * A fresh ephemeral P-256 key per message, ECDH, HKDF-SHA256 (info `<label>\n<aad>`) into an AES-256-GCM key; the
 * associated text is authenticated too. Each use has its own label, so a value sealed for one use never opens as
 * another. Wire form `e1.<ephemeral public point, 65 bytes>.<iv, 12>.<ciphertext>.<tag, 16>`, each part base64url.
 */

export const SEAL_VERSION = 'e1';

/** The shape of a sealed value whose ciphertext is at most [maxCipherChars] base64url characters. */
export const sealedRe = (maxCipherChars: number): RegExp => new RegExp(`^e1\\.[A-Za-z0-9_-]{87}\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]{1,${maxCipherChars}}\\.[A-Za-z0-9_-]{22}$`);

function pointToPublicKey(point: Buffer) {
  if (point.length !== 65 || point[0] !== 0x04) throw new Error('seal: bad point');
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') }, format: 'jwk' });
}

function deriveKey(shared: Buffer, label: string, aad: string): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), `${label}\n${aad}`, 32));
}

/** Seals [plaintext] to the box's public JWK under one use's [label] and the [aad] that binds it. */
export function sealToBoxKey(publicJwk: JsonWebKey, plaintext: string, label: string, aad: string): string {
  const eph = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const boxKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: String(publicJwk.x), y: String(publicJwk.y) }, format: 'jwk' });
  const ephJwk = eph.publicKey.export({ format: 'jwk' });
  const ephPoint = Buffer.concat([Buffer.from([0x04]), Buffer.from(String(ephJwk.x), 'base64url'), Buffer.from(String(ephJwk.y), 'base64url')]);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: boxKey });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(shared, label, aad), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [SEAL_VERSION, ephPoint.toString('base64url'), iv.toString('base64url'), ct.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

/** Opens a sealed value with the box's private JWK. Throws a fixed `seal: cannot open` on any fault. Never logs. */
export function openWithBoxKey(privateJwk: JsonWebKey, sealed: string, label: string, aad: string, shape: RegExp): string {
  try {
    if (typeof sealed !== 'string' || !shape.test(sealed)) throw new Error('format');
    const [, e, i, c, t] = sealed.split('.') as [string, string, string, string, string];
    const iv = Buffer.from(i, 'base64url');
    const tag = Buffer.from(t, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('format');
    const priv = createPrivateKey({ key: privateJwk, format: 'jwk' });
    const shared = diffieHellman({ privateKey: priv, publicKey: pointToPublicKey(Buffer.from(e, 'base64url')) });
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(shared, label, aad), iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(c, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('seal: cannot open');
  }
}
