import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '033-surau-sleep', up };

/**
 * Multi-box 2B (B3, contract `docs/design/plans/2026-11-23-cloud-sleep-reset-contract.md`). Cloud rows only; a box
 * leaves them empty.
 *
 * - `suraus.asleep_at` / `asleep_box`: a surau whose box became a follower of another box sleeps on the cloud (every
 *   write refused 409 `surau_asleep`, reads still answer); `asleep_box` is the box id that put it to sleep (the only
 *   box that may wake it).
 * - `suraus.log_floor`: the per-surau floor of the change log. A phone of that surau whose cursor is below it is told
 *   to take a full snapshot; raising it never touches another surau's phones (the global `sync_state.log_floor` would).
 * - `surau_resets`: one row per reset-from-box (the audit for the fleet view, and the per-day limit, which must survive
 *   a restart).
 * - `sync_nonces`: the replay store of signed box calls (rows older than 20 minutes are swept on each call).
 */
function up(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE suraus ADD COLUMN asleep_at TEXT;
    ALTER TABLE suraus ADD COLUMN asleep_box TEXT;
    ALTER TABLE suraus ADD COLUMN log_floor INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS surau_resets (
      id INTEGER PRIMARY KEY,
      surau_id TEXT NOT NULL,
      box_id TEXT NOT NULL,
      link_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      at TEXT NOT NULL,
      backup TEXT,
      counts_json TEXT,
      ok INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_surau_resets_surau ON surau_resets (surau_id, at);
    CREATE TABLE IF NOT EXISTS sync_nonces (
      box_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (box_id, nonce)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_nonces_at ON sync_nonces (at);
  `);
}
