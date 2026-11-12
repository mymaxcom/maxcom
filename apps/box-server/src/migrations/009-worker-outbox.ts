import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '009-worker-outbox', up };

/**
 * The cloud's outbox towards the Cloudflare Worker's admin routes (Plan 6, "no lost set").
 *
 * One row per key (`dirty/<boxId>`, `dev/<deviceId>`, `site/<boxId>`): a newer change to the same key
 * replaces the row (the dirty seq keeps the larger value), so a Worker that is down does not make the
 * table grow. `rev` counts replacements: the sender deletes a row only if it is still the revision it sent.
 *
 * The rows are written by triggers, in the very statement that causes them, so they commit or roll back
 * with the change. The triggers do nothing unless the cloud has switched the outbox on
 * (`sync_state.worker_outbox = '1'`, set at start only when a Worker is configured), so a box or an
 * always-on cloud without a Worker never queues anything.
 *
 *  - change_log insert (a change a box can pull): the `dirty` item of every linked site except the one
 *    that sent the change, with `seq` = the new change id (never lowered).
 *  - devices insert, or revoked_at changed: `dev_put {jwk, revoked}` with the four public members only;
 *    a key that is not EC P-256 or that carries `d` is never queued. Devices without a key (kiosks) are skipped.
 *  - devices delete: `dev_delete`.
 *
 * `site_put` / `site_delete` are queued by code (the body is sealed with the cloud key).
 */
function up(db: DatabaseSync): void {
  const on = "(SELECT value FROM sync_state WHERE key = 'worker_outbox') = '1'";
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  const goodJwk = (col: string): string =>
    // CASE short-circuits: json_extract on text that is not JSON would raise an error
    `(CASE WHEN ${col} IS NOT NULL AND json_valid(${col}) THEN ` +
    `(json_extract(${col}, '$.kty') = 'EC' AND json_extract(${col}, '$.crv') = 'P-256' ` +
    `AND json_type(${col}, '$.x') = 'text' AND json_type(${col}, '$.y') = 'text' AND json_type(${col}, '$.d') IS NULL) ELSE 0 END)`;
  const devBody = (r: string): string =>
    `json_object('jwk', json_object('kty', 'EC', 'crv', 'P-256', 'x', json_extract(${r}.public_jwk, '$.x'), 'y', json_extract(${r}.public_jwk, '$.y')), ` +
    `'revoked', json(CASE WHEN ${r}.revoked_at IS NULL THEN 'false' ELSE 'true' END))`;
  const devUpsert = (r: string): string =>
    `INSERT INTO worker_outbox (kind, key, body, created_at) VALUES ('dev_put', 'dev/' || ${r}.id, ${devBody(r)}, ${now}) ` +
    `ON CONFLICT(key) DO UPDATE SET kind = 'dev_put', body = excluded.body, state = 'pending', attempts = 0, next_at = '', last_error = NULL, rev = worker_outbox.rev + 1;`;

  db.exec(`
    CREATE TABLE worker_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('dirty', 'dev_put', 'dev_delete', 'site_put', 'site_delete')),
      key TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_at TEXT NOT NULL DEFAULT '',
      last_error TEXT,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'failed')),
      rev INTEGER NOT NULL DEFAULT 1
    );

    CREATE TRIGGER worker_outbox_dirty AFTER INSERT ON change_log
    WHEN ${on} AND (NEW.entity LIKE 'content:%' OR NEW.entity IN ('settings', 'users', 'user', 'devices', 'device'))
    BEGIN
      INSERT INTO worker_outbox (kind, key, body, created_at)
        SELECT 'dirty', 'dirty/' || box_id, json_object('seq', NEW.id), ${now}
          FROM sites
         WHERE linked_at IS NOT NULL AND revoked_at IS NULL AND token_hash IS NOT NULL AND NEW.origin <> 'box:' || box_id
      ON CONFLICT(key) DO UPDATE SET
        kind = 'dirty',
        body = json_object('seq', max(NEW.id, COALESCE(json_extract(worker_outbox.body, '$.seq'), 0))),
        attempts = CASE WHEN worker_outbox.state = 'failed' THEN 0 ELSE worker_outbox.attempts END,
        next_at = CASE WHEN worker_outbox.state = 'failed' THEN '' ELSE worker_outbox.next_at END,
        state = 'pending',
        rev = worker_outbox.rev + 1;
    END;

    CREATE TRIGGER worker_outbox_dev_insert AFTER INSERT ON devices
    WHEN ${on} AND ${goodJwk('NEW.public_jwk')}
    BEGIN
      ${devUpsert('NEW')}
    END;

    CREATE TRIGGER worker_outbox_dev_revoke AFTER UPDATE OF revoked_at ON devices
    WHEN ${on} AND NEW.revoked_at IS NOT OLD.revoked_at AND ${goodJwk('NEW.public_jwk')}
    BEGIN
      ${devUpsert('NEW')}
    END;

    CREATE TRIGGER worker_outbox_dev_delete AFTER DELETE ON devices
    WHEN ${on} AND OLD.public_jwk IS NOT NULL
    BEGIN
      INSERT INTO worker_outbox (kind, key, body, created_at) VALUES ('dev_delete', 'dev/' || OLD.id, '{}', ${now})
      ON CONFLICT(key) DO UPDATE SET kind = 'dev_delete', body = '{}', state = 'pending', attempts = 0, next_at = '', last_error = NULL, rev = worker_outbox.rev + 1;
    END;
  `);
}
