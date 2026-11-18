import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '021-camera-secret', up };

/**
 * The cloud's sealed backup of one surau's external camera address (live-external-source plan 4.2, 7). One row per
 * surau; `sealed` is the AES-256-GCM value of the cloud's own key (HKDF label `camera-secret`), so the database file
 * alone never shows the address or its login. A box never reads this table.
 */
function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS camera_secrets (
      surau_id TEXT NOT NULL PRIMARY KEY,
      sealed TEXT NOT NULL,
      box_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}
