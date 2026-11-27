import { webcrypto } from 'node:crypto';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { beginEnrolment } from '../src/auth/devices.ts';
import { approvePairing, beginPairing, buildKioskCookie, pollPairing } from '../src/auth/pairing.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { unlinkNotePresent, readUnlinkNote, sendUnlinkReport } from '../src/follow/unlinkNote.ts';
import { tellMasterLeft } from '../src/follow/revert.ts';
import { AT_UNLINK_KEEP_DAYS } from '../src/link/backupInfo.ts';
import { atUnlinkFolder, backupDirOf, readManifest, writeManifest } from '../src/link/setAside.ts';
import { signLink } from '../src/link/sign.ts';
import { ORDER_LABEL, clearKeptNote, orderAad, readKeptNote, sweepKeptNote, switchKept, writeKeptNote } from '../src/link/unlink.ts';
import type { KeptNote } from '../src/link/unlink.ts';
import { TokenStore } from '../src/live/youtube/tokenStore.ts';
import { issueRecoveryCode, verifyRecoveryCode } from '../src/setup/codes.ts';
import { loadIdentity } from '../src/setup/identity.ts';
import { openWithBoxKey, sealToBoxKey, sealedRe } from '../src/sync/boxSeal.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { createXWorld, outcomeOf, PIN, TEST_LEAVE_SECRET, unlockAgain, until } from './support/caseXWorld.ts';
import type { XBox, XWorld } from './support/caseXWorld.ts';

/**
 * "Putuskan pautan" (multi-box phase 2D, D1 + D2) through the real routes of real boxes in one process: the master's
 * unlink session, the signed order the follower takes, the follower's restore at the next start (a real restart of
 * every box), its join code, the follower's reports, and the follower's own leave (recovery code, no master).
 * Contract: `docs/design/plans/2026-11-23-unlink-contract.md`.
 *
 * Carry-on at the FOLLOWER ("Teruskan dengan data sekarang") is D3: those combinations stay `it.todo`.
 */

let w: XWorld;
beforeEach(() => {
  w = createXWorld();
});
afterEach(async () => {
  await w.close();
});

const F_PHONE = '+60120000021';
const YT = { refreshToken: 'refresh-token-of-g', accessToken: 'access-of-g', expiresAt: 4_102_444_800_000, channelId: 'UC-surau', channelTitle: 'Surau Al-Hidayah', scope: 'youtube', streamId: 'stream-1' };
const DAY = 86_400_000;
const SLOW = 120_000;

// ---------------------------------------------------------------- helpers

async function enrolAt(box: XBox, code: string): Promise<Login | { status: number; body: unknown }> {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  const r = await box.app.inject({ method: 'POST', url: '/api/enrol/complete', remoteAddress: box.addr, payload: { code, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, platform: 'web', pin: PIN } });
  if (r.statusCode !== 200) return { status: r.statusCode, body: r.json() };
  const deviceId = String(r.json().deviceId);
  const ch = await box.app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress: box.addr, payload: { deviceId } });
  const nonce = String(ch.json().nonce);
  const sig = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(`surau-unlock\n${box.boxId}\n${deviceId}\n${nonce}`))).toString('base64url');
  const un = await box.app.inject({ method: 'POST', url: '/api/auth/unlock', remoteAddress: box.addr, payload: { deviceId, nonce, signature: sig, pin: PIN } });
  const token = String(un.json().token);
  return { token, userId: String(r.json().userId ?? ''), deviceId, roles: [], headers: { authorization: `Bearer ${token}` }, baseVersion: 0, relogin: async () => token, sign: async () => '' };
}

/** What a follower sends the master over the box-to-box channel: the master's real route, carried by `inject`. */
function clientTo(m: XBox, from: XBox): { json: (o: string, ca: string, req: { method?: string; path: string; body?: string }) => Promise<{ status: number; json: unknown }> } {
  return {
    json: async (_o, _ca, req) => {
      const r = await m.app.inject({ method: 'POST', url: req.path, payload: JSON.parse(req.body ?? '{}'), remoteAddress: from.addr });
      let json: unknown = null;
      try {
        json = r.json();
      } catch {
        json = null;
      }
      return { status: r.statusCode, json };
    },
  };
}

const row = (box: XBox, sql: string, ...args: (string | number)[]): Record<string, unknown> | undefined => box.app.surau.db.prepare(sql).get(...args);
const count = (box: XBox, sql: string, ...args: (string | number)[]): number => Number(row(box, sql, ...args)?.n ?? 0);

/** A TV profile of the follower's TV in the master's settings (what the master drops when it carries on). */
function tvIds(m: XBox): string[] {
  const r = row(m, "SELECT json FROM settings WHERE surau_id = 'sdm' AND feature = 'tvProfiles'");
  if (r === undefined) return [];
  return Object.keys((JSON.parse(String(r.json)) as { tvs?: Record<string, unknown> }).tvs ?? {});
}
function seedTv(m: XBox, deviceId: string): void {
  const r = row(m, "SELECT json FROM settings WHERE surau_id = 'sdm' AND feature = 'tvProfiles'");
  const j = r === undefined ? { tvs: {} as Record<string, unknown> } : (JSON.parse(String(r.json)) as { tvs: Record<string, unknown> });
  j.tvs = { ...(j.tvs ?? {}), [deviceId]: { live: { show: false } } };
  m.app.surau.db.prepare("INSERT OR REPLACE INTO settings (surau_id, feature, json, updated_at, updated_by) VALUES ('sdm', 'tvProfiles', ?, ?, 'test')").run(JSON.stringify(j), new Date().toISOString());
}

async function showAndScan(m: XBox, f: XBox): Promise<string> {
  expect((await m.call('POST', '/api/link/show', { pin: PIN })).status).toBe(200);
  const qr = String((await m.tv()).body.qr?.payload ?? '');
  expect((await f.call('POST', '/api/link/scan', { pin: PIN, qr })).status).toBe(200);
  const ap = await m.call('POST', '/api/link/approve', { ok: true });
  expect(ap.status, JSON.stringify(ap.body)).toBe(200);
  return String(ap.body.session.id);
}

/** Case S: both keep the master's data (the follower's own store becomes its backup). */
async function linkS(m: XBox, f: XBox): Promise<string> {
  const linkId = await showAndScan(m, f);
  const put = await f.call('PUT', '/api/link/answers', { keep: 'show', master: 'show', roles: {}, financeTick: false });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  expect(put.body.session.case).toBe('S');
  const rev = put.body.session.answers.rev;
  expect((await f.call('POST', '/api/link/agree', { rev })).status).toBe(200);
  expect((await m.call('POST', '/api/link/agree', { rev })).status).toBe(200);
  await m.app.link!.work.idle();
  await w.restartAll();
  expect(f.app.link!.follow.present()).toBe(true);
  return linkId;
}

/** Case X: the follower's data is kept under the master (the master's own store becomes ITS backup). */
async function linkX(m: XBox, f: XBox): Promise<string> {
  const linkId = await showAndScan(m, f);
  const put = await f.call('PUT', '/api/link/answers', { keep: 'scan', master: 'show', roles: {}, financeTick: false });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  expect(put.body.session.case).toBe('X');
  const rev = put.body.session.answers.rev;
  expect((await f.call('POST', '/api/link/agree', { rev })).status).toBe(200);
  expect((await m.call('POST', '/api/link/agree', { rev })).status).toBe(200);
  await until(() => {
    expect(outcomeOf(m)).toBe('linked');
    expect(outcomeOf(f)).toBe('linked');
  });
  await m.app.link!.work.idle();
  const mAdmin = m.admin!;
  await w.restartAll();
  m.admin = await unlockAgain(m, mAdmin);
  expect(f.app.link!.follow.present()).toBe(true);
  return linkId;
}

interface Ctx {
  kind: 'S' | 'X';
  m: XBox;
  f: XBox;
  linkId: string;
  deviceId: string;
  /** The follower's Pentadbir of link day: his id on the follower and as a person of the master. */
  fAdminOnF: string;
  fAdminOnM: string;
  /** His phone, enrolled at the master with a PIN. */
  fAdmin: Login;
  /** The follower's recovery code from BEFORE the link (only when asked for). */
  code: string;
}

/** A linked pair, the follower's Pentadbir of link day as a signed-in person of the master. */
async function setup(kind: 'S' | 'X', o: { youtube?: boolean; recovery?: boolean } = {}): Promise<Ctx> {
  const m = await w.make(1);
  const f = await w.make(2);
  const fAdminOnF = f.admin!.userId;
  // in case X the follower's Pentadbir of link day is mapped by phone
  f.app.surau.db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(F_PHONE, fAdminOnF);
  if (o.youtube === true) new TokenStore(f.dir).save(YT);
  const code0 = o.recovery === true ? issueRecoveryCode(f.app.surau.db) : '';
  const linkId = kind === 'S' ? await linkS(m, f) : await linkX(m, f);
  const deviceId = String((await m.call('GET', '/api/boxes')).body.boxes[0].id);
  const mapped = row(m, 'SELECT user_id FROM link_people WHERE link_id = ? AND peer_user_id = ?', linkId, fAdminOnF);
  const fAdminOnM = mapped !== undefined ? String(mapped.user_id) : String(row(m, 'SELECT id FROM users WHERE phone = ? AND active = 1', F_PHONE)?.id);
  const code = beginEnrolment(m.app.surau.db, { userId: fAdminOnM, deviceName: 'Telefon F' }, 'test', { canManageSuperadmin: true }).code;
  const fAdmin = (await enrolAt(m, code)) as Login;
  expect(fAdmin.token, JSON.stringify({ fAdmin, fAdminOnM })).toBeTruthy();
  return { kind, m, f, linkId, deviceId, fAdminOnF, fAdminOnM, fAdmin, code: code0 };
}

/** Both sides answered and agreed: the session is working, the follower's token is dead, its order waits. */
async function answerAndAgree(c: Ctx, mc: 'carry-on' | 'back'): Promise<Record<string, any>> {
  const { m, fAdmin } = c;
  const st = await m.call('POST', '/api/unlink/start', { deviceId: c.deviceId, pin: PIN });
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  // with a second follower the master is not asked
  const asked = st.body.session.master.asked === true;
  expect(st.body.session.follower.eligible).toBe('before');
  const a1 = await m.call('PUT', '/api/unlink/answer', { side: 'follower', choice: 'back' }, { as: fAdmin });
  expect(a1.status, JSON.stringify(a1.body)).toBe(200);
  let sheet = a1.body.session;
  if (asked) {
    const a2 = await m.call('PUT', '/api/unlink/answer', { side: 'master', choice: mc, ...(mc === 'carry-on' ? { removePeople: false } : {}) });
    expect(a2.status, JSON.stringify(a2.body)).toBe(200);
    sheet = a2.body.session;
  }
  const rev = sheet.rev;
  const g1 = await m.call('POST', '/api/unlink/agree', { side: 'follower', rev, confirm: true, pin: PIN }, { as: fAdmin });
  expect(g1.status, JSON.stringify(g1.body)).toBe(200);
  if (asked) {
    const g2 = await m.call('POST', '/api/unlink/agree', { side: 'master', rev, pin: PIN, ...(mc === 'back' ? { confirm: true } : {}) });
    expect(g2.status, JSON.stringify(g2.body)).toBe(200);
    expect(g2.body.session.stage).toBe('working');
  } else {
    expect(g1.body.session.stage).toBe('working');
  }
  return sheet;
}

async function fetchOrder(c: Ctx): Promise<Record<string, any>> {
  const r = await c.m.app.inject({ method: 'POST', url: '/api/link/peer/order', remoteAddress: c.f.addr, payload: { boxId: c.f.boxId, linkId: c.linkId } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

/** What the master changed for a "carry on". */
function expectMasterCarriedOn(c: Ctx, tvBefore: string[]): void {
  const { m } = c;
  // the follower's row is off the list, its TV profile is gone, its device is revoked
  expect(count(m, 'SELECT COUNT(*) AS n FROM linked_boxes WHERE device_id = ? AND removed_at IS NOT NULL', c.deviceId)).toBe(1);
  expect(count(m, 'SELECT COUNT(*) AS n FROM linked_boxes WHERE removed_at IS NULL')).toBe(0);
  expect(tvBefore).toContain(c.deviceId);
  expect(tvIds(m)).not.toContain(c.deviceId);
  expect(row(m, 'SELECT revoked_at FROM devices WHERE id = ?', c.deviceId)?.revoked_at).not.toBeNull();
  // the note outside the store: carry-on, with the master's own backup folder kept
  const note = readKeptNote(m.dir)!;
  expect(note).toMatchObject({ side: 'master', chosen: 'carry-on', linkId: c.linkId, folder: c.linkId });
  expect(existsSync(backupDirOf(m.dir, note.folder))).toBe(true);
  expect(Date.parse(note.keptUntil)).toBeGreaterThan(w.clock.now().getTime() + (AT_UNLINK_KEEP_DAYS - 1) * DAY);
  // the master did not plan a restore of itself
  expect(existsSync(join(m.dir, 'link.json'))).toBe(false);
}

interface Done {
  ptr: { ticket: string; boxId: string; name: string; addresses: string[] };
  ord: Record<string, any>;
  sheet: Record<string, any>;
  tvBefore: string[];
}

/** The follower takes the order and restarts: its own restore, its Pentadbir, its join code. Returns before the join. */
async function untilFollowerRestored(c: Ctx, mc: 'carry-on' | 'back'): Promise<Done> {
  const { m, f } = c;
  seedTv(m, c.deviceId);
  const tvBefore = tvIds(m);
  const sheet = await answerAndAgree(c, mc);
  const ord = await fetchOrder(c);
  expect(ord.order).toBe('revert');
  // the follower is cut off at once at the master: its token is gone
  expect(count(m, 'SELECT COUNT(*) AS n FROM linked_boxes WHERE device_id = ? AND removed_at IS NOT NULL', c.deviceId)).toBe(1);
  if (mc === 'carry-on') {
    expectMasterCarriedOn(c, tvBefore);
  } else {
    // "back": nothing of the master changes before the follower joined
    expect(tvIds(m)).toContain(c.deviceId);
    expect(readKeptNote(m.dir)).toBeNull();
    expect(existsSync(join(m.dir, 'link.json'))).toBe(false);
  }
  expect(f.app.link!.takeOrder!(ord)).toBe(true);
  // the follower plans its restore and keeps the note outside its store
  expect(existsSync(join(f.dir, 'link.json'))).toBe(true);
  expect(JSON.parse(readFileSync(join(f.dir, 'link.json'), 'utf8'))).toMatchObject({ op: 'restore', linkId: c.linkId });
  expect(unlinkNotePresent(f.dir)).toBe(true);
  const sj = await m.call('GET', '/api/unlink/status', undefined, { as: c.fAdmin });
  expect(sj.body.session.stage).toBe('join');
  const ptr = sj.body.session.join;
  expect(ptr).toMatchObject({ boxId: f.boxId });
  // everything a `surau1:` enrol payload needs, for a browser that must go to the follower's own web app
  expect(ptr.box).toMatch(/^https:\/\/[^/]+$/);
  expect(ptr.addresses).toContain(ptr.box);
  expect(ptr).toMatchObject({ mode: 'ip', caSha256: expect.stringMatching(/^[0-9a-f]{64}$/i), ticket: expect.stringMatching(/^[A-Za-z2-7]{4}-?[A-Za-z2-7]{4}-?[A-Za-z2-7]{4}$/) });
  expect(ptr.user).toMatch(/\S/);
  expect(ptr.exp).toBeGreaterThan(w.clock.now().getTime());
  // the box comes from the pairing record; a name address gives mode 'name'; none at all gives null (never '')
  const origAddr = String(row(m, 'SELECT addresses_json FROM linked_boxes WHERE device_id = ?', c.deviceId)?.addresses_json);
  const setAddr = (json: string): void => { m.app.surau.db.prepare('UPDATE linked_boxes SET addresses_json = ? WHERE device_id = ?').run(json, c.deviceId); };
  const joinNow = async () => (await m.call('GET', '/api/unlink/status', undefined, { as: c.fAdmin })).body.session.join;
  setAddr(JSON.stringify(['https://box1-sdm.local:8443']));
  expect(await joinNow()).toMatchObject({ box: 'https://box1-sdm.local:8443', mode: 'name' });
  setAddr(JSON.stringify(['http://10.168.50.12:8080']));
  expect((await joinNow()).box).toBeNull();
  setAddr(origAddr);
  // the master's own people do not see the ticket
  expect((await m.call('GET', '/api/unlink/status')).body.session.join).toBeNull();
  await w.restartAll();
  return { ptr, ord, sheet, tvBefore };
}

/** The restored follower: no follow record, its answering person a Pentadbir without a PIN, a join code that works once. */
function expectFollowerRestored(c: Ctx): void {
  const { f } = c;
  expect(f.app.link!.follow.present()).toBe(false);
  expect(f.app.link!.follow.read()).toBeNull();
  expect(existsSync(join(f.dir, 'link.json'))).toBe(false);
  // the follower's data in use is kept 7 days, shown in the status and removable (not switchable)
  const kept = f.app.link!.unlinks.status(null).kept;
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatchObject({ side: 'follower', chosen: 'back', switchable: false });
  expect(existsSync(backupDirOf(f.dir, atUnlinkFolder(c.linkId)))).toBe(true);
  const note = readUnlinkNote(f.dir, loadIdentity(f.dir), f.boxId)!;
  expect(note.applied).toBe(true);
  expect(note.userId).toBe(c.fAdminOnF);
  const u = row(f, 'SELECT active, roles_json, pin_hash FROM users WHERE id = ?', c.fAdminOnF)!;
  expect(u.active).toBe(1);
  expect(JSON.parse(String(u.roles_json))).toContain('admin');
  expect(u.pin_hash).toBeNull();
}

async function joinAndReport(c: Ctx, d: Done): Promise<void> {
  const { m, f } = c;
  const phone = (await enrolAt(f, d.ptr.ticket)) as Login;
  expect(phone.token, JSON.stringify(phone)).toBeTruthy();
  // the code is spent: it works once
  const again = await enrolAt(f, d.ptr.ticket);
  expect('status' in again && again.status).toBeGreaterThanOrEqual(400);
  expect(row(f, 'SELECT pin_hash FROM users WHERE id = ?', c.fAdminOnF)?.pin_hash).not.toBeNull();
  const fid = loadIdentity(f.dir);
  const note = readUnlinkNote(f.dir, fid, f.boxId)!;
  expect(await sendUnlinkReport(clientTo(m, f) as never, fid, f.boxId, { ...note, master: { ...note.master, addresses: [m.origin] } }, 'joined')).toBe(true);
}

// ---------------------------------------------------------------- 1 and 2: the combinations

for (const kind of ['S', 'X'] as const) {
  describe(`unlink combinations, case ${kind}`, () => {
    it(`master carry-on + follower back (case ${kind}): done, the follower restored, the master keeps its data and a note`, async () => {
      const c = await setup(kind);
      const d = await untilFollowerRestored(c, 'carry-on');
      expectFollowerRestored(c);
      await joinAndReport(c, d);
      const { m } = c;
      const end = await m.call('GET', '/api/unlink/status');
      expect(end.body.session).toBeNull();
      expect(end.body.last).toMatchObject({ outcome: 'done' });
      expect(end.body.kept[0]).toMatchObject({ side: 'master', chosen: 'carry-on' });
      expectMasterCarriedOn(c, d.tvBefore);
      // a new link waits until the kept data is gone
      expect((await m.call('POST', '/api/link/show', { pin: PIN })).body.code).toBe('kept_data');
    }, SLOW);

    it(`master back + follower back (case ${kind}): the master restores LAST, after the join; its list has no live follower`, async () => {
      const c = await setup(kind);
      const { m } = c;
      const d = await untilFollowerRestored(c, 'back');
      expectFollowerRestored(c);
      // the join has not happened: the master has still changed nothing
      expect(existsSync(join(m.dir, 'link.json'))).toBe(false);
      expect(readKeptNote(m.dir)).toBeNull();
      const restartsBefore = m.restarts;
      await joinAndReport(c, d);
      // now the master plans its restore (the journal) and the note, then restarts
      expect(JSON.parse(readFileSync(join(m.dir, 'link.json'), 'utf8'))).toMatchObject({ op: 'restore', linkId: c.linkId });
      await until(() => expect(m.restarts).toBeGreaterThan(restartsBefore));
      await w.restartAll();
      expect(existsSync(join(m.dir, 'link.json'))).toBe(false);
      const kept = readKeptNote(m.dir)!;
      expect(kept).toMatchObject({ side: 'master', chosen: 'back', outcome: 'done', linkId: c.linkId, folder: atUnlinkFolder(c.linkId) });
      expect(existsSync(backupDirOf(m.dir, kept.folder))).toBe(true);
      expect(readManifest(backupDirOf(m.dir, kept.folder))!.kind).toBe('at-unlink');
      // the restored master knows no live follower, and says "done" from the note
      expect(count(m, 'SELECT COUNT(*) AS n FROM linked_boxes WHERE removed_at IS NULL')).toBe(0);
      expect(m.app.link!.unlinks.status(null).last).toMatchObject({ outcome: 'done' });
      expect(m.app.link!.unlinks.status(null).kept[0]).toMatchObject({ side: 'master', chosen: 'back' });
    }, SLOW);

    it.todo(`master carry-on + follower carry-on (case ${kind}): D3, the follower's reduced copy`);
    it.todo(`master back + follower carry-on (case ${kind}): D3, the follower's reduced copy`);
  });
}

// ---------------------------------------------------------------- shared by the next tests

/** A master with two followers: unlinking one of them does not ask the master. */
async function setupTwo(): Promise<{ m: XBox; f1: XBox; f2: XBox; c: Ctx }> {
  const m = await w.make(1);
  const f1 = await w.make(2);
  const f2 = await w.make(3);
  const a1 = f1.admin!.userId;
  const link1 = await linkS(m, f1);
  await linkS(m, f2);
  const deviceId = String(((await m.call('GET', '/api/boxes')).body.boxes as { id: string; boxId: string }[]).find((b) => b.boxId === f1.boxId)!.id);
  const onM = String(row(m, 'SELECT user_id FROM link_people WHERE link_id = ? AND peer_user_id = ?', link1, a1)!.user_id);
  const fAdmin = (await enrolAt(m, beginEnrolment(m.app.surau.db, { userId: onM, deviceName: 'Telefon F1' }, 'test', { canManageSuperadmin: true }).code)) as Login;
  expect(fAdmin.token).toBeTruthy();
  return { m, f1, f2, c: { kind: 'S', m, f: f1, linkId: link1, deviceId, fAdminOnF: a1, fAdminOnM: onM, fAdmin, code: '' } };
}

/** A follower that was a NEW box (never set up): it shows its QR, the master scans. */
async function linkNewBox(m: XBox, f: XBox): Promise<string> {
  const qr = String((await f.tv()).body.qr?.payload ?? '');
  expect(qr).not.toBe('');
  const sc = await m.call('POST', '/api/link/scan', { pin: PIN, qr });
  expect(sc.status, JSON.stringify(sc.body)).toBe(200);
  const ap = await m.call('POST', '/api/link/approve', { ok: true });
  expect(ap.status, JSON.stringify(ap.body)).toBe(200);
  const linkId = String(ap.body.session.id);
  const cur = ap.body.session.answers;
  const put = await m.call('PUT', '/api/link/answers', { keep: cur.keep, master: cur.master, roles: {}, financeTick: false });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  expect((await m.call('POST', '/api/link/agree', { rev: put.body.session.answers.rev })).status).toBe(200);
  for (let i = 0; i < 20 && m.app.link!.sessions.current() !== null; i++) await new Promise((r) => setTimeout(r, 50));
  await m.app.link!.work.idle();
  await w.restartAll();
  expect(f.app.link!.follow.present()).toBe(true);
  return linkId;
}

// ---------------------------------------------------------------- 3

describe('who is asked', () => {
  it('masterTwoFollowersNotAsked: with two followers the master is not asked; the follower side alone starts the work; the other follower stays linked', async () => {
    const { m, f1, f2, c } = await setupTwo();
    const st = await m.call('POST', '/api/unlink/start', { deviceId: c.deviceId, pin: PIN });
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    expect(st.body.session.master.asked).toBe(false);
    expect(st.body.session.master.mayAnswer).toBe(false);
    expect(st.body.session.master.choice).toBe('carry-on');
    expect(st.body.session.follower.asked).toBe(true);
    // nobody may answer for the master: not its Pentadbir, not the follower's person
    for (const as of [undefined, c.fAdmin]) {
      const r = await m.call('PUT', '/api/unlink/answer', { side: 'master', choice: 'carry-on' }, as === undefined ? {} : { as });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('not_allowed_to_answer');
    }
    const a = await m.call('PUT', '/api/unlink/answer', { side: 'follower', choice: 'back' }, { as: c.fAdmin });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const g = await m.call('POST', '/api/unlink/agree', { side: 'follower', rev: a.body.session.rev, confirm: true, pin: PIN }, { as: c.fAdmin });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    // the follower's agreement alone starts the work
    expect(g.body.session.stage).toBe('working');
    const ord = await fetchOrder(c);
    expect(ord.order).toBe('revert');
    expect(f1.app.link!.takeOrder!(ord)).toBe(true);
    // the other follower is untouched, at the master and at itself
    const boxes = (await m.call('GET', '/api/boxes')).body.boxes as { boxId: string; removedAt: string | null }[];
    expect(boxes.find((b) => b.boxId === f2.boxId)!.removedAt).toBeNull();
    expect(boxes.find((b) => b.boxId === f1.boxId)!.removedAt).not.toBeNull();
    expect(count(m, 'SELECT COUNT(*) AS n FROM linked_boxes WHERE removed_at IS NULL')).toBe(1);
    expect(f2.app.link!.follow.present()).toBe(true);
    expect(existsSync(join(f2.dir, 'link.json'))).toBe(false);
    // the master asked nothing, so it keeps no note of a choice
    expect(readKeptNote(m.dir)).toBeNull();
    // the join closes the session; still no note, the other follower still linked
    const ptr = (await m.call('GET', '/api/unlink/status', undefined, { as: c.fAdmin })).body.session.join;
    await w.restartAll();
    expect(((await enrolAt(f1, ptr.ticket)) as Login).token).toBeTruthy();
    const fid = loadIdentity(f1.dir);
    const note = readUnlinkNote(f1.dir, fid, f1.boxId)!;
    expect(await sendUnlinkReport(clientTo(m, f1) as never, fid, f1.boxId, { ...note, master: { ...note.master, addresses: [m.origin] } }, 'joined')).toBe(true);
    expect(m.app.link!.unlinks.status(null).last).toMatchObject({ outcome: 'done' });
    expect(readKeptNote(m.dir)).toBeNull();
    expect(count(m, 'SELECT COUNT(*) AS n FROM linked_boxes WHERE removed_at IS NULL')).toBe(1);
    expect(f2.app.link!.follow.present()).toBe(true);
  }, SLOW);
});

// ---------------------------------------------------------------- 4

describe('a follower that was a new box', () => {
  it('newBoxFollowerEmptyOrCarryOn: eligible any, back refused (option_unavailable), empty available and ends done at the fetch with a forget order', async () => {
    const m = await w.make(1);
    const f = await w.make(2, { setUp: false });
    const linkId = await linkNewBox(m, f);
    const deviceId = String((await m.call('GET', '/api/boxes')).body.boxes[0].id);
    const admin2 = await loginAs(m.app, 'admin');
    const ajk = await loginAs(m.app, 'ajk');
    seedTv(m, deviceId);
    const st = await m.call('POST', '/api/unlink/start', { deviceId, pin: PIN });
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    const fs = st.body.session.follower;
    expect(fs.eligible).toBe('any');
    expect(fs.options.back.available).toBe(false);
    expect(fs.options.empty.available).toBe(true);
    expect(fs.options.carryOn.available).toBe(true);
    const back = await m.call('PUT', '/api/unlink/answer', { side: 'follower', choice: 'back' });
    expect(back.status).toBe(409);
    expect(back.body.code).toBe('option_unavailable');
    // a person who is no Pentadbir still may not answer
    expect((await m.call('PUT', '/api/unlink/answer', { side: 'follower', choice: 'empty' }, { as: ajk })).body.code).toBe('not_allowed_to_answer');
    expect((await m.call('PUT', '/api/unlink/answer', { side: 'follower', choice: 'empty' })).status).toBe(200);
    // the phone that answered for the follower cannot answer for the master
    const same = await m.call('PUT', '/api/unlink/answer', { side: 'master', choice: 'carry-on' });
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('same_phone');
    const a = await m.call('PUT', '/api/unlink/answer', { side: 'master', choice: 'carry-on' }, { as: admin2 });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const rev = a.body.session.rev;
    // emptying needs the typed confirmation
    expect((await m.call('POST', '/api/unlink/agree', { side: 'follower', rev, pin: PIN })).body.code).toBe('confirm_required');
    expect((await m.call('POST', '/api/unlink/agree', { side: 'follower', rev, confirm: true, pin: PIN })).status).toBe(200);
    expect((await m.call('POST', '/api/unlink/agree', { side: 'master', rev, pin: PIN }, { as: admin2 })).status).toBe(200);
    // nothing at the master changed before the follower asked
    expect(tvIds(m)).toContain(deviceId);
    const ord = (await m.app.inject({ method: 'POST', url: '/api/link/peer/order', remoteAddress: f.addr, payload: { boxId: f.boxId, linkId } })).json();
    expect(ord.order).toBe('forget');
    // the session ended `done` at the fetch, the master carried on
    const end = await m.call('GET', '/api/unlink/status');
    expect(end.body.session).toBeNull();
    expect(end.body.last.outcome).toBe('done');
    expect(tvIds(m)).not.toContain(deviceId);
    expect(count(m, 'SELECT COUNT(*) AS n FROM linked_boxes WHERE removed_at IS NULL')).toBe(0);
    // the follower empties itself and returns to first setup
    expect(f.app.link!.takeOrder!(ord)).toBe(true);
    expect(JSON.parse(readFileSync(join(f.dir, 'link.json'), 'utf8'))).toMatchObject({ op: 'forget', linkId });
    await w.restartAll();
    expect(f.app.link!.follow.present()).toBe(false);
    expect(count(f, 'SELECT COUNT(*) AS n FROM users')).toBe(0);
    expect(unlinkNotePresent(f.dir)).toBe(false);
  }, SLOW);

  it.todo('newBoxFollowerEmptyOrCarryOn: the follower of a new box carries on (D3, the follower\'s reduced copy)');
});

// ---------------------------------------------------------------- 5

describe('who may answer', () => {
  it('unlinkAnswerWrongPerson: AJK, a Pentadbir who was not the follower\'s, a person of the master for the follower: 403; same phone 409; an answerer cannot agree for the other side', async () => {
    const c = await setup('S');
    const { m, fAdmin } = c;
    const ajk = await loginAs(m.app, 'ajk');
    const admin2 = await loginAs(m.app, 'admin');
    const start = await m.call('POST', '/api/unlink/start', { deviceId: c.deviceId, pin: PIN });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    // the sheet tells each caller what he may do
    expect((await m.call('GET', '/api/unlink/status', undefined, { as: fAdmin })).body.session.follower.mayAnswer).toBe(true);
    expect((await m.call('GET', '/api/unlink/status', undefined, { as: ajk })).body.session.follower.mayAnswer).toBe(false);
    expect((await m.call('GET', '/api/unlink/status', undefined, { as: admin2 })).body.session.follower.mayAnswer).toBe(false);
    for (const side of ['follower', 'master'] as const) {
      const r = await m.call('PUT', '/api/unlink/answer', { side, choice: 'carry-on' }, { as: ajk });
      expect([r.status, r.body.code], `ajk ${side}`).toEqual([403, 'not_allowed_to_answer']);
    }
    // a Pentadbir of the master, and the master's own signed-in Pentadbir: not the follower's person of link day
    for (const as of [admin2, m.admin!]) {
      const r = await m.call('PUT', '/api/unlink/answer', { side: 'follower', choice: 'back' }, { as });
      expect([r.status, r.body.code]).toEqual([403, 'not_allowed_to_answer']);
    }
    expect(await m.call('GET', '/api/unlink/status')).toMatchObject({ body: { session: { follower: { choice: null, answeredBy: null } } } });
    // the follower's person answers for the master first: then not for the follower with the same phone
    expect((await m.call('PUT', '/api/unlink/answer', { side: 'master', choice: 'carry-on' }, { as: fAdmin })).status).toBe(200);
    const sameA = await m.call('PUT', '/api/unlink/answer', { side: 'follower', choice: 'back' }, { as: fAdmin });
    expect([sameA.status, sameA.body.code]).toEqual([409, 'same_phone']);
    // and the other way round, in a new session
    expect((await m.call('POST', '/api/unlink/cancel')).status).toBe(200);
    expect((await m.call('POST', '/api/unlink/start', { deviceId: c.deviceId, pin: PIN })).status).toBe(200);
    expect((await m.call('PUT', '/api/unlink/answer', { side: 'follower', choice: 'back' }, { as: fAdmin })).status).toBe(200);
    const sameB = await m.call('PUT', '/api/unlink/answer', { side: 'master', choice: 'carry-on' }, { as: fAdmin });
    expect([sameB.status, sameB.body.code]).toEqual([409, 'same_phone']);
    const a = await m.call('PUT', '/api/unlink/answer', { side: 'master', choice: 'carry-on' });
    expect(a.status).toBe(200);
    const rev = a.body.session.rev;
    // an answerer cannot agree for the other side, and nobody agrees for an answer he did not give
    for (const [as, side] of [[fAdmin, 'master'], [m.admin!, 'follower'], [ajk, 'follower'], [admin2, 'master']] as const) {
      const r = await m.call('POST', '/api/unlink/agree', { side, rev, confirm: true, pin: PIN }, { as });
      expect([r.status, r.body.code], `${side}`).toEqual([403, 'not_allowed_to_answer']);
    }
    // nothing started: still the answers, the follower still linked and its token alive
    const now = await m.call('GET', '/api/unlink/status');
    expect(now.body.session.stage).toBe('answers');
    expect(now.body.session.follower.agreed).toBe(false);
    expect(now.body.session.master.agreed).toBe(false);
    expect(count(m, 'SELECT COUNT(*) AS n FROM linked_boxes WHERE removed_at IS NULL')).toBe(1);
    expect(row(m, 'SELECT revoked_at FROM devices WHERE id = ?', c.deviceId)?.revoked_at).toBeNull();
  }, SLOW);
});

// ---------------------------------------------------------------- 6 and 7

/** The order the master signed, as the follower would receive it, with the plain secret opened for forging tests. */
async function orderFixture(c: Ctx): Promise<{ answer: Record<string, any>; body: Record<string, any>; plain: string; mId: ReturnType<typeof loadIdentity>; fId: ReturnType<typeof loadIdentity> }> {
  await answerAndAgree(c, 'carry-on');
  const answer = await fetchOrder(c);
  const fId = loadIdentity(c.f.dir);
  const mId = loadIdentity(c.m.dir);
  const plain = openWithBoxKey(fId.privateJwk, answer.body.sealed, ORDER_LABEL, orderAad(answer.body.unlinkId, c.f.boxId, c.m.boxId), sealedRe(16 * 1024));
  return { answer, body: answer.body, plain, mId, fId };
}

/** One character in the middle changed (the last character of a base64 string may hold only padding bits). */
const flip = (s: string): string => {
  const i = Math.floor(s.length / 2);
  return s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
};
const OTHER16 = 'ab'.repeat(8);
const OTHER32 = 'cd'.repeat(16);

describe('the order a follower takes', () => {
  it('orderWrongSignatureRefused: every changed field, another box\'s signature, another unlink\'s sealed blob, a wrong step: false, no link.json, no note', async () => {
    const c = await setup('S');
    const { f } = c;
    const x = await w.make(4);
    const xId = loadIdentity(x.dir);
    const { answer, body, plain, mId, fId } = await orderFixture(c);
    const take = (a: unknown): boolean => f.app.link!.takeOrder!(a);
    const refused: [string, unknown][] = [];
    // the body changed in each field, the signature kept
    for (const [k, v] of Object.entries({ boxId: OTHER16, linkId: OTHER32, masterBoxId: OTHER16, unlinkId: OTHER32, sealed: flip(String(body.sealed)) })) {
      refused.push([`body.${k} changed`, { ...answer, body: { ...body, [k]: v } }]);
    }
    refused.push(['extra body field', { ...answer, body: { ...body, extra: 1 } }]);
    refused.push(['missing body field', { ...answer, body: { boxId: body.boxId, linkId: body.linkId, masterBoxId: body.masterBoxId, unlinkId: body.unlinkId } }]);
    // the signature changed, or made by another box over exactly this body
    refused.push(['signature flipped', { ...answer, sig: flip(String(answer.sig)) }]);
    refused.push(['signature of another box', { ...answer, sig: signLink(xId, 'order-revert', c.linkId, body) }]);
    refused.push(['signature of the follower itself', { ...answer, sig: signLink(fId, 'order-revert', c.linkId, body) }]);
    refused.push(['no signature', { order: answer.order, body }]);
    // a revert order carrying the signature of the other order, in both directions
    refused.push(['revert with the standalone signature', { ...answer, order: 'revert', sig: signLink(mId, 'order-standalone', c.linkId, body) }]);
    refused.push(['standalone with the revert signature', { ...answer, order: 'standalone' }]);
    refused.push(['forget with a revert body', { ...answer, order: 'forget' }]);
    refused.push(['forget signature on a revert body', { ...answer, sig: signLink(mId, 'order-forget', c.linkId, body) }]);
    // the master's own signature over a blob sealed for ANOTHER unlink (its additional data names a different one)
    const resealed = (unlinkId: string): string => sealToBoxKey(fId.publicJwk, plain, ORDER_LABEL, orderAad(unlinkId, f.boxId, c.m.boxId));
    const otherBody = { ...body, sealed: resealed(OTHER32) };
    refused.push(['sealed blob of another unlink', { order: 'revert', body: otherBody, sig: signLink(mId, 'order-revert', c.linkId, otherBody) }]);
    // a blob sealed to another box's key
    const toX = { ...body, sealed: sealToBoxKey(xId.publicJwk, plain, ORDER_LABEL, orderAad(body.unlinkId, f.boxId, c.m.boxId)) };
    refused.push(['sealed to another box key', { order: 'revert', body: toX, sig: signLink(mId, 'order-revert', c.linkId, toX) }]);
    // junk
    for (const j of [null, 'revert', 7, [], {}, { order: 'revert' }, { order: 'revert', body: 'x' }, { order: 'standalone', body, sig: answer.sig }]) refused.push([`junk ${JSON.stringify(j)}`, j]);
    for (const [name, a] of refused) expect(take(a), name).toBe(false);
    // not one of them wrote anything
    expect(existsSync(join(f.dir, 'link.json'))).toBe(false);
    expect(unlinkNotePresent(f.dir)).toBe(false);
    expect(f.app.link!.follow.present()).toBe(true);
    // the control: the same blob resealed for the RIGHT unlink under the master's signature is an order
    const good = { ...body, sealed: resealed(body.unlinkId) };
    expect(take({ order: 'revert', body: good, sig: signLink(mId, 'order-revert', c.linkId, good) })).toBe(true);
    expect(existsSync(join(f.dir, 'link.json'))).toBe(true);
    expect(unlinkNotePresent(f.dir)).toBe(true);
  }, SLOW);

  it('orderOtherLinkRefused: an order, even one the master signed, for another link or another box is refused; one follower\'s order is no use to the other', async () => {
    const { m, f1, f2, c } = await setupTwo();
    const x = await w.make(4);
    const { answer, body, plain, mId } = await orderFixture(c);
    const f2Id = loadIdentity(f2.dir);
    // a genuine order for f1 handed to f2: another box id and another link
    expect(f2.app.link!.takeOrder!(answer)).toBe(false);
    // signed by the master and sealed to f1, but naming something else
    const forged: [string, Record<string, unknown>][] = [
      ['another linkId', { ...body, linkId: OTHER32 }],
      ['another boxId', { ...body, boxId: x.boxId }],
      ['another masterBoxId', { ...body, masterBoxId: x.boxId }],
      ['the other follower\'s boxId', { ...body, boxId: f2.boxId }],
    ];
    for (const [name, b] of forged) {
      for (const ctxLink of [c.linkId, String(b.linkId)]) {
        const sig = signLink(mId, 'order-revert', ctxLink, b);
        expect(f1.app.link!.takeOrder!({ order: 'revert', body: b, sig }), `${name} (signed in link ${ctxLink === c.linkId ? 'own' : 'named'})`).toBe(false);
      }
    }
    // the plain secret of f1 sealed to f2 for f2's own box id: still not f2's link
    const b2 = { ...body, boxId: f2.boxId, sealed: sealToBoxKey(f2Id.publicJwk, plain, ORDER_LABEL, orderAad(body.unlinkId, f2.boxId, m.boxId)) };
    expect(f2.app.link!.takeOrder!({ order: 'revert', body: b2, sig: signLink(mId, 'order-revert', c.linkId, b2) })).toBe(false);
    for (const b of [f1, f2]) {
      expect(existsSync(join(b.dir, 'link.json'))).toBe(false);
      expect(unlinkNotePresent(b.dir)).toBe(false);
      expect(b.app.link!.follow.present()).toBe(true);
    }
    // the control: the genuine order is taken by the box it names
    expect(f1.app.link!.takeOrder!(answer)).toBe(true);
  }, SLOW);
});

// ---------------------------------------------------------------- 8 and 9

/**
 * The sheet's YouTube line reads what the follower said in its hello on link day. The test box has no YouTube
 * verdict (`signedIn` is false without a live check), so its hello said "not signed in" although the token file was
 * there: the test sets the stored fact the way a signed-in follower would have sent it.
 */
function signedInAtLinkDay(m: XBox, linkId: string): void {
  const r = row(m, "SELECT peer_hello_json FROM link_sessions WHERE id = ? AND kind = 'link'", linkId)!;
  const hello = JSON.parse(String(r.peer_hello_json)) as { facts: Record<string, unknown> };
  hello.facts.youtube = true;
  m.app.surau.db.prepare("UPDATE link_sessions SET peer_hello_json = ? WHERE id = ? AND kind = 'link'").run(JSON.stringify(hello), linkId);
}

describe('what must not cross', () => {
  it('youtubeNeverOnTwoBoxes: case X, master carry-on, follower back: no secret/youtube-token.json at the follower after its first start; the sheet said sign-in-again', async () => {
    const c = await setup('X', { youtube: true });
    const { m, f } = c;
    signedInAtLinkDay(m, c.linkId);
    // the master runs on the sign-in that crossed from the follower
    expect(new TokenStore(m.dir).load()).toEqual(YT);
    const d = await untilFollowerRestored(c, 'carry-on');
    expect(d.sheet.follower.youtube).toBe('sign-in-again');
    expect(d.sheet.master.youtube).toBe('kept');
    expectFollowerRestored(c);
    for (const rel of ['secret/youtube-token.json', 'secret/youtube-state.json', 'live/youtube-open.json']) expect(existsSync(join(f.dir, ...rel.split('/'))), rel).toBe(false);
    expect(new TokenStore(f.dir).load()).toBeNull();
    // the master keeps its sign-in
    expect(new TokenStore(m.dir).load()).toEqual(YT);
    await joinAndReport(c, d);
    expect(new TokenStore(m.dir).load()).toEqual(YT);
    expect(existsSync(join(f.dir, 'secret', 'youtube-token.json'))).toBe(false);
  }, SLOW);

  it('youtubeReturnsWhenTheMasterGoesBack: case X, both back: the follower\'s own sign-in returns (nothing to clash with)', async () => {
    const c = await setup('X', { youtube: true });
    signedInAtLinkDay(c.m, c.linkId);
    const d = await untilFollowerRestored(c, 'back');
    expect(d.sheet.follower.youtube).toBe('returns');
    expectFollowerRestored(c);
    expect(new TokenStore(c.f.dir).load()).toEqual(YT);
  }, SLOW);

  it.each(['S', 'X'] as const)('restoredDeviceRowsRevoked (case %s): every phone row of the follower\'s restored store is revoked, with its sessions', async (kind) => {
    const c = await setup(kind);
    const { f } = c;
    // (while it follows, its store holds no phone: the phones of before the link are in its backup)
    await untilFollowerRestored(c, 'carry-on');
    expect(count(f, "SELECT COUNT(*) AS n FROM devices WHERE platform <> 'kiosk'")).toBeGreaterThan(0);
    expect(count(f, "SELECT COUNT(*) AS n FROM devices WHERE platform <> 'kiosk' AND revoked_at IS NULL")).toBe(0);
    expect(count(f, 'SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL')).toBe(0);
    // the phones of before the link are back in the store, all revoked; the old phone of the Pentadbir is refused
    const old = await f.call('GET', '/api/users', undefined, { as: f.admin });
    expect(old.status).toBe(401);
  }, SLOW);
});

// ---------------------------------------------------------------- 10 and 11

// The PIN limiter (real clock) allows 5 proofs per person in 15 minutes: the kept-data tests spread them over
// several Pentadbir.

/** A completed carry-on unlink: the master keeps a note with its backup folder. */
async function keptCarryOn(): Promise<Ctx> {
  const c = await setup('S');
  const d = await untilFollowerRestored(c, 'carry-on');
  await joinAndReport(c, d);
  expect(readKeptNote(c.m.dir)).toMatchObject({ chosen: 'carry-on', folder: c.linkId });
  return c;
}

describe('the kept data of an unlink', () => {
  it('switchDay6OkDay8Refused: on day 6 the switch plans the restore (journal, note flipped), on day 8 409 kept_window_over', async () => {
    const c = await keptCarryOn();
    const { m } = c;
    const body = { side: 'master', pin: PIN, confirm: true };
    const other = await loginAs(m.app, 'admin');
    // refusals first: the PIN is needed, the confirmation, the right side
    expect((await m.call('POST', '/api/unlink/switch', { side: 'master', confirm: true }, { as: other })).body.code).toBe('pin_required');
    expect((await m.call('POST', '/api/unlink/switch', { side: 'master', pin: PIN }, { as: other })).body.code).toBe('confirm_required');
    expect((await m.call('POST', '/api/unlink/switch', { ...body, side: 'follower' }, { as: other })).body.code).toBe('no_kept_data');
    expect(existsSync(join(m.dir, 'link.json'))).toBe(false);
    const until0 = readKeptNote(m.dir)!.keptUntil;
    // day 6: the window is open
    w.clock.tick(6 * DAY);
    m.admin = await unlockAgain(m, m.admin!);
    expect((await m.call('GET', '/api/unlink/status')).body.kept).toHaveLength(1);
    const before = m.restarts;
    const ok = await m.call('POST', '/api/unlink/switch', body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(JSON.parse(readFileSync(join(m.dir, 'link.json'), 'utf8'))).toMatchObject({ op: 'restore', linkId: c.linkId });
    const flipped = readKeptNote(m.dir)!;
    expect(flipped).toMatchObject({ chosen: 'back', folder: atUnlinkFolder(c.linkId), keptUntil: until0 });
    await until(() => expect(m.restarts).toBeGreaterThan(before));
    await w.restartAll();
    // the master runs on its data of before the link, and what it ran on is kept for the rest of the window
    expect(existsSync(join(m.dir, 'link.json'))).toBe(false);
    expect(count(m, 'SELECT COUNT(*) AS n FROM linked_boxes WHERE removed_at IS NULL')).toBe(0);
    expect(existsSync(backupDirOf(m.dir, atUnlinkFolder(c.linkId)))).toBe(true);
    expect(readKeptNote(m.dir)).toMatchObject({ chosen: 'back', keptUntil: until0 });
  }, SLOW);

  it('switchDay6OkDay8Refused (day 8): 409 kept_window_over, nothing planned, the note untouched', async () => {
    const c = await keptCarryOn();
    const { m } = c;
    const note = readKeptNote(m.dir)!;
    w.clock.tick(8 * DAY);
    m.admin = await unlockAgain(m, m.admin!);
    // the status no longer offers it
    expect((await m.call('GET', '/api/unlink/status')).body.kept).toEqual([]);
    const r = await m.call('POST', '/api/unlink/switch', { side: 'master', pin: PIN, confirm: true });
    expect([r.status, r.body.code]).toEqual([409, 'kept_window_over']);
    expect(existsSync(join(m.dir, 'link.json'))).toBe(false);
    expect(readKeptNote(m.dir)).toEqual(note);
    expect(existsSync(backupDirOf(m.dir, c.linkId))).toBe(true);
    // the same at the function: a day inside the window is fine, the day after is not
    expect(() => switchKept(m.dir, 'follower', new Date(w.clock.now().getTime() - DAY))).toThrow('no_kept_data');
    try {
      switchKept(m.dir, 'master', w.clock.now());
      expect.unreachable('the window is over');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('kept_window_over');
    }
  }, SLOW);

  it('dropKeptRemovesFolderAndNote: "Buang data lama" removes the backup folder and the note; the switch is gone with them', async () => {
    const c = await keptCarryOn();
    const { m } = c;
    const dir = backupDirOf(m.dir, c.linkId);
    expect(existsSync(dir)).toBe(true);
    const other = await loginAs(m.app, 'admin');
    // refusals change nothing
    expect((await m.call('POST', '/api/unlink/drop-kept', { side: 'master', confirm: true }, { as: other })).body.code).toBe('pin_required');
    expect((await m.call('POST', '/api/unlink/drop-kept', { side: 'master', pin: PIN }, { as: other })).body.code).toBe('confirm_required');
    expect((await m.call('POST', '/api/unlink/drop-kept', { side: 'follower', pin: PIN, confirm: true }, { as: other })).body.code).toBe('no_kept_data');
    expect((await m.call('POST', '/api/unlink/drop-kept', { side: 'nobody', pin: PIN, confirm: true }, { as: other })).status).toBe(400);
    expect(existsSync(dir)).toBe(true);
    expect(readKeptNote(m.dir)).not.toBeNull();
    const ok = await m.call('POST', '/api/unlink/drop-kept', { side: 'master', pin: PIN, confirm: true }, { as: other });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.kept).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(readKeptNote(m.dir)).toBeNull();
    expect(existsSync(join(m.dir, 'link-unlink-kept.json'))).toBe(false);
    const sw = await m.call('POST', '/api/unlink/switch', { side: 'master', pin: PIN, confirm: true }, { as: other });
    expect([sw.status, sw.body.code]).toEqual([409, 'no_kept_data']);
    // the master may link again
    expect((await m.call('POST', '/api/link/show', { pin: PIN })).status).toBe(200);
  }, SLOW);

  it('sweepKeptNoteDropsCarryOnBackup: inside the window nothing, past it the backup folder and the note go', async () => {
    const c = await keptCarryOn();
    const { m } = c;
    const dir = backupDirOf(m.dir, c.linkId);
    const note = readKeptNote(m.dir)!;
    const t0 = w.clock.now().getTime();
    expect(sweepKeptNote(m.dir, new Date(t0 + 6 * DAY))).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(readKeptNote(m.dir)).toEqual(note);
    expect(sweepKeptNote(m.dir, new Date(Date.parse(note.keptUntil) + 1000))).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(readKeptNote(m.dir)).toBeNull();
    // nothing left to sweep
    expect(sweepKeptNote(m.dir, new Date(t0 + 30 * DAY))).toBe(false);
  }, SLOW);

  it('sweepKeptNote leaves the data of a master that went back to the other sweep (only the note goes)', async () => {
    const c = await setup('S');
    const { m } = c;
    const d = await untilFollowerRestored(c, 'back');
    const before = m.restarts;
    await joinAndReport(c, d);
    await until(() => expect(m.restarts).toBeGreaterThan(before));
    await w.restartAll();
    const note = readKeptNote(m.dir)!;
    expect(note.chosen).toBe('back');
    const dir = backupDirOf(m.dir, note.folder);
    expect(existsSync(dir)).toBe(true);
    expect(sweepKeptNote(m.dir, new Date(Date.parse(note.keptUntil) + 1000))).toBe(true);
    // the `-at-unlink` data of a box that went back is the other sweep's, by its own date
    expect(existsSync(dir)).toBe(true);
    expect(readKeptNote(m.dir)).toBeNull();
    // the data kept for 7 days: switching back to it inside the window
    expect(() => switchKept(m.dir, 'master', w.clock.now())).toThrow('no_kept_data');
  }, SLOW);

  it('switchKept on a box that went back: inside the window the data it left comes back (carry-on again)', async () => {
    const c = await setup('S');
    const { m } = c;
    const d = await untilFollowerRestored(c, 'back');
    const before = m.restarts;
    await joinAndReport(c, d);
    await until(() => expect(m.restarts).toBeGreaterThan(before));
    await w.restartAll();
    const note = readKeptNote(m.dir)!;
    const out = switchKept(m.dir, 'master', new Date(w.clock.now().getTime() + 6 * DAY));
    expect(out).toMatchObject({ chosen: 'carry-on', folder: c.linkId, keptUntil: note.keptUntil });
    expect(JSON.parse(readFileSync(join(m.dir, 'link.json'), 'utf8'))).toMatchObject({ op: 'restore', linkId: c.linkId });
    // the data kept at the unlink became the backup again
    expect(readManifest(backupDirOf(m.dir, c.linkId))!.kind).toBe('set-aside');
    expect(existsSync(backupDirOf(m.dir, atUnlinkFolder(c.linkId)))).toBe(false);
  }, SLOW);

  it('linkRefusedWhileKeptData: 409 kept_data while the note or an -at-unlink folder is there, 409 unlink_open while a session is open', async () => {
    const c = await setup('S');
    const { m } = c;
    const other = await loginAs(m.app, 'admin');
    let who: Login = m.admin!;
    const show = async (): Promise<{ status: number; code: unknown }> => {
      const r = await m.call('POST', '/api/link/show', { pin: PIN }, { as: who });
      return { status: r.status, code: r.body.code };
    };
    // the control: nothing kept, nothing open: a link may start (and is cancelled)
    expect((await show()).status).toBe(200);
    expect((await m.call('POST', '/api/link/cancel')).status).toBe(200);
    // the note alone
    const note: KeptNote = {
      v: 1, linkId: c.linkId, side: 'master', chosen: 'carry-on', folder: c.linkId, keptUntil: new Date(w.clock.now().getTime() + 7 * DAY).toISOString(),
      followerName: 'Dewan Utama', masterName: 'Surau Al-Hidayah', finishedAt: w.clock.now().toISOString(), outcome: 'done', unlinkId: '1'.repeat(32),
    };
    writeKeptNote(m.dir, note);
    expect(await show()).toEqual({ status: 409, code: 'kept_data' });
    clearKeptNote(m.dir);
    expect((await show()).status).toBe(200);
    expect((await m.call('POST', '/api/link/cancel')).status).toBe(200);
    // an -at-unlink folder alone
    const kept = backupDirOf(m.dir, atUnlinkFolder(c.linkId));
    cpSync(backupDirOf(m.dir, c.linkId), kept, { recursive: true });
    writeManifest(kept, { ...readManifest(kept)!, kind: 'at-unlink' });
    expect(await show()).toEqual({ status: 409, code: 'kept_data' });
    rmSync(kept, { recursive: true, force: true });
    who = other;
    expect((await show()).status).toBe(200);
    expect((await m.call('POST', '/api/link/cancel')).status).toBe(200);
    // an open unlink session
    const third = await loginAs(m.app, 'admin');
    expect((await m.call('POST', '/api/unlink/start', { deviceId: c.deviceId, pin: PIN }, { as: third })).status).toBe(200);
    who = third;
    expect(await show()).toEqual({ status: 409, code: 'unlink_open' });
    // and the kept routes wait for it
    writeKeptNote(m.dir, note);
    expect((await m.call('POST', '/api/unlink/drop-kept', { side: 'master', pin: PIN, confirm: true }, { as: third })).body.code).toBe('unlink_open');
    expect(readKeptNote(m.dir)).not.toBeNull();
  }, SLOW);
});

// ---------------------------------------------------------------- 12

describe('expiry', () => {
  it('unlinkExpiresAfterIdle: no tap for 20 minutes ends `expired`, nothing changed', async () => {
    const c = await setup('S');
    const { m, f } = c;
    seedTv(m, c.deviceId);
    const snap = JSON.stringify([count(m, 'SELECT COUNT(*) AS n FROM change_log'), tvIds(m)]);
    expect((await m.call('POST', '/api/unlink/start', { deviceId: c.deviceId, pin: PIN })).status).toBe(200);
    const a = await m.call('PUT', '/api/unlink/answer', { side: 'follower', choice: 'back' }, { as: c.fAdmin });
    expect(a.status).toBe(200);
    // a tap 19 minutes later keeps it alive for 20 more
    w.clock.tick(19 * 60_000);
    m.admin = await unlockAgain(m, m.admin!);
    expect((await m.call('GET', '/api/unlink/status')).body.session.stage).toBe('answers');
    expect((await m.call('PUT', '/api/unlink/answer', { side: 'master', choice: 'carry-on' })).status).toBe(200);
    w.clock.tick(19 * 60_000);
    expect((await m.call('GET', '/api/unlink/status')).body.session.stage).toBe('answers');
    // then 20 minutes and a second without a tap
    w.clock.tick(61_000);
    m.admin = await unlockAgain(m, m.admin!);
    const end = await m.call('GET', '/api/unlink/status');
    expect(end.body.session).toBeNull();
    expect(end.body.last.outcome).toBe('expired');
    // nothing changed: the follower is linked, its token alive, no note, no journal, no new log line but the start
    expect(count(m, 'SELECT COUNT(*) AS n FROM linked_boxes WHERE removed_at IS NULL')).toBe(1);
    expect(row(m, 'SELECT revoked_at FROM devices WHERE id = ?', c.deviceId)?.revoked_at).toBeNull();
    expect(tvIds(m)).toContain(c.deviceId);
    expect(readKeptNote(m.dir)).toBeNull();
    expect(existsSync(join(m.dir, 'link.json'))).toBe(false);
    expect(JSON.stringify([count(m, 'SELECT COUNT(*) AS n FROM change_log'), tvIds(m)])).toBe(snap);
    expect(f.app.link!.follow.present()).toBe(true);
    // a follower that asks gets no order
    const ord = await m.app.inject({ method: 'POST', url: '/api/link/peer/order', remoteAddress: f.addr, payload: { boxId: f.boxId, linkId: c.linkId } });
    expect(ord.json()).toEqual({ order: null });
    // and an unlink can start again
    expect((await m.call('POST', '/api/unlink/start', { deviceId: c.deviceId, pin: PIN })).status).toBe(200);
  }, SLOW);

  it('joinWindowOver (carry-on): 30 minutes without `joined` end `expired`, the master\'s own change is made, the follower still gets the SAME order', async () => {
    const c = await setup('S');
    const { m, f } = c;
    seedTv(m, c.deviceId);
    const tvBefore = tvIds(m);
    await answerAndAgree(c, 'carry-on');
    const ord = await fetchOrder(c);
    expect((await m.call('GET', '/api/unlink/status', undefined, { as: c.fAdmin })).body.session.stage).toBe('join');
    w.clock.tick(31 * 60_000);
    m.admin = await unlockAgain(m, m.admin!);
    const end = await m.call('GET', '/api/unlink/status');
    expect(end.body.session).toBeNull();
    expect(end.body.last.outcome).toBe('expired');
    expectMasterCarriedOn(c, tvBefore);
    // a late `joined` is not an error for the follower: nothing more to tell
    const note = { unlinkId: String(end.body.last.id), linkId: c.linkId, master: { boxId: m.boxId, name: 'x', pub: loadIdentity(m.dir).publicJwk as never, ca: m.ca, addresses: [m.origin] } };
    expect(await sendUnlinkReport(clientTo(m, f) as never, loadIdentity(f.dir), f.boxId, note as never, 'joined')).toBe(true);
    // the same order again, never `forget`
    const again = await fetchOrder(c);
    expect(again).toEqual(ord);
    expect(f.app.link!.takeOrder!(again)).toBe(true);
    expect(JSON.parse(readFileSync(join(f.dir, 'link.json'), 'utf8')).op).toBe('restore');
  }, SLOW);

  it('joinWindowOver (back): the master restores when the window ends, the note says `expired`', async () => {
    const c = await setup('S');
    const { m } = c;
    await answerAndAgree(c, 'back');
    await fetchOrder(c);
    expect(existsSync(join(m.dir, 'link.json'))).toBe(false);
    const before = m.restarts;
    w.clock.tick(31 * 60_000);
    m.admin = await unlockAgain(m, m.admin!);
    await m.call('GET', '/api/unlink/status');
    expect(JSON.parse(readFileSync(join(m.dir, 'link.json'), 'utf8'))).toMatchObject({ op: 'restore', linkId: c.linkId });
    await until(() => expect(m.restarts).toBeGreaterThan(before));
    await w.restartAll();
    expect(readKeptNote(m.dir)).toMatchObject({ chosen: 'back', outcome: 'expired', side: 'master' });
    expect(m.app.link!.unlinks.status(null).last).toMatchObject({ outcome: 'expired' });
  }, SLOW);

  it('workTimeOut: a follower that fetches its order after the session timed out still gets the SAME order, never forget', async () => {
    const c = await setup('S');
    const { m, f } = c;
    await answerAndAgree(c, 'carry-on');
    // the order the master made, as stored with the session
    const stored = JSON.parse(String(row(m, "SELECT answers_json FROM link_sessions WHERE kind = 'unlink' ORDER BY started_at DESC LIMIT 1")!.answers_json)).work.order as { body: unknown; sig: string };
    // the follower was off: an hour and a minute pass without a fetch
    w.clock.tick(61 * 60_000);
    m.admin = await unlockAgain(m, m.admin!);
    const end = await m.call('GET', '/api/unlink/status');
    expect(end.body.session).toBeNull();
    expect(end.body.last.outcome).toBe('failed');
    // the master changed nothing of its own (the follower never took its order)
    expect(readKeptNote(m.dir)).toBeNull();
    const late = await fetchOrder(c);
    expect(late.order).toBe('revert');
    expect(late.body).toEqual(stored.body);
    expect(late.sig).toBe(stored.sig);
    expect(f.app.link!.takeOrder!(late)).toBe(true);
    expect(JSON.parse(readFileSync(join(f.dir, 'link.json'), 'utf8')).op).toBe('restore');
    // asking again changes nothing
    expect(await fetchOrder(c)).toEqual(late);
  }, SLOW);

  it('cancelledSessionGivesNoOrder: a cancelled unlink hands the follower no order (it keeps following)', async () => {
    const c = await setup('S');
    const { m, f } = c;
    expect((await m.call('POST', '/api/unlink/start', { deviceId: c.deviceId, pin: PIN })).status).toBe(200);
    expect((await m.call('POST', '/api/unlink/cancel')).status).toBe(200);
    const r = await m.app.inject({ method: 'POST', url: '/api/link/peer/order', remoteAddress: f.addr, payload: { boxId: f.boxId, linkId: c.linkId } });
    expect(r.json()).toEqual({ order: null });
    expect(m.app.link!.unlinks.status(null).last).toMatchObject({ outcome: 'cancelled' });
  }, SLOW);
});

// ---------------------------------------------------------------- 13

describe('the follower\'s reports', () => {
  it('peerReport: another box\'s key, a changed body, an extra key, `copied` after a back: refused, the session unchanged', async () => {
    const c = await setup('S');
    const { m, f } = c;
    const x = await w.make(4);
    const xId = loadIdentity(x.dir);
    const fId = loadIdentity(f.dir);
    await answerAndAgree(c, 'carry-on');
    await fetchOrder(c);
    const sj = (await m.call('GET', '/api/unlink/status', undefined, { as: c.fAdmin })).body.session;
    expect(sj.stage).toBe('join');
    const unlinkId = String(sj.id);
    const stateOf = (): string => String(row(m, "SELECT answers_json FROM link_sessions WHERE kind = 'unlink' ORDER BY started_at DESC LIMIT 1")!.answers_json);
    const before = stateOf();
    const post = async (msg: unknown, from: XBox = f): Promise<{ status: number; code: unknown }> => {
      const r = await m.app.inject({ method: 'POST', url: '/api/unlink/peer/report', remoteAddress: from.addr, payload: msg as object });
      return { status: r.statusCode, code: r.json().code };
    };
    const good = { unlinkId, boxId: f.boxId, event: 'joined' };
    const signed = (b: Record<string, unknown>, id = fId, step: 'unlink-report' | 'store-list' = 'unlink-report'): unknown => ({ body: b, sig: signLink(id, step as never, c.linkId, b) });
    const cases: [string, unknown, number, string][] = [
      ['signed by another box', signed(good, xId), 400, 'bad_message'],
      ['signed for another step', signed(good, fId, 'store-list'), 400, 'bad_message'],
      ['signed for another link', { body: good, sig: signLink(fId, 'unlink-report', OTHER32, good) }, 400, 'bad_message'],
      ['body changed after signing (event)', { body: { ...good, event: 'copied' }, sig: signLink(fId, 'unlink-report', c.linkId, good) }, 400, 'bad_message'],
      ['body changed after signing (unlinkId)', { body: { ...good, unlinkId: OTHER32 }, sig: signLink(fId, 'unlink-report', c.linkId, good) }, 400, 'bad_message'],
      ['an extra key, properly signed', signed({ ...good, extra: 1 }), 400, 'bad_message'],
      ['a missing key', signed({ unlinkId, event: 'joined' }), 400, 'bad_message'],
      ['another unlink id, properly signed', signed({ ...good, unlinkId: OTHER32 }), 400, 'bad_message'],
      ['another box id, signed by that box', signed({ ...good, boxId: x.boxId }, xId), 400, 'bad_message'],
      ['an unknown event, properly signed', signed({ ...good, event: 'revert' }), 400, 'bad_message'],
      ['no signature', { body: good }, 400, 'bad_message'],
      ['a signature that is no signature', { body: good, sig: 'AAAA' }, 400, 'bad_message'],
      ['`copied` although the follower chose back', signed({ ...good, event: 'copied' }), 409, 'stale_session'],
    ];
    for (const [name, msg, status, code] of cases) {
      const r = await post(msg);
      expect([r.status, r.code], name).toEqual([status, code]);
      expect(stateOf(), name).toBe(before);
    }
    // not from the surau network: refused before anything is read
    const wan = await m.app.inject({ method: 'POST', url: '/api/unlink/peer/report', remoteAddress: '8.8.8.8', payload: signed(good) as object });
    expect(wan.statusCode).toBe(403);
    expect(stateOf()).toBe(before);
    expect((await m.call('GET', '/api/unlink/status')).body.session.stage).toBe('join');
    expect(row(m, 'SELECT revoked_at FROM devices WHERE id = ?', c.fAdmin.deviceId)?.revoked_at).toBeNull();
    // the control: the right report is taken, once; the phone that answered for the follower now belongs to the follower
    expect(await post(signed(good))).toEqual({ status: 200, code: undefined });
    expect((await m.call('GET', '/api/unlink/status')).body.session).toBeNull();
    expect(row(m, 'SELECT revoked_at FROM devices WHERE id = ?', c.fAdmin.deviceId)?.revoked_at).not.toBeNull();
    // a report after the end is refused as stale
    expect((await post(signed(good))).code).toBe('stale_session');
  }, SLOW);
});

// ---------------------------------------------------------------- 14: D2, the follower leaves by itself

describe('D2: a follower leaves by itself', () => {
  const loopback = '127.0.0.1';
  const post = (f: XBox, path: string, body: unknown, from = loopback, headers: Record<string, string> = { 'x-maxcom-leave': TEST_LEAVE_SECRET }) =>
    f.app.inject({ method: 'POST', url: path, remoteAddress: from, headers, payload: body as object });

  it('revertWrongCode: a wrong code is refused (401) and nothing is planned; the right code restores, and the recovery code of before the link works again', async () => {
    const c = await setup('S', { recovery: true });
    const { f } = c;
    for (const bad of ['AAAA-BBBB-CCCC-DDDD', '', 'x'.repeat(200)]) {
      const r = await post(f, '/api/follow/revert', { recoveryCode: bad });
      expect([r.statusCode, r.json().code], JSON.stringify(bad)).toEqual([401, 'wrong_code']);
    }
    // not even a number as the code, nor no body
    expect((await post(f, '/api/follow/revert', { recoveryCode: 12345 })).json().code).toBe('wrong_code');
    expect(existsSync(join(f.dir, 'link.json'))).toBe(false);
    expect(f.app.link!.follow.present()).toBe(true);
    const ok = await post(f, '/api/follow/revert', { recoveryCode: c.code });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(JSON.parse(readFileSync(join(f.dir, 'link.json'), 'utf8'))).toMatchObject({ op: 'restore', linkId: c.linkId });
    await w.restartAll();
    expect(f.app.link!.follow.present()).toBe(false);
    // the box is its own again: the code of before the link opens it, the wrong ones do not
    expect(verifyRecoveryCode(f.app.surau.db, c.code)).toBe(true);
    expect(verifyRecoveryCode(f.app.surau.db, 'AAAA-BBBB-CCCC-DDDD')).toBe(false);
    expect(count(f, "SELECT COUNT(*) AS n FROM devices WHERE platform <> 'kiosk' AND revoked_at IS NULL")).toBe(0);
  }, SLOW);

  it('revertKeptData: the follower own way back leaves its data kept, shown in the unlink status; "Buang data lama" removes it and the box may link again; "Tukar pilihan" is not offered', async () => {
    const c = await setup('S', { recovery: true });
    const { f } = c;
    const ok = await post(f, '/api/follow/revert', { recoveryCode: c.code });
    expect(ok.statusCode, ok.body).toBe(200);
    await w.restartAll();
    const dir = backupDirOf(f.dir, atUnlinkFolder(c.linkId));
    expect(existsSync(dir)).toBe(true);
    const status = f.app.link!.unlinks.status(null);
    expect(status.kept).toHaveLength(1);
    expect(status.kept[0]).toMatchObject({ side: 'follower', chosen: 'back', switchable: false });
    expect(Date.parse(status.kept[0]!.keptUntil)).toBeGreaterThan(w.clock.now().getTime() + 6 * DAY);
    // the link refuses with kept_data; the window shown is the one of the link screens
    expect((await f.call('GET', '/api/link/backup')).body.kept).not.toBeNull();
    const other = await loginAs(f.app, 'admin');
    const sw = await f.call('POST', '/api/unlink/switch', { side: 'follower', pin: PIN, confirm: true }, { as: other });
    expect([sw.status, sw.body.code]).toEqual([409, 'no_kept_data']);
    expect(existsSync(dir)).toBe(true);
    const drop = await f.call('POST', '/api/unlink/drop-kept', { side: 'follower', pin: PIN, confirm: true }, { as: other });
    expect(drop.status, JSON.stringify(drop.body)).toBe(200);
    expect(drop.body.kept).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(readKeptNote(f.dir)).toBeNull();
    expect((await f.call('POST', '/api/link/show', { pin: PIN }, { as: other })).status).toBe(200);
  }, SLOW);

  it('revertNoBackup: a follower that was a new box answers 409 no_backup; empty works there, and has_backup where a backup exists', async () => {
    const m = await w.make(1);
    const f = await w.make(2, { setUp: false });
    const linkId = await linkNewBox(m, f);
    const r = await post(f, '/api/follow/revert', { recoveryCode: 'AAAA-BBBB-CCCC-DDDD' });
    expect([r.statusCode, r.json().code]).toEqual([409, 'no_backup']);
    // no wrong try was counted for it
    expect(existsSync(join(f.dir, 'link-revert-attempts.json'))).toBe(false);
    expect(existsSync(join(f.dir, 'link.json'))).toBe(false);
    const e = await post(f, '/api/follow/empty', {});
    expect(e.statusCode, e.body).toBe(200);
    expect(JSON.parse(readFileSync(join(f.dir, 'link.json'), 'utf8'))).toMatchObject({ op: 'forget', linkId });
    await w.restartAll();
    expect(f.app.link!.follow.present()).toBe(false);
    expect(count(f, 'SELECT COUNT(*) AS n FROM users')).toBe(0);
    // a box that has its backup is never emptied this way
    const c = await setup('S');
    const h = await post(c.f, '/api/follow/empty', {});
    expect([h.statusCode, h.json().code]).toEqual([409, 'has_backup']);
    expect(existsSync(join(c.f.dir, 'link.json'))).toBe(false);
    expect(c.f.app.link!.follow.present()).toBe(true);
  }, SLOW);

  it('revertAttemptsLimited: the 6th try within the hour is 429 locked even with the right code (counted across a restart); after the hour the right code works', async () => {
    const c = await setup('S', { recovery: true });
    const { f } = c;
    for (let i = 0; i < 3; i++) expect((await post(f, '/api/follow/revert', { recoveryCode: 'AAAA-BBBB-CCCC-DDDD' })).json().code).toBe('wrong_code');
    // the count lives outside the store: a restart does not give the tries back
    await w.restartAll();
    for (let i = 0; i < 2; i++) expect((await post(f, '/api/follow/revert', { recoveryCode: 'AAAA-BBBB-CCCC-DDDD' })).json().code).toBe('wrong_code');
    const locked = await post(f, '/api/follow/revert', { recoveryCode: c.code });
    expect([locked.statusCode, locked.json().code]).toEqual([429, 'locked']);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(locked.headers['retry-after'])).toBeLessThanOrEqual(3600);
    expect(locked.json().retryAfterSec).toBe(Number(locked.headers['retry-after']));
    expect(existsSync(join(f.dir, 'link.json'))).toBe(false);
    // a wrong code while locked is the same lock, and does not extend it
    expect((await post(f, '/api/follow/revert', { recoveryCode: 'AAAA-BBBB-CCCC-DDDD' })).statusCode).toBe(429);
    w.clock.tick(30 * 60_000);
    expect((await post(f, '/api/follow/revert', { recoveryCode: c.code })).statusCode).toBe(429);
    w.clock.tick(30 * 60_000 + 5000);
    const ok = await post(f, '/api/follow/revert', { recoveryCode: c.code });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(JSON.parse(readFileSync(join(f.dir, 'link.json'), 'utf8')).op).toBe('restore');
    // the right code cleared the count
    expect(JSON.parse(readFileSync(join(f.dir, 'link-revert-attempts.json'), 'utf8'))).toEqual({ fails: [] });
  }, SLOW);

  it('leaveSecret: both routes need the per-start secret in X-Maxcom-Leave; wrong, missing, short and long are 400 not_local with nothing planned; the right one works', async () => {
    const c = await setup('S', { recovery: true });
    const { f } = c;
    const wrong = 'd4'.repeat(32);
    const nearly = TEST_LEAVE_SECRET.slice(0, 63) + (TEST_LEAVE_SECRET.endsWith('0') ? '1' : '0');
    for (const path of ['/api/follow/revert', '/api/follow/empty']) {
      for (const [name, headers] of [
        ['no header', {}],
        ['a wrong secret', { 'x-maxcom-leave': wrong }],
        ['one character off', { 'x-maxcom-leave': nearly }],
        ['too short', { 'x-maxcom-leave': TEST_LEAVE_SECRET.slice(0, 32) }],
        ['too long', { 'x-maxcom-leave': TEST_LEAVE_SECRET + 'c3' }],
        ['empty', { 'x-maxcom-leave': '' }],
        ['the secret in a cookie', { cookie: 'x-maxcom-leave=' + TEST_LEAVE_SECRET }],
      ] as const) {
        const r = await post(f, path, { recoveryCode: c.code }, loopback, headers as Record<string, string>);
        expect([r.statusCode, r.json().code], `${path} ${name}`).toEqual([400, 'not_local']);
      }
    }
    expect(existsSync(join(f.dir, 'link.json'))).toBe(false);
    expect(existsSync(join(f.dir, 'link-revert-attempts.json'))).toBe(false);
    expect(f.app.link!.follow.present()).toBe(true);
    // the secret is checked before the code: a wrong code with no secret is not counted as a try
    const ok = await post(f, '/api/follow/revert', { recoveryCode: c.code });
    expect(ok.statusCode, ok.body).toBe(200);
  }, SLOW);

  it('leaveSecretMissing: a box built with no secret, or a malformed one, refuses both routes even for the right caller (fail closed)', async () => {
    const c = await setup('S', { recovery: true });
    const { f } = c;
    for (const bad of [undefined, '', 'abc', 'zz'.repeat(32)]) {
      const app = buildApp(join(f.dir, 'surau.db'), { dataDir: f.dir, ...(bad !== undefined ? { leaveSecret: bad } : {}), link: { restart: () => undefined } });
      try {
        await app.ready();
        for (const path of ['/api/follow/revert', '/api/follow/empty']) {
          for (const h of [{}, { 'x-maxcom-leave': bad ?? '' }, { 'x-maxcom-leave': TEST_LEAVE_SECRET }]) {
            const r = await app.inject({ method: 'POST', url: path, remoteAddress: loopback, headers: h as Record<string, string>, payload: { recoveryCode: c.code } });
            expect([r.statusCode, r.json().code], `${String(bad)} ${path}`).toEqual([400, 'not_local']);
          }
        }
      } finally {
        await app.close();
      }
    }
    expect(existsSync(join(f.dir, 'link.json'))).toBe(false);
  }, SLOW);

  it('revertNotFromLan: the surau network, the box\'s own LAN address and a forwarded loopback are refused 400 not_local, for revert and empty', async () => {
    const c = await setup('S', { recovery: true });
    const { f, m } = c;
    for (const path of ['/api/follow/revert', '/api/follow/empty']) {
      for (const [name, from, headers] of [
        ['a LAN address', '10.168.50.99', {}],
        ['the box\'s own LAN address', f.addr, {}],
        ['the master', m.addr, {}],
        ['a forwarded loopback', '10.168.50.99', { 'x-forwarded-for': '127.0.0.1' }],
        ['a proxied loopback', '127.0.0.1', { 'x-forwarded-for': '10.168.50.99' }],
        ['a public address', '8.8.8.8', {}],
      ] as const) {
        const r = await post(f, path, { recoveryCode: c.code }, from, { 'x-maxcom-leave': TEST_LEAVE_SECRET, ...(headers as Record<string, string>) });
        expect([r.statusCode, r.json().code], `${path} from ${name}`).toEqual([400, 'not_local']);
      }
    }
    // nothing was planned, no try counted, the box still follows
    expect(existsSync(join(f.dir, 'link.json'))).toBe(false);
    expect(existsSync(join(f.dir, 'link-revert-attempts.json'))).toBe(false);
    expect(f.app.link!.follow.present()).toBe(true);
  }, SLOW);

  it('masterToldLeft: the master takes the box off at once, `leftByItself`, and an open unlink of that box at its answers ends cancelled', async () => {
    const c = await setup('S', { recovery: true });
    const { m, f } = c;
    const rec = f.app.link!.follow.read()!;
    const fId = loadIdentity(f.dir);
    const x = await w.make(4);
    const xId = loadIdentity(x.dir);
    seedTv(m, c.deviceId);
    expect((await m.call('POST', '/api/unlink/start', { deviceId: c.deviceId, pin: PIN })).status).toBe(200);
    expect((await m.call('PUT', '/api/unlink/answer', { side: 'follower', choice: 'back' }, { as: c.fAdmin })).status).toBe(200);
    const sendLeft = async (msg: unknown): Promise<{ status: number; code: unknown }> => {
      const r = await m.app.inject({ method: 'POST', url: '/api/unlink/peer/report', remoteAddress: f.addr, payload: msg as object });
      return { status: r.statusCode, code: r.json().code };
    };
    const body = { boxId: f.boxId, linkId: c.linkId, event: 'left' };
    // forged `left`: another box's key, another link, an extra key, a changed body
    expect(await sendLeft({ body, sig: signLink(xId, 'unlink-report', c.linkId, body) })).toEqual({ status: 400, code: 'bad_message' });
    expect(await sendLeft({ body: { ...body, extra: 1 }, sig: signLink(fId, 'unlink-report', c.linkId, { ...body, extra: 1 }) })).toEqual({ status: 400, code: 'bad_message' });
    expect(await sendLeft({ body: { ...body, linkId: OTHER32 }, sig: signLink(fId, 'unlink-report', OTHER32, { ...body, linkId: OTHER32 }) })).toEqual({ status: 404, code: 'not_found' });
    expect(await sendLeft({ body, sig: signLink(fId, 'unlink-report', c.linkId, { ...body, event: 'joined' }) })).toEqual({ status: 400, code: 'bad_message' });
    expect(count(m, 'SELECT COUNT(*) AS n FROM linked_boxes WHERE removed_at IS NULL')).toBe(1);
    expect((await m.call('GET', '/api/unlink/status')).body.session.stage).toBe('answers');
    // the follower leaves by itself, then tells the master
    const ok = await post(f, '/api/follow/revert', { recoveryCode: c.code });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await tellMasterLeft(clientTo(m, f) as never, fId, f.boxId, { ...rec, addresses: [m.origin] })).toBe(true);
    const boxes = (await m.call('GET', '/api/boxes')).body.boxes as { boxId: string; removedAt: string | null; leftByItself: boolean }[];
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.removedAt).not.toBeNull();
    expect(boxes[0]!.leftByItself).toBe(true);
    expect(row(m, 'SELECT revoked_at FROM devices WHERE id = ?', c.deviceId)?.revoked_at).not.toBeNull();
    expect(count(m, 'SELECT COUNT(*) AS n FROM kiosk_cookies WHERE device_id = ?', c.deviceId)).toBe(0);
    // the unlink that was open at its answers ended `cancelled`; its answers are gone with it
    const end = await m.call('GET', '/api/unlink/status');
    expect(end.body.session).toBeNull();
    expect(end.body.last.outcome).toBe('cancelled');
    const late = await m.call('POST', '/api/unlink/agree', { side: 'follower', rev: 2, confirm: true, pin: PIN }, { as: c.fAdmin });
    expect([late.status, late.body.code]).toEqual([409, 'stale_session']);
    // the master changed nothing else of its own: no kept note, no restore, the TV profile as it was
    expect(readKeptNote(m.dir)).toBeNull();
    expect(existsSync(join(m.dir, 'link.json'))).toBe(false);
    // the box is the follower's no longer: it can be unlinked no more, and a new unlink of it is refused
    const again = await m.call('POST', '/api/unlink/start', { deviceId: c.deviceId, pin: PIN });
    expect([again.status, again.body.code]).toEqual([409, 'not_linked']);
    // a repeat of the same note is harmless
    expect(await sendLeft({ body, sig: signLink(fId, 'unlink-report', c.linkId, body) })).toEqual({ status: 404, code: 'not_found' });
    await w.restartAll();
    expect(f.app.link!.follow.present()).toBe(false);
  }, SLOW);
});

// ---------------------------------------------------------------- 15: O23, a follower that is never seen again

describe('O23: stale follower rows', () => {
  it('notSeenSince: the master lists a follower unseen for more than 3 days with the time it was last seen; seen, or a removed row, shows null; nothing is removed by itself', async () => {
    const c = await setup('S');
    const { m } = c;
    const list = async (): Promise<{ boxId: string; notSeenSince: string | null; removedAt: string | null }[]> => (await m.call('GET', '/api/boxes')).body.boxes;
    const setSeen = (iso: string | null): void => {
      m.app.surau.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(iso, c.deviceId);
    };
    const ago = (ms: number): string => new Date(w.clock.now().getTime() - ms).toISOString();
    // seen a moment ago, and exactly 3 days ago: not stale yet
    setSeen(ago(60_000));
    expect((await list())[0]!.notSeenSince).toBeNull();
    setSeen(ago(3 * DAY));
    expect((await list())[0]!.notSeenSince).toBeNull();
    // 3 days and a minute: stale, with the time it was last seen
    const stale = ago(3 * DAY + 60_000);
    setSeen(stale);
    const row1 = (await list())[0]!;
    expect(row1.notSeenSince).toBe(stale);
    expect(row1.removedAt).toBeNull();
    // never seen at all: counted from the day of the link (linked now, so not stale), then from a link 10 days old
    setSeen(null);
    expect((await list())[0]!.notSeenSince).toBeNull();
    m.app.surau.db.prepare('UPDATE linked_boxes SET linked_at = ? WHERE device_id = ?').run(ago(10 * DAY), c.deviceId);
    expect((await list())[0]!.notSeenSince).toBe(ago(10 * DAY));
    // a row that was taken off is not "unseen": null
    m.app.surau.db.prepare('UPDATE linked_boxes SET removed_at = ? WHERE device_id = ?').run(w.clock.now().toISOString(), c.deviceId);
    expect((await list())[0]!.notSeenSince).toBeNull();
    // the stale row is never removed by the box itself
    m.app.surau.db.prepare('UPDATE linked_boxes SET removed_at = NULL WHERE device_id = ?').run(c.deviceId);
    setSeen(ago(30 * DAY));
    const after = await list();
    expect(after).toHaveLength(1);
    expect(after[0]!.removedAt).toBeNull();
    expect(after[0]!.notSeenSince).not.toBeNull();
  }, SLOW);

  it('masterUnreachableSince on the follower TV: null at first, the time of the link after 6 hours of silence; a main box never carries it; the follower keeps its link', async () => {
    const c = await setup('S');
    const { m, f } = c;
    expect((await f.tv()).body.masterUnreachableSince).toBeNull();
    expect((await m.tv()).body.masterUnreachableSince).toBeNull();
    const restartsBefore = f.restarts;
    w.clock.tick(5 * 3_600_000);
    expect((await f.tv()).body.masterUnreachableSince).toBeNull();
    w.clock.tick(2 * 3_600_000);
    const since = (await f.tv()).body.masterUnreachableSince as string;
    expect(Date.parse(since)).toBe(Date.parse(f.app.link!.follow.read()!.linkedAt));
    expect((await m.tv()).body.masterUnreachableSince).toBeNull();
    // a second TV of the follower (paired by code, not the box's own screen) shows the notice too, and still gets no QR or code (I11)
    const now = w.clock.now();
    // the follower holds no people of its own after the link: a TV device is added by hand (no approver to name)
    const fdb = f.app.surau.db;
    fdb.exec('PRAGMA foreign_keys = OFF');
    const pairing = beginPairing(fdb, '10.168.1.77', now);
    approvePairing(fdb, { code: pairing.code, deviceName: 'TV bilik lain' }, 'nobody', 'test', now, LOCAL_SURAU_ID);
    fdb.exec('PRAGMA foreign_keys = ON');
    const polled = pollPairing(fdb, pairing.pollToken, now);
    if (polled.status !== 'approved') throw new Error('TV not paired');
    const other = await f.call('GET', '/api/kiosk/link', undefined, { as: null, from: '10.168.1.77', headers: { cookie: buildKioskCookie(polled.cookieToken, false).split(';')[0]! } });
    expect(other.status).toBe(200);
    expect(other.body.masterUnreachableSince).toBe(since);
    expect([other.body.qr, other.body.code, other.body.step]).toEqual([null, null, null]);
    // it only informs: no leave note, no restart, still a follower
    expect(f.app.link!.follow.present()).toBe(true);
    expect(f.restarts).toBe(restartsBefore);
  }, SLOW);
});
