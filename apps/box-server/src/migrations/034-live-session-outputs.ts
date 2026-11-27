import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '034-live-session-outputs', up };

/**
 * The record of a live keeps its destinations as they stand now: Skrin and Merakam can be switched during a live
 * (`POST /api/live/outputs`), so the row carries them. `outputs_json` is `{"kiosk":bool,"youtube":bool,"recording"?:bool}`;
 * NULL (a row from before this) reads as Skrin on with the `youtube` column. Nothing secret.
 */
function up(db: DatabaseSync): void {
  db.exec('ALTER TABLE live_sessions ADD COLUMN outputs_json TEXT');
}
