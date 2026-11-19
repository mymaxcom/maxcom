import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { putItem } from '../src/content/store.ts';
import { openDb } from '../src/db.ts';
import { migration } from '../src/migrations/024-outbox-camera-mark.ts';
import { MIGRATIONS } from '../src/migrations/index.ts';
import { enqueueCameraMark, setOutboxOn } from '../src/sync/workerOutbox.ts';
import { insertSite } from './support/sites.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const BOX = 'a1b2c3d4e5f60718';

describe('024: the Worker outbox takes the camera mark kinds', () => {
  it('is listed after 022, by name', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names).toContain('024-outbox-camera-mark');
    expect(names.indexOf('024-outbox-camera-mark')).toBeGreaterThan(names.indexOf('022-people-relook'));
  });

  it('keeps every row, its id and the id sequence, and the triggers of 009 and 019 still write to the rebuilt table', () => {
    const db = openDb(':memory:');
    dbs.push(db);
    setOutboxOn(db, true);
    insertSite(db, { boxId: BOX });
    putItem(db, 'penceramah', { id: 'p1', name: 'A' }, 'local', undefined, 'sdm');
    db.prepare("INSERT INTO worker_outbox (kind, key, body, created_at, attempts, next_at, last_error, state, rev) VALUES ('site_delete', 'site/x', '{}', 't', 3, 'n', 'http_500', 'failed', 4)").run();
    const before = db.prepare('SELECT * FROM worker_outbox ORDER BY id').all();
    expect(before.length).toBeGreaterThanOrEqual(2);
    const maxBefore = Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'worker_outbox'").get()?.seq);

    // run it again over a filled table (as on a cloud that already has rows)
    db.exec('BEGIN IMMEDIATE');
    migration.up(db);
    db.exec('COMMIT');
    expect(db.prepare('SELECT * FROM worker_outbox ORDER BY id').all()).toEqual(before);
    expect(Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'worker_outbox'").get()?.seq)).toBe(maxBefore);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'worker_outbox_024'").get()!.n).toBe(0);
    expect(Number(db.prepare('PRAGMA legacy_alter_table').get()?.legacy_alter_table)).toBe(0);

    // the dirty trigger still fires into it
    putItem(db, 'penceramah', { id: 'p2', name: 'B' }, 'local', undefined, 'sdm');
    const dirty = db.prepare("SELECT body FROM worker_outbox WHERE key = ?").get(`dirty/${BOX}`);
    expect(JSON.parse(String(dirty?.body)).seq).toBeGreaterThan(0);
    // a new id is above every old one
    enqueueCameraMark(db, BOX, true);
    const cam = db.prepare("SELECT id, kind, body FROM worker_outbox WHERE key = ?").get(`camera/${BOX}`)!;
    expect(cam).toMatchObject({ kind: 'camera_put', body: '{}' });
    expect(Number(cam.id)).toBeGreaterThan(maxBefore);
    enqueueCameraMark(db, BOX, false);
    expect(db.prepare("SELECT kind FROM worker_outbox WHERE key = ?").get(`camera/${BOX}`)).toMatchObject({ kind: 'camera_delete' });
    // the CHECK still refuses anything else
    expect(() => db.prepare("INSERT INTO worker_outbox (kind, key, body, created_at) VALUES ('camera', 'k', '{}', 't')").run()).toThrow();
  });

  it('with the outbox off nothing is queued and no note is kept', () => {
    const db = openDb(':memory:');
    dbs.push(db);
    enqueueCameraMark(db, BOX, true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM worker_outbox').get()!.n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sync_state WHERE key LIKE 'camera_mark/%'").get()!.n).toBe(0);
  });
});
