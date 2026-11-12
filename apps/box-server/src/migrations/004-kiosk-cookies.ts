import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '004-kiosk-cookies', up };

function up(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE kiosk_pairings ADD COLUMN claimed_at TEXT;

    -- One row per issued pairing cookie. Only the SHA-256 of the token is stored.
    CREATE TABLE kiosk_cookies (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      token_hash TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX idx_kiosk_cookies_device ON kiosk_cookies (device_id);
  `);
}
