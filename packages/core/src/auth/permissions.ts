export type Role = 'superadmin' | 'admin' | 'treasurer' | 'media' | 'live' | 'ajk' | 'support';

export const ROLES: readonly Role[] = ['superadmin', 'admin', 'treasurer', 'media', 'live', 'ajk', 'support'];

export const ROLE_LABELS_MS: Record<Role, string> = {
  superadmin: 'Pentadbir MAXCOM',
  admin: 'Pentadbir',
  treasurer: 'Bendahari',
  media: 'Media',
  live: 'Siaran Langsung',
  ajk: 'AJK',
  support: 'Sokongan MAXCOM',
};

export const ROLE_LABELS_EN: Record<Role, string> = {
  superadmin: 'MAXCOM Administrator',
  admin: 'Administrator',
  treasurer: 'Treasurer',
  media: 'Media',
  live: 'Live Broadcast',
  ajk: 'Committee',
  support: 'MAXCOM Support',
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
  | 'live:settings'
  | 'finance:read'
  | 'finance:write'
  | 'users:manage'
  | 'devices:manage'
  | 'audit:read'
  | 'health:read'
  | 'system:read'
  | 'system:write'
  | 'superadmin:manage'
  | 'fleet:read'
  | 'fleet:manage'
  | 'surau:create'
  | 'surau:suspend'
  | 'audit:read_all';

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
    'live:settings',
    'finance:read',
    'finance:write',
    'users:manage',
    'devices:manage',
    'audit:read',
    'health:read',
    'system:read',
    'system:write',
    'superadmin:manage',
    'fleet:read',
    'fleet:manage',
    'surau:create',
    'surau:suspend',
    'audit:read_all',
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
    'live:settings',
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
    'health:read',
  ],
  // Siaran Langsung: the live menu and its settings, nothing else. Assigned by hand by the Pentadbir (no migration).
  live: ['settings:read', 'kiosk:read', 'health:read', 'live:control', 'live:settings'],
  ajk: ['settings:read', 'content:read', 'kiosk:read', 'finance:read', 'health:read'],
  support: ['fleet:read'],
};

export function isRole(s: string): s is Role {
  return (ROLES as readonly string[]).includes(s);
}

export function can(roles: readonly Role[], p: Permission): boolean {
  return roles.some((role) => (PERMISSIONS[role] as readonly Permission[]).includes(p));
}

export const OPS_ROLES: readonly Role[] = ['superadmin', 'support'];

export function effectiveRoles(roles: readonly Role[], opsDevice: boolean): Role[] {
  return opsDevice ? [...roles] : roles.filter((r) => !OPS_ROLES.includes(r));
}

export interface KioskIdentity {
  kind: 'kiosk';
}

export const KIOSK_PERMISSIONS: readonly Permission[] = ['kiosk:read'];
