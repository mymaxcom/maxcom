import { describe, expect, it } from 'vitest';
import {
  can,
  isRole,
  KIOSK_PERMISSIONS,
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
  'finance:read',
  'finance:write',
  'users:manage',
  'devices:manage',
  'audit:read',
  'health:read',
  'system:read',
  'system:write',
  'superadmin:manage',
];

describe('roles', () => {
  it('declares the roles in a stable order', () => {
    expect([...ROLES]).toEqual(['superadmin', 'admin', 'treasurer', 'media', 'ajk']);
  });

  it('labels every role in BM Malaysia', () => {
    expect(ROLE_LABELS_MS.admin).toBe('Pentadbir');
    expect(ROLE_LABELS_MS.treasurer).toBe('Bendahari');
    expect(ROLE_LABELS_MS.media).toBe('Media');
    expect(ROLE_LABELS_MS.ajk).toBe('AJK');
    expect(ROLES.every((r: Role) => ROLE_LABELS_MS[r])).toBe(true);
  });

  it('rejects names that are not roles', () => {
    expect(isRole('root')).toBe(false);
    expect(isRole('Admin')).toBe(false);
    expect(isRole('')).toBe(false);
    for (const r of ROLES) expect(isRole(r)).toBe(true);
  });
});

describe('permission matrix', () => {
  it('gives admin every permission except the three system ones', () => {
    expect([...PERMISSIONS.admin]).toEqual(ALL_PERMISSIONS.filter((p) => !p.startsWith('system:') && p !== 'superadmin:manage'));
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

  it('gives media content and live control', () => {
    expect([...PERMISSIONS.media]).toEqual([
      'settings:read',
      'content:read',
      'content:write',
      'assets:write',
      'kiosk:read',
      'live:control',
      'health:read',
    ]);
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
