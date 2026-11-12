import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '011-upload-replace', up };

/**
 * Plan 6 Task 5. A catch-up upload may replace a gappy live recording: the live video is set private (never
 * deleted) when the upload is done. `replace_video_id` is the live video named at `upload/begin`;
 * `replaced_at` is set once, when the cloud has made it private (a claim marker while the call is in flight).
 * No upload address is stored: only ids.
 */
function up(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE uploads ADD COLUMN replace_video_id TEXT;
    ALTER TABLE uploads ADD COLUMN replaced_at TEXT;
  `);
}
