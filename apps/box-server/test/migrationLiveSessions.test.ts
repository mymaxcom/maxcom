import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { migration } from '../src/migrations/031-live-sessions.ts';
import { MIGRATIONS, runMigrations } from '../src/migrations/index.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function fresh(): DatabaseSync {
  const db = openDb(':memory:');
  dbs.push(db);
  return db;
}

const INSERT = `INSERT INTO live_sessions (id, surau_id, box_id, owner_device_id, started_by, kuliah_id, source, video, youtube_via, started_at)
                VALUES (?, 'surau-1', 'a1b2c3d4e5f60718', 'D1', 'Pentadbir Ujian', NULL, 'android', 'external', 'device', '2026-11-22T12:00:00.000Z')`;

describe('031: the live_sessions table', () => {
  it('is listed after 030 and right before 032, by name', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.slice(names.indexOf('031-live-sessions'), names.indexOf('031-live-sessions') + 2)).toEqual(['031-live-sessions', '032-upload-session-key']);
    expect(names.indexOf('031-live-sessions')).toBe(names.indexOf('030-link-people') + 1);
  });

  it('a fresh database has the table with every column of LiveSessionRecord', () => {
    const db = fresh();
    const cols = db.prepare('PRAGMA table_info(live_sessions)').all().map((r) => String(r.name));
    expect(cols).toEqual([
      'id',
      'surau_id',
      'box_id',
      'owner_device_id',
      'started_by',
      'kuliah_id',
      'source',
      'video',
      'video_path',
      'youtube',
      'youtube_via',
      'youtube_channel_id',
      'started_at',
      'stopped_at',
      'reason',
      'broadcast_ids_json',
      'gaps_json',
      'gap_seconds',
      'outputs_json',
    ]);
  });

  it('takes a started row with the defaults: device pull, YouTube off, no broadcasts, no gaps, still open', () => {
    const db = fresh();
    db.prepare(INSERT).run('S1');
    const row = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get('S1')!;
    expect(row.video_path).toBe('device');
    expect(Number(row.youtube)).toBe(0);
    expect(row.youtube_channel_id).toBeNull();
    expect(row.stopped_at).toBeNull();
    expect(row.reason).toBeNull();
    expect(JSON.parse(String(row.broadcast_ids_json))).toEqual([]);
    expect(JSON.parse(String(row.gaps_json))).toEqual([]);
    expect(Number(row.gap_seconds)).toBe(0);
  });

  it('takes a box-pulled row on its own YouTube channel and its stop', () => {
    const db = fresh();
    db.prepare(INSERT).run('S2');
    db.prepare("UPDATE live_sessions SET video_path = 'box', youtube = 1, youtube_channel_id = 'UC-one', broadcast_ids_json = '[\"bc1\"]' WHERE id = 'S2'").run();
    db.prepare("UPDATE live_sessions SET stopped_at = '2026-11-22T13:00:00.000Z', reason = 'stopped', gap_seconds = 20 WHERE id = 'S2'").run();
    const row = db.prepare("SELECT * FROM live_sessions WHERE id = 'S2'").get()!;
    expect(row.video_path).toBe('box');
    expect(row.youtube_channel_id).toBe('UC-one');
    expect(row.reason).toBe('stopped');
    expect(Number(row.gap_seconds)).toBe(20);
  });

  it('refuses an unknown video path, source or picture, and a second row with the same id', () => {
    const db = fresh();
    db.prepare(INSERT).run('S3');
    expect(() => db.prepare(INSERT).run('S3')).toThrow();
    expect(() => db.prepare("UPDATE live_sessions SET video_path = 'cloud' WHERE id = 'S3'").run()).toThrow();
    expect(() => db.prepare("UPDATE live_sessions SET source = 'ios' WHERE id = 'S3'").run()).toThrow();
    expect(() => db.prepare("UPDATE live_sessions SET video = 'screen' WHERE id = 'S3'").run()).toThrow();
    expect(() => db.prepare("UPDATE live_sessions SET youtube = 2 WHERE id = 'S3'").run()).toThrow();
  });

  it('finds the open rows and the newest rows of a surau by index', () => {
    const db = fresh();
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'live_sessions' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => String(r.name));
    expect(idx).toEqual(['live_sessions_open', 'live_sessions_recent']);
  });

  it('runs again over a filled table and keeps the rows; a second migration run applies nothing', () => {
    const db = fresh();
    db.prepare(INSERT).run('S4');
    db.exec('BEGIN IMMEDIATE');
    migration.up(db);
    db.exec('COMMIT');
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM live_sessions').get()!.n)).toBe(1);
    expect(runMigrations(db)).toEqual([]);
  });
});
