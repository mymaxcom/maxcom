import { webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beginEnrolment } from '../src/auth/devices.ts';
import { sha256hex } from '../src/auth/crypto.ts';
import { createMovesStore } from '../src/follow/moves.ts';
import { isGiverAdmin } from '../src/link/work.ts';
import { CameraStore } from '../src/live/camera.ts';
import { TokenStore } from '../src/live/youtube/tokenStore.ts';
import { issueRecoveryCode, verifyRecoveryCode } from '../src/setup/codes.ts';
import { loadIdentity } from '../src/setup/identity.ts';
import { generateSyncKeyPair, loadSyncKey, saveSyncKey } from '../src/sync/syncKey.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { pairTv } from './support/pairTv.ts';
import { createXWorld, outcomeOf, PIN, unlockAgain, until } from './support/caseXWorld.ts';
import type { XBox, XWorld } from './support/caseXWorld.ts';

/**
 * Cases X and N-X end to end: two real boxes with real data folders go through a whole link (the real routes, the
 * master's pull of the giver's store over the giver's own file route), then both are "restarted" the way `main.ts`
 * does it (the start-up journal, the adopt, the apps built again on the same folders).
 *
 * G = the box whose data is kept (it scans and becomes the follower). M = the master (it shows the QR). In N-X, M was
 * never set up.
 */

let w: XWorld;
beforeEach(() => {
  w = createXWorld();
});
afterEach(async () => {
  await w.close();
});

const YT = { refreshToken: 'refresh-token-of-g', accessToken: 'access-of-g', expiresAt: 4_102_444_800_000, channelId: 'UC-surau', channelTitle: 'Surau Al-Hidayah', scope: 'youtube', streamId: 'stream-1' };
const CAM_URL = 'rtsp://admin:Sup3rSecret@10.168.50.40:554/stream1';
const POSTER = Buffer.from('poster one: bytes of a picture');
const VIDEO = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 7) % 251));

const put = (dir: string, rel: string, data: Buffer | string): void => {
  const abs = join(dir, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
};

interface Seeded {
  gMedia: Login;
  gCode: string;
  gKiosk: { cookie: string; deviceId: string };
  gEnrolCode: string;
  gSync: Buffer;
  mSync: Buffer;
  gSiteToken: string;
  mSiteToken: string;
}

const syncData = (dir: string, token: string) => {
  const pair = generateSyncKeyPair();
  saveSyncKey(dir, { ...pair, cloudUrl: 'https://cloud.invalid', siteToken: token, wakeSecret: `wake-${token}`, linkedAt: '2026-11-01T00:00:00.000Z' });
};

/** Real data on both boxes before they meet: content, media, credentials, sign-ins, cloud keys. */
async function seed(g: XBox, m: XBox, o: { mHasStore: boolean }): Promise<Seeded> {
  const gdb = g.app.surau.db;
  expect((await g.call('PUT', '/api/settings/surauInfo', { name: 'Surau Al-Hidayah G' })).status).toBe(200);
  gdb.prepare("INSERT INTO content_items (surau_id, kind, id, json, updated_at, updated_by) VALUES ('sdm', 'announcements', 'a-1', ?, '2026-11-01T00:00:00.000Z', 'test')").run('{"title":"Kuliah Subuh"}');
  put(g.dir, 'assets/poster-1.jpg', POSTER);
  put(g.dir, 'assets/sub/video-1.mp4', VIDEO);
  put(g.dir, 'finance/photos/receipt-1.jpg', 'receipt bytes');
  put(g.dir, 'themes/hijau/theme.json', '{"name":"Hijau"}');
  const gMedia = await loginAs(g.app, 'media');
  const gKiosk = await pairTv(g.app, g.admin!);
  expect((await g.call('GET', '/api/kiosk/bundle', undefined, { as: null, from: '10.168.1.77', headers: { cookie: gKiosk.cookie } })).status).toBe(200);
  const gEnrolCode = beginEnrolment(gdb, { userId: g.admin!.userId, deviceName: 'Telefon baru' }, 'test', { canManageSuperadmin: true }).code;
  const gCode = issueRecoveryCode(gdb);
  new TokenStore(g.dir).save(YT);
  new CameraStore(g.dir).save({ url: CAM_URL });
  syncData(g.dir, 'G-site-token-0001');
  if (o.mHasStore) {
    expect((await m.call('PUT', '/api/settings/surauInfo', { name: 'Surau M lama' })).status).toBe(200);
    m.app.surau.db.prepare("INSERT INTO content_items (surau_id, kind, id, json, updated_at, updated_by) VALUES ('sdm', 'announcements', 'm-only', ?, '2026-11-01T00:00:00.000Z', 'test')").run('{"title":"Hanya M"}');
    put(m.dir, 'assets/mine.jpg', 'm-picture');
    syncData(m.dir, 'M-site-token-0002');
  }
  return {
    gMedia, gCode, gKiosk, gEnrolCode,
    gSync: readFileSync(join(g.dir, 'secret', 'sync.key')),
    mSync: o.mHasStore ? readFileSync(join(m.dir, 'secret', 'sync.key')) : Buffer.alloc(0),
    gSiteToken: 'G-site-token-0001', mSiteToken: 'M-site-token-0002',
  };
}

/** G scans M's QR (M shows), M approves, the answers keep G's data under M as master, both agree. */
async function link(m: XBox, g: XBox, kind: 'X' | 'N-X', phones?: 'direct' | 'code', afterAgreed?: () => void /* runs after the giver agreed, before the master does */): Promise<string> {
  if (kind === 'X') {
    expect((await m.call('POST', '/api/link/show', { pin: PIN })).status).toBe(200);
  }
  const qr = String((await m.tv()).body.qr?.payload ?? '');
  const scan = await g.call('POST', '/api/link/scan', { pin: PIN, qr });
  if (scan.status !== 200) throw new Error(`scan ${scan.status} ${JSON.stringify(scan.body)}`);
  const ap = await (kind === 'X' ? m : g).call('POST', '/api/link/approve', { ok: true });
  if (ap.status !== 200) throw new Error(`approve ${ap.status} ${JSON.stringify(ap.body)}`);
  const linkId = String(ap.body.session.id);
  const put = await g.call('PUT', '/api/link/answers', { keep: 'scan', master: 'show', roles: {}, ...(phones === undefined ? {} : { phones }), financeTick: false });
  if (put.status !== 200) throw new Error(`answers ${put.status} ${JSON.stringify(put.body)}`);
  expect(put.body.session.case).toBe(kind);
  const rev = put.body.session.answers.rev;
  const a1 = await g.call('POST', '/api/link/agree', { rev });
  if (a1.status !== 200) throw new Error(`agree g ${a1.status} ${JSON.stringify(a1.body)}`);
  afterAgreed?.();
  if (kind === 'X') {
    const a2 = await m.call('POST', '/api/link/agree', { rev });
    if (a2.status !== 200) throw new Error(`agree m ${a2.status} ${JSON.stringify(a2.body)}`);
  }
  return linkId;
}

async function newPhone(): Promise<{ publicJwk: Record<string, unknown>; sign: (m: Uint8Array) => Promise<string> }> {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  return {
    publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    sign: async (msg) => Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Buffer.from(msg))).toString('base64url'),
  };
}

/** A phone enrols at a box with a code; then signs in with its PIN. Returns the enrol answer and the sign-in token. */
async function enrol(box: XBox, code: string): Promise<{ status: number; token: string | null; body: Record<string, any> }> {
  const phone = await newPhone();
  const r = await box.app.inject({ method: 'POST', url: '/api/enrol/complete', remoteAddress: box.addr, payload: { code, publicJwk: phone.publicJwk, platform: 'web', pin: PIN } });
  const body = (() => { try { return r.json() as Record<string, any>; } catch { return {}; } })();
  if (r.statusCode !== 200) return { status: r.statusCode, token: null, body };
  const deviceId = String(body.deviceId);
  const ch = await box.app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress: box.addr, payload: { deviceId } });
  const nonce = String(ch.json().nonce);
  const sig = await phone.sign(new TextEncoder().encode(`surau-unlock\n${box.boxId}\n${deviceId}\n${nonce}`));
  const un = await box.app.inject({ method: 'POST', url: '/api/auth/unlock', remoteAddress: box.addr, payload: { deviceId, nonce, signature: sig, pin: PIN } });
  return { status: 200, token: un.statusCode === 200 ? String(un.json().token) : null, body };
}

const bothLinked = async (m: XBox, g: XBox): Promise<void> => {
  await until(() => {
    expect(outcomeOf(m)).toBe('linked');
    expect(outcomeOf(g)).toBe('linked');
  });
  await m.app.link!.work.idle();
};

const treeOf = (dir: string): string[] => {
  const out: string[] = [];
  const go = (d: string, base: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel = base === '' ? e.name : `${base}/${e.name}`;
      if (e.isDirectory()) go(join(d, e.name), rel);
      else out.push(rel);
    }
  };
  go(dir, '');
  return out.sort();
};

describe('case X end to end (both boxes set up)', () => {
  it('caseXEndToEnd: after both restarts M serves G\'s content, G follows M, M lists G, M\'s own admin signs in again with the same phone key', async () => {
    const m = await w.make(1);
    const g = await w.make(2);
    const s = await seed(g, m, { mHasStore: true });
    const mAdmin = m.admin!;
    const mAdminId = mAdmin.userId;
    const linkId = await link(m, g, 'X');
    await bothLinked(m, g);

    // nothing of M's store moved yet: the adopt waits for the next start
    expect(existsSync(join(m.dir, 'link.json'))).toBe(true);
    expect(existsSync(join(m.dir, 'link-adopt.json'))).toBe(true);
    expect(m.app.surau.db.prepare("SELECT 1 AS x FROM content_items WHERE id = 'm-only'").get()).toBeDefined();
    // the master pulled the giver's files over the giver's file route, and the percent rose on the commit step
    const mine = w.files.filter((f) => f.from === m.origin);
    expect(mine.length).toBeGreaterThanOrEqual(5);
    expect(mine.every((f) => f.status === 200)).toBe(true);
    const pct = mine.map((f) => f.progress).filter((p) => p !== null && p.step === 'commit').map((p) => p!.percent as number);
    expect(pct.length).toBe(mine.length);
    for (let i = 1; i < pct.length; i++) expect(pct[i]!).toBeGreaterThanOrEqual(pct[i - 1]!);
    expect(pct[0]).toBe(0);
    expect(pct[pct.length - 1]!).toBeGreaterThan(pct[0]!);
    // G kept the phone-move list (G's media person may move to M with a ticket)
    const moves = createMovesStore(g.dir, loadIdentity(g.dir), g.boxId).read();
    const ticket = moves!.entries.find((e) => e.userId === s.gMedia.userId)!.ticket;
    await until(() => expect(m.restarts + g.restarts).toBeGreaterThanOrEqual(2));

    await w.restartAll();

    // the journal and everything it left are gone
    for (const f of ['link.json', 'link-adopt.json']) expect(existsSync(join(m.dir, f))).toBe(false);
    expect(existsSync(join(m.dir, 'linkstage'))).toBe(false);
    m.admin = await unlockAgain(m, mAdmin);
    // M serves G's content
    const settings = await m.call('GET', '/api/settings');
    expect(settings.status).toBe(200);
    expect(settings.body.surauInfo.name).toBe('Surau Al-Hidayah G');
    expect(m.app.surau.db.prepare("SELECT 1 AS x FROM content_items WHERE id = 'a-1'").get()).toBeDefined();
    expect(m.app.surau.db.prepare("SELECT 1 AS x FROM content_items WHERE id = 'm-only'").get()).toBeUndefined();
    expect(readFileSync(join(m.dir, 'assets', 'poster-1.jpg')).equals(POSTER)).toBe(true);
    expect(readFileSync(join(m.dir, 'assets', 'sub', 'video-1.mp4')).equals(VIDEO)).toBe(true);
    // M's admin (carried) calls admin routes with the same phone key
    const users = await m.call('GET', '/api/users');
    expect(users.status).toBe(200);
    expect(JSON.stringify(users.body)).toContain(mAdminId);
    // G follows M
    const follow = g.app.link!.follow.read()!;
    expect(g.app.link!.follow.present()).toBe(true);
    expect(follow.masterBoxId).toBe(m.boxId);
    expect(follow.linkId).toBe(linkId);
    const tv = await g.tv();
    expect(tv.body.mode).toBe('follower');
    // M lists G
    const boxes = await m.call('GET', '/api/boxes');
    expect(boxes.status).toBe(200);
    expect(boxes.body.self.mode).toBe('main');
    expect(boxes.body.boxes).toHaveLength(1);
    expect(boxes.body.boxes[0].boxId).toBe(g.boxId);
    expect(boxes.body.boxes[0].removedAt ?? null).toBeNull();
    // the recovery code is given once on the admin's status read
    const st1 = await m.call('GET', '/api/link/status');
    expect(st1.status).toBe(200);
    expect(String(st1.body.recoveryCode)).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
    expect(st1.body.last).toMatchObject({ id: linkId, outcome: 'linked' });
    expect(verifyRecoveryCode(m.app.surau.db, String(st1.body.recoveryCode))).toBe(true);
    expect(verifyRecoveryCode(m.app.surau.db, s.gCode)).toBe(false);
    // read again within 15 minutes (a lost answer): the same code; past them, gone
    const st2 = await m.call('GET', '/api/link/status');
    expect(st2.body.recoveryCode).toBe(st1.body.recoveryCode);
    w.clock.tick(16 * 60_000);
    expect((await m.call('GET', '/api/link/status')).body.recoveryCode).toBeNull();
    // G's media person moves to M with the ticket (an ordinary enrolment code there)
    const moved = await enrol(m, ticket);
    expect(moved.status).toBe(200);
    expect(moved.token).not.toBeNull();
    // G's own store is G's backup now (G is a follower: it mirrors M)
    expect(existsSync(join(g.dir, 'linkundo', linkId))).toBe(true);
  }, 90_000);

  it('caseXLinkingAdminTicket: the giver linking admin gets a 30-minute one-use ticket, another admin of the giver gets none, the media person keeps the long one, and the ticket enrols the admin phone on M', async () => {
    const m = await w.make(1);
    const g = await w.make(2);
    const s = await seed(g, m, { mHasStore: true });
    const gAdmin = g.admin!;
    const gOtherAdmin = await loginAs(g.app, 'admin');
    expect(gOtherAdmin.userId).not.toBe(gAdmin.userId);
    await link(m, g, 'X', 'code');
    await bothLinked(m, g);
    const moves = createMovesStore(g.dir, loadIdentity(g.dir), g.boxId).read()!;
    const adminTicket = moves.entries.find((e) => e.userId === gAdmin.userId)!.ticket;
    expect(adminTicket).toMatch(/\S/);
    expect(moves.entries.some((e) => e.userId === gOtherAdmin.userId)).toBe(false);
    const mediaTicket = moves.entries.find((e) => e.userId === s.gMedia.userId)!.ticket;
    // each entry tells its own end: the linking admin's 30 minutes, the media person's long one; the file keeps the long end
    const linkedAt = w.clock.now().getTime();
    const adminEnd = Date.parse(moves.entries.find((e) => e.userId === gAdmin.userId)!.expiresAt!) - linkedAt;
    expect(adminEnd).toBeGreaterThan(25 * 60_000);
    expect(adminEnd).toBeLessThanOrEqual(31 * 60_000);
    expect(Date.parse(moves.entries.find((e) => e.userId === s.gMedia.userId)!.expiresAt!) - linkedAt).toBeGreaterThan(24 * 3600_000);
    expect(Date.parse(moves.expiresAt) - linkedAt).toBeGreaterThan(24 * 3600_000);
    await until(() => expect(m.restarts + g.restarts).toBeGreaterThanOrEqual(2));
    const at = w.clock.now().getTime();

    await w.restartAll();

    const expiryOf = (code: string): number => {
      const row = m.app.surau.db.prepare('SELECT expires_at FROM enrolments WHERE code_hash = ?').get(sha256hex(code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()));
      return row === undefined ? NaN : Date.parse(String(row.expires_at)) - at;
    };
    const adminLeft = expiryOf(adminTicket);
    expect(adminLeft).toBeGreaterThan(25 * 60_000);
    expect(adminLeft).toBeLessThanOrEqual(31 * 60_000);
    // the media person's ticket is the ordinary long one
    expect(expiryOf(mediaTicket)).toBeGreaterThan(24 * 3600_000);
    // another admin of G has no ticket row at all on M
    expect(m.app.surau.db.prepare('SELECT 1 AS x FROM enrolments WHERE user_id = ?').get(gOtherAdmin.userId)).toBeUndefined();
    // the linking admin's phone moves with its ticket, with the admin role, once
    const me = await enrol(m, adminTicket);
    expect(me.status).toBe(200);
    expect(me.token).not.toBeNull();
    const as: Login = { token: me.token!, userId: gAdmin.userId, deviceId: String(me.body.deviceId), roles: ['admin'], headers: { authorization: `Bearer ${me.token}` }, baseVersion: 0, relogin: async () => me.token!, sign: async () => '' };
    expect((await m.call('GET', '/api/users', undefined, { as })).status).toBe(200);
    expect((await enrol(m, adminTicket)).status).toBeGreaterThanOrEqual(400);
    // 30 minutes later an unused admin ticket would be dead
  }, 90_000);

  it('caseXRejectedGiverAdmin: a linking admin id that is not a person of the list the giver sent gets no ticket in the commit result', async () => {
    const m = await w.make(1);
    const g = await w.make(2);
    const s = await seed(g, m, { mHasStore: true });
    const gAdmin = g.admin!;
    // the giver names a linking admin the list it sent does not hold (a buggy or hostile giver)
    await link(m, g, 'X', 'code', () => {
      g.app.surau.db.prepare('UPDATE link_sessions SET pin_proof_user = ? WHERE pin_proof_user = ?').run('ghost-admin-0001', gAdmin.userId);
    });
    await bothLinked(m, g);
    const moves = createMovesStore(g.dir, loadIdentity(g.dir), g.boxId).read()!;
    expect(moves.entries.some((e) => e.userId === 'ghost-admin-0001')).toBe(false);
    expect(moves.entries.some((e) => e.userId === gAdmin.userId)).toBe(false);
    // the commit went through, and the people with an ordinary phone keep theirs
    expect(moves.entries.some((e) => e.userId === s.gMedia.userId)).toBe(true);
  });

  it('caseXDirectPhones: with the choice "direct" every admin of the giver with a phone gets a ticket with the long life, and the other admin phone enrols on M', async () => {
    const m = await w.make(1);
    const g = await w.make(2);
    const s = await seed(g, m, { mHasStore: true });
    const gAdmin = g.admin!;
    const gOtherAdmin = await loginAs(g.app, 'admin');
    await link(m, g, 'X', 'direct');
    await bothLinked(m, g);
    const moves = createMovesStore(g.dir, loadIdentity(g.dir), g.boxId).read()!;
    const otherTicket = moves.entries.find((e) => e.userId === gOtherAdmin.userId)!.ticket;
    const linkingTicket = moves.entries.find((e) => e.userId === gAdmin.userId)!.ticket;
    const mediaTicket = moves.entries.find((e) => e.userId === s.gMedia.userId)!.ticket;
    expect(otherTicket).toMatch(/\S/);
    await until(() => expect(m.restarts + g.restarts).toBeGreaterThanOrEqual(2));
    const at = w.clock.now().getTime();
    await w.restartAll();
    const expiryOf = (code: string): number => {
      const row = m.app.surau.db.prepare('SELECT expires_at FROM enrolments WHERE code_hash = ?').get(sha256hex(code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()));
      return row === undefined ? NaN : Date.parse(String(row.expires_at)) - at;
    };
    for (const code of [otherTicket, linkingTicket, mediaTicket]) expect(expiryOf(code)).toBeGreaterThan(24 * 3600_000);
    const me = await enrol(m, otherTicket);
    expect(me.status).toBe(200);
    expect((await enrol(m, otherTicket)).status).toBeGreaterThanOrEqual(400);
  }, 90_000);

  it('caseXCodeChoice: with the choice "code" another admin of the giver gets none and the linking admin the short ticket', async () => {
    const m = await w.make(1);
    const g = await w.make(2);
    await seed(g, m, { mHasStore: true });
    const gOtherAdmin = await loginAs(g.app, 'admin');
    await link(m, g, 'X', 'code');
    await bothLinked(m, g);
    const moves = createMovesStore(g.dir, loadIdentity(g.dir), g.boxId).read()!;
    expect(moves.entries.some((e) => e.userId === gOtherAdmin.userId)).toBe(false);
    expect(moves.entries.some((e) => e.userId === g.admin!.userId)).toBe(true);
  }, 90_000);

  it('adoptedStoreHasNoLiveCredential (routes): G\'s session token, kiosk cookie, enrolment code and recovery code are refused by M', async () => {
    const m = await w.make(1);
    const g = await w.make(2);
    const s = await seed(g, m, { mHasStore: true });
    const gAdmin = g.admin!;
    await link(m, g, 'X');
    await bothLinked(m, g);
    const mAdmin = m.admin!;
    await w.restartAll();
    m.admin = await unlockAgain(m, mAdmin);

    // a control: M's own admin is let in
    expect((await m.call('GET', '/api/users')).status).toBe(200);
    // G's old session token (a phone of G that did not move) and the media person's token
    for (const who of [gAdmin, s.gMedia]) {
      const r = await m.call('GET', '/api/users', undefined, { as: who });
      expect(r.status, who.userId).toBe(401);
    }
    // G's TV cookie (the TV of G was paired on G)
    const kiosk = await m.call('GET', '/api/kiosk/bundle', undefined, { as: null, from: '10.168.1.77', headers: { cookie: s.gKiosk.cookie } });
    expect(kiosk.status).toBe(401);
    // G's open enrolment code
    const e = await enrol(m, s.gEnrolCode);
    expect(e.status).toBeGreaterThanOrEqual(400);
    expect(e.status).toBeLessThan(500);
    expect(e.token).toBeNull();
    // G's recovery code (the setup check itself: the hash stored on M is the new one)
    expect(verifyRecoveryCode(m.app.surau.db, s.gCode)).toBe(false);
    // no device of G is in M's list
    expect(m.app.surau.db.prepare('SELECT 1 AS x FROM devices WHERE id IN (?, ?)').get(gAdmin.deviceId, s.gMedia.deviceId)).toBeUndefined();
    // G's admin does sign in at M? Not with G's key and G's PIN (the person has no PIN of G here): the device is unknown
    const ch = await m.app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress: m.addr, payload: { deviceId: gAdmin.deviceId } });
    const nonce = String(ch.json().nonce);
    const sig = await gAdmin.sign(new TextEncoder().encode(`surau-unlock\n${m.boxId}\n${gAdmin.deviceId}\n${nonce}`));
    const un = await m.app.inject({ method: 'POST', url: '/api/auth/unlock', remoteAddress: m.addr, payload: { deviceId: gAdmin.deviceId, nonce, signature: sig, pin: PIN } });
    expect(un.statusCode).toBeGreaterThanOrEqual(400);
  }, 90_000);

  it('cloudKeyNeverCrosses: G\'s secret/sync.key bytes appear in no list, no answer and no file on M; M\'s own key is unchanged with a copy in its backup', async () => {
    const m = await w.make(1);
    const g = await w.make(2);
    const s = await seed(g, m, { mHasStore: true });
    const linkId = await link(m, g, 'X');
    await bothLinked(m, g);
    await w.restartAll();

    // M's own key: same bytes, still opens with M's box key, a copy in the backup folder
    expect(readFileSync(join(m.dir, 'secret', 'sync.key')).equals(s.mSync)).toBe(true);
    expect(readFileSync(join(m.dir, 'linkundo', linkId, 'secret', 'sync.key')).equals(s.mSync)).toBe(true);
    expect(loadSyncKey(m.dir)!.siteToken).toBe(s.mSiteToken);
    // G's key never listed, never asked for, never answered
    const asked = w.files.map((f) => f.path);
    expect(asked.length).toBeGreaterThan(0);
    for (const p of asked) expect(p).not.toMatch(/^(secret|live|import)\//);
    const lists = w.calls.filter((c) => c.path === '/api/link/peer/store/list' && (c.json as { state?: string })?.state === 'ready');
    expect(lists.length).toBeGreaterThan(0);
    for (const c of lists) {
      const list = (c.json as { files: { path: string }[] });
      for (const f of list.files) expect(f.path).not.toMatch(/^(secret|live|import)\//);
    }
    // not one wire message of the whole link holds G's key bytes or its site token
    const wire = JSON.stringify(w.calls);
    expect(wire).not.toContain(s.gSiteToken);
    expect(wire).not.toContain(s.gSync.toString('utf8'));
    expect(wire).not.toContain(s.gSync.toString('base64'));
    // not one file of M's data folder (backup included) holds them
    const needle = s.gSync.subarray(0, Math.min(40, s.gSync.length));
    for (const rel of treeOf(m.dir)) {
      if (rel.startsWith('linkundo/') && rel.endsWith('surau.db')) continue;
      const bytes = readFileSync(join(m.dir, ...rel.split('/')));
      expect(bytes.includes(needle), rel).toBe(false);
      expect(bytes.includes(s.gSiteToken), rel).toBe(false);
    }
    // nor the adopted database
    const db = m.app.surau.db;
    for (const t of ['settings', 'meta', 'sync_state', 'content_items']) {
      expect(JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).not.toContain(s.gSiteToken);
    }
  }, 90_000);

  it('YouTube and camera: M loads G\'s token, the camera has G\'s address with NO password and passwordNeeded; neither file was listed or served', async () => {
    const m = await w.make(1);
    const g = await w.make(2);
    const s = await seed(g, m, { mHasStore: true });
    const linkId = await link(m, g, 'X');
    await bothLinked(m, g);
    await w.restartAll();

    expect(new TokenStore(m.dir).load()).toEqual(YT);
    const cam = new CameraStore(m.dir);
    expect(cam.get()?.url).toBe('rtsp://10.168.50.40:554/stream1');
    expect(cam.get()?.username).toBe('admin');
    expect(cam.get()?.password).toBeUndefined();
    expect(cam.getMasked()).toMatchObject({ passwordNeeded: true });
    expect(JSON.stringify(cam.getMasked())).not.toContain('Sup3rSecret');
    // neither file was a file of the move
    for (const f of w.files) expect(f.path).not.toMatch(/youtube|camera/);
    const lists = w.calls.filter((c) => c.path === '/api/link/peer/store/list' && (c.json as { state?: string })?.state === 'ready');
    for (const c of lists) for (const f of (c.json as { files: { path: string }[] }).files) expect(f.path).not.toMatch(/youtube|camera/);
    // on the wire the sign-ins travelled sealed to M's key: no plain token, no password
    const wire = JSON.stringify(w.calls);
    expect(wire).not.toContain(YT.refreshToken);
    expect(wire).not.toContain('Sup3rSecret');
    expect(wire).not.toContain('admin:');
    // nowhere on M in plain
    for (const rel of treeOf(m.dir)) {
      const bytes = readFileSync(join(m.dir, ...rel.split('/')));
      expect(bytes.includes(YT.refreshToken), rel).toBe(false);
      expect(bytes.includes('Sup3rSecret'), rel).toBe(false);
    }
    void s; void linkId;
  }, 90_000);

  it('a commit G refuses: M ends failed, no adopt journal, no link-adopt.json, no stage, M\'s store is unchanged after a restart', async () => {
    const m = await w.make(1);
    const g = await w.make(2);
    const s = await seed(g, m, { mHasStore: true });
    const tables = ['users', 'devices', 'content_items', 'settings', 'meta', 'kiosk_cookies', 'enrolments', 'finance_funds', 'finance_entries', 'sync_state', 'sessions'];
    const snap = (b: XBox): Record<string, unknown[]> => Object.fromEntries(tables.map((t) => [t, b.app.surau.db.prepare(`SELECT * FROM ${t}`).all()]));
    const mBefore = snap(m);
    const gBefore = snap(g);
    const filesBefore = treeOf(m.dir).filter((f) => !f.endsWith('-wal') && !f.endsWith('-shm'));
    // G's commit answer is a refusal (any non-200)
    w.respond = (c) => (c.body.step === 'commit' ? { status: 500, json: { code: 'refused' } } : undefined);
    await link(m, g, 'X');
    await until(() => expect(outcomeOf(m)).toBe('failed'));
    await m.app.link!.work.idle();
    // the stage and the plan are gone at once, no journal was ever written
    expect(existsSync(join(m.dir, 'link.json'))).toBe(false);
    expect(existsSync(join(m.dir, 'link-adopt.json'))).toBe(false);
    expect(existsSync(join(m.dir, 'linkstage'))).toBe(false);
    // G never became a follower and G's session ended too
    expect(g.app.link!.follow.present()).toBe(false);
    expect(existsSync(join(g.dir, 'link.json'))).toBe(false);
    await until(() => expect(outcomeOf(g)).not.toBeNull());
    expect(outcomeOf(g)).not.toBe('linked');
    // a restart changes nothing of M (or G)
    const mAdmin = m.admin!;
    await w.restartAll();
    expect(snap(m)).toEqual(mBefore);
    expect(snap(g)).toEqual(gBefore);
    expect(treeOf(m.dir).filter((f) => !f.endsWith('-wal') && !f.endsWith('-shm'))).toEqual(filesBefore);
    expect(existsSync(join(m.dir, 'linkundo'))).toBe(false);
    // M's phone token still works (its session was never cleared)
    const again = await m.call('GET', '/api/users', undefined, { as: mAdmin });
    expect(again.status).toBe(200);
    expect(m.app.surau.db.prepare("SELECT 1 AS x FROM content_items WHERE id = 'm-only'").get()).toBeDefined();
    void s;
  }, 90_000);
});

describe('case N-X end to end (M was never set up)', () => {
  it('caseNXEndToEnd: the same after both restarts, and the linking admin\'s ticket from G\'s move list enrols a phone on M', async () => {
    const m = await w.make(1, { setUp: false });
    const g = await w.make(2);
    const s = await seed(g, m, { mHasStore: false });
    const gAdmin = g.admin!;
    const linkId = await link(m, g, 'N-X');
    await bothLinked(m, g);
    expect(existsSync(join(m.dir, 'link.json'))).toBe(true);
    // the linking admin's one move ticket, and the media person's, are in G's move list
    const moves = createMovesStore(g.dir, loadIdentity(g.dir), g.boxId).read()!;
    const adminTicket = moves.entries.find((e) => e.userId === gAdmin.userId)!.ticket;
    expect(adminTicket).toMatch(/\S/);
    expect(moves.entries.some((e) => e.userId === s.gMedia.userId)).toBe(true);
    await until(() => expect(m.restarts + g.restarts).toBeGreaterThanOrEqual(2));

    await w.restartAll();

    // M never had a place of its own: no backup folder, G's store is in place
    expect(existsSync(join(m.dir, 'linkundo'))).toBe(false);
    for (const f of ['link.json', 'link-adopt.json']) expect(existsSync(join(m.dir, f))).toBe(false);
    expect(existsSync(join(m.dir, 'linkstage'))).toBe(false);
    expect(m.app.surau.db.prepare("SELECT 1 AS x FROM content_items WHERE id = 'a-1'").get()).toBeDefined();
    expect(readFileSync(join(m.dir, 'assets', 'poster-1.jpg')).equals(POSTER)).toBe(true);
    // G follows M, M lists G
    expect(g.app.link!.follow.read()!.masterBoxId).toBe(m.boxId);
    expect((await g.tv()).body.mode).toBe('follower');
    // nobody has a PIN or a phone of G here: the ticket is the only way in
    const me = await enrol(m, adminTicket);
    expect(me.status).toBe(200);
    expect(me.token).not.toBeNull();
    const as: Login = { token: me.token!, userId: gAdmin.userId, deviceId: String(me.body.deviceId), roles: ['admin'], headers: { authorization: `Bearer ${me.token}` }, baseVersion: 0, relogin: async () => me.token!, sign: async () => '' };
    const users = await m.call('GET', '/api/users', undefined, { as });
    expect(users.status).toBe(200);
    const boxes = await m.call('GET', '/api/boxes', undefined, { as });
    expect(boxes.status).toBe(200);
    expect(boxes.body.boxes).toHaveLength(1);
    expect(boxes.body.boxes[0].boxId).toBe(g.boxId);
    // the ticket is single use
    expect((await enrol(m, adminTicket)).status).toBeGreaterThanOrEqual(400);
    // the new recovery code shows once on that admin's status read
    const st1 = await m.call('GET', '/api/link/status', undefined, { as });
    expect(String(st1.body.recoveryCode)).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
    expect((await m.call('GET', '/api/link/status', undefined, { as })).body.recoveryCode).toBe(st1.body.recoveryCode);
    w.clock.tick(16 * 60_000);
    expect((await m.call('GET', '/api/link/status', undefined, { as })).body.recoveryCode).toBeNull();
    expect(verifyRecoveryCode(m.app.surau.db, s.gCode)).toBe(false);
    // G's credentials are refused here too
    expect((await m.call('GET', '/api/users', undefined, { as: gAdmin })).status).toBe(401);
    expect((await m.call('GET', '/api/kiosk/bundle', undefined, { as: null, from: '10.168.1.77', headers: { cookie: s.gKiosk.cookie } })).status).toBe(401);
    void linkId;
  }, 90_000);
});

// keep sha256hex referenced for readers of the credential checks above
void sha256hex;

describe('the giver linking admin ticket needs a real admin of the list', () => {
  const person = (id: string, roles: string[]) => ({ id, name: `Orang ${id}`, phone: null, roles, devices: 1 }) as never;
  it('an admin and a superadmin of the list get it', () => {
    expect(isGiverAdmin('u1', [person('u1', ['admin'])])).toBe(true);
    expect(isGiverAdmin('u2', [person('u1', ['ajk']), person('u2', ['superadmin'])])).toBe(true);
  });
  it('an id that is not in the list, or a person without the admin role, gets none', () => {
    expect(isGiverAdmin('ghost', [person('u1', ['admin'])])).toBe(false);
    expect(isGiverAdmin('u1', [person('u1', ['ajk', 'media'])])).toBe(false);
    expect(isGiverAdmin('u1', [])).toBe(false);
  });
});
