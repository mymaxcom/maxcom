import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { revokeDeviceRow, tx } from '../auth/users.ts';
import { clearRecoveryHash, setRecoveryHash } from '../setup/codes.ts';
import { LINK_ID_RE } from './journal.ts';
import { adminDevices, isKeptList } from './keepAdmins.ts';
import type { KeptDevice } from './keepAdmins.ts';
import { CLOUD_RESET_REL, RESTORED_REL, writeFileAtomic } from './setAside.ts';

/**
 * The first start on a restored store. SECURITY code.
 *
 * A restore brings back the store of link day: its people, and with them the phones and sessions of that day. A
 * person removed since then would be let in again by an old enrolment. So before anything is served:
 *
 * - every phone and app device row that is not revoked is revoked, and every session with it (people and roles stay;
 *   each phone joins again under the eyes of an admin), EXCEPT a Pentadbir phone the mark names that is still a
 *   Pentadbir's (same id, same key, active person holding admin) in this restored store (`keepAdmins.ts`); every
 *   session is revoked all the same, the app signs in again with its key;
 * - every follower box this store names is taken off: a store of link day must not hand a TV token back to a box
 *   that was linked, removed or never came;
 * - a paired browser screen (a kiosk row that is no follower box) keeps its pairing: it reads the TV data and
 *   nothing else, and the plan says the pairings of that date return.
 *
 * The cloud copy of this surau has moved on since link day: syncing now would bring the newer rows back into the
 * restored store. A second mark holds the sync until the cloud copy was made equal to the box.
 *
 * The recovery code hash in use before the swap (carried by the mark) is written into the restored store in the same
 * transaction, so the code the admin was given at the link, or any later one, still completes recovery; without a
 * carried hash the restored store keeps its own.
 *
 * The work is one transaction and the mark is removed after it: a stop in between repeats it at the next start, and
 * a second run finds nothing left to revoke.
 */
export interface RestoreApplied {
  linkId: string;
  /** Phone and app devices revoked now. */
  devices: number;
  /** Follower boxes taken off now. */
  boxes: number;
}

interface Mark {
  linkId: string;
  at: string;
  /** The recovery code hash in use before the swap (null: none existed, the old one goes; absent: unknown, the store keeps its own). */
  recoveryHash?: string | null;
  /** Pentadbir phones of the store in use before the swap that stay if the restored store agrees. */
  keepDevices?: KeptDevice[];
}

function readMark(dataDir: string): Mark | null {
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, RESTORED_REL), 'utf8');
  } catch {
    return null;
  }
  try {
    const m = JSON.parse(raw) as { v?: unknown; linkId?: unknown; at?: unknown; recoveryHash?: unknown; keepDevices?: unknown } | null;
    if (m !== null && typeof m === 'object' && m.v === 1 && typeof m.linkId === 'string' && LINK_ID_RE.test(m.linkId) && typeof m.at === 'string') {
      const h = m.recoveryHash === null ? null : typeof m.recoveryHash === 'string' && /^[0-9a-f]{64}$/.test(m.recoveryHash) ? m.recoveryHash : undefined;
      return { linkId: m.linkId, at: m.at, ...(h === undefined ? {} : { recoveryHash: h }), ...(isKeptList(m.keepDevices) ? { keepDevices: m.keepDevices } : {}) };
    }
  } catch {
    // falls through: a mark that cannot be read still means "a restore happened"
  }
  return { linkId: 'unknown', at: '' };
}

export function restoreMarked(dataDir: string): boolean {
  return readMark(dataDir) !== null;
}

export function applyRestoreMark(db: DatabaseSync, dataDir: string, now: Date): RestoreApplied | null {
  const mark = readMark(dataDir);
  if (mark === null) return null;
  const at = now.toISOString();
  const actor = 'system:link-restore';
  let devices = 0;
  let boxes = 0;
  let kept = 0;
  // Before the database work, so a stop after the revoke still finds the sync held.
  writeFileAtomic(join(dataDir, CLOUD_RESET_REL), JSON.stringify({ v: 1, linkId: mark.linkId, at, reason: 'restore' }));
  tx(db, () => {
    const hasBoxes = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'linked_boxes'").get() !== undefined;
    if (hasBoxes) {
      const rows = db.prepare('SELECT device_id FROM linked_boxes WHERE removed_at IS NULL').all();
      for (const r of rows) {
        const id = String(r.device_id);
        db.prepare('DELETE FROM kiosk_cookies WHERE device_id = ?').run(id);
        db.prepare('UPDATE linked_boxes SET removed_at = ? WHERE device_id = ?').run(at, id);
        revokeDeviceRow(db, id, actor, at);
        boxes += 1;
      }
    }
    // A carried phone stays only if the restored store still has it as an active Pentadbir's, with the same key.
    const keep = new Set<string>();
    if (mark.keepDevices !== undefined && mark.keepDevices.length > 0) {
      const inRestored = new Map(adminDevices(db).map((d) => [d.id, d.key]));
      for (const k of mark.keepDevices) if (inRestored.get(k.id) === k.key) keep.add(k.id);
    }
    const phones = db.prepare("SELECT id FROM devices WHERE revoked_at IS NULL AND platform <> 'kiosk'").all();
    for (const r of phones) {
      if (keep.has(String(r.id))) {
        kept += 1;
        continue;
      }
      if (revokeDeviceRow(db, String(r.id), actor, at)) devices += 1;
    }
    // A session whose device row is gone or was revoked earlier dies too.
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL').run(at);
    // The newest recovery code an admin was shown stays valid: the restored store has the hash of link day.
    if (mark.recoveryHash === null) clearRecoveryHash(db);
    else if (mark.recoveryHash !== undefined) setRecoveryHash(db, mark.recoveryHash);
    db.prepare('INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, NULL, ?)')
      .run(at, actor, 'link', mark.linkId, JSON.stringify({ event: 'restored', backupAt: mark.at, devicesRevoked: devices, devicesKept: kept, boxesRemoved: boxes }));
  });
  rmSync(join(dataDir, RESTORED_REL), { force: true });
  return { linkId: mark.linkId, devices, boxes };
}

/** True while the cloud copy still has to be made equal to this box (set by a restore; cleared by the cloud reset). */
export function cloudResetOwed(dataDir: string): boolean {
  try {
    readFileSync(join(dataDir, CLOUD_RESET_REL));
    return true;
  } catch {
    return false;
  }
}
