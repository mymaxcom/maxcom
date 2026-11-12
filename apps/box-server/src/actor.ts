import type { AuthIdentity } from './auth/authz.ts';

/** change_log actor for a request: `user:<id>` when a signed-in user, else `'local'`. */
export function actorOf(request: { auth?: AuthIdentity | null }): string {
  const a = request.auth;
  return a != null && a.kind === 'user' ? `user:${a.userId}` : 'local';
}

/** Device that made the request (for change_log.device_id), if a signed-in user. */
export function deviceOf(request: { auth?: AuthIdentity | null }): string | undefined {
  const a = request.auth;
  return a != null && a.kind === 'user' ? a.deviceId : undefined;
}
