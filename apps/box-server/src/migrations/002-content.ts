import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '002-content', up };

function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE content_items (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      deleted_at TEXT,
      PRIMARY KEY (kind, id)
    );

    CREATE INDEX idx_content_items_kind_deleted ON content_items (kind, deleted_at);

    CREATE TABLE assets (
      id TEXT PRIMARY KEY,
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );

    CREATE TABLE islamic_cache (
      key TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
  `);
}
