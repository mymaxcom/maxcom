import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BOX_QR_PREFIX, boxQrMessage, defaultBoxName, encodeBoxQr, fingerprintGroups, keyFingerprint, parseBoxQr,
} from '../src/index.ts';
import type { BoxQrPayload } from '../src/index.ts';

interface Vec { name: string; payload: BoxQrPayload; text: string; canonicalWithoutSig: string; messageHex: string; keyFp: string }
const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/box-qr-vectors.json', import.meta.url), 'utf8'),
) as { cases: Vec[] };

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const withText = (p: unknown): string => BOX_QR_PREFIX + Buffer.from(JSON.stringify(p)).toString('base64url');
const base = (): BoxQrPayload => structuredClone(vectors.cases[0]!.payload);

describe('box QR vectors', () => {
  it('pins ten payloads', () => expect(vectors.cases.length).toBe(10));
  for (const v of vectors.cases) {
    it(`round trip and signature: ${v.name}`, () => {
      expect(encodeBoxQr(v.payload)).toBe(v.text);
      const p = parseBoxQr(v.text);
      expect(p).toEqual(v.payload);
      expect(keyFingerprint(p.pub)).toBe(v.keyFp);
      const { sig, ...rest } = p;
      expect(hex(boxQrMessage(rest))).toBe(v.messageHex);
      const ok = verify(
        'sha256', boxQrMessage(rest), { key: createPublicKey({ key: { ...p.pub }, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
        Buffer.from(sig, 'base64url'),
      );
      expect(ok).toBe(true);
    });
  }
  it('a changed field breaks the signature', () => {
    const p = base();
    const { sig, ...rest } = p;
    const forged = { ...rest, name: 'Lain' };
    const ok = verify(
      'sha256', boxQrMessage(forged), { key: createPublicKey({ key: { ...p.pub }, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig, 'base64url'),
    );
    expect(ok).toBe(false);
  });
});

describe('parseBoxQr strictness', () => {
  it('refuses a wrong keyFp', () => {
    const p = base(); p.keyFp = '0123456789abcdef';
    expect(() => parseBoxQr(withText(p))).toThrow('Kod QR tidak sah');
  });
  it('refuses an unknown key', () => {
    expect(() => parseBoxQr(withText({ ...base(), extra: 1 }))).toThrow('Kod QR tidak sah');
  });
  it('refuses a plain http box', () => {
    const p = base(); p.box = 'http://10.168.0.20:8443';
    expect(() => parseBoxQr(withText(p))).toThrow('Kod QR tidak sah');
  });
  it('refuses a box with a path, and a cloud with a path', () => {
    const p = base(); p.box = 'https://10.168.0.20:8443/x';
    expect(() => parseBoxQr(withText(p))).toThrow('Kod QR tidak sah');
    const q = base(); q.cloud = 'https://api.mymaxcom.my/path';
    expect(() => parseBoxQr(withText(q))).toThrow('Kod QR tidak sah');
  });
  it('refuses exp <= iat', () => {
    const p = base(); p.exp = p.iat;
    expect(() => parseBoxQr(withText(p))).toThrow('Kod QR tidak sah');
  });
  it('refuses a wrong prefix, junk, a bad nonce size and a long name', () => {
    expect(() => parseBoxQr('surau1:abc')).toThrow('Kod QR tidak sah');
    expect(() => parseBoxQr(BOX_QR_PREFIX + '!!!')).toThrow('Kod QR tidak sah');
    const p = base(); p.nonce = 'short';
    expect(() => parseBoxQr(withText(p))).toThrow('Kod QR tidak sah');
    const q = base(); q.name = 'x'.repeat(61);
    expect(() => parseBoxQr(withText(q))).toThrow('Kod QR tidak sah');
  });
  it('refuses a payload over the size cap', () => {
    expect(() => parseBoxQr(BOX_QR_PREFIX + 'A'.repeat(5000))).toThrow('Kod QR tidak sah');
  });
});

describe('helpers', () => {
  it('default box name', () => expect(defaultBoxName('4f2a9c1e77b0d3a1')).toBe('MAXCOM 4F2A'));
  it('fingerprint groups', () => expect(fingerprintGroups('4f2a9c1e77b0d3a1')).toBe('4F2A 9C1E 77B0 D3A1'));
});
