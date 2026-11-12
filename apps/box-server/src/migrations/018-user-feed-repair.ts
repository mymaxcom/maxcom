import type { DatabaseSync } from 'node:sqlite';
import { getUserRow, logChange } from '../auth/users.ts';
import { bumpVersion } from '../settingsStore.ts';

export const migration = { name: '018-user-feed-repair', up };

/**
 * Before 2026.11.5 an enrolment that set a PIN logged the user as a fragment `{ id, hasPin, pinChanged }`
 * (auth/devices.ts). Readers of the feed (MAX Admin Client, the cloud) REPLACE their copy of a record with
 * the latest `after`, so they were left with a user that has no name or roles, and the app's Pengguna and
 * Peranti screens failed ("type 'Null' is not a subtype of type 'String'"). For every user whose latest
 * logged record lacks a name, log the full record once more; the next sync repairs every reader.
 */
function up(db: DatabaseSync): void {
  const users = db.prepare('SELECT id FROM users').all();
  const latest = db.prepare(
    "SELECT after_json FROM change_log WHERE entity IN ('users', 'user') AND entity_id = ? ORDER BY id DESC LIMIT 1",
  );
  let repaired = 0;
  for (const u of users) {
    const id = String(u.id);
    const row = latest.get(id);
    if (row === undefined) continue; // never logged, so no reader holds a broken copy
    let after: unknown = null;
    try {
      after = typeof row.after_json === 'string' ? JSON.parse(row.after_json) : null;
    } catch {
      after = null;
    }
    const ok = after !== null && typeof after === 'object' && typeof (after as { name?: unknown }).name === 'string';
    if (ok) continue;
    const user = getUserRow(db, id);
    if (user === undefined) continue;
    const snap = { id: user.id, name: user.name, roles: user.roles, active: user.active, hasPin: !user.pinRequired };
    // Stamped with the row's own last edit, not "now": a repair restates the box's state and must not win a
    // last-writer-wins merge against a newer edit made elsewhere (the cloud) that this box has not pulled yet.
    const stamp = db.prepare('SELECT edited_at, rev FROM users WHERE id = ?').get(id);
    const editedAt = typeof stamp?.edited_at === 'string' ? stamp.edited_at : undefined;
    const rev = typeof stamp?.rev === 'string' ? stamp.rev : undefined;
    logChange(db, 'system:repair', 'users', id, after ?? undefined, snap, {
      ...(editedAt !== undefined ? { editedAt } : {}),
      ...(rev !== undefined ? { rev } : {}),
    });
    repaired++;
  }
  if (repaired > 0) bumpVersion(db);
}
