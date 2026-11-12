import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '007-asset-derivative-failures', up };

/**
 * A derivation that failed (the source cannot be decoded): one row per derivative key, so a read
 * path does not decode the same failing source on every request. The key already hashes the
 * source asset and the adjustment, so a changed source or changed params is a new key and is tried.
 */
function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE asset_derivative_failures (
      key TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      failed_at TEXT NOT NULL
    );
  `);
}
