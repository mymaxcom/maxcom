import type { DatabaseSync } from 'node:sqlite';
import { POSTER_STRETCH_FLAG } from '../migrations/025-poster-stretch-keep.ts';
import { putItemIn } from './store.ts';

const ACTOR = 'system:poster-stretch';

/**
 * Once per database (the flag of migration 025): on a box, every live poster stored without a `stretch` field is saved
 * again with `stretch: false`, so a poster made before 2026.11.13 keeps its shape. Each one is an ordinary local
 * write (new updatedAt, change_log row, content version bump), so it syncs to the cloud like an edit. A poster saved
 * later without the field keeps the new default (Yes). On the cloud the flag is only cleared: the boxes send theirs.
 * A row that does not read back as a valid poster is left as it is. Returns the posters changed.
 */
export function keepPosterShape(db: DatabaseSync, role: 'box' | 'cloud'): number {
  const flag = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(POSTER_STRETCH_FLAG);
  if (flag === undefined) return 0;
  let changed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (role === 'box') {
      const rows = db.prepare("SELECT surau_id, id, json FROM content_items WHERE kind = 'poster' AND deleted_at IS NULL ORDER BY surau_id, id").all();
      for (const row of rows) {
        let item: Record<string, unknown>;
        try {
          const v: unknown = JSON.parse(String(row.json));
          if (typeof v !== 'object' || v === null || Array.isArray(v)) continue;
          item = v as Record<string, unknown>;
        } catch {
          continue;
        }
        if (item.stretch !== undefined) continue;
        const { updatedAt: _a, updatedBy: _b, ...rest } = item;
        try {
          putItemIn(db, 'poster', { ...rest, stretch: false }, ACTOR, { trusted: true }, String(row.surau_id));
          changed += 1;
        } catch {
          /* a poster that does not validate is left as it was */
        }
      }
    }
    db.prepare('DELETE FROM sync_state WHERE key = ?').run(POSTER_STRETCH_FLAG);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return changed;
}
