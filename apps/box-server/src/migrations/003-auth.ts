import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '003-auth', up };

function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE users (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      roles_json TEXT NOT NULL,
      pin_hash TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      pin_fail_count INTEGER NOT NULL DEFAULT 0,
      pin_locked_until TEXT,
      lock_round INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );

    CREATE TABLE devices (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      public_jwk TEXT,
      enrolled_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT
    );

    CREATE TABLE enrolments (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      code_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_name TEXT,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_by TEXT NOT NULL
    );

    CREATE TABLE sessions (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE challenges (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      nonce TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );

    CREATE TABLE auth_log (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      id INTEGER PRIMARY KEY,
      at TEXT NOT NULL,
      event TEXT NOT NULL,
      user_id TEXT,
      device_id TEXT,
      ip TEXT,
      ok INTEGER NOT NULL,
      detail TEXT
    );

    CREATE TABLE kiosk_pairings (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      code_hash TEXT PRIMARY KEY,
      poll_token_hash TEXT NOT NULL UNIQUE,
      ip TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_by TEXT,
      device_id TEXT
    );

    CREATE INDEX idx_devices_user ON devices (user_id);
    CREATE INDEX idx_sessions_device ON sessions (device_id);
    CREATE INDEX idx_enrolments_user ON enrolments (user_id);

    ALTER TABLE change_log ADD COLUMN device_id TEXT;
  `);
}
