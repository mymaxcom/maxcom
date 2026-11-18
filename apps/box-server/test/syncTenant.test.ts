/*
 * Plan 14 Task 6: sync per surau. A cloud with two suraus (A and B, each with its own linked site and its own
 * phones) must never mix their feeds, snapshots, applied changes, op ids or dirty marks.
 *
 * Assumptions for the implementer
 *  1. Ids: A = 'surau-a', B = 'surau-b' (neither is 'sdm', so a result that lands in the old single-surau default
 *     is caught). Both exist in `suraus`; each has one linked site made with `insertSite` (token_hash set).
 *  2. Everything is driven over HTTP (`/api/sync/ops`, `/changes`, `/snapshot`, `/api/users`), so the internal
 *     signatures of `readFeed`, `snapshot` and `createSyncService` are free to change. The tenant of a site call
 *     is the site's own `sites.surau_id`; the tenant of a phone call is its device row.
 *  3. A refused entry shows as `refused: 1` with the code in the answer's `reasons` (the existing `note(...)`
 *     list), and as ONE `auth_log` row with `event = 'sync_refused'` whose detail contains the code. The foreign
 *     id codes: `foreign_id`.
 *  4. `foreign_id` is the refusal for the two tables that keep GLOBAL keys: `users` and `devices` (migration 019
 *     step 5). Content, settings and finance rows have per-surau keys (`surau_id` is part of the key), so the same
 *     id pushed by B is B's own row: it is applied in B and A's row stays byte-identical. The brief says "same for
 *     content, settings, finance"; the property tested is "A's row is never touched and B's data lands in B".
 *     If the implementer reads the plan as "refuse a content id that exists in A", say so: that would also break
 *     "the same opId / same id in two suraus both apply".
 *  5. The `*` rule: a `*` user, a device of a `*` user (or a device with `surau_id = '*'`) and their change_log rows
 *     reach EVERY site feed; nothing else filed under `*` does. The test makes the rows consistent either way:
 *     it files the `*` user's and device's change_log rows under surau '*' (a helper's `loginAs` tags them with the
 *     enrolling surau), and adds two noise rows under '*' for a content item and a setting, which no feed may carry.
 *  6. A surau session (admin of A) sees no `*` row in `/api/sync/changes` or `/api/users` (decision 22).
 *  7. Dirty marks are the `worker_outbox` rows `dirty/<boxId>`, made by the change_log trigger once the outbox is
 *     switched on (`setOutboxOn`). A change filed under A marks A's box only; one filed under '*' marks both.
 *  8. Device ops: `surauId` in a signed op is the tenant id or the wire alias 'sdm'; any other id is refused
 *     (`auth_log` detail `surau_mismatch`, answer reason `invalid`) and writes nothing.
 *  9. The box regression tests use a real box linked to a cloud (the syncAgent harness). They describe behaviour
 *     "as today" and must keep passing: a box pulls a `*` user from the cloud feed, and its own `*` user is still
 *     in its push (the cloud refuses it, `superadmin_cloud_only`, as it does now).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant } from '@surau/core';
import type { OpResult } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { createUser } from '../src/auth/users.ts';
import { putItem } from '../src/content/store.ts';
import { putFeature } from '../src/settingsStore.ts';
import { runCloudLink } from '../src/cli/cloudLink.ts';
import { issueLinkCode } from '../src/sync/sites.ts';
import { ensureSurau } from './support/surauRow.ts';
import { loadSyncKey } from '../src/sync/syncKey.ts';
import { setOutboxOn } from '../src/sync/workerOutbox.ts';
import { loginAs, TEST_PIN } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';
import { newOpId, signOp } from './support/signOp.ts';
import type { OpInput } from './support/signOp.ts';
import { insertSite } from './support/sites.ts';
import type { TestSite } from './support/sites.ts';

const A = 'surau-a';
const B = 'surau-b';
const BOX_A = 'a1a1a1a1a1a1a1a1';
const BOX_B = 'b2b2b2b2b2b2b2b2';
const AT = klInstant('2026-11-03', '12:00');
const EDITED = '2026-11-03T03:00:00.000Z';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const clouds: TestCloud[] = [];
afterEach(async () => {
  for (const c of clouds.splice(0)) await c.close();
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const noNetwork = (async () => { throw new TypeError('network disabled in tests'); }) as unknown as typeof fetch;

interface Rig { app: FastifyInstance; sa: TestSite; sb: TestSite }

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'surau-synctenant-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'c.db'), { dataDir: dir, role: 'cloud', now: () => AT, fetchImpl: noNetwork });
  apps.push(app);
  const ins = app.surau.db.prepare('INSERT INTO suraus (id, name, created_at, created_by) VALUES (?, ?, ?, ?)');
  ins.run(A, 'Surau A', AT.toISOString(), 'test');
  ins.run(B, 'Surau B', AT.toISOString(), 'test');
  const sa = insertSite(app.surau.db, { surauId: A, boxId: BOX_A });
  const sb = insertSite(app.surau.db, { surauId: B, boxId: BOX_B });
  return { app, sa, sb };
}

let seqN = 0;
interface Entry {
  seq: number; entity: string; entityId: string; rev: string; editedAt: string; syncedAt: string;
  actor: string; deviceId: string | null; origin: string; opId: string | null; after: unknown;
}
function entry(over: Partial<Entry> & { entity: string; entityId: string; after: unknown }): Entry {
  seqN += 1;
  return {
    seq: seqN, rev: `${EDITED}|local`, editedAt: EDITED, syncedAt: '2026-11-03T03:00:01.000Z',
    actor: 'local', deviceId: null, origin: 'local', opId: null, ...over,
  };
}
const contentEntry = (id: string, name: string, opId: string | null = null): Entry =>
  entry({ entity: 'content:penceramah', entityId: id, after: { id, name }, opId });

interface PushOut { applied: number; duplicate: number; superseded: number; refused: number; reasons: string[] }
async function push(app: FastifyInstance, site: TestSite, entries: unknown[]): Promise<PushOut> {
  const r = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: site.headers, payload: { entries } });
  expect(r.statusCode).toBe(200);
  return r.json() as PushOut;
}

interface Changes { entries: Array<{ entity: string; entityId: string; origin: string }>; head: number }
async function changes(app: FastifyInstance, headers: Record<string, string>): Promise<Changes> {
  const r = await app.inject({ method: 'GET', url: '/api/sync/changes?since=0', headers });
  expect(r.statusCode).toBe(200);
  return r.json() as Changes;
}
const idsOf = (c: Changes, entityPrefix: string): string[] =>
  c.entries.filter((e) => e.entity.startsWith(entityPrefix)).map((e) => e.entityId).sort();

async function snap(app: FastifyInstance, site: TestSite): Promise<{ seq: number; content: Record<string, Array<{ id: string }>> }> {
  const r = await app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: site.headers });
  expect(r.statusCode).toBe(200);
  return r.json() as { seq: number; content: Record<string, Array<{ id: string }>> };
}

const one = (app: FastifyInstance, sql: string, ...args: Array<string | number>) => app.surau.db.prepare(sql).get(...args);
const n = (app: FastifyInstance, sql: string, ...args: Array<string | number>): number => Number(one(app, sql, ...args)?.n ?? 0);
const refusals = (app: FastifyInstance): number => n(app, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'sync_refused'");
const refusalsWith = (app: FastifyInstance, code: string): number =>
  n(app, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'sync_refused' AND detail LIKE ?", `%${code}%`);
const logRows = (app: FastifyInstance, surau: string): number => n(app, 'SELECT COUNT(*) AS n FROM change_log WHERE surau_id = ?', surau);
const penc = (app: FastifyInstance, surau: string, id: string) =>
  one(app, "SELECT json, rev, edited_at FROM content_items WHERE surau_id = ? AND kind = 'penceramah' AND id = ?", surau, id);

function admins(app: FastifyInstance): Promise<[Login, Login]> {
  return Promise.all([loginAs(app, 'admin', TEST_PIN, A), loginAs(app, 'admin', TEST_PIN, B)]);
}

describe('the feed and the snapshot are per surau', () => {
  it('site A pushes 3 entries: A applies them, B sees none of it and its head does not move', async () => {
    const { app, sa, sb } = rig();
    const db = app.surau.db;
    putItem(db, 'penceramah', { id: 'a-direct', name: 'Dari A' }, 'local', undefined, A);
    putItem(db, 'penceramah', { id: 'b-direct', name: 'Dari B' }, 'local', undefined, B);

    const bBefore = await changes(app, sb.headers);
    const aBefore = await changes(app, sa.headers);
    expect(idsOf(bBefore, 'content:')).toEqual(['b-direct']);
    expect(idsOf(aBefore, 'content:')).toEqual(['a-direct']);
    expect(bBefore.head).toBeGreaterThan(0);
    const bSnapBefore = await snap(app, sb);

    // success path: A's three entries land in A
    const out = await push(app, sa, [contentEntry('p1', 'Satu'), contentEntry('p2', 'Dua'), contentEntry('p3', 'Tiga')]);
    expect(out).toMatchObject({ applied: 3, duplicate: 0, refused: 0 });
    expect(n(app, 'SELECT COUNT(*) AS n FROM content_items WHERE surau_id = ?', A)).toBe(4);
    expect(n(app, 'SELECT COUNT(*) AS n FROM content_items WHERE surau_id = ?', B)).toBe(1);
    const aAfter = await changes(app, sa.headers);
    expect(aAfter.head).toBeGreaterThan(aBefore.head);
    expect(idsOf(aAfter, 'content:')).toEqual(['a-direct']); // its own pushes are never echoed back to it

    // B: nothing new in the feed, same head, snapshot unchanged
    const bAfter = await changes(app, sb.headers);
    expect(idsOf(bAfter, 'content:')).toEqual(['b-direct']);
    expect(bAfter.head).toBe(bBefore.head);
    const bSnap = await snap(app, sb);
    expect(bSnap.content.penceramah!.map((i) => i.id)).toEqual(['b-direct']);
    expect(bSnap.seq).toBe(bSnapBefore.seq);
    expect(bSnap.seq).toBe(bBefore.head);

    // and A's snapshot holds exactly A's four, none of B's
    const aSnap = await snap(app, sa);
    expect(aSnap.content.penceramah!.map((i) => i.id).sort()).toEqual(['a-direct', 'p1', 'p2', 'p3']);
    expect(aSnap.seq).toBe(aAfter.head);
  });
});

describe('a site cannot take an id that belongs to another surau', () => {
  it('user: B sends an entry with the id of A\'s user: refused foreign_id, one auth_log row, A\'s row unchanged; B\'s own new user is applied', async () => {
    const { app, sa, sb } = rig();
    const [adminA] = await admins(app);
    const before = JSON.stringify(one(app, 'SELECT * FROM users WHERE id = ?', adminA.userId));
    const logsA = logRows(app, A);
    const refused0 = refusals(app);

    const out = await push(app, sb, [entry({ entity: 'user', entityId: adminA.userId, after: { name: 'Dirampas', roles: ['admin'], active: false } })]);
    expect(out).toMatchObject({ applied: 0, refused: 1 });
    // the site is told plain invalid (qs-gate S8); the server log keeps foreign_id
    expect(out.reasons).toContain('invalid');
    expect(out.reasons).not.toContain('foreign_id');
    expect(refusals(app) - refused0).toBe(1);
    expect(refusalsWith(app, 'foreign_id')).toBe(1);
    expect(JSON.stringify(one(app, 'SELECT * FROM users WHERE id = ?', adminA.userId))).toBe(before);
    expect(logRows(app, A)).toBe(logsA);

    // success path: a user B really owns is made and filed under B
    const ok = await push(app, sb, [entry({ entity: 'user', entityId: 'b-new-user', after: { name: 'Pengguna B', roles: ['ajk'], active: true } })]);
    expect(ok).toMatchObject({ applied: 1, refused: 0 });
    expect(one(app, 'SELECT surau_id FROM users WHERE id = ?', 'b-new-user')?.surau_id).toBe(B);
    void sa;
  });

  it('device: B sends a revoke for A\'s device: refused foreign_id, one auth_log row, A\'s device stays live; B revoking its own device is applied', async () => {
    const { app, sb } = rig();
    const [adminA, adminB] = await admins(app);
    const before = JSON.stringify(one(app, 'SELECT * FROM devices WHERE id = ?', adminA.deviceId));
    const refused0 = refusals(app);

    const out = await push(app, sb, [entry({ entity: 'device', entityId: adminA.deviceId, after: { revoked: true } })]);
    expect(out).toMatchObject({ applied: 0, refused: 1 });
    // the site is told plain invalid (qs-gate S8); the server log keeps foreign_id
    expect(out.reasons).toContain('invalid');
    expect(out.reasons).not.toContain('foreign_id');
    expect(refusals(app) - refused0).toBe(1);
    expect(refusalsWith(app, 'foreign_id')).toBe(1);
    expect(JSON.stringify(one(app, 'SELECT * FROM devices WHERE id = ?', adminA.deviceId))).toBe(before);
    expect(one(app, 'SELECT revoked_at FROM devices WHERE id = ?', adminA.deviceId)?.revoked_at).toBeNull();

    const ok = await push(app, sb, [entry({ entity: 'device', entityId: adminB.deviceId, after: { revoked: true } })]);
    expect(ok).toMatchObject({ applied: 1, refused: 0 });
    expect(one(app, 'SELECT revoked_at FROM devices WHERE id = ?', adminB.deviceId)?.revoked_at).not.toBeNull();
  });

  it('content: B pushes the id A already uses: A\'s item is untouched and B gets its own item', async () => {
    const { app, sb } = rig();
    putItem(app.surau.db, 'penceramah', { id: 'sama', name: 'Milik A' }, 'local', undefined, A);
    const before = JSON.stringify(penc(app, A, 'sama'));
    const logsA = logRows(app, A);
    const out = await push(app, sb, [contentEntry('sama', 'Milik B')]);
    expect(out).toMatchObject({ applied: 1, refused: 0 });
    expect(JSON.stringify(penc(app, A, 'sama'))).toBe(before);
    expect(logRows(app, A)).toBe(logsA);
    expect(JSON.parse(String(penc(app, B, 'sama')?.json)).name).toBe('Milik B');
  });

  it('settings: B pushes a setting A also has: A\'s value is untouched and B holds its own', async () => {
    const { app, sb } = rig();
    putFeature(app.surau.db, 'zone', { zone: 'SGR01' }, 'local', undefined, A);
    const zoneOf = (surau: string) => one(app, "SELECT json, rev FROM settings WHERE surau_id = ? AND feature = 'zone'", surau);
    const before = JSON.stringify(zoneOf(A));
    const logsA = logRows(app, A);
    const out = await push(app, sb, [entry({ entity: 'settings', entityId: 'zone', after: { zone: 'SGR02' } })]);
    expect(out).toMatchObject({ applied: 1, refused: 0 });
    expect(JSON.stringify(zoneOf(A))).toBe(before);
    expect(logRows(app, A)).toBe(logsA);
    expect(JSON.parse(String(zoneOf(B)?.json)).zone).toBe('SGR02');
  });

  it('finance: B pushes a fund id A already uses: A\'s fund is untouched and B gets its own', async () => {
    const { app, sa, sb } = rig();
    const seed = await push(app, sa, [entry({ entity: 'finance:fund', entityId: 'f1', after: { name: 'Tabung A', public: true, sortOrder: 2 } })]);
    expect(seed).toMatchObject({ applied: 1, refused: 0 });
    const fundOf = (surau: string) => one(app, 'SELECT name, rev FROM finance_funds WHERE surau_id = ? AND id = ?', surau, 'f1');
    const before = JSON.stringify(fundOf(A));
    const logsA = logRows(app, A);
    const out = await push(app, sb, [entry({ entity: 'finance:fund', entityId: 'f1', after: { name: 'Tabung B', public: true, sortOrder: 2 } })]);
    expect(out).toMatchObject({ applied: 1, refused: 0 });
    expect(JSON.stringify(fundOf(A))).toBe(before);
    expect(logRows(app, A)).toBe(logsA);
    expect(fundOf(B)?.name).toBe('Tabung B');
  });
});

describe('op ids are per surau', () => {
  it('the same opId pushed by two sites applies in both; a replay in one is a duplicate', async () => {
    const { app, sa, sb } = rig();
    const opId = newOpId();
    const ra = await push(app, sa, [contentEntry('p1', 'Dari A', opId)]);
    const rb = await push(app, sb, [contentEntry('p1', 'Dari B', opId)]);
    expect(ra).toMatchObject({ applied: 1, duplicate: 0, refused: 0 });
    expect(rb).toMatchObject({ applied: 1, duplicate: 0, refused: 0 });
    const seen = app.surau.db.prepare('SELECT surau_id FROM applied_ops WHERE op_id = ? ORDER BY surau_id').all(opId).map((r) => r.surau_id);
    expect(seen).toEqual([A, B]);
    expect(JSON.parse(String(penc(app, A, 'p1')?.json)).name).toBe('Dari A');
    expect(JSON.parse(String(penc(app, B, 'p1')?.json)).name).toBe('Dari B');
    expect(await push(app, sa, [contentEntry('p1', 'Dari A', opId)])).toMatchObject({ applied: 0, duplicate: 1 });
  });

  it('the same opId from a phone of each surau applies in both; a replay is a duplicate', async () => {
    const { app } = rig();
    const [adminA, adminB] = await admins(app);
    const opId = newOpId();
    const put = (name: string): OpInput => ({ kind: 'content.put', entity: 'content:penceramah', entityId: 'p1', payload: { name }, opId });
    const send = async (login: Login, surauId: string, name: string): Promise<OpResult> => {
      const op = await signOp(login, app.surau.boxId, { ...put(name), surauId });
      const r = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: login.headers, payload: { ops: [op] } });
      expect(r.statusCode).toBe(200);
      return (r.json() as { results: OpResult[] }).results[0]!;
    };
    expect((await send(adminA, A, 'Ustaz A')).status).toBe('applied');
    expect((await send(adminB, B, 'Ustaz B')).status).toBe('applied');
    expect(JSON.parse(String(penc(app, A, 'p1')?.json)).name).toBe('Ustaz A');
    expect(JSON.parse(String(penc(app, B, 'p1')?.json)).name).toBe('Ustaz B');
    expect(n(app, 'SELECT COUNT(*) AS n FROM applied_ops WHERE op_id = ?', opId)).toBe(2);
    expect((await send(adminA, A, 'Ustaz A')).status).toBe('duplicate');
  });
});

describe('device ops name their surau', () => {
  it('a phone of B sending surauId "sdm" (the wire alias) applies in B, and its own id works too', async () => {
    const { app } = rig();
    const [, adminB] = await admins(app);
    const send = async (input: OpInput) => {
      const op = await signOp(adminB, app.surau.boxId, input);
      const r = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: adminB.headers, payload: { ops: [op] } });
      return (r.json() as { results: OpResult[] }).results[0]!;
    };
    const alias = await send({ kind: 'content.put', entity: 'content:penceramah', entityId: 'p-alias', payload: { name: 'Alias' }, surauId: 'sdm' });
    expect(alias.status).toBe('applied');
    expect(JSON.parse(String(penc(app, B, 'p-alias')?.json)).name).toBe('Alias');
    expect(penc(app, A, 'p-alias')).toBeUndefined();
    expect(penc(app, 'sdm', 'p-alias')).toBeUndefined();
    const own = await send({ kind: 'content.put', entity: 'content:penceramah', entityId: 'p-own', payload: { name: 'Sendiri' }, surauId: B });
    expect(own.status).toBe('applied');
    expect(JSON.parse(String(penc(app, B, 'p-own')?.json)).name).toBe('Sendiri');
  });

  it('a phone of B sending the id of A is refused surau_mismatch, one auth_log row, nothing written anywhere', async () => {
    const { app } = rig();
    const [, adminB] = await admins(app);
    const changeRows = n(app, 'SELECT COUNT(*) AS n FROM change_log WHERE entity LIKE ?', 'content:%');
    const refused0 = refusals(app);
    const op = await signOp(adminB, app.surau.boxId, { kind: 'content.put', entity: 'content:penceramah', entityId: 'p-evil', payload: { name: 'Jahat' }, surauId: A });
    const r = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: adminB.headers, payload: { ops: [op] } });
    const res = (r.json() as { results: OpResult[] }).results[0]!;
    expect(res.status).toBe('refused');
    expect(refusals(app) - refused0).toBe(1);
    expect(refusalsWith(app, 'surau_mismatch')).toBe(1);
    expect(n(app, 'SELECT COUNT(*) AS n FROM change_log WHERE entity LIKE ?', 'content:%')).toBe(changeRows);
    expect(penc(app, A, 'p-evil')).toBeUndefined();
    expect(penc(app, B, 'p-evil')).toBeUndefined();
    expect(n(app, 'SELECT COUNT(*) AS n FROM applied_ops WHERE op_id = ?', op.opId)).toBe(0);
  });
});

describe('the Pentadbir MAXCOM (`*`) rows', () => {
  async function starRig() {
    const r = rig();
    const star = await loginAs(r.app, 'superadmin');
    const [adminA, adminB] = await admins(r.app);
    const db = r.app.surau.db;
    // preconditions: an ops account and an ops device are filed under '*'
    expect(one(r.app, 'SELECT surau_id FROM users WHERE id = ?', star.userId)?.surau_id).toBe('*');
    expect(one(r.app, 'SELECT surau_id FROM devices WHERE id = ?', star.deviceId)?.surau_id).toBe('*');
    // the helper files their change_log rows under the enrolling surau; file them where the feed rule looks
    db.prepare(
      "UPDATE change_log SET surau_id = '*' WHERE (entity IN ('users', 'user') AND entity_id = ?) OR (entity IN ('devices', 'device') AND entity_id = ?)",
    ).run(star.userId, star.deviceId);
    expect(n(r.app, "SELECT COUNT(*) AS n FROM change_log WHERE surau_id = '*' AND entity IN ('users','user')")).toBeGreaterThan(0);
    expect(n(r.app, "SELECT COUNT(*) AS n FROM change_log WHERE surau_id = '*' AND entity IN ('devices','device')")).toBeGreaterThan(0);
    // two other `*` rows that no feed may carry
    const ins = db.prepare(
      `INSERT INTO change_log (surau_id, at, actor, entity, entity_id, after_json, origin, edited_at, synced_at, rev)
       VALUES ('*', ?, 'local', ?, ?, ?, 'local', ?, ?, ?)`,
    );
    ins.run(AT.toISOString(), 'content:penceramah', 'star-noise', '{"id":"star-noise","name":"x"}', EDITED, EDITED, `${EDITED}|local`);
    ins.run(AT.toISOString(), 'settings', 'zone', '{"zone":"SGR09"}', EDITED, EDITED, `${EDITED}|local`);
    return { ...r, star, adminA, adminB };
  }

  it('the `*` user and device are in both sites\' feeds, and no other `*` row is', async () => {
    const { app, sa, sb, star, adminA, adminB } = await starRig();
    const ca = await changes(app, sa.headers);
    const cb = await changes(app, sb.headers);
    for (const c of [ca, cb]) {
      expect(c.entries.filter((e) => ['user', 'users'].includes(e.entity)).map((e) => e.entityId)).toContain(star.userId);
      expect(c.entries.filter((e) => ['device', 'devices'].includes(e.entity)).map((e) => e.entityId)).toContain(star.deviceId);
      expect(c.entries.map((e) => e.entityId)).not.toContain('star-noise');
      expect(c.entries.some((e) => e.entity === 'settings' && e.entityId === 'zone')).toBe(false);
    }
    // each site still gets its own surau's people and not the other's
    const users = (c: Changes) => c.entries.filter((e) => ['user', 'users'].includes(e.entity)).map((e) => e.entityId);
    expect(users(ca)).toContain(adminA.userId);
    expect(users(ca)).not.toContain(adminB.userId);
    expect(users(cb)).toContain(adminB.userId);
    expect(users(cb)).not.toContain(adminA.userId);
    // and the `*` content/setting noise is not in a snapshot either
    for (const s of [sa, sb]) {
      const sn = await snap(app, s);
      expect(sn.content.penceramah ?? []).toEqual([]);
    }
  });

  it('a surau session never sees a `*` row: not in the feed, not in the user list', async () => {
    const { app, star, adminA, adminB } = await starRig();
    for (const login of [adminA, adminB]) {
      const c = await changes(app, login.headers);
      const ids = c.entries.map((e) => e.entityId);
      expect(ids).not.toContain(star.userId);
      expect(ids).not.toContain(star.deviceId);
      const list = await app.inject({ method: 'GET', url: '/api/users', headers: login.headers });
      expect(list.statusCode).toBe(200);
      const listed = (list.json() as { users: Array<{ id: string }> }).users.map((u) => u.id);
      expect(listed).not.toContain(star.userId);
      expect(listed).toContain(login.userId);
    }
    // success path of the same session: it does see its own people
    const own = await changes(app, adminA.headers);
    expect(own.entries.map((e) => e.entityId)).toContain(adminA.userId);
    expect(own.entries.map((e) => e.entityId)).not.toContain(adminB.userId);
  });
});

describe('dirty marks go to the boxes of the changed surau', () => {
  const dirty = (app: FastifyInstance): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const r of app.surau.db.prepare("SELECT key, body FROM worker_outbox WHERE kind = 'dirty' ORDER BY key").all()) {
      out[String(r.key)] = Number((JSON.parse(String(r.body)) as { seq: number }).seq);
    }
    return out;
  };
  const headOf = (app: FastifyInstance): number => n(app, 'SELECT MAX(id) AS n FROM change_log');

  it('a change in A marks A\'s box only; a change in B then marks B\'s without moving A\'s', () => {
    const { app } = rig();
    const db = app.surau.db;
    setOutboxOn(db, true);
    putItem(db, 'penceramah', { id: 'p1', name: 'Satu' }, 'local', undefined, A);
    const afterA = headOf(app);
    expect(dirty(app)).toEqual({ [`dirty/${BOX_A}`]: afterA });

    putItem(db, 'penceramah', { id: 'p2', name: 'Dua' }, 'local', undefined, B);
    const afterB = headOf(app);
    expect(afterB).toBeGreaterThan(afterA);
    expect(dirty(app)).toEqual({ [`dirty/${BOX_A}`]: afterA, [`dirty/${BOX_B}`]: afterB });
  });

  it('a change a site pushed does not mark that site\'s own box, nor the other surau\'s', async () => {
    const { app, sa } = rig();
    setOutboxOn(app.surau.db, true);
    const out = await push(app, sa, [contentEntry('p1', 'Dari kotak A')]);
    expect(out).toMatchObject({ applied: 1 });
    expect(dirty(app)).toEqual({});
  });

  it('a change to a `*` user marks the boxes of every surau', () => {
    const { app } = rig();
    const db = app.surau.db;
    setOutboxOn(db, true);
    const star = createUser(db, { name: 'Pentadbir MAXCOM', roles: ['ajk'] }, 'test', '*');
    expect(one(app, 'SELECT surau_id FROM users WHERE id = ?', star.id)?.surau_id).toBe('*');
    const head = headOf(app);
    expect(dirty(app)).toEqual({ [`dirty/${BOX_A}`]: head, [`dirty/${BOX_B}`]: head });
  });
});

/** Make the user a superadmin and leave exactly one feed row for it that says so (what the CLI's promote step leaves). */
function fileAsSuperadmin(db: import('node:sqlite').DatabaseSync, userId: string, name: string): void {
  db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(['superadmin']), userId);
  db.prepare("DELETE FROM change_log WHERE entity IN ('users', 'user') AND entity_id = ?").run(userId);
  db.prepare(
    `INSERT INTO change_log (surau_id, at, actor, entity, entity_id, after_json, origin, edited_at, synced_at, rev)
     VALUES ('*', ?, 'local', 'users', ?, ?, 'local', ?, ?, ?)`,
  ).run(AT.toISOString(), userId, JSON.stringify({ id: userId, name, roles: ['superadmin'], active: true }), EDITED, EDITED, `${EDITED}|local`);
}

describe('a box keeps pushing and pulling `*` rows as today', () => {
  interface Pair { box: FastifyInstance; boxDir: string; cloud: TestCloud; worker: FakeWorker }
  async function makePair(): Promise<Pair> {
    const boxDir = mkdtempSync(join(tmpdir(), 'surau-tenantbox-'));
    dirs.push(boxDir);
    const hook = { fetch: (undefined as unknown) as typeof fetch };
    const box = buildApp(join(boxDir, 'box.db'), {
      dataDir: boxDir,
      sync: { fetchImpl: ((i: Parameters<typeof fetch>[0], init?: RequestInit) => hook.fetch(i, init)) as typeof fetch, sleep: async () => undefined },
    });
    apps.push(box);
    const boxId = box.surau.boxId;
    const cloud = buildCloud(boxId);
    clouds.push(cloud);
    const worker = new FakeWorker(cloud.fetch);
    hook.fetch = worker.fetch;
    const { code } = issueLinkCode({ db: cloud.app.surau.db, now: () => new Date() }, { boxId, name: 'Surau D\'Waqaf', target: { surauId: ensureSurau(cloud.app.surau.db) } });
    const lines: string[] = [];
    const exit = await runCloudLink(['--data', boxDir, '--db', join(boxDir, 'box.db'), 'link', CLOUD_URL, code], { out: (l) => lines.push(l), err: (l) => lines.push(l) }, worker.fetch);
    expect(exit).toBe(0);
    worker.setSecret(boxId, loadSyncKey(boxDir)!.wakeSecret);
    return { box, boxDir, cloud, worker };
  }

  it('a `*` user made on the cloud reaches the box through the feed', async () => {
    const p = await makePair();
    const cdb = p.cloud.app.surau.db;
    const star = createUser(cdb, { name: 'Pentadbir MAXCOM', roles: ['ajk'] }, 'test', '*');
    fileAsSuperadmin(cdb, star.id, star.name);
    expect(p.box.surau.db.prepare('SELECT id FROM users WHERE id = ?').get(star.id)).toBeUndefined();
    await p.box.syncAgent!.runOnce();
    const got = p.box.surau.db.prepare('SELECT roles_json FROM users WHERE id = ?').get(star.id);
    expect(got).toBeDefined();
    expect(String(got?.roles_json)).toContain('superadmin');
  });

  it('a `*` user made on the box is still in its push: the cloud refuses it as superadmin_cloud_only and keeps no row', async () => {
    const p = await makePair();
    const star = await loginAs(p.box, 'superadmin');
    fileAsSuperadmin(p.box.surau.db, star.userId, 'Pentadbir MAXCOM');
    await p.box.syncAgent!.runOnce();
    expect(p.cloud.app.surau.db.prepare('SELECT id FROM users WHERE id = ?').get(star.userId)).toBeUndefined();
    expect(p.cloud.app.surau.db.prepare('SELECT id FROM devices WHERE id = ?').get(star.deviceId)).toBeUndefined();
    expect(refusalsWith(p.cloud.app, 'superadmin_cloud_only')).toBeGreaterThan(0);
  });
});
