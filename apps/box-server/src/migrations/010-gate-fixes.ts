import type { DatabaseSync } from 'node:sqlite';
import { deviceOfRev } from '../sync/meta.ts';
import { leafPaths } from '../settingsStore.ts';

export const migration = { name: '010-gate-fixes', up };

/**
 * Plan 6 gate fixes. `applied_ops` keeps the first answer of an op (so a replay of a superseded op
 * is answered superseded again, with the same winner). Settings merge per field: each settings row gets a
 * map of field path -> { editedAt, deviceId }, backfilled from the row's own edit stamp; the change history
 * carries the map of each settings write so the feed can hand it on.
 */
function up(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE applied_ops ADD COLUMN result_status TEXT NOT NULL DEFAULT 'applied';
    ALTER TABLE applied_ops ADD COLUMN winner_json TEXT;
    ALTER TABLE settings ADD COLUMN field_stamps TEXT;
    ALTER TABLE change_log ADD COLUMN stamps_json TEXT;
  `);
  const rows = db.prepare('SELECT feature, json, rev, edited_at, updated_at FROM settings').all();
  const set = db.prepare('UPDATE settings SET field_stamps = ? WHERE feature = ?');
  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(r.json));
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const rev = typeof r.rev === 'string' ? r.rev : null;
    const stamp = {
      editedAt: typeof r.edited_at === 'string' ? r.edited_at : String(r.updated_at),
      deviceId: deviceOfRev(rev) ?? 'local',
    };
    const stamps: Record<string, typeof stamp> = {};
    for (const p of leafPaths(parsed as Record<string, unknown>)) stamps[p] = stamp;
    set.run(JSON.stringify(stamps), String(r.feature));
  }
}
