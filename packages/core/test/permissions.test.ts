import { describe, expect, it } from 'vitest';
import {
  can,
  effectiveRoles,
  isRole,
  KIOSK_PERMISSIONS,
  OPS_ROLES,
  PERMISSIONS,
  ROLES,
  ROLE_LABELS_MS,
  ROLE_LABELS_EN,
  type KioskIdentity,
  type Permission,
  type Role,
} from '../src/auth/permissions.ts';

const ALL_PERMISSIONS: readonly Permission[] = [
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
];

const CLOUD_ONLY: readonly Permission[] = ['fleet:read', 'fleet:manage', 'surau:create', 'surau:suspend', 'audit:read_all'];

describe('roles', () => {
  it('declares the roles in a stable order', () => {
    expect([...ROLES]).toEqual(['superadmin', 'admin', 'treasurer', 'media', 'live', 'ajk', 'support']);
  });

  it('labels every role in BM Malaysia', () => {
    expect(ROLE_LABELS_MS.admin).toBe('Pentadbir');
    expect(ROLE_LABELS_MS.treasurer).toBe('Bendahari');
    expect(ROLE_LABELS_MS.media).toBe('Media');
    expect(ROLE_LABELS_MS.ajk).toBe('AJK');
    expect(ROLE_LABELS_MS.support).toBe('Sokongan MAXCOM');
    expect(ROLES.every((r: Role) => ROLE_LABELS_MS[r])).toBe(true);
  });

  it('adds the Siaran Langsung role and labels it in both languages', () => {
    expect(isRole('live')).toBe(true);
    expect(ROLE_LABELS_MS.live).toBe('Siaran Langsung');
    expect(ROLE_LABELS_EN.live).toBe('Live Broadcast');
  });

  it('rejects names that are not roles', () => {
    expect(isRole('root')).toBe(false);
    expect(isRole('Admin')).toBe(false);
    expect(isRole('')).toBe(false);
    for (const r of ROLES) expect(isRole(r)).toBe(true);
  });
});

describe('permission matrix', () => {
  it('gives admin every permission except the system, superadmin and cloud-only ones', () => {
    expect([...PERMISSIONS.admin]).toEqual(
      ALL_PERMISSIONS.filter((p) => !p.startsWith('system:') && p !== 'superadmin:manage' && !CLOUD_ONLY.includes(p)),
    );
  });

  it('gives superadmin every permission: a superset of admin plus the three system ones', () => {
    expect([...PERMISSIONS.superadmin].sort()).toEqual([...ALL_PERMISSIONS].sort());
    for (const p of PERMISSIONS.admin) expect(PERMISSIONS.superadmin).toContain(p);
    for (const p of ['system:read', 'system:write', 'superadmin:manage'] as const) {
      expect(PERMISSIONS.superadmin).toContain(p);
      expect(PERMISSIONS.admin).not.toContain(p);
    }
  });

  it('labels the superadmin Pentadbir MAXCOM / MAXCOM Administrator', () => {
    expect(ROLE_LABELS_MS.superadmin).toBe('Pentadbir MAXCOM');
    expect(ROLE_LABELS_EN.superadmin).toBe('MAXCOM Administrator');
    expect(ROLES.every((r) => ROLE_LABELS_EN[r])).toBe(true);
  });

  it('lets only the superadmin hold system rights', () => {
    expect(can(['superadmin'], 'users:manage')).toBe(true);
    expect(can(['admin'], 'system:write')).toBe(false);
    expect(can(['admin'], 'system:read')).toBe(false);
    expect(can(['admin', 'media'], 'superadmin:manage')).toBe(false);
    expect(can(['superadmin'], 'system:write')).toBe(true);
  });

  it('gives the treasurer finance and read-only views', () => {
    expect([...PERMISSIONS.treasurer]).toEqual([
      'settings:read',
      'content:read',
      'kiosk:read',
      'finance:read',
      'finance:write',
      'health:read',
    ]);
  });

  it('keeps every surau role out of the cloud-only permissions', () => {
    for (const role of ['admin', 'treasurer', 'media', 'live', 'ajk'] as const) {
      for (const p of CLOUD_ONLY) expect(PERMISSIONS[role]).not.toContain(p);
    }
  });

  it('gives media content work but no live access: Media lost live control and live settings, with no migration', () => {
    expect([...PERMISSIONS.media]).toEqual([
      'settings:read',
      'content:read',
      'content:write',
      'assets:write',
      'kiosk:read',
      'health:read',
    ]);
    expect(can(['media'], 'live:control')).toBe(false);
    expect(can(['media'], 'live:settings')).toBe(false);
  });

  it('gives the live role the Siaran Langsung menu and its settings, and nothing else', () => {
    expect([...PERMISSIONS.live]).toEqual([
      'settings:read',
      'kiosk:read',
      'health:read',
      'live:control',
      'live:settings',
    ]);
    expect(can(['live'], 'settings:write')).toBe(false);
    expect(can(['live'], 'content:write')).toBe(false);
    expect(can(['live'], 'users:manage')).toBe(false);
  });

  it('holds live:settings for exactly live, admin and superadmin', () => {
    const holders = ROLES.filter((r) => can([r], 'live:settings'));
    expect([...holders].sort()).toEqual(['admin', 'live', 'superadmin']);
  });

  it('lets a user with Media and Siaran Langsung do both jobs', () => {
    expect(can(['media', 'live'], 'live:control')).toBe(true);
    expect(can(['media', 'live'], 'content:write')).toBe(true);
  });

  it('gives ajk read-only access including finance', () => {
    expect([...PERMISSIONS.ajk]).toEqual([
      'settings:read',
      'content:read',
      'kiosk:read',
      'finance:read',
      'health:read',
    ]);
  });

  it('never grants a permission outside the declared union', () => {
    for (const role of ROLES) {
      for (const p of PERMISSIONS[role]) {
        expect(ALL_PERMISSIONS).toContain(p);
      }
    }
  });
});

describe('can', () => {
  it('denies ajk settings writes', () => {
    expect(can(['ajk'], 'settings:write')).toBe(false);
  });

  it('unions roles', () => {
    expect(can(['ajk', 'media'], 'content:write')).toBe(true);
  });

  it('grants the treasurer finance writes', () => {
    expect(can(['treasurer'], 'finance:write')).toBe(true);
  });

  it('denies media finance reads', () => {
    expect(can(['media'], 'finance:read')).toBe(false);
  });

  it('grants admin user management', () => {
    expect(can(['admin'], 'users:manage')).toBe(true);
  });

  it('denies the empty role set', () => {
    expect(can([], 'kiosk:read')).toBe(false);
  });

  it('respects every matrix row exactly', () => {
    for (const role of ROLES) {
      for (const p of ALL_PERMISSIONS) {
        expect(can([role], p)).toBe((PERMISSIONS[role] as readonly Permission[]).includes(p));
      }
    }
  });
});

describe('kiosk identity', () => {
  it('holds exactly the read permission', () => {
    expect([...KIOSK_PERMISSIONS]).toEqual(['kiosk:read']);
    expect(can([], 'kiosk:read')).toBe(false);
  });

  it('types a kiosk identity that no user role can produce', () => {
    const identity: KioskIdentity = { kind: 'kiosk' };
    expect(identity.kind).toBe('kiosk');
  });
});

describe('support role', () => {
  it('holds only fleet:read', () => {
    expect([...PERMISSIONS.support]).toEqual(['fleet:read']);
    expect(can(['support'], 'fleet:read')).toBe(true);
    expect(can(['support'], 'content:read')).toBe(false);
    expect(can(['support'], 'system:write')).toBe(false);
    expect(can(['support'], 'users:manage')).toBe(false);
  });

  it('labels the support role Sokongan MAXCOM / MAXCOM Support', () => {
    expect(ROLE_LABELS_MS.support).toBe('Sokongan MAXCOM');
    expect(ROLE_LABELS_EN.support).toBe('MAXCOM Support');
  });

  it('never grants a permission outside the declared union', () => {
    for (const p of PERMISSIONS.support) expect(CLOUD_ONLY).toContain(p);
  });
});

describe('OPS_ROLES and effectiveRoles', () => {
  it('declares the ops roles', () => {
    expect([...OPS_ROLES]).toEqual(['superadmin', 'support']);
  });

  it('drops the ops roles on a public device', () => {
    expect(effectiveRoles(['superadmin', 'admin'], false)).toEqual(['admin']);
    expect(effectiveRoles(['superadmin'], false)).toEqual([]);
    expect(effectiveRoles(['support'], false)).toEqual([]);
    expect(effectiveRoles(['superadmin', 'support', 'ajk'], false)).toEqual(['ajk']);
  });

  it('keeps every role on an ops device', () => {
    expect(effectiveRoles(['superadmin', 'admin'], true)).toEqual(['superadmin', 'admin']);
    expect(effectiveRoles(['support'], true)).toEqual(['support']);
    expect(effectiveRoles([], true)).toEqual([]);
  });

  it('leaves a surau role list unchanged either way', () => {
    const roles: Role[] = ['admin', 'treasurer', 'ajk'];
    expect(effectiveRoles(roles, false)).toEqual(roles);
    expect(effectiveRoles(roles, true)).toEqual(roles);
  });

  it('keeps the original order', () => {
    expect(effectiveRoles(['ajk', 'superadmin', 'admin'], false)).toEqual(['ajk', 'admin']);
  });

  it('is pure: the input list is not mutated', () => {
    const roles: Role[] = ['superadmin', 'admin'];
    effectiveRoles(roles, false);
    expect(roles).toEqual(['superadmin', 'admin']);
  });
});
