import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '013-box-codes', up };

/**
 * Plan 14. One row per box QR code (setup, recovery, network probe). Only the sha256 of the nonce is stored,
 * never the nonce; a used row stays 24 hours for the record, then purgeExpired drops it. A spent setup or recovery
 * row also names the device it created (id, user, public key thumbprint, nothing secret) so a lost reply can be resumed.
 */
function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS box_codes (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      nonce_hash TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      used_ip TEXT,
      outcome TEXT,
      device_id TEXT,
      user_id TEXT,
      key_thumb TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_box_codes_type ON box_codes (type, expires_at);
  `);
}
