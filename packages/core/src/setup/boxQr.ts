/** Signed box QR payloads (`maxcom1:` + base64url JSON). Pure (browser-safe). The Dart twin in
 *  apps/surau-app/lib/box/box_qr.dart must give the same bytes: test/fixtures/box-qr-vectors.json pins them. */

import { canonicalJson, sha256Hex } from '../sync/canonical.ts';

export const BOX_QR_PREFIX = 'maxcom1:';
export type BoxQrType = 'setup' | 'recovery' | 'probe';

export interface BoxQrPub { kty: 'EC'; crv: 'P-256'; x: string; y: string }

/** `iat` and `exp` are Unix seconds. */
export interface BoxQrPayload {
  v: 1;
  type: BoxQrType;
  boxId: string;
  keyFp: string;
  name: string;
  box: string;
  caSha256: string | null;
  linked: boolean;
  cloud?: string;
  nonce: string;
  iat: number;
  exp: number;
  pub: BoxQrPub;
  sig: string;
}

const BAD = 'Kod QR tidak sah';
const MAX_TEXT = 4096;
const KEYS = new Set([
  'v', 'type', 'boxId', 'keyFp', 'name', 'box', 'caSha256', 'linked', 'cloud', 'nonce', 'iat', 'exp', 'pub', 'sig',
]);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error(BAD);
  const std = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** First 16 hex of sha256 of the canonical JSON of `{crv,kty,x,y}`. */
export function keyFingerprint(pub: { kty: string; crv: string; x: string; y: string }): string {
  return sha256Hex(utf8(canonicalJson({ crv: pub.crv, kty: pub.kty, x: pub.x, y: pub.y }))).slice(0, 16);
}

/** `'4F2A 9C1E 77B0 D3A1'` from 16 hex. */
export function fingerprintGroups(fp: string): string {
  return (fp.toUpperCase().match(/.{1,4}/g) ?? []).join(' ');
}

/** The canonical string the signature covers is made of everything but `sig`. */
export function boxQrCanonical(p: Omit<BoxQrPayload, 'sig'>): string {
  return canonicalJson(p);
}

/** UTF-8 of `maxcom-qr\n<boxId>\n<type>\n<sha256 hex of canonicalJson(payload without sig)>`. */
export function boxQrMessage(p: Omit<BoxQrPayload, 'sig'>): Uint8Array {
  const { sig: _sig, ...rest } = p as BoxQrPayload;
  return utf8(`maxcom-qr\n${rest.boxId}\n${rest.type}\n${sha256Hex(utf8(boxQrCanonical(rest)))}`);
}

export function encodeBoxQr(p: BoxQrPayload): string {
  return BOX_QR_PREFIX + b64urlEncode(utf8(JSON.stringify(p)));
}

function isOrigin(s: unknown, allowEmpty: boolean): s is string {
  if (s === '') return allowEmpty;
  if (typeof s !== 'string' || s.length > 200) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && u.origin === s && !u.username && !u.password && u.hostname !== '';
  } catch {
    return false;
  }
}

/** Strict parse. Only the listed keys and sizes; the signature is NOT checked here (the verifier needs a crypto API). */
export function parseBoxQr(text: string): BoxQrPayload {
  if (typeof text !== 'string' || text.length > MAX_TEXT || !text.startsWith(BOX_QR_PREFIX)) throw new Error(BAD);
  let o: unknown;
  try {
    o = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b64urlDecode(text.slice(BOX_QR_PREFIX.length))));
  } catch {
    throw new Error(BAD);
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new Error(BAD);
  const r = o as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!KEYS.has(k)) throw new Error(BAD);
  const hex16 = /^[0-9a-f]{16}$/;
  const int = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
  const pub = r.pub as Record<string, unknown> | undefined;
  if (
    r.v !== 1 ||
    (r.type !== 'setup' && r.type !== 'recovery' && r.type !== 'probe') ||
    typeof r.boxId !== 'string' || !hex16.test(r.boxId) ||
    typeof r.keyFp !== 'string' || !hex16.test(r.keyFp) ||
    typeof r.name !== 'string' || r.name.length < 1 || r.name.length > 60 ||
    !isOrigin(r.box, true) ||
    !(r.caSha256 === null || (typeof r.caSha256 === 'string' && /^[0-9a-f]{64}$/.test(r.caSha256))) ||
    typeof r.linked !== 'boolean' ||
    (r.cloud !== undefined && !isOrigin(r.cloud, false)) ||
    typeof r.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(r.nonce) ||
    !int(r.iat) || !int(r.exp) || r.exp <= r.iat ||
    typeof r.sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(r.sig) ||
    typeof pub !== 'object' || pub === null ||
    Object.keys(pub).sort().join() !== 'crv,kty,x,y' ||
    pub.kty !== 'EC' || pub.crv !== 'P-256' ||
    typeof pub.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(pub.x) ||
    typeof pub.y !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(pub.y)
  ) throw new Error(BAD);
  const p = r as unknown as BoxQrPayload;
  if (p.keyFp !== keyFingerprint(p.pub)) throw new Error(BAD);
  return p;
}
