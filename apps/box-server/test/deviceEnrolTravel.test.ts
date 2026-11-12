import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeedEntry } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { approvePairing, beginPairing } from '../src/auth/pairing.ts';
import { createUser, revokeDeviceRow } from '../src/auth/users.ts';
import { openDb } from '../src/db.ts';
import { runCloudLink } from '../src/cli/cloudLink.ts';
import { canTravel } from '../src/sync/agent.ts';
import { applyFeedEntry } from '../src/sync/apply.ts';
import { readFeed, snapshot } from '../src/sync/feed.ts';
import { issueLinkCode } from '../src/sync/sites.ts';
import { loadSyncKey } from '../src/sync/syncKey.ts';
import { verifySiteEntry } from '../src/sync/verify.ts';
import { loginAs } from './authHelpers.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';
import { insertSite } from './support/sites.ts';
import { signOp } from './support/signOp.ts';

const NOW = new Date('2026-11-09T10:00:00.000Z');
const T0 = '2026-11-09T09:00:00.000Z';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function newKey(): Promise<{ kty: string; crv: string; x: string; y: string }> {
  const k = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const j = await webcrypto.subtle.exportKey('jwk', k.publicKey);
  return { kty: String(j.kty), crv: String(j.crv), x: String(j.x), y: String(j.y) };
}

interface Pair {
  box: FastifyInstance;
  cloud: TestCloud;
  worker: FakeWorker;
  boxId: string;
}

/** A box linked to an in-process cloud whose Worker admin routes are served by the fake Worker. */
async function makePair(): Promise<Pair> {
  const boxDir = mkdtempSync(join(tmpdir(), 'surau-travelbox-'));
  let worker!: FakeWorker;
  const hook = { fetch: (undefined as unknown) as typeof fetch };
  const box = buildApp(join(boxDir, 'box.db'), {
    dataDir: boxDir,
    sync: { fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => hook.fetch(i, n)) as typeof fetch, sleep: async () => undefined },
  });
  const boxId = box.surau.boxId;
  const cloud = buildCloud(boxId, {
    workerAdmin: { url: 'https://worker.test', token: 'test-admin-token', fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => worker.fetch(i, n)) as typeof fetch },
    workerOutbox: { auto: false },
  });
  worker = new FakeWorker(cloud.fetch);
  hook.fetch = worker.fetch;
  cleanups.push(async () => {
    await box.close().catch(() => undefined);
    await cloud.close();
    rmSync(boxDir, { recursive: true, force: true });
  });
  const { code } = issueLinkCode({ db: cloud.app.surau.db, now: () => new Date() }, { boxId, name: 'Surau Ujian' });
  const lines: string[] = [];
  const exit = await runCloudLink(['--data', boxDir, '--db', join(boxDir, 'box.db'), 'link', CLOUD_URL, code], { out: (l) => lines.push(l), err: (l) => lines.push(l) }, worker.fetch);
  expect(exit).toBe(0);
  worker.setSecret(boxId, loadSyncKey(boxDir)!.wakeSecret);
  return { box, cloud, worker, boxId };
}

const changeRows = (app: FastifyInstance): number => Number(app.surau.db.prepare('SELECT COUNT(*) AS n FROM change_log').get()?.n ?? 0);

/** Challenge and unlock the device at `app`, signing with the device's key (no PIN: the cloud holds none for it). */
async function unlockAt(app: FastifyInstance, login: { deviceId: string; sign: (m: Uint8Array) => Promise<string> }): Promise<{ status: number; token?: string; body: string }> {
  const ip = '10.9.9.9';
  const ch = await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress: ip, payload: { deviceId: login.deviceId } });
  if (ch.statusCode !== 200) return { status: ch.statusCode, body: ch.body };
  const nonce = String(ch.json().nonce);
  const sig = await login.sign(new TextEncoder().encode(`surau-unlock\n${app.surau.boxId}\n${login.deviceId}\n${nonce}`));
  const un = await app.inject({ method: 'POST', url: '/api/auth/unlock', remoteAddress: ip, payload: { deviceId: login.deviceId, nonce, signature: sig } });
  return { status: un.statusCode, token: un.statusCode === 200 ? String(un.json().token) : undefined, body: un.body };
}

describe('a device enrolled at the box becomes known to the cloud', () => {
  it('travels by the real push path, unlocks at the cloud and a signed op is accepted there', async () => {
    const p = await makePair();
    const login = await loginAs(p.box, 'admin');
    const before = p.cloud.app.surau.db.prepare('SELECT COUNT(*) AS n FROM devices').get();
    expect(Number(before?.n)).toBe(0);
    // unknown to the cloud before the sync
    expect((await unlockAt(p.cloud.app, login)).status).not.toBe(200);

    await p.box.syncAgent!.runOnce();
    expect(p.box.syncAgent!.status()).toMatchObject({ lastError: null, refused: 0 });
    const onCloud = p.cloud.app.surau.db.prepare('SELECT id, user_id, platform, public_jwk, origin FROM devices WHERE id = ?').get(login.deviceId);
    expect(onCloud).toMatchObject({ id: login.deviceId, user_id: login.userId, platform: 'web', origin: `box:${p.boxId}` });
    const boxKey = p.box.surau.db.prepare('SELECT public_jwk FROM devices WHERE id = ?').get(login.deviceId)?.public_jwk;
    expect(onCloud?.public_jwk).toBe(boxKey);

    const un = await unlockAt(p.cloud.app, login);
    expect(un.status, un.body).toBe(200);
    const op = await signOp(login, p.boxId, { kind: 'content.put', entity: 'content:penceramah', entityId: 'pt1', payload: { name: 'Ustaz Perjalanan' } });
    const res = await p.cloud.app.inject({ method: 'POST', url: '/api/sync/ops', headers: { authorization: `Bearer ${un.token}` }, payload: { ops: [op] } });
    expect(res.json().results[0].status).toBe('applied');
  });

  it('reaches the Worker allowlist in the same transaction, and a revocation follows it', async () => {
    const p = await makePair();
    const login = await loginAs(p.box, 'admin');
    await p.box.syncAgent!.runOnce();
    await p.cloud.app.workerOutbox!.drain();
    const listed = p.worker.devices.get(login.deviceId);
    expect(listed).toBeDefined();
    expect(listed?.revoked).toBe(false);
    expect(Object.keys(listed!.jwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);

    revokeDeviceRow(p.box.surau.db, login.deviceId, 'user:test', new Date().toISOString());
    await p.box.syncAgent!.runOnce();
    await p.cloud.app.workerOutbox!.drain();
    expect(p.worker.devices.get(login.deviceId)?.revoked).toBe(true);
    expect(p.cloud.app.surau.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(login.deviceId)?.revoked_at).not.toBeNull();
    expect((await unlockAt(p.cloud.app, login)).status).not.toBe(200);
  });

  it('does not echo: the applied row never travels back and rounds do not grow either log', async () => {
    const p = await makePair();
    await loginAs(p.box, 'admin');
    await p.box.syncAgent!.runOnce();
    const c1 = changeRows(p.cloud.app);
    const b1 = changeRows(p.box);
    await p.box.syncAgent!.runOnce();
    await p.box.syncAgent!.runOnce();
    expect(changeRows(p.cloud.app)).toBe(c1);
    expect(changeRows(p.box)).toBe(b1);
    // the cloud's feed hands the box nothing of its own
    const feed = readFeed(p.cloud.app.surau.db, 0, 500, { users: true, devices: true, keys: true });
    expect(feed.entries.filter((e) => e.entity === 'device' && e.origin !== `box:${p.boxId}`)).toEqual([]);
  });

  it('a box never takes a device key from the cloud: a compromised cloud cannot plant a LAN login', async () => {
    const p = await makePair();
    const login = await loginAs(p.cloud.app, 'admin');
    await p.box.syncAgent!.runOnce();
    expect(p.box.surau.db.prepare('SELECT id FROM devices WHERE id = ?').get(login.deviceId)).toBeUndefined();
    // the refusal is the benign one: the box is not left reporting a sync problem
    expect(p.box.syncAgent!.status().lastError).toBeNull();
  });
});

describe('applying a device entry', () => {
  function fresh(): { db: DatabaseSync; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'surau-travel-'));
    const db = openDb(join(dir, 't.db'));
    cleanups.push(() => {
      try {
        db.close();
      } catch {
        /* closed */
      }
      rmSync(dir, { recursive: true, force: true });
    });
    return { db, dir };
  }
  const ctx = (dir: string) => ({ now: NOW, origin: 'box:b1', actor: 'user:x', dataDir: dir, acceptDeviceEnrolment: true });
  let n = 0;
  const entry = (id: string, after: unknown, over: Partial<FeedEntry> = {}): FeedEntry => ({
    seq: ++n,
    entity: 'device',
    entityId: id,
    rev: `${T0}|dev-${n}`,
    editedAt: T0,
    syncedAt: T0,
    actor: 'user:x',
    deviceId: null,
    origin: 'local',
    opId: null,
    after,
    ...over,
  });
  const enrolAfter = (id: string, userId: string, jwk: unknown) => ({ id, userId, name: 'Telefon', platform: 'android', revoked: false, publicJwk: jwk, enrolledAt: T0 });
  const deviceCount = (db: DatabaseSync): number => Number(db.prepare('SELECT COUNT(*) AS n FROM devices').get()?.n);

  it('enrols an unknown device for an active user, with the canonical key', async () => {
    const { db, dir } = fresh();
    const u = createUser(db, { name: 'Ajk', roles: ['ajk'] }, 'test');
    const jwk = await newKey();
    const r = applyFeedEntry(db, entry('d1', enrolAfter('d1', u.id, jwk)), ctx(dir));
    expect(r).toEqual({ status: 'applied', reason: null });
    const row = db.prepare('SELECT user_id, name, platform, public_jwk, enrolled_at, origin FROM devices WHERE id = ?').get('d1');
    expect(row).toMatchObject({ user_id: u.id, name: 'Telefon', platform: 'android', enrolled_at: T0, origin: 'box:b1' });
    expect(JSON.parse(String(row?.public_jwk))).toEqual({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y });
    // delivered again: a no-op, no new log row
    const logged = Number(db.prepare('SELECT COUNT(*) AS n FROM change_log').get()?.n);
    expect(applyFeedEntry(db, entry('d1', enrolAfter('d1', u.id, jwk), { rev: `${T0}|dev-again` }), ctx(dir)).status).toBe('duplicate');
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM change_log').get()?.n)).toBe(logged);
  });

  it('refuses a different key for an existing id (device_key_mismatch) and keeps the stored one', async () => {
    const { db, dir } = fresh();
    const u = createUser(db, { name: 'Ajk', roles: ['ajk'] }, 'test');
    const a = await newKey();
    const b = await newKey();
    applyFeedEntry(db, entry('d1', enrolAfter('d1', u.id, a)), ctx(dir));
    const r = applyFeedEntry(db, entry('d1', enrolAfter('d1', u.id, b), { rev: `${T0}|dev-b`, editedAt: '2026-11-09T09:30:00.000Z' }), ctx(dir));
    expect(r).toEqual({ status: 'refused', reason: 'device_key_mismatch' });
    expect(JSON.parse(String(db.prepare('SELECT public_jwk FROM devices WHERE id = ?').get('d1')?.public_jwk)).x).toBe(a.x);
    expect(db.prepare("SELECT detail FROM auth_log WHERE event = 'sync_refused' AND device_id = 'd1'").get()?.detail).toBe('device_key_mismatch');
  });

  it('a kiosk device (no key) refuses a key too', async () => {
    const { db, dir } = fresh();
    const u = createUser(db, { name: 'Ajk', roles: ['ajk'] }, 'test');
    db.prepare("INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at) VALUES ('k1', ?, 'Paparan', 'kiosk', NULL, ?)").run(u.id, T0);
    const r = applyFeedEntry(db, entry('k1', enrolAfter('k1', u.id, await newKey())), ctx(dir));
    expect(r).toEqual({ status: 'refused', reason: 'device_key_mismatch' });
    expect(db.prepare('SELECT public_jwk FROM devices WHERE id = ?').get('k1')?.public_jwk).toBeNull();
  });

  it('a revocation beats a late enrolment, in either arrival order', async () => {
    const { db, dir } = fresh();
    const u = createUser(db, { name: 'Ajk', roles: ['ajk'] }, 'test');
    const jwk = await newKey();
    // order 1: enrol, revoke, enrol again (late redelivery)
    expect(applyFeedEntry(db, entry('d1', enrolAfter('d1', u.id, jwk)), ctx(dir)).status).toBe('applied');
    expect(applyFeedEntry(db, entry('d1', { revoked: true }, { editedAt: '2026-11-09T09:10:00.000Z' }), ctx(dir)).status).toBe('applied');
    expect(db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get('d1')?.revoked_at).not.toBeNull();
    expect(applyFeedEntry(db, entry('d1', enrolAfter('d1', u.id, jwk), { rev: `${T0}|late` }), ctx(dir)).status).toBe('duplicate');
    expect(db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get('d1')?.revoked_at).not.toBeNull();
    // order 2: the revocation arrives first, the enrolment afterwards
    expect(applyFeedEntry(db, entry('d2', { revoked: true }, { editedAt: '2026-11-09T09:10:00.000Z' }), ctx(dir)).reason).toBe('device_unknown');
    expect(applyFeedEntry(db, entry('d2', enrolAfter('d2', u.id, jwk)), ctx(dir)).status).toBe('duplicate');
    expect(db.prepare('SELECT 1 AS x FROM devices WHERE id = ?').get('d2')).toBeUndefined();
    // an entry that says both leaves the device revoked
    expect(applyFeedEntry(db, entry('d3', { ...enrolAfter('d3', u.id, jwk), revoked: true }), ctx(dir)).status).toBe('applied');
    expect(db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get('d3')?.revoked_at).not.toBeNull();
  });

  it('refuses an enrolment for an unknown or inactive user and adds nothing', async () => {
    const { db, dir } = fresh();
    const jwk = await newKey();
    expect(applyFeedEntry(db, entry('d1', enrolAfter('d1', 'nobody', jwk)), ctx(dir)).status).toBe('refused');
    const u = createUser(db, { name: 'Ajk', roles: ['ajk'] }, 'test');
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(u.id);
    expect(applyFeedEntry(db, entry('d2', enrolAfter('d2', u.id, jwk)), ctx(dir)).status).toBe('refused');
    expect(deviceCount(db)).toBe(0);
    expect(db.prepare("SELECT detail FROM auth_log WHERE event = 'sync_refused' AND detail = 'enrol_user_unknown'").get()).toBeDefined();
  });
});

describe('what may travel', () => {
  const site = { boxId: 'b1', surauId: 'sdm' };
  const base = { seq: 1, entity: 'device', entityId: 'd1', rev: `${T0}|d`, editedAt: T0, syncedAt: T0, actor: 'user:x', deviceId: null, origin: 'local', opId: null };
  const good = { id: 'd1', userId: 'u1', name: 'T', platform: 'web', revoked: false, enrolledAt: T0 };

  it('verifySiteEntry accepts an enrolment and a revocation and refuses extras, bad keys and bad shapes', async () => {
    const jwk = await newKey();
    expect(verifySiteEntry(site, {}, { ...base, after: { ...good, publicJwk: jwk } }).ok).toBe(true);
    expect(verifySiteEntry(site, {}, { ...base, after: { revoked: true } }).ok).toBe(true);
    const bad = (after: unknown) => verifySiteEntry(site, {}, { ...base, after });
    expect(bad({ ...good, publicJwk: jwk, pinHash: 'x' })).toEqual({ ok: false, detail: 'bad_device' });
    expect(bad({ ...good, publicJwk: jwk, extra: 1 }).ok).toBe(false);
    expect(bad({ ...good, publicJwk: { ...jwk, d: 'secret' } }).ok).toBe(false);
    expect(bad({ ...good, publicJwk: { ...jwk, kty: 'RSA' } }).ok).toBe(false);
    expect(bad({ ...good, publicJwk: { ...jwk, x: 'short' } }).ok).toBe(false);
    expect(bad({ ...good, publicJwk: 'text' }).ok).toBe(false);
    expect(bad({ ...good, publicJwk: jwk, userId: undefined }).ok).toBe(false);
    expect(bad({ ...good, id: 'other', publicJwk: jwk }).ok).toBe(false);
    expect(bad({ ...good, platform: 'toaster', publicJwk: jwk }).ok).toBe(false);
    expect(bad(null).ok).toBe(false);
  });

  it('canTravel: an enrolment with a key and a revocation go up; a keyless row (a kiosk) and a bare name do not', async () => {
    const e = (after: unknown): FeedEntry => ({ ...base, after } as FeedEntry);
    expect(canTravel(e({ ...good, publicJwk: await newKey() }))).toBe(true);
    expect(canTravel(e({ id: 'd1', userId: 'u1', name: 'T', platform: 'web', revoked: true }))).toBe(true);
    expect(canTravel(e({ id: 'd1', userId: 'u1', name: 'Paparan', platform: 'kiosk', revoked: false }))).toBe(false);
    expect(canTravel(e({ name: 'only' }))).toBe(false);
    expect(canTravel(e(null))).toBe(false);
  });

  it('a kiosk device paired at the box never reaches the cloud', async () => {
    const p = await makePair();
    const admin = await loginAs(p.box, 'admin');
    const pair = beginPairing(p.box.surau.db, '10.1.1.1', new Date());
    approvePairing(p.box.surau.db, { code: pair.code }, admin.userId, 'user:test', new Date());
    await p.box.syncAgent!.runOnce();
    expect(p.cloud.app.surau.db.prepare("SELECT COUNT(*) AS n FROM devices WHERE platform = 'kiosk'").get()?.n).toBe(0);
    expect(p.box.syncAgent!.status()).toMatchObject({ lastError: null, refused: 0 });
  });
});

describe('keys are for linked sites only', () => {
  it('a site snapshot and feed carry the key; a user session snapshot, feed, device list and audit never do', async () => {
    const p = await makePair();
    const db = p.cloud.app.surau.db;
    const admin = await loginAs(p.cloud.app, 'admin');
    const site = insertSite(db, { boxId: 'other-box' });

    const siteSnap = await p.cloud.app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: site.headers });
    expect(siteSnap.statusCode).toBe(200);
    expect(siteSnap.body).toContain('"publicJwk"');
    expect(siteSnap.json().devices.find((d: { id: string }) => d.id === admin.deviceId).publicJwk).toHaveProperty('x');
    expect((await p.cloud.app.inject({ method: 'GET', url: '/api/sync/changes?since=0', headers: site.headers })).body).toContain('"publicJwk"');

    for (const url of ['/api/sync/snapshot', '/api/sync/changes?since=0', '/api/devices', '/api/audit', '/api/users']) {
      const res = await p.cloud.app.inject({ method: 'GET', url, headers: admin.headers });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain('"x":');
      expect(res.body, url).not.toContain('publicJwk');
    }
    // a kiosk row has no key to give even to a site
    const u = createUser(db, { name: 'Ajk', roles: ['ajk'] }, 'test');
    db.prepare("INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at) VALUES ('kk', ?, 'Paparan', 'kiosk', NULL, ?)").run(u.id, T0);
    const s = snapshot(db, { users: true, devices: true, keys: true }, { boxId: p.boxId, now: NOW });
    expect(s.devices?.find((d) => (d as { id: string }).id === 'kk')).not.toHaveProperty('publicJwk');
    // no scope given means no keys
    expect(JSON.stringify(snapshot(db, { users: true, devices: true }, { boxId: p.boxId, now: NOW }))).not.toContain('"x":');
  });

  it('a snapshot after 410 does not bring a cloud-enrolled device key to the box either', async () => {
    const p = await makePair();
    const login = await loginAs(p.cloud.app, 'admin');
    p.cloud.app.surau.db.prepare("INSERT INTO sync_state (key, value) VALUES ('log_floor', '100000')").run();
    await p.box.syncAgent!.runOnce();
    expect(p.box.syncAgent!.status().lastError).toBeNull();
    expect(p.box.surau.db.prepare('SELECT id FROM devices WHERE id = ?').get(login.deviceId)).toBeUndefined();
  });
});
