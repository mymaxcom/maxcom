import type { AuthIdentity } from './auth/authz.ts';

/**
 * The TV a request speaks for: `self` for the box's own loopback kiosk, the device id for a paired browser screen.
 * Any other identity (an admin reading a kiosk route) is no TV: null, so it gets the surau values.
 */
export function tvIdOf(auth: AuthIdentity | null | undefined): string | null {
  if (auth == null || auth.kind !== 'kiosk') return null;
  if (auth.via === 'loopback') return 'self';
  return auth.deviceId;
}
