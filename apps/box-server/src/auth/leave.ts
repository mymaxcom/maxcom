import type { DatabaseSync } from 'node:sqlite';
import { bumpVersion } from '../settingsStore.ts';
import { activeAdminDeviceCount } from '../setup/state.ts';
import { authLog } from './sessions.ts';
import type { AuthContext } from './sessions.ts';
import { AuthError, MSG, revokeDeviceRow, tx } from './users.ts';

/**
 * A phone leaves its surau: revoke exactly the caller's own device (and so its sessions), never another device
 * and never a TV screen. The last Pentadbir device may not leave: the surau would be left with nobody to run it
 * (the box would fall into recovery), so the answer is 409 `last_admin_device` and nothing changes.
 */
export function leaveDevice(db: DatabaseSync, ctx: AuthContext, now: Date): void {
  const nowIso = now.toISOString();
  try {
    tx(db, () => {
      const dev = db.prepare('SELECT id, user_id, platform, revoked_at FROM devices WHERE id = ?').get(ctx.deviceId);
      if (dev === undefined || dev.user_id !== ctx.userId || dev.platform === 'kiosk') {
        throw new AuthError(403, 'forbidden', MSG.forbidden);
      }
      if (dev.revoked_at !== null) return; // already gone: the session was dead anyway
      const holdsAdmin = ctx.roles.includes('admin') || ctx.roles.includes('superadmin');
      revokeDeviceRow(db, ctx.deviceId, `user:${ctx.userId}`, nowIso);
      // Counted after the revoke, inside the same transaction: a refusal rolls the revoke back.
      if (holdsAdmin && activeAdminDeviceCount(db) === 0) {
        throw new AuthError(409, 'last_admin_device', 'Daftar peranti Pentadbir lain dahulu');
      }
      bumpVersion(db);
    });
  } catch (e) {
    if (e instanceof AuthError) authLog(db, now, 'leave', false, { userId: ctx.userId, deviceId: ctx.deviceId, detail: e.code });
    throw e;
  }
  authLog(db, now, 'leave', true, { userId: ctx.userId, deviceId: ctx.deviceId });
}
