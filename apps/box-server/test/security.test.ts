/**
 * Task 10 (Plan 3): active security probes against the box server, written as a pentester would.
 * One describe per probe area. Every probe asserts; a failure here is a finding and goes into
 * docs/field-tests/SECURITY-PLAN3.md with its fix.
 */
import { createHash, webcrypto } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { connect as netConnect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { KIOSK_PERMISSIONS, PERMISSIONS, ROLES, klInstant } from '@surau/core';
import type { Permission, Role } from '@surau/core';
import { buildApp } from '../src/app.ts';
import type { AppOptions } from '../src/app.ts';
import { MSG_UNLOCK_AGAIN, ROUTE_PERMISSIONS, classifyRequest, normalisePath, siteMayCall } from '../src/auth/authz.ts';
import type { RoutePermission } from '../src/auth/authz.ts';
import { beginEnrolment } from '../src/auth/devices.ts';
import { createUser } from '../src/auth/users.ts';
import { putFeature } from '../src/settingsStore.ts';
import { planListeners, startListeners } from '../src/main.ts';
import type { Listeners } from '../src/main.ts';
import { loadTls } from '../src/tls.ts';
import type { TlsMaterial } from '../src/tls.ts';
import { TEST_PIN, loginAs, loginAsAdmin } from './authHelpers.ts';
import { insertSite } from './support/sites.ts';
import type { Login } from './authHelpers.ts';

const AT = klInstant('2026-11-03', '12:00');
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const KIOSK_DIST = fileURLToPath(new URL('../../kiosk-display/dist/', import.meta.url));

// ---------------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------------

interface Ctx {
  app: FastifyInstance;
  dir: string;
  dataDir: string;
  dbPath: string;
  staticDir: string;
  clock: { t: Date };
  boxKey: Buffer;
}

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
const listeners: Listeners[] = [];

afterEach(async () => {
  for (const l of listeners.splice(0)) await l.app.close().catch(() => undefined);
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
});
afterAll(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* Windows may still hold a SQLite handle for a moment; the OS temp folder is swept anyway */
    }
  }
});

/** Everything every response said: scanned by the secrets probe at the end. */
const seen: { method: string; url: string; status: number; text: string }[] = [];
const consoleLines: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-sec-'));
  dirs.push(d);
  return d;
}

/** A tiny kiosk page folder (index.html + sw.js + one asset) beside the secret folder. */
function make(opts: Partial<AppOptions> = {}, keep = false): Ctx {
  const dir = tempDir();
  const dataDir = join(dir, 'data');
  const staticDir = join(dir, 'dist');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(staticDir, 'assets'), { recursive: true });
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><html><body><div id="app"></div></body></html>');
  writeFileSync(join(staticDir, 'sw.js'), '// sw');
  writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  const dbPath = join(dataDir, 'surau.db');
  const clock = { t: AT };
  const app = buildApp(dbPath, { now: () => clock.t, dataDir, staticDir, ...opts });
  if (!keep) apps.push(app);
  // The probes here are about the PIN path, which only exists while the app lock is on (off by default).
  putFeature(app.surau.db, 'appLock', { enabled: true }, 'test');
  const boxKey = readFileSync(join(dataDir, 'secret', 'box.key'));
  return { app, dir, dataDir, dbPath, staticDir, clock, boxKey };
}

let ipCounter = 0;
/** A fresh LAN client address per call, so one probe never consumes another's rate limit. */
const lan = (): string => `10.77.${(++ipCounter >> 8) & 255}.${ipCounter & 255}`;

interface CallOpts {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
  remoteAddress?: string;
}

/** `app.inject` from a fresh LAN address unless one is given; every response is recorded. */
async function call(app: FastifyInstance, o: CallOpts): Promise<{ status: number; text: string; headers: Record<string, unknown>; json: () => any }> {
  const res = await app.inject({
    method: (o.method ?? 'GET') as 'GET',
    url: o.url,
    headers: o.headers ?? {},
    remoteAddress: o.remoteAddress ?? lan(),
    ...(o.payload !== undefined ? { payload: o.payload as never } : {}),
  });
  const text = res.body;
  seen.push({ method: o.method ?? 'GET', url: o.url, status: res.statusCode, text: text.length > 200_000 ? text.slice(0, 200_000) : text });
  return { status: res.statusCode, text, headers: res.headers, json: () => JSON.parse(text) };
}

const LEAK = /SQLITE|node:sqlite|node_modules|\bat (?:async )?[\w$.<>]+ \(|\bat (?:file:|[A-Za-z]:[\\/]|\/)|\b[A-Za-z]:[\\/][\w.-]+[\\/]|\/Users\/|\/home\/|\.(?:ts|js|mjs):\d+|\bstack\b|\bENOENT\b|\bEACCES\b/i;

/** Error bodies must carry no stack, SQL text or file path. Reflected request text is removed first. */
function expectNoLeak(text: string, url: string): void {
  let t = text;
  const bits = new Set<string>([url, safeDecode(url)]);
  for (const seg of safeDecode(url).split(/[/?&=]/)) if (seg.length >= 2) bits.add(seg);
  for (const b of [...bits].sort((a, c) => c.length - a.length)) {
    t = t.split(b).join('');
    t = t.split(JSON.stringify(b).slice(1, -1)).join('');
  }
  expect(t, `leak in body for ${url.slice(0, 80)}`).not.toMatch(LEAK);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Hash of every table that a rejected request must leave alone. */
function dbState(app: FastifyInstance): string {
  const db = app.surau.db;
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => String(r.name))
    .filter((n) => !['sessions', 'challenges', 'auth_log'].includes(n));
  const h = createHash('sha256');
  for (const t of tables) {
    h.update(`#${t}\n`);
    for (const row of db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()) h.update(JSON.stringify(row) + '\n');
  }
  return h.digest('hex');
}

/** A device that can sign challenges, so the probes can capture and replay real bodies. */
async function newDevice(app: FastifyInstance, roles: Role[] = ['admin'], pin = TEST_PIN) {
  const n = ++ipCounter;
  const { db, boxId } = app.surau;
  const user = createUser(db, { name: `Sec ${n}`, roles }, 'test');
  const { code } = beginEnrolment(db, { userId: user.id, deviceName: `Peranti ${n}` }, 'test');
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const enrol = await call(app, { method: 'POST', url: '/api/enrol/complete', payload: { code, publicJwk, platform: 'web', pin } });
  if (enrol.status !== 200) throw new Error(`enrol failed ${enrol.status}`);
  const deviceId = String(enrol.json().deviceId);
  const ip = lan();
  const challenge = async (): Promise<string> => {
    const ch = await call(app, { method: 'POST', url: '/api/auth/challenge', payload: { deviceId }, remoteAddress: ip });
    return String(ch.json().nonce);
  };
  const sign = async (nonce: string): Promise<string> => {
    const msg = new TextEncoder().encode(`surau-unlock\n${boxId}\n${deviceId}\n${nonce}`);
    return Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, msg)).toString('base64url');
  };
  const body = async (nonce: string, usePin = pin) => ({ deviceId, nonce, signature: await sign(nonce), pin: usePin });
  const unlock = (payload: unknown, remoteAddress = ip) => call(app, { method: 'POST', url: '/api/auth/unlock', payload, remoteAddress });
  return { userId: user.id, deviceId, code, ip, challenge, sign, body, unlock };
}

/** Pairs a kiosk through the real routes; returns the cookie header value. */
async function pairKiosk(app: FastifyInstance, admin: Login) {
  const begin = await call(app, { method: 'POST', url: '/api/kiosk/pair/begin' });
  const { code, pollToken } = begin.json();
  const approve = await call(app, { method: 'POST', url: '/api/kiosk/pair/approve', headers: admin.headers, payload: { code } });
  expect(approve.status).toBe(200);
  const poll = await call(app, { method: 'POST', url: '/api/kiosk/pair/poll', payload: { pollToken } });
  const setCookie = String(poll.headers['set-cookie']);
  const cookie = setCookie.split(';')[0]!;
  return { cookie, code, pollToken, deviceId: String(approve.json().deviceId), setCookie };
}

interface RawRes {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** A hand-written HTTP/1.1 request on a raw socket: nothing normalises the path or headers. */
function rawReq(
  port: number,
  o: { method?: string; path: string; host?: string | null; headers?: Record<string, string>; body?: Buffer | string; tls?: boolean },
): Promise<RawRes> {
  return new Promise((resolve, reject) => {
    const lines = [`${o.method ?? 'GET'} ${o.path} HTTP/1.1`];
    if (o.host !== null) lines.push(`Host: ${o.host ?? '127.0.0.1'}`);
    for (const [k, v] of Object.entries(o.headers ?? {})) lines.push(`${k}: ${v}`);
    const body = o.body === undefined ? Buffer.alloc(0) : Buffer.from(o.body);
    if (body.length > 0) lines.push(`Content-Length: ${body.length}`);
    lines.push('Connection: close', '', '');
    const head = Buffer.from(lines.join('\r\n'), 'latin1');
    const chunks: Buffer[] = [];
    const sock = o.tls
      ? tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false })
      : netConnect({ host: '127.0.0.1', port });
    sock.setTimeout(10_000, () => sock.destroy(new Error('raw timeout')));
    sock.on('connect', () => {
      if (!o.tls) {
        sock.write(head);
        if (body.length > 0) sock.write(body);
      }
    });
    sock.on('secureConnect', () => {
      sock.write(head);
      if (body.length > 0) sock.write(body);
    });
    sock.on('data', (c: Buffer) => chunks.push(c));
    sock.on('error', reject);
    sock.on('close', () => {
      const all = Buffer.concat(chunks);
      const split = all.indexOf('\r\n\r\n');
      if (split < 0) return resolve({ status: 0, headers: {}, body: all });
      const headText = all.subarray(0, split).toString('latin1').split('\r\n');
      const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(headText[0] ?? '')?.[1] ?? 0);
      const headers: Record<string, string> = {};
      for (const l of headText.slice(1)) {
        const i = l.indexOf(':');
        if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      let payload = all.subarray(split + 4);
      if ((headers['transfer-encoding'] ?? '').includes('chunked')) {
        const parts: Buffer[] = [];
        let p = payload;
        for (;;) {
          const eol = p.indexOf('\r\n');
          if (eol < 0) break;
          const size = parseInt(p.subarray(0, eol).toString('latin1'), 16);
          if (!Number.isFinite(size) || size === 0) break;
          parts.push(p.subarray(eol + 2, eol + 2 + size));
          p = p.subarray(eol + 2 + size + 2);
        }
        payload = Buffer.concat(parts);
      }
      resolve({ status, headers, body: payload });
    });
  });
}

async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  return (app.server.address() as AddressInfo).port;
}

function fixtureTls(): TlsMaterial {
  const d = tempDir();
  mkdirSync(join(d, 'secret'));
  mkdirSync(join(d, 'pki'));
  cpSync(join(fixtures, 'test-box.pfx'), join(d, 'secret', 'box.pfx'));
  writeFileSync(join(d, 'secret', 'pfx.pass'), 'test');
  cpSync(join(fixtures, 'test-box-leaf.cer'), join(d, 'pki', 'box-leaf.cer'));
  const tls = loadTls(d, new Date('2026-11-03T00:00:00Z'));
  if (!tls) throw new Error('fixture tls missing');
  return tls;
}

/** Fastify route table text -> concrete (method, path) pairs, one per registered route. */
function registeredRoutes(app: FastifyInstance): { method: string; path: string; shape: string }[] {
  const text = app.printRoutes({ commonPrefix: false });
  const out: { method: string; path: string; shape: string }[] = [];
  const stack: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^((?:│   |    )*)(?:├── |└── )(.*) \(([A-Z, ]+)\)$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack[depth] = m[2]!;
    const shape = stack.join('').replace(/\/\//g, '/');
    for (const method of m[3]!.split(', ')) out.push({ method, path: concretePath(shape), shape });
  }
  return out;
}

function concretePath(shape: string): string {
  return shape
    .replace(/:id\(\^\[0-9a-f\]\{64\}\$\)/, 'a'.repeat(64))
    .replace(/:[A-Za-z]+/g, 'x')
    .replace(/\*$/, 'index.html');
}

const PUBLIC_RULES = ROUTE_PERMISSIONS.filter((r) => r.permission === 'public');

// ---------------------------------------------------------------------------------------------
// 1. route enumeration and unauthenticated access
// ---------------------------------------------------------------------------------------------

describe('1 route enumeration: nothing registered is unlisted, nothing is reachable anonymously', () => {
  let c: Ctx;
  beforeAll(async () => {
    c = make({}, true);
    await c.app.ready();
  });
  afterAll(async () => {
    await c.app.close();
  });

  it('every registered Fastify route is covered by exactly the permission table (default deny, no accidents)', () => {
    const routes = registeredRoutes(c.app).filter((r) => r.shape !== '*');
    expect(routes.length).toBeGreaterThan(25);
    for (const r of routes) {
      const cls = classifyRequest(r.method, r.path);
      expect(cls.kind, `${r.method} ${r.path} must be listed in ROUTE_PERMISSIONS`).toBe('rule');
    }
  });

  it('every ROUTE_PERMISSIONS entry belongs to a real route (no stale rule that hides a typo)', () => {
    const routes = registeredRoutes(c.app);
    for (const rule of ROUTE_PERMISSIONS) {
      const hit = routes.some((r) => r.method === rule.method && classifyRequest(r.method, r.path).kind === 'rule' && rule.pattern.test(normalisePath(r.path) ?? ''));
      expect(hit, `${rule.method} ${rule.sample} has no registered route`).toBe(true);
    }
  });

  it('the public list is exactly the fifteen intended routes (POST /api/sync/link and /api/sync/claim are cloud-only: 404 on a box)', () => {
    expect(PUBLIC_RULES.map((r) => `${r.method} ${r.sample}`).sort()).toEqual(
      [
        'GET /api/box/info',
        'GET /api/health',
        'GET /api/pki/root.cer',
        'GET /api/surau/info',
        'GET /surau-logo',
        'POST /api/auth/challenge',
        'POST /api/auth/unlock',
        'POST /api/enrol/complete',
        'POST /api/kiosk/pair/begin',
        'POST /api/kiosk/pair/poll',
        'POST /api/recovery/complete',
        'POST /api/setup/complete',
        'POST /api/setup/probe',
        'POST /api/sync/claim',
        'POST /api/sync/link',
      ].sort(),
    );
  });

  it('anonymous (LAN) requests: every non-public route answers 401 for every method, including HEAD and OPTIONS', async () => {
    const routes = registeredRoutes(c.app);
    const paths = [...new Set(routes.filter((r) => r.shape !== '*').map((r) => r.path))];
    for (const path of paths) {
      const cls = classifyRequest('GET', path);
      const isPublicGet = cls.kind === 'rule' && cls.permission === 'public';
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
        const rule = classifyRequest(method, path);
        const isPublic = rule.kind === 'rule' && rule.permission === 'public';
        if (isPublic || (method === 'GET' && isPublicGet)) continue;
        const r = await call(c.app, { method, url: path, payload: method === 'POST' || method === 'PUT' || method === 'PATCH' ? {} : undefined });
        expect(r.status, `${method} ${path}`).toBe(401);
      }
    }
  });

  it('anonymous requests to public routes never get the generic deny; unlisted verbs on them are denied', async () => {
    for (const rule of PUBLIC_RULES) {
      const r = await call(c.app, { method: rule.method, url: rule.sample, payload: rule.method === 'POST' ? {} : undefined });
      expect(r.status).not.toBe(403);
      expect(r.text).not.toContain(MSG_UNLOCK_AGAIN);
      const other = rule.method === 'GET' ? 'POST' : 'GET';
      if (other === 'POST' || !PUBLIC_RULES.some((x) => x.sample === rule.sample && x.method === other)) {
        const o = await call(c.app, { method: other, url: rule.sample, payload: other === 'POST' ? {} : undefined });
        expect([401, 404, 405]).toContain(o.status);
      }
    }
  });

  it('a garbage, empty or foreign Authorization header is never an identity', async () => {
    for (const h of ['Bearer', 'Bearer ', 'Bearer x', 'Basic YWRtaW46YWRtaW4=', 'Bearer ' + 'A'.repeat(300), 'bearer ../../x', 'Bearer a b']) {
      const r = await call(c.app, { url: '/api/settings', headers: { authorization: h } });
      expect(r.status, h.slice(0, 20)).toBe(401);
    }
    const q = await call(c.app, { url: '/api/settings?token=abc&access_token=abc&authorization=Bearer%20abc' });
    expect(q.status).toBe(401);
  });

  it('HTTP verb tunnelling and path tricks do not reach a protected handler anonymously', async () => {
    const tricks = [
      { method: 'POST', url: '/api/settings/clock', headers: { 'x-http-method-override': 'GET' } },
      { method: 'GET', url: '/API/settings' },
      { method: 'GET', url: '/api/settings/' },
      { method: 'GET', url: '/api//settings' },
      { method: 'GET', url: '/api/./settings' },
      { method: 'GET', url: '/api/x/../settings' },
      { method: 'GET', url: '/api%2fsettings' },
      { method: 'GET', url: '/%61pi/settings' },
      { method: 'GET', url: '/api/settings;.css' },
      { method: 'GET', url: '/api/settings%00.css' },
      { method: 'GET', url: '/api/settings%2e' },
      { method: 'GET', url: '/api\\settings' },
      { method: 'GET', url: '/assets/..%2fapi%2fsettings' },
      { method: 'GET', url: '/islamic/audio/..%2f..%2fapi%2fsettings' },
    ];
    for (const t of tricks) {
      const r = await call(c.app, t);
      expect(r.text, `${t.method} ${t.url}`).not.toContain('"zone"');
      expect([400, 401, 404], `${t.method} ${t.url}`).toContain(r.status);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 2. role matrix
// ---------------------------------------------------------------------------------------------

type Who = {
  name: string;
  headers: Record<string, string>;
  remoteAddress?: string;
  allowed: (p: RoutePermission) => boolean;
  /** When set, decides per table entry (a site is allowed by path, not by permission). */
  allowedRule?: (rule: (typeof ROUTE_PERMISSIONS)[number]) => boolean;
  anonymous?: boolean;
};

describe('2 role matrix: every identity against every table entry', () => {
  let c: Ctx;
  const who: Who[] = [];
  beforeAll(async () => {
    c = make({}, true);
    for (const role of ROLES) {
      const l = await loginAs(c.app, role);
      who.push({
        name: role,
        headers: l.headers,
        allowed: (p) => p === 'public' || p === 'session' || p === 'session_or_site' || (PERMISSIONS[role] as readonly Permission[]).includes(p as Permission),
      });
    }
    for (const roles of [['media', 'treasurer'], ['ajk', 'media']] as Role[][]) {
      const l = await loginAs(c.app, roles);
      who.push({
        name: roles.join('+'),
        headers: l.headers,
        allowed: (p) =>
          p === 'public' || p === 'session' || p === 'session_or_site' || roles.some((r) => (PERMISSIONS[r] as readonly Permission[]).includes(p as Permission)),
      });
    }
    const admin = await loginAsAdmin(c.app);
    const k = await pairKiosk(c.app, admin);
    const kioskAllowed = (p: RoutePermission): boolean => p === 'public' || (KIOSK_PERMISSIONS as readonly string[]).includes(p);
    who.push({ name: 'kiosk-cookie', headers: { cookie: k.cookie }, remoteAddress: '10.168.1.77', allowed: kioskAllowed });
    who.push({ name: 'loopback-kiosk', headers: {}, remoteAddress: '127.0.0.1', allowed: kioskAllowed });
    const site = insertSite(c.app.surau.db);
    who.push({
      name: 'site',
      headers: site.headers,
      remoteAddress: '10.168.1.78',
      allowed: (p) => p === 'public',
      allowedRule: (rule) => rule.permission === 'public' || siteMayCall(rule.method, rule.sample),
    });
    who.push({ name: 'anonymous', headers: {}, allowed: (p) => p === 'public', anonymous: true });
  }, 60_000);
  afterAll(async () => {
    await c.app.close();
  });

  it('each identity gets 403/401 exactly where the core permission table says, and never a 5xx', async () => {
    // logout last so the token it kills is not needed again.
    const rules = [...ROUTE_PERMISSIONS].sort((a, b) => Number(a.sample === '/api/auth/logout') - Number(b.sample === '/api/auth/logout'));
    for (const w of who) {
      for (const rule of rules) {
        const allowed = w.allowedRule ? w.allowedRule(rule) : w.allowed(rule.permission);
        if (allowed && rule.sample === '/api/kiosk/events') continue; // long-lived stream: covered by the SSE probes
        if (allowed && rule.sample === '/api/auth/leave') continue; // revokes the caller's own device: covered by leave.test.ts
        const r = await call(c.app, {
          method: rule.method,
          url: rule.sample,
          headers: w.headers,
          ...(w.remoteAddress ? { remoteAddress: w.remoteAddress } : {}),
          payload: rule.method === 'POST' || rule.method === 'PUT' ? {} : undefined,
        });
        const label = `${w.name} ${rule.method} ${rule.sample}`;
        expect(r.status, label).toBeLessThan(500);
        if (rule.permission === 'public') {
          expect(r.text, label).not.toContain(MSG_UNLOCK_AGAIN);
          expect(r.status, label).not.toBe(403);
        } else if (allowed) {
          expect([401, 403], label).not.toContain(r.status);
        } else {
          expect(r.status, label).toBe(w.anonymous ? 401 : 403);
        }
      }
    }
  }, 120_000);

  it('the kiosk identities can read the display data and nothing else, even by a nearby path', async () => {
    for (const w of who.filter((x) => x.name.includes('kiosk'))) {
      const opts = { headers: w.headers, ...(w.remoteAddress ? { remoteAddress: w.remoteAddress } : {}) };
      expect((await call(c.app, { url: '/api/kiosk/bundle', ...opts })).status).toBe(200);
      expect((await call(c.app, { url: '/api/kiosk/content', ...opts })).status).toBe(200);
      for (const url of ['/api/settings', '/api/content/kuliah', '/api/users', '/api/devices', '/api/audit', '/api/islamic/status', '/api/auth/me']) {
        expect((await call(c.app, { url, ...opts })).status, `${w.name} ${url}`).toBe(403);
      }
      const put = await call(c.app, { method: 'PUT', url: '/api/settings/clock', payload: { show24h: true }, ...opts });
      expect(put.status).toBe(403);
    }
  });

  it('loopback is only a kiosk when plain, unproxied and not cross-site', async () => {
    const base = { url: '/api/kiosk/bundle', remoteAddress: '127.0.0.1' };
    expect((await call(c.app, base)).status).toBe(200);
    for (const h of <Record<string, string>[]>[{ 'x-forwarded-for': '10.168.1.5' }, { forwarded: 'for=1.2.3.4' }, { 'x-real-ip': '1.2.3.4' }, { via: '1.1 proxy' }, { 'x-forwarded-proto': 'https' }, { 'x-forwarded-host': 'evil' }, { 'sec-fetch-site': 'cross-site' }]) {
      const r = await call(c.app, { ...base, headers: h });
      expect(r.status, JSON.stringify(h)).toBe(401);
    }
    // A bad bearer token on loopback is 401, not a silent downgrade to kiosk.
    expect((await call(c.app, { ...base, headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    // Loopback never writes.
    expect((await call(c.app, { method: 'PUT', url: '/api/settings/clock', remoteAddress: '127.0.0.1', payload: {} })).status).toBe(403);
  });

  it('a user token presented as a cookie, or the kiosk cookie presented as a bearer token, grants nothing', async () => {
    const admin = await loginAsAdmin(c.app);
    const token = admin.headers.authorization.slice(7);
    expect((await call(c.app, { url: '/api/settings', headers: { cookie: `surau_kiosk=${token}` } })).status).toBe(401);
    const k = await pairKiosk(c.app, admin);
    const cookieToken = k.cookie.split('=')[1]!;
    expect((await call(c.app, { url: '/api/settings', headers: { authorization: `Bearer ${cookieToken}` } })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. replay
// ---------------------------------------------------------------------------------------------

describe('3 replay: captured credentials stop working', () => {
  it('a captured unlock body resent is refused; the bearer dies on logout; a nonce cannot be moved to another device', async () => {
    const { app } = make();
    const d = await newDevice(app);
    const nonce = await d.challenge();
    const body = await d.body(nonce);
    const first = await d.unlock(body);
    expect(first.status).toBe(200);
    const token = first.json().token as string;
    const replay = await d.unlock(body);
    expect(replay.status).toBe(401);
    expect(replay.text).not.toContain('token');

    const auth = { authorization: `Bearer ${token}` };
    expect((await call(app, { url: '/api/auth/me', headers: auth })).status).toBe(200);
    expect((await call(app, { method: 'POST', url: '/api/auth/logout', headers: auth, payload: {} })).status).toBe(200);
    expect((await call(app, { url: '/api/auth/me', headers: auth })).status).toBe(401);
    expect((await call(app, { url: '/api/settings', headers: auth })).status).toBe(401);

    // Device B asks for a nonce; device A's signature over it must not unlock B (or anything).
    const b = await newDevice(app);
    const nonceB = await b.challenge();
    const swapped = { ...(await d.body(nonceB)), deviceId: b.deviceId };
    expect((await b.unlock(swapped)).status).toBe(401);
  });

  it('a nonce is single use even when the signature was wrong, and expires after 60 s', async () => {
    const c = make();
    const d = await newDevice(c.app);
    const nonce = await d.challenge();
    const bad = { ...(await d.body(nonce)), signature: 'A'.repeat(86) };
    const badRes = await d.unlock(bad);
    expect(badRes.status).toBe(401);
    expect(badRes.json().code, 'the app maps unlock failures by code').toBe('bad_signature');
    const burnt = await d.unlock(await d.body(nonce));
    expect(burnt.status).toBe(401);
    expect(burnt.json().code).toBe('bad_nonce');
    const late = await d.challenge();
    c.clock.t = new Date(c.clock.t.getTime() + 61_000);
    expect((await d.unlock(await d.body(late))).status).toBe(401);
  });

  it('an enrolment code works once; the pairing poll token and code work once', async () => {
    const { app } = make();
    const d = await newDevice(app);
    const again = await call(app, {
      method: 'POST',
      url: '/api/enrol/complete',
      payload: { code: d.code, publicJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }, platform: 'web', pin: TEST_PIN },
    });
    expect([400, 401, 404, 410]).toContain(again.status);

    const admin = await loginAsAdmin(app);
    const k = await pairKiosk(app, admin);
    const poll2 = await call(app, { method: 'POST', url: '/api/kiosk/pair/poll', payload: { pollToken: k.pollToken } });
    expect(poll2.status).toBe(404);
    expect(poll2.headers['set-cookie']).toBeUndefined();
    const approve2 = await call(app, { method: 'POST', url: '/api/kiosk/pair/approve', headers: admin.headers, payload: { code: k.code } });
    expect(approve2.status).toBe(404);
  });

  it('after a device is revoked its bearer, its challenges and the kiosk cookie are dead on the next request', async () => {
    const { app } = make();
    const admin = await loginAsAdmin(app);
    const victim = await loginAs(app, 'media');
    expect((await call(app, { url: '/api/auth/me', headers: victim.headers })).status).toBe(200);
    expect((await call(app, { method: 'POST', url: `/api/devices/${victim.deviceId}/revoke`, headers: admin.headers, payload: {} })).status).toBe(200);
    expect((await call(app, { url: '/api/auth/me', headers: victim.headers })).status).toBe(401);
    expect((await call(app, { method: 'POST', url: '/api/auth/challenge', payload: { deviceId: victim.deviceId } })).status).toBe(401);

    const k = await pairKiosk(app, admin);
    const ok = { headers: { cookie: k.cookie }, remoteAddress: '10.168.1.90' };
    expect((await call(app, { url: '/api/kiosk/bundle', ...ok })).status).toBe(200);
    expect((await call(app, { method: 'POST', url: `/api/devices/${k.deviceId}/revoke`, headers: admin.headers, payload: {} })).status).toBe(200);
    expect((await call(app, { url: '/api/kiosk/bundle', ...ok })).status).toBe(401);
    // Deactivating the user kills their bearer tokens too.
    const media = await loginAs(app, 'media');
    expect((await call(app, { method: 'POST', url: `/api/users/${media.userId}/deactivate`, headers: admin.headers, payload: {} })).status).toBe(200);
    expect((await call(app, { url: '/api/auth/me', headers: media.headers })).status).toBe(401);
  });

  it('resetting a PIN ends that user\'s sessions', async () => {
    const { app } = make();
    const admin = await loginAsAdmin(app);
    const media = await loginAs(app, 'media');
    expect((await call(app, { method: 'PUT', url: `/api/users/${media.userId}/pin`, headers: admin.headers, payload: {} })).status).toBe(200);
    expect((await call(app, { url: '/api/auth/me', headers: media.headers })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. lockout and rate limits
// ---------------------------------------------------------------------------------------------

describe('4 lockout, rate limits and parallel guessing', () => {
  it('5 wrong PINs lock the account; the right PIN is then refused; Retry-After is advertised', async () => {
    const { app } = make();
    const d = await newDevice(app);
    for (let i = 0; i < 4; i++) {
      const r = await d.unlock(await d.body(await d.challenge(), '000000'));
      expect([401, 429]).toContain(r.status);
    }
    const fifth = await d.unlock(await d.body(await d.challenge(), '000000'));
    expect(fifth.status).toBe(423);
    expect(Number(fifth.headers['retry-after']), 'Retry-After on the 423').toBeGreaterThan(0);
    // Whatever route is taken, the correct PIN must not unlock now, and the refusal says when to retry.
    const device2 = await newDevice(app, ['ajk']);
    void device2;
    const right = await d.unlock(await d.body(await d.challenge(), TEST_PIN));
    expect([423, 429]).toContain(right.status);
    expect(right.text).not.toContain('token');
    expect(Number(right.headers['retry-after']), `Retry-After on ${right.status}`).toBeGreaterThan(0);
  });

  it('parallel guessing cannot exceed the attempt limit', async () => {
    const { app } = make();
    const d = await newDevice(app);
    const nonces: string[] = [];
    for (let i = 0; i < 5; i++) nonces.push(await d.challenge());
    const bodies = await Promise.all(nonces.map((n) => d.body(n, '111111')));
    const results = await Promise.all(bodies.map((b) => d.unlock(b)));
    expect(results.every((r) => r.status !== 200)).toBe(true);
    const row = app.surau.db.prepare('SELECT pin_fail_count AS n, pin_locked_until AS l FROM users WHERE id = ?').get(d.userId);
    expect(Number(row?.n) <= 5).toBe(true);
    expect(row?.l, 'five parallel misses lock the account').not.toBeNull();
    const ok = await d.unlock(await d.body(await d.challenge(), TEST_PIN));
    expect(ok.status).not.toBe(200);
  });

  it('after an admin PIN reset, newPin needs the device key: no key -> generic 401 and nothing stored; with it -> a session', async () => {
    const { app } = make();
    const admin = await loginAsAdmin(app);
    const d = await newDevice(app, ['ajk']);
    const reset = await call(app, { method: 'PUT', url: `/api/users/${d.userId}/pin`, headers: admin.headers, payload: {} });
    expect(reset.status).toBe(200);
    const stored = () => app.surau.db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(d.userId)?.pin_hash;
    // An attacker without the key: the answer is the ordinary bad-signature 401, no pinRequired hint.
    const nonce1 = await d.challenge();
    const forged = await d.unlock({ deviceId: d.deviceId, nonce: nonce1, signature: 'A'.repeat(86), newPin: '739204' });
    expect(forged.status).toBe(401);
    expect(forged.text).not.toContain('pinRequired');
    expect(stored()).toBeNull();
    // The key holder: a PIN attempt learns pinRequired (409); newPin then signs in.
    const need = await d.unlock(await d.body(await d.challenge(), TEST_PIN));
    expect(need.status).toBe(409);
    expect(need.json().pinRequired).toBe(true);
    const nonce2 = await d.challenge();
    const set = await d.unlock({ deviceId: d.deviceId, nonce: nonce2, signature: await d.sign(nonce2), newPin: '739204' });
    expect(set.status).toBe(200);
    expect(typeof set.json().token).toBe('string');
    expect(String(stored())).toMatch(/^scrypt2\$/);
    expect(set.text).not.toContain('scrypt$');
    expect(set.text).not.toContain('scrypt2$');
  });

  it('only the 5 newest challenges per device stay live, so a guesser cannot stockpile nonces', async () => {
    const { app } = make();
    const d = await newDevice(app);
    const nonces: string[] = [];
    for (let i = 0; i < 9; i++) nonces.push(await d.challenge());
    const live = app.surau.db.prepare('SELECT COUNT(*) AS n FROM challenges WHERE device_id = ?').get(d.deviceId);
    expect(Number(live?.n)).toBeLessThanOrEqual(5);
  });

  it('per-IP limits: challenge/unlock 20 per 5 min, enrolment 5 per 10 min, pairing begin 3 per 10 min; 429 carries Retry-After', async () => {
    const { app } = make();
    const ip = '203.0.113.9';
    let last = 0;
    for (let i = 0; i < 25; i++) {
      const r = await call(app, { method: 'POST', url: '/api/auth/challenge', payload: { deviceId: `d${i}` }, remoteAddress: ip });
      last = r.status;
      if (r.status === 429) {
        expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
        expect(i).toBeLessThanOrEqual(20);
        break;
      }
    }
    expect(last).toBe(429);
    const pair = [];
    for (let i = 0; i < 5; i++) pair.push((await call(app, { method: 'POST', url: '/api/kiosk/pair/begin', remoteAddress: '203.0.113.10' })).status);
    expect(pair.slice(0, 3)).toEqual([200, 200, 200]);
    expect(pair[3]).toBe(429);
    const enrol = [];
    for (let i = 0; i < 7; i++) enrol.push((await call(app, { method: 'POST', url: '/api/enrol/complete', payload: { code: '000000' + i }, remoteAddress: '203.0.113.11' })).status);
    expect(enrol.at(-1)).toBe(429);
  });

  it('pairing codes cannot be brute-forced through approve: 10 tries per user per 5 min', async () => {
    const { app } = make();
    const admin = await loginAsAdmin(app);
    const codes = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await call(app, { method: 'POST', url: '/api/kiosk/pair/approve', headers: admin.headers, payload: { code: String(100000 + i) } })).status);
    }
    expect(codes.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(codes[11]).toBe(429);
  });

  it('a lockout survives closing and reopening the same database', async () => {
    const c = make({}, true);
    const d = await newDevice(c.app);
    for (let i = 0; i < 5; i++) await d.unlock(await d.body(await d.challenge(), '222222'));
    await c.app.close();
    const reopened = buildApp(c.dbPath, { now: () => c.clock.t, dataDir: c.dataDir, staticDir: c.staticDir });
    apps.push(reopened);
    const again = await call(reopened, { method: 'POST', url: '/api/auth/challenge', payload: { deviceId: d.deviceId } });
    expect(again.status).toBe(200);
    const nonce = String(again.json().nonce);
    const r = await call(reopened, { method: 'POST', url: '/api/auth/unlock', payload: await d.body(nonce, TEST_PIN) });
    expect(r.status).toBe(423);
  });

  it('PIN change from a stolen unlocked session is rate limited (guard on the current-PIN check)', async () => {
    const { app } = make();
    const admin = await loginAsAdmin(app);
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await call(app, { method: 'PUT', url: '/api/auth/pin', headers: admin.headers, payload: { currentPin: '000000', newPin: '135790' } })).status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401 || s === 423)).toBe(true);
    expect(statuses[6]).toBe(429);
    const ok = await call(app, { method: 'PUT', url: '/api/auth/pin', headers: admin.headers, payload: { currentPin: TEST_PIN, newPin: '135790' } });
    expect(ok.status).toBe(429);
  });

  it('error messages do not reveal whether a device, nonce, signature or user was the failing part', async () => {
    const { app } = make();
    const d = await newDevice(app);
    const unknown = await call(app, { method: 'POST', url: '/api/auth/challenge', payload: { deviceId: 'nobody' } });
    const revokedAdmin = await loginAsAdmin(app);
    await call(app, { method: 'POST', url: `/api/devices/${d.deviceId}/revoke`, headers: revokedAdmin.headers, payload: {} });
    const revoked = await call(app, { method: 'POST', url: '/api/auth/challenge', payload: { deviceId: d.deviceId } });
    expect(unknown.status).toBe(revoked.status);
    expect(unknown.text).toBe(revoked.text);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. injection
// ---------------------------------------------------------------------------------------------

const EVIL = [
  "'",
  "' OR '1'='1",
  "'; DROP TABLE users; --",
  '";--',
  '../../etc/passwd',
  '..\\..\\windows\\win.ini',
  'a\u0000b',
  '%00',
  '%27%20OR%201=1',
  '{{7*7}}',
  '${7*7}',
  '<script>alert(1)</script>',
  '__proto__',
  'constructor',
  'toString',
  '😀'.repeat(20),
  'A'.repeat(10_240),
];

describe('5 injection: SQL meta-characters, prototype keys and huge numbers', () => {
  let c: Ctx;
  let admin: Login;
  beforeAll(async () => {
    c = make({}, true);
    admin = await loginAsAdmin(c.app);
  });
  afterAll(async () => {
    await c.app.close();
  });

  it('hostile ids, kinds and params in every path position give 4xx never 5xx, no leak, and change no rows', async () => {
    const before = dbState(c.app);
    for (const evil of EVIL) {
      const p = encodeURIComponent(evil);
      const targets: CallOpts[] = [
        { url: `/api/content/${p}` },
        { url: `/api/content/kuliah/${p}` },
        { url: `/api/content/${p}/${p}` },
        { method: 'PUT', url: `/api/content/kuliah/${p}`, payload: {} },
        { method: 'PUT', url: `/api/content/${p}/x`, payload: { a: 1 } },
        { method: 'DELETE', url: `/api/content/kuliah/${p}` },
        { method: 'DELETE', url: `/api/content/${p}/${p}` },
        { method: 'PUT', url: `/api/settings/${p}`, payload: {} },
        { url: `/api/islamic/jobs/${p}` },
        { method: 'PUT', url: `/api/users/${p}/roles`, payload: { roles: ['ajk'] } },
        { method: 'PUT', url: `/api/users/${p}/pin`, payload: {} },
        { method: 'POST', url: `/api/users/${p}/deactivate`, payload: {} },
        { method: 'POST', url: `/api/devices/${p}/revoke`, payload: {} },
        { url: `/assets/${p}` },
        { url: `/islamic/audio/${p}/1/1.mp3` },
        { url: `/islamic/audio/x/${p}/1.mp3` },
        { url: `/islamic/audio/x/1/${p}` },
        { url: `/api/audit?limit=${p}` },
        { url: `/api/kiosk/bundle?x=${p}` },
        { url: `/${p}` },
      ];
      for (const t of targets) {
        const r = await call(c.app, { ...t, headers: admin.headers });
        expect(r.status, `${t.method ?? 'GET'} ${t.url.slice(0, 70)}`).toBeLessThan(500);
        expectNoLeak(r.text, t.url);
      }
    }
    expect(dbState(c.app)).toBe(before);
    const tables = c.app.surau.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
    expect(Number(tables?.n)).toBe(1);
  }, 120_000);

  it('an over-long path parameter is refused in the API error shape without echoing the path', async () => {
    const long = 'A'.repeat(10_240);
    const r = await call(c.app, { method: 'PUT', url: `/api/users/${long}/roles`, headers: admin.headers, payload: { roles: ['ajk'] } });
    expect(r.status).toBe(414);
    expect(r.json()).toEqual({ errors: ['invalid request'] });
    expect(String(r.headers['x-content-type-options'])).toBe('nosniff');
  });

  it('a hostile id that passes validation is stored and read back verbatim through bound parameters', async () => {
    const usersBefore = Number(c.app.surau.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n);
    for (const id of ["x'; DROP TABLE users;--", "' OR '1'='1", 'a%b_c']) {
      const put = await call(c.app, { method: 'PUT', url: `/api/content/penceramah/${encodeURIComponent(id)}`, headers: admin.headers, payload: { name: "Ustaz ' OR 1=1 --" } });
      expect(put.status).toBeLessThan(500);
      if (put.status === 200 || put.status === 201) {
        const get = await call(c.app, { url: `/api/content/penceramah/${encodeURIComponent(id)}`, headers: admin.headers });
        expect(get.status).toBe(200);
      }
    }
    expect(Number(c.app.surau.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n)).toBe(usersBefore);
  });

  it('JSON prototype keys never pollute Object.prototype or become fields', async () => {
    const bodies = [
      '{"__proto__":{"admin":true,"roles":["admin"]}}',
      '{"constructor":{"prototype":{"admin":true}}}',
      '{"a":{"__proto__":{"polluted":"yes"}}}',
      '{"name":"x","roles":["ajk"],"__proto__":{"roles":["admin"]}}',
      '{"zone":"SGR01","__proto__":{"zone":"SGR02"}}',
    ];
    const routes: [string, string][] = [
      ['PUT', '/api/settings/clock'],
      ['PUT', '/api/settings/zone'],
      ['PUT', '/api/content/kuliah/pp'],
      ['PUT', '/api/content/penceramah/pp'],
      ['POST', '/api/users'],
      ['PUT', `/api/users/${admin.userId}/roles`],
      ['POST', '/api/prayer/import'],
      ['POST', '/api/enrol/begin'],
      ['POST', '/api/kiosk/pair/approve'],
      ['POST', '/api/islamic/fetch'],
      ['PUT', '/api/auth/pin'],
    ];
    for (const [method, url] of routes) {
      for (const raw of bodies) {
        const r = await c.app.inject({ method: method as 'PUT', url, headers: { ...admin.headers, 'content-type': 'application/json' }, remoteAddress: lan(), payload: raw });
        expect(r.statusCode, `${method} ${url} ${raw.slice(0, 30)}`).toBeLessThan(500);
        seen.push({ method, url, status: r.statusCode, text: r.body });
        expectNoLeak(r.body, url);
      }
    }
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).roles).toBeUndefined();
    const roles = await call(c.app, { url: '/api/auth/me', headers: admin.headers });
    expect(roles.json().roles).toEqual(['admin']);
  });

  it('wrong JSON shapes (null, array, string, number, deep nesting, broken JSON) are 400 on every body route', async () => {
    const shapes = ['null', '[]', '"str"', '123', 'true', '{"a":'.repeat(2000) + '1' + '}'.repeat(2000), '{broken', ''];
    const routes: [string, string][] = [
      ['POST', '/api/users'],
      ['PUT', `/api/users/${admin.userId}/roles`],
      ['PUT', '/api/settings/clock'],
      ['PUT', '/api/content/kuliah/zz'],
      ['POST', '/api/prayer/import'],
      ['POST', '/api/enrol/begin'],
      ['POST', '/api/enrol/complete'],
      ['POST', '/api/auth/challenge'],
      ['POST', '/api/auth/unlock'],
      ['POST', '/api/kiosk/pair/poll'],
      ['POST', '/api/kiosk/pair/approve'],
      ['POST', '/api/islamic/fetch'],
      ['PUT', '/api/auth/pin'],
    ];
    for (const [method, url] of routes) {
      for (const raw of shapes) {
        const r = await c.app.inject({ method: method as 'PUT', url, headers: { ...admin.headers, 'content-type': 'application/json' }, remoteAddress: lan(), payload: raw });
        seen.push({ method, url, status: r.statusCode, text: r.body });
        expect(r.statusCode, `${method} ${url} <${raw.slice(0, 20)}>`).toBeLessThan(500);
        // `null` on a settings PUT is an empty patch: a harmless no-op that answers 200 (accepted, see SECURITY-PLAN3 A3).
        if (!(url.startsWith('/api/settings/') && raw === 'null')) {
          expect(r.statusCode, `${method} ${url} <${raw.slice(0, 20)}>`).toBeGreaterThanOrEqual(400);
        }
        expectNoLeak(r.body, url);
      }
    }
  });

  it('huge, negative, fractional and non-finite numbers never crash a route or move state', async () => {
    const before = dbState(c.app);
    // -0 and 1e-400 are the valid integer 0 once parsed, so they legitimately change a setting; they are not in this list.
    const nums = ['1e999', '-1e999', '99999999999999999999999', '0.5', '9007199254740993', '-9007199254740993'];
    for (const n of nums) {
      const bodies: [string, string, string][] = [
        ['POST', '/api/islamic/fetch', `{"what":"audio","surah":${n}}`],
        ['POST', '/api/prayer/import', `{"zone":"SGR01","year":${n},"source":"esolat"}`],
        ['PUT', '/api/settings/hijriDate', `{"adjustDays":${n}}`],
        ['PUT', '/api/settings/tilawah', `{"cacheMaxMb":${n}}`],
        ['PUT', '/api/settings/clock', `{"show24h":${n}}`],
      ];
      for (const [method, url, payload] of bodies) {
        const r = await c.app.inject({ method: method as 'PUT', url, headers: { ...admin.headers, 'content-type': 'application/json' }, remoteAddress: lan(), payload });
        seen.push({ method, url, status: r.statusCode, text: r.body });
        expect(r.statusCode, `${method} ${url} ${n}`).toBeLessThan(500);
      }
      for (const url of [`/api/audit?limit=${n}`, `/api/audit?limit=${n}&limit=${n}`, `/api/islamic/jobs/${n}`]) {
        const r = await call(c.app, { url, headers: admin.headers });
        expect(r.status, url).toBeLessThan(500);
      }
    }
    expect(dbState(c.app)).toBe(before);
  });

  it('query-string tricks: arrays, repeated keys and bracket syntax are harmless', async () => {
    for (const q of ['limit[]=1', 'limit=1&limit=2', 'limit[$ne]=1', '__proto__[x]=1', 'limit=%00', 'limit=%ZZ']) {
      const r = await call(c.app, { url: `/api/audit?${q}`, headers: admin.headers });
      expect(r.status, q).toBeLessThan(500);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 6. path traversal
// ---------------------------------------------------------------------------------------------

describe('6 path traversal on /assets, /islamic/audio and the static handler', () => {
  let c: Ctx;
  let port: number;
  beforeAll(async () => {
    c = make({}, true);
    // A real cached verse so audio routes have something to find, plus decoys outside the roots.
    mkdirSync(join(c.dataDir, 'islamic', 'audio', 'reciter_x', '1'), { recursive: true });
    writeFileSync(join(c.dataDir, 'islamic', 'audio', 'reciter_x', '1', '001.mp3'), Buffer.from('ID3-audio'));
    writeFileSync(join(c.dir, 'outside.txt'), 'OUTSIDE-STATIC-ROOT');
    writeFileSync(join(c.dataDir, 'surau.conf'), 'DATA-DIR-FILE');
    port = await listen(c.app);
  });
  afterAll(async () => {
    await c.app.close();
  });

  const KEY_PATHS = [
    '/data/secret/box.key',
    '/secret/box.key',
    '/../data/secret/box.key',
    '/../../data/secret/box.key',
    '/%2e%2e/data/secret/box.key',
    '/%2e%2e%2fdata%2fsecret%2fbox.key',
    '/..%2fdata%2fsecret%2fbox.key',
    '/%252e%252e/data/secret/box.key',
    '/..%5cdata%5csecret%5cbox.key',
    '/..\\data\\secret\\box.key',
    '/assets/../../data/secret/box.key',
    '/assets/..%2f..%2fdata%2fsecret%2fbox.key',
    '/assets/%2e%2e/%2e%2e/data/secret/box.key',
    '/assets/..%252f..%252fdata%252fsecret%252fbox.key',
    '/assets/....//....//data/secret/box.key',
    '/assets/..%c0%af..%c0%afdata%c0%afsecret%c0%afbox.key',
    '/islamic/audio/../../../../data/secret/box.key',
    '/islamic/audio/..%2f..%2f..%2fsecret%2fbox.key',
    '/islamic/audio/reciter_x/1/..%2f..%2f..%2f..%2f..%2fsecret%2fbox.key',
    '/islamic/audio/reciter_x/..%2f1/001.mp3',
    '/islamic/audio/..%2freciter_x/1/001.mp3',
    '/islamic/audio/reciter_x/1/%2e%2e%2f001.mp3',
    '/islamic/audio/reciter_x/1/001.mp3%00.txt',
    '/islamic/audio/reciter_x/1/001.mp3/../../../../secret/box.key',
    '/assets/' + 'a'.repeat(64) + '/../../../data/secret/box.key',
    '/assets/%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61%61/../../data/secret/box.key',
    '/api/pki/../../data/secret/box.key',
    '/api/../data/secret/box.key',
    '/index.html/../../data/secret/box.key',
    '/sw.js/../../data/secret/box.key',
    '/.env',
    '/.git/config',
    '/outside.txt',
    '/../outside.txt',
    '/%2e%2e/outside.txt',
    '/data/surau.db',
    '/data/surau.db-wal',
    '/../data/surau.conf',
    '/node_modules/fastify/package.json',
    '/package.json',
  ];

  it('no path, encoded or not, reaches box.key, the database or files outside the roots (loopback kiosk and admin)', async () => {
    const admin = await loginAsAdmin(c.app);
    for (const identity of [{}, admin.headers]) {
      for (const path of KEY_PATHS) {
        const r = await rawReq(port, { path, headers: identity as Record<string, string> });
        const label = `${path.slice(0, 90)} -> ${r.status}`;
        expect(r.status, label).not.toBe(500);
        expect(r.body.includes(c.boxKey), label).toBe(false);
        const text = r.body.toString('latin1');
        expect(text, label).not.toContain('OUTSIDE-STATIC-ROOT');
        expect(text, label).not.toContain('DATA-DIR-FILE');
        expect(text, label).not.toContain('SQLite format');
        // Either a refusal, or the harmless SPA shell.
        if (r.status === 200) expect(text, label).toContain('<div id="app">');
      }
    }
  });

  it('percent-encoded dot segments and slashes in asset ids and audio names are refused', async () => {
    for (const path of [
      '/assets/..%2f',
      '/assets/%2e%2e',
      '/assets/' + 'g'.repeat(64),
      '/assets/' + 'A'.repeat(64),
      '/assets/' + 'a'.repeat(63),
      '/assets/' + 'a'.repeat(65),
      '/assets/' + 'a'.repeat(64) + '.png',
      '/islamic/audio/reciter_x/1/001.mp3',
      '/islamic/audio/reciter_x/01/001.mp3',
      '/islamic/audio/reciter_x/1/1.mp3',
      '/islamic/audio/reciter_x/1/0001.mp3',
      '/islamic/audio/reciter_x/1/001.MP3',
      '/islamic/audio/reciter_x/1/001.mp3/',
      '/islamic/audio/reciter x/1/001.mp3',
    ]) {
      const r = await rawReq(port, { path });
      expect(r.status, path).toBeLessThan(500);
      if (path === '/islamic/audio/reciter_x/1/001.mp3') {
        expect(r.status).toBe(200);
        expect(r.body.toString()).toBe('ID3-audio');
      } else if (!path.endsWith('1.mp3') || path.includes('01/') || path.includes('0001')) {
        expect([200, 400, 404], path).toContain(r.status);
        if (r.status === 200) expect(r.body.toString('latin1')).toContain('<div id="app">');
      }
    }
  });

  it('range requests on audio cannot read past the file or crash on hostile ranges', async () => {
    for (const range of ['bytes=0-', 'bytes=-5', 'bytes=999-', 'bytes=5-2', 'bytes=-', 'bytes=0-0,5-9', 'bytes=a-b', 'bytes=' + '9'.repeat(40) + '-', 'items=0-1', 'bytes=0-99999999999999999999999']) {
      const r = await rawReq(port, { path: '/islamic/audio/reciter_x/1/001.mp3', headers: { Range: range } });
      expect(r.status, range).toBeLessThan(500);
      expect(r.body.length).toBeLessThanOrEqual('ID3-audio'.length);
    }
  });

  it('the SPA fallback never serves a file for a path that looks like a file, nor the index for /api', async () => {
    const f = await rawReq(port, { path: '/nonexistent.js' });
    expect(f.status).toBe(404);
    const api = await rawReq(port, { path: '/api/nope' });
    expect([401, 403, 404]).toContain(api.status);
    expect(api.body.toString()).not.toContain('<div id="app">');
  });
});

// ---------------------------------------------------------------------------------------------
// 7. error leakage
// ---------------------------------------------------------------------------------------------

describe('7 error bodies carry no stack, SQL text or path', () => {
  it('an internal failure answers {"errors":["internal error"]} and logs the detail server-side only', async () => {
    const { app } = make();
    const admin = await loginAsAdmin(app);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    app.surau.db.exec('DROP TABLE content_items');
    const r = await call(app, { url: '/api/content/kuliah', headers: admin.headers });
    expect(r.status).toBe(500);
    expect(r.json()).toEqual({ errors: ['internal error'] });
    expect(r.text).not.toMatch(LEAK);
    expect(r.text).not.toMatch(/content_items|no such table/i);
    const logged = log.mock.calls.flat().map(String).join('\n');
    expect(logged).toMatch(/no such table/i);
    expect(logged).not.toContain(TEST_PIN);
    log.mockRestore();
  });

  it('client errors from the framework (bad JSON, wrong media type, oversized, bad encoding) leak nothing', async () => {
    const { app } = make();
    const admin = await loginAsAdmin(app);
    const cases: [string, Record<string, string>, string | Buffer][] = [
      ['/api/settings/clock', { 'content-type': 'application/json' }, '{"a":'],
      ['/api/settings/clock', { 'content-type': 'text/plain' }, 'hello'],
      ['/api/settings/clock', { 'content-type': 'application/xml' }, '<a/>'],
      ['/api/settings/clock', { 'content-type': 'application/json; charset=utf-16' }, 'x'],
      ['/api/settings/clock', { 'content-type': 'application/json' }, Buffer.from([0xff, 0xfe, 0x00])],
      ['/api/assets', { 'content-type': 'image/png' }, 'not a png'],
      ['/api/assets', { 'content-type': 'text/html' }, '<script>'],
      ['/api/assets', {}, 'nothing'],
    ];
    for (const [url, headers, payload] of cases) {
      const r = await call(app, { method: 'PUT', url, headers: { ...admin.headers, ...headers }, payload: payload as string });
      expect(r.status, url + JSON.stringify(headers)).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expectNoLeak(r.text, url);
      const p = await call(app, { method: 'POST', url, headers: { ...admin.headers, ...headers }, payload: payload as string });
      expect(p.status).toBeLessThan(500);
      expectNoLeak(p.text, url);
    }
    const badUri = await rawReq(await listen(app), { path: '/api/%E0%A4%A', headers: admin.headers });
    expect(badUri.status).toBeLessThan(500);
    expectNoLeak(badUri.body.toString(), '/api/%E0%A4%A');
  });

  it('every response from every route for every identity, scanned so far, is free of stack/SQL/path text', () => {
    const bad = seen.filter((s) => s.status >= 400 && LEAK.test(strip(s)));
    expect(bad.map((b) => `${b.method} ${b.url.slice(0, 60)} ${b.status}`)).toEqual([]);
  });

  function strip(s: { url: string; text: string }): string {
    let t = s.text;
    for (const b of [s.url, safeDecode(s.url), ...safeDecode(s.url).split(/[/?&=]/).filter((x) => x.length >= 2)].sort((a, c) => c.length - a.length)) {
      t = t.split(b).join('').split(JSON.stringify(b).slice(1, -1)).join('');
    }
    return t;
  }
});

// ---------------------------------------------------------------------------------------------
// 8. headers
// ---------------------------------------------------------------------------------------------

describe('8 response headers', () => {
  let c: Ctx;
  let admin: Login;
  beforeAll(async () => {
    c = make({}, true);
    admin = await loginAsAdmin(c.app);
  });
  afterAll(async () => {
    await c.app.close();
  });

  const API_GETS = ['/api/health', '/api/settings', '/api/kiosk/bundle', '/api/kiosk/content', '/api/users', '/api/devices', '/api/audit', '/api/auth/me', '/api/content/kuliah', '/api/islamic/status', '/api/pki/root.cer', '/api/nope'];

  it('every /api response (including errors and denials) is no-store + nosniff + no-referrer, with no Server / X-Powered-By / CORS headers', async () => {
    const reqs: CallOpts[] = [
      ...API_GETS.flatMap((url) => [{ url, headers: admin.headers }, { url }]),
      { method: 'POST', url: '/api/auth/unlock', payload: {} },
      { method: 'PUT', url: '/api/settings/clock', headers: admin.headers, payload: { show24h: 'x' } },
      { method: 'DELETE', url: '/api/content/kuliah/none', headers: admin.headers },
      { method: 'OPTIONS', url: '/api/settings', headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' } },
    ];
    for (const r of reqs) {
      const res = await call(c.app, r);
      const label = `${r.method ?? 'GET'} ${r.url} -> ${res.status}`;
      expect(String(res.headers['cache-control']), label).toContain('no-store');
      expect(res.headers['x-content-type-options'], label).toBe('nosniff');
      expect(res.headers['referrer-policy'], label).toBe('no-referrer');
      expect(res.headers['server'], label).toBeUndefined();
      expect(res.headers['x-powered-by'], label).toBeUndefined();
      for (const h of Object.keys(res.headers)) expect(h, label).not.toMatch(/^access-control-/);
    }
    // A cross-origin request carries no permissive header either.
    const cors = await call(c.app, { url: '/api/health', headers: { origin: 'https://evil.example' } });
    expect(cors.headers['access-control-allow-origin']).toBeUndefined();
  });

  const CSP_REQUIRED = ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'", "connect-src 'self'", "worker-src 'self'"];

  it('the kiosk page and its files carry a CSP, nosniff, no-referrer and no framing', async () => {
    for (const url of ['/', '/index.html', '/sw.js', '/assets/app.js', '/some/spa/route']) {
      const res = await call(c.app, { url });
      expect(res.status, url).toBe(200);
      const csp = String(res.headers['content-security-policy']);
      for (const d of CSP_REQUIRED) expect(csp, `${url} ${d}`).toContain(d);
      expect(csp).toContain("img-src 'self' data: blob:");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      // The one network source beyond 'self' is the loopback port of the Windows host-exit helper, and only the kiosk
      // page document itself gets it; its scripts, the service worker and everything else keep connect-src 'self'.
      expect(csp.replace('http://127.0.0.1:*', '')).not.toMatch(/unsafe-eval|\*|http:|https:/);
      const kioskDocument = !url.includes('.js');
      expect(csp, url).toContain(kioskDocument ? "connect-src 'self' http://127.0.0.1:*;" : "connect-src 'self';");
      expect(csp, 'script-src must not allow inline script').not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(String(res.headers['x-frame-options']).toUpperCase()).toBe('DENY');
    }
    // API answers and a kiosk preview keep the narrow rule / the loopback rule respectively
    const api = String((await call(c.app, { url: '/api/health' })).headers['content-security-policy']);
    expect(api).toContain("connect-src 'self';");
    expect(api).not.toContain('127.0.0.1');
    const preview = String((await call(c.app, { url: '/?preview=1' })).headers['content-security-policy']);
    expect(preview).toContain("connect-src 'self' http://127.0.0.1:*;");
    expect(preview).toContain("frame-ancestors 'self'");
  });

  it('the built kiosk page is compatible with that CSP: no inline script, no inline handlers, no off-origin loads', () => {
    let html: string;
    try {
      html = readFileSync(join(KIOSK_DIST, 'index.html'), 'utf8');
    } catch {
      return; // kiosk not built in this checkout
    }
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    for (const s of scripts) {
      expect(s[1], 'script must have a same-origin src').toMatch(/\bsrc="\/[^"]*"/);
      expect(s[2]!.trim(), 'no inline script body').toBe('');
    }
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//i);
    expect(html).not.toMatch(/<base\b|<iframe\b|<object\b|<embed\b|<form\b/i);
    const sw = readFileSync(join(KIOSK_DIST, 'sw.js'), 'utf8');
    expect(sw).not.toMatch(/https?:\/\//);
    expect(sw).not.toMatch(/\beval\s*\(|new Function\(/);
    // Fonts and images in the stylesheet are same-origin files, not remote URLs.
    const css = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
    if (css) {
      const text = readFileSync(join(KIOSK_DIST, css), 'utf8');
      for (const m of text.matchAll(/url\(\s*["']?([^)"']+)/g)) expect(m[1], m[1]).toMatch(/^(?:\/|\.\/|\.\.\/|data:)/);
      expect(text).not.toMatch(/@import\s+(?:url\()?["']?https?:/);
    }
  });

  it('the event stream carries the same headers (it bypasses the normal send path)', async () => {
    const port = await listen(c.app);
    const head = await new Promise<string>((resolve, reject) => {
      const sock = netConnect({ host: '127.0.0.1', port }, () => sock.write('GET /api/kiosk/events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'));
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString('latin1');
        if (buf.includes('\r\n\r\n')) {
          sock.destroy();
          resolve(buf.split('\r\n\r\n')[0]!);
        }
      });
      sock.on('error', reject);
    });
    expect(head).toMatch(/200/);
    expect(head.toLowerCase()).toContain('x-content-type-options: nosniff');
    expect(head.toLowerCase()).toContain('referrer-policy: no-referrer');
    expect(head.toLowerCase()).toMatch(/cache-control: no-(?:store|cache)/);
  });

  it('assets keep their content type under nosniff, and the store never serves HTML/SVG as an asset', async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from('00000001000000010806000000', 'hex'), Buffer.alloc(40)]);
    const up = await c.app.inject({ method: 'POST', url: '/api/assets', headers: { ...admin.headers, 'content-type': 'image/png' }, remoteAddress: lan(), payload: png });
    if (up.statusCode === 201 || up.statusCode === 200) {
      const id = up.json().id as string;
      const got = await call(c.app, { url: `/assets/${id}`, headers: admin.headers });
      expect(got.headers['x-content-type-options']).toBe('nosniff');
      expect(String(got.headers['content-type'])).toMatch(/^image\//);
    }
    for (const type of ['text/html', 'image/svg+xml', 'application/javascript']) {
      const r = await c.app.inject({ method: 'POST', url: '/api/assets', headers: { ...admin.headers, 'content-type': type }, remoteAddress: lan(), payload: '<svg onload=alert(1)/>' });
      expect(r.statusCode, type).toBeGreaterThanOrEqual(400);
      expect(r.statusCode, type).toBeLessThan(500);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 10 and 8b. TLS (placed before the secrets scan so its traffic is scanned too)
// ---------------------------------------------------------------------------------------------

describe('10 TLS: protocol floor, ciphers, certificate, HSTS, no plain HTTP on the LAN', () => {
  async function startTls(): Promise<{ l: Listeners; tls: TlsMaterial; port: number }> {
    const tls = fixtureTls();
    const l = await startListeners({
      dbPath: join(tempDir(), 'tls.db'),
      staticDir: null,
      tls,
      plan: { http: { host: '127.0.0.1', port: 0 }, https: { host: '127.0.0.1', port: 0 }, warnings: [] },
      env: {},
    });
    listeners.push(l);
    return { l, tls, port: l.httpsPort ?? 0 };
  }

  const handshake = (port: number, o: Record<string, unknown>): Promise<{ protocol: string | null; cipher: string; san: string }> =>
    new Promise((resolve, reject) => {
      const s = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false, ...o }, () => {
        const out = { protocol: s.getProtocol(), cipher: s.getCipher().name, san: s.getPeerCertificate().subjectaltname ?? '' };
        s.destroy();
        resolve(out);
      });
      s.on('error', reject);
    });

  it('TLS 1.2 and 1.3 only; SSLv3/TLS1.0/TLS1.1 are refused; the certificate has the IP SAN', async () => {
    const { port } = await startTls();
    const best = await handshake(port, {});
    expect(['TLSv1.2', 'TLSv1.3']).toContain(best.protocol);
    expect(best.san).toContain('IP Address:127.0.0.1');
    for (const v of ['TLSv1', 'TLSv1.1'] as const) {
      await expect(handshake(port, { minVersion: v, maxVersion: v, ciphers: 'ALL:@SECLEVEL=0' }), v).rejects.toBeDefined();
    }
    const tls12 = await handshake(port, { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' });
    expect(tls12.protocol).toBe('TLSv1.2');
  });

  it('only forward-secret AEAD suites are negotiable (ECDHE + GCM/ChaCha, or TLS 1.3)', async () => {
    const { port } = await startTls();
    const seenCiphers = new Set<string>();
    for (const ciphers of ['ECDHE-RSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES256-GCM-SHA384', 'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-CHACHA20-POLY1305']) {
      try {
        seenCiphers.add((await handshake(port, { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers })).cipher);
      } catch {
        /* this key type may not suit this suite */
      }
    }
    expect(seenCiphers.size).toBeGreaterThan(0);
    for (const weak of ['ECDHE-ECDSA-AES128-SHA', 'ECDHE-ECDSA-AES256-SHA', 'ECDHE-ECDSA-AES128-SHA256', 'ECDHE-ECDSA-AES256-SHA384', 'AES128-SHA', 'AES256-SHA', 'AES128-SHA256', 'AES256-GCM-SHA384', 'AES128-GCM-SHA256', 'ECDHE-RSA-AES128-SHA', 'ECDHE-RSA-AES256-SHA', 'ECDHE-RSA-AES128-SHA256', 'ECDHE-RSA-AES256-SHA384', 'DHE-RSA-AES128-GCM-SHA256', 'DES-CBC3-SHA', 'RC4-SHA']) {
      await expect(handshake(port, { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers: `${weak}:@SECLEVEL=0` }), weak).rejects.toBeDefined();
    }
    const chosen = (await handshake(port, {})).cipher;
    expect(chosen).toMatch(/^(?:TLS_|ECDHE-)/);
  });

  it('HTTPS responses carry HSTS and the kiosk cookie is Secure; plain loopback HTTP does not claim HSTS', async () => {
    const { l, port } = await startTls();
    const https = await rawReq(port, { path: '/api/health', tls: true });
    expect(https.status).toBe(200);
    expect(https.headers['strict-transport-security']).toMatch(/max-age=\d{6,}/);
    expect(https.headers['x-content-type-options']).toBe('nosniff');
    const http = await rawReq(l.httpPort, { path: '/api/health' });
    expect(http.headers['strict-transport-security']).toBeUndefined();
    // Anonymous over HTTPS stays anonymous (an encrypted loopback connection is not "the local kiosk").
    const bundle = await rawReq(port, { path: '/api/kiosk/bundle', tls: true });
    expect(bundle.status).toBe(401);
    const local = await rawReq(l.httpPort, { path: '/api/kiosk/bundle' });
    expect(local.status).toBe(200);
  });

  it('there is no plain-HTTP listener on any non-loopback address, and no switch to add one', { timeout: 60_000 }, async () => {
    const { l } = await startTls();
    const lanIps = Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i!.address);
    for (const ip of lanIps) {
      await expect(
        new Promise((resolve, reject) => {
          const s = netConnect({ host: ip, port: l.httpPort, timeout: 3000 }, () => {
            s.destroy();
            resolve('connected');
          });
          s.on('error', reject);
          s.on('timeout', () => reject(new Error('timeout')));
        }),
        `plain HTTP reachable on ${ip}`,
      ).rejects.toBeDefined();
    }
    expect(planListeners({ SURAU_HTTP_LAN: '1', SURAU_HOST: '0.0.0.0', SURAU_ALLOW_LAN: '1' }, fixtureTls()).http.host).toBe('127.0.0.1');
  });

  it('the Host allowlist holds on HTTPS and HTTP, including look-alike and smuggled host values', async () => {
    const { l, port } = await startTls();
    const good = ['127.0.0.1', '127.0.0.1:8443', 'localhost', 'LOCALHOST:80', '[::1]', '[::1]:8443'];
    for (const h of good) expect((await rawReq(l.httpPort, { path: '/api/health', host: h })).status, h).toBe(200);
    const bad = [
      'evil.example',
      '127.0.0.1.evil.example',
      'localhost.evil.example',
      'evil.example:127.0.0.1',
      '127.0.0.1@evil.example',
      '127.0.0.1:80@evil.example',
      'evil.example#127.0.0.1',
      'evil.example/127.0.0.1',
      '127.0.0.1 evil.example',
      '127.0.0.1,evil.example',
      '127.0.0.1:abc',
      '127.0.0.1:',
      '',
      '0x7f.1',
      '2130706433',
      '127.1',
      '[::ffff:127.0.0.1]',
      '[::1',
      'LOCALHOST.',
      'localhost%00.evil.example',
    ];
    for (const h of bad) {
      for (const [p, tls] of [[l.httpPort, false], [port, true]] as const) {
        const r = await rawReq(p, { path: '/api/health', host: h, tls });
        expect(r.status, `Host: ${JSON.stringify(h)} tls=${tls}`).toBe(421);
        expect(r.body.toString()).toContain('host not allowed');
      }
    }
    // Forwarded-host headers do not stand in for the real Host.
    const fwd = await rawReq(l.httpPort, { path: '/api/health', host: 'evil.example', headers: { 'X-Forwarded-Host': '127.0.0.1' } });
    expect(fwd.status).toBe(421);
    // With two Host headers Node keeps the first, so a hostile first value is refused (and a hostile second cannot win).
    const dup = await rawReq(l.httpPort, { path: '/api/health', host: 'evil.example', headers: { Host: '127.0.0.1' } });
    expect(dup.status).toBe(421);
    // HTTP/1.1 without any Host header.
    const none = await rawReq(l.httpPort, { path: '/api/health', host: null });
    expect(none.status).toBeGreaterThanOrEqual(400);
    // An absolute-form request line to a foreign authority still needs an allowed Host.
    const abs = await rawReq(l.httpPort, { path: 'http://evil.example/api/health', host: 'evil.example' });
    expect(abs.status).toBe(421);
  });
});

// ---------------------------------------------------------------------------------------------
// 11. clock jumps
// ---------------------------------------------------------------------------------------------

describe('11 clock jumps: sessions and codes behave when the box clock steps +/- hours', () => {
  const HOUR = 3_600_000;
  it('a session expires on absolute time (12 h) and idle time (2 h); stepping the clock back does not revive or extend it', async () => {
    const c = make();
    const a = await loginAsAdmin(c.app);
    const at = (ms: number): Date => new Date(AT.getTime() + ms);
    const me = () => call(c.app, { url: '/api/auth/me', headers: a.headers });

    expect((await me()).status).toBe(200);
    c.clock.t = at(HOUR);
    expect((await me()).status).toBe(200);
    // Clock jumps back a day: the session was created "in the future" -> refused, not extended.
    c.clock.t = at(-24 * HOUR);
    expect((await me()).status, 'session created in the future').toBe(401);
    // Jumping forward again does not bring it back to life beyond its idle limit.
    c.clock.t = at(HOUR + 3 * HOUR);
    expect((await me()).status, 'idle > 2h').toBe(401);

    const b = await loginAsAdmin(c.app); // created at 'now' = AT+4h
    c.clock.t = at(4 * HOUR + 11 * HOUR + 59 * 60_000);
    // keep it alive past the idle limit by touching it every hour
    for (let h = 1; h <= 11; h++) {
      c.clock.t = at(4 * HOUR + h * HOUR);
      expect((await call(c.app, { url: '/api/auth/me', headers: b.headers })).status, `h${h}`).toBe(200);
    }
    c.clock.t = at(4 * HOUR + 12 * HOUR + 1000);
    expect((await call(c.app, { url: '/api/auth/me', headers: b.headers })).status, 'absolute 12h').toBe(401);
  });

  it('a backwards step does not push last_used_at back, so idle time cannot be gamed', async () => {
    const c = make();
    const a = await loginAsAdmin(c.app);
    c.clock.t = new Date(AT.getTime() + HOUR);
    await call(c.app, { url: '/api/auth/me', headers: a.headers });
    const row = c.app.surau.db.prepare('SELECT last_used_at AS t FROM sessions LIMIT 1').get();
    c.clock.t = new Date(AT.getTime() + 30 * 60_000); // 30 min after login, but before the last touch
    await call(c.app, { url: '/api/auth/me', headers: a.headers });
    const row2 = c.app.surau.db.prepare('SELECT last_used_at AS t FROM sessions LIMIT 1').get();
    expect(String(row2?.t) >= String(row?.t)).toBe(true);
  });

  it('a pairing code expires after 10 minutes; a forward jump of hours kills it; approve and poll agree', async () => {
    const c = make();
    const admin = await loginAsAdmin(c.app);
    const begin = await call(c.app, { method: 'POST', url: '/api/kiosk/pair/begin' });
    const { code, pollToken } = begin.json();
    c.clock.t = new Date(AT.getTime() + 11 * 60_000);
    expect((await call(c.app, { method: 'POST', url: '/api/kiosk/pair/approve', headers: admin.headers, payload: { code } })).status).toBe(404);
    expect((await call(c.app, { method: 'POST', url: '/api/kiosk/pair/poll', payload: { pollToken } })).status).toBe(404);

    const b2 = await call(c.app, { method: 'POST', url: '/api/kiosk/pair/begin' });
    c.clock.t = new Date(c.clock.t.getTime() + 5 * HOUR);
    const later = await loginAsAdmin(c.app); // the first admin session idled out during the jump
    expect((await call(c.app, { method: 'POST', url: '/api/kiosk/pair/approve', headers: later.headers, payload: { code: b2.json().code } })).status).toBe(404);
    expect((await call(c.app, { method: 'POST', url: '/api/kiosk/pair/poll', payload: { pollToken: b2.json().pollToken } })).status).toBe(404);
  });

  it('an enrolment code and a pairing cookie keep their own absolute expiry across a jump; a revoked cookie stays dead after any jump', async () => {
    const c = make();
    const admin = await loginAsAdmin(c.app);
    const k = await pairKiosk(c.app, admin);
    const ok = { headers: { cookie: k.cookie }, remoteAddress: '10.168.1.91' };
    c.clock.t = new Date(AT.getTime() + 24 * HOUR);
    expect((await call(c.app, { url: '/api/kiosk/bundle', ...ok })).status).toBe(200);
    c.clock.t = new Date(AT.getTime() - 24 * HOUR);
    expect((await call(c.app, { url: '/api/kiosk/bundle', ...ok })).status).toBe(200); // cookie valid either way, by design (10 years)
    c.clock.t = AT;
    const rev = await call(c.app, { method: 'POST', url: `/api/devices/${k.deviceId}/revoke`, headers: admin.headers, payload: {} });
    expect(rev.status).toBe(200);
    for (const d of [-48, 0, 48]) {
      c.clock.t = new Date(AT.getTime() + d * HOUR);
      expect((await call(c.app, { url: '/api/kiosk/bundle', ...ok })).status, `jump ${d}h`).toBe(401);
    }
  });

  it('challenge nonces issued before a forward jump are dead after it; an unlock with a stale nonce never creates a session', async () => {
    const c = make();
    const d = await newDevice(c.app);
    const nonce = await d.challenge();
    c.clock.t = new Date(AT.getTime() + 2 * HOUR);
    const r = await d.unlock(await d.body(nonce));
    expect(r.status).toBe(401);
    expect(Number(c.app.surau.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE device_id = ?').get(d.deviceId)?.n)).toBe(0);
  });

  it('a lockout is measured in absolute time: stepping the clock back does not shorten it', async () => {
    const c = make();
    const d = await newDevice(c.app);
    for (let i = 0; i < 5; i++) await d.unlock(await d.body(await d.challenge(), '333333'));
    const until = String(c.app.surau.db.prepare('SELECT pin_locked_until AS t FROM users WHERE id = ?').get(d.userId)?.t);
    expect(Date.parse(until)).toBeGreaterThan(AT.getTime());
    c.clock.t = new Date(AT.getTime() - 5 * HOUR);
    const r = await d.unlock(await d.body(await d.challenge(), TEST_PIN));
    expect([423, 429]).toContain(r.status);
  });
});

// ---------------------------------------------------------------------------------------------
// 12. body limits and slow connections
// ---------------------------------------------------------------------------------------------

describe('12 body limits and slow / oversized requests', () => {
  it('3 MB JSON is 413 (JSON limit 2 MB); 25 MB asset is 413 (asset limit 20 MB); both refuse without storing anything', async () => {
    const c = make({}, true);
    const admin = await loginAsAdmin(c.app);
    const before = dbState(c.app);
    const big = JSON.stringify({ label: 'x'.repeat(3 * 1024 * 1024) });
    const json = await call(c.app, { method: 'PUT', url: '/api/content/kuliah/x', headers: { ...admin.headers, 'content-type': 'application/json' }, payload: big });
    expect(json.status).toBe(413);
    expectNoLeak(json.text, '/api/content/kuliah/x');
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(25 * 1024 * 1024)]);
    const asset = await call(c.app, { method: 'POST', url: '/api/assets', headers: { ...admin.headers, 'content-type': 'image/png' }, payload: png });
    expect(asset.status).toBe(413);
    // The other JSON routes and unauthenticated ones are bound by the 2 MB cap too.
    for (const url of ['/api/auth/unlock', '/api/enrol/complete', '/api/kiosk/pair/poll']) {
      const r = await call(c.app, { method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: big });
      expect([401, 413], url).toContain(r.status);
    }
    expect(dbState(c.app)).toBe(before);
    await c.app.close();
  }, 60_000);

  it('a chunked body with no Content-Length is still cut at the limit', async () => {
    const c = make({}, true);
    const admin = await loginAsAdmin(c.app);
    const port = await listen(c.app);
    const status = await new Promise<number>((resolve, reject) => {
      const s = netConnect({ host: '127.0.0.1', port });
      let got = '';
      s.on('connect', () => {
        s.write(
          `PUT /api/content/kuliah/x HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: ${admin.headers.authorization}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`,
        );
        const chunk = Buffer.alloc(256 * 1024, 0x61);
        let sent = 0;
        const pump = (): void => {
          if (s.destroyed || sent > 6 * 1024 * 1024) return;
          s.write(`${chunk.length.toString(16)}\r\n`);
          s.write(chunk);
          s.write('\r\n');
          sent += chunk.length;
          setImmediate(pump);
        };
        pump();
      });
      s.on('data', (d) => {
        got += d.toString('latin1');
        const m = /^HTTP\/1\.1 (\d{3})/.exec(got);
        if (m) {
          s.destroy();
          resolve(Number(m[1]));
        }
      });
      s.on('error', () => resolve(got ? Number(/^HTTP\/1\.1 (\d{3})/.exec(got)?.[1]) : 0));
      s.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(got)?.[1] ?? 0)));
    });
    expect([413, 0]).toContain(status);
    await c.app.close();
  }, 30_000);

  it('server time limits are set on both listeners (headers 10 s, request 30 s, idle 60 s)', async () => {
    const tls = fixtureTls();
    const l = await startListeners({
      dbPath: join(tempDir(), 'lim.db'),
      staticDir: null,
      tls,
      plan: { http: { host: '127.0.0.1', port: 0 }, https: { host: '127.0.0.1', port: 0 }, warnings: [] },
      env: {},
    });
    listeners.push(l);
    expect(l.app.server.headersTimeout).toBeLessThanOrEqual(10_000);
    expect(l.app.server.headersTimeout).toBeGreaterThan(0);
    expect(l.app.server.requestTimeout).toBeLessThanOrEqual(30_000);
    expect(l.app.server.requestTimeout).toBeGreaterThan(0);
    expect(l.app.server.timeout).toBeLessThanOrEqual(60_000);
    expect(l.app.server.timeout).toBeGreaterThan(0);
  });

  it('a slow-loris client that never finishes its headers is cut off on HTTP and on HTTPS', async () => {
    const tls = fixtureTls();
    const l = await startListeners({
      dbPath: join(tempDir(), 'slow.db'),
      staticDir: null,
      tls,
      plan: { http: { host: '127.0.0.1', port: 0 }, https: { host: '127.0.0.1', port: 0 }, warnings: [] },
      env: {},
    });
    listeners.push(l);
    const loris = (port: number, secure: boolean): Promise<number> =>
      new Promise((resolve) => {
        const started = Date.now();
        const s = secure ? tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }) : netConnect({ host: '127.0.0.1', port });
        const drip = (): void => {
          if (s.destroyed) return;
          s.write('X-Slow: 1\r\n');
          setTimeout(drip, 1000);
        };
        s.on(secure ? 'secureConnect' : 'connect', () => {
          s.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n');
          drip();
        });
        const done = (): void => resolve(Date.now() - started);
        s.on('close', done);
        s.on('error', () => undefined);
      });
    const [plain, secure] = await Promise.all([loris(l.httpPort, false), loris(l.httpsPort ?? 0, true)]);
    expect(plain, 'plain HTTP slow-loris closed after (ms)').toBeLessThan(25_000);
    expect(secure, 'HTTPS slow-loris closed after (ms)').toBeLessThan(25_000);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// SSE slot exhaustion
// ---------------------------------------------------------------------------------------------

describe('13 event-stream slots: one client cannot starve the display', () => {
  it('a single address is capped well below the global cap; closing a stream frees its slot; other addresses still get in', async () => {
    const c = make({ heartbeatMs: 60_000 }, true);
    const port = await listen(c.app);
    const open = (): Promise<{ status: number; close: () => void }> =>
      new Promise((resolve, reject) => {
        const s = netConnect({ host: '127.0.0.1', port }, () => s.write('GET /api/kiosk/events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'));
        let buf = '';
        s.on('data', (d) => {
          buf += d.toString('latin1');
          const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
          if (m) resolve({ status: Number(m[1]), close: () => s.destroy() });
        });
        s.on('error', reject);
      });
    const opened: { status: number; close: () => void }[] = [];
    for (let i = 0; i < 12; i++) opened.push(await open());
    const ok = opened.filter((o) => o.status === 200).length;
    expect(ok, 'streams one address may hold').toBeGreaterThanOrEqual(2);
    expect(ok, 'streams one address may hold').toBeLessThanOrEqual(8);
    expect(opened.some((o) => o.status === 429 || o.status === 503)).toBe(true);
    // Free one slot and reconnect.
    opened.find((o) => o.status === 200)!.close();
    await new Promise((r) => setTimeout(r, 200));
    const again = await open();
    expect(again.status).toBe(200);
    again.close();
    // A different client address is not locked out by the first one.
    const other = c.app.inject({ method: 'GET', url: '/api/health', remoteAddress: '10.168.1.200' });
    expect((await other).statusCode).toBe(200);
    for (const o of opened) o.close();
    await c.app.close();
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// 9. secrets in output (last: it scans everything captured above plus a fresh full scenario)
// ---------------------------------------------------------------------------------------------

describe('9 secrets never appear in any response, log or audit output', () => {
  it('PINs, session tokens, nonces, codes, hashes, the cookie token and key material are absent from responses, change_log, auth_log and logs', async () => {
    const logSpies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        consoleLines.push(a.map(String).join(' '));
      }),
    );
    const tls = fixtureTls();
    const c = make({ tls });
    const secrets = new Map<string, string>();
    const PIN2 = '905173';

    const admin = await loginAsAdmin(c.app);
    secrets.set('admin PIN', TEST_PIN);
    secrets.set('admin session token', admin.token);
    const media = await newDevice(c.app, ['media'], PIN2);
    secrets.set('media PIN', PIN2);
    secrets.set('enrolment code', media.code);
    const wrongNonce = await media.challenge();
    secrets.set('nonce', wrongNonce);
    const wrong = await media.body(wrongNonce, '000111');
    secrets.set('wrong PIN', '000111');
    secrets.set('signature', wrong.signature);
    await media.unlock(wrong);
    const goodNonce = await media.challenge();
    secrets.set('nonce 2', goodNonce);
    const sess = await media.unlock(await media.body(goodNonce));
    secrets.set('media session token', String(sess.json().token));
    const k = await pairKiosk(c.app, admin);
    secrets.set('pair code', k.code);
    secrets.set('poll token', k.pollToken);
    secrets.set('kiosk cookie token', k.cookie.split('=')[1]!);
    const changed = await call(c.app, { method: 'PUT', url: '/api/auth/pin', headers: admin.headers, payload: { currentPin: TEST_PIN, newPin: '864209' } });
    expect(changed.status).toBe(200);
    secrets.set('new PIN', '864209');
    await call(c.app, { method: 'POST', url: '/api/enrol/begin', headers: admin.headers, payload: { userId: media.userId, deviceName: 'Tablet' } });
    await call(c.app, { method: 'POST', url: `/api/devices/${k.deviceId}/revoke`, headers: admin.headers, payload: {} });

    // Every read endpoint an operator can open.
    const outputs: string[] = [];
    for (const url of ['/api/users', '/api/devices', '/api/audit?limit=1000', '/api/health', '/api/settings', '/api/auth/me', '/api/content/penceramah', '/api/islamic/status', '/api/kiosk/bundle', '/api/kiosk/content']) {
      const r = await call(c.app, { url, headers: admin.headers });
      outputs.push(`${url}\n${r.text}\n${JSON.stringify(r.headers)}`);
    }
    const db = c.app.surau.db;
    for (const t of ['change_log', 'auth_log', 'meta', 'settings']) {
      outputs.push(`${t}\n${JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())}`);
    }
    const outText = outputs.join('\n');
    for (const [name, value] of secrets) {
      expect(outText.includes(value), `${name} found in an output surface`).toBe(false);
    }

    // Field names and formats that mean "secret material".
    expect(outText).not.toMatch(/pin_hash|pinHash|token_hash|tokenHash|code_hash|codeHash|poll_token|pollToken|cookie_hash|public_jwk\b.*"d"|scrypt2?\$|BEGIN (?:RSA |EC )?PRIVATE KEY|passphrase|pfx\.pass/i);
    expect(outText).not.toContain(c.boxKey.toString('hex'));
    expect(outText).not.toContain(c.boxKey.toString('base64'));
    // The audit page tells who changed a PIN, never to what.
    const audit = (await call(c.app, { url: '/api/audit?limit=1000', headers: admin.headers })).json();
    expect(JSON.stringify(audit)).toContain('pinChanged');

    // Whatever any probe in this file received: no secret from this scenario leaks into a later,
    // unrelated response (the only places a value may appear are the response that issues it).
    const issuing = new Set(['/api/auth/unlock', '/api/kiosk/pair/begin', '/api/kiosk/pair/poll', '/api/enrol/begin', '/api/auth/challenge']);
    for (const s of seen) {
      if (issuing.has(s.url.split('?')[0]!)) continue;
      for (const [name, value] of secrets) {
        if (name.includes('PIN')) continue; // 6-digit values can occur in unrelated numbers; checked on the surfaces above
        expect(s.text.includes(value), `${name} echoed by ${s.method} ${s.url.slice(0, 60)} (${s.status})`).toBe(false);
      }
      expect(s.text, `${s.method} ${s.url.slice(0, 60)}`).not.toMatch(/pin_hash|token_hash|code_hash|scrypt2?\$|passphrase/i);
    }

    // Logs captured during the whole file, including the HTTPS passphrase (made unmistakable here).
    const logText = consoleLines.join('\n');
    for (const [name, value] of secrets) expect(logText.includes(value), `${name} in console output`).toBe(false);
    expect(logText).not.toContain(TEST_PIN);
    expect(tls.passphrase).toBe('test');
    expect(outText).not.toMatch(/"passphrase"|"pfx"/);
    for (const s of logSpies) s.mockRestore();
  }, 60_000);
});
