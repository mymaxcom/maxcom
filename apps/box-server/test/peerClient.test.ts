import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PeerError, certPemAndHash, createPinnedClient } from '../src/link/peerClient.ts';

/**
 * Real HTTPS servers on 127.0.0.1 with the fixtures: `test-box2` is a self-signed certificate that names 127.0.0.1
 * and is its own root (the pinned CA); `test-box` is a leaf that chains to a root this folder does not hold (the
 * "other CA"). Each server answers `/api/pki/root.cer` with the certificate its test wants to present as the root.
 */
const fx = (n: string): Buffer => readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)));
const ROOT_DER = fx('test-box2-leaf.cer');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const ROOT_SHA = sha(ROOT_DER);
const OTHER_DER = fx('test-box-leaf.cer');
const OTHER_SHA = sha(OTHER_DER);

interface Srv {
  origin: string;
  hits: string[];
  close: () => Promise<void>;
}

async function serve(pfx: string, rootCer: () => Buffer | string, extra?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean): Promise<Srv> {
  const hits: string[] = [];
  const server = https.createServer({ pfx: fx(pfx), passphrase: 'test' }, (req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (extra?.(req, res) === true) return;
    if (req.url === '/api/pki/root.cer') {
      res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert' });
      res.end(rootCer());
      return;
    }
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, method: req.method, url: req.url, got: body === '' ? null : JSON.parse(body) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { origin: `https://127.0.0.1:${port}`, hits, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PeerError);
    return (e as PeerError).code;
  }
  throw new Error('expected a PeerError');
};

let good: Srv; // chains to ROOT_DER
let wrongChain: Srv; // says ROOT_DER is its root, but its leaf chains to something else
let redirecting: Srv;
let big: Srv;
let pem: Srv;
const closing: Srv[] = [];

beforeAll(async () => {
  good = await serve('test-box2.pfx', () => ROOT_DER);
  wrongChain = await serve('test-box.pfx', () => ROOT_DER);
  redirecting = await serve('test-box2.pfx', () => ROOT_DER, (req, res) => {
    if (req.url === '/api/redirect') {
      res.writeHead(302, { location: '/api/target' });
      res.end();
      return true;
    }
    return false;
  });
  big = await serve('test-box2.pfx', () => ROOT_DER, (req, res) => {
    if (req.url === '/api/big') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.alloc(2 * 1024 * 1024 + 10, 0x20));
      return true;
    }
    if (req.url === '/api/big-cert') return false;
    return false;
  });
  pem = await serve('test-box2.pfx', () => `-----BEGIN CERTIFICATE-----\n${ROOT_DER.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`);
  closing.push(good, wrongChain, redirecting, big, pem);
});
afterAll(async () => {
  for (const s of closing) await s.close();
});

describe('certPemAndHash', () => {
  it('hashes the DER of a certificate given as DER or as PEM to the same value', () => {
    const d = certPemAndHash(ROOT_DER)!;
    expect(d.sha256).toBe(ROOT_SHA);
    expect(d.pem).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
    const p = certPemAndHash(Buffer.from(d.pem))!;
    expect(p.sha256).toBe(ROOT_SHA);
  });
  it('refuses junk, a PEM with no certificate and a body that is not a DER sequence', () => {
    expect(certPemAndHash(Buffer.from('hello'))).toBeNull();
    expect(certPemAndHash(Buffer.alloc(200, 1))).toBeNull();
    expect(certPemAndHash(Buffer.from('-----BEGIN CERTIFICATE-----\n!!!\n-----END CERTIFICATE-----'))).toBeNull();
    expect(certPemAndHash(Buffer.from('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'))).toBeNull();
    expect(certPemAndHash(Buffer.alloc(0))).toBeNull();
  });
});

describe('pinned HTTPS client', () => {
  it('the right pin works: GET and POST with a JSON body reach the box, and nothing else is trusted', async () => {
    const c = createPinnedClient({ timeoutMs: 5000 });
    const g = await c.json(good.origin, ROOT_SHA, { path: '/api/ping?x=1' });
    expect(g.status).toBe(200);
    expect(g.json).toMatchObject({ ok: true, method: 'GET', url: '/api/ping?x=1' });
    const p = await c.post(good.origin, ROOT_SHA, '/api/link/peer/hello', { nonce: 'n', hello: { a: 1 } });
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({ method: 'POST', got: { nonce: 'n', hello: { a: 1 } } });
    // the root was fetched once, then kept for the origin and the pin
    expect(good.hits.filter((h) => h === 'GET /api/pki/root.cer')).toHaveLength(1);
  });

  it('the root may be served as PEM', async () => {
    const c = createPinnedClient({ timeoutMs: 5000 });
    expect((await c.json(pem.origin, ROOT_SHA, { path: '/x' })).status).toBe(200);
  });

  it('a wrong pin is ca_mismatch, and no request beyond the root fetch is made', async () => {
    const c = createPinnedClient({ timeoutMs: 5000 });
    const before = good.hits.length;
    expect(await code(c.json(good.origin, '0'.repeat(64), { path: '/api/secret' }))).toBe('ca_mismatch');
    expect(await code(c.post(good.origin, OTHER_SHA, '/api/link/peer/hello', { a: 1 }))).toBe('ca_mismatch');
    const seen = good.hits.slice(before);
    expect(seen.every((h) => h === 'GET /api/pki/root.cer')).toBe(true);
    expect(seen.some((h) => h.includes('secret') || h.includes('hello'))).toBe(false);
  });

  it('a wrong pin is not cached as a success: the right pin works right after', async () => {
    const c = createPinnedClient({ timeoutMs: 5000 });
    expect(await code(c.json(good.origin, '1'.repeat(64), { path: '/x' }))).toBe('ca_mismatch');
    expect((await c.json(good.origin, ROOT_SHA, { path: '/x' })).status).toBe(200);
    // and the reverse: a pin that worked for this origin does not make another pin work
    expect(await code(c.json(good.origin, '2'.repeat(64), { path: '/x' }))).toBe('ca_mismatch');
  });

  it('a server that hands out the pinned root but whose leaf chains to another CA fails (the pin proves nothing about the leaf)', async () => {
    const c = createPinnedClient({ timeoutMs: 5000 });
    expect(await code(c.json(wrongChain.origin, ROOT_SHA, { path: '/api/link/peer/hello' }))).toBe('unreachable');
    // the body was never sent: the server saw the root fetch only, no application request
    expect(wrongChain.hits.filter((h) => h !== 'GET /api/pki/root.cer')).toEqual([]);
    expect(await code(c.post(wrongChain.origin, ROOT_SHA, '/api/link/peer/message', { token: 'secret' }))).toBe('unreachable');
    expect(wrongChain.hits.filter((h) => h !== 'GET /api/pki/root.cer')).toEqual([]);
  });

  it('the other CA pinned for the chain-to-another-CA server (its real root is not held here): refused too', async () => {
    const c = createPinnedClient({ timeoutMs: 5000 });
    // the server serves ROOT_DER as its root, so a pin of the leaf's own hash does not match what it serves
    expect(await code(c.json(wrongChain.origin, OTHER_SHA, { path: '/x' }))).toBe('ca_mismatch');
  });

  it('no redirect is followed: the 302 comes back as it is and the target is never asked', async () => {
    const c = createPinnedClient({ timeoutMs: 5000 });
    const r = await c.json(redirecting.origin, ROOT_SHA, { path: '/api/redirect' });
    expect(r.status).toBe(302);
    expect(redirecting.hits).not.toContain('GET /api/target');
  });

  it('a body over 2 MB is too_large', async () => {
    const c = createPinnedClient({ timeoutMs: 5000 });
    expect(await code(c.json(big.origin, ROOT_SHA, { path: '/api/big' }))).toBe('too_large');
  });

  it('a root certificate over 16 KB is too_large and is not accepted', async () => {
    const huge = await serve('test-box2.pfx', () => Buffer.concat([ROOT_DER, Buffer.alloc(20 * 1024, 0)]));
    closing.push(huge);
    const c = createPinnedClient({ timeoutMs: 5000 });
    expect(await code(c.json(huge.origin, ROOT_SHA, { path: '/x' }))).toBe('too_large');
  });

  it('a root fetch that is not 200 is unreachable', async () => {
    const down = await serve('test-box2.pfx', () => ROOT_DER, (req, res) => {
      if (req.url === '/api/pki/root.cer') {
        res.writeHead(500);
        res.end('no');
        return true;
      }
      return false;
    });
    closing.push(down);
    const c = createPinnedClient({ timeoutMs: 5000 });
    expect(await code(c.json(down.origin, ROOT_SHA, { path: '/x' }))).toBe('unreachable');
  });

  it('a JSON body that is not JSON comes back as null with its status', async () => {
    const odd = await serve('test-box2.pfx', () => ROOT_DER, (req, res) => {
      if (req.url === '/api/text') {
        res.writeHead(502);
        res.end('<html>bad gateway</html>');
        return true;
      }
      return false;
    });
    closing.push(odd);
    const c = createPinnedClient({ timeoutMs: 5000 });
    expect(await c.json(odd.origin, ROOT_SHA, { path: '/api/text' })).toEqual({ status: 502, json: null });
  });

  it('a server that does not answer in time is a timeout or unreachable, never a hang', async () => {
    const slow = await serve('test-box2.pfx', () => ROOT_DER, (req) => req.url === '/api/slow');
    closing.push(slow);
    const c = createPinnedClient({ timeoutMs: 300 });
    const k = await code(c.json(slow.origin, ROOT_SHA, { path: '/api/slow' }));
    expect(['timeout', 'unreachable']).toContain(k);
  });

  it('an address with nothing listening is unreachable', async () => {
    const c = createPinnedClient({ timeoutMs: 2000 });
    expect(await code(c.json('https://127.0.0.1:9', ROOT_SHA, { path: '/x' }))).toBe('unreachable');
  });

  describe('what is refused before any connection', () => {
    const c = createPinnedClient({ timeoutMs: 1000 });
    const origins = [
      'http://127.0.0.1:8443',
      'ftp://127.0.0.1',
      'https://user:pw@127.0.0.1:8443',
      'https://127.0.0.1:8443/',
      'https://127.0.0.1:8443/path',
      'https://127.0.0.1:8443?x=1',
      'not a url',
      '',
      'HTTPS://127.0.0.1:8443',
    ];
    it.each(origins.map((o) => [o]))('origin %j is bad_origin', async (o) => {
      expect(await code(c.json(o, ROOT_SHA, { path: '/x' }))).toBe('bad_origin');
    });

    it.each([['x'], ['api/x'], ['//evil.example/x'], [''], ['http://127.0.0.1/x']])('path %j is bad_origin', async (p) => {
      expect(await code(c.json(good.origin, ROOT_SHA, { path: p }))).toBe('bad_origin');
    });

    it.each([[''], ['abc'], ['G'.repeat(64)], [ROOT_SHA.toUpperCase()], [ROOT_SHA + '0'], [ROOT_SHA.slice(1)]])('pin %j is bad_origin', async (pin) => {
      expect(await code(c.json(good.origin, pin, { path: '/x' }))).toBe('bad_origin');
    });

    it('none of them reached the server', () => {
      const asked = good.hits.filter((h) => h.includes('evil') || h.includes('api/x'));
      expect(asked).toEqual([]);
    });
  });
});
