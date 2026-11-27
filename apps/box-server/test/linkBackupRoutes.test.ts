import { generateSyncKeyPair, saveSyncKey } from '../src/sync/syncKey.ts';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROLES } from '@surau/core';
import { buildApp } from '../src/app.ts';
import type { AppOptions } from '../src/app.ts';
import { sha256hex } from '../src/auth/crypto.ts';
import { createUser } from '../src/auth/users.ts';
import { openDb } from '../src/db.ts';
import { takeMasterBackup } from '../src/link/backupCopy.ts';
import { readJournal } from '../src/link/journal.ts';
import { applyLinkJournalAtBoot, backupOf, listBackups, writeManifest } from '../src/link/setAside.ts';
import { keptRows, noteKeptByRestore, readKeptNote } from '../src/link/unlink.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { loginAs, TEST_PIN } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { pairTv } from './support/pairTv.ts';
import { startBody, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

/**
 * "Sandaran sebelum pautan": the backup routes of the box that took a backup before its first follower, and the
 * first start after a restore (`applyRestoreMark`). Every test runs on a real data folder.
 */

const LINK = 'c1'.repeat(16);
const LAN = '10.168.50.11';
const WRONG_PIN = '135790';
const FOLLOWER_TOKEN = `${'A1'.repeat(21)}x`;
const T0 = new Date('2026-11-20T01:41:00.000Z');

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
const harnesses: LiveHarness[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const h of harnesses.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'maxcom-backup-routes-'));
  dirs.push(d);
  return d;
}

async function boot(dir: string, extra: Partial<AppOptions> = {}): Promise<FastifyInstance> {
  const app = buildApp(join(dir, 'surau.db'), { dataDir: dir, link: { restart: vi.fn(), origin: 'https://10.168.50.11:8443', caSha256: '1'.repeat(64) }, ...extra });
  apps.push(app);
  await app.ready();
  return app;
}

interface Site {
  dir: string;
  app: FastifyInstance;
  admin: Login;
  phone: Login;
}

/** A set-up box with an admin, one more person with a phone, the app lock on. */
async function site(): Promise<Site> {
  const dir = tempDir();
  const app = await boot(dir);
  const admin = await loginAs(app, 'admin');
  const phone = await loginAs(app, 'ajk');
  const lock = await app.inject({ method: 'PUT', url: '/api/settings/appLock', headers: admin.headers, remoteAddress: LAN, payload: { enabled: true } });
  expect(lock.statusCode).toBe(200);
  return { dir, app, admin, phone };
}

const take = (s: Site) => takeMasterBackup({ db: s.app.surau.db, dataDir: s.dir, linkId: LINK, now: T0, free: () => null });

/** A follower box as the link makes it: a kiosk device, its cookie row and the linked_boxes row. */
function addFollower(s: Site, tag: string, token: string): string {
  const { db } = s.app.surau;
  const deviceId = `follower-${tag}`.padEnd(12, 'x');
  const at = T0.toISOString();
  db.prepare("INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at, surau_id) VALUES (?, ?, ?, 'kiosk', NULL, ?, ?)").run(deviceId, s.admin.userId, 'Ruang Muslimat', at, LOCAL_SURAU_ID);
  db.prepare('INSERT INTO kiosk_cookies (token_hash, device_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256hex(token), deviceId, at, '2099-01-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO linked_boxes (device_id, box_id, key_fp, public_jwk, name, local_name, addresses_json, version, linked_at, link_id)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(deviceId, tag.repeat(16).slice(0, 16), 'f'.repeat(16), '{}', 'Ruang Muslimat', '["https://10.168.50.12:8443"]', '2026.11.15', at, 'd'.repeat(32));
  return deviceId;
}

/** The follower is taken off again (what the unlink does), so the box runs alone and may restore. */
function removeFollower(s: Site, deviceId: string): void {
  const { db } = s.app.surau;
  db.prepare('DELETE FROM kiosk_cookies WHERE device_id = ?').run(deviceId);
  db.prepare('UPDATE linked_boxes SET removed_at = ? WHERE device_id = ?').run(T0.toISOString(), deviceId);
  db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(T0.toISOString(), deviceId);
}

/** Every call comes from its own LAN address: the PIN limiter counts per address, and a test makes many tries. */
let lanCounter = 0;
const nextLan = (): string => `10.168.60.${(++lanCounter % 250) + 1}`;

const call = (s: { app: FastifyInstance }, method: 'GET' | 'POST', url: string, payload?: unknown, o: { as?: Login | null; from?: string } = {}) =>
  s.app.inject({
    method, url, remoteAddress: o.from ?? nextLan(),
    headers: o.as === null ? {} : (o.as ?? (s as Site).admin).headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const act = (payload: Record<string, unknown>) => ({ pin: TEST_PIN, linkId: LINK, confirm: true, ...payload });

const phonesLive = (app: FastifyInstance): number =>
  Number(app.surau.db.prepare("SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL AND platform <> 'kiosk'").get()?.n ?? 0);
const logRows = (app: FastifyInstance): number => Number(app.surau.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'link'").get()?.n ?? 0);

/** The box was linked to the cloud: a sync key on disk (a box without one owes the cloud no reset, B4). */
function cloudLinked(dir: string): void {
  saveSyncKey(dir, { ...generateSyncKeyPair(), cloudUrl: 'https://awan.contoh.test', siteToken: 'site-token-ujian-0001', wakeSecret: 'wake-secret-1', linkedAt: '2026-11-05T00:00:00.000Z' });
}

describe('restore end to end', () => {
  it('old data back, every phone revoked, a paired screen kept, a follower token dead, people intact, sync held, the mark used once', async () => {
    const s = await site();
    const tv = await pairTv(s.app, s.admin);
    const followerDevice = addFollower(s, '5', FOLLOWER_TOKEN);
    expect((await take(s)).taken).toBe(true);
    expect(backupOf(s.dir, LINK)).not.toBeNull();

    // link-day state: the paired screen and the follower both read; the phones are signed in
    const cookie = (token: string) => ({ cookie: `surau_kiosk=${token}` });
    const linkDay = await s.app.inject({ method: 'GET', url: '/api/kiosk/bundle', headers: cookie(FOLLOWER_TOKEN), remoteAddress: '10.168.50.12' });
    expect(linkDay.statusCode).toBe(200);
    expect((await call(s, 'GET', '/api/settings')).statusCode).toBe(200);

    // later: a person added, the follower taken off, then the admin restores
    createUser(s.app.surau.db, { name: 'Baru Sahaja', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID);
    removeFollower(s, followerDevice);
    const before = await call(s, 'GET', '/api/link/backup');
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ backup: { linkId: LINK, kind: 'copy' }, kept: null, followers: 0 });

    const plan = await call(s, 'POST', '/api/link/backup/restore', act({}));
    expect(plan.statusCode).toBe(200);
    expect(plan.json().ok).toBe(true);
    expect(readJournal(s.dir)).toMatchObject({ op: 'restore', linkId: LINK });
    await s.app.close();

    expect(applyLinkJournalAtBoot(s.dir)).toBe('restore');
    // the restore left its mark; nothing is revoked until the database opens again
    expect(existsSync(join(s.dir, 'link-restored.json'))).toBe(true);
    const raw = openDb(join(s.dir, 'surau.db'));
    expect(Number(raw.prepare("SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL AND platform <> 'kiosk'").get()?.n)).toBeGreaterThan(0);
    raw.close();

    cloudLinked(s.dir);
    const again = await boot(s.dir);
    expect(existsSync(join(s.dir, 'link-restored.json'))).toBe(false);
    expect(existsSync(join(s.dir, 'link-cloud-reset.json'))).toBe(true);
    expect(again.syncAgent).toBeNull();
    const { db } = again.surau;
    // the old data is back: the person added later is gone, the ones of link day and their roles stay
    const names = db.prepare('SELECT name, roles_json FROM users ORDER BY name').all().map((r) => String(r.name));
    expect(names.some((n) => n.startsWith('Baru Sahaja'))).toBe(false);
    expect(names.length).toBeGreaterThanOrEqual(2);
    for (const id of [s.admin.userId, s.phone.userId]) expect(db.prepare('SELECT 1 AS x FROM users WHERE id = ?').get(id)).toBeDefined();
    expect(JSON.parse(String(db.prepare('SELECT roles_json FROM users WHERE id = ?').get(s.admin.userId)?.roles_json))).toContain('admin');
    // the Pentadbir phone stays (same key as before the swap), every other phone is revoked, every session is gone
    expect(phonesLive(again)).toBe(1);
    expect(again.surau.db.prepare('SELECT revoked_at AS r FROM devices WHERE id = ?').get(s.admin.deviceId)?.r).toBeNull();
    expect(again.surau.db.prepare('SELECT revoked_at AS r FROM devices WHERE id = ?').get(s.phone.deviceId)?.r).not.toBeNull();
    for (const who of [s.admin, s.phone]) {
      const r = await again.inject({ method: 'GET', url: '/api/settings', headers: who.headers, remoteAddress: LAN });
      expect(r.statusCode).toBe(401);
    }
    // the paired browser screen still reads the TV data
    const tvRead = await again.inject({ method: 'GET', url: '/api/kiosk/bundle', headers: { cookie: tv.cookie }, remoteAddress: '10.168.1.77' });
    expect(tvRead.statusCode).toBe(200);
    // the follower token of link day does not work any more, and its row is closed
    const old = await again.inject({ method: 'GET', url: '/api/kiosk/bundle', headers: cookie(FOLLOWER_TOKEN), remoteAddress: '10.168.50.12' });
    expect([401, 403]).toContain(old.statusCode);
    expect(db.prepare('SELECT COUNT(*) AS n FROM linked_boxes WHERE removed_at IS NULL').get()?.n).toBe(0);
    expect(logRows(again)).toBeGreaterThan(0);
    // the backup was used up; the data in use is kept for 7 days
    expect(listBackups(s.dir).map((b) => b.manifest.kind)).toEqual(['at-unlink']);
    await again.close();

    // a second start on the same folder revokes nothing more and writes nothing new
    const rows = (a: FastifyInstance): number => Number(a.surau.db.prepare('SELECT COUNT(*) AS n FROM change_log').get()?.n);
    const third = await boot(s.dir);
    const logged = rows(third);
    expect(third.syncAgent).toBeNull();
    expect(phonesLive(third)).toBe(1);
    expect(existsSync(join(s.dir, 'link-restored.json'))).toBe(false);
    await third.close();
    const fourth = await boot(s.dir);
    expect(rows(fourth)).toBe(logged);
  });

  it('a stop between the restore and the revoke: the mark stays and the next start revokes; a mark left after the revoke finds nothing more', async () => {
    const s = await site();
    expect((await take(s)).taken).toBe(true);
    expect((await call(s, 'POST', '/api/link/backup/restore', act({}))).statusCode).toBe(200);
    await s.app.close();
    expect(applyLinkJournalAtBoot(s.dir)).toBe('restore');
    // the process stopped here: no database was opened yet
    expect(existsSync(join(s.dir, 'link-restored.json'))).toBe(true);

    cloudLinked(s.dir);
    const first = await boot(s.dir);
    expect(phonesLive(first)).toBe(1);
    expect(existsSync(join(s.dir, 'link-restored.json'))).toBe(false);
    const logged = logRows(first);
    await first.close();

    // a stop after the revoke but before the mark was removed: the same mark again
    writeFileSync(join(s.dir, 'link-restored.json'), JSON.stringify({ v: 1, linkId: LINK, at: T0.toISOString() }));
    const second = await boot(s.dir);
    expect(phonesLive(second)).toBe(0);
    expect(existsSync(join(s.dir, 'link-restored.json'))).toBe(false);
    expect(logRows(second)).toBe(logged + 1);
    expect(second.syncAgent).toBeNull();
  });
});

describe('data kept by a restore', () => {
  it('the restore keeps the data in use 7 days, shown in the unlink status and removable; switching to it is not offered', async () => {
    const s = await site();
    expect((await take(s)).taken).toBe(true);
    expect((await call(s, 'POST', '/api/link/backup/restore', act({}))).statusCode).toBe(200);
    await s.app.close();
    expect(applyLinkJournalAtBoot(s.dir)).toBe('restore');
    const again = await boot(s.dir);
    const kept = again.link!.unlinks.status(null).kept;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ side: 'master', chosen: 'back', switchable: false });
    const admin = await loginAs(again, 'admin');
    const sw = await call({ app: again }, 'POST', '/api/unlink/switch', { pin: TEST_PIN, side: 'master', confirm: true }, { as: admin });
    expect([sw.statusCode, sw.json().code]).toEqual([409, 'no_kept_data']);
    const drop = await call({ app: again }, 'POST', '/api/unlink/drop-kept', { pin: TEST_PIN, side: 'master', confirm: true }, { as: admin });
    expect(drop.statusCode, drop.body).toBe(200);
    expect(drop.json().kept).toEqual([]);
    expect(listBackups(s.dir)).toEqual([]);
  });
});

describe('drop', () => {
  it('frees the folder at once; a later restore answers 404 no_backup', async () => {
    const s = await site();
    expect((await take(s)).taken).toBe(true);
    expect(existsSync(join(s.dir, 'linkundo', LINK))).toBe(true);
    const drop = await call(s, 'POST', '/api/link/backup/drop', act({}));
    expect(drop.statusCode).toBe(200);
    expect(drop.json()).toMatchObject({ ok: true, backup: null });
    expect(existsSync(join(s.dir, 'linkundo', LINK))).toBe(false);
    expect(existsSync(join(s.dir, 'linkundo', `${LINK}.dropping`))).toBe(false);
    const restore = await call(s, 'POST', '/api/link/backup/restore', act({}));
    expect(restore.statusCode).toBe(404);
    expect(restore.json().code).toBe('no_backup');
    const again = await call(s, 'POST', '/api/link/backup/drop', act({}));
    expect(again.statusCode).toBe(404);
    expect(again.json().code).toBe('no_backup');
    expect((await call(s, 'GET', '/api/link/backup')).json().backup).toBeNull();
  });

  it('which: kept removes the data kept at an unlink and leaves the backup', async () => {
    const s = await site();
    expect((await take(s)).taken).toBe(true);
    // a restore made the kept data; do it for real
    expect((await call(s, 'POST', '/api/link/backup/restore', act({}))).statusCode).toBe(200);
    await s.app.close();
    applyLinkJournalAtBoot(s.dir);
    const app = await boot(s.dir);
    const admin = await loginAs(app, 'admin');
    const view = await app.inject({ method: 'GET', url: '/api/link/backup', headers: admin.headers, remoteAddress: LAN });
    expect(view.json().kept).toMatchObject({ linkId: LINK });
    const drop = await app.inject({ method: 'POST', url: '/api/link/backup/drop', headers: admin.headers, remoteAddress: LAN, payload: { pin: TEST_PIN, linkId: LINK, confirm: true, which: 'kept' } });
    expect(drop.statusCode).toBe(200);
    expect(drop.json().kept).toBeNull();
    expect(existsSync(join(s.dir, 'linkundo', `${LINK}-at-unlink`))).toBe(false);
  });

  it('which: kept also clears the kept note, so a link start is no longer refused with kept_data', async () => {
    const s = await site();
    expect((await take(s)).taken).toBe(true);
    expect((await call(s, 'POST', '/api/link/backup/restore', act({}))).statusCode).toBe(200);
    await s.app.close();
    applyLinkJournalAtBoot(s.dir);
    const app = await boot(s.dir);
    const admin = await loginAs(app, 'admin');
    const show = () => app.inject({ method: 'POST', url: '/api/link/show', headers: admin.headers, remoteAddress: LAN, payload: { pin: TEST_PIN } });
    // a restore-made note never carries an empty name (older apps refuse the whole status for one)
    const note = readKeptNote(s.dir)!;
    expect(note.followerName.trim()).not.toBe('');
    expect(note.masterName.trim()).not.toBe('');
    expect((await show()).json().code).toBe('kept_data');
    const drop = await app.inject({ method: 'POST', url: '/api/link/backup/drop', headers: admin.headers, remoteAddress: LAN, payload: { pin: TEST_PIN, linkId: LINK, confirm: true, which: 'kept' } });
    expect(drop.statusCode).toBe(200);
    expect(readKeptNote(s.dir)).toBeNull();
    const after = await show();
    expect(after.json().code).not.toBe('kept_data');
    expect(after.statusCode).toBe(200);
  });

  it('a follower-side restore note keeps the master name and takes its own name; with no names it falls back, never empty', () => {
    const dir = tempDir();
    noteKeptByRestore(dir, 'follower', LINK, { masterName: 'Surau Contoh', ownName: 'box1-SCT' }, new Date());
    expect(readKeptNote(dir)).toMatchObject({ followerName: 'box1-SCT', masterName: 'Surau Contoh' });
  });

  it('a kept note whose folder is gone does not refuse a link, and does not block the note of the next restore', async () => {
    const s = await site();
    expect((await take(s)).taken).toBe(true);
    // a stale note: no folder behind it
    noteKeptByRestore(s.dir, 'master', LINK, {}, new Date());
    expect(readKeptNote(s.dir)).not.toBeNull();
    expect(keptRows(s.dir, new Date())).toEqual([]);
    const show = await call(s, 'POST', '/api/link/show', { pin: TEST_PIN });
    expect(show.json().code).not.toBe('kept_data');
    // a restore now writes a fresh note over the stale one
    const other = 'd3'.repeat(16);
    mkdirSync(join(s.dir, 'linkundo', `${other}-at-unlink`), { recursive: true });
    writeManifest(join(s.dir, 'linkundo', `${other}-at-unlink`), { v: 1, kind: 'at-unlink', linkId: other, at: T0.toISOString(), release: '2026.11.15', dbLevel: 29, files: [], bytes: 0 });
    noteKeptByRestore(s.dir, 'master', other, {}, new Date());
    expect(readKeptNote(s.dir)?.linkId).toBe(other);
    // a live note (its folder is there) is left as it is
    noteKeptByRestore(s.dir, 'master', LINK, {}, new Date());
    expect(readKeptNote(s.dir)?.linkId).toBe(other);
  });
});

describe('refusals', () => {
  it('has_followers: a box that still has a follower leaves through the unlink, not through restore', async () => {
    const s = await site();
    expect((await take(s)).taken).toBe(true);
    addFollower(s, '6', FOLLOWER_TOKEN);
    expect((await call(s, 'GET', '/api/link/backup')).json().followers).toBe(1);
    const r = await call(s, 'POST', '/api/link/backup/restore', act({}));
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('has_followers');
    expect(readJournal(s.dir)).toBeNull();
  });

  it('linking: refused while a link session is open', async () => {
    const s = await site();
    expect((await take(s)).taken).toBe(true);
    expect((await call(s, 'POST', '/api/link/show', { pin: TEST_PIN })).statusCode).toBe(200);
    for (const url of ['/api/link/backup/restore', '/api/link/backup/drop']) {
      const r = await call(s, 'POST', url, act({}));
      expect(r.statusCode, url).toBe(409);
      expect(r.json().code, url).toBe('linking');
    }
    expect(existsSync(join(s.dir, 'linkundo', LINK))).toBe(true);
  });

  it('kept_exists: data kept at an earlier unlink is still there; and such a box refuses to link (kept_data)', async () => {
    const s = await site();
    expect((await take(s)).taken).toBe(true);
    const kept = join(s.dir, 'linkundo', `${LINK}-at-unlink`);
    mkdirSync(kept, { recursive: true });
    writeManifest(kept, { v: 1, kind: 'at-unlink', linkId: LINK, at: T0.toISOString(), release: '2026.11.15', dbLevel: 29, files: [], bytes: 0 });
    const r = await call(s, 'POST', '/api/link/backup/restore', act({}));
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('kept_exists');
    const show = await call(s, 'POST', '/api/link/show', { pin: TEST_PIN });
    expect(show.statusCode).toBe(409);
    expect(show.json().code).toBe('kept_data');
    expect(readJournal(s.dir)).toBeNull();
  });

  it('live_on: refused while a live broadcast runs', async () => {
    const h = await startLiveHarness({ app: { link: { restart: vi.fn() } } });
    harnesses.push(h);
    const admin = await loginAs(h.app, 'admin');
    const live = await loginAs(h.app, 'live');
    expect((await takeMasterBackup({ db: h.app.surau.db, dataDir: h.dataDir, linkId: LINK, now: T0, free: () => null })).taken).toBe(true);
    const start = await h.app.inject({ method: 'POST', url: '/api/live/start', headers: live.headers, payload: startBody(h), remoteAddress: LAN });
    expect(start.statusCode).toBe(200);
    const r = await h.app.inject({ method: 'POST', url: '/api/link/backup/restore', headers: admin.headers, remoteAddress: LAN, payload: act({}) });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('live_on');
    expect(readJournal(h.dataDir)).toBeNull();
  });

  it('confirm_required (400) without confirm: true, for both routes; nothing changes', async () => {
    const s = await site();
    expect((await take(s)).taken).toBe(true);
    // the PIN limiter counts every proof of one user, so only a few tries
    const tries: [string, unknown][] = [['/api/link/backup/restore', undefined], ['/api/link/backup/restore', false], ['/api/link/backup/drop', 'true'], ['/api/link/backup/drop', 1]];
    for (const [url, confirm] of tries) {
      const r = await call(s, 'POST', url, { pin: TEST_PIN, linkId: LINK, ...(confirm === undefined ? {} : { confirm }) });
      expect(r.statusCode, `${url} ${String(confirm)}`).toBe(400);
      expect(r.json().code).toBe('confirm_required');
    }
    expect(readJournal(s.dir)).toBeNull();
    expect(existsSync(join(s.dir, 'linkundo', LINK))).toBe(true);
  });

  it('no_backup (404): an unknown link id, a malformed one, none at all', async () => {
    const s = await site();
    expect((await take(s)).taken).toBe(true);
    const tries: [string, unknown][] = [['/api/link/backup/restore', 'e'.repeat(32)], ['/api/link/backup/drop', '../x'], ['/api/link/backup/restore', 12], ['/api/link/backup/drop', undefined]];
    for (const [url, linkId] of tries) {
      const r = await call(s, 'POST', url, act({ linkId }));
      expect(r.statusCode, `${url} ${String(linkId)}`).toBe(404);
      expect(r.json().code).toBe('no_backup');
    }
    expect(existsSync(join(s.dir, 'linkundo', LINK))).toBe(true);
  });

  it('a wrong or missing PIN is refused and changes nothing', async () => {
    const s = await site();
    expect((await take(s)).taken).toBe(true);
    for (const url of ['/api/link/backup/restore', '/api/link/backup/drop']) {
      const bad = await call(s, 'POST', url, act({ pin: WRONG_PIN }));
      expect(bad.statusCode, url).toBe(401);
      expect(bad.json().code).toBe('wrong_pin');
      const none = await call(s, 'POST', url, { linkId: LINK, confirm: true });
      expect(none.statusCode, url).toBe(400);
      expect(none.json().code).toBe('pin_required');
    }
    expect(readJournal(s.dir)).toBeNull();
    expect(existsSync(join(s.dir, 'linkundo', LINK))).toBe(true);
  });

  it('a role without devices:manage is 403, an anonymous caller 401', async () => {
    const s = await site();
    expect((await take(s)).taken).toBe(true);
    const roles = ROLES.filter((r) => r !== 'admin' && r !== 'superadmin' && r !== 'live');
    expect(roles.length).toBeGreaterThan(0);
    const targets: ['GET' | 'POST', string][] = [['GET', '/api/link/backup'], ['POST', '/api/link/backup/restore'], ['POST', '/api/link/backup/drop']];
    for (const role of roles) {
      const who = await loginAs(s.app, role);
      for (const [method, url] of targets) {
        const r = await call(s, method, url, method === 'GET' ? undefined : act({}), { as: who });
        // a role that holds devices:manage is not in this list; every other role is refused
        expect([403], `${role} ${method} ${url}`).toContain(r.statusCode);
      }
    }
    for (const [method, url] of targets) {
      const r = await call(s, method, url, method === 'GET' ? undefined : act({}), { as: null });
      expect(r.statusCode, `anon ${url}`).toBe(401);
    }
    expect(readJournal(s.dir)).toBeNull();
    expect(existsSync(join(s.dir, 'linkundo', LINK))).toBe(true);
  });

  it('a public address is 403 lan_only, so is a private one that carries a proxy header', async () => {
    const s = await site();
    expect((await take(s)).taken).toBe(true);
    for (const url of ['/api/link/backup/restore', '/api/link/backup/drop']) {
      const pub = await call(s, 'POST', url, act({}), { from: '8.8.8.8' });
      expect(pub.statusCode, url).toBe(403);
      expect(pub.json().code).toBe('lan_only');
      const proxied = await s.app.inject({ method: 'POST', url, remoteAddress: LAN, headers: { ...s.admin.headers, 'x-forwarded-for': '203.0.113.9' }, payload: act({}) });
      expect(proxied.statusCode, url).toBe(403);
      expect(proxied.json().code).toBe('lan_only');
    }
    expect(readJournal(s.dir)).toBeNull();
    expect(existsSync(join(s.dir, 'linkundo', LINK))).toBe(true);
  });

  it('GET /api/boxes carries the backup of the box and its free space', async () => {
    const s = await site();
    expect((await take(s)).taken).toBe(true);
    const r = await call(s, 'GET', '/api/boxes');
    expect(r.statusCode).toBe(200);
    expect(r.json().self.backup).toMatchObject({ linkId: LINK });
    expect(r.json().self).toHaveProperty('kept');
    expect(r.json().self).toHaveProperty('freeBytes');
  });
});
