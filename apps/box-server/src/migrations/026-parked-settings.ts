import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '026-parked-settings', up };

/**
 * Two small additions for a mixed rollout (box and cloud on different builds):
 *  - `parked_settings`: a settings entry the other side refused as `invalid` (push) or this side refused (pull) is kept
 *    here, with its stamp, and tried once more after either side's software version changes;
 *  - `sites.box_features`: the server features a linked box reported in its sync requests (cloud role), so the cloud
 *    lists a feature for a surau only when its box can take it.
 * Safe to run twice.
 */
function up(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS parked_settings (
    direction TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    stamp TEXT NOT NULL,
    entry_json TEXT NOT NULL,
    parked_at TEXT NOT NULL,
    PRIMARY KEY (direction, entity, entity_id)
  )`);
  const have = new Set(db.prepare('PRAGMA table_info(sites)').all().map((r) => String(r.name)));
  if (have.size > 0 && !have.has('box_features')) db.exec('ALTER TABLE sites ADD COLUMN box_features TEXT');
}
