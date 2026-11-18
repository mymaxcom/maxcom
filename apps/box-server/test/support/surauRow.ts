import type { DatabaseSync } from 'node:sqlite';

/**
 * Plan 14 Task 8: a link code names a surau that exists in the cloud's registry. Tests that link a box into the pilot
 * surau `sdm` (as the pilot cloud has it after migration 019) make sure its row is there first. Returns the id.
 */
export function ensureSurau(db: DatabaseSync, id = 'sdm', name = 'Surau Perintis Contoh'): string {
  db.prepare("INSERT OR IGNORE INTO suraus (id, name, created_at, created_by) VALUES (?, ?, '2026-11-01T00:00:00.000Z', 'test')").run(id, name);
  return id;
}
