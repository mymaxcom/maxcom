import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeedEntry } from '@surau/core';
import { createUser, promoteSuperadmin, setRoles, setUsersRole } from '../src/auth/users.ts';
import { openDb } from '../src/db.ts';
import { applyFeedEntry } from '../src/sync/apply.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function memDb(role: 'box' | 'cloud'): DatabaseSync {
  const db = openDb(':memory:');
  setUsersRole(db, role);
  dbs.push(db);
  return db;
}

let n = 0;
/** An open session for the user (no PIN needed to hold one when the lock is off). */
function openSession(db: DatabaseSync, userId: string): string {
  n += 1;
  const id = `s${n}`;
  const at = new Date().toISOString();
  db.prepare(
    'INSERT INTO sessions (id, token_hash, device_id, user_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, `h${n}`, 'dev-1', userId, at, new Date(Date.now() + 3_600_000).toISOString(), at);
  return id;
}
const revoked = (db: DatabaseSync, id: string): boolean => db.prepare('SELECT revoked_at FROM sessions WHERE id = ?').get(id)?.revoked_at != null;

describe('gaining the Pentadbir MAXCOM role ends the old sessions', () => {
  it('setRoles: gaining superadmin revokes the sessions; another role change does not', () => {
    const cloud = memDb('cloud');
    const u = createUser(cloud, { name: 'Pentadbir', roles: ['admin'] }, 'test');
    const other = createUser(cloud, { name: 'Lain', roles: ['admin'] }, 'test');
    const s1 = openSession(cloud, u.id);
    const s2 = openSession(cloud, other.id);
    setRoles(cloud, u.id, ['admin', 'ajk'], 'test');
    expect(revoked(cloud, s1)).toBe(false);
    setRoles(cloud, u.id, ['admin', 'ajk', 'superadmin'], 'test');
    expect(revoked(cloud, s1)).toBe(true);
    expect(revoked(cloud, s2)).toBe(false);
    // the session opened afterwards (with the new role) stays; taking the role away is not a gain
    const s3 = openSession(cloud, u.id);
    setRoles(cloud, createUser(cloud, { name: 'Ketiga', roles: ['admin'] }, 'test').id, ['admin', 'superadmin'], 'test'); // so the demotion is allowed
    setRoles(cloud, u.id, ['admin', 'ajk'], 'test');
    expect(revoked(cloud, s3)).toBe(false);
  });

  it('putUserSynced (a cloud entry on a box): gaining superadmin revokes the sessions', () => {
    const box = memDb('box');
    createUser(box, { name: 'Pentadbir Surau', roles: ['admin'] }, 'test');
    const T = '2026-11-09T10:00:00.000Z';
    const entry = (roles: string[], at: string): FeedEntry => ({
      seq: 1, entity: 'user', entityId: 'u-cloud', rev: `${at}|dev-y`, editedAt: at, syncedAt: at, actor: 'user:x', deviceId: null, origin: 'cloud', opId: null,
      after: { name: 'Dari Awan', roles, active: true },
    });
    const ctx = { now: new Date('2026-11-09T10:30:00.000Z'), origin: 'cloud', actor: 'user:x', dataDir: '.' };
    expect(applyFeedEntry(box, entry(['admin'], T), ctx).status).toBe('applied');
    const s = openSession(box, 'u-cloud');
    expect(applyFeedEntry(box, entry(['admin', 'ajk'], '2026-11-09T10:10:00.000Z'), ctx).status).toBe('applied');
    expect(revoked(box, s)).toBe(false);
    expect(applyFeedEntry(box, entry(['admin', 'superadmin'], '2026-11-09T10:20:00.000Z'), ctx).status).toBe('applied');
    expect(revoked(box, s)).toBe(true);
  });

  it('promoteSuperadmin revokes the sessions of the promoted user only', () => {
    const cloud = memDb('cloud');
    const u = createUser(cloud, { name: 'Pentadbir', roles: ['admin'] }, 'test');
    const other = createUser(cloud, { name: 'Lain', roles: ['admin'] }, 'test');
    const s1 = openSession(cloud, u.id);
    const s2 = openSession(cloud, other.id);
    promoteSuperadmin(cloud, u.id, 'local');
    expect(revoked(cloud, s1)).toBe(true);
    expect(revoked(cloud, s2)).toBe(false);
  });
});
