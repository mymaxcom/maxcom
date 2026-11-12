import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant } from '@surau/core';
import type { OpResult, SyncOp } from '@surau/core';
import { buildApp } from '../src/app.ts';
import type { AppOptions } from '../src/app.ts';
import { authHook, createLimiters } from '../src/auth/authz.ts';
import { revokeDevice } from '../src/auth/devices.ts';
import { resolveSession } from '../src/auth/sessions.ts';
import { setRoles } from '../src/auth/users.ts';
import { createChangeBus } from '../src/events.ts';
import { getVersion } from '../src/settingsStore.ts';
import { createSyncService, registerSyncRoutes, SYNC_BODY_LIMIT } from '../src/sync/routes.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { newOpId, signOp } from './support/signOp.ts';
import type { OpInput } from './support/signOp.ts';
import { insertSite } from './support/sites.ts';

const AT = klInstant('2026-11-03', '12:00');
const apps: FastifyInstance[] = [];
const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-syncroutes-'));
  dirs.push(d);
  return d;
}

function makeApp(options: AppOptions = {}): FastifyInstance {
  const app = buildApp(join(tempDir(), 'test.db'), { now: () => AT, ...options });
  apps.push(app);
  return app;
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const put = (id: string, name = 'Ustaz'): OpInput => ({ kind: 'content.put', entity: 'content:penceramah', entityId: id, payload: { name } });

const count = (app: FastifyInstance, sql: string): number => Number(app.surau.db.prepare(sql).get()?.n ?? 0);
const refusals = (app: FastifyInstance): number => count(app, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'sync_refused'");
const contentChanges = (app: FastifyInstance): number => count(app, "SELECT COUNT(*) AS n FROM change_log WHERE entity LIKE 'content:%'");

async function postOps(app: FastifyInstance, login: Login, ops: unknown[], extra: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: '/api/sync/ops', headers: login.headers, payload: { ops, ...extra } });
}

async function batch(app: FastifyInstance, login: Login, inputs: OpInput[]): Promise<SyncOp[]> {
  return Promise.all(inputs.map((i) => signOp(login, app.surau.boxId, i)));
}

describe('POST /api/sync/ops from a device session', () => {
  it('applies a batch of 3 content ops, moves the version, and a replay answers 3 duplicate with no new change', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ops = await batch(app, admin, [put('p1'), put('p2'), put('p3')]);
    const v0 = getVersion(app.surau.db);
    const r = await postOps(app, admin, ops);
    expect(r.statusCode).toBe(200);
    const body = r.json() as { results: OpResult[]; seq: number };
    expect(body.results.map((x) => x.status)).toEqual(['applied', 'applied', 'applied']);
    expect(body.results.map((x) => x.opId)).toEqual(ops.map((o) => o.opId));
    expect(getVersion(app.surau.db)).toBeGreaterThan(v0);
    expect(body.seq).toBeGreaterThan(0);
    expect((await app.inject({ method: 'GET', url: '/api/content/penceramah/p2', headers: admin.headers })).json().item.name).toBe('Ustaz');
    const logs = contentChanges(app);
    const origin = app.surau.db.prepare("SELECT origin, op_id FROM change_log WHERE op_id = ?").get(ops[0]!.opId);
    expect(origin).toMatchObject({ origin: 'app' });

    const again = (await postOps(app, admin, ops)).json() as { results: OpResult[] };
    expect(again.results.map((x) => x.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect(contentChanges(app)).toBe(logs);
    expect(refusals(app)).toBe(0);
  });

  it('a flipped signature byte is bad_signature, nothing is written, one auth_log row', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const [op] = await batch(app, admin, [put('p1')]);
    const raw = Buffer.from(op!.sig, 'base64url');
    raw[0]! ^= 1;
    const before = contentChanges(app);
    const r = await postOps(app, admin, [{ ...op, sig: raw.toString('base64url') }]);
    expect((r.json() as { results: OpResult[] }).results[0]).toMatchObject({ status: 'refused', reason: 'bad_signature' });
    expect(contentChanges(app)).toBe(before);
    expect(refusals(app)).toBe(1);
    expect(count(app, "SELECT COUNT(*) AS n FROM applied_ops")).toBe(0);
  });

  it('a refused op does not block the ones after it', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const [a, b] = await batch(app, admin, [put('p1'), put('p2')]);
    const flipped = { ...a!, sig: Buffer.alloc(64).toString('base64url') };
    const r = (await postOps(app, admin, [flipped, b])).json() as { results: OpResult[] };
    expect(r.results.map((x) => x.status)).toEqual(['refused', 'applied']);
  });

  it('revoked device: the token is dead (401 device_revoked, one auth_log row) and nothing is written', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ops = await batch(app, admin, [put('p1'), put('p2'), put('p3'), put('p4'), put('p5')]);
    revokeDevice(app.surau.db, admin.deviceId, 'test');
    const before = contentChanges(app);
    const r = await postOps(app, admin, ops);
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ reason: 'device_revoked' });
    expect(contentChanges(app)).toBe(before);
    expect(count(app, "SELECT COUNT(*) AS n FROM applied_ops")).toBe(0);
    const rows = app.surau.db.prepare("SELECT * FROM auth_log WHERE event = 'sync_refused'").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ detail: 'device_revoked', device_id: admin.deviceId, ok: 0 });
    expect(JSON.stringify(rows)).not.toContain(admin.token);
  });

  it('revoked device whose session was resolved just before the revocation: every op device_revoked, one auth_log row each, nothing written', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ops = await batch(app, admin, [put('p1'), put('p2'), put('p3'), put('p4'), put('p5')]);
    const ctx = resolveSession(app.surau.db, admin.token, AT)!;
    expect(ctx).not.toBeNull();
    revokeDevice(app.surau.db, admin.deviceId, 'test');
    const service = createSyncService({
      db: app.surau.db, boxId: app.surau.boxId, dataDir: tempDir(), now: () => AT, limiters: createLimiters(), bus: createChangeBus(),
    });
    const before = contentChanges(app);
    const out = service.processDeviceOps(ctx, ops, '10.1.1.1');
    expect(out.results.map((x) => x.reason)).toEqual(Array(5).fill('device_revoked'));
    expect(out.results.every((x) => x.status === 'refused')).toBe(true);
    expect(out.changed).toBe(false);
    expect(contentChanges(app)).toBe(before);
    expect(count(app, "SELECT COUNT(*) AS n FROM applied_ops")).toBe(0);
    expect(refusals(app)).toBe(5);
  });

  it('a user demoted from Pentadbir to AJK with a queued settings.put: forbidden, not applied, logged', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const [op] = await batch(app, admin, [{ kind: 'settings.put', entity: 'settings', entityId: 'clock', payload: { show24h: true } }]);
    setRoles(app.surau.db, admin.userId, ['ajk'], 'test');
    const before = JSON.stringify((await app.inject({ method: 'GET', url: '/api/settings', headers: admin.headers })).json());
    const r = (await postOps(app, admin, [op])).json() as { results: OpResult[] };
    expect(r.results[0]).toMatchObject({ status: 'refused', reason: 'forbidden' });
    expect(JSON.stringify((await app.inject({ method: 'GET', url: '/api/settings', headers: admin.headers })).json())).toBe(before);
    expect(refusals(app)).toBe(1);
    expect(count(app, "SELECT COUNT(*) AS n FROM applied_ops")).toBe(0);
  });

  it('an AJK session sending settings.put or content.put is forbidden', async () => {
    const app = makeApp();
    const ajk = await loginAs(app, 'ajk');
    const ops = await batch(app, ajk, [{ kind: 'settings.put', entity: 'settings', entityId: 'clock', payload: { show24h: true } }, put('p1')]);
    const r = (await postOps(app, ajk, ops)).json() as { results: OpResult[] };
    expect(r.results.map((x) => x.reason)).toEqual(['forbidden', 'forbidden']);
    expect(refusals(app)).toBe(2);
  });

  it('ops signed by device A sent over device B session: whole batch 403 device_mismatch, nothing applied', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'admin');
    const b = await loginAs(app, 'admin');
    const ops = await batch(app, a, [put('p1'), put('p2')]);
    const before = contentChanges(app);
    const r = await postOps(app, b, ops);
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ code: 'device_mismatch' });
    expect(contentChanges(app)).toBe(before);
    expect(refusals(app)).toBe(1);
    // a mixed batch (one own op, one foreign) is refused whole too
    const own = await batch(app, b, [put('p3')]);
    expect((await postOps(app, b, [...own, ...ops])).statusCode).toBe(403);
    expect(contentChanges(app)).toBe(before);
  });

  it('a foreign box id is refused per op and nothing is written', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const op = await signOp(admin, app.surau.boxId, { ...put('p1'), boxId: 'ffffffffffffffff' });
    const r = (await postOps(app, admin, [op])).json() as { results: OpResult[] };
    expect(r.results[0]).toMatchObject({ status: 'refused', reason: 'invalid' });
    expect(refusals(app)).toBe(1);
    expect(count(app, "SELECT COUNT(*) AS n FROM applied_ops")).toBe(0);
  });

  it('201 ops are refused whole (400 too_many_ops); 3 asset ops are refused (400 too_many_assets)', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ops = await batch(app, admin, Array.from({ length: 201 }, (_, i) => put(`p${i}`)));
    const r = await postOps(app, admin, ops);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'too_many_ops' });
    const assets = await batch(app, admin, [1, 2, 3].map((i) => ({ kind: 'asset.put' as const, entity: 'asset', entityId: `a${i}`, payload: { mime: 'image/png', bytesBase64: 'AA==' } })));
    const r2 = await postOps(app, admin, assets);
    expect(r2.statusCode).toBe(400);
    expect(r2.json()).toMatchObject({ code: 'too_many_assets' });
    expect(contentChanges(app)).toBe(0);
    expect(count(app, "SELECT COUNT(*) AS n FROM applied_ops")).toBe(0);
  });

  it('200 ops in one batch are accepted', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ops = await batch(app, admin, Array.from({ length: 200 }, (_, i) => put(`p${i}`)));
    const r = await postOps(app, admin, ops);
    expect(r.statusCode).toBe(200);
    expect((r.json() as { results: OpResult[] }).results.every((x) => x.status === 'applied')).toBe(true);
  });

  it('a body over the batch limit (room for two 8 MB files as base64) is refused (413) before it is parsed', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const r = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: admin.headers, payload: { ops: [], pad: 'x'.repeat(SYNC_BODY_LIMIT + 10) } });
    expect(r.statusCode).toBe(413);
  });

  it('a bad body is 400, and a device session may not send site entries', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    expect((await app.inject({ method: 'POST', url: '/api/sync/ops', headers: admin.headers, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/sync/ops', headers: admin.headers, payload: { ops: ['x'] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/sync/ops', headers: admin.headers, payload: { entries: [] } })).statusCode).toBe(400);
  });

  it('anonymous is 401', async () => {
    const app = makeApp();
    const r = await app.inject({ method: 'POST', url: '/api/sync/ops', remoteAddress: '10.168.1.50', payload: { ops: [] } });
    expect(r.statusCode).toBe(401);
  });

  it('the kiosk bus is told once per batch (and not at all when nothing changed)', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const bus = createChangeBus();
    const seen: number[] = [];
    bus.on((v) => seen.push(v));
    const bare = Fastify({ logger: false });
    apps.push(bare);
    bare.decorateRequest('auth', null);
    bare.addHook('onRequest', async (request) => {
      request.auth = resolveSession(app.surau.db, admin.token, AT);
    });
    registerSyncRoutes(bare, {
      db: app.surau.db, boxId: app.surau.boxId, dataDir: tempDir(), now: () => AT, limiters: createLimiters(), bus,
    });
    const ops = await batch(app, admin, [put('p1'), put('p2'), put('p3')]);
    const r = await bare.inject({ method: 'POST', url: '/api/sync/ops', payload: { ops } });
    expect(r.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(getVersion(app.surau.db));
    await bare.inject({ method: 'POST', url: '/api/sync/ops', payload: { ops } });
    expect(seen).toHaveLength(1);
  });
});

describe('snapshot and changes', () => {
  it('snapshot: AJK has no users or devices; Pentadbir has users and devices, never a pin or key', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const a = (await app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: ajk.headers })).json();
    expect(a.users).toBeUndefined();
    expect(a.devices).toBeUndefined();
    expect(a.boxId).toBe(app.surau.boxId);
    const p = await app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: admin.headers });
    const body = p.json();
    expect(body.users.length).toBeGreaterThanOrEqual(2);
    expect(body.devices.length).toBeGreaterThanOrEqual(2);
    expect(p.body.toLowerCase()).not.toContain('pin');
    expect(p.body).not.toContain('public_jwk');
    expect(p.body).not.toContain('"x"');
    expect(typeof body.seq).toBe('number');
    expect(body.settings.appLock).toBeUndefined();
  });

  it('changes?since= returns only newer entries, carries head, and pages', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    await postOps(app, admin, await batch(app, admin, [put('p1'), put('p2'), put('p3'), put('p4')]));
    const all = (await app.inject({ method: 'GET', url: '/api/sync/changes?since=0', headers: admin.headers })).json();
    const contents = all.entries.filter((e: { entity: string }) => e.entity === 'content:penceramah');
    expect(contents).toHaveLength(4);
    expect(all.head).toBe(all.seq);
    expect(all.next).toBeNull();
    const mid = contents[1].seq as number;
    const after = (await app.inject({ method: 'GET', url: `/api/sync/changes?since=${mid}`, headers: admin.headers })).json();
    expect(after.entries.every((e: { seq: number }) => e.seq > mid)).toBe(true);
    expect(after.entries.filter((e: { entity: string }) => e.entity === 'content:penceramah')).toHaveLength(2);
    const page = (await app.inject({ method: 'GET', url: `/api/sync/changes?since=0&limit=2`, headers: admin.headers })).json();
    expect(page.entries).toHaveLength(2);
    expect(page.next).toBe(page.entries[1].seq);
    expect(page.head).toBe(all.head);
    const rest = (await app.inject({ method: 'GET', url: `/api/sync/changes?since=${page.next}&limit=2`, headers: admin.headers })).json();
    expect(rest.entries[0].seq).toBeGreaterThan(page.next);
  });

  it('a page never exceeds 500 entries, whatever limit is asked', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ins = app.surau.db.prepare("INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json) VALUES (?, 'local', 'content:penceramah', ?, NULL, '{}')");
    for (let i = 0; i < 520; i++) ins.run('2026-11-03T03:00:00.000Z', `x${i}`);
    const r = (await app.inject({ method: 'GET', url: '/api/sync/changes?since=0&limit=9999', headers: admin.headers })).json();
    expect(r.entries).toHaveLength(500);
    expect(r.next).toBe(r.entries[499].seq);
  });

  it('changes scopes users and devices by permission', async () => {
    const app = makeApp();
    const ajk = await loginAs(app, 'ajk');
    const admin = await loginAs(app, 'admin');
    const seen = (r: { entries: { entity: string }[] }): Set<string> => new Set(r.entries.map((e) => e.entity));
    const asAjk = (await app.inject({ method: 'GET', url: '/api/sync/changes?since=0', headers: ajk.headers })).json();
    expect(seen(asAjk).has('user')).toBe(false);
    expect(seen(asAjk).has('device')).toBe(false);
    expect(seen(asAjk).has('users')).toBe(false);
    const asAdmin = (await app.inject({ method: 'GET', url: '/api/sync/changes?since=0', headers: admin.headers })).json();
    expect(seen(asAdmin).has('user')).toBe(true);
  });

  it('since below the retention floor is 410 snapshot_required', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    app.surau.db.prepare("INSERT INTO sync_state (key, value) VALUES ('log_floor', '50')").run();
    const r = await app.inject({ method: 'GET', url: '/api/sync/changes?since=10', headers: admin.headers });
    expect(r.statusCode).toBe(410);
    expect(r.json()).toMatchObject({ code: 'snapshot_required' });
    expect((await app.inject({ method: 'GET', url: '/api/sync/changes?since=50', headers: admin.headers })).statusCode).toBe(200);
  });

  it('a malformed since or limit is 400', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    for (const q of ['since=-1', 'since=abc', 'limit=0x', 'since=1e3', 'since=1&since=2']) {
      expect((await app.inject({ method: 'GET', url: `/api/sync/changes?${q}`, headers: admin.headers })).statusCode, q).toBe(400);
    }
  });
});

describe('site identity', () => {
  it('a site token reads the snapshot and changes, is 403 on /api/settings and every route outside its three families', async () => {
    const app = makeApp();
    await loginAs(app, 'admin');
    const site = insertSite(app.surau.db);
    const snap = await app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: site.headers });
    expect(snap.statusCode).toBe(200);
    expect(snap.json().users.length).toBeGreaterThan(0);
    expect(snap.body.toLowerCase()).not.toContain('pin');
    expect((await app.inject({ method: 'GET', url: '/api/sync/changes?since=0', headers: site.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/sync/status', headers: site.headers })).statusCode).toBe(200);
    for (const [method, url] of [
      ['GET', '/api/settings'], ['GET', '/api/users'], ['GET', '/api/devices'], ['GET', '/api/audit'], ['GET', '/api/kiosk/bundle'],
      ['GET', '/api/content/penceramah'], ['GET', '/api/auth/me'], ['POST', '/api/assets'], ['GET', '/api/live/status'],
      ['PUT', '/api/settings/clock'], ['POST', '/api/users'], ['GET', '/api/nope'], ['GET', '/api/kiosk/events'],
    ] as const) {
      const r = await app.inject({ method, url, headers: site.headers, payload: method === 'GET' ? undefined : {} });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
    // GET /assets/:id is its one non-API route: it reaches the handler (404 for an unknown id), not the 403
    const a = await app.inject({ method: 'GET', url: `/assets/${'a'.repeat(64)}`, headers: site.headers });
    expect(a.statusCode).toBe(404);
    // encoded or dotted paths cannot widen the reach
    expect((await app.inject({ method: 'GET', url: '/api/sync/../settings', headers: site.headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/assets/x', headers: site.headers, payload: {} })).statusCode).toBe(403);
  });

  it('an unlinked, revoked or unknown site key is no identity (401); a user token is not a site', async () => {
    const app = makeApp();
    const unlinked = insertSite(app.surau.db, { linked: false });
    const revoked = insertSite(app.surau.db, { revoked: true });
    for (const h of [unlinked.headers, revoked.headers, { authorization: 'Bearer ' + 'z'.repeat(43) }]) {
      const r = await app.inject({ method: 'GET', url: '/api/sync/snapshot', remoteAddress: '10.168.1.60', headers: h });
      expect(r.statusCode).toBe(401);
    }
    // the hash of a SESSION token is not a site key: a site key is never accepted as a user session either
    const site = insertSite(app.surau.db);
    expect(resolveSession(app.surau.db, site.token, AT)).toBeNull();
  });

  it('a site pushes feed entries: applied once, duplicate on redelivery, stamped box:<id>, and never echoed back', async () => {
    const app = makeApp();
    const site = insertSite(app.surau.db, { boxId: 'aaaabbbbccccdddd' });
    const opId = newOpId();
    const entry = {
      seq: 7, entity: 'content:penceramah', entityId: 'p1', rev: '2026-11-03T03:00:00.000Z|dev1',
      editedAt: '2026-11-03T03:00:00.000Z', syncedAt: '2026-11-03T03:00:01.000Z', actor: 'user:u1', deviceId: 'dev1',
      origin: 'app', opId, after: { id: 'p1', name: 'Dari kotak' },
    };
    const v0 = getVersion(app.surau.db);
    const r1 = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: site.headers, payload: { entries: [entry] } });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ applied: 1, duplicate: 0, refused: 0 });
    expect(getVersion(app.surau.db)).toBeGreaterThan(v0);
    const row = app.surau.db.prepare('SELECT origin, op_id FROM change_log WHERE op_id = ?').get(opId);
    expect(row).toMatchObject({ origin: 'app' });
    const r2 = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: site.headers, payload: { entries: [entry] } });
    expect(r2.json()).toMatchObject({ applied: 0, duplicate: 1 });

    // an entry the box made itself ('local') is stamped with the box origin and is never offered back to that box
    const own = { ...entry, entityId: 'p2', rev: '2026-11-03T03:00:00.000Z|local', deviceId: null, origin: 'local', opId: null, after: { id: 'p2', name: 'Lokal' } };
    const r3 = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: site.headers, payload: { entries: [own] } });
    expect(r3.json()).toMatchObject({ applied: 1 });
    const stamped = app.surau.db.prepare("SELECT origin FROM change_log WHERE entity_id = 'p2'").get();
    expect(stamped).toMatchObject({ origin: 'box:aaaabbbbccccdddd' });
    const changes = (await app.inject({ method: 'GET', url: '/api/sync/changes?since=0', headers: site.headers })).json();
    const ids = changes.entries.map((e: { entityId: string }) => e.entityId);
    expect(ids).toContain('p1');
    expect(ids).not.toContain('p2');
    expect(changes.head).toBeGreaterThan(0);
  });

  it('a site entry for another box, an echo of the cloud, a foreign entity or an op field is refused and logged', async () => {
    const app = makeApp();
    const site = insertSite(app.surau.db, { boxId: 'aaaabbbbccccdddd' });
    const base = {
      seq: 1, entity: 'content:penceramah', entityId: 'p9', rev: '2026-11-03T03:00:00.000Z|local',
      editedAt: '2026-11-03T03:00:00.000Z', syncedAt: '2026-11-03T03:00:01.000Z', actor: 'local', deviceId: null,
      origin: 'local', opId: null, after: { id: 'p9', name: 'X' },
    };
    const bad = [
      { ...base, origin: 'box:other' }, { ...base, origin: 'cloud' }, { ...base, entity: 'auth' },
      { ...base, entity: 'islamic' }, { ...base, actor: '../../x' }, 'x', { ...base, hack: 1 },
    ];
    const r = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: site.headers, payload: { entries: bad } });
    expect(r.json()).toMatchObject({ applied: 0, refused: 7 });
    expect(refusals(app)).toBe(7);
    expect(count(app, "SELECT COUNT(*) AS n FROM content_items")).toBe(0);
    expect((await app.inject({ method: 'POST', url: '/api/sync/ops', headers: site.headers, payload: { ops: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/sync/ops', headers: site.headers, payload: { entries: Array(501).fill(base) } })).statusCode).toBe(400);
    // a site of another surau is refused every entry
    const lain = insertSite(app.surau.db, { surauId: 'lain' });
    const r2 = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: lain.headers, payload: { entries: [base] } });
    expect(r2.json()).toMatchObject({ applied: 0, refused: 1 });
  });
});

describe('status and link', () => {
  it('status answers from sync_state on a box and is health:read', async () => {
    const app = makeApp();
    const ajk = await loginAs(app, 'ajk');
    const r = await app.inject({ method: 'GET', url: '/api/sync/status', headers: ajk.headers });
    expect(r.json()).toEqual({ linked: false, cloudUrl: null, lastPush: null, lastPull: null, pendingOut: 0, lastError: null, link: 'pending' });
    app.surau.db.prepare("INSERT INTO sync_state (key, value) VALUES ('linked','1'), ('cloud_url','https://c.example'), ('pending_out','3')").run();
    expect((await app.inject({ method: 'GET', url: '/api/sync/status', headers: ajk.headers })).json()).toMatchObject({ linked: true, cloudUrl: 'https://c.example', pendingOut: 3, link: 'linked' });
  });

  it('status on the cloud role counts linked sites', async () => {
    const app = makeApp({ role: 'cloud' });
    const admin = await loginAs(app, 'admin');
    expect((await app.inject({ method: 'GET', url: '/api/sync/status', headers: admin.headers })).json().linked).toBe(false);
    insertSite(app.surau.db);
    expect((await app.inject({ method: 'GET', url: '/api/sync/status', headers: admin.headers })).json().linked).toBe(true);
  });

  it('POST /api/sync/link does not exist on a box (404), and does not use up the enrolment limit', async () => {
    const app = makeApp();
    for (let i = 0; i < 8; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/sync/link', remoteAddress: '10.168.1.70', payload: {} });
      expect(r.statusCode).toBe(404);
    }
    expect(app.surau.limiters.enrolIp.hit('10.168.1.70').ok).toBe(true);
  });

  it('on the cloud role /api/sync/link is rate limited like enrolment (5 per 10 minutes per IP)', async () => {
    const app = makeApp({ role: 'cloud' });
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      codes.push((await app.inject({ method: 'POST', url: '/api/sync/link', remoteAddress: '10.168.1.71', payload: {} })).statusCode);
    }
    // an empty body is a 400 now that the exchange exists (Task 4); the limiter counts every try
    expect(codes).toEqual([400, 400, 400, 400, 400, 429, 429]);
  });
});

describe('hook wiring', () => {
  it('a bare server with the real hook and the sync routes refuses an unsigned caller before parsing the body', async () => {
    const app = makeApp();
    const bare = Fastify({ logger: false });
    apps.push(bare);
    bare.decorateRequest('auth', null);
    bare.addHook('onRequest', authHook({ db: app.surau.db, now: () => AT, limiters: createLimiters() }));
    registerSyncRoutes(bare, {
      db: app.surau.db, boxId: app.surau.boxId, dataDir: tempDir(), now: () => AT, limiters: createLimiters(), bus: createChangeBus(),
    });
    const r = await bare.inject({ method: 'POST', url: '/api/sync/ops', remoteAddress: '10.168.1.5', payload: { ops: [] } });
    expect(r.statusCode).toBe(401);
  });
});
