import { createHash } from 'node:crypto';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { PeerTransport } from './session.ts';

/**
 * HTTPS from one box to another on the surau LAN, pinned to the other box's root CA. SECURITY code.
 *
 * The caller knows the sha256 of the other box's root CA from a SIGNED source (the link QR, a signed hello or the
 * sealed follow record). This client fetches `/api/pki/root.cer` without trusting anything, compares its hash with
 * that pin, and then talks to the box trusting ONLY that certificate: not the system roots, not this box's own CA.
 * The host name or address must be named by the leaf, as for any HTTPS call. No redirect is followed.
 */

const MAX_CERT_BYTES = 16 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

export class PeerError extends Error {
  readonly code: 'bad_origin' | 'ca_mismatch' | 'unreachable' | 'too_large' | 'timeout';
  constructor(code: PeerError['code']) {
    super(`peer: ${code}`);
    this.code = code;
  }
}

function lanOrigin(origin: string): URL {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    throw new PeerError('bad_origin');
  }
  if (u.protocol !== 'https:' || u.origin !== origin || u.username !== '' || u.password !== '') throw new PeerError('bad_origin');
  return u;
}

/** PEM of one certificate given as DER or PEM, with the sha256 hex of its DER. */
export function certPemAndHash(raw: Buffer): { pem: string; sha256: string } | null {
  const text = raw.toString('latin1');
  let der: Buffer;
  if (text.includes('BEGIN CERTIFICATE')) {
    const m = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/.exec(text);
    if (m === null) return null;
    der = Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64');
  } else der = raw;
  if (der.length < 64 || der[0] !== 0x30) return null;
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd()}\n-----END CERTIFICATE-----\n`;
  return { pem, sha256: createHash('sha256').update(der).digest('hex') };
}

function readBody(res: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    res.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        res.destroy();
        reject(new PeerError('too_large'));
        return;
      }
      parts.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(parts)));
    res.on('error', () => reject(new PeerError('unreachable')));
  });
}

export interface PinnedRequest {
  method?: 'GET' | 'POST' | 'DELETE';
  /** Path with query, starting with `/`. */
  path: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PinnedClient extends PeerTransport {
  /** One request to `origin`, trusted only through the CA whose DER hashes to `caSha256`. The caller reads the stream. */
  request(origin: string, caSha256: string, req: PinnedRequest): Promise<IncomingMessage>;
  /** Same, with the body read as JSON (null when it is not JSON), capped at 2 MB. */
  json(origin: string, caSha256: string, req: PinnedRequest): Promise<{ status: number; json: unknown }>;
}

export function createPinnedClient(o: { timeoutMs?: number } = {}): PinnedClient {
  const timeoutMs = o.timeoutMs ?? 15_000;
  /** Pinned CA PEM per origin and pin. A box that renews its root gets a new pin from a new signed source. */
  const cas = new Map<string, string>();

  const fetchCa = (u: URL, caSha256: string): Promise<string> =>
    new Promise((resolve, reject) => {
      // The only unverified request: its answer is public and is accepted only when its hash equals the pin.
      const req = https.request(
        new URL('/api/pki/root.cer', u),
        { method: 'GET', rejectUnauthorized: false, minVersion: 'TLSv1.2', timeout: timeoutMs, agent: false },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new PeerError('unreachable'));
            return;
          }
          readBody(res, MAX_CERT_BYTES).then((raw) => {
            const c = certPemAndHash(raw);
            if (c === null || c.sha256 !== caSha256) reject(new PeerError('ca_mismatch'));
            else resolve(c.pem);
          }, reject);
        },
      );
      req.on('timeout', () => req.destroy(new PeerError('timeout')));
      req.on('error', (e) => reject(e instanceof PeerError ? e : new PeerError('unreachable')));
      req.end();
    });

  const request = async (origin: string, caSha256: string, r: PinnedRequest): Promise<IncomingMessage> => {
    const u = lanOrigin(origin);
    if (!HEX64.test(caSha256) || !r.path.startsWith('/') || r.path.startsWith('//')) throw new PeerError('bad_origin');
    const key = `${origin}|${caSha256}`;
    let ca = cas.get(key);
    if (ca === undefined) {
      ca = await fetchCa(u, caSha256);
      cas.set(key, ca);
    }
    const trusted = ca;
    return new Promise<IncomingMessage>((resolve, reject) => {
      const req = https.request(
        new URL(r.path, u),
        {
          method: r.method ?? 'GET', headers: r.headers ?? {}, ca: [trusted], rejectUnauthorized: true, minVersion: 'TLSv1.2',
          timeout: r.timeoutMs ?? timeoutMs, agent: false, ...(r.signal ? { signal: r.signal } : {}),
        },
        resolve,
      );
      req.on('timeout', () => req.destroy(new PeerError('timeout')));
      req.on('error', (e) => {
        // A certificate that no longer chains to the pinned CA: forget the cached copy, the next call checks again.
        cas.delete(key);
        reject(e instanceof PeerError ? e : new PeerError('unreachable'));
      });
      if (r.body === undefined) req.end();
      else req.end(r.body);
    });
  };

  const json = async (origin: string, caSha256: string, r: PinnedRequest): Promise<{ status: number; json: unknown }> => {
    const res = await request(origin, caSha256, r);
    const raw = await readBody(res, MAX_JSON_BYTES);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      parsed = null;
    }
    return { status: res.statusCode ?? 502, json: parsed };
  };

  return {
    request,
    json,
    post: (origin, caSha256, path, body) =>
      json(origin, caSha256, { method: 'POST', path, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  };
}
