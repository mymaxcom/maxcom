import type { DatabaseSync } from 'node:sqlite';
import { activeAdminDeviceCount } from './devices.ts';
import { authLog } from './sessions.ts';
import type { AuthContext } from './sessions.ts';
import { AuthError, MSG, bumpFor, getUserRow, revokeDeviceRow, tx } from './users.ts';

/**
 * A phone leaves its surau: revoke exactly the caller's own device (and so its sessions), never another device
 * and never a TV screen. The last Pentadbir device may not leave: the surau would be left with nobody to run it
 * (the box would fall into recovery), so the answer is 409 `last_admin_device` and nothing changes.
 */
export function leaveDevice(db: DatabaseSync, ctx: AuthContext, now: Date): void {
  const nowIso = now.toISOString();
  try {
    tx(db, () => {
      const dev = db.prepare('SELECT id, user_id, platform, revoked_at, surau_id FROM devices WHERE id = ?').get(ctx.deviceId);
      if (dev === undefined || dev.user_id !== ctx.userId || dev.platform === 'kiosk') {
        throw new AuthError(403, 'forbidden', MSG.forbidden);
      }
      if (dev.revoked_at !== null) return; // already gone: the session was dead anyway
      // The user's real roles from the database, not the session's: a Pentadbir MAXCOM on a public device has no
      // `superadmin` in `ctx.roles` (Plan 14 Task 23), and the last Pentadbir device must still not leave.
      const real = getUserRow(db, ctx.userId)?.roles ?? ctx.roles;
      const holdsAdmin = real.includes('admin') || real.includes('superadmin');
      revokeDeviceRow(db, ctx.deviceId, `user:${ctx.userId}`, nowIso);
      // Counted after the revoke, inside the same transaction: a refusal rolls the revoke back.
      if (holdsAdmin && dev.surau_id !== '*' && activeAdminDeviceCount(db, String(dev.surau_id)) === 0) {
        throw new AuthError(409, 'last_admin_device', 'Daftar peranti Pentadbir lain dahulu');
      }
      bumpFor(db, String(dev.surau_id));
    });
  } catch (e) {
    if (e instanceof AuthError) authLog(db, now, 'leave', false, { userId: ctx.userId, deviceId: ctx.deviceId, detail: e.code });
    throw e;
  }
  authLog(db, now, 'leave', true, { userId: ctx.userId, deviceId: ctx.deviceId });
}
