/**
 * Plan 14 follow-up (2026-11-14): automatic linking only, no empty or duplicate suraus, prune.
 * Covers: re-approve without an orphan, the pending list (held boxes only), the empty-surau definition, deleting one,
 * the fleet route, the CLI (`surau-delete`, `surau-prune`), the daily automatic prune and the new daily cap default.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../src/auth/users.ts';
import { sha256hex } from '../src/auth/crypto.ts';
import { run as usersCli } from '../src/cli/users.ts';
import { putItem } from '../src/content/store.ts';
import { openDb } from '../src/db.ts';
import { ageEncrypt, autoPruneDays, backupBeforePrune, backupRecipient, emptySuraus, PruneBackupError, pruneEmptySuraus, startAutoPrune } from '../src/surau/prune.ts';
import { createSurau, deleteEmptySurau, getSurau, listSuraus, SurauError, surauUsage } from '../src/surau/registry.ts';
import { isStaleRegistration } from '../src/sync/workerRegs.ts';
import { approveSite, autoSurauDailyCap, DEFAULT_AUTO_SURAU_DAILY_CAP } from '../src/sync/sites.ts';
import { generateSyncKeyPair } from '../src/sync/syncKey.ts';
import { TEST_PIN, loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { buildCloud } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';

const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  // never read the machine's real /etc/maxcom/backup.recipient: point at a file that does not exist
  process.env.MAXCOM_BACKUP_RECIPIENT_FILE = join(tmpdir(), 'maxcom-test-no-such-recipient-file');
  // most tests here use a plain copy: opt in explicitly (the default is to refuse, see the fail-closed tests)
  process.env.MAXCOM_PRUNE_PLAIN_BACKUP = '1';
});
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  delete process.env.MAXCOM_AUTO_SURAU_DAILY_CAP;
  delete process.env.MAXCOM_AUTO_PRUNE_DAYS;
  delete process.env.SURAU_ROLE;
  delete process.env.MAXCOM_BACKUP_RECIPIENT_FILE;
  delete process.env.MAXCOM_AGE_BIN;
  delete process.env.MAXCOM_PRUNE_PLAIN_BACKUP;
});

const DAY = 24 * 3_600_000;
const CLOUD_BOX = '0c10ad000000000c';
const START = Date.parse('2026-11-13T08:00:00.000Z');
const HASH = 'ab'.repeat(32);
const BOX = '1111111111111111';
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40));
const count = (db: DatabaseSync, sql: string, ...p: string[]): number => Number((db.prepare(sql).get(...p) as { n: number }).n);
const age = (db: DatabaseSync, id: string, ms: number, now = Date.now()): void => {
  db.prepare('UPDATE suraus SET created_at = ? WHERE id = ?').run(new Date(now - ms).toISOString(), id);
};

/** A fresh temporary folder (the folder of a throwaway cloud), removed after the test. */
function tmpDir(): string {
  const c = buildCloud(CLOUD_BOX, { workerOutbox: { auto: false } });
  cleanups.push(() => c.close());
  return c.dir;
}

describe('daily cap default', () => {
  it('is 100; the env still overrides it', () => {
    expect(DEFAULT_AUTO_SURAU_DAILY_CAP).toBe(100);
    expect(autoSurauDailyCap({})).toBe(100);
    expect(autoSurauDailyCap({ MAXCOM_AUTO_SURAU_DAILY_CAP: '20' })).toBe(20);
    expect(autoSurauDailyCap({ MAXCOM_AUTO_SURAU_DAILY_CAP: '0' })).toBe(0);
  });
});

describe('re-approving a box into a new surau', () => {
  it('reuses the surau of its unclaimed approval: no orphan, one surau, one approval', () => {
    const db = openDb(':memory:');
    const deps = { db, now: () => new Date(START) };
    const first = approveSite(deps, { boxId: BOX, name: 'Surau A', claimHash: HASH, target: { newSurau: {} } }, 'user:1');
    expect(first.created).toBe(true);
    const again = approveSite(deps, { boxId: BOX, name: 'Surau A', claimHash: HASH, target: { newSurau: {} } }, 'user:1');
    expect(again).toEqual({ surauId: first.surauId, created: false });
    for (let i = 0; i < 4; i++) approveSite(deps, { boxId: BOX, name: 'Surau A', claimHash: HASH, target: { newSurau: {} } }, 'cli');
    expect(count(db, 'SELECT COUNT(*) AS n FROM suraus')).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM site_approvals')).toBe(1);
    expect(db.prepare('SELECT surau_id FROM site_approvals WHERE box_id = ?').get(BOX)).toMatchObject({ surau_id: first.surauId });
  });

  it('a CLAIMED approval is not reused; a different box gets its own surau', () => {
    const db = openDb(':memory:');
    const deps = { db, now: () => new Date(START) };
    const a = approveSite(deps, { boxId: BOX, name: 'A', claimHash: HASH, target: { newSurau: {} } });
    const b = approveSite(deps, { boxId: '2222222222222222', name: 'B', claimHash: HASH, target: { newSurau: {} } });
    expect(b.surauId).not.toBe(a.surauId);
    db.prepare('UPDATE site_approvals SET claimed_at = ? WHERE box_id = ?').run(new Date(START).toISOString(), BOX);
    const c = approveSite(deps, { boxId: BOX, name: 'A', claimHash: HASH, target: { newSurau: {} } });
    expect(c.created).toBe(true);
    expect(c.surauId).not.toBe(a.surauId);
  });
});

describe('what an empty surau is', () => {
  it('a fresh one is empty; the reserved ids never are', () => {
    const db = openDb(':memory:');
    const s = createSurau(db, { name: 'Kosong' }, 'test');
    expect(surauUsage(db, s.id)).toEqual({ counts: {}, empty: true });
    expect(getSurau(db, s.id)!.empty).toBe(true);
    expect(surauUsage(db, 'sdm').empty).toBe(false);
    expect(surauUsage(db, '*').empty).toBe(false);
  });

  it('an unclaimed approval, a prayer cache and the audit trail do not count', () => {
    const db = openDb(':memory:');
    const s = createSurau(db, { name: 'Kosong' }, 'test');
    approveSite({ db, now: () => new Date(START) }, { boxId: BOX, name: 'K', claimHash: HASH, target: { surauId: s.id } });
    db.prepare("INSERT INTO prayer_days (surau_id, zone, date, json) VALUES (?, 'SGR01', '2026-11-14', '{}')").run(s.id);
    expect(count(db, 'SELECT COUNT(*) AS n FROM change_log WHERE surau_id = ?', s.id)).toBeGreaterThan(0);
    expect(surauUsage(db, s.id).empty).toBe(true);
  });

  it('content, a user, a device, a live site and a claimed approval each make it non-empty', () => {
    const db = openDb(':memory:');
    const withContent = createSurau(db, { name: 'Ada kandungan' }, 'test');
    putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz' }, 'local', undefined, withContent.id);
    expect(surauUsage(db, withContent.id)).toMatchObject({ empty: false, counts: { content_items: 1 } });

    const withUser = createSurau(db, { name: 'Ada pengguna' }, 'test');
    createUser(db, { name: 'Pak Imam', roles: ['admin'] }, 'test', withUser.id);
    expect(surauUsage(db, withUser.id)).toMatchObject({ empty: false, counts: { users: 1 } });

    const withSite = createSurau(db, { name: 'Ada kotak' }, 'test');
    db.prepare('INSERT INTO sites (surau_id, box_id, name, public_jwk, token_hash, linked_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      withSite.id,
      BOX,
      'Kotak',
      JSON.stringify(generateSyncKeyPair().publicJwk),
      sha256hex('t'),
      new Date(START).toISOString(),
    );
    expect(surauUsage(db, withSite.id)).toMatchObject({ empty: false, counts: { sites: 1 } });
    // revoked: the row stays on record (so the revoked box cannot auto-link again), the surau is still not empty
    db.prepare('UPDATE sites SET revoked_at = ? WHERE box_id = ?').run(new Date(START).toISOString(), BOX);
    expect(surauUsage(db, withSite.id)).toMatchObject({ empty: false, counts: { sites: 1 } });

    const claimed = createSurau(db, { name: 'Pernah menuntut' }, 'test');
    approveSite({ db, now: () => new Date(START) }, { boxId: '3333333333333333', name: 'C', claimHash: HASH, target: { surauId: claimed.id } });
    db.prepare('UPDATE site_approvals SET claimed_at = ? WHERE box_id = ?').run(new Date(START).toISOString(), '3333333333333333');
    expect(surauUsage(db, claimed.id)).toMatchObject({ empty: false, counts: { site_approvals: 1 } });
  });

  it('a device row makes it non-empty (a surau with phones is never deleted)', () => {
    const db = openDb(':memory:');
    const s = createSurau(db, { name: 'Ada peranti' }, 'test');
    const u = createUser(db, { name: 'Pak Imam', roles: ['admin'] }, 'test', s.id);
    db.prepare("INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at, surau_id) VALUES ('d1', ?, 'Telefon', 'android', '{}', ?, ?)").run(
      u.id,
      new Date(START).toISOString(),
      s.id,
    );
    expect(surauUsage(db, s.id)).toMatchObject({ empty: false, counts: { devices: 1 } });
  });
});

describe('prune gate fixes', () => {
  const revokedSurau = (db: DatabaseSync): string => {
    const s = createSurau(db, { name: 'Kotak dibatalkan' }, 'test');
    db.prepare('INSERT INTO sites (surau_id, box_id, name, public_jwk, token_hash, linked_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      s.id,
      BOX,
      'Kotak',
      JSON.stringify(generateSyncKeyPair().publicJwk),
      sha256hex('t'),
      new Date(START).toISOString(),
      new Date(START).toISOString(),
    );
    return s.id;
  };

  it('F1: a surau with a revoked box is not empty: delete refused (not_empty), prune skips it, the revoked row survives', () => {
    const db = openDb(':memory:');
    const id = revokedSurau(db);
    const now = new Date(START + 10 * DAY);
    age(db, id, 5 * DAY, now.getTime());
    expect(() => deleteEmptySurau(db, id, 'user:1')).toThrowError(expect.objectContaining({ code: 'not_empty' }));
    expect(emptySuraus(db, DAY, now)).toEqual([]);
    const r = pruneEmptySuraus(db, { now, olderThanMs: DAY, apply: true, backupDir: join(tmpDir(), 'backups') });
    expect(r.deleted).toEqual([]);
    expect(count(db, 'SELECT COUNT(*) AS n FROM sites WHERE box_id = ? AND revoked_at IS NOT NULL', BOX)).toBe(1);
    expect(getSurau(db, id)).not.toBeNull();
  });

  it('F2: a surau re-approved inside the prune age is skipped; an old approval does not protect it; a suspended one is skipped', () => {
    const db = openDb(':memory:');
    const now = new Date(START + 10 * DAY);
    const fresh = createSurau(db, { name: 'Baru diluluskan' }, 'test');
    const stale = createSurau(db, { name: 'Lama diluluskan' }, 'test');
    const suspended = createSurau(db, { name: 'Digantung' }, 'test');
    for (const s of [fresh, stale, suspended]) age(db, s.id, 5 * DAY, now.getTime());
    approveSite({ db, now: () => new Date(now.getTime() - 3_600_000) }, { boxId: BOX, name: 'F', claimHash: HASH, target: { surauId: fresh.id } });
    approveSite({ db, now: () => new Date(now.getTime() - 3 * DAY) }, { boxId: '2222222222222222', name: 'S', claimHash: HASH, target: { surauId: stale.id } });
    db.prepare('UPDATE suraus SET suspended_at = ?, suspended_reason = ? WHERE id = ?').run(new Date(START).toISOString(), 'x', suspended.id);
    expect(emptySuraus(db, DAY, now).map((c) => c.id)).toEqual([stale.id]);
  });

  it('F3: backups folder 0700 and file 0600 (where supported), unique names within one millisecond, newest 7 kept, pattern-only deletion', () => {
    const db = openDb(':memory:');
    const dir = join(tmpDir(), 'backups');
    mkdirSync(dir, { recursive: true });
    const other = join(dir, 'notes.txt');
    const lookalike = join(dir, 'pre-prune-keep-me.db');
    writeFileSync(other, 'x');
    writeFileSync(lookalike, 'x');
    const same = new Date('2026-11-14T10:00:00.000Z');
    const a = backupBeforePrune(db, dir, same);
    const b = backupBeforePrune(db, dir, same);
    expect(a).not.toBe(b);
    for (let i = 1; i <= 9; i++) backupBeforePrune(db, dir, new Date(same.getTime() + i * 1000));
    const dbs = readdirSync(dir).filter((f) => /^pre-prune-\d{4}-.*\.db$/.test(f));
    expect(dbs).toHaveLength(7);
    // the oldest ones went, the newest stayed
    expect(dbs.some((f) => f.includes('T10-00-09-000Z'))).toBe(true);
    expect(dbs.some((f) => f.includes('T10-00-00-000Z'))).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(lookalike)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, dbs[0]!)).mode & 0o777).toBe(0o600);
    }
  });

  it('F4: an apply run removes prayer_days and meta rows of a surau that no longer exists; a dry run only reports; sdm and * stay', () => {
    const db = openDb(':memory:');
    const keep = createSurau(db, { name: 'Ada' }, 'test');
    for (const sid of ['gone0000', keep.id, 'sdm', '*']) {
      db.prepare("INSERT OR REPLACE INTO prayer_days (surau_id, zone, date, json) VALUES (?, ?, '2026-11-14', '{}')").run(sid, `Z-${sid}`);
      db.prepare('INSERT OR REPLACE INTO meta (surau_id, key, value) VALUES (?, ?, ?)').run(sid, `k-${sid}`, '1');
    }
    const logs: string[] = [];
    pruneEmptySuraus(db, { now: new Date(START), olderThanMs: DAY, backupDir: join(tmpDir(), 'backups'), log: (l) => logs.push(l) });
    expect(count(db, "SELECT COUNT(*) AS n FROM prayer_days WHERE surau_id = 'gone0000'")).toBe(1);
    expect(logs).toHaveLength(1);
    pruneEmptySuraus(db, { now: new Date(START), olderThanMs: DAY, apply: true, backupDir: join(tmpDir(), 'backups') });
    expect(count(db, "SELECT COUNT(*) AS n FROM prayer_days WHERE surau_id = 'gone0000'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM meta WHERE key = 'k-gone0000'")).toBe(0);
    for (const sid of [keep.id, 'sdm', '*']) {
      expect(count(db, 'SELECT COUNT(*) AS n FROM prayer_days WHERE surau_id = ?', sid)).toBe(1);
      expect(count(db, 'SELECT COUNT(*) AS n FROM meta WHERE key = ?', `k-${sid}`)).toBe(1);
    }
  });
});

describe('F5: pending staleness uses seenAt when the Worker sends it', () => {
  const now = new Date('2026-11-14T12:00:00.000Z');
  it('seenAt wins over at; an older Worker (no seenAt) falls back to at; no readable time is stale', () => {
    const old = '2026-11-01T00:00:00.000Z';
    const recent = '2026-11-14T10:00:00.000Z';
    expect(isStaleRegistration({ at: old, seenAt: recent }, now)).toBe(false);
    expect(isStaleRegistration({ at: recent, seenAt: old }, now)).toBe(true);
    expect(isStaleRegistration({ at: old }, now)).toBe(true);
    expect(isStaleRegistration({ at: recent }, now)).toBe(false);
    expect(isStaleRegistration({ at: '' }, now)).toBe(true);
  });
});

describe('deleteEmptySurau', () => {
  it('refuses a surau with content (not_empty with the counts) and changes nothing', () => {
    const db = openDb(':memory:');
    const s = createSurau(db, { name: 'Ada kandungan' }, 'test');
    putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz' }, 'local', undefined, s.id);
    const snap = (): string => JSON.stringify([db.prepare('SELECT * FROM suraus').all(), db.prepare('SELECT * FROM content_items').all(), count(db, 'SELECT COUNT(*) AS n FROM change_log')]);
    const before = snap();
    let err: unknown;
    try {
      deleteEmptySurau(db, s.id, 'user:1');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SurauError);
    expect(err).toMatchObject({ code: 'not_empty', counts: { content_items: 1 } });
    expect(snap()).toBe(before);
  });

  it('refuses the local surau, and an unknown or malformed id is surau_not_found', () => {
    const db = openDb(':memory:');
    expect(() => deleteEmptySurau(db, 'zzzzzzzzzzzz', 'x')).toThrowError(expect.objectContaining({ code: 'surau_not_found' }));
    expect(() => deleteEmptySurau(db, '../x', 'x')).toThrowError(expect.objectContaining({ code: 'surau_not_found' }));
    db.prepare("INSERT INTO suraus (id, name, created_at, created_by) VALUES ('sdm', 'Pilot', ?, 'm')").run(new Date(START).toISOString());
    expect(() => deleteEmptySurau(db, 'sdm', 'x')).toThrowError(expect.objectContaining({ code: 'not_empty' }));
    expect(count(db, "SELECT COUNT(*) AS n FROM suraus WHERE id = 'sdm'")).toBe(1);
  });

  it('deletes an empty surau, its unclaimed approval and prayer cache; keeps the audit trail and writes one delete entry; other suraus untouched', () => {
    const db = openDb(':memory:');
    const keep = createSurau(db, { name: 'Kekal' }, 'test');
    putItem(db, 'penceramah', { id: 'p9', name: 'Ustaz Kekal' }, 'local', undefined, keep.id);
    const s = createSurau(db, { name: 'Kosong' }, 'test');
    approveSite({ db, now: () => new Date(START) }, { boxId: BOX, name: 'K', claimHash: HASH, target: { surauId: s.id } });
    db.prepare("INSERT INTO prayer_days (surau_id, zone, date, json) VALUES (?, 'SGR01', '2026-11-14', '{}')").run(s.id);
    const auditBefore = count(db, 'SELECT COUNT(*) AS n FROM change_log WHERE surau_id = ?', s.id);

    expect(deleteEmptySurau(db, s.id, 'user:7')).toEqual({ id: s.id, name: 'Kosong' });
    expect(db.prepare('SELECT 1 AS x FROM suraus WHERE id = ?').get(s.id)).toBeUndefined();
    expect(count(db, 'SELECT COUNT(*) AS n FROM site_approvals')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM prayer_days WHERE surau_id = ?', s.id)).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM change_log WHERE surau_id = ?', s.id)).toBe(auditBefore + 1);
    const last = db.prepare('SELECT actor, entity, after_json FROM change_log WHERE surau_id = ? ORDER BY id DESC LIMIT 1').get(s.id)!;
    expect(last).toMatchObject({ actor: 'user:7', entity: 'surau' });
    expect(JSON.parse(String(last.after_json))).toEqual({ event: 'delete', id: s.id, name: 'Kosong' });
    expect(surauUsage(db, keep.id).counts).toMatchObject({ content_items: 1 });
    expect(listSuraus(db).map((x) => x.id)).toEqual([keep.id]);
    expect(() => deleteEmptySurau(db, s.id, 'user:7')).toThrowError(expect.objectContaining({ code: 'surau_not_found' }));
  });
});

describe('prune', () => {
  it('dry run lists the empty suraus older than the age and writes nothing; apply backs up first, then deletes only those', () => {
    const db = openDb(':memory:');
    const now = new Date(START + 10 * DAY);
    const oldEmpty = createSurau(db, { name: 'Lama kosong' }, 'test');
    const newEmpty = createSurau(db, { name: 'Baharu kosong' }, 'test');
    const oldFull = createSurau(db, { name: 'Lama berisi' }, 'test');
    putItem(db, 'penceramah', { id: 'p1', name: 'U' }, 'local', undefined, oldFull.id);
    age(db, oldEmpty.id, 3 * DAY, now.getTime());
    age(db, oldFull.id, 3 * DAY, now.getTime());
    age(db, newEmpty.id, 3_600_000, now.getTime());
    const dir = join(tmpDir(), 'backups');

    expect(emptySuraus(db, DAY, now).map((c) => c.id)).toEqual([oldEmpty.id]);
    const dry = pruneEmptySuraus(db, { now, olderThanMs: DAY, backupDir: dir });
    expect(dry.candidates.map((c) => c.id)).toEqual([oldEmpty.id]);
    expect(dry.deleted).toEqual([]);
    expect(dry.backup).toBeNull();
    expect(existsSync(dir)).toBe(false);
    expect(listSuraus(db)).toHaveLength(3);

    const gone: string[] = [];
    const logs: string[] = [];
    const done = pruneEmptySuraus(db, { now, olderThanMs: DAY, apply: true, backupDir: dir, onDeleted: (id) => gone.push(id), log: (l) => logs.push(l) });
    expect(done.deleted.map((c) => c.id)).toEqual([oldEmpty.id]);
    expect(gone).toEqual([oldEmpty.id]);
    const deletedLogs = logs.filter((l) => l.includes('dipadam'));
    expect(deletedLogs).toHaveLength(1);
    expect(deletedLogs[0]).toContain(oldEmpty.id);
    expect(logs.some((l) => l.includes('tidak disulitkan'))).toBe(true);
    expect(listSuraus(db).map((s) => s.id).sort()).toEqual([newEmpty.id, oldFull.id].sort());
    expect(done.backup).toMatch(/pre-prune-2026-11-2\dT\d\d-\d\d-\d\d-\d{3}Z-[0-9a-f]{6}\.db$/);
    expect(readdirSync(dir)).toHaveLength(1);
    // the backup is a database that still holds the deleted surau
    const copy = openDb(done.backup!);
    expect(copy.prepare('SELECT 1 AS x FROM suraus WHERE id = ?').get(oldEmpty.id)).toBeDefined();
    copy.close();
  });

  it('nothing to delete: no backup file is written', () => {
    const db = openDb(':memory:');
    const dir = join(tmpDir(), 'backups');
    const r = pruneEmptySuraus(db, { now: new Date(START), olderThanMs: DAY, apply: true, backupDir: dir });
    expect(r.backup).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it('autoPruneDays: default 7, 0 = off, junk = default', () => {
    expect(autoPruneDays({})).toBe(7);
    expect(autoPruneDays({ MAXCOM_AUTO_PRUNE_DAYS: '0' })).toBe(0);
    expect(autoPruneDays({ MAXCOM_AUTO_PRUNE_DAYS: '14' })).toBe(14);
    expect(autoPruneDays({ MAXCOM_AUTO_PRUNE_DAYS: 'x' })).toBe(7);
    expect(autoPruneDays({ MAXCOM_AUTO_PRUNE_DAYS: '-1' })).toBe(7);
  });

  it('the daily timer deletes empty suraus older than the days, logs one line each, and does nothing when days = 0', async () => {
    const db = openDb(':memory:');
    const now = new Date(START + 30 * DAY);
    const old = createSurau(db, { name: 'Lama' }, 'test');
    const young = createSurau(db, { name: 'Muda' }, 'test');
    age(db, old.id, 8 * DAY, now.getTime());
    age(db, young.id, 6 * DAY, now.getTime());
    const dir = join(tmpDir(), 'backups');
    const logs: string[] = [];
    const off = startAutoPrune({ db, now: () => now, days: 0, backupDir: dir, firstDelayMs: 5 });
    await new Promise((r) => setTimeout(r, 40));
    off();
    expect(listSuraus(db)).toHaveLength(2);
    const stop = startAutoPrune({ db, now: () => now, days: 7, backupDir: dir, log: (l) => logs.push(l), firstDelayMs: 5, intervalMs: 3_600_000 });
    await new Promise((r) => setTimeout(r, 120));
    stop();
    expect(listSuraus(db).map((s) => s.id)).toEqual([young.id]);
    expect(logs.filter((l) => l.includes('dipadam'))).toHaveLength(1);
    expect(readdirSync(dir)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// the cloud: fleet route, CLI, pending list

interface Rig {
  cloud: TestCloud;
  db: DatabaseSync;
  worker: FakeWorker;
  clock: number;
}
function rig(): Rig {
  const state = { clock: START } as Rig;
  const viaWorker = ((i: Parameters<typeof fetch>[0], n?: RequestInit) => state.worker.fetch(i, n)) as typeof fetch;
  const cloud = buildCloud(CLOUD_BOX, {
    workerAdmin: { url: 'https://worker.test', token: 'test-admin-token', fetchImpl: viaWorker },
    workerOutbox: { auto: false },
    now: () => new Date(state.clock),
  });
  state.cloud = cloud;
  state.db = cloud.app.surau.db;
  state.worker = new FakeWorker(cloud.fetch, () => state.clock);
  cleanups.push(() => cloud.close());
  return state;
}
let boxN = 0;
function newBox() {
  boxN += 1;
  return { boxId: `b${String(boxN).padStart(15, '0')}`, claim: randomBytes(32).toString('hex'), publicJwk: generateSyncKeyPair().publicJwk };
}
type Box = ReturnType<typeof newBox>;
function register(r: Rig, b: Box, name = 'Surau Al-Hidayah', at = r.clock): void {
  r.worker.regs.set(b.boxId, { claimHash: sha256hex(b.claim), name, at: new Date(at).toISOString() });
}
let ipN = 0;
const claim = (r: Rig, b: Box) => {
  ipN += 1;
  return r.cloud.app.inject({ method: 'POST', url: '/api/sync/claim', remoteAddress: `10.6.${(ipN >> 8) & 255}.${ipN & 255}`, payload: { boxId: b.boxId, claim: b.claim, publicJwk: b.publicJwk } });
};
async function autoLink(r: Rig, name = 'Surau Terpaut'): Promise<{ box: Box; surauId: string }> {
  const box = newBox();
  register(r, box, name);
  const res = await claim(r, box);
  expect(res.statusCode, res.body).toBe(200);
  await settle();
  return { box, surauId: (res.json() as { surauId: string }).surauId };
}
const ops = (r: Rig): Promise<Login> => loginAs(r.cloud.app, ['superadmin', 'admin']);
const support = (r: Rig): Promise<Login> => loginAs(r.cloud.app, 'support');
const call = (r: Rig, who: Login | null, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  r.cloud.app.inject({ method, url, ...(who === null ? { remoteAddress: '10.168.1.60' } : { headers: who.headers }), ...(payload === undefined ? {} : { payload }) });
const viaWorkerOf = (r: Rig) => ({
  url: 'https://worker.test',
  token: 'test-admin-token',
  fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => r.worker.fetch(i, n)) as typeof fetch,
});
async function cli(r: Rig, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  process.env.SURAU_ROLE = 'cloud';
  const code = await usersCli(['--db', join(r.cloud.dir, 'cloud.db'), ...args], { workerAdmin: viaWorkerOf(r), out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('DELETE /api/fleet/suraus/:id', () => {
  it('an ops superadmin deletes an empty surau: 200 { deleted: true }, the row is gone, one auth_log row; the list showed empty before', async () => {
    const r = rig();
    const s = createSurau(r.db, { name: 'Kosong' }, 'test');
    const sa = await ops(r);
    const list = (await call(r, sa, 'GET', '/api/suraus')).json() as { suraus: { id: string; empty: boolean }[] };
    expect(list.suraus.find((x) => x.id === s.id)).toMatchObject({ empty: true });
    const res = await call(r, sa, 'DELETE', `/api/fleet/suraus/${s.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
    expect(r.db.prepare('SELECT 1 AS x FROM suraus WHERE id = ?').get(s.id)).toBeUndefined();
    const log = r.db.prepare("SELECT * FROM auth_log WHERE event = 'fleet_surau_delete'").all();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ user_id: sa.userId, device_id: sa.deviceId, ok: 1 });
    expect(String(log[0]!.detail)).toContain(s.id);
    expect((await call(r, sa, 'DELETE', `/api/fleet/suraus/${s.id}`)).statusCode).toBe(404);
  });

  it('a surau with a live box is 409 not_empty with errors and counts, nothing is deleted; the list says empty false', async () => {
    const r = rig();
    const linked = await autoLink(r);
    const sa = await ops(r);
    const res = await call(r, sa, 'DELETE', `/api/fleet/suraus/${linked.surauId}`);
    expect(res.statusCode, res.body).toBe(409);
    const j = res.json() as { code: string; errors: string[]; counts: Record<string, number> };
    expect(j.code).toBe('not_empty');
    expect(j.errors.length).toBeGreaterThan(0);
    expect(j.counts.sites).toBe(1);
    expect(r.db.prepare('SELECT 1 AS x FROM suraus WHERE id = ?').get(linked.surauId)).toBeDefined();
    const list = (await call(r, sa, 'GET', '/api/suraus')).json() as { suraus: { id: string; empty: boolean }[] };
    expect(list.suraus.find((x) => x.id === linked.surauId)).toMatchObject({ empty: false });
  });

  it('a surau with users or content is refused too (409)', async () => {
    const r = rig();
    const s = createSurau(r.db, { name: 'Berisi' }, 'test');
    createUser(r.db, { name: 'Pak Imam', roles: ['admin'] }, 'test', s.id);
    const t = createSurau(r.db, { name: 'Berisi 2' }, 'test');
    putItem(r.db, 'penceramah', { id: 'p1', name: 'U' }, 'local', undefined, t.id);
    const sa = await ops(r);
    for (const id of [s.id, t.id]) {
      const res = await call(r, sa, 'DELETE', `/api/fleet/suraus/${id}`);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe('not_empty');
    }
  });

  it('refuses support (403), a surau admin (403) and an anonymous caller; malformed or unknown ids are 404; nothing is written', async () => {
    const r = rig();
    const linked = await autoLink(r);
    const s = createSurau(r.db, { name: 'Kosong' }, 'test');
    const ids = (): string => JSON.stringify(r.db.prepare('SELECT id FROM suraus ORDER BY id').all());
    const sp = await support(r);
    const adm = await loginAs(r.cloud.app, 'admin', TEST_PIN, linked.surauId);
    const sa = await ops(r);
    const before = ids();
    expect((await call(r, sp, 'DELETE', `/api/fleet/suraus/${s.id}`)).statusCode).toBe(403);
    expect((await call(r, adm, 'DELETE', `/api/fleet/suraus/${s.id}`)).statusCode).toBe(403);
    expect([401, 403]).toContain((await call(r, null, 'DELETE', `/api/fleet/suraus/${s.id}`)).statusCode);
    expect((await call(r, sa, 'DELETE', '/api/fleet/suraus/zzzzzzzzzzzz')).statusCode).toBe(404);
    expect((await call(r, sa, 'DELETE', '/api/fleet/suraus/not-an-id')).statusCode).toBe(404);
    expect(ids()).toBe(before);
  });

  it('on a box (role box) the path answers 404 and deletes nothing', async () => {
    const box = buildCloud('0b0b0b0b0b0b0b0b', { role: 'box' });
    cleanups.push(() => box.close());
    const who = await loginAs(box.app, ['superadmin', 'admin']);
    const res = await box.app.inject({ method: 'DELETE', url: '/api/fleet/suraus/abcdefghijkl', headers: who.headers });
    expect(res.statusCode).toBe(404);
  });
});

describe('re-approving through the fleet route and the CLI', () => {
  it('approving the same held box twice makes one surau; the second answer has created:false; the box then links into it', async () => {
    process.env.MAXCOM_AUTO_SURAU_DAILY_CAP = '1';
    const r = rig();
    await autoLink(r, 'Pengisi Had');
    const b = newBox();
    register(r, b, 'Surau Tertahan');
    expect((await claim(r, b)).statusCode).not.toBe(200);
    const sa = await ops(r);
    const before = count(r.db, 'SELECT COUNT(*) AS n FROM suraus');
    const one = await call(r, sa, 'POST', `/api/fleet/pending/${b.boxId}/approve`, { newSurau: true });
    expect(one.statusCode, one.body).toBe(200);
    const two = await call(r, sa, 'POST', `/api/fleet/pending/${b.boxId}/approve`, { newSurau: true });
    expect(two.statusCode, two.body).toBe(200);
    expect(two.json()).toEqual({ surauId: one.json().surauId, created: false });
    expect(count(r.db, 'SELECT COUNT(*) AS n FROM suraus')).toBe(before + 1);
    const linked = await claim(r, b);
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json().surauId).toBe(one.json().surauId);
  });

  it('the CLI cloud-approve twice makes one surau too', async () => {
    const r = rig();
    const b = newBox();
    register(r, b, 'Surau CLI');
    const args = ['cloud-approve', '--box-id', b.boxId, '--new-surau'];
    const first = await cli(r, args);
    const second = await cli(r, args);
    expect(first.code, first.err).toBe(0);
    expect(second.code, second.err).toBe(0);
    expect(count(r.db, 'SELECT COUNT(*) AS n FROM suraus')).toBe(1);
    expect(first.out).toContain('(baharu)');
    expect(second.out).not.toContain('(baharu)');
  });
});

describe('GET /api/fleet/pending: only boxes that are really held and recently seen', () => {
  it('a cap-held box is daily_cap; a stale registration is not listed; a box about to link is not; past the grace period a waiting box is "other"', async () => {
    process.env.MAXCOM_AUTO_SURAU_DAILY_CAP = '1';
    const r = rig();
    await autoLink(r, 'Pengisi Had');
    const held = newBox();
    register(r, held, 'Tertahan');
    expect((await claim(r, held)).statusCode).not.toBe(200);
    const stale = newBox();
    register(r, stale, 'Lama', r.clock - 2 * DAY);
    const sa = await ops(r);
    const list = async (who: Login): Promise<string[]> =>
      ((await call(r, who, 'GET', '/api/fleet/pending')).json() as { pending: { boxId: string; held: string }[] }).pending.map((p) => `${p.boxId}:${p.held}`);
    expect(await list(sa)).toEqual([`${held.boxId}:daily_cap`]);

    // the cap no longer holds the box: it is only waiting, so not listed until it is past the grace period
    process.env.MAXCOM_AUTO_SURAU_DAILY_CAP = '100';
    expect(await list(sa)).toEqual([]);
    r.clock += 11 * 60_000;
    const sa2 = await ops(r);
    expect(await list(sa2)).toEqual([`${held.boxId}:other`]);
  });

  it('cloud-pending (CLI) still shows everything, with a stale marker on the old registration', async () => {
    const r = rig();
    const fresh = newBox();
    register(r, fresh, 'Segar', Date.now());
    const old = newBox();
    register(r, old, 'Lama', Date.now() - 3 * DAY);
    const res = await cli(r, ['cloud-pending']);
    expect(res.code, res.err).toBe(0);
    const lines = res.out.split('\n');
    const freshLine = lines.find((l) => l.includes(fresh.boxId))!;
    const oldLine = lines.find((l) => l.includes(old.boxId))!;
    expect(freshLine).toBeDefined();
    expect(oldLine).toContain('stale');
    expect(freshLine).not.toContain('stale');
  });
});

describe('CLI surau-delete and surau-prune', () => {
  it('surau-delete removes an empty surau and refuses a non-empty one (exit 1), and needs --surau', async () => {
    const r = rig();
    const linked = await autoLink(r);
    const s = createSurau(r.db, { name: 'Kosong' }, 'test');
    expect((await cli(r, ['surau-delete'])).code).toBe(1);
    const refused = await cli(r, ['surau-delete', '--surau', linked.surauId]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('tidak kosong');
    expect(r.db.prepare('SELECT 1 AS x FROM suraus WHERE id = ?').get(linked.surauId)).toBeDefined();
    const ok = await cli(r, ['surau-delete', '--surau', s.id]);
    expect(ok.code, ok.err).toBe(0);
    expect(r.db.prepare('SELECT 1 AS x FROM suraus WHERE id = ?').get(s.id)).toBeUndefined();
    expect((await cli(r, ['surau-delete', '--surau', s.id])).code).toBe(1);
  });

  it('surau-prune is a dry run by default; --apply backs up beside the database, then deletes only the old empty ones', async () => {
    const r = rig();
    const linked = await autoLink(r);
    const oldEmpty = createSurau(r.db, { name: 'Lama kosong' }, 'test');
    const newEmpty = createSurau(r.db, { name: 'Baharu kosong' }, 'test');
    age(r.db, oldEmpty.id, 3 * DAY);
    age(r.db, linked.surauId, 3 * DAY);
    const dry = await cli(r, ['surau-prune']);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(oldEmpty.id);
    expect(dry.out).not.toContain(newEmpty.id);
    expect(dry.out).not.toContain(linked.surauId);
    expect(count(r.db, 'SELECT COUNT(*) AS n FROM suraus')).toBe(3);
    expect(existsSync(join(r.cloud.dir, 'backups'))).toBe(false);

    const applied = await cli(r, ['surau-prune', '--apply']);
    expect(applied.code, applied.err).toBe(0);
    expect(applied.out).toContain('dipadam');
    expect(r.db.prepare('SELECT 1 AS x FROM suraus WHERE id = ?').get(oldEmpty.id)).toBeUndefined();
    expect(r.db.prepare('SELECT 1 AS x FROM suraus WHERE id = ?').get(newEmpty.id)).toBeDefined();
    expect(r.db.prepare('SELECT 1 AS x FROM suraus WHERE id = ?').get(linked.surauId)).toBeDefined();
    const files = readdirSync(join(r.cloud.dir, 'backups'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^pre-prune-.*\.db$/);

    const all = await cli(r, ['surau-prune', '--older-hours', '0']);
    expect(all.out).toContain(newEmpty.id);
    expect((await cli(r, ['surau-prune', '--older-hours', 'abc'])).code).toBe(1);
  });

  it('both commands are cloud only (a box answers "Hanya di awan MAXCOM")', async () => {
    const r = rig();
    const out: string[] = [];
    process.env.SURAU_ROLE = 'box';
    for (const cmd of [['surau-delete', '--surau', 'abcdefghijkl'], ['surau-prune']]) {
      const code = await usersCli(['--db', join(r.cloud.dir, 'cloud.db'), ...cmd], { err: (l) => out.push(l), out: (l) => out.push(l) });
      expect(code).toBe(1);
    }
    expect(out.join('\n')).toContain('Hanya di awan MAXCOM');
  });

  it('the usage text names both commands', async () => {
    const out: string[] = [];
    await usersCli(['--db', 'x.db'], { err: (l) => out.push(l) });
    const text = out.join('\n');
    expect(text).toContain('surau-delete --surau <id>');
    expect(text).toContain('surau-prune [--older-hours <n>] [--apply]');
  });
});

describe('the cloud app wires the daily prune', () => {
  it('autoPrune on the cloud role deletes an old empty surau (backup beside the database) and leaves a young one; a box never prunes', async () => {
    const c = buildCloud(CLOUD_BOX, { workerOutbox: { auto: false }, autoPrune: { days: 7, firstDelayMs: 150 } });
    cleanups.push(() => c.close());
    const db = c.app.surau.db;
    const old = createSurau(db, { name: 'Lama' }, 'test');
    const young = createSurau(db, { name: 'Muda' }, 'test');
    age(db, old.id, 8 * DAY);
    age(db, young.id, 2 * DAY);
    await new Promise((r) => setTimeout(r, 800));
    expect(listSuraus(db).map((s) => s.id)).toEqual([young.id]);
    expect(readdirSync(join(c.dir, 'backups'))).toHaveLength(1);

    const box = buildCloud('0b0b0b0b0b0b0b0b', { role: 'box', autoPrune: { days: 7, firstDelayMs: 20 } });
    cleanups.push(() => box.close());
    const stray = createSurau(box.app.surau.db, { name: 'Lama pada kotak' }, 'test');
    age(box.app.surau.db, stray.id, 30 * DAY);
    await new Promise((r) => setTimeout(r, 400));
    expect(getSurau(box.app.surau.db, stray.id)).not.toBeNull();
  });
});

describe('the pre-prune copy is encrypted when a backup recipient is configured', () => {
  const RCPT = `age1${'q'.repeat(58)}`;
  const fakeEncrypt = (plain: string, out: string): void => writeFileSync(out, Buffer.concat([Buffer.from('AGE:'), readFileSync(plain)]));
  const failing = (): void => {
    throw new Error('age gagal: tiada');
  };
  const emptyOld = (db: DatabaseSync, now: Date): string => {
    const x = createSurau(db, { name: 'Kosong' }, 'test');
    age(db, x.id, 3 * DAY, now.getTime());
    return x.id;
  };
  const NOW = new Date(START + 10 * DAY);

  it('recipient present + encrypt ok: only the .age remains, the plain copy is gone, 0600 where supported', () => {
    const db = openDb(':memory:');
    const dir = join(tmpDir(), 'backups');
    const path = backupBeforePrune(db, dir, NOW, { recipient: RCPT, encrypt: fakeEncrypt });
    expect(path).toMatch(/\.db\.age$/);
    const files = readdirSync(dir);
    expect(files).toEqual([path.slice(dir.length + 1)]);
    expect(files.filter((f) => f.endsWith('.db'))).toHaveLength(0);
    expect(statSync(path).size).toBeGreaterThan(0);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('the encrypt step gets the recipient and the plain and output paths as values', () => {
    const db = openDb(':memory:');
    const seen: string[][] = [];
    const p = backupBeforePrune(db, join(tmpDir(), 'backups'), NOW, {
      recipient: RCPT,
      encrypt: (a, o, r) => {
        seen.push([a, o, r]);
        fakeEncrypt(a, o);
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]![2]).toBe(RCPT);
    expect(seen[0]![1]).toBe(`${seen[0]![0]}.age`);
    expect(p).toBe(seen[0]![1]);
  });

  it('encrypt fails: throws, no plain or partial file is left, and prune deletes no surau', () => {
    const db = openDb(':memory:');
    const id = emptyOld(db, NOW);
    const dir = join(tmpDir(), 'backups');
    const logs: string[] = [];
    const partial = (_a: string, o: string): void => {
      writeFileSync(o, 'partial');
      failing();
    };
    expect(() => backupBeforePrune(db, dir, NOW, { recipient: RCPT, encrypt: partial })).toThrow(/age gagal/);
    expect(readdirSync(dir)).toEqual([]);
    expect(() => pruneEmptySuraus(db, { now: NOW, olderThanMs: DAY, apply: true, backupDir: dir, backup: { recipient: RCPT, encrypt: partial }, log: (l) => logs.push(l) })).toThrow(PruneBackupError);
    expect(readdirSync(dir)).toEqual([]);
    expect(getSurau(db, id)).toBeDefined();
    expect(logs.some((l) => l.includes('sandaran gagal'))).toBe(true);
  });

  const addOrphan = (db: DatabaseSync): void => {
    db.prepare("INSERT INTO prayer_days (surau_id, zone, date, json) VALUES ('gone0000', 'Z', '2026-11-14', '{}')").run();
    db.prepare("INSERT INTO meta (surau_id, key, value) VALUES ('gone0000', 'k', '1')").run();
  };
  const orphanCount = (db: DatabaseSync): number => count(db, "SELECT COUNT(*) AS n FROM prayer_days WHERE surau_id = 'gone0000'") + count(db, "SELECT COUNT(*) AS n FROM meta WHERE surau_id = 'gone0000'");

  it('backup fails with candidates and orphan rows: throws PruneBackupError, orphans stay, no surau deleted', () => {
    const db = openDb(':memory:');
    const id = emptyOld(db, NOW);
    addOrphan(db);
    const dir = join(tmpDir(), 'backups');
    let err: unknown;
    try {
      pruneEmptySuraus(db, { now: NOW, olderThanMs: DAY, apply: true, backupDir: dir, backup: { recipient: RCPT, encrypt: failing } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PruneBackupError);
    expect((err as Error).message).toMatch(/Sandaran.*age gagal: tiada/);
    expect(orphanCount(db)).toBe(2);
    expect(getSurau(db, id)).toBeDefined();
  });

  it('backup ok with candidates and orphan rows: orphans removed and suraus deleted', () => {
    const db = openDb(':memory:');
    const id = emptyOld(db, NOW);
    addOrphan(db);
    const dir = join(tmpDir(), 'backups');
    const r = pruneEmptySuraus(db, { now: NOW, olderThanMs: DAY, apply: true, backupDir: dir, backup: { recipient: RCPT, encrypt: fakeEncrypt } });
    expect(r.deleted.map((d) => d.id)).toEqual([id]);
    expect(r.backup).toMatch(/\.db\.age$/);
    expect(orphanCount(db)).toBe(0);
    expect(getSurau(db, id)).toBeNull();
  });

  it('apply with no candidates: orphans removed, no backup written', () => {
    const db = openDb(':memory:');
    addOrphan(db);
    const dir = join(tmpDir(), 'backups');
    const r = pruneEmptySuraus(db, { now: NOW, olderThanMs: DAY, apply: true, backupDir: dir, backup: { recipient: RCPT, encrypt: failing } });
    expect(r.candidates).toEqual([]);
    expect(r.backup).toBeNull();
    expect(orphanCount(db)).toBe(0);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it('an empty .age output counts as a failure', () => {
    const db = openDb(':memory:');
    const dir = join(tmpDir(), 'backups');
    expect(() => backupBeforePrune(db, dir, NOW, { recipient: RCPT, encrypt: (_a, o) => writeFileSync(o, '') })).toThrow(/kosong/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('with a recipient file and a missing age binary (env), prune throws and deletes nothing', () => {
    const dir = tmpDir();
    const file = join(dir, 'rcpt');
    writeFileSync(file, `${RCPT}\n`);
    process.env.MAXCOM_BACKUP_RECIPIENT_FILE = file;
    process.env.MAXCOM_AGE_BIN = join(dir, 'no-such-age-binary');
    const db = openDb(':memory:');
    const id = emptyOld(db, NOW);
    expect(() => pruneEmptySuraus(db, { now: NOW, olderThanMs: DAY, apply: true, backupDir: join(dir, 'backups') })).toThrow(PruneBackupError);
    expect(getSurau(db, id)).toBeDefined();
    expect(existsSync(join(dir, 'backups')) ? readdirSync(join(dir, 'backups')) : []).toEqual([]);
  });

  it('the real age step runs the binary without a shell (a fake script binary)', () => {
    const dir = tmpDir();
    const missing = { MAXCOM_AGE_BIN: join(dir, 'missing') };
    expect(() => ageEncrypt(join(dir, 'x.db'), join(dir, 'x.db.age'), RCPT, missing)).toThrow(/age gagal/);
    if (process.platform === 'win32') return; // the fake binary is a shell script
    const bin = join(dir, 'fake-age');
    writeFileSync(bin, '#!/bin/sh\nprintf "%s|" "$@" > "$4.args"\ncp "$5" "$4"\n');
    chmodSync(bin, 0o755);
    const plain = join(dir, 'x.db');
    writeFileSync(plain, 'data');
    ageEncrypt(plain, join(dir, 'x.db.age'), RCPT, { MAXCOM_AGE_BIN: bin });
    expect(readFileSync(join(dir, 'x.db.age'), 'utf8')).toBe('data');
    expect(readFileSync(join(dir, 'x.db.age.args'), 'utf8')).toBe(`-r|${RCPT}|-o|${join(dir, 'x.db.age')}|${plain}|`);
  });

  it('an invalid recipient value is treated as none by backupRecipient and is never used', () => {
    const dir = tmpDir();
    const file = join(dir, 'rcpt');
    for (const bad of ['age1short', `${RCPT}; rm -rf /`, `AGE1${'q'.repeat(58)}`, '-o /etc/passwd', '']) {
      writeFileSync(file, bad);
      const logs: string[] = [];
      expect(backupRecipient({ MAXCOM_BACKUP_RECIPIENT_FILE: file }, (l) => logs.push(l))).toBeNull();
      expect(logs).toHaveLength(1);
    }
    writeFileSync(file, `  ${RCPT}\n`);
    expect(backupRecipient({ MAXCOM_BACKUP_RECIPIENT_FILE: file })).toBe(RCPT);
    expect(backupRecipient({ MAXCOM_BACKUP_RECIPIENT_FILE: join(dir, 'missing') })).toBeNull();
  });

  describe('fails closed without a valid recipient', () => {
    const seed = (db: DatabaseSync): string => emptyOld(db, NOW);
    const listing = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);

    it('missing recipient file: PruneBackupError, no file in the backups folder, no surau deleted', () => {
      delete process.env.MAXCOM_PRUNE_PLAIN_BACKUP;
      const db = openDb(':memory:');
      const id = seed(db);
      const dir = join(tmpDir(), 'backups');
      const env = { MAXCOM_BACKUP_RECIPIENT_FILE: join(tmpDir(), 'nope') };
      expect(() => pruneEmptySuraus(db, { now: NOW, olderThanMs: DAY, apply: true, backupDir: dir, backup: { env } })).toThrow(PruneBackupError);
      expect(() => pruneEmptySuraus(db, { now: NOW, olderThanMs: DAY, apply: true, backupDir: dir, backup: { env } })).toThrow(/tiada atau tidak boleh dibaca/);
      expect(listing(dir)).toEqual([]);
      expect(getSurau(db, id)).toBeDefined();
    });

    it('invalid recipient content: the same, and the message names the cause', () => {
      delete process.env.MAXCOM_PRUNE_PLAIN_BACKUP;
      const db = openDb(':memory:');
      const id = seed(db);
      const dir = join(tmpDir(), 'backups');
      const file = join(tmpDir(), 'rcpt');
      writeFileSync(file, 'garbage');
      const env = { MAXCOM_BACKUP_RECIPIENT_FILE: file };
      expect(() => pruneEmptySuraus(db, { now: NOW, olderThanMs: DAY, apply: true, backupDir: dir, backup: { env } })).toThrow(PruneBackupError);
      expect(() => backupBeforePrune(db, dir, NOW, { env })).toThrow(/bukan kunci awam age yang sah/);
      expect(listing(dir)).toEqual([]);
      expect(getSurau(db, id)).toBeDefined();
    });

    it('an explicit recipient: null without allowPlain throws too', () => {
      delete process.env.MAXCOM_PRUNE_PLAIN_BACKUP;
      const db = openDb(':memory:');
      const dir = join(tmpDir(), 'backups');
      expect(() => backupBeforePrune(db, dir, NOW, { recipient: null })).toThrow(/MAXCOM_PRUNE_PLAIN_BACKUP=1/);
      expect(listing(dir)).toEqual([]);
    });

    it('MAXCOM_PRUNE_PLAIN_BACKUP=1 allows a plain copy and logs that it is not encrypted; any other value does not', () => {
      const db = openDb(':memory:');
      const dir = join(tmpDir(), 'backups');
      const logs: string[] = [];
      const p = backupBeforePrune(db, dir, NOW, { env: { MAXCOM_PRUNE_PLAIN_BACKUP: '1' }, log: (l) => logs.push(l) });
      expect(p).toMatch(/\.db$/);
      expect(readdirSync(dir)).toHaveLength(1);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('tidak disulitkan');
      expect(() => backupBeforePrune(db, join(tmpDir(), 'b2'), NOW, { env: { MAXCOM_PRUNE_PLAIN_BACKUP: 'true' } })).toThrow(/tidak dibenarkan/);
    });

    it('the allowPlain option allows a plain copy too (also with recipient: null)', () => {
      delete process.env.MAXCOM_PRUNE_PLAIN_BACKUP;
      const db = openDb(':memory:');
      const dir = join(tmpDir(), 'backups');
      const logs: string[] = [];
      const p = backupBeforePrune(db, dir, NOW, { allowPlain: true, recipient: null, log: (l) => logs.push(l) });
      expect(p).toMatch(/\.db$/);
      expect(logs[0]).toContain('tidak disulitkan');
    });

    it('a dry run never throws for a missing recipient and writes nothing', () => {
      delete process.env.MAXCOM_PRUNE_PLAIN_BACKUP;
      const db = openDb(':memory:');
      const id = seed(db);
      const dir = join(tmpDir(), 'backups');
      const r = pruneEmptySuraus(db, { now: NOW, olderThanMs: DAY, backupDir: dir });
      expect(r.candidates.map((c) => c.id)).toEqual([id]);
      expect(r.deleted).toEqual([]);
      expect(existsSync(dir)).toBe(false);
    });
  });

  describe('a plain copy that cannot be removed is never silent', () => {
    const failPlainRemoval = (path: string): void => {
      if (path.endsWith('.db')) throw new Error('EBUSY');
      rmSync(path, { force: true });
    };

    it('encryption ok, plain removal fails: the .age is returned and one loud line names the plain file', () => {
      const db = openDb(':memory:');
      const dir = join(tmpDir(), 'backups');
      const logs: string[] = [];
      const p = backupBeforePrune(db, dir, NOW, { recipient: RCPT, encrypt: fakeEncrypt, remove: failPlainRemoval, log: (l) => logs.push(l) });
      expect(p).toMatch(/\.db\.age$/);
      expect(logs.some((l) => l.includes('AMARAN') && l.includes('salinan biasa'))).toBe(true);
      expect(readdirSync(dir).filter((f) => f.endsWith('.db'))).toHaveLength(1);
    });

    it('encryption fails and the plain copy cannot be removed: the thrown message says the plain copy is still there', () => {
      const db = openDb(':memory:');
      const dir = join(tmpDir(), 'backups');
      expect(() => backupBeforePrune(db, dir, NOW, { recipient: RCPT, encrypt: failing, remove: failPlainRemoval })).toThrow(/AMARAN.*masih ada/);
    });
  });

  it('retention counts plain and encrypted copies together (newest 7 by name), and only the exact pattern', () => {
    const db = openDb(':memory:');
    const dir = join(tmpDir(), 'backups');
    mkdirSync(dir, { recursive: true });
    const other = join(dir, 'pre-prune-keep-me.db.age');
    writeFileSync(other, 'x');
    const mk = (i: number, ext: string): string => `pre-prune-2026-11-0${i}T10-00-00-000Z-aaaaa${i}${ext}`;
    for (let i = 1; i <= 5; i++) writeFileSync(join(dir, mk(i, '.db.age')), 'x');
    for (let i = 6; i <= 9; i++) writeFileSync(join(dir, mk(i, '.db')), 'x');
    backupBeforePrune(db, dir, NOW, { recipient: RCPT, encrypt: fakeEncrypt });
    const kept = readdirSync(dir).filter((f) => f !== 'pre-prune-keep-me.db.age');
    expect(kept).toHaveLength(7);
    expect(kept.some((f) => /2026-11-0[123]T/.test(f))).toBe(false);
    expect(kept.some((f) => f.includes('2026-11-09T'))).toBe(true);
    expect(kept.filter((f) => f.endsWith('.db'))).toEqual([]); // the kept plain ones were encrypted
    expect(existsSync(other)).toBe(true);
  });

  it('older plain copies still in the folder are encrypted too; one that fails is kept, logged, and does not abort', () => {
    const db = openDb(':memory:');
    const dir = join(tmpDir(), 'backups');
    mkdirSync(dir, { recursive: true });
    const ok = 'pre-prune-2026-11-01T10-00-00-000Z-aaaaa1.db';
    const bad = 'pre-prune-2026-11-02T10-00-00-000Z-bbbbb2.db';
    writeFileSync(join(dir, ok), 'old-ok');
    writeFileSync(join(dir, bad), 'old-bad');
    const logs: string[] = [];
    const enc = (a: string, o: string): void => {
      if (a.endsWith('bbbbb2.db')) failing();
      fakeEncrypt(a, o);
    };
    const p = backupBeforePrune(db, dir, NOW, { recipient: RCPT, encrypt: enc, log: (l) => logs.push(l) });
    expect(p).toMatch(/\.db\.age$/);
    const files = readdirSync(dir);
    expect(files).toContain(`${ok}.age`);
    expect(files).not.toContain(ok);
    expect(files).toContain(bad);
    expect(files).not.toContain(`${bad}.age`);
    expect(readFileSync(join(dir, `${ok}.age`), 'utf8')).toBe('AGE:old-ok');
    expect(logs.some((l) => l.includes(bad))).toBe(true);
  });

  it('the daily automatic prune logs a failed backup, deletes nothing and keeps running', async () => {
    const db = openDb(':memory:');
    const id = emptyOld(db, NOW);
    const logs: string[] = [];
    const dir = join(tmpDir(), 'backups');
    const stop = startAutoPrune({ db, now: () => NOW, days: 1, backupDir: dir, log: (l) => logs.push(l), firstDelayMs: 5, intervalMs: 30, backup: { recipient: RCPT, encrypt: failing } });
    cleanups.push(stop);
    await settle();
    await settle();
    expect(logs.filter((l) => l.includes('sandaran gagal')).length).toBeGreaterThanOrEqual(2);
    expect(logs.some((l) => l.includes('larian automatik gagal'))).toBe(false);
    expect(getSurau(db, id)).toBeDefined();
  });
});
