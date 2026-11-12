/**
 * The Pentadbir MAXCOM sees every surau's money by right; the Pentadbir Surau must be able to see that they did.
 * One `finance:view` row per session and route per ten minutes, written by the finance routes and by the sync feed
 * and snapshot when they hand finance rows to that caller.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AuthIdentity } from '../auth/authz.ts';
import { logChange } from '../auth/users.ts';

export const VIEW_WINDOW_MS = 10 * 60_000;

const seen = new WeakMap<DatabaseSync, Map<string, number>>();

/** True for a signed-in Pentadbir MAXCOM (the superadmin role). */
export function isPentadbirMaxcom(auth: AuthIdentity | null | undefined): auth is Extract<AuthIdentity, { kind: 'user' }> {
  return auth != null && auth.kind === 'user' && auth.roles.includes('superadmin');
}

export function noteFinanceView(
  db: DatabaseSync, auth: AuthIdentity | null | undefined, route: string, now: Date, actor: string, deviceId?: string,
): void {
  if (!isPentadbirMaxcom(auth)) return;
  let map = seen.get(db);
  if (map === undefined) { map = new Map(); seen.set(db, map); }
  const key = `${auth.sessionId}|${route}`;
  const nowMs = now.getTime();
  const last = map.get(key);
  if (last !== undefined && nowMs - last < VIEW_WINDOW_MS) return;
  if (map.size > 500) for (const [k, t] of map) if (nowMs - t >= VIEW_WINDOW_MS) map.delete(k);
  map.set(key, nowMs);
  logChange(db, actor, 'finance:view', route, undefined, { route }, deviceId === undefined ? undefined : { deviceId });
}
