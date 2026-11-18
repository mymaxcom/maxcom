import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { listDevices, getDeviceInTenant, activeAdminDeviceCount, enrolDeviceSynced } from '../src/auth/devices.ts';
import { generateSyncKeyPair } from '../src/sync/syncKey.ts';
import { leaveDevice } from '../src/auth/leave.ts';
import type { AuthContext } from '../src/auth/sessions.ts';
import {
  activeAdminCount,
  createUser,
  getUserInTenant,
  listUsers,
  promoteSuperadmin,
  putUserSynced,
  setRoles,
  setUsersRole,
} from '../src/auth/users.ts';
import { openDb } from '../src/db.ts';
import { DEFAULT_SURAU_ID } from '../src/sync/verify.ts';
import { getVersion } from '../src/settingsStore.ts';
import { insertSite } from './support/sites.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function make(role: 'box' | 'cloud'): DatabaseSync {
  const db = openDb(':memory:');
  setUsersRole(db, role);
  dbs.push(db);
  return db;
}

let n = 0;
function addDevice(db: DatabaseSync, userId: string, surauId: string, platform = 'android'): string {
  const id = `dev-${++n}`;
  db.prepare(
    `INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at, surau_id) VALUES (?, ?, ?, ?, '{}', ?, ?)`,
  ).run(id, userId, id, platform, `2026-11-12T00:00:${String(n).padStart(2, '0')}.000Z`, surauId);
  return id;
}

const surauOf = (db: DatabaseSync, userId: string): string =>
  String(db.prepare('SELECT surau_id FROM users WHERE id = ?').get(userId)?.surau_id);

const ctxOf = (userId: string, deviceId: string, roles: AuthContext['roles']): AuthContext => ({
  kind: 'user',
  userId,
  deviceId,
  roles,
  sessionId: 's',
  ops: false,
});

describe('users scoped by surau', () => {
  it('lists are disjoint between two suraus', () => {
    const db = make('cloud');
    const a = createUser(db, { name: 'Ali', roles: ['admin'] }, 't', 'sdm');
    const b = createUser(db, { name: 'Bakar', roles: ['admin'] }, 't', 'masjid-b');
    expect(listUsers(db, 'sdm').map((u) => u.id)).toEqual([a.id]);
    expect(listUsers(db, 'masjid-b').map((u) => u.id)).toEqual([b.id]);
    expect(getUserInTenant(db, a.id, 'sdm')?.name).toBe('Ali');
    expect(getUserInTenant(db, a.id, 'masjid-b')).toBeUndefined();

    const da = addDevice(db, a.id, 'sdm');
    const dbb = addDevice(db, b.id, 'masjid-b');
    expect(listDevices(db, undefined, {}, 'sdm').map((d) => d.id)).toEqual([da]);
    expect(listDevices(db, undefined, {}, 'masjid-b').map((d) => d.id)).toEqual([dbb]);
    expect(getDeviceInTenant(db, da, 'sdm')?.id).toBe(da);
    expect(getDeviceInTenant(db, da, 'masjid-b')).toBeUndefined();
  });

  it('the default surau is the local one', () => {
    const db = make('box');
    const u = createUser(db, { name: 'Ali', roles: ['admin'] }, 't', 'sdm');
    expect(surauOf(db, u.id)).toBe(DEFAULT_SURAU_ID);
    expect(listUsers(db, 'sdm').map((x) => x.id)).toEqual([u.id]);
  });

  it('last_admin is counted per surau', () => {
    const db = make('cloud');
    const a = createUser(db, { name: 'Ali', roles: ['admin'] }, 't', 'sdm');
    const a2 = createUser(db, { name: 'Ahmad', roles: ['admin'] }, 't', 'sdm');
    const b = createUser(db, { name: 'Bakar', roles: ['admin'] }, 't', 'masjid-b');
    expect(activeAdminCount(db, 'sdm')).toBe(2);
    expect(activeAdminCount(db, 'masjid-b')).toBe(1);
    // masjid-b has one admin: demoting them is refused although sdm has two
    expect(() =>
      putUserSynced(db, b.id, { name: 'Bakar', roles: ['ajk'], active: true }, 'x', { origin: 'cloud', trusted: false } as never, 'masjid-b'),
    ).toThrowError(expect.objectContaining({ code: 'last_admin' }));
    // sdm has two: the same change succeeds there
    putUserSynced(db, a.id, { name: 'Ali', roles: ['ajk'], active: true }, 'x', { origin: 'cloud', trusted: false } as never, 'sdm');
    expect(activeAdminCount(db, 'sdm')).toBe(1);
    expect(a2.id).toBeTruthy();
  });

  it('a * user is hidden from every surau listing (an ops session sees it as Pentadbir MAXCOM only), and is nobody is the last admin', () => {
    const db = make('cloud');
    const a = createUser(db, { name: 'Ali', roles: ['admin'] }, 't', 'sdm');
    createUser(db, { name: 'Bakar', roles: ['admin'] }, 't', 'masjid-b');
    promoteSuperadmin(db, a.id, 'cli');
    expect(surauOf(db, a.id)).toBe('*');
    for (const s of ['sdm', 'masjid-b', 'baru']) {
      // hidden from a surau session (decision 22); an ops-device session sees it as Pentadbir MAXCOM only
      expect(listUsers(db, s).find((u) => u.id === a.id)).toBeUndefined();
      expect(getUserInTenant(db, a.id, s)).toBeUndefined();
      expect(listUsers(db, s, true).find((u) => u.id === a.id)?.roles).toEqual(['superadmin']);
      expect(getUserInTenant(db, a.id, s, true)?.roles).toEqual(['superadmin']);
    }
    expect(activeAdminCount(db, 'sdm')).toBe(0);
    expect(activeAdminCount(db, 'masjid-b')).toBe(1);
  });
});

describe('superadmin and users.surau_id', () => {
  it('promoteSuperadmin files the user under * (cloud and box, as migration 019)', () => {
    for (const role of ['cloud', 'box'] as const) {
      const db = make(role);
      const u = createUser(db, { name: 'Ali', roles: ['admin'] }, 't', 'masjid-b');
      expect(promoteSuperadmin(db, u.id, 'cli').roles).toContain('superadmin');
      expect(surauOf(db, u.id)).toBe('*');
    }
  });

  it('cloud: granting superadmin sets *, removing it restores the surau of the user\'s live home device', () => {
    const db = make('cloud');
    const boss = createUser(db, { name: 'Bos', roles: ['admin'] }, 't', 'sdm');
    promoteSuperadmin(db, boss.id, 'cli');
    const u = createUser(db, { name: 'Ali', roles: ['admin'] }, 't', 'masjid-b');
    addDevice(db, u.id, 'masjid-b');
    setRoles(db, u.id, ['admin', 'superadmin'], 'bos');
    expect(surauOf(db, u.id)).toBe('*');
    setRoles(db, u.id, ['admin'], 'bos');
    expect(surauOf(db, u.id)).toBe('masjid-b');
  });

  it('removal with no live home device falls back to the local surau constant', () => {
    const db = make('cloud');
    const u = createUser(db, { name: 'Ali', roles: ['admin'] }, 't', 'masjid-b');
    createUser(db, { name: 'Bos', roles: ['admin', 'superadmin'] }, 't', 'sdm');
    setRoles(db, u.id, ['admin', 'superadmin'], 'bos');
    expect(surauOf(db, u.id)).toBe('*');
    setRoles(db, u.id, ['admin'], 'bos');
    expect(surauOf(db, u.id)).toBe(DEFAULT_SURAU_ID);
  });
});

describe('a synced device of a * user (qs-gate)', () => {
  const synced = (db: DatabaseSync, id: string, userId: string, siteSurau?: string): void =>
    enrolDeviceSynced(
      db,
      { id, userId, name: 'Telefon', platform: 'android', publicJwk: generateSyncKeyPair().publicJwk, enrolledAt: '2026-11-12T00:00:00.000Z' },
      'site',
      { origin: 'box:b2b2b2b2b2b2b2b2' },
      'b2b2b2b2b2b2b2b2',
      siteSurau,
    );
  const deviceSurauOf = (db: DatabaseSync, id: string): string => String(db.prepare('SELECT surau_id FROM devices WHERE id = ?').get(id)?.surau_id);

  it('cloud: a * user device from a site takes the site surau, never *', () => {
    const db = make('cloud');
    const boss = createUser(db, { name: 'Bos', roles: ['admin', 'support'] }, 't', 'masjid-b');
    expect(surauOf(db, boss.id)).toBe('*');
    synced(db, 'dev-star-1', boss.id, 'masjid-b');
    expect(deviceSurauOf(db, 'dev-star-1')).toBe('masjid-b');
  });

  it('cloud: an ordinary user device keeps the user surau', () => {
    const db = make('cloud');
    const u = createUser(db, { name: 'Ali', roles: ['admin'] }, 't', 'masjid-b');
    synced(db, 'dev-plain-1', u.id, 'masjid-b');
    expect(deviceSurauOf(db, 'dev-plain-1')).toBe('masjid-b');
  });
});

describe('a * change is announced to the suraus with a site (qs-gate)', () => {
  it('cloud: bumps every surau that has a site, never sdm when sdm has none', () => {
    const db = make('cloud');
    insertSite(db, { surauId: 'masjid-a' });
    insertSite(db, { surauId: 'masjid-b' });
    const boss = createUser(db, { name: 'Bos', roles: ['admin'] }, 't', 'masjid-a');
    const before = { a: getVersion(db, 'masjid-a'), b: getVersion(db, 'masjid-b'), sdm: getVersion(db, 'sdm') };
    promoteSuperadmin(db, boss.id, 'cli');
    expect(getVersion(db, 'masjid-a')).toBeGreaterThan(before.a);
    expect(getVersion(db, 'masjid-b')).toBeGreaterThan(before.b);
    expect(getVersion(db, 'sdm')).toBe(before.sdm);
  });

  it('box: a * change bumps the local surau as before', () => {
    const db = make('box');
    const boss = createUser(db, { name: 'Bos', roles: ['admin'] }, 't', 'sdm');
    const before = getVersion(db, 'sdm');
    promoteSuperadmin(db, boss.id, 'cli');
    expect(getVersion(db, 'sdm')).toBeGreaterThan(before);
  });
});

describe('leaving: the last Pentadbir device of a surau', () => {
  it('uses the user\'s real roles, not the session roles (a Pentadbir MAXCOM on a public device)', () => {
    const db = make('cloud');
    const u = createUser(db, { name: 'Ali', roles: ['admin', 'superadmin'] }, 't', 'sdm');
    const dev = addDevice(db, u.id, 'sdm');
    // the public-device session carries no admin and no superadmin
    const ctx = ctxOf(u.id, dev, ['ajk']);
    expect(() => leaveDevice(db, ctx, new Date())).toThrowError(expect.objectContaining({ code: 'last_admin_device' }));
    expect(db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(dev)?.revoked_at).toBeNull();
  });

  it('counts per surau: another surau\'s Pentadbir device does not let the last one leave', () => {
    const db = make('cloud');
    const a = createUser(db, { name: 'Ali', roles: ['admin'] }, 't', 'sdm');
    const b = createUser(db, { name: 'Bakar', roles: ['admin'] }, 't', 'masjid-b');
    const da = addDevice(db, a.id, 'sdm');
    addDevice(db, b.id, 'masjid-b');
    expect(activeAdminDeviceCount(db, 'sdm')).toBe(1);
    expect(() => leaveDevice(db, ctxOf(a.id, da, ['admin']), new Date())).toThrowError(
      expect.objectContaining({ code: 'last_admin_device' }),
    );
  });

  it('succeeds while the surau keeps another Pentadbir device', () => {
    const db = make('cloud');
    const a = createUser(db, { name: 'Ali', roles: ['admin'] }, 't', 'sdm');
    const a2 = createUser(db, { name: 'Ahmad', roles: ['admin'] }, 't', 'sdm');
    const da = addDevice(db, a.id, 'sdm');
    addDevice(db, a2.id, 'sdm');
    leaveDevice(db, ctxOf(a.id, da, ['ajk']), new Date());
    expect(db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(da)?.revoked_at).not.toBeNull();
    expect(activeAdminDeviceCount(db, 'sdm')).toBe(1);
  });
});
