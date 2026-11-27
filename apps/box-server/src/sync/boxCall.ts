import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { JsonWebKey } from '../auth/crypto.ts';

/**
 * Signed box calls (multi-box 2B, contract `2026-11-23-cloud-sleep-reset-contract.md`). The three routes that put a
 * surau to sleep, wake it or replace it from its box carry, besides the site's bearer token, an ES256 signature by the
 * box's sync key (`secret/sync.key`) over the method, path, box id, time, a one-time nonce and the body's hash. The
 * cloud verifies it with the public key it stored at link (`sites.public_jwk`). A stolen bearer token alone cannot
 * call them, a captured call cannot be sent twice, and a body cannot be swapped under a signature.
 */

export const BOX_CALL_VERSION = 'maxcom-boxcall-v1';
export const HDR_TS = 'x-maxcom-box-ts';
export const HDR_NONCE = 'x-maxcom-box-nonce';
export const HDR_SIG = 'x-maxcom-box-sig';
/** A signed call is taken within this much of the cloud's clock, either side. */
export const BOX_CALL_WINDOW_MS = 10 * 60_000;
/** Nonces are remembered this long (more than the two-sided window, so a nonce cannot come back inside it). */
export const NONCE_KEEP_MS = 20 * 60_000;

const NONCE_RE = /^[A-Za-z0-9_-]{22,64}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const PATH_RE = /^\/api\/sync\/[a-z-]{1,40}$/;

export function sha256Hex(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** The exact bytes that are signed. */
export function boxCallMessage(p: { method: string; path: string; boxId: string; ts: string; nonce: string; bodyHash: string }): string {
  return [BOX_CALL_VERSION, p.method.toUpperCase(), p.path, p.boxId, p.ts, p.nonce, p.bodyHash].join('|');
}

/** Box side: the three headers of a signed call. */
export function signBoxCall(
  privateJwk: JsonWebKey,
  p: { method: string; path: string; boxId: string; body: Buffer | string; now: Date; nonce: string },
): Record<string, string> {
  const ts = p.now.toISOString();
  const msg = boxCallMessage({ method: p.method, path: p.path, boxId: p.boxId, ts, nonce: p.nonce, bodyHash: sha256Hex(p.body) });
  const key = createPrivateKey({ key: privateJwk as never, format: 'jwk' });
  const sig = sign('sha256', Buffer.from(msg), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { [HDR_TS]: ts, [HDR_NONCE]: p.nonce, [HDR_SIG]: sig };
}

export type BoxCallRefusal = { status: 403; code: 'no_key' | 'bad_sig' | 'clock' } | { status: 409; code: 'replay' };

function header(headers: Record<string, unknown>, name: string): string | null {
  const v = headers[name];
  return typeof v === 'string' ? v : null;
}

/** The site's stored public key, or null when there is none usable. */
export function sitePublicKey(db: DatabaseSync, boxId: string): JsonWebKey | null {
  const r = db.prepare('SELECT public_jwk FROM sites WHERE box_id = ? AND revoked_at IS NULL AND linked_at IS NOT NULL').get(boxId);
  if (r === undefined || typeof r.public_jwk !== 'string') return null;
  try {
    const j = JSON.parse(r.public_jwk) as Record<string, unknown>;
    if (j.kty === 'EC' && j.crv === 'P-256' && typeof j.x === 'string' && typeof j.y === 'string') return { kty: 'EC', crv: 'P-256', x: j.x, y: j.y };
  } catch {
    /* not a usable key */
  }
  return null;
}

/**
 * Cloud side: check a signed call of `boxId` (the site the bearer token resolved to; never a header) and, when it is
 * good, spend its nonce. The nonce is spent only after the signature and time checked out, so a forged call cannot
 * burn a nonce the real box is about to use. Returns null when the call is good.
 */
export function verifyBoxCall(
  db: DatabaseSync,
  p: { method: string; path: string; boxId: string; headers: Record<string, unknown>; body: Buffer; now: Date },
): BoxCallRefusal | null {
  const jwk = sitePublicKey(db, p.boxId);
  if (jwk === null) return { status: 403, code: 'no_key' };
  const ts = header(p.headers, HDR_TS);
  const nonce = header(p.headers, HDR_NONCE);
  const sig = header(p.headers, HDR_SIG);
  if (ts === null || nonce === null || sig === null || !TS_RE.test(ts) || !NONCE_RE.test(nonce) || !SIG_RE.test(sig) || !PATH_RE.test(p.path)) {
    return { status: 403, code: 'bad_sig' };
  }
  const msg = boxCallMessage({ method: p.method, path: p.path, boxId: p.boxId, ts, nonce, bodyHash: sha256Hex(p.body) });
  let good = false;
  try {
    const key = createPublicKey({ key: jwk as never, format: 'jwk' });
    good = verify('sha256', Buffer.from(msg), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  } catch {
    good = false;
  }
  if (!good) return { status: 403, code: 'bad_sig' };
  const at = Date.parse(ts);
  if (!Number.isFinite(at) || Math.abs(p.now.getTime() - at) > BOX_CALL_WINDOW_MS) return { status: 403, code: 'clock' };
  db.prepare('DELETE FROM sync_nonces WHERE at < ?').run(new Date(p.now.getTime() - NONCE_KEEP_MS).toISOString());
  const put = db.prepare('INSERT INTO sync_nonces (box_id, nonce, at) VALUES (?, ?, ?) ON CONFLICT(box_id, nonce) DO NOTHING').run(p.boxId, nonce, p.now.toISOString());
  if (Number(put.changes) === 0) return { status: 409, code: 'replay' };
  return null;
}
