import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '024-outbox-camera-mark', up };

/**
 * Release 2026.11.13: the cloud's Worker outbox learns two more kinds, `camera_put` and `camera_delete`
 * (key `camera/<boxId>`, body `{}`). When the cloud stores a camera change relayed from a phone away from the surau it
 * queues `camera_put`; the Worker then answers that box's signed `GET /dirty` with `camera: true`, and the box makes
 * a full (waking) cycle that picks the change up even when the cloud had gone to sleep. The box's answer queues
 * `camera_delete`. Nothing secret is queued: the item names the box only.
 *
 * SQLite cannot change a CHECK constraint in place, so the table is rebuilt with the same columns and rows. The
 * triggers of 009 and 019 that write to `worker_outbox` live on other tables and refer to it by name, so the rename is
 * done with `legacy_alter_table` on (otherwise SQLite re-checks those triggers while the table is briefly missing).
 */
function up(db: DatabaseSync): void {
  db.exec('PRAGMA legacy_alter_table = ON');
  try {
    db.exec(`
      CREATE TABLE worker_outbox_024 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('dirty', 'dev_put', 'dev_delete', 'site_put', 'site_delete', 'camera_put', 'camera_delete')),
        key TEXT NOT NULL UNIQUE,
        body TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at TEXT NOT NULL DEFAULT '',
        last_error TEXT,
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'failed')),
        rev INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO worker_outbox_024 (id, kind, key, body, created_at, attempts, next_at, last_error, state, rev)
        SELECT id, kind, key, body, created_at, attempts, next_at, last_error, state, rev FROM worker_outbox;
      DROP TABLE worker_outbox;
      ALTER TABLE worker_outbox_024 RENAME TO worker_outbox;
    `);
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF');
  }
}
