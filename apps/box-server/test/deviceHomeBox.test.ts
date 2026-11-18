/*
 * Plan 14 Task 7: signatures against the device's own box. `unlock` and `verifyDeviceOp` verify against the box the
 * device enrolled at (`devices.box_id`), not against one server id. On the cloud that box must be a `sites` row of
 * the device's surau; NULL falls back to the server's own id.
 *
 * Assumptions for the implementer
 *  1. Rig: a cloud-role app with NO `boxId` option (so no SURAU_BOX_ID): its own id is the random id of its data dir.
 *     Surau 'surau-a' with site BOX_A, surau 'surau-b' with site BOX_B (`insertSite`). Neither box id equals the
 *     cloud's own id, so a check that still uses the single server id fails for the right reason.
 *  2. "A phone enrolled at A" is made the real way a box-enrolled phone reaches the cloud: site A pushes a `device`
 *     feed entry (the shape a 2026.11.4 box sends: no `boxId` key in `after`) through `/api/sync/ops`, for a user
 *     of surau a made with `createUser`. The cloud stamps `devices.box_id` = the sending site's box id. The stamp
 *     comes from the site, never from the entry.
 *  3. `after.boxId` is an additive key a new box sends up. The cloud accepts it when it equals the sending site's
 *     box id (still applied, box_id = that site). When it names ANOTHER box, the entry is either refused or applied
 *     with box_id = the sending site; the device must never end up homed at the foreign box. The test accepts both.
 *  4. Unlock failures: a signature that does not verify against the expected box (including one over the cloud's own
 *     id for a device homed at A, or over A for a device homed at B) is 401 with `auth_log` event 'unlock', ok = 0,
 *     detail 'bad_signature' (the existing code). A device whose `box_id` is not a `sites` row of the device's own
 *     surau (another surau's box, or no box at all) cannot unlock at all, whatever it signs: 401, detail
 *     'box_mismatch', no session row. The same device's ops are refused with `sync_refused` detail 'box_mismatch'
 *     (the existing code for an op naming the wrong box), answer reason 'invalid', nothing written.
 *  5. `box_mismatch` is used for BOTH "expected box is null" cases (foreign surau, unknown box). A revoked site is
 *     still a `sites` row of the surau, so it is not tested as a mismatch.
 *  6. A device enrolled on a box gets `box_id` = that box's own id (plan section 3.1: "set on a box to its own id at
 *     enrolment"), and the box's feed entry for it carries `after.boxId` = the same id. A device enrolled directly
 *     on the cloud (loginAs on a cloud app) keeps `box_id` NULL, as does every ops device (Task 23).
 *  7. The cloud never adds `boxId` to a device entry in the feed it sends DOWN (an unmodified 2026.11.4 box refuses
 *     any unknown key), whatever the device's own `box_id`. The test compares the entry keys against the old key
 *     set rather than calling `verifySiteEntry`, which Task 7 itself widens.
 *  8. Unlock without a PIN: the test users hold only 'admin', so the app lock is off on the cloud (as
 *     deviceEnrolTravel.test.ts relies on) and the signature alone opens the session.
 *  9. SKIPPED, listed in the report: "an unmodified 2026.11.4 box pulls a device enrolment made on the cloud and
 *     applies it". The gate decision (p14-common.md) is that a box NEVER accepts a device key from the cloud
 *     (`acceptDeviceEnrolment`), so that behaviour must not exist. What is tested instead is the part Task 7 can
 *     break: the down entry carries no key an old box would refuse (7).
 */
import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant } from '@surau/core';
import type { OpResult } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { createUser } from '../src/auth/users.ts';
import { runCloudLink } from '../src/cli/cloudLink.ts';
import { canTravel } from '../src/sync/agent.ts';
import { readFeed } from '../src/sync/feed.ts';
import { issueLinkCode } from '../src/sync/sites.ts';
import { ensureSurau } from './support/surauRow.ts';
import { loadSyncKey } from '../src/sync/syncKey.ts';
import { loginAs, TEST_PIN } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';
import { signOp } from './support/signOp.ts';
import { insertSite } from './support/sites.ts';
import type { TestSite } from './support/sites.ts';

const A = 'surau-a';
const B = 'surau-b';
const BOX_A = 'a1a1a1a1a1a1a1a1';
const BOX_B = 'b2b2b2b2b2b2b2b2';
const BOX_A2 = 'a3a3a3a3a3a3a3a3';
const AT = klInstant('2026-11-03', '12:00');
const EDITED = '2026-11-03T03:00:00.000Z';
const OLD_DEVICE_KEYS = ['id', 'userId', 'name', 'platform', 'revoked', 'publicJwk', 'enrolledAt'];

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const clouds: TestCloud[] = [];
afterEach(async () => {
  for (const c of clouds.splice(0)) await c.close();
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const noNetwork = (async () => { throw new TypeError('network disabled in tests'); }) as unknown as typeof fetch;

interface Rig { app: FastifyInstance; sa: TestSite; sb: TestSite }

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'surau-homebox-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'c.db'), { dataDir: dir, role: 'cloud', now: () => AT, fetchImpl: noNetwork });
  apps.push(app);
  const ins = app.surau.db.prepare('INSERT INTO suraus (id, name, created_at, created_by) VALUES (?, ?, ?, ?)');
  ins.run(A, 'Surau A', AT.toISOString(), 'test');
  ins.run(B, 'Surau B', AT.toISOString(), 'test');
  const sa = insertSite(app.surau.db, { surauId: A, boxId: BOX_A });
  const sb = insertSite(app.surau.db, { surauId: B, boxId: BOX_B });
  expect(app.surau.boxId).not.toBe(BOX_A);
  expect(app.surau.boxId).not.toBe(BOX_B);
  return { app, sa, sb };
}

const one = (app: FastifyInstance, sql: string, ...args: Array<string | number>) => app.surau.db.prepare(sql).get(...args);
const count = (app: FastifyInstance, sql: string, ...args: Array<string | number>): number => Number(one(app, sql, ...args)?.n ?? 0);
const boxIdOfDevice = (app: FastifyInstance, id: string): unknown => one(app, 'SELECT box_id FROM devices WHERE id = ?', id)?.box_id;
const unlockFailures = (app: FastifyInstance, deviceId: string, detail: string): number =>
  count(app, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'unlock' AND ok = 0 AND device_id = ? AND detail = ?", deviceId, detail);
const sessionsOf = (app: FastifyInstance, deviceId: string): number => count(app, 'SELECT COUNT(*) AS n FROM sessions WHERE device_id = ?', deviceId);
const syncRefusals = (app: FastifyInstance, code: string): number =>
  count(app, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'sync_refused' AND detail LIKE ?", `%${code}%`);
const penc = (app: FastifyInstance, surau: string, id: string) =>
  one(app, "SELECT json FROM content_items WHERE surau_id = ? AND kind = 'penceramah' AND id = ?", surau, id);

// ---- a phone: a P-256 key we hold, enrolled by a site's feed entry ----

interface Phone {
  deviceId: string;
  userId: string;
  publicJwk: { kty: string; crv: string; x: string; y: string };
  sign: (message: Uint8Array) => Promise<string>;
}

let phoneN = 0;
async function newKey(): Promise<{ publicJwk: Phone['publicJwk']; sign: Phone['sign'] }> {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const j = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  return {
    publicJwk: { kty: String(j.kty), crv: String(j.crv), x: String(j.x), y: String(j.y) },
    sign: async (m) => Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Buffer.from(m))).toString('base64url'),
  };
}

let seqN = 0;
function deviceEntry(deviceId: string, after: Record<string, unknown>) {
  seqN += 1;
  return {
    seq: seqN, entity: 'device', entityId: deviceId, rev: `${EDITED}|local`, editedAt: EDITED, syncedAt: '2026-11-03T03:00:01.000Z',
    actor: 'local', deviceId: null, origin: 'local', opId: null, after,
  };
}

interface PushOut { applied: number; duplicate: number; superseded: number; refused: number; reasons: string[] }
async function push(app: FastifyInstance, site: TestSite, entries: unknown[]): Promise<PushOut> {
  const r = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: site.headers, payload: { entries } });
  expect(r.statusCode).toBe(200);
  return r.json() as PushOut;
}

/** A user of `surau` on the cloud, a fresh phone key, and the enrolment entry pushed by `site`. */
async function enrolAt(app: FastifyInstance, site: TestSite, extraAfter: Record<string, unknown> = {}): Promise<{ phone: Phone; out: PushOut }> {
  phoneN += 1;
  const user = createUser(app.surau.db, { name: `Pengguna ${phoneN}`, roles: ['admin'] }, 'test', site.surauId);
  const key = await newKey();
  const deviceId = `phone${phoneN}x${Math.random().toString(36).slice(2, 10)}`;
  const out = await push(app, site, [
    deviceEntry(deviceId, { id: deviceId, userId: user.id, name: 'Telefon', platform: 'android', publicJwk: key.publicJwk, enrolledAt: '2026-11-03T02:00:00.000Z', ...extraAfter }),
  ]);
  return { phone: { deviceId, userId: user.id, publicJwk: key.publicJwk, sign: key.sign }, out };
}

/** Challenge, then unlock signing `surau-unlock\n<signBox>\n<deviceId>\n<nonce>` with the phone's key. */
async function unlockSigning(app: FastifyInstance, p: { deviceId: string; sign: Phone['sign'] }, signBox: string): Promise<{ status: number; token: string | null; body: string }> {
  phoneN += 1;
  const ip = `10.7.${(phoneN >> 8) & 255}.${phoneN & 255}`;
  const ch = await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress: ip, payload: { deviceId: p.deviceId } });
  if (ch.statusCode !== 200) return { status: ch.statusCode, token: null, body: ch.body };
  const nonce = String(ch.json().nonce);
  const sig = await p.sign(new TextEncoder().encode(`surau-unlock\n${signBox}\n${p.deviceId}\n${nonce}`));
  const un = await app.inject({ method: 'POST', url: '/api/auth/unlock', remoteAddress: ip, payload: { deviceId: p.deviceId, nonce, signature: sig } });
  return { status: un.statusCode, token: un.statusCode === 200 ? String(un.json().token) : null, body: un.body };
}

/** One content op signed by the phone for `signBox`, sent with the phone's own session. */
async function sendOp(app: FastifyInstance, p: Phone, token: string, signBox: string, entityId: string): Promise<OpResult> {
  const login = { deviceId: p.deviceId, userId: p.userId, sign: p.sign } as unknown as Login;
  const op = await signOp(login, signBox, { kind: 'content.put', entity: 'content:penceramah', entityId, payload: { name: `Nama ${entityId}` } });
  const r = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: { authorization: `Bearer ${token}` }, payload: { ops: [op] } });
  expect(r.statusCode).toBe(200);
  return (r.json() as { results: OpResult[] }).results[0]!;
}

describe('the cloud stamps the home box when a device enrolment arrives from a site', () => {
  it('a phone pushed by site A is homed at A, one pushed by site B at B (stamped from the site, not the entry)', async () => {
    const { app, sa, sb } = rig();
    const a = await enrolAt(app, sa);
    const b = await enrolAt(app, sb);
    expect(a.out).toMatchObject({ applied: 1, refused: 0 });
    expect(b.out).toMatchObject({ applied: 1, refused: 0 });
    expect(one(app, 'SELECT surau_id FROM devices WHERE id = ?', a.phone.deviceId)?.surau_id).toBe(A);
    expect(boxIdOfDevice(app, a.phone.deviceId)).toBe(BOX_A);
    expect(boxIdOfDevice(app, b.phone.deviceId)).toBe(BOX_B);
  });

  it('an entry that carries after.boxId equal to the sending site is applied and homed at that site', async () => {
    const { app, sa } = rig();
    const a = await enrolAt(app, sa, { boxId: BOX_A });
    expect(a.out).toMatchObject({ applied: 1, refused: 0 });
    expect(boxIdOfDevice(app, a.phone.deviceId)).toBe(BOX_A);
  });

  it('an entry from site A that names box B in after.boxId never homes the device at B', async () => {
    const { app, sa } = rig();
    const a = await enrolAt(app, sa, { boxId: BOX_B });
    const row = one(app, 'SELECT box_id FROM devices WHERE id = ?', a.phone.deviceId);
    if (a.out.applied === 1) expect(row?.box_id).toBe(BOX_A);
    else expect(row).toBeUndefined();
    expect(row?.box_id).not.toBe(BOX_B);
    // and B's box cannot be used to sign for it
    expect((await unlockSigning(app, a.phone, BOX_B)).status).toBe(401);
  });
});

describe('unlock and op signatures are checked against the device\'s own box', () => {
  it('a phone enrolled at A unlocks signing A, and a signed op verifies and lands in surau a', async () => {
    const { app, sa } = rig();
    const { phone, out } = await enrolAt(app, sa);
    expect(out.applied).toBe(1);
    const un = await unlockSigning(app, phone, BOX_A);
    expect(un.status, un.body).toBe(200);
    expect(sessionsOf(app, phone.deviceId)).toBe(1);
    const res = await sendOp(app, phone, un.token!, BOX_A, 'p-from-a');
    expect(res.status).toBe('applied');
    expect(JSON.parse(String(penc(app, A, 'p-from-a')?.json)).name).toBe('Nama p-from-a');
    expect(penc(app, B, 'p-from-a')).toBeUndefined();
  });

  it('a phone enrolled at B works the same way, in surau b', async () => {
    const { app, sb } = rig();
    const { phone } = await enrolAt(app, sb);
    const un = await unlockSigning(app, phone, BOX_B);
    expect(un.status, un.body).toBe(200);
    expect((await sendOp(app, phone, un.token!, BOX_B, 'p-from-b')).status).toBe('applied');
    expect(JSON.parse(String(penc(app, B, 'p-from-b')?.json)).name).toBe('Nama p-from-b');
    expect(penc(app, A, 'p-from-b')).toBeUndefined();
  });

  it('the signature a phone of A would make is no good for a device of b: unlock over A fails for the B phone, B\'s own box works', async () => {
    const { app, sa, sb } = rig();
    const a = await enrolAt(app, sa);
    const b = await enrolAt(app, sb);
    const wrong = await unlockSigning(app, b.phone, BOX_A);
    expect(wrong.status).toBe(401);
    expect(sessionsOf(app, b.phone.deviceId)).toBe(0);
    expect(unlockFailures(app, b.phone.deviceId, 'bad_signature')).toBe(1);
    // the mirror image, and both still unlock with their own box afterwards
    expect((await unlockSigning(app, a.phone, BOX_B)).status).toBe(401);
    expect((await unlockSigning(app, b.phone, BOX_B)).status).toBe(200);
    expect((await unlockSigning(app, a.phone, BOX_A)).status).toBe(200);
  });

  it('an op of a B phone naming box A is refused box_mismatch and writes nothing; naming B it applies', async () => {
    const { app, sb } = rig();
    const { phone } = await enrolAt(app, sb);
    const un = await unlockSigning(app, phone, BOX_B);
    expect(un.status).toBe(200);
    const before = syncRefusals(app, 'box_mismatch');
    const bad = await sendOp(app, phone, un.token!, BOX_A, 'p-replay');
    expect(bad.status).toBe('refused');
    expect(syncRefusals(app, 'box_mismatch') - before).toBe(1);
    expect(penc(app, B, 'p-replay')).toBeUndefined();
    expect(penc(app, A, 'p-replay')).toBeUndefined();
    expect((await sendOp(app, phone, un.token!, BOX_B, 'p-ok')).status).toBe('applied');
  });

  it('the cloud\'s own id is not the home box of a phone enrolled at A: unlock and op signed with it fail', async () => {
    const { app, sa } = rig();
    const { phone } = await enrolAt(app, sa);
    const cloudId = app.surau.boxId;
    const un = await unlockSigning(app, phone, cloudId);
    expect(un.status).toBe(401);
    expect(unlockFailures(app, phone.deviceId, 'bad_signature')).toBe(1);
    expect(sessionsOf(app, phone.deviceId)).toBe(0);
    // an op signed with the cloud id, sent on a session opened the right way
    const ok = await unlockSigning(app, phone, BOX_A);
    const res = await sendOp(app, phone, ok.token!, cloudId, 'p-cloudid');
    expect(res.status).toBe('refused');
    expect(penc(app, A, 'p-cloudid')).toBeUndefined();
  });

  it('a device row whose box_id names a box of another surau cannot unlock: box_mismatch, logged, no session', async () => {
    const { app, sa } = rig();
    const { phone } = await enrolAt(app, sa);
    app.surau.db.prepare('UPDATE devices SET box_id = ? WHERE id = ?').run(BOX_B, phone.deviceId);
    // the phone signs with the box its row now names: still refused
    const un = await unlockSigning(app, phone, BOX_B);
    expect(un.status).toBe(401);
    expect(unlockFailures(app, phone.deviceId, 'box_mismatch')).toBe(1);
    expect(sessionsOf(app, phone.deviceId)).toBe(0);
    // signing its surau's real box does not help either
    expect((await unlockSigning(app, phone, BOX_A)).status).toBe(401);
    expect(sessionsOf(app, phone.deviceId)).toBe(0);
  });

  it('a device row whose box_id is no site at all cannot unlock; an op on an earlier session is refused box_mismatch', async () => {
    const { app, sa } = rig();
    const { phone } = await enrolAt(app, sa);
    const open = await unlockSigning(app, phone, BOX_A);
    expect(open.status).toBe(200);
    app.surau.db.prepare('UPDATE devices SET box_id = ? WHERE id = ?').run('f0f0f0f0f0f0f0f0', phone.deviceId);
    const un = await unlockSigning(app, phone, 'f0f0f0f0f0f0f0f0');
    expect(un.status).toBe(401);
    expect(unlockFailures(app, phone.deviceId, 'box_mismatch')).toBe(1);
    const before = syncRefusals(app, 'box_mismatch');
    const res = await sendOp(app, phone, open.token!, 'f0f0f0f0f0f0f0f0', 'p-ghost');
    expect(res.status).toBe('refused');
    expect(syncRefusals(app, 'box_mismatch') - before).toBe(1);
    expect(penc(app, A, 'p-ghost')).toBeUndefined();
  });

  it('a second box of the same surau is a valid home box: a device homed there unlocks (the box must be a site of the device\'s surau)', async () => {
    const { app, sa } = rig();
    insertSite(app.surau.db, { surauId: A, boxId: BOX_A2 });
    const { phone } = await enrolAt(app, sa);
    app.surau.db.prepare('UPDATE devices SET box_id = ? WHERE id = ?').run(BOX_A2, phone.deviceId);
    const un = await unlockSigning(app, phone, BOX_A2);
    expect(un.status, un.body).toBe(200);
    expect((await sendOp(app, phone, un.token!, BOX_A2, 'p-a2')).status).toBe('applied');
  });
});

describe('a device with no home box uses the server\'s own id', () => {
  it('a phone enrolled on the cloud itself (box_id NULL) unlocks and signs ops with the cloud id', async () => {
    const { app } = rig();
    const login = await loginAs(app, 'admin', TEST_PIN, A);
    expect(boxIdOfDevice(app, login.deviceId)).toBeNull();
    // loginAs already unlocked once with the cloud id; a second unlock and an op prove the same path
    const token = await login.relogin();
    const op = await signOp(login, app.surau.boxId, { kind: 'content.put', entity: 'content:penceramah', entityId: 'p-null', payload: { name: 'Awan' } });
    const r = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: { authorization: `Bearer ${token}` }, payload: { ops: [op] } });
    expect((r.json() as { results: OpResult[] }).results[0]!.status).toBe('applied');
    expect(JSON.parse(String(penc(app, A, 'p-null')?.json)).name).toBe('Awan');
  });

  it('that phone cannot sign for a site\'s box: A\'s id is refused for it', async () => {
    const { app } = rig();
    const login = await loginAs(app, 'admin', TEST_PIN, A);
    const un = await unlockSigning(app, login, BOX_A);
    expect(un.status).toBe(401);
    expect(unlockFailures(app, login.deviceId, 'bad_signature')).toBe(1);
    const token = await login.relogin();
    const op = await signOp(login, BOX_A, { kind: 'content.put', entity: 'content:penceramah', entityId: 'p-nullbad', payload: { name: 'Salah' } });
    const r = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: { authorization: `Bearer ${token}` }, payload: { ops: [op] } });
    expect((r.json() as { results: OpResult[] }).results[0]!.status).toBe('refused');
    expect(penc(app, A, 'p-nullbad')).toBeUndefined();
  });

  it('an ops device (the Task 23 path) keeps box_id NULL and verifies with the cloud id', async () => {
    const { app } = rig();
    const ops = await loginAs(app, 'superadmin');
    expect(one(app, 'SELECT ops FROM devices WHERE id = ?', ops.deviceId)?.ops).toBe(1);
    expect(boxIdOfDevice(app, ops.deviceId)).toBeNull();
    // a Pentadbir MAXCOM always needs its PIN, so the success path is loginAs's own PIN unlock (signed with the cloud id)
    expect((await ops.relogin()).length).toBeGreaterThan(10);
    expect((await unlockSigning(app, ops, BOX_A)).status).toBe(401);
    expect(unlockFailures(app, ops.deviceId, 'bad_signature')).toBe(1);
  });
});

describe('a box checks its own phones exactly as before', () => {
  function boxApp(): FastifyInstance {
    const dir = mkdtempSync(join(tmpdir(), 'surau-homebox-box-'));
    dirs.push(dir);
    const app = buildApp(join(dir, 'b.db'), { dataDir: dir });
    apps.push(app);
    return app;
  }

  it('a phone enrolled at a box is stamped with the box\'s own id, unlocks with it and nothing else', async () => {
    const box = boxApp();
    const login = await loginAs(box, 'admin');
    expect(boxIdOfDevice(box, login.deviceId)).toBe(box.surau.boxId);
    expect((await unlockSigning(box, login, box.surau.boxId)).status).toBe(200);
    const other = await unlockSigning(box, login, BOX_A);
    expect(other.status).toBe(401);
    expect(unlockFailures(box, login.deviceId, 'bad_signature')).toBe(1);
  });

  it('a device row on a box with box_id NULL (enrolled before Task 7) still verifies with the box id', async () => {
    const box = boxApp();
    const login = await loginAs(box, 'admin');
    box.surau.db.prepare('UPDATE devices SET box_id = NULL WHERE id = ?').run(login.deviceId);
    const un = await unlockSigning(box, login, box.surau.boxId);
    expect(un.status, un.body).toBe(200);
    const op = await signOp(login, box.surau.boxId, { kind: 'content.put', entity: 'content:penceramah', entityId: 'p-box', payload: { name: 'Kotak' } });
    const r = await box.inject({ method: 'POST', url: '/api/sync/ops', headers: { authorization: `Bearer ${un.token}` }, payload: { ops: [op] } });
    expect((r.json() as { results: OpResult[] }).results[0]!.status).toBe('applied');
  });

  it('the box feed entry for its phone carries after.boxId = the box id, and canTravel keeps the entry', async () => {
    const box = boxApp();
    const login = await loginAs(box, 'admin');
    const feed = readFeed(box.surau.db, 0, 500, { surauId: 'sdm', users: true, devices: true, keys: true, star: true, finance: true, financeWrite: true });
    const e = feed.entries.find((x) => x.entity === 'device' && x.entityId === login.deviceId && (x.after as Record<string, unknown> | null)?.publicJwk !== undefined);
    expect(e).toBeDefined();
    expect((e!.after as Record<string, unknown>).boxId).toBe(box.surau.boxId);
    expect(canTravel(e!)).toBe(true);
    // a revocation entry (no key) still travels and a device entry without boxId (older box) still travels
    expect(canTravel({ ...e!, after: { ...(e!.after as object), boxId: undefined } })).toBe(true);
  });
});

describe('the feed the cloud sends down adds no boxId to a device entry (an unmodified box refuses unknown keys)', () => {
  it('a cloud-enrolled device and a site-A-enrolled device reach a sibling site of surau a with only the old keys', async () => {
    const { app, sa } = rig();
    const sibling = insertSite(app.surau.db, { surauId: A, boxId: BOX_A2 });
    const cloudMade = await loginAs(app, 'admin', TEST_PIN, A);
    const siteMade = await enrolAt(app, sa);
    expect(siteMade.out.applied).toBe(1);
    expect(boxIdOfDevice(app, siteMade.phone.deviceId)).toBe(BOX_A); // the stamp exists, and still must not travel down
    const r = await app.inject({ method: 'GET', url: '/api/sync/changes?since=0', headers: sibling.headers });
    expect(r.statusCode).toBe(200);
    const entries = (r.json() as { entries: Array<{ entity: string; entityId: string; after: Record<string, unknown> | null }> }).entries;
    const devices = entries.filter((x) => x.entity === 'device');
    const ids = devices.map((x) => x.entityId);
    expect(ids).toContain(cloudMade.deviceId);
    expect(ids).toContain(siteMade.phone.deviceId);
    for (const d of devices) {
      for (const k of Object.keys(d.after ?? {})) expect(OLD_DEVICE_KEYS, `${d.entityId} key ${k}`).toContain(k);
    }
  });
});

// ---- the whole path with a real box and a cloud whose own id differs ----

describe('a phone enrolled at a real box unlocks at the cloud only with that box\'s id', () => {
  it('box enrols, the agent pushes, the cloud homes the device at the box; the box id opens it, the cloud id does not', async () => {
    const boxDir = mkdtempSync(join(tmpdir(), 'surau-homebox-pair-'));
    dirs.push(boxDir);
    let worker!: FakeWorker;
    const hook = { fetch: (undefined as unknown) as typeof fetch };
    const box = buildApp(join(boxDir, 'box.db'), {
      dataDir: boxDir,
      sync: { fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => hook.fetch(i, n)) as typeof fetch, sleep: async () => undefined },
    });
    apps.push(box);
    const boxId = box.surau.boxId;
    const cloud = buildCloud('c0c0c0c0c0c0c0c0', {
      workerAdmin: { url: 'https://worker.test', token: 'test-admin-token', fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => worker.fetch(i, n)) as typeof fetch },
      workerOutbox: { auto: false },
    });
    clouds.push(cloud);
    worker = new FakeWorker(cloud.fetch);
    hook.fetch = worker.fetch;
    const { code } = issueLinkCode({ db: cloud.app.surau.db, now: () => new Date() }, { boxId, name: 'Surau Ujian', target: { surauId: ensureSurau(cloud.app.surau.db) } });
    const lines: string[] = [];
    const exit = await runCloudLink(['--data', boxDir, '--db', join(boxDir, 'box.db'), 'link', CLOUD_URL, code], { out: (l) => lines.push(l), err: (l) => lines.push(l) }, worker.fetch);
    expect(exit, lines.join('\n')).toBe(0);
    worker.setSecret(boxId, loadSyncKey(boxDir)!.wakeSecret);
    expect(cloud.app.surau.boxId).toBe('c0c0c0c0c0c0c0c0');

    const login = await loginAs(box, 'admin');
    await box.syncAgent!.runOnce();
    expect(box.syncAgent!.status()).toMatchObject({ lastError: null, refused: 0 });
    expect(cloud.app.surau.db.prepare('SELECT box_id FROM devices WHERE id = ?').get(login.deviceId)?.box_id).toBe(boxId);

    const wrong = await unlockSigning(cloud.app, login, 'c0c0c0c0c0c0c0c0');
    expect(wrong.status).toBe(401);
    const right = await unlockSigning(cloud.app, login, boxId);
    expect(right.status, right.body).toBe(200);
    const op = await signOp(login, boxId, { kind: 'content.put', entity: 'content:penceramah', entityId: 'p-pair', payload: { name: 'Pasangan' } });
    const res = await cloud.app.inject({ method: 'POST', url: '/api/sync/ops', headers: { authorization: `Bearer ${right.token}` }, payload: { ops: [op] } });
    expect((res.json() as { results: OpResult[] }).results[0]!.status).toBe('applied');
  });
});
