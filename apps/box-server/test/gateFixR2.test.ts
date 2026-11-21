import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { peopleActivity } from '../src/auth/activity.ts';
import { beginEnrolment, revokeDeviceGuarded } from '../src/auth/devices.ts';
import { activateUser, createUser, deactivateUser, deleteUserIn, getUserInTenant, listUsers, restoreUser } from '../src/auth/users.ts';
import type { TlsMaterial } from '../src/tls.ts';
import { allocatorFor } from '../src/auth/ids.ts';
import { mergeCloudIds } from '../src/sync/peopleIds.ts';
import { applyOfficialCsv, undoImport } from '../src/prayer/importFile.ts';
import { importDaysIn } from '../src/prayerStore.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';

const NAMED = { mode: 'ip', pfx: Buffer.alloc(0), passphrase: '', notAfter: new Date('2030-01-01'), ipSan: ['192.0.2.20'], dnsSan: ['localhost', 'box1-surau.local'] } as TlsMaterial;

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function make(opts: Parameters<typeof buildApp>[1] = {}): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-gr2-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'r2.db'), { dataDir: dir, httpsPort: 8443, tls: NAMED, ...opts });
  apps.push(app);
  return app;
}
const NOW = new Date();
const call = (app: FastifyInstance, who: Login, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload: payload as object }) });

describe('[G-X1] the last admin phone guard counts only the people of this surau', () => {
  it('[G-X1] a surau whose only other admin phone belongs to a * user keeps its own last admin phone', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    await loginAs(app, ['admin', 'superadmin']); // a * user with a public phone at this surau
    expect(() => revokeDeviceGuarded(app.surau.db, admin.deviceId, 'test')).toThrowError(/Pentadbir/);
    expect(app.surau.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(admin.deviceId)?.revoked_at).toBeNull();
  });
});

describe('[G-S2] a * identity is never shown to a surau session', () => {
  it('[G-S2] activity: createdByName and createdByRef of a person a * user added are null for a surau, shown for ops', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const su = await loginAs(app, ['admin', 'superadmin']);
    const made = createUser(app.surau.db, { name: 'Kak Aminah', roles: ['ajk'] }, `user:${su.userId}`, 'sdm');
    const surau = (await call(app, admin, 'GET', '/api/people/activity')).json() as { users: Array<{ id: string; createdByName: string | null; createdByRef: string | null }> };
    const row = surau.users.find((u) => u.id === made.id);
    expect(row).toBeDefined();
    expect(row?.createdByName).toBeNull();
    expect(row?.createdByRef).toBeNull();
    const ops = peopleActivity(app.surau.db, 'sdm', new Date(), 'box', true).users.find((u) => u.id === made.id);
    expect(ops?.createdByName).not.toBeNull();
  });

  it('[G-S2] /api/users shows createdBy and deletedBy of a * actor as system', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const su = await loginAs(app, ['admin', 'superadmin']);
    const made = createUser(app.surau.db, { name: 'Kak Aminah', roles: ['ajk'] }, `user:${su.userId}`, 'sdm');
    const mine = createUser(app.surau.db, { name: 'Pak Daud', roles: ['ajk'] }, `user:${admin.userId}`, 'sdm');
    const list = (await call(app, admin, 'GET', '/api/users')).json() as { users: Array<{ id: string; createdBy: string; deletedBy: string | null }> };
    expect(list.users.find((u) => u.id === made.id)?.createdBy).toBe('system');
    expect(list.users.find((u) => u.id === mine.id)?.createdBy).toBe(`user:${admin.userId}`);
    deleteUserIn(app.surau.db, made.id, `user:${su.userId}`);
    const again = listUsers(app.surau.db, 'sdm', false);
    expect(again.find((u) => u.id === made.id)).toBeUndefined();
    const ops = listUsers(app.surau.db, 'sdm', true).find((u) => u.id === made.id);
    expect(ops?.deletedBy).toBe(`user:${su.userId}`);
  });

  it('[G-S2] finance entry names hide a * user and a * user\'s phone at the surau', async () => {
    const app = make();
    const su = await loginAs(app, ['admin', 'superadmin']);
    const { entryNamesOf } = await import('../src/finance/store.ts');
    const n = entryNamesOf(app.surau.db, su.userId, su.deviceId, null);
    expect(n.createdBy).toBeNull();
    expect(n.createdByRef ?? null).toBeNull();
    expect(n.device).toBeNull();
    expect(n.deviceRef ?? null).toBeNull();
    const t = await loginAs(app, 'treasurer');
    const m = entryNamesOf(app.surau.db, t.userId, t.deviceId, null);
    expect(m.createdBy).not.toBeNull();
    expect(m.device).not.toBeNull();
  });
});

describe('[G-S3] a deleted person cannot be activated or enrolled', () => {
  it('[G-S3] activateUser refuses a deleted row and the tenant lookup of an ops session does not return it', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const x = await loginAs(app, 'ajk');
    const db = app.surau.db;
    deleteUserIn(db, x.userId, `user:${admin.userId}`);
    expect(() => activateUser(db, x.userId, 'test')).toThrowError(/Tidak dijumpai/);
    expect(db.prepare('SELECT active FROM users WHERE id = ?').get(x.userId)?.active).toBe(0);
    expect(getUserInTenant(db, x.userId, 'sdm', true)).toBeUndefined();
    expect(() => beginEnrolment(db, { userId: x.userId, deviceName: 'Telefon' }, 'test')).toThrowError();
  });
});

describe('[G-S4] a device name is cleaned at enrolment', () => {
  it('[G-S4] a bidi override or control character in the name falls back to the default', async () => {
    const app = make();
    const u = createUser(app.surau.db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', 'sdm');
    const a = beginEnrolment(app.surau.db, { userId: u.id, deviceName: 'Telefon ‮evil' }, 'test');
    expect(app.surau.db.prepare('SELECT device_name FROM enrolments WHERE rowid = ?').get(a.id)?.device_name).toBe('Peranti');
    const b = beginEnrolment(app.surau.db, { userId: u.id, deviceName: '  Telefon   Ibu ' }, 'test');
    expect(app.surau.db.prepare('SELECT device_name FROM enrolments WHERE rowid = ?').get(b.id)?.device_name).toBe('Telefon Ibu');
  });
});

describe('[G-Q2] restore and activate refuse a number a live person holds', () => {
  it('[G-Q2] a deleted person holds no number, so a restore cannot clash with the person who now holds it', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const db = app.surau.db;
    const x = createUser(db, { name: 'Kak Siti', roles: ['ajk'], phone: '+60120000011' }, 'test', 'sdm');
    deleteUserIn(db, x.id, 'test');
    expect(db.prepare('SELECT phone FROM users WHERE id = ?').get(x.id)?.phone).toBeNull();
    const other = createUser(db, { name: 'Kak Mah', roles: ['ajk'], phone: '+60120000011' }, 'test', 'sdm');
    const r = await call(app, admin, 'POST', `/api/users/${x.id}/restore`, {});
    expect(r.statusCode).toBe(200);
    const back = db.prepare('SELECT deleted_at, phone FROM users WHERE id = ?').get(x.id);
    expect(back?.deleted_at).toBeNull();
    expect(back?.phone).toBeNull();
    expect(db.prepare('SELECT phone FROM users WHERE id = ?').get(other.id)?.phone).toBe('+60120000011');
  });

  it('[G-Q2] activate refuses 409 phone_taken when a live person now holds the number', async () => {
    const app = make();
    const db = app.surau.db;
    const x = createUser(db, { name: 'Kak Siti', roles: ['ajk'], phone: '+60120000012' }, 'test', 'sdm');
    deactivateUser(db, x.id, 'test');
    db.prepare('UPDATE users SET phone = NULL WHERE id = ?').run(x.id);
    createUser(db, { name: 'Kak Mah', roles: ['ajk'], phone: '+60120000012' }, 'test', 'sdm');
    db.prepare('UPDATE users SET phone = ? WHERE id = ?').run('+60120000012', x.id);
    expect(() => activateUser(db, x.id, 'test')).toThrowError(/digunakan/);
  });
});

describe('[G-S6] no share text for a Pentadbir while the app lock is off', () => {
  it('[G-S6] sharePayload is omitted for an admin target with the lock off and kept for an ajk', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const other = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const forAdmin = (await call(app, admin, 'POST', '/api/enrol/begin', { userId: other.userId, deviceName: 'Telefon' })).json() as Record<string, unknown>;
    expect(forAdmin.payload).toBeDefined();
    expect(forAdmin).not.toHaveProperty('sharePayload');
    const forAjk = (await call(app, admin, 'POST', '/api/enrol/begin', { userId: ajk.userId, deviceName: 'Telefon' })).json() as Record<string, unknown>;
    expect(forAjk).toHaveProperty('sharePayload');
  });
});

describe('[G-S7] the activity answer flags a surau with no Pentadbir phone', () => {
  it('[G-S7] noAdminPhone is true with an admin who has no phone, false once one has', async () => {
    const app = make();
    const db = app.surau.db;
    createUser(db, { name: 'Pak Admin', roles: ['admin'] }, 'test', 'sdm');
    expect(peopleActivity(db, 'sdm', new Date(), 'box', false).noAdminPhone).toBe(true);
    const a = await loginAs(app, 'admin');
    expect(peopleActivity(db, 'sdm', new Date(), 'box', false).noAdminPhone).toBe(false);
    db.prepare("UPDATE devices SET platform = 'kiosk' WHERE id = ?").run(a.deviceId);
    expect(peopleActivity(db, 'sdm', new Date(), 'box', false).noAdminPhone).toBe(true);
  });
});

describe('[G-S9] renaming a phone has its own limiter', () => {
  it('[G-S9] renames do not use up the PIN change limit', async () => {
    const app = make();
    const a = await loginAs(app, 'ajk');
    for (let i = 0; i < 8; i++) {
      const r = await call(app, a, 'PUT', '/api/auth/device/name', { name: `Telefon ${i}` });
      expect(r.statusCode, String(i)).toBe(200);
    }
    const pin = await call(app, a, 'PUT', '/api/auth/pin', { currentPin: '000000', newPin: '123456' });
    expect(pin.statusCode).not.toBe(429);
  });
});

describe('[G-S8] a secondary or once-linked box never numbers its own records', () => {
  it('[G-S8] a linked box with no role yet, and an unlinked box with link history, allocate nothing; a never-linked box and a primary do', () => {
    const app = make();
    const db = app.surau.db;
    expect(allocatorFor(db, 'sdm')).toBe('b');
    db.prepare("INSERT INTO sync_state (key, value) VALUES ('linked', '1')").run();
    expect(allocatorFor(db, 'sdm')).toBeNull();
    const a = createUser(db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', 'sdm');
    expect(a.ref).toBeNull();
    db.prepare("DELETE FROM sync_state WHERE key = 'linked'").run();
    db.prepare("INSERT INTO sync_state (key, value) VALUES ('link_history', '1')").run();
    expect(allocatorFor(db, 'sdm')).toBeNull();
    db.prepare("INSERT INTO sync_state (key, value) VALUES ('site_role', 'primary')").run();
    expect(allocatorFor(db, 'sdm')).toBe('b');
    db.prepare("UPDATE sync_state SET value = 'secondary' WHERE key = 'site_role'").run();
    expect(allocatorFor(db, 'sdm')).toBeNull();
  });

  it('[G-S8] a secondary box adopts the numbers the cloud sends for its people', () => {
    const app = make();
    const db = app.surau.db;
    db.prepare("INSERT INTO sync_state (key, value) VALUES ('site_role', 'secondary')").run();
    const a = createUser(db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', 'sdm');
    expect(a.ref).toBeNull();
    expect(mergeCloudIds(db, { users: [{ id: a.id, no: 7 }], devices: [] })).toBe(1);
    expect(db.prepare('SELECT no, no_src FROM users WHERE id = ?').get(a.id)).toMatchObject({ no: 7, no_src: 'c' });
  });
});

describe('[G-Q4] undoing an official CSV load leaves days changed since', () => {
  const day = (date: string, subuh: string) =>
    ({ date, hijri: { year: 1448, month: 1, day: 1 }, times: { imsak: '05:40', subuh, syuruk: '07:00', zohor: '13:10', asar: '16:30', maghrib: '19:20', isyak: '20:30' } }) as never;
  it('[G-Q4] only the days that still hold what the load wrote are restored or removed; the rest are reported', () => {
    const app = make();
    const db = app.surau.db;
    importDaysIn(db, 'SGR01', [day('2026-12-01', '05:50')], 'user:t', undefined, {}, 'sdm');
    const r = applyOfficialCsv(db, 'SGR01', [day('2026-12-01', '05:51'), day('2026-12-02', '05:52'), day('2026-12-03', '05:53')], 'user:t', undefined, new Date(), 'sdm');
    // a later change of the 2nd and 3rd days (a manual replace)
    db.prepare("UPDATE prayer_days SET json = ? WHERE surau_id = 'sdm' AND zone = 'SGR01' AND date = '2026-12-02'").run(JSON.stringify(day('2026-12-02', '05:59')));
    const res = undoImport(db, r.id, 'user:t', undefined, new Date(), 'sdm');
    expect(res).toMatchObject({ ok: true, restored: 2, skipped: ['2026-12-02'] });
    const get = (d: string) => (JSON.parse(String(db.prepare("SELECT json FROM prayer_days WHERE surau_id = 'sdm' AND zone = 'SGR01' AND date = ?").get(d)?.json)) as { times: { subuh: string } }).times.subuh;
    expect(get('2026-12-01')).toBe('05:50');
    expect(get('2026-12-02')).toBe('05:59');
    expect(db.prepare("SELECT 1 AS x FROM prayer_days WHERE surau_id = 'sdm' AND zone = 'SGR01' AND date = '2026-12-03'").get()).toBeUndefined();
  });
});
