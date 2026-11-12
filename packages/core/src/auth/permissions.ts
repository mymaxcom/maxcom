export type Role = 'superadmin' | 'admin' | 'treasurer' | 'media' | 'ajk';

export const ROLES: readonly Role[] = ['superadmin', 'admin', 'treasurer', 'media', 'ajk'];

export const ROLE_LABELS_MS: Record<Role, string> = {
  superadmin: 'Pentadbir MAXCOM',
  admin: 'Pentadbir',
  treasurer: 'Bendahari',
  media: 'Media',
  ajk: 'AJK',
};

export const ROLE_LABELS_EN: Record<Role, string> = {
  superadmin: 'MAXCOM Administrator',
  admin: 'Administrator',
  treasurer: 'Treasurer',
  media: 'Media',
  ajk: 'Committee',
};

export type Permission =
  | 'settings:read'
  | 'settings:write'
  | 'prayer:import'
  | 'content:read'
  | 'content:write'
  | 'assets:write'
  | 'islamic:fetch'
  | 'kiosk:read'
  | 'live:control'
  | 'finance:read'
  | 'finance:write'
  | 'users:manage'
  | 'devices:manage'
  | 'audit:read'
  | 'health:read'
  | 'system:read'
  | 'system:write'
  | 'superadmin:manage';

export const PERMISSIONS: Record<Role, readonly Permission[]> = {
  // Written out in full (no spreads): the Dart twin reads this table from the source text.
  superadmin: [
    'settings:read',
    'settings:write',
    'prayer:import',
    'content:read',
    'content:write',
    'assets:write',
    'islamic:fetch',
    'kiosk:read',
    'live:control',
    'finance:read',
    'finance:write',
    'users:manage',
    'devices:manage',
    'audit:read',
    'health:read',
    'system:read',
    'system:write',
    'superadmin:manage',
  ],
  admin: [
    'settings:read',
    'settings:write',
    'prayer:import',
    'content:read',
    'content:write',
    'assets:write',
    'islamic:fetch',
    'kiosk:read',
    'live:control',
    'finance:read',
    'finance:write',
    'users:manage',
    'devices:manage',
    'audit:read',
    'health:read',
  ],
  treasurer: [
    'settings:read',
    'content:read',
    'kiosk:read',
    'finance:read',
    'finance:write',
    'health:read',
  ],
  media: [
    'settings:read',
    'content:read',
    'content:write',
    'assets:write',
    'kiosk:read',
    'live:control',
    'health:read',
  ],
  ajk: ['settings:read', 'content:read', 'kiosk:read', 'finance:read', 'health:read'],
};

export function isRole(s: string): s is Role {
  return (ROLES as readonly string[]).includes(s);
}

export function can(roles: readonly Role[], p: Permission): boolean {
  return roles.some((role) => (PERMISSIONS[role] as readonly Permission[]).includes(p));
}

export interface KioskIdentity {
  kind: 'kiosk';
}

export const KIOSK_PERMISSIONS: readonly Permission[] = ['kiosk:read'];
