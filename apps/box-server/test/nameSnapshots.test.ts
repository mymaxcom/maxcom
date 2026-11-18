import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { createUser, logChange } from '../src/auth/users.ts';
import { migration } from '../src/migrations/022-people-relook.ts';
import { putFeature } from '../src/settingsStore.ts';
import { appendEntry, ensureSeeded, insertReplicatedEntry, listFunds, listPerihal } from '../src/finance/store.ts';
import { loginAs } from './authHelpers.ts';

const AT = klInstant('2026-11-10', '10:00');
const box = { surauId: 'sdm', now: AT, role: 'box' as const };
const dbs: DatabaseSync[] = [];
const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) d.close();
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh(): { db: DatabaseSync; fundA: string; perIn: string; ahmad: string; aminah: string } {
  const db = openDb(':memory:');
  dbs.push(db);
  ensureSeeded(db, 'test', AT, 'sdm');
  const ahmad = createUser(db, { name: 'Ustaz Ahmad', roles: ['treasurer'] }, 'test', 'sdm').id;
  const aminah = createUser(db, { name: 'Puan Aminah', roles: ['admin'] }, 'test', 'sdm').id;
  return { db, fundA: listFunds(db, undefined, 'sdm')[0]!.id, perIn: listPerihal(db, undefined, 'sdm').find((p) => p.direction === 'in')!.id, ahmad, aminah };
}

const cash = (s: ReturnType<typeof fresh>, id: string) => ({
  id, kind: 'in', entryDate: '2026-11-06', fundId: s.fundA, perihalId: s.perIn, amountSen: 1000, method: 'tunai',
  counters: [{ userId: s.ahmad }, { userId: s.aminah }],
});

const count = (db: DatabaseSync, t: string): number => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()!.n);

/** Put a database back to how it was before 022 wrote its snapshots. */
function unsnapshot(db: DatabaseSync): void {
  db.exec('DROP TRIGGER trg_fin_entries_immutable');
  db.exec('UPDATE finance_entries SET names_json = NULL; UPDATE change_log SET actor_name = NULL');
}

describe('[PP-S1] migration 022', () => {
  it('[PP-S1] backfills the names of the time, keeps every row, and a second run changes nothing', () => {
    const s = fresh();
    logChange(s.db, `user:${s.ahmad}`, 'content:kuliah', 'k1', undefined, { a: 1 }, undefined, 'sdm');
    logChange(s.db, `user:${s.ahmad}`, 'content:kuliah', 'k2', undefined, { a: 2 }, undefined, 'sdm');
    logChange(s.db, 'system', 'content:kuliah', 'k3', undefined, { a: 3 }, undefined, 'sdm');
    appendEntry(s.db, cash(s, 'e1'), `user:${s.ahmad}`, box);
    unsnapshot(s.db);
    const logs = count(s.db, 'change_log');
    const entries = count(s.db, 'finance_entries');
    migration.up(s.db);
    const rows = s.db.prepare("SELECT actor, entity_id, actor_name FROM change_log WHERE entity = 'content:kuliah' ORDER BY id").all();
    expect(rows.map((r) => r.actor_name)).toEqual(['Ustaz Ahmad', 'Ustaz Ahmad', null]);
    expect(JSON.parse(String(s.db.prepare("SELECT names_json AS j FROM finance_entries WHERE id = 'e1'").get()!.j))).toEqual({
      createdBy: 'Ustaz Ahmad', device: null, counters: { [s.ahmad]: 'Ustaz Ahmad', [s.aminah]: 'Puan Aminah' },
    });
    expect(count(s.db, 'change_log')).toBe(logs);
    expect(count(s.db, 'finance_entries')).toBe(entries);
    const dump = () => JSON.stringify([s.db.prepare('SELECT * FROM change_log ORDER BY id').all(), s.db.prepare('SELECT * FROM finance_entries').all()]);
    const before = dump();
    migration.up(s.db);
    expect(dump()).toBe(before);
  });

  it('[PP-S1] creates every later column, the unique ID indexes and the flags, and dates earlier deactivations', () => {
    const s = fresh();
    const cols = (t: string) => s.db.prepare(`PRAGMA table_info(${t})`).all().map((r) => String(r.name));
    expect(cols('users')).toEqual(expect.arrayContaining(['deleted_at', 'deleted_by', 'deactivated_at', 'phone', 'no', 'no_src']));
    expect(cols('devices')).toEqual(expect.arrayContaining(['no', 'no_src']));
    expect(cols('enrolments')).toEqual(expect.arrayContaining(['cancelled_at', 'device_id']));
    expect(cols('id_counters')).toEqual(['surau_id', 'kind', 'next']);
    const idx = s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => String(r.name));
    expect(idx).toEqual(expect.arrayContaining(['ux_users_no', 'ux_devices_no']));
    const flags = s.db.prepare("SELECT key, value FROM sync_state WHERE key IN ('people_resync', 'ids_push')").all();
    expect(flags.map((r) => `${r.key}=${r.value}`).sort()).toEqual(['ids_push=1', 'people_resync=1']);
    s.db.prepare("UPDATE users SET no = 1, no_src = 'b' WHERE id = ?").run(s.ahmad);
    expect(() => s.db.prepare("UPDATE users SET no = 1, no_src = 'b' WHERE id = ?").run(s.aminah)).toThrow();
    // a user deactivated before 022: dated from the newest change row that says so, else from the migration
    s.db.prepare('UPDATE users SET active = 0, deactivated_at = NULL WHERE id IN (?, ?)').run(s.ahmad, s.aminah);
    s.db.prepare("INSERT INTO change_log (surau_id, at, actor, entity, entity_id, after_json) VALUES ('sdm', '2026-01-05T00:00:00.000Z', 'system', 'users', ?, ?)").run(s.ahmad, JSON.stringify({ active: false }));
    migration.up(s.db);
    const at = (id: string) => String(s.db.prepare('SELECT deactivated_at AS d FROM users WHERE id = ?').get(id)!.d);
    expect(at(s.ahmad)).toBe('2026-01-05T00:00:00.000Z');
    expect(Math.abs(Date.parse(at(s.aminah)) - Date.now())).toBeLessThan(60_000);
  });
});

describe('[PP-S1] names kept with the history', () => {
  it('[PP-S1] logChange stores the name of the moment and a rename does not change the old row', () => {
    const s = fresh();
    logChange(s.db, `user:${s.ahmad}`, 'content:kuliah', 'k1', undefined, { a: 1 }, undefined, 'sdm');
    s.db.prepare('UPDATE users SET name = ? WHERE id = ?').run('Ustaz Ahmad bin Ali', s.ahmad);
    logChange(s.db, `user:${s.ahmad}`, 'content:kuliah', 'k2', undefined, { a: 2 }, undefined, 'sdm');
    const names = s.db.prepare("SELECT actor_name FROM change_log WHERE entity = 'content:kuliah' ORDER BY id").all().map((r) => r.actor_name);
    expect(names).toEqual(['Ustaz Ahmad', 'Ustaz Ahmad bin Ali']);
  });

  it('[PP-S1] a new finance entry stores names_json once; changing it aborts, one fill of a NULL is allowed', () => {
    const s = fresh();
    appendEntry(s.db, cash(s, 'e1'), `user:${s.ahmad}`, box);
    const names = () => String(s.db.prepare("SELECT names_json AS j FROM finance_entries WHERE id = 'e1'").get()!.j);
    expect(JSON.parse(names()).createdBy).toBe('Ustaz Ahmad');
    expect(() => s.db.exec("UPDATE finance_entries SET names_json = '{}'")).toThrow(/append-only/);
    expect(JSON.parse(names()).createdBy).toBe('Ustaz Ahmad');
    // the one allowed fill: a NULL becomes a value, then it is fixed
    unsnapshot(s.db);
    migration.up(s.db);
    expect(JSON.parse(names()).createdBy).toBe('Ustaz Ahmad');
    expect(() => s.db.exec("UPDATE finance_entries SET names_json = '{}'")).toThrow(/append-only/);
  });

  it('[PP-S1] a replicated entry keeps well formed names and replaces malformed or missing ones with names computed here', () => {
    const s = fresh();
    const base = { kind: 'in', entryDate: '2026-11-06', fundId: s.fundA, perihalId: s.perIn, amountSen: 1000, method: 'tunai', counters: [{ userId: s.ahmad }, { userId: s.aminah }] };
    const pull = (id: string, names: unknown) => insertReplicatedEntry(
      s.db, { ...base, ...(names === undefined ? {} : { names }) }, id, `user:${s.ahmad}`, box, { editedAt: '2026-11-06T01:00:00.000Z', origin: 'cloud' },
    );
    const sent = { createdBy: 'Ustaz Lama', device: 'Telefon Lama', counters: { [s.ahmad]: 'Ustaz Lama', [s.aminah]: 'Puan Lama' } };
    expect(pull('r1', sent).names).toMatchObject(sent);
    const local = { createdBy: 'Ustaz Ahmad', device: null, counters: { [s.ahmad]: 'Ustaz Ahmad', [s.aminah]: 'Puan Aminah' } };
    expect(pull('r2', undefined).names).toMatchObject(local);
    expect(pull('r3', { ...sent, createdBy: 'x'.repeat(81) }).names).toMatchObject(local);
    expect(pull('r4', { ...sent, counters: { stranger: 'Orang Lain' } }).names).toMatchObject(local);
    expect(pull('r5', 'text').names).toMatchObject(local);
    expect(pull('r6', { ...sent, device: 7 }).names).toMatchObject(local);
  });
});

describe('[PP-S1] the readers', () => {
  function makeApp(): FastifyInstance {
    const dir = mkdtempSync(join(tmpdir(), 'surau-names-'));
    dirs.push(dir);
    const noNetwork = (async () => { throw new TypeError('network disabled in tests'); }) as unknown as typeof fetch;
    const app = buildApp(join(dir, 'test.db'), { now: () => AT, fetchImpl: noNetwork });
    apps.push(app);
    return app;
  }

  it('[PP-S1] GET /api/audit and GET /api/finance/audit show the old name after a rename, the new name on a new row, and a NULL snapshot falls back to the live name', async () => {
    const app = makeApp();
    const { db } = app.surau;
    const admin = await loginAs(app, 'admin');
    const treasurer = await loginAs(app, 'treasurer');
    putFeature(db, 'finance', { enabled: true }, 'test', undefined, 'sdm');
    const funds = (await app.inject({ method: 'GET', url: '/api/finance/funds', headers: treasurer.headers })).json().funds as { id: string }[];
    const per = (await app.inject({ method: 'GET', url: '/api/finance/perihal', headers: treasurer.headers })).json().perihal as { id: string; direction: string }[];
    const body = (id: string) => ({ id, kind: 'in', entryDate: '2026-11-06', fundId: funds[0]!.id, perihalId: per.find((p) => p.direction === 'in')!.id, amountSen: 500, method: 'tunai', counters: [{ userId: treasurer.userId }, { name: 'Tuan Haji Ali' }] });
    const put = (id: string) => app.inject({ method: 'PUT', url: `/api/finance/entries/${id}`, headers: treasurer.headers, payload: body(id) });
    expect((await put('e1')).statusCode).toBe(200);
    const oldName = String(db.prepare('SELECT name FROM users WHERE id = ?').get(treasurer.userId)!.name);
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run('Encik Rahman bin Ali', treasurer.userId);
    expect((await put('e2')).statusCode).toBe(200);
    // an old row from before 022 has no snapshot: it shows the live name
    logChange(db, `user:${treasurer.userId}`, 'finance:month', '2026-10', undefined, { ym: '2026-10' }, undefined, 'sdm');
    db.prepare("UPDATE change_log SET actor_name = NULL WHERE entity = 'finance:month'").run();

    const finRes = (await app.inject({ method: 'GET', url: '/api/finance/audit', headers: treasurer.headers })).json() as { entries: { entityId: string | null; entity: string; userName: string | null }[] };
    expect(finRes.entries.find((e) => e.entityId === 'e1')!.userName).toBe(oldName);
    expect(finRes.entries.find((e) => e.entityId === 'e2')!.userName).toBe('Encik Rahman bin Ali');
    expect(finRes.entries.find((e) => e.entity === 'finance:month')!.userName).toBe('Encik Rahman bin Ali');
    const aud = (await app.inject({ method: 'GET', url: '/api/audit', headers: admin.headers })).json() as { entries: { entityId: string | null; entity: string; userName: string | null }[] };
    expect(aud.entries.find((e) => e.entityId === 'e1' && e.entity === 'finance:entry')!.userName).toBe(oldName);
    expect(aud.entries.find((e) => e.entityId === 'e2' && e.entity === 'finance:entry')!.userName).toBe('Encik Rahman bin Ali');
    const e1 = (await app.inject({ method: 'GET', url: '/api/finance/entries/e1', headers: treasurer.headers })).json();
    expect(JSON.stringify(e1)).toContain(oldName);
  });

  it('[PP-S1] a surau session still never sees a Pentadbir MAXCOM row in the audit log', async () => {
    const app = makeApp();
    const { db } = app.surau;
    const admin = await loginAs(app, 'admin');
    db.prepare("INSERT INTO users (surau_id, id, name, roles_json, active, created_at, created_by) VALUES ('*', 'star1', 'Pentadbir MAXCOM', ?, 1, '2026-01-01T00:00:00.000Z', 'cli')").run(JSON.stringify(['superadmin']));
    logChange(db, 'user:star1', 'users', 'star1', undefined, { name: 'Pentadbir MAXCOM' }, undefined, '*');
    expect(String(db.prepare("SELECT actor_name FROM change_log WHERE actor = 'user:star1'").get()!.actor_name)).toBe('Pentadbir MAXCOM');
    const aud = (await app.inject({ method: 'GET', url: '/api/audit', headers: admin.headers })).json() as { entries: { actor: string }[] };
    expect(aud.entries.some((e) => e.actor === 'user:star1')).toBe(false);
  });
});
