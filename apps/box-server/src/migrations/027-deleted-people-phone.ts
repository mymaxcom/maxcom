import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '027-deleted-people-phone', up };

/**
 * A deleted person keeps no phone number. Deleting a person now erases the number (`deleteUserRows`); this clears it for
 * every person deleted before that rule, on a box and on the cloud alike, and removes the `phone` key from the change
 * history of those people (`before_json` and `after_json`). The rows keep their id, rev, edited_at, op_id and origin and
 * nothing is stamped or logged, so cursors, the push marker and the sync merge are untouched and each side cleans its own
 * copy. Safe to run twice: a second run finds nothing to change.
 */
function up(db: DatabaseSync): void {
  const have = new Set(db.prepare('PRAGMA table_info(users)').all().map((r) => String(r.name)));
  if (!have.has('deleted_at') || !have.has('phone')) return;
  db.exec(`UPDATE users SET phone = NULL WHERE deleted_at IS NOT NULL AND phone IS NOT NULL`);
  db.exec(`
    UPDATE change_log SET
      before_json = CASE WHEN before_json IS NOT NULL AND json_valid(before_json) THEN json_remove(before_json, '$.phone') ELSE before_json END,
      after_json = CASE WHEN after_json IS NOT NULL AND json_valid(after_json) THEN json_remove(after_json, '$.phone') ELSE after_json END
     WHERE entity = 'users'
       AND entity_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL)
       AND (before_json LIKE '%"phone"%' OR after_json LIKE '%"phone"%')
  `);
}
