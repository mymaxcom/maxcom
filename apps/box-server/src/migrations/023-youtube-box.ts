import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '023-youtube-box', up };

/**
 * Release 2026.11.13: the YouTube grant is held by the surau's BOX only; the cloud keeps a non-secret flag.
 *
 *  - `youtube_flag`: what the cloud may show away from the surau (signed in or not, the channel name, whether Google
 *    withdrew the grant) and which box said so. No token, no code, no key: the columns cannot hold one.
 *  - `youtube_handover`: the one-time move of a grant the cloud held before this release to the box that asked first
 *    (D4). Ids and times only; the grant itself travels sealed to that box and is never written here.
 *
 * Both tables are made on every role (a box simply leaves them empty). Safe to run twice.
 */
function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS youtube_flag (
      surau_id TEXT NOT NULL PRIMARY KEY,
      signed_in INTEGER NOT NULL,
      channel_title TEXT,
      revoked INTEGER NOT NULL DEFAULT 0,
      box_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS youtube_handover (
      surau_id TEXT NOT NULL PRIMARY KEY,
      box_id TEXT NOT NULL,
      handover_id TEXT NOT NULL,
      state TEXT NOT NULL,
      offered_at TEXT NOT NULL,
      acked_at TEXT
    )
  `);
}
