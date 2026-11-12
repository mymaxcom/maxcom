import type { DatabaseSync } from 'node:sqlite';
import { getSettings } from '../settingsStore.ts';

/** The cloud keeps everything a box may still replay: the largest value a box can choose. */
const CLOUD_RETENTION_DAYS = 365;
const DAY_MS = 86_400_000;

/**
 * The ONE retention window, in days, for the change history and for the tombstones of deleted items (and so
 * for the snapshot's tombstone list). A box reads `system.syncHistoryDays` (180 by default, 365 allowed); the
 * cloud keeps 365 whatever any box chose, so it never forgets a delete a box could still replay.
 */
export function retentionDays(db: DatabaseSync, role: 'box' | 'cloud'): 180 | 365 {
  if (role === 'cloud') return CLOUD_RETENTION_DAYS;
  return getSettings(db).system.syncHistoryDays === 365 ? 365 : 180;
}

/** `sync_state` key: the highest change_log id the box has pushed (the trim never removes anything above it). */
export const LAST_PUSH_SEQ_KEY = 'last_push_seq';

function stateNumber(db: DatabaseSync, key: string): number {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
  const n = row !== undefined && typeof row.value === 'string' ? Number(row.value) : 0;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export interface TrimResult {
  removed: number;
  floor: number;
}

/**
 * Delete change_log rows older than the retention window (`retentionDays`), except:
 *  - the latest row of every entity (current data keeps its last change), unless that row is a deletion
 *    older than the same window (the snapshot no longer lists it);
 *  - on a box, every row it has not yet pushed (`origin` local or app, the two the agent pushes, above `last_push_seq`).
 * `sync_state.log_floor` becomes the highest id removed: a client whose cursor is below it may have missed a
 * removed row and is answered 410 `snapshot_required` (Task 3), so it loads the snapshot instead.
 */
export function trimChangeLog(db: DatabaseSync, role: 'box' | 'cloud', now: Date): TrimResult {
  const cutoff = new Date(now.getTime() - retentionDays(db, role) * DAY_MS).toISOString();
  const tombCutoff = cutoff;
  const unpushedAbove = role === 'box' ? stateNumber(db, LAST_PUSH_SEQ_KEY) : Number.MAX_SAFE_INTEGER;
  db.exec('BEGIN IMMEDIATE');
  try {
    const doomed = db
      .prepare(
        `SELECT c.id FROM change_log c
          WHERE c.at < ?
            AND NOT (? = 'box' AND c.origin IN ('local', 'app') AND c.id > ?)
            AND (
              c.id <> (SELECT MAX(m.id) FROM change_log m WHERE m.entity = c.entity AND m.entity_id IS c.entity_id)
              OR (c.after_json IS NULL AND c.at < ?)
            )`,
      )
      .all(cutoff, role, unpushedAbove, tombCutoff);
    let highest = 0;
    const del = db.prepare('DELETE FROM change_log WHERE id = ?');
    for (const r of doomed) {
      const id = Number(r.id);
      del.run(id);
      if (id > highest) highest = id;
    }
    const floor = Math.max(stateNumber(db, 'log_floor'), highest);
    if (floor > 0) {
      db.prepare("INSERT INTO sync_state (key, value) VALUES ('log_floor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(floor));
    }
    db.exec('COMMIT');
    return { removed: doomed.length, floor };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
