import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { sha256hex } from '../src/auth/crypto.ts';
import { takeMasterBackup } from '../src/link/backupCopy.ts';
import { readJournal } from '../src/link/journal.ts';
import { adminDevices, isKeptList } from '../src/link/keepAdmins.ts';
import { applyLinkJournalAtBoot, backupDirOf, planRestore } from '../src/link/setAside.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';

/**
 * A restore keeps the Pentadbir phones: a device row of the restored store stays only if the same device id with the
 * same key was an unrevoked phone of an active Pentadbir in the store in use before the swap and is still one in the
 * restored store. Every session is revoked all the same.
 */

const LINK = 'd3'.repeat(16);
const T0 = new Date('2026-11-24T02:00:00.000Z');

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function boot(dir: string): Promise<FastifyInstance> {
  const app = buildApp(join(dir, 'surau.db'), { dataDir: dir, link: { restart: vi.fn(), origin: 'https://10.168.50.11:8443', caSha256: '1'.repeat(64) } });
  apps.push(app);
  await app.ready();
  return app;
}

interface Site {
  dir: string;
  app: FastifyInstance;
  admin: Login;
  member: Login;
}

/** A box with one Pentadbir phone and one ordinary member phone, both signed in, backed up as of "link day". */
async function site(): Promise<Site> {
  const dir = mkdtempSync(join(tmpdir(), 'maxcom-keep-admins-'));
  dirs.push(dir);
  const app = await boot(dir);
  const admin = await loginAs(app, 'admin');
  const member = await loginAs(app, 'ajk');
  expect((await takeMasterBackup({ db: app.surau.db, dataDir: dir, linkId: LINK, now: T0, free: () => null })).taken).toBe(true);
  return { dir, app, admin, member };
}

type Db = FastifyInstance['surau']['db'];

/** Edit the stored copy of link day (the store that comes back), before the restore is planned. */
function editBackup(s: Site, fn: (db: DatabaseSync) => void): void {
  const raw = new DatabaseSync(join(backupDirOf(s.dir, LINK), 'surau.db'));
  try {
    fn(raw);
  } finally {
    raw.close();
  }
}

/** Change the live store, plan the restore, close, carry it out at the "next start", open the store again. */
async function restoreAfter(s: Site, change: (db: Db) => void = () => undefined): Promise<FastifyInstance> {
  change(s.app.surau.db);
  planRestore(s.dir, LINK, T0);
  await s.app.close();
  expect(applyLinkJournalAtBoot(s.dir)).toBe('restore');
  return boot(s.dir);
}

const revokedAt = (app: FastifyInstance, id: string): unknown => app.surau.db.prepare('SELECT revoked_at AS r FROM devices WHERE id = ?').get(id)?.r;
const liveSessions = (app: FastifyInstance): number => Number(app.surau.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL').get()?.n);

describe('a restore keeps the Pentadbir phones', () => {
  it('the Pentadbir phone survives, the member phone is revoked, every session is revoked', async () => {
    const s = await site();
    expect(liveSessions(s.app)).toBeGreaterThan(0);
    const again = await restoreAfter(s);
    expect(revokedAt(again, s.admin.deviceId)).toBeNull();
    expect(revokedAt(again, s.member.deviceId)).not.toBeNull();
    expect(liveSessions(again)).toBe(0);
    const log = again.surau.db.prepare("SELECT after_json AS a FROM change_log WHERE entity = 'link' ORDER BY id DESC LIMIT 1").get();
    expect(JSON.parse(String(log?.a))).toMatchObject({ event: 'restored', devicesKept: 1 });
  });

  it('the kept phone is still a Pentadbir device of the restored store, with its key', async () => {
    const s = await site();
    const again = await restoreAfter(s);
    expect(adminDevices(again.surau.db).map((d) => d.id)).toEqual([s.admin.deviceId]);
  });

  it('a member promoted to Pentadbir only after link day: the restored store has them as a member, so the phone is revoked', async () => {
    const s = await site();
    const again = await restoreAfter(s, (db) => {
      db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(['admin']), s.member.userId);
    });
    expect(revokedAt(again, s.member.deviceId)).not.toBeNull();
    expect(revokedAt(again, s.admin.deviceId)).toBeNull();
  });

  it('a Pentadbir of the live store who is a plain member in the restored store is revoked', async () => {
    const s = await site();
    editBackup(s, (db) => db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(['ajk']), s.admin.userId));
    const again = await restoreAfter(s);
    expect(revokedAt(again, s.admin.deviceId)).not.toBeNull();
  });

  it('a Pentadbir who is not active in the restored store loses the phone', async () => {
    const s = await site();
    editBackup(s, (db) => db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(s.admin.userId));
    const again = await restoreAfter(s);
    expect(revokedAt(again, s.admin.deviceId)).not.toBeNull();
  });

  it('a phone revoked before the swap stays revoked, though the backup holds it unrevoked', async () => {
    const s = await site();
    const again = await restoreAfter(s, (db) => {
      db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(T0.toISOString(), s.admin.deviceId);
    });
    expect(revokedAt(again, s.admin.deviceId)).not.toBeNull();
  });

  it('a device whose key differs between the live and the restored store is revoked', async () => {
    const s = await site();
    editBackup(s, (db) => db.prepare('UPDATE devices SET public_jwk = ? WHERE id = ?').run(JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'BBBB' }), s.admin.deviceId));
    const again = await restoreAfter(s);
    expect(revokedAt(again, s.admin.deviceId)).not.toBeNull();
  });

  it('a device the live store does not know is revoked', async () => {
    const s = await site();
    const again = await restoreAfter(s, (db) => {
      db.prepare('DELETE FROM sessions WHERE device_id = ?').run(s.admin.deviceId);
      db.prepare('DELETE FROM devices WHERE id = ?').run(s.admin.deviceId);
    });
    expect(revokedAt(again, s.admin.deviceId)).not.toBeNull();
  });

  it('a follower store follows the same rule: the phone with the same id and key stays, a member phone does not', async () => {
    const s = await site();
    const again = await restoreAfter(s, () => {
      mkdirSync(join(s.dir, 'secret'), { recursive: true });
      writeFileSync(join(s.dir, 'secret', 'follow.json'), '{}');
    });
    expect(revokedAt(again, s.admin.deviceId)).toBeNull();
    expect(revokedAt(again, s.member.deviceId)).not.toBeNull();
  });

  it('a kiosk row is never listed as a Pentadbir phone, and a mark naming one does not keep it', async () => {
    const s = await site();
    const kiosk = 'kioskdevice1';
    s.app.surau.db.prepare("INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at) VALUES (?, ?, 'TV', 'kiosk', ?, ?)").run(kiosk, s.admin.userId, '{"a":1}', T0.toISOString());
    expect(adminDevices(s.app.surau.db).map((d) => d.id)).not.toContain(kiosk);
    await s.app.close();
    writeFileSync(join(s.dir, 'link-restored.json'), JSON.stringify({ v: 1, linkId: LINK, at: T0.toISOString(), keepDevices: [{ id: kiosk, key: sha256hex('{"a":1}') }] }));
    const again = await boot(s.dir);
    expect(adminDevices(again.surau.db).map((d) => d.id)).not.toContain(kiosk);
  });

  it('the plan carries the list, and the list is read again at the swap', async () => {
    const s = await site();
    planRestore(s.dir, LINK, T0);
    const planned = readJournal(s.dir)?.keepDevices ?? [];
    expect(planned.map((d) => d.id)).toEqual([s.admin.deviceId]);
    expect(planned[0]?.key).toBe(sha256hex(String(s.app.surau.db.prepare('SELECT public_jwk AS k FROM devices WHERE id = ?').get(s.admin.deviceId)?.k)));
    // the Pentadbir phone is revoked after the plan, before the swap
    s.app.surau.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(T0.toISOString(), s.admin.deviceId);
    await s.app.close();
    expect(applyLinkJournalAtBoot(s.dir)).toBe('restore');
    const again = await boot(s.dir);
    expect(revokedAt(again, s.admin.deviceId)).not.toBeNull();
  });

  it('a malformed list is refused: the shape check, and a mark with a bad list keeps nothing', async () => {
    expect(isKeptList([{ id: '../x', key: 'a'.repeat(64) }])).toBe(false);
    expect(isKeptList([{ id: 'ok', key: 'short' }])).toBe(false);
    expect(isKeptList('x')).toBe(false);
    expect(isKeptList([])).toBe(true);
    const s = await site();
    await s.app.close();
    writeFileSync(join(s.dir, 'link-restored.json'), JSON.stringify({ v: 1, linkId: LINK, at: T0.toISOString(), keepDevices: [{ id: s.admin.deviceId, key: 'zz' }] }));
    const again = await boot(s.dir);
    expect(revokedAt(again, s.admin.deviceId)).not.toBeNull();
  });
});
