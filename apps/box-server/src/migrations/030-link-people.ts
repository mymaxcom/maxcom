import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '030-link-people', up };

/**
 * People of two linked boxes (2026.11.15, phase 2C). One new table and two new columns of `link_sessions`.
 *
 * `link_sessions.own_people_json` / `peer_people_json`: the people list each box sent at the questions step (names,
 * phone numbers, roles, a count of phones; never a PIN hash or a device key). The answers hash covers both, so a
 * consent is for exactly the people both admins were shown.
 *
 * `link_people`: on the master, one row per person a link merged: created here, matched to a person already here
 * (by phone or, when the admins said so, by name) or given one more role. `roles_before_json` lets a link that fails
 * after the merge put roles back; `from_box_id` and `peer_user_id` say where the person came from (used at unlink).
 */
function up(db: DatabaseSync): void {
  const cols = new Set(db.prepare('PRAGMA table_info(link_sessions)').all().map((r) => String(r.name)));
  if (!cols.has('own_people_json')) db.exec('ALTER TABLE link_sessions ADD COLUMN own_people_json TEXT');
  if (!cols.has('peer_people_json')) db.exec('ALTER TABLE link_sessions ADD COLUMN peer_people_json TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS link_people (
      link_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      from_box_id TEXT NOT NULL,
      peer_user_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('created', 'same', 'role')),
      roles_before_json TEXT,
      at TEXT NOT NULL,
      PRIMARY KEY (link_id, peer_user_id)
    );
    CREATE INDEX IF NOT EXISTS link_people_user ON link_people (user_id);
  `);
}
