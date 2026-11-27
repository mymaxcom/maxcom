import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { boxQrMessage, linkIdFromNonce } from '@surau/core';
import { ephemeralIdentity, signBoxQr } from '../src/setup/identity.ts';
import { identityPub, signLink, verifyLink } from '../src/link/sign.ts';

const id = linkIdFromNonce('n'.repeat(43));
const other = linkIdFromNonce('m'.repeat(43));

describe('link signatures', () => {
  const a = ephemeralIdentity();
  const b = ephemeralIdentity();
  const body = { boxId: 'a'.repeat(16), rev: 1, hash: 'f'.repeat(64) };

  it('verifies its own signature for the same step, session and body', () => {
    const sig = signLink(a, 'consent', id, body);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(verifyLink(identityPub(a), 'consent', id, body, sig)).toBe(true);
    expect(verifyLink(identityPub(a), 'consent', id, { hash: body.hash, rev: 1, boxId: body.boxId }, sig)).toBe(true);
  });
  it('refuses another key, step, session or body', () => {
    const sig = signLink(a, 'consent', id, body);
    expect(verifyLink(identityPub(b), 'consent', id, body, sig)).toBe(false);
    expect(verifyLink(identityPub(a), 'commit', id, body, sig)).toBe(false);
    expect(verifyLink(identityPub(a), 'consent', other, body, sig)).toBe(false);
    expect(verifyLink(identityPub(a), 'consent', id, { ...body, rev: 2 }, sig)).toBe(false);
  });
  it('refuses malformed signatures without throwing', () => {
    for (const bad of [undefined, null, 1, '', 'x'.repeat(85), 'x'.repeat(87), `${'x'.repeat(85)}=`, {}]) {
      expect(verifyLink(identityPub(a), 'consent', id, body, bad)).toBe(false);
    }
    expect(verifyLink({ kty: 'EC', crv: 'P-256', x: 'bad', y: 'bad' }, 'consent', id, body, signLink(a, 'consent', id, body))).toBe(false);
  });
  it('a box QR signature is not a link signature, and the reverse', () => {
    const qr = { v: 1 as const, type: 'link' as const, boxId: 'a'.repeat(16), keyFp: a.keyFp, name: 'x', box: '', caSha256: null, linked: false, nonce: 'n'.repeat(43), iat: 1, exp: 2, pub: identityPub(a) };
    const qrSig = signBoxQr(a, qr);
    for (const step of ['hello', 'answers', 'consent', 'commit', 'order-forget', 'order-revert', 'order-standalone'] as const) {
      expect(verifyLink(identityPub(a), step, id, qr, qrSig)).toBe(false);
    }
    const linkSig = signLink(a, 'hello', id, qr);
    const key = createPublicKey({ key: { ...identityPub(a) }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(boxQrMessage(qr)), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(linkSig, 'base64url'))).toBe(false);
  });
});
