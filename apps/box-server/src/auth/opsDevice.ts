import type { DatabaseSync } from 'node:sqlite';
import { OPS_ROLES, effectiveRoles } from '@surau/core';
import type { Role } from '@surau/core';
import { beginEnrolment, deviceFromRow } from './devices.ts';
import type { Device } from './devices.ts';
import { AuthError, getUserRow, logChange, tx } from './users.ts';

/**
 * Ops devices (Plan 14 section 3.4). The ops roles (`superadmin`, `support`) count only on a device born from a
 * CLI-issued ops enrolment code (`devices.ops = 1`). Phase 1: the rule applies on the cloud; a box returns the
 * user's roles unchanged until Task 27 carries the flag down. The flag is never read from a request body, a
 * header or a site entry, and never enters the change feed in Phase 1.
 */

/** Live ops devices one user may hold at once (open ops codes count too, so the cap cannot be outrun). */
export const MAX_OPS_DEVICES = 3;

export const holdsOpsRole = (roles: readonly Role[]): boolean => roles.some((r) => OPS_ROLES.includes(r));

/** Whether the device row carries the ops flag. Unknown ids are not ops devices. */
export function isOpsDevice(db: DatabaseSync, deviceId: string): boolean {
  if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > 100) return false;
  const row = db.prepare('SELECT ops FROM devices WHERE id = ?').get(deviceId);
  return row !== undefined && Number(row.ops) === 1;
}

/**
 * The roles a user acts with from this device. On the cloud: the user's roles minus every ops role unless the
 * device is an ops device. On a box: the user's roles unchanged (Phase 1).
 */
export function effectiveRolesFor(
  db: DatabaseSync,
  user: { roles: readonly Role[] },
  deviceId: string,
  server: { role: 'box' | 'cloud' },
): Role[] {
  if (server.role !== 'cloud') return [...user.roles];
  return effectiveRoles(user.roles, isOpsDevice(db, deviceId));
}

/**
 * Issue a single-use ops enrolment code (10 minutes, only its hash stored, `enrolments.ops = 1`). Refuses a user
 * without an ops role (`not_ops_user`) and a user who already holds `MAX_OPS_DEVICES` live ops devices or open
 * ops codes (`ops_device_limit`). Reached only from the cloud CLI (`ops-enrol`); no route calls it.
 */
export function issueOpsEnrolment(
  db: DatabaseSync,
  input: { userId: string; deviceName: string },
  actor: string,
): { code: string; expiresAt: string } {
  return beginEnrolment(db, { userId: input.userId, deviceName: input.deviceName, ttlMinutes: 10 }, actor, {
    canManageSuperadmin: true,
    opsCli: true,
  });
}

/**
 * Clear the ops flag of a device and end every open session of it: from the next unlock it is a public device.
 * Writes one `auth_log` row `ops_unmark` and a `devices` change_log row (no `ops` key: not in the feed in Phase 1).
 */
export function unmarkOps(db: DatabaseSync, deviceId: string, actor: string): void {
  const nowIso = new Date().toISOString();
  tx(db, () => {
    const row = typeof deviceId === 'string' && deviceId.length <= 100 ? db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) : undefined;
    if (row === undefined) throw new AuthError(404, 'device_not_found', 'Peranti tidak dijumpai');
    if (Number(row.ops) !== 1) throw new AuthError(409, 'not_ops_device', 'Peranti ini bukan peranti MAXCOM Ops');
    db.prepare('UPDATE devices SET ops = 0 WHERE id = ?').run(deviceId);
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(nowIso, deviceId);
    const d = deviceFromRow(row as Record<string, unknown>);
    // The same secret-free fields a device entry already carries; a reader applies it as a no-op.
    const snap = { id: d.id, userId: d.userId, name: d.name, platform: d.platform, revoked: d.revokedAt !== null, enrolledAt: d.enrolledAt };
    logChange(db, actor, 'devices', d.id, snap, snap, undefined, String(row.surau_id));
    db.prepare(
      `INSERT INTO auth_log (at, event, user_id, device_id, ip, ok, detail) VALUES (?, 'ops_unmark', ?, ?, NULL, 1, 'ops_unmark')`,
    ).run(nowIso, d.userId, d.id);
  });
}

/** Every live ops device, and separately every live public device of a user holding an ops role. */
export function listOpsDevices(db: DatabaseSync): { ops: Device[]; publicOfOpsUsers: Device[] } {
  const rows = db
    .prepare('SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY enrolled_at, id')
    .all() as Record<string, unknown>[];
  const ops: Device[] = [];
  const publicOfOpsUsers: Device[] = [];
  const opsUser = new Map<string, boolean>();
  for (const r of rows) {
    if (Number(r.ops) === 1) {
      ops.push(deviceFromRow(r));
      continue;
    }
    const uid = String(r.user_id);
    if (!opsUser.has(uid)) opsUser.set(uid, holdsOpsRole(getUserRow(db, uid)?.roles ?? []));
    if (opsUser.get(uid) === true) publicOfOpsUsers.push(deviceFromRow(r));
  }
  return { ops, publicOfOpsUsers };
}
