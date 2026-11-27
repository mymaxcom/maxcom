import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FeedEntry } from '@surau/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAssetPath, putAsset } from '../src/assets/store.ts';
import { applyFeedEntry } from '../src/sync/apply.ts';
import { buildResetState, createCloudResetLoop } from '../src/sync/resetFromBox.ts';
import { sleepOf } from '../src/sync/surauSleep.ts';
import { CLOUD_URL } from './support/fakeCloud.ts';
import { ensureSurau } from './support/surauRow.ts';
import { jpeg } from './support/jpeg.ts';
import { closeAllPairs, makeLinkedPair, until } from './support/linkedPair.ts';
import type { LinkedPair } from './support/linkedPair.ts';

/*
 * Multi-box 2B, block B4: the box sends its state to the cloud after a restore or an adopt, and starts syncing again
 * without a restart. The cloud is a real `buildApp` (role cloud), the box is linked to it by the real link steps; only
 * the network is a function. Contract: `docs/design/plans/2026-11-23-cloud-sleep-reset-contract.md`.
 */

const T0 = '2026-11-20T01:00:00.000Z';
const MARK = 'link-cloud-reset.json';
const LINK = 'L2026112300';
const SURAU = 'sdm';

let savedPlain: string | undefined;
beforeEach(() => {
  savedPlain = process.env.MAXCOM_PRUNE_PLAIN_BACKUP;
  process.env.MAXCOM_PRUNE_PLAIN_BACKUP = '1';
});
afterEach(async () => {
  await closeAllPairs();
  if (savedPlain === undefined) delete process.env.MAXCOM_PRUNE_PLAIN_BACKUP;
  else process.env.MAXCOM_PRUNE_PLAIN_BACKUP = savedPlain;
});

type Rec = Record<string, unknown>;

function entry(entity: string, entityId: string, after: unknown, extra: Rec = {}): FeedEntry {
  return { seq: 1, entity, entityId, rev: `${T0}|local`, editedAt: T0, syncedAt: T0, actor: 'user:x', deviceId: null, origin: 'local', opId: null, after, ...extra } as FeedEntry;
}

/** Put entries on a database the way the sync puts a pulled feed (so the rows are real rows). */
function seed(db: DatabaseSync, dataDir: string, entries: FeedEntry[], o: { role: 'box' | 'cloud'; siteBoxId?: string } = { role: 'box' }): void {
  for (const e of entries) {
    const r = applyFeedEntry(db, e, {
      now: new Date('2026-11-22T01:00:00.000Z'), origin: o.role === 'cloud' ? `box:${o.siteBoxId}` : 'local', actor: e.actor, dataDir,
      role: o.role, surauId: SURAU, acceptDeviceEnrolment: e.entity === 'device', ...(o.siteBoxId ? { siteBoxId: o.siteBoxId } : {}),
    });
    if (r.status !== 'applied') throw new Error(`seed ${e.entity} ${e.entityId}: ${r.status} ${r.reason}`);
  }
}

const key = (): { kty: 'EC'; crv: 'P-256'; x: string; y: string } => {
  const j = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  return { kty: 'EC', crv: 'P-256', x: String(j.x), y: String(j.y) };
};

interface Seeded {
  posterAsset: string;
}

/** What a restored box holds: content with a picture, people, a phone, finance, and one stale thing the cloud still has. */
function seedBox(p: LinkedPair): Seeded {
  const db = p.box.surau.db;
  const posterAsset = putAsset(db, p.boxDir, jpeg(2000), 'image/jpeg', 'test').id;
  seed(db, p.boxDir, [
    entry('content:penceramah', 'p1', { name: 'Ustaz Ahmad' }),
    entry('content:poster', 'po1', { title: 'Majlis Maulidur Rasul', assetId: posterAsset, days: ['umum'], order: 1 }),
    entry('user', 'u1', { name: 'Pak Imam', roles: ['admin'], active: true, phone: '+60 12-000 0001' }),
    entry('user', 'u2', { name: 'Cik Bendahari', roles: ['treasurer'], active: true }),
    entry('device', 'd1', { id: 'd1', userId: 'u1', name: 'Telefon Dewan Utama', platform: 'android', publicJwk: key(), enrolledAt: T0 }),
    entry('finance:fund', 'f1', { name: 'Tabung Am', public: true, sortOrder: 1 }),
    entry('finance:perihal', 'pi1', { direction: 'in', label: 'Derma', sortOrder: 1 }),
    entry('finance:entry', 'e1', { id: 'e1', kind: 'in', entryDate: '2026-11-08', fundId: 'f1', perihalId: 'pi1', amountSen: 5000, method: 'bank', reference: 'FPX99', refNo: null, createdBy: 'u2', editedAt: T0 }),
  ]);
  return { posterAsset };
}

/** The cloud as it was before the restore: an item and a person the restored box no longer has. */
function seedStaleCloud(p: LinkedPair): void {
  seed(p.cloud.app.surau.db, p.cloud.dir, [
    entry('content:penceramah', 'old1', { name: 'Ustaz Lama' }),
    entry('user', 'ustale', { name: 'Orang Lama', roles: ['admin'], active: true }),
  ], { role: 'cloud', siteBoxId: p.boxId });
}

const ids = (db: DatabaseSync, sql: string, ...a: string[]): string[] => db.prepare(sql).all(...a).map((r) => String(r.id));
const one = (db: DatabaseSync, sql: string, ...a: string[]): Record<string, unknown> | undefined => db.prepare(sql).get(...a);
const stateOf = (db: DatabaseSync, k: string): string | null => {
  const r = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(k);
  return typeof r?.value === 'string' ? r.value : null;
};

function writeMark(dir: string, reason: 'restore' | 'adopt' = 'restore'): void {
  writeFileSync(join(dir, MARK), JSON.stringify({ v: 1, linkId: LINK, at: T0, reason }));
}

/** A loop on the pair's box with every wait skipped; `done` counts calls of `onDone`. */
function loopOf(p: LinkedPair): { loop: ReturnType<typeof createCloudResetLoop>; done: { n: number }; waits: number[] } {
  const done = { n: 0 };
  const waits: number[] = [];
  const loop = createCloudResetLoop({
    db: p.box.surau.db, dataDir: p.boxDir, boxId: p.boxId, now: () => new Date(), fetchImpl: p.wire,
    sleep: (ms) => { waits.push(ms); return new Promise((r) => setTimeout(r, 1)); }, initialDelayMs: 0, onDone: () => void (done.n += 1),
  });
  return { loop, done, waits };
}

const resetCalls = (p: LinkedPair): number => p.calls.filter((c) => c.path === '/api/sync/reset-from-box').length;

const json = (status: number, body: Rec, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// =====================================================================================================================
describe('the reset loop, in a running box', () => {
  it('resetLoopRemovesMarkAndStartsSync: the cloud copy equals the box, the files went up, the mark is gone and the agent syncs without a 410', async () => {
    const p = await makeLinkedPair();
    const s = seedBox(p);
    seedStaleCloud(p);
    writeMark(p.boxDir, 'adopt');
    const cdb = p.cloud.app.surau.db;
    // before the reset: the cloud holds the stale rows and not the box's
    expect(ids(cdb, "SELECT id FROM content_items WHERE surau_id = ? AND deleted_at IS NULL", SURAU)).toEqual(['old1']);

    const box = await p.reopen();
    // held: no agent while the mark is there (the reset runs first)
    expect(box.syncAgent).toBeNull();
    await box.ready();
    await until(() => expect(existsSync(join(p.boxDir, MARK))).toBe(false));
    await until(() => expect(box.syncAgent).not.toBeNull());

    // the cloud surau equals the box for the rows that travel
    expect(ids(cdb, 'SELECT id FROM content_items WHERE surau_id = ? AND deleted_at IS NULL ORDER BY id', SURAU)).toEqual(['p1', 'po1']);
    expect(ids(cdb, 'SELECT id FROM users WHERE surau_id = ? AND deleted_at IS NULL ORDER BY id', SURAU)).toEqual(['u1', 'u2']);
    expect(one(cdb, 'SELECT phone FROM users WHERE id = ?', 'u1')?.phone).toBe(one(box.surau.db, 'SELECT phone FROM users WHERE id = ?', 'u1')?.phone);
    expect(one(cdb, 'SELECT revoked_at FROM devices WHERE id = ?', 'd1')?.revoked_at).toBeNull();
    expect(ids(cdb, 'SELECT id FROM finance_entries WHERE surau_id = ?', SURAU)).toEqual(['e1']);
    expect(ids(cdb, 'SELECT id FROM finance_funds WHERE surau_id = ?', SURAU)).toEqual(['f1']);
    expect(Number(one(cdb, 'SELECT amount_sen AS n FROM finance_entries WHERE id = ?', 'e1')?.n)).toBe(5000);
    // the stale person is soft-deleted the way the feed deletes one
    expect(one(cdb, 'SELECT deleted_at FROM users WHERE id = ?', 'ustale')?.deleted_at).not.toBeNull();

    // the picture the cloud lacked was uploaded and the surau holds it
    expect(one(cdb, 'SELECT asset_id FROM surau_assets WHERE surau_id = ? AND asset_id = ?', SURAU, s.posterAsset)).toBeDefined();
    expect(getAssetPath(cdb, p.cloud.dir, s.posterAsset)).not.toBeNull();
    expect(p.calls.some((c) => c.method === 'PUT' && c.path === `/api/sync/assets/${s.posterAsset}` && c.status < 300)).toBe(true);

    // the cursors: the pull cursor is the answer's seq (the surau's log floor), the push cursor is the box's own head
    expect(stateOf(box.surau.db, 'last_pull_seq')).toBe(String(one(cdb, 'SELECT log_floor AS n FROM suraus WHERE id = ?', SURAU)?.n));
    expect(stateOf(box.surau.db, 'last_error')).toBeNull();
    expect(Number(one(cdb, 'SELECT COUNT(*) AS n FROM surau_resets WHERE surau_id = ? AND ok = 1', SURAU)?.n)).toBe(1);

    // the agent then runs a normal cycle: no 410, no error, nothing refused
    const before = p.calls.length;
    await box.syncAgent!.runOnce();
    const st = box.syncAgent!.status();
    expect(st.lastError).toBeNull();
    expect(st.refused).toBe(0);
    expect(p.calls.slice(before).filter((c) => c.status === 410)).toEqual([]);
    expect(p.calls.slice(before).some((c) => c.path === '/api/sync/changes' && c.status === 200)).toBe(true);
    // and the cloud copy still equals the box
    expect(ids(cdb, 'SELECT id FROM content_items WHERE surau_id = ? AND deleted_at IS NULL ORDER BY id', SURAU)).toEqual(['p1', 'po1']);
  });

  it('a box with a mark but no sync key owes the cloud nothing: the mark is dropped and no reset is sent', async () => {
    const p = await makeLinkedPair();
    writeMark(p.boxDir);
    await p.box.close();
    const { rmSync } = await import('node:fs');
    rmSync(join(p.boxDir, 'secret', 'sync.key'));
    const box = await p.reopen();
    await box.ready();
    await new Promise((r) => setTimeout(r, 60));
    expect(existsSync(join(p.boxDir, MARK))).toBe(false);
    expect(p.calls.some((c) => c.path === '/api/sync/reset-from-box')).toBe(false);
  });
});

// =====================================================================================================================
describe('the reset loop, step by step', () => {
  it('the mark stays and last_error says why when the cloud refuses for good: surau_asleep', async () => {
    const p = await makeLinkedPair();
    seedBox(p);
    writeMark(p.boxDir);
    // another box put the surau to sleep
    p.cloud.app.surau.db.prepare('UPDATE suraus SET asleep_at = ?, asleep_box = ? WHERE id = ?').run(T0, 'bbbbbbbbbbbbbbbb', SURAU);
    const { loop, done, waits } = loopOf(p);
    loop.start();
    await loop.finished();
    expect(resetCalls(p)).toBe(1);
    expect(p.calls.find((c) => c.path === '/api/sync/reset-from-box')?.status).toBe(409);
    expect(existsSync(join(p.boxDir, MARK))).toBe(true);
    expect(stateOf(p.box.surau.db, 'last_error')).toBe('cloud_not_equal:surau_asleep');
    expect(done.n).toBe(0);
    expect(waits).toEqual([]);
    expect(sleepOf(p.cloud.app.surau.db, SURAU)?.asleepBox).toBe('bbbbbbbbbbbbbbbb');
  });

  it('the mark stays and last_error says why: foreign_id (a person id the cloud holds under another surau)', async () => {
    const p = await makeLinkedPair();
    seedBox(p);
    writeMark(p.boxDir);
    // the cloud holds 'u1' under another surau
    ensureSurau(p.cloud.app.surau.db, 's9', 'Surau Lain');
    seed(p.cloud.app.surau.db, p.cloud.dir, [entry('user', 'u1', { name: 'Orang Lain', roles: ['admin'], active: true })], { role: 'cloud', siteBoxId: 'cccccccccccccccc' });
    p.cloud.app.surau.db.prepare("UPDATE users SET surau_id = 's9' WHERE id = 'u1'").run();
    const { loop, done } = loopOf(p);
    loop.start();
    await loop.finished();
    expect(p.calls.find((c) => c.path === '/api/sync/reset-from-box')?.status).toBe(409);
    expect(resetCalls(p)).toBe(1);
    expect(existsSync(join(p.boxDir, MARK))).toBe(true);
    expect(stateOf(p.box.surau.db, 'last_error')).toBe('cloud_not_equal:foreign_id');
    expect(done.n).toBe(0);
    // the cloud kept its rows (a refused reset changes nothing)
    expect(one(p.cloud.app.surau.db, "SELECT surau_id FROM users WHERE id = 'u1'")?.surau_id).toBe('s9');
  });

  it.each([
    ['bad_state', 400],
    ['forbidden', 403],
  ])('the mark stays and last_error says why: %s (no retry)', async (code, status) => {
    const p = await makeLinkedPair();
    seedBox(p);
    writeMark(p.boxDir);
    p.intercept.fn = (_m, path) => (path === '/api/sync/reset-from-box' ? json(status, { errors: [code], code, detail: 'entries[0]:bad_shape' }) : undefined);
    const { loop, done, waits } = loopOf(p);
    loop.start();
    await loop.finished();
    expect(resetCalls(p)).toBe(1);
    expect(existsSync(join(p.boxDir, MARK))).toBe(true);
    expect(stateOf(p.box.surau.db, 'last_error')).toBe(`cloud_not_equal:${code}`);
    expect(done.n).toBe(0);
    expect(waits).toEqual([]);
  });

  it('5xx backs off 1 then 5 minutes, then the reset goes through; the state is rebuilt for each try', async () => {
    const p = await makeLinkedPair();
    seedBox(p);
    writeMark(p.boxDir);
    p.intercept.fn = (_m, path, n) => (path === '/api/sync/reset-from-box' && n <= 2 ? json(503, { errors: ['backup_unavailable'], code: 'backup_unavailable' }) : undefined);
    const { loop, done, waits } = loopOf(p);
    loop.start();
    await loop.finished();
    expect(waits).toEqual([60_000, 300_000]);
    expect(resetCalls(p)).toBe(3);
    expect(done.n).toBe(1);
    expect(existsSync(join(p.boxDir, MARK))).toBe(false);
    expect(ids(p.cloud.app.surau.db, 'SELECT id FROM content_items WHERE surau_id = ? AND deleted_at IS NULL ORDER BY id', SURAU)).toEqual(['p1', 'po1']);
  });

  it('a network fault and then 15 and 60 minute waits; the wait stays at 60', async () => {
    const p = await makeLinkedPair();
    seedBox(p);
    writeMark(p.boxDir);
    let tries = 0;
    p.intercept.fn = (_m, path) => {
      if (path !== '/api/sync/reset-from-box' || tries >= 5) return undefined;
      tries += 1;
      if (tries === 1) throw new Error('down');
      return json(500, { errors: ['x'] });
    };
    const { loop, done, waits } = loopOf(p);
    loop.start();
    await loop.finished();
    expect(waits).toEqual([60_000, 300_000, 900_000, 3_600_000, 3_600_000]);
    expect(done.n).toBe(1);
  });

  it('429 reset_limit waits a day, then tries again', async () => {
    const p = await makeLinkedPair();
    seedBox(p);
    writeMark(p.boxDir);
    p.intercept.fn = (_m, path, n) => (path === '/api/sync/reset-from-box' && n === 1 ? json(429, { errors: ['reset_limit'], code: 'reset_limit' }) : undefined);
    const { loop, done, waits } = loopOf(p);
    loop.start();
    await loop.finished();
    expect(waits).toEqual([24 * 3_600_000]);
    expect(done.n).toBe(1);
  });

  it('503 waking: the box wakes the cloud through the Worker and tries again after Retry-After', async () => {
    const p = await makeLinkedPair();
    seedBox(p);
    writeMark(p.boxDir);
    p.intercept.fn = (_m, path, n) => (path === '/api/sync/reset-from-box' && n === 1 ? json(503, { state: 'waking' }, { 'retry-after': '3' }) : undefined);
    const { loop, done, waits } = loopOf(p);
    loop.start();
    await loop.finished();
    expect(waits).toEqual([3000]);
    expect(p.worker.wakes).toBeGreaterThan(0);
    expect(done.n).toBe(1);
  });

  it('a file the cloud refuses does not hold the rest back; a 5xx on a file is tried again without a second reset', async () => {
    const p = await makeLinkedPair();
    const s = seedBox(p);
    writeMark(p.boxDir);
    p.intercept.fn = (_m, path, n) => (path === `/api/sync/assets/${s.posterAsset}` && n === 1 ? json(502, { errors: ['x'] }) : undefined);
    const { loop, done, waits } = loopOf(p);
    loop.start();
    await loop.finished();
    expect(resetCalls(p)).toBe(1);
    expect(waits).toEqual([60_000]);
    expect(p.calls.filter((c) => c.method === 'PUT' && c.path === `/api/sync/assets/${s.posterAsset}`).map((c) => c.status)).toEqual([502, 201]);
    expect(done.n).toBe(1);
    expect(existsSync(join(p.boxDir, MARK))).toBe(false);
  });

  it('stop() ends a loop that is waiting; the mark stays', async () => {
    const p = await makeLinkedPair();
    seedBox(p);
    writeMark(p.boxDir);
    p.intercept.fn = (_m, path) => (path === '/api/sync/reset-from-box' ? json(500, { errors: ['x'] }) : undefined);
    const done = { n: 0 };
    const loop = createCloudResetLoop({ db: p.box.surau.db, dataDir: p.boxDir, boxId: p.boxId, now: () => new Date(), fetchImpl: p.wire, initialDelayMs: 0, onDone: () => void (done.n += 1) });
    loop.start();
    await until(() => expect(resetCalls(p)).toBe(1));
    loop.stop();
    await loop.finished();
    expect(done.n).toBe(0);
    expect(existsSync(join(p.boxDir, MARK))).toBe(true);
  });

  it('a mark that cannot be read, or one with a bad link id, sends nothing', async () => {
    const p = await makeLinkedPair();
    seedBox(p);
    writeFileSync(join(p.boxDir, MARK), JSON.stringify({ v: 1, linkId: '../x', at: T0, reason: 'restore' }));
    const { loop, done } = loopOf(p);
    loop.start();
    await loop.finished();
    expect(resetCalls(p)).toBe(0);
    expect(done.n).toBe(0);
    expect(existsSync(join(p.boxDir, MARK))).toBe(true);
  });
});

// =====================================================================================================================
describe('the state', () => {
  it('a box with a Pentadbir MAXCOM person builds a state without it (and without its phone), and the cloud takes the state', async () => {
    const p = await makeLinkedPair();
    seedBox(p);
    const db = p.box.surau.db;
    seed(db, p.boxDir, [
      entry('user', 'star1', { name: 'Pentadbir MAXCOM', roles: ['superadmin'], active: true }),
      entry('device', 'dstar', { id: 'dstar', userId: 'u1', name: 'Telefon Operator', platform: 'android', publicJwk: key(), enrolledAt: T0 }),
    ]);
    db.prepare("UPDATE users SET surau_id = '*' WHERE id = 'star1'").run();
    db.prepare("UPDATE devices SET surau_id = '*', user_id = 'star1' WHERE id = 'dstar'").run();
    // an operator role on a person of the surau is never sent either
    seed(db, p.boxDir, [entry('user', 'sup1', { name: 'Sokongan', roles: ['support'], active: true })]);

    const state = buildResetState(db, p.boxId);
    const names = state.entries.map((e) => `${e.entity}:${e.entityId}`);
    expect(names).not.toContain('user:star1');
    expect(names).not.toContain('device:dstar');
    expect(names).not.toContain('user:sup1');
    expect(names).toEqual(expect.arrayContaining(['user:u1', 'user:u2', 'device:d1', 'content:penceramah:p1'.replace('penceramah:p1', 'penceramah:p1'), 'finance:entry:e1']));
    // the shape the cloud's strict parse wants
    for (const e of state.entries) {
      expect(e.origin).toBe('local');
      expect(e.opId).toBeNull();
      expect(typeof e.seq).toBe('number');
      expect(typeof e.syncedAt).toBe('string');
      expect(e.actor).toMatch(/^[A-Za-z0-9:_@.|-]{1,120}$/);
    }
    expect(new Set(state.entries.map((e) => `${e.entity}\u0000${e.entityId}`)).size).toBe(state.entries.length);
    expect(state.entries.some((e) => e.entity === 'settings' && e.entityId === 'appLock')).toBe(false);
    const u1 = state.entries.find((e) => e.entity === 'user' && e.entityId === 'u1')!;
    expect(u1.after).toMatchObject({ name: 'Pak Imam', roles: ['admin'], active: true });
    // the real rev and edit time of the row travel
    expect(u1.rev).toBe(String(one(db, "SELECT rev FROM users WHERE id = 'u1'")?.rev));
    expect(state.assets).toEqual([String(one(db, "SELECT id FROM assets LIMIT 1")?.id)]);

    // and the cloud accepts it whole
    writeMark(p.boxDir);
    const { loop, done } = loopOf(p);
    loop.start();
    await loop.finished();
    expect(done.n).toBe(1);
    expect(one(p.cloud.app.surau.db, "SELECT id FROM users WHERE id = 'star1'")).toBeUndefined();
    expect(one(p.cloud.app.surau.db, "SELECT id FROM devices WHERE id = 'dstar'")).toBeUndefined();
  });

  it('a video asset is never listed, a settings feature this build does not know is not sent, and a deleted item is absent', async () => {
    const p = await makeLinkedPair();
    const db = p.box.surau.db;
    const video = 'c'.repeat(64);
    db.prepare("INSERT INTO assets (id, surau_id, mime, bytes, created_at, created_by) VALUES (?, 'sdm', 'video/mp4', 10, ?, 'test')").run(video, T0);
    seed(db, p.boxDir, [entry('content:penceramah', 'p9', { name: 'Ustaz Hapus' })]);
    db.prepare("UPDATE content_items SET deleted_at = ? WHERE id = 'p9'").run(T0);
    db.prepare("INSERT INTO settings (surau_id, feature, json, updated_at, updated_by) VALUES ('sdm', 'tidakWujud', '{}', ?, 'x')").run(T0);
    const state = buildResetState(db, p.boxId);
    expect(state.entries.find((e) => e.entityId === 'p9')).toBeUndefined();
    expect(state.entries.find((e) => e.entity === 'settings' && e.entityId === 'tidakWujud')).toBeUndefined();
    expect(state.assets).not.toContain(video);
  });
});

// keep the unused import of the cloud url honest: the pair is linked to it
void CLOUD_URL;

// =====================================================================================================================
describe('the agent and a sleeping surau', () => {
  it('a 409 surau_asleep stops the agent: last_error says so, no retry is scheduled, and a later run sends nothing', async () => {
    const p = await makeLinkedPair();
    const agent = p.box.syncAgent!;
    seed(p.box.surau.db, p.boxDir, [entry('content:penceramah', 'p5', { name: 'Ustaz Baru' })]);
    p.cloud.app.surau.db.prepare('UPDATE suraus SET asleep_at = ?, asleep_box = ? WHERE id = ?').run(T0, 'bbbbbbbbbbbbbbbb', SURAU);
    await agent.runOnce();
    expect(agent.status().lastError).toBe('surau_asleep');
    expect(agent.nextDelayMs).toBeNull();
    const before = p.calls.length;
    await agent.runOnce();
    expect(p.calls.length).toBe(before);
    expect(agent.status().lastError).toBe('surau_asleep');
  });
});
