import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '031-live-sessions', up };

/**
 * The persisted record of every live a box ran (2026.11.15, Siaran langsung revamp). Table only: the store that
 * writes it (`live/sessionStore.ts`) and the routes that read it come with the live lanes.
 *
 * One row per live session, the shape of `LiveSessionRecord` in @surau/core. Held PER BOX: `box_id` is the box that
 * ran the live, and `youtube_channel_id` is the YouTube channel THAT box was signed in to, since each box streams to
 * its own channel. `owner_device_id` never leaves the box (the routes answer `mine` instead). A row with
 * `stopped_at` NULL is a live that runs, or one a box restart cut short; the store ends those at start-up.
 * `broadcast_ids_json` is a JSON array of YouTube broadcast ids, oldest first; `gaps_json` a JSON array of `LiveGap`.
 * No secret is stored here: no stream key, no token, no camera address.
 */
function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_sessions (
      id TEXT PRIMARY KEY,
      surau_id TEXT NOT NULL,
      box_id TEXT NOT NULL,
      owner_device_id TEXT NOT NULL,
      started_by TEXT NOT NULL,
      kuliah_id TEXT,
      source TEXT NOT NULL CHECK (source IN ('android', 'web')),
      video TEXT NOT NULL CHECK (video IN ('phone', 'external')),
      video_path TEXT NOT NULL DEFAULT 'device' CHECK (video_path IN ('device', 'box')),
      youtube INTEGER NOT NULL DEFAULT 0 CHECK (youtube IN (0, 1)),
      youtube_via TEXT NOT NULL CHECK (youtube_via IN ('device', 'box')),
      youtube_channel_id TEXT,
      started_at TEXT NOT NULL,
      stopped_at TEXT,
      reason TEXT,
      broadcast_ids_json TEXT NOT NULL DEFAULT '[]',
      gaps_json TEXT NOT NULL DEFAULT '[]',
      gap_seconds INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS live_sessions_recent ON live_sessions (surau_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS live_sessions_open ON live_sessions (stopped_at) WHERE stopped_at IS NULL;
  `);
}
