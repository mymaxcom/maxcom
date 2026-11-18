import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createUser } from '../src/auth/users.ts';
import { loginAs } from './authHelpers.ts';
import { makeIdsPair } from './support/idsPair.ts';
import type { IdsPair } from './support/idsPair.ts';
import { insertSite } from './support/sites.ts';

const pairs: IdsPair[] = [];
afterEach(async () => {
  for (const p of pairs.splice(0)) await p.close();
});
async function pair(): Promise<IdsPair> {
  const p = await makeIdsPair();
  pairs.push(p);
  return p;
}

const refOf = (db: DatabaseSync, table: 'users' | 'devices', id: string): string | null => {
  const r = db.prepare(`SELECT no, no_src FROM ${table} WHERE id = ?`).get(id);
  if (r === undefined || r.no === null) return null;
  const prefix = table === 'users' ? 'U' : 'D';
  return `${prefix}-${r.no_src === 'c' ? 'C' : ''}${String(r.no).padStart(4, '0')}`;
};
/** Makes the next round ask the cloud again (the box asks at most once a minute while a record waits for its ID). */
const askAgain = (db: DatabaseSync): void => void db.prepare("DELETE FROM sync_state WHERE key = 'device_seen_try_at'").run();

describe('[PP-S8] two servers never issue the same ID', () => {
  it('[PP-S8] the box offline and the cloud each create a user for one surau: both end with both, with different IDs (U-0001 and U-C0001)', async () => {
    const p = await pair();
    await p.round(); // a linked box numbers its own records only once the cloud has said it is the primary
    const onBox = createUser(p.box.surau.db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', 'sdm');
    const onCloud = createUser(p.cloud.app.surau.db, { name: 'Encik Rahman', roles: ['ajk'] }, 'test', 'sdm');
    expect(onBox.ref).toBe('U-0001');
    expect(onCloud.ref).toBe('U-C0001');
    await p.round();
    askAgain(p.box.surau.db);
    await p.round();
    for (const db of [p.box.surau.db, p.cloud.app.surau.db]) {
      expect(refOf(db, 'users', onBox.id)).toBe('U-0001');
      expect(refOf(db, 'users', onCloud.id)).toBe('U-C0001');
    }
  });

  it('[PP-S8] a device number travels up with the enrolment entry', async () => {
    const p = await pair();
    await p.round(); // a linked box numbers its own records only once the cloud has said it is the primary
    const a = await loginAs(p.box, 'ajk');
    await p.round();
    const boxRef = refOf(p.box.surau.db, 'devices', a.deviceId);
    expect(boxRef).toMatch(/^D-\d{4}$/);
    expect(refOf(p.cloud.app.surau.db, 'devices', a.deviceId)).toBe(boxRef);
    expect(refOf(p.cloud.app.surau.db, 'users', a.userId)).toBe(refOf(p.box.surau.db, 'users', a.userId));
  });

  it('[PP-S8] a box the cloud says is secondary creates a user with no ID; the cloud assigns a C-series ID at ingest and it comes back', async () => {
    const p = await pair();
    await p.round(); // the box learns its role
    p.cloud.app.surau.db.prepare("UPDATE sites SET role = 'secondary' WHERE box_id = ?").run(p.box.surau.boxId);
    askAgain(p.box.surau.db);
    await p.round();
    expect(p.box.surau.db.prepare("SELECT value FROM sync_state WHERE key = 'site_role'").get()?.value).toBe('secondary');
    const u = createUser(p.box.surau.db, { name: 'Haji Osman', roles: ['ajk'] }, 'test', 'sdm');
    expect(u.ref).toBeNull();
    await p.round();
    expect(refOf(p.cloud.app.surau.db, 'users', u.id)).toBe('U-C0001');
    askAgain(p.box.surau.db);
    await p.round();
    expect(refOf(p.box.surau.db, 'users', u.id)).toBe('U-C0001');
  });

  it('[PP-S8] an entry from a non-primary site carrying a b number is not trusted: the cloud assigns its own', async () => {
    const p = await pair();
    await p.round(); // a linked box numbers its own records only once the cloud has said it is the primary
    const u = createUser(p.box.surau.db, { name: 'Puan Aminah', roles: ['ajk'] }, 'test', 'sdm');
    expect(u.ref).toBe('U-0001');
    p.cloud.app.surau.db.prepare("UPDATE sites SET role = 'secondary' WHERE box_id = ?").run(p.box.surau.boxId);
    await p.round();
    expect(refOf(p.cloud.app.surau.db, 'users', u.id)).toBe('U-C0001');
  });

  it('[PP-S8] restore case: the cloud holds U-0007 for X, a box whose counter is at 7 creates Y as U-0007: the cloud refuses, the box renumbers above maxNo, both end with different IDs', async () => {
    const p = await pair();
    await p.round(); // a linked box numbers its own records only once the cloud has said it is the primary
    const cloudDb = p.cloud.app.surau.db;
    const boxDb = p.box.surau.db;
    cloudDb.prepare("INSERT INTO users (id, name, roles_json, active, created_at, created_by, surau_id, no, no_src) VALUES ('x-rec', 'Kak Siti', '[\"ajk\"]', 1, '2026-01-01T00:00:00.000Z', 'test', 'sdm', 7, 'b')").run();
    boxDb.prepare("INSERT OR REPLACE INTO id_counters (surau_id, kind, next) VALUES ('sdm', 'user', 7)").run();
    const y = createUser(boxDb, { name: 'Encik Rahman', roles: ['ajk'] }, 'test', 'sdm');
    expect(y.ref).toBe('U-0007');
    await p.round();
    expect(cloudDb.prepare("SELECT 1 AS x FROM users WHERE id = ?").get(y.id)).toBeUndefined();
    expect(refOf(boxDb, 'users', y.id)).toBe('U-0008');
    await p.round();
    expect(refOf(cloudDb, 'users', y.id)).toBe('U-0008');
    expect(refOf(cloudDb, 'users', 'x-rec')).toBe('U-0007');
  });
});

describe('[PP-S8] POST /api/sync/people-ids', () => {
  const rawUser = (db: DatabaseSync, id: string, surau = 'sdm'): void =>
    void db.prepare("INSERT INTO users (id, name, roles_json, active, created_at, created_by, surau_id) VALUES (?, 'Kak Siti', '[\"ajk\"]', 1, '2026-01-01T00:00:00.000Z', 'test', ?)").run(id, surau);

  it('[PP-S8] a primary site fills the cloud rows once; a second call changes nothing', async () => {
    const p = await pair();
    const db = p.cloud.app.surau.db;
    rawUser(db, 'a1');
    rawUser(db, 'a2');
    const site = { headers: { authorization: `Bearer ${await siteToken(p)}` } };
    const body = { users: [{ id: 'a1', no: 1 }, { id: 'a2', no: 2 }], devices: [] };
    const r = await p.cloud.app.inject({ method: 'POST', url: '/api/sync/people-ids', headers: site.headers, payload: body });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ stored: 2, taken: [], adopt: [] });
    expect(refOf(db, 'users', 'a1')).toBe('U-0001');
    const again = await p.cloud.app.inject({ method: 'POST', url: '/api/sync/people-ids', headers: site.headers, payload: body });
    expect(again.json()).toMatchObject({ stored: 0, taken: [], adopt: [] });
  });

  it('[PP-S8] a number another record holds is taken; a row the cloud already numbered is adopted by the box', async () => {
    const p = await pair();
    const db = p.cloud.app.surau.db;
    rawUser(db, 'b1');
    rawUser(db, 'b2');
    rawUser(db, 'b3');
    db.prepare("UPDATE users SET no = 5, no_src = 'b' WHERE id = 'b1'").run();
    db.prepare("UPDATE users SET no = 1, no_src = 'c' WHERE id = 'b3'").run();
    const h = { authorization: `Bearer ${await siteToken(p)}` };
    const r = await p.cloud.app.inject({ method: 'POST', url: '/api/sync/people-ids', headers: h, payload: { users: [{ id: 'b2', no: 5 }, { id: 'b3', no: 9 }, { id: 'unknown', no: 5 }] } });
    expect(r.json().taken).toEqual([{ kind: 'user', id: 'b2' }, { kind: 'user', id: 'unknown' }]);
    expect(r.json().adopt).toEqual([{ kind: 'user', id: 'b3', no: 1, src: 'c' }]);
    expect(refOf(db, 'users', 'b2')).toBeNull();
  });

  it('[PP-S8] a secondary site, a person session and a malformed body are refused', async () => {
    const p = await pair();
    const db = p.cloud.app.surau.db;
    const secondary = insertSite(db, { boxId: 'ee'.repeat(8), surauId: 'sdm' });
    db.prepare("UPDATE sites SET role = 'secondary' WHERE box_id = ?").run(secondary.boxId);
    expect((await p.cloud.app.inject({ method: 'POST', url: '/api/sync/people-ids', headers: secondary.headers, payload: { users: [] } })).statusCode).toBe(403);
    const admin = await loginAs(p.cloud.app, 'admin');
    expect((await p.cloud.app.inject({ method: 'POST', url: '/api/sync/people-ids', headers: admin.headers, payload: { users: [] } })).statusCode).toBe(404);
    const primary = { authorization: `Bearer ${await siteToken(p)}` };
    for (const payload of [{ users: 'x' }, { users: [{ id: 'a b', no: 1 }] }, { users: [{ id: 'ok', no: 0 }] }, { users: [{ id: 'ok', no: 1.5 }] }]) {
      expect((await p.cloud.app.inject({ method: 'POST', url: '/api/sync/people-ids', headers: primary, payload })).statusCode).toBe(400);
    }
  });
});

/** A fresh site token for the pair's own (primary) box: the cloud stores only hashes, so the test makes its own site. */
async function siteToken(p: IdsPair): Promise<string> {
  const db = p.cloud.app.surau.db;
  const s = insertSite(db, { boxId: 'cd'.repeat(8), surauId: 'sdm' });
  return s.token;
}
