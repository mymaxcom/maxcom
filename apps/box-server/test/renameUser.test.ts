import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { applyFeedEntry } from '../src/sync/apply.ts';
import type { FeedEntry } from '@surau/core';
import { createUser, renameUser } from '../src/auth/users.ts';
import { loginAs } from './authHelpers.ts';
import { signOp } from './support/signOp.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp(role: 'box' | 'cloud' = 'box'): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-rename-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir, role });
  apps.push(app);
  return app;
}

const rename = (app: FastifyInstance, headers: Record<string, string>, id: string, name: unknown) =>
  app.inject({ method: 'PUT', url: `/api/users/${id}/name`, headers, payload: { name } });
const nameOf = (db: DatabaseSync, id: string): string => String(db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name);
const usersLog = (db: DatabaseSync, id: string): Array<Record<string, unknown>> =>
  db.prepare("SELECT before_json, after_json, actor_name FROM change_log WHERE entity = 'users' AND entity_id = ? ORDER BY id").all(id) as Array<Record<string, unknown>>;

describe('[PP-S2] rename a user', () => {
  it('[PP-S2] a Pentadbir renames; the list shows it; one log row has the old and the new name', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const u = createUser(app.surau.db, { name: 'Ustaz Ahmad', roles: ['ajk'] }, 'test', 'sdm');
    const before = usersLog(app.surau.db, u.id).length;
    const r = await rename(app, admin.headers, u.id, 'Ustaz Ahmad bin Ali');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ id: u.id, name: 'Ustaz Ahmad bin Ali' });
    const list = (await app.inject({ method: 'GET', url: '/api/users', headers: admin.headers })).json().users as Array<{ id: string; name: string }>;
    expect(list.find((x) => x.id === u.id)?.name).toBe('Ustaz Ahmad bin Ali');
    const rows = usersLog(app.surau.db, u.id);
    expect(rows.length).toBe(before + 1);
    const last = rows[rows.length - 1]!;
    expect(JSON.parse(String(last.before_json)).name).toBe('Ustaz Ahmad');
    expect(JSON.parse(String(last.after_json)).name).toBe('Ustaz Ahmad bin Ali');
  });

  it('[PP-S2] an earlier audit row by that user still shows the old name', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const u = await loginAs(app, 'admin');
    const oldName = nameOf(app.surau.db, u.userId);
    app.surau.db.prepare("UPDATE users SET name = ? WHERE id = ?").run(oldName, u.userId);
    // a change made by that user, before the rename
    const put = await app.inject({ method: 'PUT', url: `/api/users/${admin.userId}/name`, headers: u.headers, payload: { name: 'Nama Pertama' } });
    expect(put.statusCode, put.body).toBe(200);
    expect((await rename(app, admin.headers, u.userId, 'Encik Rahman')).statusCode).toBe(200);
    const audit = (await app.inject({ method: 'GET', url: '/api/audit?limit=200', headers: admin.headers })).json().entries as Array<{ entityId: string; userName: string | null; userId?: string }>;
    const first = audit.find((e) => e.entityId === admin.userId);
    expect(first?.userName).toBe(oldName);
  });

  it('[PP-S2] the name rule: empty, 81 characters, a control character and U+202E are refused; spaces are collapsed', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const u = createUser(app.surau.db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', 'sdm');
    for (const bad of ['', '   ', 'x'.repeat(81), 'A\u0000B', 'A‮B', 'A⁦B', 'A\u007FB', 'A\nB', 42, null]) {
      const r = await rename(app, admin.headers, u.id, bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      expect(r.json().code).toBe('bad_name');
    }
    expect(nameOf(app.surau.db, u.id)).toBe('Kak Siti');
    expect((await rename(app, admin.headers, u.id, 'x'.repeat(80))).statusCode).toBe(200);
    const r = await rename(app, admin.headers, u.id, '  Encik   Rahman  ');
    expect(r.statusCode).toBe(200);
    expect(nameOf(app.surau.db, u.id)).toBe('Encik Rahman');
  });

  it('[PP-S2] the same name again writes no log row', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const u = createUser(app.surau.db, { name: 'Haji Osman', roles: ['ajk'] }, 'test', 'sdm');
    const n = usersLog(app.surau.db, u.id).length;
    expect((await rename(app, admin.headers, u.id, '  Haji   Osman ')).statusCode).toBe(200);
    expect(usersLog(app.surau.db, u.id).length).toBe(n);
  });

  it('[PP-S2] a Bendahari gets 403', async () => {
    const app = makeApp();
    const treasurer = await loginAs(app, 'treasurer');
    const u = createUser(app.surau.db, { name: 'Puan Aminah', roles: ['ajk'] }, 'test', 'sdm');
    expect((await rename(app, treasurer.headers, u.id, 'Lain')).statusCode).toBe(403);
    expect(nameOf(app.surau.db, u.id)).toBe('Puan Aminah');
  });

  it('[PP-S2] an unknown id, another surau and a Pentadbir MAXCOM answer 404; the star one is logged', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const star = await loginAs(app, 'superadmin');
    const db = app.surau.db;
    db.prepare("INSERT OR IGNORE INTO suraus (id, name, created_at, created_by) VALUES ('lain', 'Surau Lain', '2026-11-01T00:00:00.000Z', 'test')").run();
    const other = createUser(db, { name: 'Orang Lain', roles: ['ajk'] }, 'test', 'lain');
    const logged = (): number => Number(db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE event = 'star_target_refused'").get()?.n);
    const n0 = logged();
    const oldStar = nameOf(db, star.userId);
    expect((await rename(app, admin.headers, 'no-such-id', 'X')).statusCode).toBe(404);
    expect((await rename(app, admin.headers, other.id, 'X')).statusCode).toBe(404);
    const s = await rename(app, admin.headers, star.userId, 'X');
    expect(s.statusCode).toBe(404);
    expect(s.json().code).toBe('not_found');
    expect(logged() - n0).toBe(1);
    expect(nameOf(db, star.userId)).toBe(oldStar);
    expect(nameOf(db, other.id)).toBe('Orang Lain');
  });

  it('[PP-S2] on a server with role cloud the route works for a surau user', async () => {
    const app = makeApp('cloud');
    const admin = await loginAs(app, 'admin');
    const u = createUser(app.surau.db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', 'sdm');
    const r = await rename(app, admin.headers, u.id, 'Kak Siti binti Ali');
    expect(r.statusCode, r.body).toBe(200);
    expect(nameOf(app.surau.db, u.id)).toBe('Kak Siti binti Ali');
  });

  it('[PP-S2] renameUser is a no-op for the same cleaned name and a 404 for an unknown id', () => {
    const db = openDb(':memory:');
    dbs.push(db);
    const u = createUser(db, { name: 'Encik Rahman', roles: ['ajk'] }, 'test', 'sdm');
    expect(renameUser(db, u.id, 'Encik  Rahman', 'user:x').name).toBe('Encik Rahman');
    expect(() => renameUser(db, 'nope', 'Y', 'user:x')).toThrowError(/tidak dijumpai/i);
  });

  it('[PP-S2] the feed entry of the rename changes the name on a second database', () => {
    const a = openDb(':memory:');
    const b = openDb(':memory:');
    dbs.push(a, b);
    const u = createUser(a, { name: 'Ustaz Ahmad', roles: ['ajk'] }, 'test', 'sdm');
    const toEntry = (r: Record<string, unknown>, seq: number): FeedEntry => ({
      seq,
      entity: 'user',
      entityId: u.id,
      rev: String(r.rev),
      editedAt: String(r.edited_at),
      syncedAt: String(r.edited_at),
      actor: String(r.actor),
      deviceId: null,
      origin: 'local',
      opId: null,
      after: JSON.parse(String(r.after_json)),
    });
    renameUser(a, u.id, 'Ustaz Ahmad bin Ali', 'user:x');
    const rows = a.prepare("SELECT rev, edited_at, actor, after_json FROM change_log WHERE entity = 'users' AND entity_id = ? ORDER BY id").all(u.id) as Array<Record<string, unknown>>;
    const ctx = { surauId: 'sdm', now: new Date(Date.now() + 3600_000), origin: 'box:b1', actor: 'user:x', dataDir: tmpdir() };
    expect(applyFeedEntry(b, toEntry(rows[0]!, 1), ctx).status).toBe('applied');
    expect(nameOf(b, u.id)).toBe('Ustaz Ahmad');
    const stamp = new Date(Date.parse(String(rows[1]!.edited_at)) + 5000).toISOString();
    const later = { ...toEntry(rows[1]!, 2), editedAt: stamp, rev: `${stamp}|dev-a` };
    expect(applyFeedEntry(b, later, ctx).status).toBe('applied');
    expect(nameOf(b, u.id)).toBe('Ustaz Ahmad bin Ali');
  });

  it('[PP-S2] a user.put op carrying only a name still applies', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const media = await loginAs(app, 'media');
    const signed = await signOp(admin, app.surau.boxId, {
      kind: 'user.put', entity: 'user', entityId: media.userId, payload: { name: 'Nama Op' }, editedAt: new Date().toISOString(),
    });
    const r = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: admin.headers, payload: { ops: [signed] } });
    expect(r.json().results[0].status).toBe('applied');
    expect(nameOf(app.surau.db, media.userId)).toBe('Nama Op');
  });
});
