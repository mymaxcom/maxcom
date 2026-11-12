import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boxQrMessage, parseBoxQr } from '@surau/core';
import type { BoxQrPayload } from '@surau/core';
import { verifyP256 } from '../src/auth/crypto.ts';
import { secretDir } from '../src/auth/secrets.ts';
import { IDENTITY_KEY_FILE, buildBoxQr, loadIdentity, signBoxQr } from '../src/setup/identity.ts';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'surau-ident-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const fields = {
  type: 'setup' as const, boxId: '0123456789abcdef', name: 'MAXCOM 0123', box: 'https://10.168.0.2:8443',
  caSha256: 'a'.repeat(64), linked: false, nonce: 'n'.repeat(43), iat: 1795000000, exp: 1795000600,
};

describe('box identity key', () => {
  it('is created once and gives the same fingerprint on reload', () => {
    const dir = tmp();
    const a = loadIdentity(dir);
    const b = loadIdentity(dir);
    expect(a.keyFp).toMatch(/^[0-9a-f]{16}$/);
    expect(b.keyFp).toBe(a.keyFp);
    expect(b.privateJwk.d).toBe(a.privateJwk.d);
  });

  it('is sealed: the private scalar is not in the file', () => {
    const dir = tmp();
    const a = loadIdentity(dir);
    const raw = readFileSync(join(secretDir(dir), IDENTITY_KEY_FILE), 'utf8');
    expect(raw.startsWith('v1.')).toBe(true);
    expect(raw).not.toContain(a.privateJwk.d!);
  });

  it('a flipped byte makes loadIdentity throw without content', () => {
    const dir = tmp();
    loadIdentity(dir);
    const p = join(secretDir(dir), IDENTITY_KEY_FILE);
    const raw = readFileSync(p, 'utf8');
    const i = raw.lastIndexOf('.') + 2;
    writeFileSync(p, raw.slice(0, i) + (raw[i] === 'A' ? 'B' : 'A') + raw.slice(i + 1));
    expect(() => loadIdentity(dir)).toThrow('identity key: cannot open');
  });

  it('a signature verifies with verifyP256 and fails after one payload byte changes', () => {
    const id = loadIdentity(tmp());
    const unsigned: Omit<BoxQrPayload, 'sig'> = {
      v: 1, ...fields, keyFp: id.keyFp, pub: { kty: 'EC', crv: 'P-256', x: id.publicJwk.x!, y: id.publicJwk.y! },
    };
    const sig = signBoxQr(id, unsigned);
    const pub = { kty: 'EC', crv: 'P-256', x: id.publicJwk.x!, y: id.publicJwk.y! };
    expect(verifyP256(pub, Buffer.from(boxQrMessage(unsigned)), Buffer.from(sig, 'base64url'))).toBe(true);
    expect(verifyP256(pub, Buffer.from(boxQrMessage({ ...unsigned, name: 'MAXCOM 0124' })), Buffer.from(sig, 'base64url'))).toBe(
      false,
    );
  });

  it('buildBoxQr gives a text the core parser accepts and whose signature verifies', () => {
    const id = loadIdentity(tmp());
    const text = buildBoxQr(id, fields);
    expect(text.startsWith('maxcom1:')).toBe(true);
    const p = parseBoxQr(text);
    expect(p.keyFp).toBe(id.keyFp);
    const { sig, ...rest } = p;
    expect(
      verify('sha256', boxQrMessage(rest), { key: createPublicKey({ key: { ...p.pub }, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')),
    ).toBe(true);
  });
});
