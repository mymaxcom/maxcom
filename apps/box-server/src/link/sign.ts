import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { linkMessage } from '@surau/core';
import type { BoxQrPub, LinkStep } from '@surau/core';
import type { BoxIdentity } from '../setup/identity.ts';

/**
 * Signing and checking of box-to-box link messages with the box identity key. This is the second use of that key
 * (the first is box QR payloads): every message here starts `maxcom-link-v1|<step>|<linkId>|`, a box QR message starts
 * `maxcom-qr` and a line break, so a signature made for one can never be shown as the other.
 */
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;

/** base64url ECDSA P-256 / SHA-256 signature (r||s) over `linkMessage(step, linkId, body)`. */
export function signLink(identity: BoxIdentity, step: LinkStep, linkId: string, body: unknown): string {
  const key = createPrivateKey({ key: identity.privateJwk, format: 'jwk' });
  return sign('sha256', Buffer.from(linkMessage(step, linkId, body)), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}

/** True only for a well-formed signature by `pub` over exactly this step, session and body. Never throws. */
export function verifyLink(pub: BoxQrPub, step: LinkStep, linkId: string, body: unknown, sig: unknown): boolean {
  if (typeof sig !== 'string' || !SIG_RE.test(sig)) return false;
  try {
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y }, format: 'jwk' });
    return verify('sha256', Buffer.from(linkMessage(step, linkId, body)), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}

/** The public half of an identity in the shape the link messages carry. */
export function identityPub(identity: BoxIdentity): BoxQrPub {
  return { kty: 'EC', crv: 'P-256', x: identity.publicJwk.x!, y: identity.publicJwk.y! };
}
