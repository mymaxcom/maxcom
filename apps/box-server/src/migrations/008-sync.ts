import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '008-sync', up };

/**
 * Plan 6 sync groundwork. The change history learns who/where/when (origin, op id, edit time, sync
 * time, revision); every synced table carries a revision and the origin of its last write; and the
 * cloud's bookkeeping tables exist (empty on a box). Existing rows are backfilled so a Plan 5
 * database keeps every row and merges against them as local, older edits.
 */
function up(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE change_log ADD COLUMN origin TEXT NOT NULL DEFAULT 'local';
    ALTER TABLE change_log ADD COLUMN op_id TEXT;
    ALTER TABLE change_log ADD COLUMN edited_at TEXT;
    ALTER TABLE change_log ADD COLUMN synced_at TEXT;
    ALTER TABLE change_log ADD COLUMN rev TEXT;
    CREATE UNIQUE INDEX idx_change_log_op ON change_log (op_id) WHERE op_id IS NOT NULL;
    UPDATE change_log SET edited_at = at, rev = at || '|local';

    ALTER TABLE content_items ADD COLUMN rev TEXT;
    ALTER TABLE content_items ADD COLUMN edited_at TEXT;
    ALTER TABLE content_items ADD COLUMN origin TEXT NOT NULL DEFAULT 'local';
    UPDATE content_items SET edited_at = updated_at, rev = updated_at || '|local';

    ALTER TABLE settings ADD COLUMN rev TEXT;
    ALTER TABLE settings ADD COLUMN edited_at TEXT;
    ALTER TABLE settings ADD COLUMN origin TEXT NOT NULL DEFAULT 'local';
    UPDATE settings SET edited_at = updated_at, rev = updated_at || '|local';

    ALTER TABLE users ADD COLUMN rev TEXT;
    ALTER TABLE users ADD COLUMN edited_at TEXT;
    ALTER TABLE users ADD COLUMN origin TEXT NOT NULL DEFAULT 'local';
    UPDATE users SET edited_at = created_at, rev = created_at || '|local';

    ALTER TABLE devices ADD COLUMN rev TEXT;
    ALTER TABLE devices ADD COLUMN edited_at TEXT;
    ALTER TABLE devices ADD COLUMN origin TEXT NOT NULL DEFAULT 'local';
    UPDATE devices SET edited_at = enrolled_at, rev = enrolled_at || '|local';

    CREATE TABLE applied_ops (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      op_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      status TEXT NOT NULL,
      rev TEXT,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE sync_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE sites (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      box_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      public_jwk TEXT,
      token_hash TEXT UNIQUE,
      linked_at TEXT,
      last_seen_at TEXT,
      revoked_at TEXT
    );

    CREATE TABLE uploads (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      id TEXT PRIMARY KEY,
      kuliah_id TEXT,
      device_id TEXT NOT NULL,
      video_id TEXT,
      state TEXT NOT NULL,
      bytes INTEGER,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );
  `);
}
