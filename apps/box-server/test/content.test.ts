import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klDateOf } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { loginAs, withAdmin } from './authHelpers.ts';
import type { AdminApp } from './authHelpers.ts';
import { actorOf } from '../src/actor.ts';
import { ContentError, deleteItem, getItem, listItems, putItem } from '../src/content/store.ts';
import { openDb } from '../src/db.ts';
import { runMigrations } from '../src/migrations/index.ts';
import { getVersion } from '../src/settingsStore.ts';

const openDbs: DatabaseSync[] = [];
const tempDirs: string[] = [];

function newDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'surau-content-'));
  tempDirs.push(dir);
  const db = openDb(join(dir, 'test.db'));
  openDbs.push(db);
  return db;
}

function logRows(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM change_log ORDER BY id').all();
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A Kuala Lumpur date `n` days from the real today (the delete rule counts only kuliah of today or later). */
const inDays = (n: number): string => klDateOf(new Date(Date.now() + n * 86_400_000));

const kuliahFor = (penceramahId: string, extra: Record<string, unknown> = {}) => ({
  date: inDays(2),
  slot: 'maghrib',
  time: '19:15',
  label: 'Kuliah Maghrib',
  penceramahId,
  status: 'aktif',
  ...extra,
});

function expectContentError(fn: () => unknown, status: number, text: RegExp): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ContentError);
    expect((e as ContentError).status).toBe(status);
    expect((e as ContentError).errors.join(';')).toMatch(text);
    return;
  }
  throw new Error('expected ContentError');
}

describe('002-content migration', () => {
  it('is applied by openDb and a second run applies nothing', () => {
    const db = newDb();
    const names = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r) => r.name);
    expect(names).toContain('002-content');
    expect(runMigrations(db)).toEqual([]);
    for (const t of ['content_items', 'assets', 'islamic_cache']) {
      expect(db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', t)).toBeDefined();
    }
  });
});

describe('content store', () => {
  it('creates a penceramah and a kuliah referencing it', () => {
    const db = newDb();
    const p = putItem(db, 'penceramah', { name: 'Ustaz Ahmad' }, 'local', undefined, 'sdm');
    expect(p.created).toBe(true);
    expect(p.item.id.length).toBeGreaterThan(0);
    const k = putItem(db, 'kuliah', kuliahFor(p.item.id), 'local', undefined, 'sdm');
    expect(k.created).toBe(true);
    expect(listItems(db, 'kuliah', undefined, 'sdm')).toHaveLength(1);
    expect(getItem(db, 'kuliah', k.item.id, 'sdm')?.penceramahId).toBe(p.item.id);
  });

  it('replaces an existing item with created false', () => {
    const db = newDb();
    const p = putItem(db, 'penceramah', { name: 'Ustaz Ahmad' }, 'local', undefined, 'sdm');
    const again = putItem(db, 'penceramah', { id: p.item.id, name: 'Ustaz Ahmad bin Ali' }, 'local', undefined, 'sdm');
    expect(again.created).toBe(false);
    expect(listItems(db, 'penceramah', undefined, 'sdm')).toHaveLength(1);
    expect(getItem(db, 'penceramah', p.item.id, 'sdm')?.name).toBe('Ustaz Ahmad bin Ali');
  });

  it('refuses a missing penceramah with 409 naming penceramahId', () => {
    const db = newDb();
    expectContentError(() => putItem(db, 'kuliah', kuliahFor('nope'), 'local', undefined, 'sdm'), 409, /penceramahId/);
    expect(logRows(db)).toHaveLength(0);
  });

  it('refuses a missing kitab and a missing asset', () => {
    const db = newDb();
    const p = putItem(db, 'penceramah', { name: 'Ustaz Ahmad' }, 'local', undefined, 'sdm');
    expectContentError(() => putItem(db, 'kuliah', kuliahFor(p.item.id, { kitabId: 'nope' }), 'local', undefined, 'sdm'), 409, /kitabId/);
    expectContentError(
      () => putItem(db, 'penceramah', { name: 'X', photoAssetId: 'a'.repeat(64) }, 'local', undefined, 'sdm'),
      409,
      /photoAssetId/,
    );
  });

  it('accepts an asset reference once the asset exists', () => {
    const db = newDb();
    const id = 'b'.repeat(64);
    db.prepare(
      'INSERT INTO assets (id, mime, bytes, width, height, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, 'image/png', 10, 2, 2, new Date().toISOString(), 'local');
    const p = putItem(db, 'penceramah', { name: 'Ustaz', photoAssetId: id }, 'local', undefined, 'sdm');
    expect(p.item.photoAssetId).toBe(id);
    putItem(db, 'poster', { title: 'Poster 1', assetId: id, days: ['umum'], order: 1 }, 'local', undefined, 'sdm');
  });

  it('refuses to delete a referenced penceramah, then allows it', () => {
    const db = newDb();
    const p = putItem(db, 'penceramah', { name: 'Ustaz Ahmad' }, 'local', undefined, 'sdm');
    const k = putItem(db, 'kuliah', kuliahFor(p.item.id), 'local', undefined, 'sdm');
    expectContentError(() => deleteItem(db, 'penceramah', p.item.id, 'local', undefined, 'sdm'), 409, /kuliah/);
    expect(deleteItem(db, 'kuliah', k.item.id, 'local', undefined, 'sdm')).toBe(true);
    expect(deleteItem(db, 'penceramah', p.item.id, 'local', undefined, 'sdm')).toBe(true);
    expect(listItems(db, 'penceramah', undefined, 'sdm')).toEqual([]);
    expect(listItems(db, 'penceramah', { includeDeleted: true }, 'sdm')).toHaveLength(1);
    expect(getItem(db, 'penceramah', p.item.id, 'sdm')).toBeNull();
    expect(deleteItem(db, 'penceramah', p.item.id, 'local', undefined, 'sdm')).toBe(false);
  });

  it('[C4] a speaker used only by past kuliah can be deleted, by a kuliah tomorrow not (listed)', () => {
    const db = newDb();
    const a = putItem(db, 'penceramah', { name: 'Ustaz Lama' }, 'local', undefined, 'sdm');
    putItem(db, 'kuliah', kuliahFor(a.item.id, { date: inDays(-30) }), 'local', undefined, 'sdm');
    expect(deleteItem(db, 'penceramah', a.item.id, 'local', undefined, 'sdm')).toBe(true);
    const b = putItem(db, 'penceramah', { name: 'Ustaz Baru' }, 'local', undefined, 'sdm');
    const k = putItem(db, 'kuliah', kuliahFor(b.item.id, { date: inDays(1) }), 'local', undefined, 'sdm');
    try {
      deleteItem(db, 'penceramah', b.item.id, 'local', undefined, 'sdm');
      throw new Error('expected ContentError');
    } catch (e) {
      expect((e as ContentError).code).toBe('content_in_use');
      expect(((e as ContentError).detail as { items: { id: string }[] }).items[0]!.id).toBe(k.item.id);
    }
  });

  it('[C3][C4] the refusal is coded content_in_use with the kuliah of today or later; a past kuliah does not block', () => {
    const db = newDb();
    const p = putItem(db, 'penceramah', { name: 'Ustaz Ahmad' }, 'local', undefined, 'sdm');
    const old = putItem(db, 'kuliah', kuliahFor(p.item.id, { date: inDays(-40) }), 'local', undefined, 'sdm');
    // only a past kuliah uses the speaker: the delete goes through
    const lone = putItem(db, 'penceramah', { name: 'Ustaz Lama' }, 'local', undefined, 'sdm');
    putItem(db, 'kuliah', kuliahFor(lone.item.id, { date: inDays(-30) }), 'local', undefined, 'sdm');
    expect(deleteItem(db, 'penceramah', lone.item.id, 'local', undefined, 'sdm')).toBe(true);
    // tomorrow's kuliah blocks, with a code and the blocking kuliah in the detail
    const next = putItem(db, 'kuliah', kuliahFor(p.item.id, { date: inDays(1), label: 'Kuliah Subuh' }), 'local', undefined, 'sdm');
    let caught: unknown;
    try {
      deleteItem(db, 'penceramah', p.item.id, 'local', undefined, 'sdm');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ContentError);
    const err = caught as ContentError;
    expect(err.status).toBe(409);
    expect(err.code).toBe('content_in_use');
    expect(err.errors[0]).toMatch(/still used by 1 kuliah/);
    expect(err.detail).toEqual({ kind: 'penceramah', count: 1, items: [{ id: next.item.id, date: inDays(1), label: 'Kuliah Subuh' }] });
    expect(old.item.id).not.toBe(next.item.id);
  });

  it('[C3] the detail lists at most 5 blocking kuliah but counts them all', () => {
    const db = newDb();
    const p = putItem(db, 'penceramah', { name: 'Ustaz Ahmad' }, 'local', undefined, 'sdm');
    for (let i = 1; i <= 7; i++) putItem(db, 'kuliah', kuliahFor(p.item.id, { date: inDays(i) }), 'local', undefined, 'sdm');
    try {
      deleteItem(db, 'penceramah', p.item.id, 'local', undefined, 'sdm');
      throw new Error('expected ContentError');
    } catch (e) {
      const d = (e as ContentError).detail as { count: number; items: unknown[] };
      expect(d.count).toBe(7);
      expect(d.items).toHaveLength(5);
    }
  });

  it('[C3] a missing asset is coded asset_missing', () => {
    const db = newDb();
    try {
      putItem(db, 'penceramah', { name: 'X', photoAssetId: 'a'.repeat(64) }, 'local', undefined, 'sdm');
      throw new Error('expected ContentError');
    } catch (e) {
      expect((e as ContentError).code).toBe('asset_missing');
    }
  });

  it('refuses to delete a referenced kitab and petugas', () => {
    const db = newDb();
    const p = putItem(db, 'penceramah', { name: 'Ustaz' }, 'local', undefined, 'sdm');
    const kt = putItem(db, 'kitab', { title: 'Riyadhus Solihin' }, 'local', undefined, 'sdm');
    putItem(db, 'kuliah', kuliahFor(p.item.id, { kitabId: kt.item.id }), 'local', undefined, 'sdm');
    expectContentError(() => deleteItem(db, 'kitab', kt.item.id, 'local', undefined, 'sdm'), 409, /kuliah/);
    const pt = putItem(db, 'petugas', { name: 'Encik Salleh' }, 'local', undefined, 'sdm');
    putItem(db, 'tugasan', { date: inDays(3), role: 'bilal', petugasId: pt.item.id }, 'local', undefined, 'sdm');
    expectContentError(() => deleteItem(db, 'petugas', pt.item.id, 'local', undefined, 'sdm'), 409, /tugasan/);
  });

  it('writes one change_log row per write with the actor, and bumps the version', () => {
    const db = newDb();
    const v0 = getVersion(db, 'sdm');
    const p = putItem(db, 'penceramah', { name: 'Ustaz Ahmad' }, 'user:u1', undefined, 'sdm');
    expect(getVersion(db, 'sdm')).toBe(v0 + 1);
    putItem(db, 'penceramah', { id: p.item.id, name: 'Ustaz Ahmad 2' }, 'user:u2', undefined, 'sdm');
    deleteItem(db, 'penceramah', p.item.id, 'user:u3', undefined, 'sdm');
    expect(getVersion(db, 'sdm')).toBe(v0 + 3);
    const rows = logRows(db);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.actor)).toEqual(['user:u1', 'user:u2', 'user:u3']);
    expect(rows.every((r) => r.entity === 'content:penceramah' && r.entity_id === p.item.id)).toBe(true);
    expect(rows[0]?.before_json).toBeNull();
    expect(JSON.parse(String(rows[1]?.before_json)).name).toBe('Ustaz Ahmad');
    expect(JSON.parse(String(rows[1]?.after_json)).name).toBe('Ustaz Ahmad 2');
    expect(rows[2]?.after_json).toBeNull();
  });

  it('rejects an invalid item with 400 and leaves change_log and version alone', () => {
    const db = newDb();
    const v0 = getVersion(db, 'sdm');
    expectContentError(() => putItem(db, 'kuliah', { date: '2026-13-05' }, 'local', undefined, 'sdm'), 400, /date/);
    expect(logRows(db)).toHaveLength(0);
    expect(getVersion(db, 'sdm')).toBe(v0);
  });

  it('rejects an unsafe id and an unknown kind', () => {
    const db = newDb();
    expectContentError(() => putItem(db, 'penceramah', { id: '../x', name: 'A' }, 'local', undefined, 'sdm'), 400, /id/);
    expectContentError(() => putItem(db, 'nosuch' as never, { name: 'A' }, 'local', undefined, 'sdm'), 404, /kind/);
  });

  it('stamps updatedAt and updatedBy from the server, not the client', () => {
    const db = newDb();
    const p = putItem(db, 'penceramah', { name: 'A', updatedBy: 'evil', updatedAt: '2000-01-01' }, 'user:u1', undefined, 'sdm');
    expect(p.item.updatedBy).toBe('user:u1');
    expect(p.item.updatedAt).not.toBe('2000-01-01');
  });

  it('revives a soft-deleted id as created', () => {
    const db = newDb();
    const p = putItem(db, 'penceramah', { name: 'A' }, 'local', undefined, 'sdm');
    deleteItem(db, 'penceramah', p.item.id, 'local', undefined, 'sdm');
    const again = putItem(db, 'penceramah', { id: p.item.id, name: 'A' }, 'local', undefined, 'sdm');
    expect(again.created).toBe(true);
    expect(listItems(db, 'penceramah', undefined, 'sdm')).toHaveLength(1);
  });
});

describe('actorOf', () => {
  it('is local without auth and user:<id> with it', () => {
    expect(actorOf({})).toBe('local');
    expect(actorOf({ auth: { kind: 'user', userId: 'u1', deviceId: 'd1', roles: ['admin'], sessionId: 's1', ops: false } })).toBe('user:u1');
  });
});

describe('content routes', () => {
  const apps: FastifyInstance[] = [];
  const dirs: string[] = [];

  function makeApp(): AdminApp {
    const dir = mkdtempSync(join(tmpdir(), 'surau-content-routes-'));
    dirs.push(dir);
    const app = withAdmin(buildApp(join(dir, 'test.db')));
    apps.push(app);
    return app;
  }

  afterEach(async () => {
    for (const app of apps.splice(0)) {
      try {
        await app.close();
      } catch {
        // already closed
      }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('PUT creates (201), replaces (200), GET reads, list returns, DELETE then GET 404', async () => {
    const app = makeApp();
    const put = await app.inject({ method: 'PUT', url: '/api/content/penceramah/p1', payload: { name: 'Ustaz Ahmad' } });
    expect(put.statusCode).toBe(201);
    expect(put.json().item.id).toBe('p1');
    const again = await app.inject({ method: 'PUT', url: '/api/content/penceramah/p1', payload: { name: 'Ustaz Ahmad 2' } });
    expect(again.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/content/penceramah' });
    expect(list.json().items).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/content/penceramah/p1' })).json().item.name).toBe('Ustaz Ahmad 2');
    expect((await app.inject({ method: 'DELETE', url: '/api/content/penceramah/p1' })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/content/penceramah/p1' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/content/penceramah/p1' })).statusCode).toBe(404);
  });

  it('the path id wins over a body id; non-object body and bad id are 400', async () => {
    const app = makeApp();
    const put = await app.inject({ method: 'PUT', url: '/api/content/penceramah/p2', payload: { id: 'other', name: 'A' } });
    expect(put.json().item.id).toBe('p2');
    expect((await app.inject({ method: 'PUT', url: '/api/content/penceramah/p3', payload: [1] })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/content/penceramah/a.b', payload: { name: 'A' } })).statusCode).toBe(400);
  });

  it('a kuliah with a missing penceramah is 409; a missing asset is 409', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'PUT', url: '/api/content/kuliah/k1', payload: kuliahFor('nosuch') });
    expect(res.statusCode).toBe(409);
    expect(res.json().errors.join(' ')).toMatch(/penceramahId/);
    const asset = await app.inject({
      method: 'PUT',
      url: '/api/content/penceramah/p9',
      payload: { name: 'A', photoAssetId: 'f'.repeat(64) },
    });
    expect(asset.statusCode).toBe(409);
  });

  it('[C3] DELETE of a used speaker is 409 with the sentence, a code and detail', async () => {
    const app = makeApp();
    await app.inject({ method: 'PUT', url: '/api/content/penceramah/p1', payload: { name: 'Ustaz Ahmad' } });
    await app.inject({ method: 'PUT', url: '/api/content/kuliah/k1', payload: kuliahFor('p1') });
    const res = await app.inject({ method: 'DELETE', url: '/api/content/penceramah/p1' });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { errors: string[]; code: string; detail: { kind: string; count: number; items: { id: string }[] } };
    expect(body.errors[0]).toMatch(/still used by 1 kuliah/);
    expect(body.code).toBe('content_in_use');
    expect(body.detail).toMatchObject({ kind: 'penceramah', count: 1 });
    expect(body.detail.items[0]!.id).toBe('k1');
    const asset = await app.inject({ method: 'PUT', url: '/api/content/penceramah/p9', payload: { name: 'A', photoAssetId: 'f'.repeat(64) } });
    expect(asset.json().code).toBe('asset_missing');
  });

  it('invalid item is 400 with errors; unknown kind is 404 on every verb', async () => {
    const app = makeApp();
    const bad = await app.inject({ method: 'PUT', url: '/api/content/kuliah/k2', payload: { date: '2026-13-05' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors.length).toBeGreaterThan(0);
    for (const method of ['GET', 'DELETE'] as const) {
      expect((await app.inject({ method, url: '/api/content/nosuch' })).statusCode).toBe(404);
      expect((await app.inject({ method, url: '/api/content/nosuch/x' })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: 'PUT', url: '/api/content/nosuch/x', payload: { name: 'A' } })).statusCode).toBe(404);
  });

  it('a write pushes changed to an SSE client with a higher version', async () => {
    const app = makeApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/kiosk/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (n: number): Promise<number[]> => {
      for (;;) {
        const versions = [...buffer.matchAll(/event: changed\ndata: \{"version":(\d+)\}\n\n/g)].map((m) => Number(m[1]));
        if (versions.length >= n) return versions;
        const chunk = await reader.read();
        if (chunk.done) return versions;
        buffer += decoder.decode(chunk.value);
      }
    };
    const first = await readUntil(1);
    const { headers: auth } = await app.admin();
    const put = await fetch(`http://127.0.0.1:${port}/api/content/penceramah/p1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ name: 'Ustaz' }),
    });
    expect(put.status).toBe(201);
    const second = await readUntil(2);
    controller.abort();
    expect(second[1]).toBeGreaterThan(first[0]!);
  });
});

describe('W13 M4: a speaker phone number is only for roles that can write content', () => {
  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'surau-content-phone-'));
    tempDirs.push(dir);
    const app = buildApp(join(dir, 'test.db'), { dataDir: dir });
    const editor = await loginAs(app, 'media');
    const reader = await loginAs(app, 'ajk');
    const put = await app.inject({
      method: 'PUT',
      url: '/api/content/penceramah/p1',
      headers: editor.headers,
      payload: { name: 'Ustaz Ahmad', phone: '012-3456789' },
    });
    expect(put.statusCode).toBe(201);
    return { app, editor, reader };
  }

  it('content:write roles see the phone in the list and the single item', async () => {
    const { app, editor } = await setup();
    const list = await app.inject({ method: 'GET', url: '/api/content/penceramah', headers: editor.headers });
    expect(list.json().items[0]).toMatchObject({ name: 'Ustaz Ahmad', phone: '012-3456789' });
    const one = await app.inject({ method: 'GET', url: '/api/content/penceramah/p1', headers: editor.headers });
    expect(one.json().item.phone).toBe('012-3456789');
    await app.close();
  });

  it('read-only roles get the same items without the phone (list and single item)', async () => {
    const { app, reader } = await setup();
    const list = await app.inject({ method: 'GET', url: '/api/content/penceramah', headers: reader.headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0]).toMatchObject({ id: 'p1', name: 'Ustaz Ahmad' });
    expect(list.body).not.toContain('012-3456789');
    expect('phone' in list.json().items[0]).toBe(false);
    const one = await app.inject({ method: 'GET', url: '/api/content/penceramah/p1', headers: reader.headers });
    expect(one.statusCode).toBe(200);
    expect(one.body).not.toContain('012-3456789');
    await app.close();
  });

  it('other content kinds are untouched for read-only roles', async () => {
    const { app, editor, reader } = await setup();
    const put = await app.inject({ method: 'PUT', url: '/api/content/ticker/t1', headers: editor.headers, payload: { text: 'Selamat datang', from: '2026-11-01', to: '2026-12-01' } });
    expect(put.statusCode).toBe(201);
    const r = await app.inject({ method: 'GET', url: '/api/content/ticker', headers: reader.headers });
    expect(r.statusCode).toBe(200);
    expect(r.json().items).toHaveLength(1);
    expect(r.json().items[0]).toMatchObject({ text: 'Selamat datang' });
    await app.close();
  });
});

describe('[G-Q1] a past kuliah of a deleted penceramah can still be edited', () => {
  it('[G-Q1] the unchanged reference is not re-checked; a changed one to a missing penceramah is still refused', () => {
    const db = newDb();
    const p = putItem(db, 'penceramah', { name: 'Ustaz Ahmad' }, 'local', undefined, 'sdm');
    const k = putItem(db, 'kuliah', kuliahFor(p.item.id, { date: inDays(-5) }), 'local', undefined, 'sdm');
    expect(deleteItem(db, 'penceramah', p.item.id, 'local', undefined, 'sdm')).toBe(true);
    const edited = putItem(db, 'kuliah', { ...kuliahFor(p.item.id, { date: inDays(-5) }), id: k.item.id, label: 'Kuliah Maghrib (dikemas kini)' }, 'local', undefined, 'sdm');
    expect(edited.item.label).toBe('Kuliah Maghrib (dikemas kini)');
    expectContentError(() => putItem(db, 'kuliah', { ...kuliahFor('tiada', { date: inDays(-5) }), id: k.item.id }, 'local', undefined, 'sdm'), 409, /penceramahId/);
  });
});
