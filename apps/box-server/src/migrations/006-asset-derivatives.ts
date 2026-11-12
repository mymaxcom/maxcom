import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '006-asset-derivatives', up };

/**
 * Derived pictures made from an adjusted image (crop, rotate, background, square): one row per
 * (slot, source asset, adjustment) -> the derived asset. The key is a hash of those inputs, so
 * the same adjustment saved twice finds its row and never renders or stores a second copy.
 */
function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE asset_derivatives (
      key TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      derived_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_asset_derivatives_source ON asset_derivatives (source_id);
  `);
}
