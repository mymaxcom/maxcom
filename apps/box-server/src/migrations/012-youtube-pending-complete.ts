import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '012-youtube-pending-complete', up };

/**
 * Plan 6 follow-up. A YouTube `complete` that did not reach the cloud at stop is kept here so it survives a box
 * restart and is tried again at boot and on the sync agent's cycle. Only the broadcast id and a try counter
 * are stored: never a stream key, token or address.
 */
function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS youtube_pending_complete (
      broadcast_id TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
}
