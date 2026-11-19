// Operator decision 2026-11-19: posters saved before 2026.11.13 (no `stretch` field) keep their shape. Migration 025
// raises a one-time flag; the box rewrites each such poster with stretch:false as an ordinary local (syncing) write.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { keepPosterShape } from '../src/content/posterStretch.ts';
import { getItem, putItem } from '../src/content/store.ts';
import { POSTER_STRETCH_FLAG } from '../src/migrations/025-poster-stretch-keep.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ASSET = 'a'.repeat(64);
const poster = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Poster ${id}`, assetId: ASSET, days: ['umum'], order: 1, ...extra });

function open(dir: string, role: 'box' | 'cloud' = 'box'): FastifyInstance {
  const app = buildApp(join(dir, 'box.db'), { dataDir: dir, role });
  apps.push(app);
  return app;
}

/** A database whose posters were saved by a release before 2026.11.13 (flag raised again, as an upgraded box has it). */
async function upgradedBox(role: 'box' | 'cloud' = 'box'): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'surau-poster-stretch-'));
  dirs.push(dir);
  const first = open(dir, role);
  const db = first.surau.db;
  db.prepare('INSERT OR IGNORE INTO assets (id, mime, bytes, width, height, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(ASSET, 'image/png', 10, 10, 10, '2026-01-01T00:00:00.000Z', 'test');
  putItem(db, 'poster', poster('old1'), 'test', { trusted: true }, LOCAL_SURAU_ID);
  putItem(db, 'poster', poster('old2'), 'test', { trusted: true }, LOCAL_SURAU_ID);
  putItem(db, 'poster', poster('chosen', { stretch: true }), 'test', { trusted: true }, LOCAL_SURAU_ID);
  db.prepare("UPDATE content_items SET updated_at = '2026-01-01T00:00:00.000Z' WHERE kind = 'poster'").run();
  db.prepare("INSERT OR IGNORE INTO sync_state (key, value) VALUES (?, '1')").run(POSTER_STRETCH_FLAG);
  await first.close();
  apps.splice(apps.indexOf(first), 1);
  return dir;
}

describe('existing posters keep their shape (migration 025)', () => {
  it('a box sets stretch:false once on every poster without the field, as a local change that syncs', async () => {
    const dir = await upgradedBox();
    const app = open(dir);
    const db = app.surau.db;
    expect(getItem(db, 'poster', 'old1', LOCAL_SURAU_ID)).toMatchObject({ stretch: false, updatedBy: 'system:poster-stretch' });
    expect(getItem(db, 'poster', 'old2', LOCAL_SURAU_ID)).toMatchObject({ stretch: false });
    expect((getItem(db, 'poster', 'old1', LOCAL_SURAU_ID) as { updatedAt: string }).updatedAt > '2026-01-01T00:00:00.000Z').toBe(true);
    // a poster that already chose keeps its choice
    expect(getItem(db, 'poster', 'chosen', LOCAL_SURAU_ID)).toMatchObject({ stretch: true });
    // the writes are local change_log rows (what the sync agent pushes)
    const rows = db.prepare("SELECT entity_id, origin FROM change_log WHERE actor = 'system:poster-stretch' ORDER BY entity_id").all();
    expect(rows.map((r) => [r.entity_id, r.origin])).toEqual([['old1', 'local'], ['old2', 'local']]);
    expect(db.prepare('SELECT 1 FROM sync_state WHERE key = ?').get(POSTER_STRETCH_FLAG)).toBeUndefined();
    // the migration is recorded: it never runs again, and a poster saved now without the field keeps the new default
    expect(db.prepare("SELECT 1 FROM schema_migrations WHERE name = '025-poster-stretch-keep'").get()).toBeDefined();
    putItem(db, 'poster', poster('new1'), 'test', { trusted: true }, LOCAL_SURAU_ID);
    expect(keepPosterShape(db, 'box')).toBe(0);
    expect('stretch' in (getItem(db, 'poster', 'new1', LOCAL_SURAU_ID) as object)).toBe(false);
  });

  it('the cloud only clears the flag: it changes no poster (the boxes send theirs)', async () => {
    const dir = await upgradedBox('cloud');
    const app = open(dir, 'cloud');
    const db = app.surau.db;
    expect('stretch' in (getItem(db, 'poster', 'old1', LOCAL_SURAU_ID) as object)).toBe(false);
    expect(db.prepare('SELECT 1 FROM sync_state WHERE key = ?').get(POSTER_STRETCH_FLAG)).toBeUndefined();
  });
});
