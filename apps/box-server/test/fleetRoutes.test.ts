/**
 * Plan 14 Task 10 (adjusted by decisions 19-27): the fleet routes of the ops app. SECURITY scope: these tests were
 * written first, by a different author than the implementation. Brief: maxcom-work/briefs/p14-t10.md.
 *
 * Assumptions for the implementer (every choice below is mine where the brief is silent; change the test, not the
 * contract, only after saying so):
 *  1. Routes (new module `src/surau/routes.ts`; table rows in `src/auth/authz.ts`, all `tenant: 'none'` and `ops: true`):
 *       GET  /api/suraus                         fleet:read    -> 200 `{ suraus: [SurauDetail...] }`
 *       GET  /api/suraus/:id                     fleet:read    -> 200 `{ surau: SurauDetail }`; unknown or malformed id 404 `surau_not_found`
 *       GET  /api/fleet/pending                  fleet:read    -> 200 `{ pending: [{ boxId, name, at, boxName?, platform?, version? }] }`
 *       POST /api/fleet/pending/:boxId/approve   fleet:manage  -> 200 `{ surauId, created }`
 *       POST /api/suraus/:id/suspend             fleet:manage  body `{ reason }` -> 200 `{ surau }`
 *       POST /api/suraus/:id/unsuspend           fleet:manage  -> 200 `{ surau }`
 *       POST /api/fleet/boxes/:boxId/revoke      fleet:manage  -> 200 `{ revoked: true }`
 *       POST /api/fleet/boxes/:boxId/unrevoke    fleet:manage  -> 200 `{ surauId }`
 *       PUT  /api/suraus/:id/storage-limit       fleet:manage  body `{ bytes }` -> 200 `{ surau }`
 *     `SurauDetail` is exactly what `getSurau` returns (id, name, status, suspendedAt, suspendedReason,
 *     storageLimitBytes, storageUsedBytes, boxes[{ boxId, name, role, lastSeenAt, revoked }]).
 *  2. Pending = every Worker registration (read with the cloud's Worker admin settings) whose box has no site row,
 *     live or revoked (so a box held by the daily cap and a box that has not claimed yet are both listed; a linked
 *     or revoked box is not). Each carries `heldByCap`: true when the daily cap would hold it now (no approval
 *     waiting for it and today's automatic suraus at the cap), false otherwise (controller ruling 5). The
 *     answer never carries a claim hash (no 64-hex string at all), the admin token, or a control/format character
 *     in any text.
 *  3. Approve: the same function and rules as `cloud-approve` (`approveSite`). Body `{ newSurau: true }` (the new
 *     surau is named from the registration) or `{ surauId }`; none -> 400 `surau_required`, both or a wrong type ->
 *     400 `bad_args`; unknown surauId 404 `surau_not_found`; box not registered at the Worker 404 `not_registered`;
 *     malformed box id 400 or 404 (never 200/500); `surau_has_box`, `foreign_surau`, `linked` -> 409. Worker down or
 *     refusing -> 502 `worker_unreachable` with no detail (no status text, no URL, no token), nothing written.
 *  4. Revoke/unrevoke: unknown or malformed box id 404 `not_found`; revoking a revoked box 409 `not_linked`;
 *     unrevoking a live box 409 `not_revoked`. Suspend: `reason` required, control/format-only text counts as empty,
 *     more than 200 characters is REFUSED (400 `bad_args`, not truncated). Storage limit: `bytes` a positive safe
 *     integer, anything else 400 `bad_args`; unknown surau 404 `surau_not_found`; below what the surau already holds
 *     400 `limit_below_use` (controller ruling 4, enforced in `setStorageLimit`, so the CLI refuses it too).
 *  5. Errors are `{ errors: [text], code }` (the existing shape). The hook answers 403 for a role without the
 *     permission and, before that, for a session that is not an ops device (decision: `ops` rows).
 *  6. A superadmin or support user on a PUBLIC device is refused 403 and an `auth_log` row is written with
 *     `event = 'ops_device_required'` (or `detail = 'ops_device_required'`), `ok = 0`, that user and device ids. A
 *     support user on an ops device calling a `fleet:manage` row is a plain 403 (no `ops_device_required` row).
 *  7. Every successful mutating call writes ONE `auth_log` row, `ok = 1`, `user_id` / `device_id` of the caller, and a
 *     `detail` that contains the target id(s): events `fleet_approve` (box id and surau id), `fleet_suspend`,
 *     `fleet_unsuspend` (surau id), `fleet_revoke`, `fleet_unrevoke` (box id), `fleet_storage_limit` (surau id).
 *     The reason text is not required in the row.
 *  8. Rate limits (counted per caller, refused calls count too, windows on the app's injected clock): every GET row
 *     answers 429 + `Retry-After` at or before the 121st call in a minute; every mutating row at or before the 31st
 *     call in the window. Another caller is unaffected. The general 600 a minute limit is not what these see.
 *  9. `/api/auth/me` gains `surau: { id, name }` and `scope`. An ops session: `scope: 'all'`, `surau` is the acting
 *     surau (the `X-Maxcom-Surau` header). Every other session (surau role, superadmin on a public device, box):
 *     `scope: 'surau'`, `surau` its own surau.
 * 10. On a box (`role: 'box'`) every fleet path answers 404 to a signed-in caller of any role (so the ops check must
 *     not turn that into a 403 there: the generated role matrix in authz.test.ts expects `fleet:*` roles on a box
 *     to get past the hook). Anonymous is 401 as for every listed row.
 * 11. No route creates, grants, removes or appoints superadmin/support (decisions 19-20): no such path is
 *     registered, and no fleet body can change `users.roles_json`, `users.active`, devices or enrolments.
 */
import { randomBytes, createHash, webcrypto } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@surau/core';
import type { Role } from '@surau/core';
import { beginEnrolment } from '../src/auth/devices.ts';
import { getUserRow, createUser } from '../src/auth/users.ts';
import { sha256hex } from '../src/auth/crypto.ts';
import { buildApp } from '../src/app.ts';
import { createSurau, getSurau } from '../src/surau/registry.ts';
import { generateSyncKeyPair } from '../src/sync/syncKey.ts';
import { SURAU_HEADER } from '../src/tenant.ts';
import { TEST_PIN, loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { buildCloud } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  delete process.env.MAXCOM_AUTO_SURAU_DAILY_CAP;
});

const CLOUD_BOX = '0c10ad000000000c';
const START = Date.parse('2026-11-13T08:00:00.000Z');
const ADMIN_TOKEN = 'test-admin-token';
const LAN = '10.168.1.60';
const NO_SURAU = 'zzzzzzzzzzzz';
const NO_BOX = 'ffffffffffffffff';
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

// ---------------------------------------------------------------------------------------------------------------
// rig: a cloud role app wired to a fake Worker

interface Rig {
  cloud: TestCloud;
  app: FastifyInstance;
  db: DatabaseSync;
  worker: FakeWorker;
  clock: number;
}
interface Box {
  boxId: string;
  claim: string;
  publicJwk: unknown;
}

function rig(): Rig {
  const state = { clock: START } as Rig;
  const viaWorker = ((i: Parameters<typeof fetch>[0], n?: RequestInit) => state.worker.fetch(i, n)) as typeof fetch;
  const cloud = buildCloud(CLOUD_BOX, {
    workerAdmin: { url: 'https://worker.test', token: ADMIN_TOKEN, fetchImpl: viaWorker },
    workerOutbox: { auto: false },
    now: () => new Date(state.clock),
  });
  state.cloud = cloud;
  state.app = cloud.app;
  state.db = cloud.app.surau.db;
  state.worker = new FakeWorker(cloud.fetch, () => state.clock);
  cleanups.push(() => cloud.close());
  return state;
}

let boxN = 0;
function newBox(): Box {
  boxN += 1;
  return { boxId: `a${String(boxN).padStart(15, '0')}`, claim: randomBytes(32).toString('hex'), publicJwk: generateSyncKeyPair().publicJwk };
}
function register(r: Rig, b: Box, name = 'Surau Al-Hidayah', extra: Record<string, unknown> = {}): void {
  r.worker.regs.set(b.boxId, { claimHash: sha256hex(b.claim), name, at: new Date(r.clock).toISOString(), ...extra } as never);
}
let ipN = 0;
function claim(r: Rig, b: Box) {
  ipN += 1;
  return r.app.inject({
    method: 'POST',
    url: '/api/sync/claim',
    remoteAddress: `10.9.${(ipN >> 8) & 255}.${ipN & 255}`,
    payload: { boxId: b.boxId, claim: b.claim, publicJwk: b.publicJwk },
  });
}
const snapshot = (r: Rig, token: string) => r.app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: { authorization: `Bearer ${token}` } });

/** A box registers and claims by itself: the surau it got. */
async function autoLink(r: Rig, name = 'Surau Al-Hidayah'): Promise<{ box: Box; surauId: string; siteToken: string }> {
  const box = newBox();
  register(r, box, name);
  const res = await claim(r, box);
  expect(res.statusCode, res.body).toBe(200);
  const j = res.json() as { surauId: string; siteToken: string };
  await settle();
  return { box, surauId: j.surauId, siteToken: j.siteToken };
}

const ops = (r: Rig): Promise<Login> => loginAs(r.app, ['superadmin', 'admin']);
const support = (r: Rig): Promise<Login> => loginAs(r.app, 'support');
async function surauAdmin(r: Rig, surauId: string): Promise<Login> {
  return loginAs(r.app, 'admin', TEST_PIN, surauId);
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
function call(r: Rig, who: Login | null, method: Method, url: string, payload?: unknown) {
  return r.app.inject({
    method,
    url,
    ...(who === null ? { remoteAddress: LAN } : { headers: who.headers }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const count = (db: DatabaseSync, sql: string, ...p: string[]): number => Number((db.prepare(sql).get(...p) as { n: number }).n);
const surauCount = (db: DatabaseSync): number => count(db, 'SELECT COUNT(*) AS n FROM suraus');
const approvals = (db: DatabaseSync): number => count(db, 'SELECT COUNT(*) AS n FROM site_approvals');
const autoCreates = (db: DatabaseSync): number => count(db, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'surau_auto_create'");
const siteOf = (db: DatabaseSync, boxId: string): Record<string, unknown> | undefined => db.prepare('SELECT * FROM sites WHERE box_id = ?').get(boxId);
const authRows = (db: DatabaseSync, event: string): Record<string, unknown>[] => db.prepare('SELECT * FROM auth_log WHERE event = ? ORDER BY id').all(event);
const opsDeviceRefusals = (db: DatabaseSync, userId: string): number =>
  count(db, "SELECT COUNT(*) AS n FROM auth_log WHERE (event = 'ops_device_required' OR detail = 'ops_device_required') AND user_id = ? AND ok = 0", userId);

/** Everything a fleet call could touch, as one comparable string. */
function world(db: DatabaseSync): string {
  return JSON.stringify([
    db.prepare('SELECT * FROM suraus ORDER BY id').all(),
    db.prepare('SELECT * FROM sites ORDER BY box_id').all(),
    db.prepare('SELECT * FROM site_approvals ORDER BY box_id').all(),
    // (implementer) the sign-ins a test makes after its snapshot write users/devices change rows; people() covers those
    db.prepare("SELECT id, surau_id, entity, entity_id FROM change_log WHERE entity NOT IN ('users', 'devices') ORDER BY id").all(),
  ]);
}
/** Users, devices and enrolments: what a role grant would touch. */
function people(db: DatabaseSync): string {
  return JSON.stringify([
    db.prepare('SELECT id, roles_json, active, surau_id FROM users ORDER BY id').all(),
    db.prepare('SELECT id, user_id, ops, revoked_at FROM devices ORDER BY id').all(),
    db.prepare('SELECT COUNT(*) AS n FROM enrolments').get(),
  ]);
}

// ---------------------------------------------------------------------------------------------------------------
// public devices of ops-role users (copied from the ops device tests: the helper there is file-local)

let counter = 0;
const addr = (): string => {
  counter += 1;
  return `10.8.${(counter >> 8) & 255}.${(counter & 255) || 1}`;
};
const setRolesSql = (db: DatabaseSync, userId: string, roles: Role[]): void => {
  db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(roles), userId);
};

/** A PUBLIC device of a user who holds the ops role(s): the code is issued while the user is ordinary. */
async function publicDevice(r: Rig, roles: Role[]): Promise<Login> {
  const { db, boxId } = r.app.surau;
  const plain = roles.filter((x) => x !== 'superadmin' && x !== 'support');
  const u = createUser(db, { name: `Awam ${++counter}`, roles: plain.length > 0 ? plain : ['ajk'] }, 'test', 'sdm');
  const { code } = beginEnrolment(db, { userId: u.id, deviceName: 'Telefon awam' }, 'test', { canManageSuperadmin: true });
  setRolesSql(db, u.id, roles);
  db.prepare("UPDATE users SET surau_id = '*', no = NULL, no_src = NULL WHERE id = ?").run(u.id);
  const keys = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  // the code was issued before the roles changed: an ordinary code, an ordinary (public) device
  const enrol = await r.app.inject({ method: 'POST', url: '/api/enrol/complete', remoteAddress: addr(), payload: { code, publicJwk, platform: 'web', pin: TEST_PIN } });
  if (enrol.statusCode !== 200) throw new Error(`enrol failed: ${enrol.statusCode} ${enrol.body}`);
  const deviceId = String(enrol.json().deviceId);
  const remoteAddress = addr();
  const ch = await r.app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress, payload: { deviceId } });
  const nonce = String(ch.json().nonce);
  const message = new TextEncoder().encode(`surau-unlock\n${boxId}\n${deviceId}\n${nonce}`);
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, message);
  const un = await r.app.inject({
    method: 'POST',
    url: '/api/auth/unlock',
    remoteAddress,
    payload: { deviceId, nonce, signature: Buffer.from(sig).toString('base64url'), pin: TEST_PIN },
  });
  if (un.statusCode !== 200) throw new Error(`unlock failed: ${un.statusCode} ${un.body}`);
  const token = String(un.json().token);
  expect(getUserRow(db, u.id)!.roles.some((x) => x === 'superadmin' || x === 'support') === roles.some((x) => x === 'superadmin' || x === 'support')).toBe(true);
  return {
    token,
    userId: u.id,
    deviceId,
    roles,
    headers: { authorization: `Bearer ${token}` },
    baseVersion: 0,
    relogin: async () => token,
    sign: async () => '',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// the rows

interface Row {
  label: string;
  method: Method;
  url: (s: string, b: string) => string;
  permission: 'fleet:read' | 'fleet:manage';
  /** A body the handler refuses without writing anything (for the denial and rate-limit walks). */
  harmless?: unknown;
}
const ROWS: readonly Row[] = [
  { label: 'list', method: 'GET', url: () => '/api/suraus', permission: 'fleet:read' },
  { label: 'detail', method: 'GET', url: (s) => `/api/suraus/${s}`, permission: 'fleet:read' },
  { label: 'pending', method: 'GET', url: () => '/api/fleet/pending', permission: 'fleet:read' },
  { label: 'approve', method: 'POST', url: (_s, b) => `/api/fleet/pending/${b}/approve`, permission: 'fleet:manage', harmless: {} },
  { label: 'reject', method: 'POST', url: (_s, b) => `/api/fleet/pending/${b}/reject`, permission: 'fleet:manage', harmless: {} },
  { label: 'suspend', method: 'POST', url: (s) => `/api/suraus/${s}/suspend`, permission: 'fleet:manage', harmless: {} },
  { label: 'unsuspend', method: 'POST', url: (s) => `/api/suraus/${s}/unsuspend`, permission: 'fleet:manage', harmless: {} },
  { label: 'revoke', method: 'POST', url: (_s, b) => `/api/fleet/boxes/${b}/revoke`, permission: 'fleet:manage', harmless: {} },
  { label: 'unrevoke', method: 'POST', url: (_s, b) => `/api/fleet/boxes/${b}/unrevoke`, permission: 'fleet:manage', harmless: {} },
  { label: 'storage-limit', method: 'PUT', url: (s) => `/api/suraus/${s}/storage-limit`, permission: 'fleet:manage', harmless: { bytes: 0 } },
  { label: 'delete', method: 'DELETE', url: (s) => `/api/fleet/suraus/${s}`, permission: 'fleet:manage', harmless: {} },
];

// ---------------------------------------------------------------------------------------------------------------

describe('who may call the fleet routes', () => {
  it('an ops-device superadmin gets past the hook on every row; support only on the fleet:read rows', async () => {
    const r = rig();
    const sa = await ops(r);
    const sp = await support(r);
    const before = world(r.db);
    for (const row of ROWS) {
      const url = row.url(NO_SURAU, NO_BOX);
      const a = await call(r, sa, row.method, url, row.harmless);
      expect([401, 403], `${row.label} as ops superadmin: ${a.body}`).not.toContain(a.statusCode);
      expect(a.statusCode, `${row.label} as ops superadmin`).toBeLessThan(500);
      const s = await call(r, sp, row.method, url, row.harmless);
      if (row.permission === 'fleet:read') expect([401, 403], `${row.label} as support: ${s.body}`).not.toContain(s.statusCode);
      else expect(s.statusCode, `${row.label} as support`).toBe(403);
    }
    expect(world(r.db), 'refusals and unknown ids wrote nothing').toBe(before);
    // support on an ops device lacking the permission is a plain 403: not the "public device" refusal
    expect(opsDeviceRefusals(r.db, sp.userId)).toBe(0);
  });

  it('a superadmin and a support user on a PUBLIC device get 403 on every row, each with an ops_device_required row', async () => {
    const r = rig();
    const target = createSurau(r.db, { name: 'Sasaran' }, 'test');
    for (const roles of [['superadmin', 'admin'], ['superadmin'], ['support']] as Role[][]) {
      const dev = await publicDevice(r, roles);
      const before = world(r.db);
      let seen = opsDeviceRefusals(r.db, dev.userId);
      for (const row of ROWS) {
        // a valid-looking body too: the refusal must come before the handler looks at it
        const body = row.method === 'GET' ? undefined : row.label === 'storage-limit' ? { bytes: 1000 } : row.label === 'suspend' ? { reason: 'x' } : row.label === 'approve' ? { newSurau: true } : {};
        const res = await call(r, dev, row.method, row.url(target.id, NO_BOX), body);
        expect(res.statusCode, `${roles.join('+')} public ${row.label}: ${res.body}`).toBe(403);
        const now = opsDeviceRefusals(r.db, dev.userId);
        expect(now, `${roles.join('+')} public ${row.label}: auth_log ops_device_required`).toBeGreaterThan(seen);
        seen = now;
      }
      const row = authRows(r.db, 'ops_device_required').filter((x) => x.user_id === dev.userId).at(-1);
      expect(row?.device_id, 'the row names the device').toBe(dev.deviceId);
      expect(world(r.db)).toBe(before);
    }
  });

  it('a surau admin (and every other surau role) gets 403 on every row, in its own surau and about another', async () => {
    const r = rig();
    const a = await autoLink(r, 'Surau A');
    const b = createSurau(r.db, { name: 'Surau B' }, 'test');
    const before = world(r.db);
    for (const role of ['admin', 'treasurer', 'media', 'ajk'] as Role[]) {
      const who = await loginAs(r.app, role, TEST_PIN, a.surauId);
      for (const row of ROWS) {
        for (const sid of [a.surauId, b.id]) {
          const res = await call(r, who, row.method, row.url(sid, a.box.boxId), row.method === 'GET' ? undefined : { newSurau: true, reason: 'x', bytes: 1000 });
          expect(res.statusCode, `${role} ${row.label} ${sid}: ${res.body}`).toBe(403);
        }
      }
    }
    expect(world(r.db)).toBe(before);
  });

  it('anonymous (not the local kiosk) is 401 on every row', async () => {
    const r = rig();
    const before = world(r.db);
    for (const row of ROWS) {
      const res = await call(r, null, row.method, row.url(NO_SURAU, NO_BOX), row.method === 'GET' ? undefined : {});
      expect(res.statusCode, row.label).toBe(401);
    }
    expect(world(r.db)).toBe(before);
  });

  it('a box (role box) answers 404 to every signed-in caller on every fleet path, and writes nothing', async () => {
    const dir = (await import('node:fs')).mkdtempSync(join((await import('node:os')).tmpdir(), 'surau-fleet-box-'));
    const app = buildApp(join(dir, 'box.db'), { dataDir: dir, role: 'box' });
    cleanups.push(async () => {
      await app.close().catch(() => undefined);
      (await import('node:fs')).rmSync(dir, { recursive: true, force: true });
    });
    const logins = [];
    for (const roles of [['superadmin', 'admin'], ['admin'], ['support']] as Role[][]) logins.push({ roles, who: await loginAs(app, roles) });
    const snap = (): string => JSON.stringify([app.surau.db.prepare('SELECT * FROM suraus').all(), app.surau.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity IN ('surau', 'site')").get()]);
    const before = snap();
    for (const { roles, who } of logins) {
      for (const row of ROWS) {
        const res = await app.inject({
          method: row.method,
          url: row.url(NO_SURAU, NO_BOX),
          headers: who.headers,
          ...(row.method === 'GET' ? {} : { payload: { newSurau: true, reason: 'x', bytes: 1000 } }),
        });
        // (implementer) a role without the permission is the hook's 403 on a box too (the generated role matrix in
        // authz.test.ts expects it); a role holding it is never turned into a 403 by the ops check: the router's 404
        const allowed = roles.some((x) => (PERMISSIONS[x] as readonly string[]).includes(row.permission));
        expect(res.statusCode, `box ${roles.join('+')} ${row.label}: ${res.body}`).toBe(allowed ? 404 : 403);
      }
    }
    expect(snap()).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('GET /api/suraus, /api/suraus/:id', () => {
  it('lists every surau with its boxes, status and storage; support may read; no secret is in the answer', async () => {
    const r = rig();
    const a = await autoLink(r, 'Surau A');
    const waiting = createSurau(r.db, { name: 'Surau Menunggu' }, 'test');
    const sa = await ops(r);
    const sp = await support(r);
    for (const who of [sa, sp]) {
      const res = await call(r, who, 'GET', '/api/suraus');
      expect(res.statusCode, res.body).toBe(200);
      const list = (res.json() as { suraus: { id: string; name: string; status: string; storageLimitBytes: number; storageUsedBytes: number; boxes: { boxId: string; revoked: boolean }[] }[] }).suraus;
      const sa1 = list.find((s) => s.id === a.surauId)!;
      expect(sa1.name).toBe('Surau A');
      expect(sa1.status).toBe('Aktif');
      expect(sa1.boxes.map((b) => b.boxId)).toEqual([a.box.boxId]);
      expect(sa1.boxes[0]!.revoked).toBe(false);
      expect(typeof sa1.storageUsedBytes).toBe('number');
      expect(sa1.storageLimitBytes).toBe(2 * 1024 ** 3);
      const w = list.find((s) => s.id === waiting.id)!;
      expect(w.status).toBe('Menunggu MAXCOM');
      expect(w.boxes).toEqual([]);
      const text = res.body;
      for (const secret of [a.siteToken, sha256hex(a.siteToken), 'token_hash', 'public_jwk', ADMIN_TOKEN, JSON.stringify((a.box.publicJwk as { x: string }).x).slice(1, -1)]) {
        expect(text.includes(secret), `no ${secret.slice(0, 12)}`).toBe(false);
      }
    }
  });

  it('detail: one surau with its boxes; unknown or malformed id 404 surau_not_found', async () => {
    const r = rig();
    const a = await autoLink(r, 'Surau A');
    const sa = await ops(r);
    const ok = await call(r, sa, 'GET', `/api/suraus/${a.surauId}`);
    expect(ok.statusCode, ok.body).toBe(200);
    const s = (ok.json() as { surau: { id: string; boxes: { boxId: string; name: string; role: string }[]; status: string } }).surau;
    expect(s.id).toBe(a.surauId);
    expect(s.boxes[0]).toMatchObject({ boxId: a.box.boxId, role: 'primary' });
    expect(ok.body.includes(a.siteToken)).toBe(false);
    for (const id of [NO_SURAU, 'NOT-AN-ID', 'a'.repeat(60)]) {
      const res = await call(r, sa, 'GET', `/api/suraus/${id}`);
      expect(res.statusCode, id).toBe(404);
      expect(res.json().code).toBe('surau_not_found');
    }
    // (implementer) a NUL in the path is the hook's default deny (403); an id past the router's parameter limit is 414
    expect((await call(r, sa, 'GET', '/api/suraus/%00')).statusCode).toBe(403);
    expect((await call(r, sa, 'GET', `/api/suraus/${'a'.repeat(300)}`)).statusCode).toBe(414);
  });

  it('shows a revoked box as revoked and a suspended surau as Digantung', async () => {
    const r = rig();
    const a = await autoLink(r);
    const sa = await ops(r);
    expect((await call(r, sa, 'POST', `/api/fleet/boxes/${a.box.boxId}/revoke`, {})).statusCode).toBe(200);
    expect((await call(r, sa, 'POST', `/api/suraus/${a.surauId}/suspend`, { reason: 'Ujian' })).statusCode).toBe(200);
    const s = ((await call(r, sa, 'GET', `/api/suraus/${a.surauId}`)).json() as { surau: { status: string; suspendedReason: string; boxes: { revoked: boolean }[] } }).surau;
    expect(s.status).toBe('Digantung');
    expect(s.suspendedReason).toBe('Ujian');
    expect(s.boxes[0]!.revoked).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('GET /api/fleet/pending', () => {
  it('lists the boxes held by the daily cap and boxes not yet claimed, sanitised; not a linked box; never a claim hash or the token', async () => {
    process.env.MAXCOM_AUTO_SURAU_DAILY_CAP = '1';
    const r = rig();
    const linked = await autoLink(r, 'Sudah Terpaut');
    const held = newBox();
    register(r, held, 'Surau‮ Tertahan\u0000', { boxName: 'Kotak​ Satu', platform: 'android', version: '2026.11.6' });
    const capped = await claim(r, held);
    expect(capped.statusCode).not.toBe(200);
    expect(capped.json().code).toBe('pending');
    const quiet = newBox();
    register(r, quiet, 'Belum Menuntut', { platform: 'linux' });
    // a box that has not linked within the grace period is held by something other than the cap; before it, it is only about to link
    r.clock += 11 * 60_000;
    const sa = await ops(r);
    const sp = await support(r);

    for (const who of [sa, sp]) {
      const res = await call(r, who, 'GET', '/api/fleet/pending');
      expect(res.statusCode, res.body).toBe(200);
      const list = (res.json() as { pending: { boxId: string; name: string; boxName?: string; platform?: string; version?: string; at: string }[] }).pending;
      expect(list.map((p) => p.boxId).sort()).toEqual([held.boxId, quiet.boxId].sort());
      const h = list.find((p) => p.boxId === held.boxId)!;
      expect(h.name).toBe('Surau Tertahan');
      expect(h).toMatchObject({ boxName: 'Kotak Satu', platform: 'android', version: '2026.11.6' });
      expect(list.find((p) => p.boxId === quiet.boxId)!.platform).toBe('linux');
      expect(res.body.includes(linked.box.boxId)).toBe(false);
      expect(/[0-9a-f]{64}/.test(res.body), 'no claim hash').toBe(false);
      expect(/[\u0000-\u0008‮​]/.test(res.body), 'no control or format characters').toBe(false);
      expect(res.body.includes(ADMIN_TOKEN)).toBe(false);
    }
  });

  it('heldByCap: true only while the daily cap holds a box with no approval; an approved box waiting its claim and a box under the cap are false; a revoked box is not listed', async () => {
    const r = rig();
    let sa = await ops(r);
    const pending = async () => {
      const res = await call(r, sa, 'GET', '/api/fleet/pending');
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { pending: { boxId: string; heldByCap: boolean }[] }).pending;
    };
    // under the cap (default 20): a registered box that has not claimed is waiting, not held
    const early = newBox();
    register(r, early, 'Belum Menuntut');
    // just registered, under the cap: it is about to link by itself, so it is not pending
    expect((await pending()).find((p) => p.boxId === early.boxId)).toBeUndefined();
    r.clock += 11 * 60_000;
    sa = await ops(r);
    expect((await pending()).find((p) => p.boxId === early.boxId)).toMatchObject({ heldByCap: false, held: 'other' });

    // cap reached: a new box is held; a box approved by MAXCOM is not; a revoked box is not pending at all
    process.env.MAXCOM_AUTO_SURAU_DAILY_CAP = '1';
    const revoked = await autoLink(r, 'Dibatalkan');
    expect((await call(r, sa, 'POST', `/api/fleet/boxes/${revoked.box.boxId}/revoke`, {})).statusCode).toBe(200);
    register(r, revoked.box, 'Dibatalkan');
    const held = newBox();
    register(r, held, 'Tertahan');
    expect((await claim(r, held)).json().code).toBe('pending');
    const approved = newBox();
    register(r, approved, 'Diluluskan');
    expect((await call(r, sa, 'POST', `/api/fleet/pending/${approved.boxId}/approve`, { newSurau: true })).statusCode).toBe(200);
    const list = await pending();
    expect(list.map((p) => p.boxId).sort()).toEqual([early.boxId, held.boxId].sort());
    expect(list.find((p) => p.boxId === held.boxId)).toMatchObject({ heldByCap: true, held: 'daily_cap' });
    expect(list.find((p) => p.boxId === early.boxId)).toMatchObject({ heldByCap: true, held: 'daily_cap' });
    // approved by MAXCOM and still waiting for its box: listed only once it is past the grace period
    expect(list.find((p) => p.boxId === approved.boxId)).toBeUndefined();
    r.clock += 11 * 60_000;
    sa = await ops(r);
    expect((await pending()).find((p) => p.boxId === approved.boxId)).toMatchObject({ heldByCap: false, held: 'other' });

    // the next UTC day the cap no longer holds anyone (and registrations unseen for a day are stale: not listed at all)
    r.clock += 24 * 3_600_000;
    sa = await ops(r);
    expect((await pending()).every((p) => !p.heldByCap)).toBe(true);
  });

  it('an empty Worker lists nothing; an unreachable or refusing Worker is 502 worker_unreachable with no detail', async () => {
    const r = rig();
    const sa = await ops(r);
    const none = await call(r, sa, 'GET', '/api/fleet/pending');
    expect(none.statusCode).toBe(200);
    expect((none.json() as { pending: unknown[] }).pending).toEqual([]);
    for (const fault of ['down', 'http500', 'http401'] as const) {
      r.worker.adminDown = fault === 'down';
      r.worker.adminStatus = fault === 'http500' ? 500 : fault === 'http401' ? 401 : null;
      const res = await call(r, sa, 'GET', '/api/fleet/pending');
      expect(res.statusCode, fault).toBe(502);
      expect(res.json().code).toBe('worker_unreachable');
      for (const leak of [ADMIN_TOKEN, 'worker.test', 'http_', 'injected', 'TypeError', 'fetch failed', 'unauthorised']) {
        expect(res.body.includes(leak), `${fault} leaks ${leak}`).toBe(false);
      }
    }
    // the token is sent only to the Worker, as a Bearer header, never reflected: the Worker saw it, the app did not echo it
    expect(r.worker.adminCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('POST /api/fleet/pending/:boxId/approve', () => {
  async function held(r: Rig, name = 'Surau Tertahan'): Promise<Box> {
    process.env.MAXCOM_AUTO_SURAU_DAILY_CAP = '1';
    if (autoCreates(r.db) === 0) await autoLink(r, 'Pengisi Had');
    const b = newBox();
    register(r, b, name);
    expect((await claim(r, b)).statusCode).not.toBe(200);
    return b;
  }

  it('newSurau: creates the surau named from the registration, binds the approval to the registered hash, logs the actor; the box then links into it past the cap', async () => {
    const r = rig();
    const b = await held(r);
    const sa = await ops(r);
    const surausBefore = surauCount(r.db);
    const autoBefore = autoCreates(r.db);
    const res = await call(r, sa, 'POST', `/api/fleet/pending/${b.boxId}/approve`, { newSurau: true });
    expect(res.statusCode, res.body).toBe(200);
    const j = res.json() as { surauId: string; created: boolean };
    expect(j.created).toBe(true);
    expect(surauCount(r.db)).toBe(surausBefore + 1);
    expect(r.db.prepare('SELECT name FROM suraus WHERE id = ?').get(j.surauId)?.name).toBe('Surau Tertahan');
    const ap = r.db.prepare('SELECT * FROM site_approvals WHERE box_id = ?').get(b.boxId) as Record<string, unknown>;
    expect(ap).toMatchObject({ surau_id: j.surauId, claim_hash: sha256hex(b.claim), claimed_at: null });
    const log = authRows(r.db, 'fleet_approve').at(-1)!;
    expect(log).toMatchObject({ user_id: sa.userId, device_id: sa.deviceId, ok: 1 });
    expect(String(log.detail)).toContain(b.boxId);
    expect(String(log.detail)).toContain(j.surauId);
    // the box claims: linked as primary in the new surau; the approval is not a cap creation
    const linked = await claim(r, b);
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json()).toMatchObject({ surauId: j.surauId, role: 'primary' });
    expect(autoCreates(r.db), 'approval is not an automatic creation').toBe(autoBefore);
  });

  it('surauId: links the box as primary of an existing waiting surau, no new surau', async () => {
    const r = rig();
    const b = await held(r);
    const target = createSurau(r.db, { name: 'Surau Sedia' }, 'test');
    const sa = await ops(r);
    const surausBefore = surauCount(r.db);
    const res = await call(r, sa, 'POST', `/api/fleet/pending/${b.boxId}/approve`, { surauId: target.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ surauId: target.id, created: false });
    expect(surauCount(r.db)).toBe(surausBefore);
    const linked = await claim(r, b);
    expect(linked.json()).toMatchObject({ surauId: target.id, role: 'primary' });
    expect(getSurau(r.db, target.id)!.boxes.map((x) => x.boxId)).toEqual([b.boxId]);
  });

  it('refuses a missing, doubled or malformed target without writing anything', async () => {
    const r = rig();
    const b = await held(r);
    const target = createSurau(r.db, { name: 'Surau Sedia' }, 'test');
    const sa = await ops(r);
    const before = world(r.db);
    const url = `/api/fleet/pending/${b.boxId}/approve`;
    for (const [body, code] of [
      [{}, 'surau_required'],
      [{ newSurau: false }, 'surau_required'],
      [{ newSurau: true, surauId: target.id }, 'bad_args'],
      [{ surauId: 12 }, 'bad_args'],
      [{ surauId: ['x'] }, 'bad_args'],
      [{ newSurau: 'yes' }, 'bad_args'],
    ] as const) {
      const res = await call(r, sa, 'POST', url, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().code, JSON.stringify(body)).toBe(code);
    }
    const unknown = await call(r, sa, 'POST', url, { surauId: NO_SURAU });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('surau_not_found');
    expect(world(r.db)).toBe(before);
  });

  it('refuses a box the Worker does not hold and a malformed box id; an unreachable Worker is 502 with nothing written', async () => {
    const r = rig();
    const b = await held(r);
    const sa = await ops(r);
    const before = world(r.db);
    const nobody = await call(r, sa, 'POST', `/api/fleet/pending/${NO_BOX}/approve`, { newSurau: true });
    expect(nobody.statusCode).toBe(404);
    expect(nobody.json().code).toBe('not_registered');
    for (const id of ['xyz', '../../etc', 'F'.repeat(16)]) {
      const res = await call(r, sa, 'POST', `/api/fleet/pending/${encodeURIComponent(id)}/approve`, { newSurau: true });
      expect([400, 404], id).toContain(res.statusCode);
    }
    r.worker.adminDown = true;
    const down = await call(r, sa, 'POST', `/api/fleet/pending/${b.boxId}/approve`, { newSurau: true });
    r.worker.adminDown = false;
    expect(down.statusCode).toBe(502);
    expect(down.json().code).toBe('worker_unreachable');
    expect(down.body.includes(ADMIN_TOKEN)).toBe(false);
    expect(world(r.db)).toBe(before);
    // and the same box approves fine once the Worker is back
    expect((await call(r, sa, 'POST', `/api/fleet/pending/${b.boxId}/approve`, { newSurau: true })).statusCode).toBe(200);
  });

  it('surau_has_box: a surau that already has a live box is refused (409), nothing written', async () => {
    const r = rig();
    const a = await autoLink(r, 'Surau A');
    const b = await held(r);
    const sa = await ops(r);
    const before = world(r.db);
    const res = await call(r, sa, 'POST', `/api/fleet/pending/${b.boxId}/approve`, { surauId: a.surauId });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().code).toBe('surau_has_box');
    expect(world(r.db)).toBe(before);
  });

  it('a live box cannot be approved again (409 linked); a revoked box stays in its own surau (409 foreign_surau, traced) and re-approves into it', async () => {
    const r = rig();
    const a = await autoLink(r, 'Surau A');
    const other = createSurau(r.db, { name: 'Surau Lain' }, 'test');
    const sa = await ops(r);
    register(r, a.box, 'Surau A');
    const live = await call(r, sa, 'POST', `/api/fleet/pending/${a.box.boxId}/approve`, { surauId: other.id });
    expect(live.statusCode, live.body).toBe(409);
    expect(live.json().code).toBe('linked');

    expect((await call(r, sa, 'POST', `/api/fleet/boxes/${a.box.boxId}/revoke`, {})).statusCode).toBe(200);
    register(r, a.box, 'Surau A');
    const approvalsBefore = approvals(r.db);
    const foreign = await call(r, sa, 'POST', `/api/fleet/pending/${a.box.boxId}/approve`, { surauId: other.id });
    expect(foreign.statusCode, foreign.body).toBe(409);
    expect(foreign.json().code).toBe('foreign_surau');
    expect(approvals(r.db)).toBe(approvalsBefore);
    expect(r.db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE detail LIKE '%foreign_surau%' OR event LIKE '%foreign_surau%'").get()?.n).toBeGreaterThan(0);
    expect(getSurau(r.db, other.id)!.boxes).toEqual([]);

    const own = await call(r, sa, 'POST', `/api/fleet/pending/${a.box.boxId}/approve`, { surauId: a.surauId });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toMatchObject({ surauId: a.surauId, created: false });
  });

  it('a surau admin and a public-device superadmin cannot approve (no approval written)', async () => {
    const r = rig();
    const b = await held(r);
    const approvalsBefore = approvals(r.db);
    const admin = await surauAdmin(r, createSurau(r.db, { name: 'Lain' }, 'test').id);
    const pub = await publicDevice(r, ['superadmin', 'admin']);
    for (const who of [admin, pub]) {
      const res = await call(r, who, 'POST', `/api/fleet/pending/${b.boxId}/approve`, { newSurau: true });
      expect(res.statusCode).toBe(403);
    }
    expect(approvals(r.db)).toBe(approvalsBefore);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('POST /api/fleet/pending/:boxId/reject', () => {
  it('rejects a pending registration: the Worker entry goes, nothing is linked, one fleet_reject row names the box', async () => {
    const r = rig();
    process.env.MAXCOM_AUTO_SURAU_DAILY_CAP = '1';
    await autoLink(r, 'Pengisi Had');
    const b = newBox();
    register(r, b, 'Surau Tertahan');
    const sa = await ops(r);
    const sitesBefore = JSON.stringify(r.db.prepare('SELECT * FROM sites ORDER BY box_id').all());
    const res = await call(r, sa, 'POST', `/api/fleet/pending/${b.boxId}/reject`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ rejected: true });
    expect(r.worker.regs.has(b.boxId)).toBe(false);
    expect(JSON.stringify(r.db.prepare('SELECT * FROM sites ORDER BY box_id').all())).toBe(sitesBefore);
    expect(siteOf(r.db, b.boxId)).toBeUndefined();
    const log = authRows(r.db, 'fleet_reject').at(-1)!;
    expect(log).toMatchObject({ user_id: sa.userId, device_id: sa.deviceId, ok: 1 });
    expect(String(log.detail)).toContain(b.boxId);
    const list = (await call(r, sa, 'GET', '/api/fleet/pending')).json() as { pending: { boxId: string }[] };
    expect(list.pending.some((p) => p.boxId === b.boxId)).toBe(false);
    // a second reject: nothing left at the Worker
    const again = await call(r, sa, 'POST', `/api/fleet/pending/${b.boxId}/reject`, {});
    expect(again.statusCode).toBe(404);
    expect(again.json().code).toBe('not_registered');
  });

  it('support, a surau admin and a public device are refused 403; the registration stays', async () => {
    const r = rig();
    const a = await autoLink(r, 'Surau A');
    const b = newBox();
    register(r, b);
    const pub = await publicDevice(r, ['superadmin', 'admin']);
    for (const who of [await support(r), await surauAdmin(r, a.surauId), pub]) {
      const res = await call(r, who, 'POST', `/api/fleet/pending/${b.boxId}/reject`, {});
      expect(res.statusCode, res.body).toBe(403);
    }
    expect(r.worker.regs.has(b.boxId)).toBe(true);
    expect(authRows(r.db, 'fleet_reject')).toHaveLength(0);
  });

  it('an unknown or malformed box id is 404 (not_registered / not_found), nothing deleted', async () => {
    const r = rig();
    const sa = await ops(r);
    const none = await call(r, sa, 'POST', `/api/fleet/pending/${NO_BOX}/reject`, {});
    expect(none.statusCode).toBe(404);
    expect(none.json().code).toBe('not_registered');
    for (const id of ['xyz', 'G'.repeat(16), 'a'.repeat(90)]) {
      const res = await call(r, sa, 'POST', `/api/fleet/pending/${id}/reject`, {});
      expect(res.statusCode, id).toBe(404);
      expect(res.json().code).toBe('not_found');
    }
    expect(r.worker.adminCalls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('a Worker that is down or refuses is 502 worker_unreachable with no detail', async () => {
    const r = rig();
    const b = newBox();
    register(r, b);
    const sa = await ops(r);
    for (const fault of ['down', 'http500', 'http401'] as const) {
      r.worker.adminDown = fault === 'down';
      r.worker.adminStatus = fault === 'http500' ? 500 : fault === 'http401' ? 401 : null;
      const res = await call(r, sa, 'POST', `/api/fleet/pending/${b.boxId}/reject`, {});
      expect(res.statusCode, fault).toBe(502);
      expect(res.json().code).toBe('worker_unreachable');
      for (const leak of [ADMIN_TOKEN, 'worker.test', 'http_', 'injected', 'TypeError', 'fetch failed']) {
        expect(res.body.includes(leak), `${fault} leaks ${leak}`).toBe(false);
      }
    }
    expect(r.worker.regs.has(b.boxId)).toBe(true);
    expect(authRows(r.db, 'fleet_reject')).toHaveLength(0);
  });

  it('a linked box (or a revoked one) is refused 409 already_linked and keeps its site, key and Worker entry', async () => {
    const r = rig();
    const a = await autoLink(r);
    const sa = await ops(r);
    register(r, a.box); // the Worker may still hold an entry for a linked box
    const before = world(r.db);
    const res = await call(r, sa, 'POST', `/api/fleet/pending/${a.box.boxId}/reject`, {});
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().code).toBe('already_linked');
    expect(world(r.db)).toBe(before);
    expect(r.worker.regs.has(a.box.boxId)).toBe(true);
    expect((await snapshot(r, a.siteToken)).statusCode).toBe(200);
    expect((await call(r, sa, 'POST', `/api/fleet/boxes/${a.box.boxId}/revoke`, {})).statusCode).toBe(200);
    const rev = await call(r, sa, 'POST', `/api/fleet/pending/${a.box.boxId}/reject`, {});
    expect(rev.statusCode).toBe(409);
    expect(r.worker.regs.has(a.box.boxId)).toBe(true);
  });

  it('a box with a waiting approval is refused 409 already_linked (revoke withdraws it, not reject)', async () => {
    const r = rig();
    process.env.MAXCOM_AUTO_SURAU_DAILY_CAP = '1';
    await autoLink(r, 'Pengisi Had');
    const b = newBox();
    register(r, b);
    const sa = await ops(r);
    expect((await call(r, sa, 'POST', `/api/fleet/pending/${b.boxId}/approve`, { newSurau: true })).statusCode).toBe(200);
    const res = await call(r, sa, 'POST', `/api/fleet/pending/${b.boxId}/reject`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('already_linked');
    expect(r.db.prepare('SELECT 1 AS x FROM site_approvals WHERE box_id = ?').get(b.boxId)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('suspend, unsuspend', () => {
  it('suspend shuts the surau out (its box key 403 surau_suspended), the ops device is not stopped; unsuspend lets it back; both logged', async () => {
    const r = rig();
    const a = await autoLink(r);
    const sa = await ops(r);
    expect((await snapshot(r, a.siteToken)).statusCode).toBe(200);
    const res = await call(r, sa, 'POST', `/api/suraus/${a.surauId}/suspend`, { reason: 'Penggunaan salah' });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { surau: { status: string } }).surau.status).toBe('Digantung');
    const row = r.db.prepare('SELECT suspended_at, suspended_reason FROM suraus WHERE id = ?').get(a.surauId);
    expect(typeof row?.suspended_at).toBe('string');
    expect(row?.suspended_reason).toBe('Penggunaan salah');
    const shut = await snapshot(r, a.siteToken);
    expect(shut.statusCode).toBe(403);
    expect(shut.json().code).toBe('surau_suspended');
    expect((await call(r, sa, 'GET', `/api/suraus/${a.surauId}`)).statusCode, 'ops device not stopped').toBe(200);
    const log = authRows(r.db, 'fleet_suspend').at(-1)!;
    expect(log).toMatchObject({ user_id: sa.userId, device_id: sa.deviceId, ok: 1 });
    expect(String(log.detail)).toContain(a.surauId);

    const back = await call(r, sa, 'POST', `/api/suraus/${a.surauId}/unsuspend`, {});
    expect(back.statusCode, back.body).toBe(200);
    expect((back.json() as { surau: { status: string } }).surau.status).toBe('Aktif');
    expect(r.db.prepare('SELECT suspended_at FROM suraus WHERE id = ?').get(a.surauId)?.suspended_at ?? null).toBeNull();
    expect((await snapshot(r, a.siteToken)).statusCode).toBe(200);
    const log2 = authRows(r.db, 'fleet_unsuspend').at(-1)!;
    expect(log2).toMatchObject({ user_id: sa.userId, device_id: sa.deviceId, ok: 1 });
    expect(String(log2.detail)).toContain(a.surauId);
  });

  it('a reason is required, trimmed of control characters and at most 200 long; an unknown surau is 404; nothing is written on a refusal', async () => {
    const r = rig();
    const a = await autoLink(r);
    const sa = await ops(r);
    const before = world(r.db);
    const logsBefore = authRows(r.db, 'fleet_suspend').length;
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: '\u0000‮​' }, { reason: 5 }, { reason: ['x'] }, { reason: 'x'.repeat(201) }, { reason: 'y'.repeat(5000) }]) {
      const res = await call(r, sa, 'POST', `/api/suraus/${a.surauId}/suspend`, body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(res.json().code).toBe('bad_args');
    }
    const unknown = await call(r, sa, 'POST', `/api/suraus/${NO_SURAU}/suspend`, { reason: 'x' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('surau_not_found');
    expect((await call(r, sa, 'POST', `/api/suraus/${NO_SURAU}/unsuspend`, {})).statusCode).toBe(404);
    expect(world(r.db)).toBe(before);
    expect(authRows(r.db, 'fleet_suspend').length).toBe(logsBefore);
    // 200 characters exactly is accepted
    expect((await call(r, sa, 'POST', `/api/suraus/${a.surauId}/suspend`, { reason: 'x'.repeat(200) })).statusCode).toBe(200);
  });

  it('support (fleet:read only) cannot suspend or unsuspend', async () => {
    const r = rig();
    const a = await autoLink(r);
    const sp = await support(r);
    expect((await call(r, sp, 'POST', `/api/suraus/${a.surauId}/suspend`, { reason: 'x' })).statusCode).toBe(403);
    expect(r.db.prepare('SELECT suspended_at FROM suraus WHERE id = ?').get(a.surauId)?.suspended_at ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('revoke, unrevoke', () => {
  it('revoke kills the box key at once, is logged, and is final: a second revoke is 409 not_linked, a claim is refused (403 box_revoked)', async () => {
    const r = rig();
    const a = await autoLink(r);
    const sa = await ops(r);
    expect((await snapshot(r, a.siteToken)).statusCode).toBe(200);
    const res = await call(r, sa, 'POST', `/api/fleet/boxes/${a.box.boxId}/revoke`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(siteOf(r.db, a.box.boxId)).toMatchObject({ token_hash: null });
    expect(typeof siteOf(r.db, a.box.boxId)!.revoked_at).toBe('string');
    expect((await snapshot(r, a.siteToken)).statusCode).toBe(401);
    const log = authRows(r.db, 'fleet_revoke').at(-1)!;
    expect(log).toMatchObject({ user_id: sa.userId, device_id: sa.deviceId, ok: 1 });
    expect(String(log.detail)).toContain(a.box.boxId);

    const again = await call(r, sa, 'POST', `/api/fleet/boxes/${a.box.boxId}/revoke`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('not_linked');
    register(r, a.box);
    const refused = await claim(r, a.box);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'box_revoked' });
    expect(refused.json().siteToken).toBeUndefined();
  });

  it('unrevoke lets the revoked box link again once, into its own surau, with a fresh key; a live or unknown box is refused', async () => {
    const r = rig();
    const a = await autoLink(r);
    const sa = await ops(r);
    const surausBefore = surauCount(r.db);

    const live = await call(r, sa, 'POST', `/api/fleet/boxes/${a.box.boxId}/unrevoke`, {});
    expect(live.statusCode).toBe(409);
    expect(live.json().code).toBe('not_revoked');
    const none = await call(r, sa, 'POST', `/api/fleet/boxes/${NO_BOX}/unrevoke`, {});
    expect(none.statusCode).toBe(404);
    expect(none.json().code).toBe('not_found');

    expect((await call(r, sa, 'POST', `/api/fleet/boxes/${a.box.boxId}/revoke`, {})).statusCode).toBe(200);
    register(r, a.box);
    expect((await claim(r, a.box)).statusCode, 'still refused before the unrevoke').toBe(403);
    const res = await call(r, sa, 'POST', `/api/fleet/boxes/${a.box.boxId}/unrevoke`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ surauId: a.surauId });
    const log = authRows(r.db, 'fleet_unrevoke').at(-1)!;
    expect(log).toMatchObject({ user_id: sa.userId, device_id: sa.deviceId, ok: 1 });
    expect(String(log.detail)).toContain(a.box.boxId);

    const again = await claim(r, a.box);
    expect(again.statusCode, again.body).toBe(200);
    const j = again.json() as { surauId: string; siteToken: string };
    expect(j.surauId).toBe(a.surauId);
    expect(j.siteToken).not.toBe(a.siteToken);
    expect(surauCount(r.db)).toBe(surausBefore);
    expect((await snapshot(r, a.siteToken)).statusCode).toBe(401);
    expect((await snapshot(r, j.siteToken)).statusCode).toBe(200);
  });

  it('unknown and malformed box ids are 404 not_found; support and a surau admin cannot revoke', async () => {
    const r = rig();
    const a = await autoLink(r);
    const sa = await ops(r);
    // (implementer) 'a'.repeat(200) is past the router's parameter limit (414), not a handler answer: 'a'.repeat(90) instead
    for (const id of [NO_BOX, 'xyz', 'G'.repeat(16), 'a'.repeat(90)]) {
      for (const action of ['revoke', 'unrevoke']) {
        const res = await call(r, sa, 'POST', `/api/fleet/boxes/${id}/${action}`, {});
        expect(res.statusCode, `${action} ${id}`).toBe(404);
        expect(res.json().code).toBe('not_found');
      }
    }
    const sp = await support(r);
    const admin = await surauAdmin(r, a.surauId);
    for (const who of [sp, admin]) {
      expect((await call(r, who, 'POST', `/api/fleet/boxes/${a.box.boxId}/revoke`, {})).statusCode).toBe(403);
    }
    expect((await snapshot(r, a.siteToken)).statusCode, 'the box is untouched').toBe(200);
  });
});

describe('revoke withdraws a pending approval (qs-gate)', () => {
  it('a box with only a pending approval (no site) is revoked: the approval goes, the box cannot claim it', async () => {
    const r = rig();
    process.env.MAXCOM_AUTO_SURAU_DAILY_CAP = '1';
    await autoLink(r, 'Pengisi Had');
    const b = newBox();
    register(r, b, 'Surau Tertahan');
    expect((await claim(r, b)).statusCode).not.toBe(200);
    const sa = await ops(r);
    expect((await call(r, sa, 'POST', `/api/fleet/pending/${b.boxId}/approve`, { newSurau: true })).statusCode).toBe(200);
    expect(siteOf(r.db, b.boxId)).toBeUndefined();
    const res = await call(r, sa, 'POST', `/api/fleet/boxes/${b.boxId}/revoke`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ revoked: true });
    expect(r.db.prepare('SELECT 1 AS x FROM site_approvals WHERE box_id = ?').get(b.boxId)).toBeUndefined();
    expect(String(authRows(r.db, 'fleet_revoke').at(-1)!.detail)).toContain(b.boxId);
    // the approval is gone: the box is held by the cap again, never linked
    expect((await claim(r, b)).statusCode).not.toBe(200);
    expect(siteOf(r.db, b.boxId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('PUT /api/suraus/:id/storage-limit', () => {
  it('sets the limit, shows it in the detail and the list, logs it', async () => {
    const r = rig();
    const a = await autoLink(r);
    const sa = await ops(r);
    const res = await call(r, sa, 'PUT', `/api/suraus/${a.surauId}/storage-limit`, { bytes: 5_000_000_000 });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { surau: { storageLimitBytes: number } }).surau.storageLimitBytes).toBe(5_000_000_000);
    expect(r.db.prepare('SELECT storage_limit_bytes AS b FROM suraus WHERE id = ?').get(a.surauId)?.b).toBe(5_000_000_000);
    const detail = (await call(r, sa, 'GET', `/api/suraus/${a.surauId}`)).json() as { surau: { storageLimitBytes: number } };
    expect(detail.surau.storageLimitBytes).toBe(5_000_000_000);
    const log = authRows(r.db, 'fleet_storage_limit').at(-1)!;
    expect(log).toMatchObject({ user_id: sa.userId, device_id: sa.deviceId, ok: 1 });
    expect(String(log.detail)).toContain(a.surauId);
    // it can be lowered again
    expect((await call(r, sa, 'PUT', `/api/suraus/${a.surauId}/storage-limit`, { bytes: 1_000_000 })).statusCode).toBe(200);
    expect(getSurau(r.db, a.surauId)!.storageLimitBytes).toBe(1_000_000);
  });

  it('refuses a limit below what the surau already holds (limit_below_use, nothing written); exactly the use is accepted', async () => {
    const r = rig();
    const a = await autoLink(r);
    const sa = await ops(r);
    r.db.prepare('INSERT INTO surau_assets (surau_id, asset_id, bytes, created_at) VALUES (?, ?, ?, ?)').run(a.surauId, 'b'.repeat(64), 3_000_000, new Date(r.clock).toISOString());
    expect(getSurau(r.db, a.surauId)!.storageUsedBytes).toBe(3_000_000);
    const before = world(r.db);
    const logsBefore = authRows(r.db, 'fleet_storage_limit').length;
    const low = await call(r, sa, 'PUT', `/api/suraus/${a.surauId}/storage-limit`, { bytes: 2_999_999 });
    expect(low.statusCode, low.body).toBe(400);
    expect(low.json().code).toBe('limit_below_use');
    expect(world(r.db)).toBe(before);
    expect(authRows(r.db, 'fleet_storage_limit').length).toBe(logsBefore);
    const exact = await call(r, sa, 'PUT', `/api/suraus/${a.surauId}/storage-limit`, { bytes: 3_000_000 });
    expect(exact.statusCode, exact.body).toBe(200);
    expect(getSurau(r.db, a.surauId)!.storageLimitBytes).toBe(3_000_000);
  });

  it('refuses anything but a positive safe integer; unknown surau 404; support and a surau admin 403', async () => {
    const r = rig();
    const a = await autoLink(r);
    const sa = await ops(r);
    const before = world(r.db);
    for (const body of [{}, { bytes: 0 }, { bytes: -5 }, { bytes: 1.5 }, { bytes: '1000' }, { bytes: null }, { bytes: [1] }, { bytes: 9007199254740994 }, { limit: 1000 }]) {
      const res = await call(r, sa, 'PUT', `/api/suraus/${a.surauId}/storage-limit`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().code).toBe('bad_args');
    }
    const unknown = await call(r, sa, 'PUT', `/api/suraus/${NO_SURAU}/storage-limit`, { bytes: 1000 });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('surau_not_found');
    for (const who of [await support(r), await surauAdmin(r, a.surauId)]) {
      expect((await call(r, who, 'PUT', `/api/suraus/${a.surauId}/storage-limit`, { bytes: 1000 })).statusCode).toBe(403);
    }
    expect(world(r.db)).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('rate limits on every row', () => {
  it('each GET row answers 429 with Retry-After by the 121st call, a second caller is unaffected', { timeout: 120_000 }, async () => {
    const r = rig();
    for (const row of ROWS.filter((x) => x.method === 'GET')) {
      const who = await ops(r);
      const other = await ops(r);
      let first = 0;
      let retryAfter: unknown;
      for (let i = 1; i <= 130 && first === 0; i++) {
        const res = await call(r, who, row.method, row.url(NO_SURAU, NO_BOX));
        if (res.statusCode === 429) {
          first = i;
          retryAfter = res.headers['retry-after'];
        }
      }
      expect(first, `${row.label}: limited`).toBeGreaterThan(1);
      expect(first, `${row.label}: limited by the 121st call`).toBeLessThanOrEqual(121);
      expect(Number(retryAfter), `${row.label}: Retry-After`).toBeGreaterThan(0);
      expect((await call(r, other, row.method, row.url(NO_SURAU, NO_BOX))).statusCode, `${row.label}: another caller`).not.toBe(429);
    }
  });

  it('each mutating row answers 429 with Retry-After by the 31st call, refused calls count, a second caller is unaffected, nothing is written', { timeout: 120_000 }, async () => {
    const r = rig();
    // (implementer) the first ops sign-in seeds the test surau row (authHelpers); snapshot after it
    await ops(r);
    const before = world(r.db);
    for (const row of ROWS.filter((x) => x.method !== 'GET')) {
      const who = await ops(r);
      const other = await ops(r);
      let first = 0;
      let retryAfter: unknown;
      for (let i = 1; i <= 40 && first === 0; i++) {
        const res = await call(r, who, row.method, row.url(NO_SURAU, NO_BOX), row.harmless);
        if (res.statusCode === 429) {
          first = i;
          retryAfter = res.headers['retry-after'];
        }
      }
      expect(first, `${row.label}: limited`).toBeGreaterThan(1);
      expect(first, `${row.label}: limited by the 31st call`).toBeLessThanOrEqual(31);
      expect(Number(retryAfter), `${row.label}: Retry-After`).toBeGreaterThan(0);
      expect((await call(r, other, row.method, row.url(NO_SURAU, NO_BOX), row.harmless)).statusCode, `${row.label}: another caller`).not.toBe(429);
    }
    expect(world(r.db)).toBe(before);
  });

  it('the window ends: after it the caller is served again', async () => {
    const r = rig();
    const who = await ops(r);
    let limited = false;
    for (let i = 0; i < 130 && !limited; i++) limited = (await call(r, who, 'GET', '/api/suraus')).statusCode === 429;
    expect(limited).toBe(true);
    r.clock += 11 * 60_000;
    expect((await call(r, who, 'GET', '/api/suraus')).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('/api/auth/me carries the surau and the scope', () => {
  const me = async (r: Rig, who: Login) => (await call(r, who, 'GET', '/api/auth/me')).json() as { surau: { id: string; name: string } | null; scope: string; ops: boolean; roles: string[] };

  it('an ops session: scope all, the acting surau named', async () => {
    const r = rig();
    const sa = await ops(r);
    const sp = await support(r);
    for (const who of [sa, sp]) {
      const j = await me(r, who);
      expect(j.scope).toBe('all');
      expect(j.ops).toBe(true);
      expect(j.surau).toEqual({ id: 'sdm', name: 'Surau ujian' });
    }
    // acting for another surau
    const a = await autoLink(r, 'Surau A');
    const res = await r.app.inject({ method: 'GET', url: '/api/auth/me', headers: { ...sa.headers, [SURAU_HEADER]: a.surauId } });
    expect(res.json()).toMatchObject({ scope: 'all', surau: { id: a.surauId, name: 'Surau A' } });
  });

  it('a surau admin: scope surau, its own surau; a header cannot widen it', async () => {
    const r = rig();
    const a = await autoLink(r, 'Surau A');
    const b = createSurau(r.db, { name: 'Surau B' }, 'test');
    const admin = await surauAdmin(r, a.surauId);
    expect(await me(r, admin)).toMatchObject({ scope: 'surau', ops: false, surau: { id: a.surauId, name: 'Surau A' } });
    const res = await r.app.inject({ method: 'GET', url: '/api/auth/me', headers: { ...admin.headers, [SURAU_HEADER]: b.id } });
    expect(res.json()).toMatchObject({ scope: 'surau', surau: { id: a.surauId } });
  });

  it('a superadmin on a public device: scope surau, ops false, no ops role in the roles', async () => {
    const r = rig();
    const pub = await publicDevice(r, ['superadmin', 'admin']);
    const j = await me(r, pub);
    expect(j.scope).toBe('surau');
    expect(j.ops).toBe(false);
    expect(j.roles).not.toContain('superadmin');
    expect(j.roles).not.toContain('support');
    expect(typeof j.surau?.id).toBe('string');
    const res = await r.app.inject({ method: 'GET', url: '/api/auth/me', headers: { ...pub.headers, [SURAU_HEADER]: 'zzzzzzzzzzzz' } });
    expect(res.json().scope).toBe('surau');
  });

  it('a box: scope surau with the local surau', async () => {
    const dir = (await import('node:fs')).mkdtempSync(join((await import('node:os')).tmpdir(), 'surau-fleet-me-'));
    const app = buildApp(join(dir, 'box.db'), { dataDir: dir, role: 'box' });
    cleanups.push(async () => {
      await app.close().catch(() => undefined);
      (await import('node:fs')).rmSync(dir, { recursive: true, force: true });
    });
    const admin = await loginAs(app, 'admin');
    const j = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: admin.headers })).json();
    expect(j.scope).toBe('surau');
    expect(j.surau.id).toBe('sdm');
    expect(typeof j.surau.name).toBe('string');
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('no fleet route touches superadmin or support (decisions 19-20)', () => {
  it('no path exists to create, grant, remove or appoint an ops-role person; unlisted paths are 404 for a signed-in ops device', async () => {
    const r = rig();
    const a = await autoLink(r);
    const sa = await ops(r);
    const before = people(r.db);
    const paths: [Method, string][] = [
      ['POST', '/api/fleet/users'],
      ['POST', '/api/fleet/superadmin'],
      ['POST', '/api/fleet/support'],
      ['PUT', '/api/fleet/roles'],
      ['POST', '/api/suraus/' + a.surauId + '/users'],
      ['POST', '/api/suraus/' + a.surauId + '/superadmin'],
      ['PUT', '/api/suraus/' + a.surauId + '/support'],
      ['DELETE', '/api/suraus/' + a.surauId + '/support'],
      ['POST', '/api/suraus/' + a.surauId + '/appoint'],
      ['POST', '/api/fleet/support-add'],
      ['POST', '/api/fleet/ops-enrol'],
      ['POST', '/api/fleet/boxes/' + a.box.boxId + '/promote'],
    ];
    for (const [m, p] of paths) {
      const res = await call(r, sa, m, p, { name: 'X', roles: ['superadmin'], role: 'superadmin', userId: sa.userId });
      expect(res.statusCode, `${m} ${p}`).toBe(404);
    }
    expect(people(r.db)).toBe(before);
  });

  it('role-shaped fields in the body of every real fleet route change no user, role, device or enrolment', async () => {
    const r = rig();
    const a = await autoLink(r, 'Surau A');
    const waiting = createSurau(r.db, { name: 'Surau Menunggu' }, 'test');
    const sp = await support(r);
    const sa = await ops(r);
    process.env.MAXCOM_AUTO_SURAU_DAILY_CAP = '1';
    const held = newBox();
    register(r, held, 'Tertahan');
    await claim(r, held);
    const before = people(r.db);
    const evil = { roles: ['superadmin', 'support'], role: 'superadmin', userId: sp.userId, grantSuperadmin: true, support: true, ops: true, makeOps: true, name: 'Dalang' };
    await call(r, sa, 'POST', `/api/fleet/pending/${held.boxId}/approve`, { newSurau: true, ...evil });
    await call(r, sa, 'POST', `/api/fleet/pending/${held.boxId}/approve`, { surauId: waiting.id, ...evil });
    await call(r, sa, 'POST', `/api/suraus/${a.surauId}/suspend`, { reason: 'x', ...evil });
    await call(r, sa, 'POST', `/api/suraus/${a.surauId}/unsuspend`, evil);
    await call(r, sa, 'PUT', `/api/suraus/${a.surauId}/storage-limit`, { bytes: 4_000_000, ...evil });
    await call(r, sa, 'POST', `/api/fleet/boxes/${a.box.boxId}/revoke`, evil);
    await call(r, sa, 'POST', `/api/fleet/boxes/${a.box.boxId}/unrevoke`, evil);
    for (const [m, u] of [['GET', '/api/suraus'], ['GET', `/api/suraus/${a.surauId}`], ['GET', '/api/fleet/pending']] as const) {
      await call(r, sa, m, `${u}?roles=superadmin&userId=${sp.userId}`);
    }
    expect(people(r.db)).toBe(before);
    // the users table still has exactly the roles the two logins were made with
    expect(getUserRow(r.db, sp.userId)!.roles).toEqual(['support']);
    expect([...getUserRow(r.db, sa.userId)!.roles].sort()).toEqual(['admin', 'superadmin']);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('the Worker admin token never leaves the cloud', () => {
  it('is in no answer of any fleet route and in no log row, on success and on failure', async () => {
    process.env.MAXCOM_AUTO_SURAU_DAILY_CAP = '1';
    const r = rig();
    const a = await autoLink(r);
    const held = newBox();
    register(r, held, 'Tertahan');
    await claim(r, held);
    const sa = await ops(r);
    const bodies: string[] = [];
    const run = async (m: Method, u: string, p?: unknown) => bodies.push((await call(r, sa, m, u, p)).body);
    await run('GET', '/api/suraus');
    await run('GET', `/api/suraus/${a.surauId}`);
    await run('GET', '/api/fleet/pending');
    await run('POST', `/api/fleet/pending/${held.boxId}/approve`, { newSurau: true });
    r.worker.adminStatus = 500;
    await run('GET', '/api/fleet/pending');
    await run('POST', `/api/fleet/pending/${held.boxId}/approve`, { newSurau: true });
    r.worker.adminStatus = null;
    await run('POST', `/api/suraus/${a.surauId}/suspend`, { reason: 'x' });
    await run('POST', `/api/suraus/${a.surauId}/unsuspend`, {});
    await run('POST', `/api/fleet/boxes/${a.box.boxId}/revoke`, {});
    await run('POST', `/api/fleet/boxes/${a.box.boxId}/unrevoke`, {});
    await run('PUT', `/api/suraus/${a.surauId}/storage-limit`, { bytes: 4_000_000 });
    for (const b of bodies) expect(b.includes(ADMIN_TOKEN)).toBe(false);
    const logs = JSON.stringify([r.db.prepare('SELECT * FROM auth_log').all(), r.db.prepare('SELECT * FROM change_log').all()]);
    expect(logs.includes(ADMIN_TOKEN)).toBe(false);
    // the claim secret of the held box is not in any fleet answer or log either (only its hash is ever stored)
    for (const b of bodies) expect(b.includes(held.claim)).toBe(false);
    expect(logs.includes(held.claim)).toBe(false);
    expect(createHash('sha256').update(held.claim).digest('hex').length).toBe(64);
  });
});
