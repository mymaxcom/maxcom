import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '025-poster-stretch-keep', up };

/** Raised once here; `keepPosterShape` (content/posterStretch.ts) does the rewrite on a box and clears it. */
export const POSTER_STRETCH_FLAG = 'poster_stretch_keep';

/**
 * Posters saved before 2026.11.13 have no `stretch` field, which now reads as "stretch to fill" (Yes). The operator
 * decided (2026-11-19) that those EXISTING posters keep the shape they were shown with: each gets `stretch: false`,
 * once. The rewrite needs the server role (a box rewrites and syncs its own posters; the cloud only receives them),
 * which a migration does not know, so this migration only raises a one-time flag; the box does the work at start.
 * Safe to run twice (the flag is set once and the migration is recorded by name).
 */
function up(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare("INSERT OR IGNORE INTO sync_state (key, value) VALUES (?, '1')").run(POSTER_STRETCH_FLAG);
}
