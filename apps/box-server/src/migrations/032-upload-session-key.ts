import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '032-upload-session-key', up };

/**
 * The catch-up upload knows which live it belongs to (2026.11.15, Siaran langsung revamp, U6). `session_id` is the
 * live session id the app names at `POST /api/youtube/upload/begin` (the id of a `live_sessions` row; NULL for an
 * upload begun without one, as before). Two phones that both hold a recording of the same live no longer both upload
 * it: the second `begin` for a session another device is uploading is refused with `already_uploading`.
 *
 * No new state column: `state` is free text and gains the value `abandoned` (U4), next to `open`, `done`, `expired`.
 * Nothing secret is added: an id only, never the upload address.
 */
function up(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE uploads ADD COLUMN session_id TEXT;
    CREATE INDEX IF NOT EXISTS uploads_session ON uploads (surau_id, session_id) WHERE session_id IS NOT NULL;
  `);
}
