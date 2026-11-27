import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '029-linked-boxes', up };

/**
 * Several boxes in one surau (2026.11.15). Two new tables, no change to an existing one.
 *
 * `linked_boxes`: on the master (kotak utama), one row per follower box (kotak pengikut). The follower reads what a TV
 * reads through the TV device row `device_id` and its token; the row keeps the follower's identity key so the master
 * can seal to it and name it. `removed_at` set = taken off (Tanggalkan or Putuskan pautan); the row stays for the log.
 *
 * `link_sessions`: one row per link or unlink attempt on THIS box, on either side. Every step of the state machine is
 * one durable write of `step`, so a restart finds where it was. `answers_json`, its revision and hash are what the
 * admins agree to; `own_sig` and `peer_sig` are the two boxes' signatures over that hash. Nothing in a store is
 * changed before both exist. The step journal of the store move itself lives outside the database (the store is what moves).
 */
function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS linked_boxes (
      device_id TEXT PRIMARY KEY REFERENCES devices(id),
      box_id TEXT NOT NULL UNIQUE,
      key_fp TEXT NOT NULL,
      public_jwk TEXT NOT NULL,
      name TEXT NOT NULL,
      local_name TEXT,
      addresses_json TEXT NOT NULL DEFAULT '[]',
      version TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      last_seen_at TEXT,
      removed_at TEXT,
      link_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS link_sessions (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('link', 'unlink')),
      role TEXT NOT NULL CHECK (role IN ('show', 'scan')),
      peer_box_id TEXT,
      peer_jwk TEXT,
      peer_origin TEXT,
      peer_ca TEXT,
      code TEXT,
      own_agreed_rev INTEGER,
      peer_agreed_rev INTEGER,
      peer_hello_json TEXT,
      own_hello_json TEXT,
      step TEXT NOT NULL,
      answers_json TEXT,
      answers_rev INTEGER NOT NULL DEFAULT 0,
      answers_hash TEXT,
      own_sig TEXT,
      peer_sig TEXT,
      pin_proof_at TEXT,
      pin_proof_user TEXT,
      started_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      committed_at TEXT,
      finished_at TEXT,
      outcome TEXT
    );
    CREATE INDEX IF NOT EXISTS link_sessions_open ON link_sessions (finished_at, expires_at);
  `);
}
