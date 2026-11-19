// [PP-COMPAT] Peranti and Pengguna against an older peer: a database from before the people relook (migration 021)
// upgrades with its data, the feed this release sends passes the rules an older box or cloud applies, a box against
// a cloud without `device-seen` still completes its round, and the answers an older app reads keep their shape.
//
// The "older peer" is the verifier of the previous release (commit adc9679, `sync/verify.ts`): a feed entry has a
// fixed set of keys and a device `after` carries only the eight keys it knew. That rule is written out below as
// `olderPeerRefuses`, so the test fails if this release starts sending something the previous one would refuse.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createUser } from '../src/auth/users.ts';
import { runCloudLink } from '../src/cli/cloudLink.ts';
import { openDb } from '../src/db.ts';
import { backfillIds } from '../src/auth/ids.ts';
import { MIGRATIONS, runMigrations } from '../src/migrations/index.ts';
import { readFeed } from '../src/sync/feed.ts';
import { issueLinkCode } from '../src/sync/sites.ts';
import { loadSyncKey } from '../src/sync/syncKey.ts';
import { loginAs } from './authHelpers.ts';
import { must } from './helpers/must.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';
import { ensureSurau } from './support/surauRow.ts';

const dbs: DatabaseSync[] = [];
const apps: FastifyInstance[] = [];
const clouds: TestCloud[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) d.close();
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const c of clouds.splice(0)) await c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

const count = (db: DatabaseSync, table: string): number => Number(must(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), 'count row').n);
const columns = (db: DatabaseSync, table: string): string[] => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name));

// ---------------------------------------------------------------------------------------------------------------
// The previous release's rules for an entry that reaches it (apps/box-server/src/sync/verify.ts at adc9679).

const OLD_ENTRY_KEYS = new Set(['seq', 'entity', 'entityId', 'rev', 'editedAt', 'syncedAt', 'actor', 'deviceId', 'origin', 'opId', 'after', 'stamps']);
const OLD_DEVICE_KEYS = new Set(['id', 'userId', 'name', 'platform', 'revoked', 'publicJwk', 'enrolledAt', 'boxId']);

/** Why the previous release would refuse this entry, or null when it takes it. */
function olderPeerRefuses(entry: object): string | null {
  const e = entry as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!OLD_ENTRY_KEYS.has(k)) return `entry key ${k}`;
  if (e.entity === 'device') {
    const after = e.after;
    if (typeof after !== 'object' || after === null || Array.isArray(after)) return 'device after is not an object';
    for (const k of Object.keys(after)) if (!OLD_DEVICE_KEYS.has(k)) return `device key ${k}`;
  }
  return null;
}

/** What the previous release does with a user entry: it reads name, roles and active and nothing else. */
const olderPeerReadsUser = (after: Record<string, unknown>): { name: unknown; roles: unknown; active: unknown } => ({ name: after.name, roles: after.roles, active: after.active });

// ---------------------------------------------------------------------------------------------------------------

describe('[PP-COMPAT] a database from before this release (migration 021)', () => {
  /** Put a finished database back to how a 021 box left it: no 022 column, index, counter table, flag or trigger clause. */
  function downgradeTo021(db: DatabaseSync): void {
    db.exec('DROP TRIGGER IF EXISTS trg_fin_entries_immutable');
    db.exec('DROP INDEX IF EXISTS ux_users_no; DROP INDEX IF EXISTS ux_devices_no; DROP TABLE IF EXISTS id_counters');
    db.exec("DELETE FROM sync_state WHERE key IN ('people_resync', 'ids_push')");
    for (const c of ['deleted_at', 'deleted_by', 'deactivated_at', 'phone', 'no_src', 'no']) db.exec(`ALTER TABLE users DROP COLUMN ${c}`);
    for (const c of ['no', 'no_src']) db.exec(`ALTER TABLE devices DROP COLUMN ${c}`);
    for (const c of ['cancelled_at', 'device_id']) db.exec(`ALTER TABLE enrolments DROP COLUMN ${c}`);
    db.exec('ALTER TABLE finance_entries DROP COLUMN names_json; ALTER TABLE change_log DROP COLUMN actor_name');
    db.exec("DELETE FROM schema_migrations WHERE name = '022-people-relook'");
  }

  it('[PP-COMPAT] keeps every user, device, history row and ledger row, adds the new columns, and numbers the people', async () => {
    const dir = tmp('surau-compat021-');
    const file = join(dir, 'box.db');
    const first = openDb(file);
    createUser(first, { name: 'Ustaz Ahmad', roles: ['treasurer'] }, 'test', 'sdm');
    const off = createUser(first, { name: 'Puan Aminah', roles: ['admin'] }, 'test', 'sdm').id;
    first.prepare('UPDATE users SET active = 0 WHERE id = ?').run(off);
    first.prepare("INSERT INTO change_log (surau_id, at, actor, entity, entity_id, after_json) VALUES ('sdm', '2026-01-05T00:00:00.000Z', 'system', 'users', ?, ?)").run(off, JSON.stringify({ active: false }));
    const users = first.prepare('SELECT id, name, roles_json, active FROM users ORDER BY id').all().map((r) => ({ ...r }));
    const history = count(first, 'change_log');
    downgradeTo021(first);
    expect(columns(first, 'users')).not.toContain('deleted_at');
    expect(first.prepare('SELECT 1 AS x FROM schema_migrations WHERE name = ?').get('022-people-relook')).toBeUndefined();
    first.close();

    // the box is started again on the old file: this is the upgrade
    const db = openDb(file);
    dbs.push(db);
    expect(db.prepare("SELECT 1 AS x FROM schema_migrations WHERE name = '022-people-relook'").get()).toBeDefined();
    expect(columns(db, 'users')).toEqual(expect.arrayContaining(['deleted_at', 'deactivated_at', 'phone', 'no', 'no_src']));
    expect(columns(db, 'devices')).toEqual(expect.arrayContaining(['no', 'no_src']));
    expect(columns(db, 'change_log')).toContain('actor_name');
    expect(columns(db, 'finance_entries')).toContain('names_json');
    expect(db.prepare('SELECT id, name, roles_json, active FROM users ORDER BY id').all().map((r) => ({ ...r }))).toEqual(users);
    expect(count(db, 'change_log')).toBeGreaterThanOrEqual(history);
    // the deactivated person is dated from the history row, and nobody is deleted by the upgrade
    expect(db.prepare('SELECT deactivated_at, deleted_at FROM users WHERE id = ?').get(off)).toMatchObject({ deactivated_at: '2026-01-05T00:00:00.000Z', deleted_at: null });
    // the people are numbered by the start-up backfill, once, and a second run changes nothing
    const filled = backfillIds(db, 'box');
    expect(filled.users).toBe(users.length);
    expect(backfillIds(db, 'box')).toEqual({ users: 0, devices: 0 });
    expect(runMigrations(db)).toEqual([]);
  });

  it('[PP-COMPAT] the migration list ends with 022 and no earlier migration changed its name', () => {
    // later releases append after 022 (023 the YouTube flag and handover, 024 the outbox camera mark, 025 poster stretch keep)
    const names = MIGRATIONS.map((m) => m.name);
    const at = names.indexOf('021-camera-secret');
    expect(names.slice(at, at + 2)).toEqual(['021-camera-secret', '022-people-relook']);
    expect(names.slice(at + 2).every((n) => n > '022-people-relook')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('[PP-COMPAT] what this release sends passes an older peer', () => {
  it('[PP-COMPAT] the cloud feed to a linked site (no IDs) is accepted by an older box: every entry, every device key', async () => {
    const cloud = buildCloud('ab'.repeat(8));
    clouds.push(cloud);
    const db = cloud.app.surau.db;
    ensureSurau(db, 'sdm');
    await loginAs(cloud.app, 'admin');
    await loginAs(cloud.app, 'ajk');
    await loginAs(cloud.app, 'media');
    backfillIds(db, 'cloud');
    expect(Number(must(db.prepare('SELECT COUNT(*) AS n FROM users WHERE no IS NOT NULL').get(), 'ids').n)).toBeGreaterThan(0);
    const scope = { surauId: 'sdm', users: true, devices: true, keys: true, star: true, finance: true, financeWrite: true, contentWrite: true, omitIds: true } as const;
    const feed = readFeed(db, 0, 500, scope);
    const devices = feed.entries.filter((e) => e.entity === 'device');
    const users = feed.entries.filter((e) => e.entity === 'user');
    expect(devices.length).toBeGreaterThan(0);
    expect(users.length).toBeGreaterThan(0);
    for (const e of feed.entries) expect(olderPeerRefuses(e), `${e.entity} ${e.entityId}`).toBeNull();
    for (const e of [...devices, ...users]) expect(JSON.stringify(e.after)).not.toMatch(/"no(Src)?"/);
  });

  it('[PP-COMPAT] the same feed with IDs on (a new box) is refused by an older peer for a device, so the cloud must hide them from a site', async () => {
    // the guard that makes the test above worth having: without `omitIds` an older box refuses a numbered device
    const cloud = buildCloud('ab'.repeat(8));
    clouds.push(cloud);
    const db = cloud.app.surau.db;
    await loginAs(cloud.app, 'ajk');
    backfillIds(db, 'cloud');
    const scope = { surauId: 'sdm', users: true, devices: true, keys: true, star: true } as const;
    const device = readFeed(db, 0, 500, scope).entries.find((e) => e.entity === 'device');
    expect(olderPeerRefuses(must(device, 'a device entry'))).toMatch(/^device key no/);
  });

  it('[PP-COMPAT] a deleted person reaches an older peer as a deactivation: name and roles kept, active false', async () => {
    const dir = tmp('surau-compat-del-');
    const app = buildApp(join(dir, 'box.db'), { dataDir: dir });
    apps.push(app);
    const ajk = await loginAs(app, 'ajk');
    const admin = await loginAs(app, 'admin');
    const r = must(app.surau.db.prepare('SELECT no, no_src FROM users WHERE id = ?').get(ajk.userId), 'the number of the person');
    const ref = `U-${r.no_src === 'c' ? 'C' : ''}${String(r.no).padStart(4, '0')}`;
    const res = await app.inject({ method: 'POST', url: `/api/users/${ajk.userId}/delete`, headers: admin.headers, payload: { ref } });
    expect(res.statusCode, res.body).toBe(200);
    const feed = readFeed(app.surau.db, 0, 500, { surauId: 'sdm', users: true, devices: true, keys: true });
    const last = feed.entries.filter((e) => e.entity === 'user' && e.entityId === ajk.userId).pop();
    expect(olderPeerRefuses(must(last, 'the delete entry'))).toBeNull();
    const seen = olderPeerReadsUser(must(last?.after as Record<string, unknown> | null | undefined, 'user entry after'));
    expect(typeof seen.name).toBe('string');
    expect(seen.roles).toEqual(['ajk']);
    expect(seen.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('[PP-COMPAT] an older app against this box', () => {
  const OLD_USER = { id: 'string', name: 'string', roles: 'array', active: 'boolean', pinRequired: 'boolean', createdAt: 'string', createdBy: 'string' } as const;
  const OLD_DEVICE = { id: 'string', userId: 'string', name: 'string', platform: 'string', enrolledAt: 'string' } as const;
  const kindOf = (v: unknown): string => (Array.isArray(v) ? 'array' : typeof v);

  it('[PP-COMPAT] the lists keep every field the older app reads, with the same kinds; new fields are only added', async () => {
    const dir = tmp('surau-compat-old-app-');
    const app = buildApp(join(dir, 'box.db'), { dataDir: dir });
    apps.push(app);
    const admin = await loginAs(app, 'admin');
    const users = (await app.inject({ method: 'GET', url: '/api/users', headers: admin.headers })).json().users as Array<Record<string, unknown>>;
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) for (const [k, kind] of Object.entries(OLD_USER)) expect(kindOf(u[k]), `user.${k}`).toBe(kind);
    const devices = (await app.inject({ method: 'GET', url: '/api/devices', headers: admin.headers })).json().devices as Array<Record<string, unknown>>;
    expect(devices.length).toBeGreaterThan(0);
    for (const d of devices) {
      for (const [k, kind] of Object.entries(OLD_DEVICE)) expect(kindOf(d[k]), `device.${k}`).toBe(kind);
      expect('lastSeenAt' in d && 'revokedAt' in d).toBe(true);
    }
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: admin.headers })).json() as Record<string, unknown>;
    for (const k of ['user', 'device', 'roles', 'ops', 'surau', 'suspended', 'scope', 'expiresAt', 'appLock']) expect(me, `me.${k}`).toHaveProperty(k);
  });

  it('[PP-COMPAT] requests of the older app, without any new field, still work: create, roles, enrol code, deactivate, revoke', async () => {
    const dir = tmp('surau-compat-old-app2-');
    const app = buildApp(join(dir, 'box.db'), { dataDir: dir });
    apps.push(app);
    const admin = await loginAs(app, 'admin');
    // The one deliberate refusal: a person is added with a phone number now (decision of this release). An older app
    // sends none and gets a coded, readable 400, not a crash; its other requests below are unchanged.
    const bare = await app.inject({ method: 'POST', url: '/api/users', headers: admin.headers, payload: { name: 'Kak Aminah Contoh', roles: ['ajk'] } });
    expect(bare.statusCode, bare.body).toBe(400);
    expect(bare.json()).toMatchObject({ code: 'phone_required' });
    expect(Array.isArray(bare.json().errors)).toBe(true);
    const make = await app.inject({ method: 'POST', url: '/api/users', headers: admin.headers, payload: { name: 'Kak Aminah Contoh', roles: ['ajk'], phone: '+60 12-000 0011' } });
    expect(make.statusCode, make.body).toBe(201);
    const id = String(make.json().id);
    const roles = await app.inject({ method: 'PUT', url: `/api/users/${id}/roles`, headers: admin.headers, payload: { roles: ['ajk', 'media'] } });
    expect(roles.statusCode, roles.body).toBe(200);
    const code = await app.inject({ method: 'POST', url: '/api/enrol/begin', headers: admin.headers, payload: { userId: id } });
    expect(code.statusCode, code.body).toBe(200);
    expect(typeof code.json().code).toBe('string');
    const off = await app.inject({ method: 'POST', url: `/api/users/${id}/deactivate`, headers: admin.headers, payload: {} });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toEqual({ ok: true });
    const phone = await loginAs(app, 'ajk');
    const revoke = await app.inject({ method: 'POST', url: `/api/devices/${phone.deviceId}/revoke`, headers: admin.headers, payload: {} });
    expect(revoke.statusCode, revoke.body).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('[PP-COMPAT] a box against a cloud without device-seen', () => {
  async function pair(mode: { fetch: 'ok' | '404' | '405' | 'down' }): Promise<{ box: FastifyInstance; cloud: TestCloud; seenCalls: number }> {
    const dir = tmp('surau-compat-seen-');
    const state = { seenCalls: 0 };
    let worker!: FakeWorker;
    const box = buildApp(join(dir, 'box.db'), {
      dataDir: dir,
      sync: {
        fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => {
          if (String(i).endsWith('/api/sync/device-seen')) {
            state.seenCalls += 1;
            if (mode.fetch === 'down') return Promise.reject(new TypeError('network down'));
            if (mode.fetch !== 'ok') return Promise.resolve(new Response('{}', { status: Number(mode.fetch) }));
          }
          return worker.fetch(i, n);
        }) as typeof fetch,
        sleep: async () => undefined,
      },
    });
    apps.push(box);
    const cloud = buildCloud(box.surau.boxId);
    clouds.push(cloud);
    worker = new FakeWorker(cloud.fetch);
    const { code } = issueLinkCode({ db: cloud.app.surau.db, now: () => new Date() }, { boxId: box.surau.boxId, name: 'Surau Contoh Perintis', target: { surauId: ensureSurau(cloud.app.surau.db) } });
    const lines: string[] = [];
    expect(await runCloudLink(['--data', dir, '--db', join(dir, 'box.db'), 'link', CLOUD_URL, code], { out: (l) => lines.push(l), err: (l) => lines.push(l) }, worker.fetch), lines.join('\n')).toBe(0);
    worker.setSecret(box.surau.boxId, must(loadSyncKey(dir), 'sync key').wakeSecret);
    return { box, cloud, get seenCalls() { return state.seenCalls; } };
  }

  for (const failure of ['404', '405', 'down'] as const) {
    it(`[PP-COMPAT] device-seen answering ${failure} leaves the round complete: no error, and the box's own edits still reach the cloud`, async () => {
      const p = await pair({ fetch: failure });
      const agent = must(p.box.syncAgent, 'sync agent');
      createUser(p.box.surau.db, { name: 'Kak Siti Contoh', roles: ['ajk'] }, 'test', 'sdm');
      await agent.runOnce();
      expect(p.seenCalls).toBeGreaterThan(0);
      expect(agent.status()).toMatchObject({ lastError: null, state: 'idle' });
      const onCloud = p.cloud.app.surau.db.prepare("SELECT name FROM users WHERE name = 'Kak Siti Contoh'").get();
      expect(onCloud, 'the new person reached the cloud in the same round').toBeDefined();
    });
  }
});
