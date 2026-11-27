import { createHash, webcrypto } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beginEnrolment } from '../src/auth/devices.ts';
import { boxId as boxIdOf } from '../src/auth/secrets.ts';
import { createUserIn } from '../src/auth/users.ts';
import { openDb } from '../src/db.ts';
import { receiveVideo } from '../src/assets/video.ts';
import { readUnlinkNote, sendUnlinkReport, startUnlinkReporter, unlinkNotePresent, writeUnlinkNote } from '../src/follow/unlinkNote.ts';
import { buildReducedCopy } from '../src/link/reducedCopy.ts';
import { runReduce, sweepReduceLeftovers } from '../src/link/reduce.ts';
import { applyLinkJournalAtBoot, walkFiles } from '../src/link/setAside.ts';
import { signLink } from '../src/link/sign.ts';
import { dropMoveOut, outDbOf, stageDirOf, STORE_TOKEN_HEADER, UNLINK_OUT_DIR } from '../src/link/storeMove.ts';
import type { MoveList } from '../src/link/storeMove.ts';
import type { BootResult } from '../src/link/setAside.ts';
import { MIGRATIONS } from '../src/migrations/index.ts';
import { TokenStore } from '../src/live/youtube/tokenStore.ts';
import { putFeature } from '../src/settingsStore.ts';
import { issueRecoveryCode, RECOVERY_META_KEY } from '../src/setup/codes.ts';
import { loadIdentity } from '../src/setup/identity.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { dumpDb } from './support/adoptRig.ts';
import { createXWorld, outcomeOf, PIN, unlockAgain, until } from './support/caseXWorld.ts';
import type { XBox, XWorld } from './support/caseXWorld.ts';
import { mp4 } from './support/mp4.ts';

/**
 * "Teruskan dengan data sekarang" at a FOLLOWER (multi-box phase 2D, D3), through the real routes of real boxes in one
 * process: the master's reduced copy (`link/reducedCopy.ts`), the follower's pull of it, the reduce at its next start
 * (`link/reduce.ts`), its `copied` / `joined` reports and the master's own change. Contract: the "Server decisions (D3)"
 * of `docs/design/plans/2026-11-23-unlink-contract.md`.
 */

let w: XWorld;
const tempDirs: string[] = [];
beforeEach(() => {
  w = createXWorld();
});
afterEach(async () => {
  await w.close();
});
afterAll(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // a folder that is still held is left to the system
    }
  }
});

const SLOW = 180_000;
const F_PHONE = '+60120000021';
const B_PHONE = '+60120000022';
const Z_PHONE = '+60120000032';
const COUNTER_NAME = 'Tuan Haji Ali';
const ENTRY_NOTE = 'Sumbangan Jumaat Khas Qurban';
const Z_NAME = 'Cik Zainab Pengurus';
const STAR_NAME = 'Sokongan Ruang Utama';
const OWN_NAME = 'Ruang Muslimat';
const YT = { refreshToken: 'refresh-token-of-m', accessToken: 'access-of-m', expiresAt: 4_102_444_800_000, channelId: 'UC-surau', channelTitle: 'Surau Al-Hidayah', scope: 'youtube', streamId: 'stream-1' };
const FIXED = new Date('2026-11-23T10:00:00.000Z');

// ---------------------------------------------------------------- helpers

type Rec = Record<string, any>;
const row = (box: XBox, sql: string, ...args: (string | number)[]): Record<string, unknown> | undefined => box.app.surau.db.prepare(sql).get(...args);
const count = (box: XBox, sql: string, ...args: (string | number)[]): number => Number(row(box, sql, ...args)?.n ?? 0);
const hasTable = (db: DatabaseSync, t: string): boolean => db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const safe = (r: { json: () => unknown }): Rec => {
  try {
    const j = r.json();
    return typeof j === 'object' && j !== null ? (j as Rec) : { value: j };
  } catch {
    return {};
  }
};

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

/** What the follower's reports reach the master through: the master's real route; `events` records what was sent. */
function clientTo(m: XBox, from: XBox, o: { events?: string[]; failCopied?: boolean } = {}): { json: (origin: string, ca: string, req: { method?: string; path: string; body?: string }) => Promise<{ status: number; json: unknown }> } {
  return {
    json: async (_origin, _ca, req) => {
      const msg = JSON.parse(req.body ?? '{}') as Rec;
      const ev = msg.body?.event;
      if (typeof ev === 'string') o.events?.push(ev);
      if (o.failCopied === true && ev === 'copied') return { status: 503, json: { code: 'down' } };
      const r = await m.app.inject({ method: 'POST', url: req.path, payload: msg, remoteAddress: from.addr });
      return { status: r.statusCode, json: safe(r) };
    },
  };
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

/** Case X: the follower's data is kept under the master (the master's own store becomes its backup). */
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
  fAdmin: Login;
  /** The follower's second person of link day (an ordinary AJK) and the recovery hash the follower had. */
  bilalOnF: string;
  recoveryHash: string;
  /** The name the master gave the follower (it becomes the box name of the copy). */
  followerName: string;
}

interface Seed {
  treasurer: Login;
  entryId: string;
  /** Strings that exist only at the master and must not be anywhere in the follower's database file. */
  secrets: string[];
  /** People only the master has: they must not be in the copy. */
  masterOnly: string[];
  masterHead: number;
  funds: number;
  perihal: number;
  leavingTv: boolean;
}

/** A linked pair, the follower's Pentadbir of link day as a signed-in person of the master. */
async function setup(kind: 'S' | 'X'): Promise<Ctx> {
  const m = await w.make(1);
  const f = await w.make(2);
  const fAdminOnF = f.admin!.userId;
  f.app.surau.db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(F_PHONE, fAdminOnF);
  const bilal = createUserIn(f.app.surau.db, { name: 'Bilal Hamid', roles: ['ajk'], phone: B_PHONE }, 'test', 'sdm');
  issueRecoveryCode(f.app.surau.db);
  const recoveryHash = String(f.app.surau.db.prepare('SELECT value FROM meta WHERE key = ?').get(RECOVERY_META_KEY)?.value);
  const linkId = kind === 'S' ? await linkS(m, f) : await linkX(m, f);
  const deviceId = String((await m.call('GET', '/api/boxes')).body.boxes[0].id);
  const mapped = row(m, 'SELECT user_id FROM link_people WHERE link_id = ? AND peer_user_id = ?', linkId, fAdminOnF);
  const fAdminOnM = mapped !== undefined ? String(mapped.user_id) : String(row(m, 'SELECT id FROM users WHERE phone = ? AND active = 1', F_PHONE)?.id);
  const code = beginEnrolment(m.app.surau.db, { userId: fAdminOnM, deviceName: 'Telefon F' }, 'test', { canManageSuperadmin: true }).code;
  const fAdmin = (await enrolAt(m, code)) as Login;
  expect(fAdmin.token, JSON.stringify({ fAdmin, fAdminOnM })).toBeTruthy();
  const dev = row(m, 'SELECT name FROM devices WHERE id = ?', deviceId);
  const followerName = typeof dev?.name === 'string' && dev.name !== '' ? dev.name : String(row(m, 'SELECT name FROM linked_boxes WHERE device_id = ?', deviceId)?.name);
  return { kind, m, f, linkId, deviceId, fAdminOnF, fAdminOnM, fAdmin, bilalOnF: bilal.id, recoveryHash, followerName };
}

function seedTv(m: XBox, tvs: Record<string, unknown>): void {
  m.app.surau.db.prepare("INSERT OR REPLACE INTO settings (surau_id, feature, json, updated_at, updated_by) VALUES ('sdm', 'tvProfiles', ?, ?, 'test')").run(JSON.stringify({ tvs }), new Date().toISOString());
}

/** Everything the master holds that the copy must NOT carry, and the media that it must. */
async function seedMaster(c: Ctx, o: { leavingTv: boolean; videos?: { padding: number; salt: number; title: string }[] }): Promise<Seed> {
  const { m } = c;
  const db = m.app.surau.db;
  putFeature(db, 'finance', { enabled: true }, 'test', undefined, 'sdm');
  const treasurer = await loginAs(m.app, 'treasurer');
  const funds = (await m.call('GET', '/api/finance/funds', undefined, { as: treasurer })).body.funds as { id: string }[];
  const per = (await m.call('GET', '/api/finance/perihal', undefined, { as: treasurer })).body.perihal as { id: string; direction: string }[];
  const e = await m.call('PUT', '/api/finance/entries/e-seed-1', {
    kind: 'in', entryDate: '2026-11-06', fundId: funds[0]!.id, perihalId: per.find((p) => p.direction === 'in')!.id, amountSen: 12345, method: 'tunai', note: ENTRY_NOTE,
    counters: [{ userId: treasurer.userId }, { name: COUNTER_NAME }],
  }, { as: treasurer });
  expect(e.status, JSON.stringify(e.body)).toBe(200);
  const at = new Date().toISOString();
  db.prepare("INSERT INTO finance_photos (surau_id, id, entry_id, mime, bytes, created_at, created_by) VALUES ('sdm', 'ph-seed-1', 'e-seed-1', 'image/jpeg', 24, ?, 'test')").run(at);
  db.prepare("INSERT OR REPLACE INTO finance_months (surau_id, ym, status, updated_at, rev, edited_at) VALUES ('sdm', '2026-11', 'open', ?, 'r1', ?)").run(at, at);
  db.prepare("INSERT OR REPLACE INTO finance_counters (surau_id, letter, next) VALUES ('sdm', 'Z', 7)").run();
  // a person only the master has, and a Pentadbir MAXCOM of the master ('*')
  const z = createUserIn(db, { name: Z_NAME, roles: ['ajk'], phone: Z_PHONE }, 'test', 'sdm');
  const star = createUserIn(db, { name: STAR_NAME, roles: ['ajk'] }, 'test', 'sdm');
  db.prepare("UPDATE users SET surau_id = '*', no = NULL, no_src = NULL WHERE id = ?").run(star.id);
  db.prepare("INSERT INTO sync_nonces (box_id, nonce, at) VALUES ('box-x', 'nonce-1', ?)").run(at);
  // media: a poster and a theme file (they cross), a finance photo and the secret files (they never cross)
  const put = (rel: string, data: Buffer | string): void => {
    mkdirSync(dirname(join(m.dir, ...rel.split('/'))), { recursive: true });
    writeFileSync(join(m.dir, ...rel.split('/')), data);
  };
  put('assets/poster-1.jpg', 'poster bytes of the master surau');
  put('themes/hijau/theme.json', '{"name":"hijau"}');
  put('finance/photos/ph-seed-1.jpg', 'PHOTO OF A RECEIPT FROM THE MASTER');
  new TokenStore(m.dir).save(YT);
  put('secret/live-camera.json', '{"sealed":"camera of the master"}');
  // TV profiles: the leaving TV's and another TV's
  seedTv(m, { ...(o.leavingTv ? { [c.deviceId]: { live: { show: false } } } : {}), 'other-tv': { live: { show: true } } });
  // videos
  for (const v of o.videos ?? []) {
    const buf = mp4({ seconds: 10, salt: v.salt, padding: v.padding });
    const meta = await receiveVideo(db, m.dir, Readable.from([buf]), buf.length, 'u1', { free: () => null });
    db.prepare("INSERT INTO content_items (surau_id, kind, id, json, updated_at, updated_by) VALUES ('sdm', 'video', ?, ?, ?, 'test')")
      .run(`item-${meta.id.slice(0, 8)}`, JSON.stringify({ assetId: meta.id, title: v.title }), at);
  }
  // what the master holds is there (a copy test that finds an empty master proves nothing)
  expect(count(m, 'SELECT COUNT(*) AS n FROM finance_entries')).toBeGreaterThan(0);
  expect(count(m, 'SELECT COUNT(*) AS n FROM finance_photos')).toBeGreaterThan(0);
  expect(count(m, 'SELECT COUNT(*) AS n FROM finance_months')).toBeGreaterThan(0);
  expect(count(m, 'SELECT COUNT(*) AS n FROM finance_counters')).toBeGreaterThan(0);
  expect(count(m, 'SELECT COUNT(*) AS n FROM devices')).toBeGreaterThan(1);
  expect(count(m, 'SELECT COUNT(*) AS n FROM auth_log')).toBeGreaterThan(0);
  expect(count(m, 'SELECT COUNT(*) AS n FROM users WHERE pin_hash IS NOT NULL')).toBeGreaterThan(0);
  expect(count(m, 'SELECT COUNT(*) AS n FROM change_log WHERE entity LIKE ?', 'finance%')).toBeGreaterThan(0);
  const name = (id: string): string => String(row(m, 'SELECT name FROM users WHERE id = ?', id)?.name);
  return {
    treasurer, entryId: 'e-seed-1', leavingTv: o.leavingTv,
    secrets: [COUNTER_NAME, ENTRY_NOTE, Z_NAME, Z_PHONE, STAR_NAME, name(treasurer.userId), name(m.admin!.userId), 'PHOTO OF A RECEIPT'],
    masterOnly: [z.id, star.id, treasurer.userId, m.admin!.userId],
    masterHead: count(m, 'SELECT MAX(id) AS n FROM change_log'),
    funds: count(m, 'SELECT COUNT(*) AS n FROM finance_funds'),
    perihal: count(m, 'SELECT COUNT(*) AS n FROM finance_perihal'),
  };
}

/** Starts the unlink: the follower answers "carry on" (ledger tick), the master carry-on or back; both agree. */
async function startCarryOn(c: Ctx, mc: 'carry-on' | 'back'): Promise<string> {
  const { m, fAdmin } = c;
  const st = await m.call('POST', '/api/unlink/start', { deviceId: c.deviceId, pin: PIN });
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  expect(st.body.session.master.asked).toBe(true);
  const a = await m.call('PUT', '/api/unlink/answer', { side: 'follower', choice: 'carry-on', financeTick: true }, { as: fAdmin });
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  expect(a.body.session.follower.numbers.financeEntriesLeft).toBeGreaterThan(0);
  const b = await m.call('PUT', '/api/unlink/answer', { side: 'master', choice: mc, ...(mc === 'carry-on' ? { removePeople: false } : {}) });
  expect(b.status, JSON.stringify(b.body)).toBe(200);
  const rev = b.body.session.rev;
  expect((await m.call('POST', '/api/unlink/agree', { side: 'follower', rev, pin: PIN }, { as: fAdmin })).status).toBe(200);
  const g = await m.call('POST', '/api/unlink/agree', { side: 'master', rev, pin: PIN, ...(mc === 'back' ? { confirm: true } : {}) });
  expect(g.status, JSON.stringify(g.body)).toBe(200);
  expect(g.body.session.stage).toBe('working');
  expect(g.body.session.progress.step).toBe('copy');
  return String(g.body.session.id);
}

/** A session where the FOLLOWER chose "back" (nothing is copied for it). */
async function startFollowerBack(c: Ctx): Promise<string> {
  const { m, fAdmin } = c;
  expect((await m.call('POST', '/api/unlink/start', { deviceId: c.deviceId, pin: PIN })).status).toBe(200);
  expect((await m.call('PUT', '/api/unlink/answer', { side: 'follower', choice: 'back' }, { as: fAdmin })).status).toBe(200);
  const b = await m.call('PUT', '/api/unlink/answer', { side: 'master', choice: 'carry-on', removePeople: false });
  const rev = b.body.session.rev;
  expect((await m.call('POST', '/api/unlink/agree', { side: 'follower', rev, confirm: true, pin: PIN }, { as: fAdmin })).status).toBe(200);
  const g = await m.call('POST', '/api/unlink/agree', { side: 'master', rev, pin: PIN });
  expect(g.body.session.stage).toBe('working');
  return String(g.body.session.id);
}

async function fetchOrder(c: Ctx): Promise<Rec> {
  const r = await c.m.app.inject({ method: 'POST', url: '/api/link/peer/order', remoteAddress: c.f.addr, payload: { boxId: c.f.boxId, linkId: c.linkId } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

/** The follower takes the standalone order and pulls its copy; returns when its plan and journal are written. */
async function pull(c: Ctx, samples?: Rec[], warm = true): Promise<Rec> {
  const { f } = c;
  const ord = await fetchOrder(c);
  expect(ord.order).toBe('standalone');
  // The master's copy is made before the follower's first request: the follower of this harness polls the list with no
  // pause and the list route counts every poll (see the `it.fails` of the polling limit), so a slow build would end
  // the pull before it began. The follower's own request then gets `ready` at once.
  if (warm) await readyList(c, String(ord.body.unlinkId));
  expect(f.app.link!.takeOrder!(ord)).toBe(true);
  if (samples !== undefined) {
    // the TV of the follower while it pulls
    for (let i = 0; i < 400 && !existsSync(join(f.dir, 'link.json')); i++) samples.push({ ...(await f.tv()).body.unlink });
  }
  await until(() => expect(existsSync(join(f.dir, 'link.json'))).toBe(true));
  expect(JSON.parse(readFileSync(join(f.dir, 'link.json'), 'utf8'))).toMatchObject({ op: 'reduce', linkId: c.linkId, step: 'planned' });
  return JSON.parse(readFileSync(join(f.dir, 'link-reduce.json'), 'utf8')) as Rec;
}

const ownIds = (db: DatabaseSync): string[] => (db.prepare('SELECT id FROM users').all() as { id: string }[]).map((r) => r.id).sort();

/** The follower's database after its start on the copy: everything the reduced copy must and must not hold. */
function expectReduced(c: Ctx, s: Seed): void {
  const { f } = c;
  const db = f.app.surau.db;
  expect(f.app.link!.follow.present()).toBe(false);
  // finance: the ledger is empty, its lists are there, the triggers that keep a ledger are back
  for (const t of ['finance_entries', 'finance_photos', 'finance_months', 'finance_counters']) expect(count(f, `SELECT COUNT(*) AS n FROM ${t}`), t).toBe(0);
  expect(count(f, 'SELECT COUNT(*) AS n FROM finance_funds')).toBe(s.funds);
  expect(count(f, 'SELECT COUNT(*) AS n FROM finance_perihal')).toBe(s.perihal);
  const fund = String(row(f, 'SELECT id FROM finance_funds LIMIT 1')?.id);
  db.prepare("INSERT INTO finance_entries (surau_id, id, kind, entry_date, fund_id, amount_sen, created_by, edited_at, received_at, rev) VALUES ('sdm', 'new-1', 'in', '2026-11-24', ?, 500, 'test', 'x', 'x', 'r')").run(fund);
  expect(() => db.prepare("UPDATE finance_entries SET amount_sen = 900 WHERE id = 'new-1'").run()).toThrow(/append-only/);
  expect(() => db.prepare("DELETE FROM finance_entries WHERE id = 'new-1'").run()).toThrow(/append-only/);
  // people: only the follower's own of link day, with the ids they had on the follower
  expect(ownIds(db)).toEqual([c.fAdminOnF, c.bilalOnF].sort());
  for (const id of s.masterOnly) expect(row(f, 'SELECT 1 AS x FROM users WHERE id = ?', id), id).toBeUndefined();
  expect(count(f, "SELECT COUNT(*) AS n FROM users WHERE surau_id = '*'")).toBe(0);
  expect(row(f, 'SELECT 1 AS x FROM users WHERE pin_hash IS NOT NULL')).toBeUndefined();
  // phones, TVs, sessions, links: nothing of the master's; only the one join ticket
  for (const t of ['devices', 'sessions', 'challenges', 'kiosk_cookies', 'kiosk_pairings', 'linked_boxes', 'link_people', 'link_sessions', 'sync_nonces', 'auth_log', 'applied_ops', 'live_sessions', 'uploads']) {
    if (hasTable(db, t)) expect(count(f, `SELECT COUNT(*) AS n FROM ${t}`), t).toBe(0);
  }
  const note = readUnlinkNote(f.dir, loadIdentity(f.dir), f.boxId)!;
  expect((db.prepare('SELECT code_hash FROM enrolments').all() as { code_hash: string }[]).map((r) => r.code_hash)).toEqual([note.ticketHash]);
  // the change log: no finance or people row of the master; the head never goes back
  const log = db.prepare('SELECT entity, entity_id, before_json, after_json FROM change_log').all() as Rec[];
  for (const r of log) {
    expect(['box', 'link'], JSON.stringify(r)).toContain(r.entity);
    for (const id of [...s.masterOnly, s.entryId]) expect(`${r.entity_id}${r.before_json}${r.after_json}`).not.toContain(id);
  }
  expect(count(f, 'SELECT MAX(id) AS n FROM change_log')).toBeGreaterThanOrEqual(s.masterHead);
  // the box's own name and recovery code, no setup of the master
  expect(row(f, "SELECT value FROM meta WHERE key = 'box_name'")?.value).toBe(c.followerName);
  expect(String(row(f, 'SELECT value FROM meta WHERE key = ?', RECOVERY_META_KEY)?.value)).toBe(c.recoveryHash);
  // the leaving TV's profile is the box's own TV; no other TV stays
  const tv = row(f, "SELECT json FROM settings WHERE surau_id = 'sdm' AND feature = 'tvProfiles'");
  const tvs = tv === undefined ? {} : ((JSON.parse(String(tv.json)) as { tvs?: Record<string, unknown> }).tvs ?? {});
  if (s.leavingTv) expect(tvs).toEqual({ self: { live: { show: false } } });
  else expect(Object.keys(tvs)).toEqual([]);
  // files: the media crossed, no secret and no finance photo did
  expect(readFileSync(join(f.dir, 'assets', 'poster-1.jpg'), 'utf8')).toBe('poster bytes of the master surau');
  expect(existsSync(join(f.dir, 'themes', 'hijau', 'theme.json'))).toBe(true);
  expect(walkFiles(join(f.dir, 'finance', 'photos'))).toEqual([]);
  expect(existsSync(join(f.dir, 'secret', 'youtube-token.json'))).toBe(false);
  expect(existsSync(join(f.dir, 'secret', 'live-camera.json'))).toBe(false);
  expect(existsSync(join(f.dir, 'linkstage'))).toBe(false);
  expect(existsSync(join(f.dir, 'link.json'))).toBe(false);
  // no removed row survives in a free page of the file either
  for (const name of readdirSync(f.dir).filter((n) => n.startsWith('surau.db'))) {
    const bytes = readFileSync(join(f.dir, name));
    for (const str of s.secrets) expect(bytes.includes(Buffer.from(str)), `${str} in ${name}`).toBe(false);
  }
}

/** The follower tells the master the copy landed; returns the note with the master's address. */
async function reportCopied(c: Ctx): Promise<ReturnType<typeof readUnlinkNote> & object> {
  const { m, f } = c;
  const fid = loadIdentity(f.dir);
  const note = readUnlinkNote(f.dir, fid, f.boxId)!;
  expect(note.applied).toBe(true);
  expect(note.copied).toBe(false);
  const n2 = { ...note, master: { ...note.master, addresses: [m.origin] } };
  expect(await sendUnlinkReport(clientTo(m, f) as never, fid, f.boxId, n2, 'copied')).toBe(true);
  return n2;
}

async function joinAndReport(c: Ctx, n2: Rec): Promise<void> {
  const { m, f } = c;
  const sj = await m.call('GET', '/api/unlink/status', undefined, { as: c.fAdmin });
  expect(sj.body.session.stage).toBe('join');
  const phone = (await enrolAt(f, sj.body.session.join.ticket)) as Login;
  expect(phone.token, JSON.stringify(phone)).toBeTruthy();
  expect(await sendUnlinkReport(clientTo(m, f) as never, loadIdentity(f.dir), f.boxId, n2 as never, 'joined')).toBe(true);
}

// ---------------------------------------------------------------- 1: what the copy holds

for (const kind of ['S', 'X'] as const) {
  it(`reducedCopyNoFinanceNoForeignPerson (case ${kind}): the follower runs on a copy with no ledger, no foreign person and no secret`, async () => {
    const c = await setup(kind);
    // case S: the leaving TV had a profile; case X: it had none
    const seed = await seedMaster(c, { leavingTv: kind === 'S' });
    await startCarryOn(c, 'carry-on');
    const plan = await pull(c);
    // the list names the reduced database and media; never a finance photo or a secret file
    const paths = (plan.list as MoveList).files.map((x) => x.path);
    expect(paths).toContain('surau.db');
    expect(paths).toContain('assets/poster-1.jpg');
    expect(paths).toContain('themes/hijau/theme.json');
    expect(paths.filter((p) => p.startsWith('finance/') || p.startsWith('secret/') || p.startsWith('live/'))).toEqual([]);
    // nothing of the follower moved yet
    expect(c.f.app.link!.follow.present()).toBe(true);
    await w.restartOne(c.f);
    expectReduced(c, seed);
    expect(JSON.parse(readFileSync(join(c.f.dir, 'link-unlink-kept.json'), 'utf8'))).toMatchObject({ side: 'follower', chosen: 'carry-on', folder: c.linkId });
    // the master still holds its own ledger
    expect(count(c.m, 'SELECT COUNT(*) AS n FROM finance_entries')).toBeGreaterThan(0);
  }, SLOW);
}

// ---------------------------------------------------------------- 2: videos that do not fit

describe('reducedCopyVideosThatDoNotFitListed', () => {
  const UID = 'abcdef0123456789abcdef0123456789';
  const input = (m: XBox, free: number | null) => ({
    dataDir: m.dir, db: m.app.surau.db, unlinkId: UID, dbLevel: MIGRATIONS.length, release: 'test', people: new Map<string, string | null>(),
    boxName: OWN_NAME, tvDeviceId: 'tv-none', followerFreeBytes: free, floorBytes: 0,
  });
  const copyDb = (m: XBox): DatabaseSync => new DatabaseSync(outDbOf(m.dir, UID, UNLINK_OUT_DIR), { readOnly: true });
  const videosOf = (m: XBox): { id: string; bytes: number; title: string }[] =>
    (m.app.surau.db.prepare("SELECT id, bytes FROM assets WHERE mime = 'video/mp4'").all() as { id: string; bytes: number }[]).map((r) => {
      const item = m.app.surau.db.prepare("SELECT json FROM content_items WHERE kind = 'video' AND json_extract(json, '$.assetId') = ?").get(r.id) as { json: string };
      return { id: r.id, bytes: statSync(join(m.dir, 'assets', `${r.id}.mp4`)).size, title: (JSON.parse(item.json) as { title: string }).title };
    }).sort((a, b) => b.bytes - a.bytes);

  async function master(): Promise<{ m: XBox; vids: { id: string; bytes: number; title: string }[]; total: number }> {
    const m = await w.make(1);
    await seedMaster({ kind: 'S', m, f: m, linkId: '', deviceId: 'd', fAdminOnF: '', fAdminOnM: '', fAdmin: m.admin!, bilalOnF: '', recoveryHash: '', followerName: '' }, {
      leavingTv: false,
      videos: [{ padding: 2_000, salt: 1, title: 'Kuliah Subuh' }, { padding: 30_000, salt: 2, title: 'Tazkirah Jumaat' }, { padding: 9_000, salt: 3, title: 'Majlis Khatam' }],
    });
    const vids = videosOf(m);
    expect(vids.map((v) => v.title)).toEqual(['Tazkirah Jumaat', 'Majlis Khatam', 'Kuliah Subuh']);
    // everything listed, nothing asked
    const all = await buildReducedCopy(input(m, null));
    return { m, vids, total: all.list.bytes };
  }

  it('unknown free bytes leave nothing out; plenty of space leaves nothing out', async () => {
    const { m, vids, total } = await master();
    const none = await buildReducedCopy(input(m, null));
    expect(none.videosNotFit).toEqual([]);
    for (const v of vids) expect(none.list.files.map((x) => x.path)).toContain(`assets/${v.id}.mp4`);
    const plenty = await buildReducedCopy(input(m, total * 10));
    expect(plenty.videosNotFit).toEqual([]);
    expect(plenty.list.files).toHaveLength(none.list.files.length);
    dropMoveOut(m.dir, UNLINK_OUT_DIR);
  }, SLOW);

  it('the largest video goes first, then the next; its file is not listed and its item is soft-deleted in the copy only', async () => {
    const { m, vids, total } = await master();
    // room for everything but the largest
    const one = await buildReducedCopy(input(m, total - vids[0]!.bytes + 100));
    expect(one.videosNotFit).toEqual([{ title: 'Tazkirah Jumaat', bytes: vids[0]!.bytes }]);
    expect(one.list.files.map((x) => x.path)).not.toContain(`assets/${vids[0]!.id}.mp4`);
    expect(one.list.files.map((x) => x.path)).toContain(`assets/${vids[1]!.id}.mp4`);
    expect(one.list.files.map((x) => x.path)).toContain(`assets/${vids[2]!.id}.mp4`);
    let cdb = copyDb(m);
    try {
      expect(cdb.prepare('SELECT 1 AS x FROM assets WHERE id = ?').get(vids[0]!.id)).toBeUndefined();
      expect(cdb.prepare('SELECT 1 AS x FROM assets WHERE id = ?').get(vids[1]!.id)).toBeDefined();
      const gone = cdb.prepare("SELECT deleted_at FROM content_items WHERE kind = 'video' AND json_extract(json, '$.assetId') = ?").get(vids[0]!.id) as { deleted_at: string | null };
      expect(gone.deleted_at).not.toBeNull();
      const kept = cdb.prepare("SELECT deleted_at FROM content_items WHERE kind = 'video' AND json_extract(json, '$.assetId') = ?").get(vids[1]!.id) as { deleted_at: string | null };
      expect(kept.deleted_at).toBeNull();
    } finally {
      cdb.close();
    }
    // room for the smallest only
    const two = await buildReducedCopy(input(m, total - vids[0]!.bytes - vids[1]!.bytes + 100));
    expect(two.videosNotFit.map((v) => v.title)).toEqual(['Tazkirah Jumaat', 'Majlis Khatam']);
    expect(two.videosNotFit.map((v) => v.bytes)).toEqual([vids[0]!.bytes, vids[1]!.bytes]);
    cdb = copyDb(m);
    try {
      expect((cdb.prepare("SELECT COUNT(*) AS n FROM assets WHERE mime = 'video/mp4'").get() as { n: number }).n).toBe(1);
    } finally {
      cdb.close();
    }
    // no room at all: every video is left out
    const every = await buildReducedCopy(input(m, 1000));
    expect(every.videosNotFit).toHaveLength(3);
    expect(every.list.files.filter((x) => x.path.endsWith('.mp4'))).toEqual([]);
    // the master's own store is untouched
    expect(videosOf(m)).toHaveLength(3);
    expect(count(m, "SELECT COUNT(*) AS n FROM content_items WHERE kind = 'video' AND deleted_at IS NOT NULL")).toBe(0);
    for (const v of vids) expect(existsSync(join(m.dir, 'assets', `${v.id}.mp4`))).toBe(true);
    dropMoveOut(m.dir, UNLINK_OUT_DIR);
  }, SLOW);

  it('end to end through the route: the follower sends its free bytes signed, the sheet lists the videos left out with title and bytes', async () => {
    const c = await setup('S');
    await seedMaster(c, { leavingTv: true, videos: [{ padding: 2_000, salt: 1, title: 'Kuliah Subuh' }, { padding: 30_000, salt: 2, title: 'Tazkirah Jumaat' }] });
    const vids = videosOf(c.m);
    const unlinkId = await startCarryOn(c, 'carry-on');
    await fetchOrder(c);
    const { list } = await readyList(c, unlinkId, { freeBytes: 1000 });
    expect(list.files.filter((x: Rec) => x.path.endsWith('.mp4'))).toEqual([]);
    const sheet = (await c.m.call('GET', '/api/unlink/status', undefined, { as: c.fAdmin })).body.session;
    expect(sheet.follower.numbers.videosNotFit).toEqual([{ title: 'Tazkirah Jumaat', bytes: vids[0]!.bytes }, { title: 'Kuliah Subuh', bytes: vids[1]!.bytes }]);
    // the copy the follower would pull has them gone
    const cdb = new DatabaseSync(outDbOf(c.m.dir, unlinkId, UNLINK_OUT_DIR), { readOnly: true });
    try {
      expect((cdb.prepare("SELECT COUNT(*) AS n FROM assets WHERE mime = 'video/mp4'").get() as { n: number }).n).toBe(0);
      expect((cdb.prepare("SELECT COUNT(*) AS n FROM content_items WHERE kind = 'video' AND deleted_at IS NULL").get() as { n: number }).n).toBe(0);
    } finally {
      cdb.close();
    }
  }, SLOW);
});

// ---------------------------------------------------------------- 3: the two carry-on combos of case S

describe('the carry-on combos of case S: outcome done on both sides', () => {
  it('follower carry-on + master carry-on: the master keeps its data and a note, the follower joins with its code', async () => {
    const c = await setup('S');
    const seed = await seedMaster(c, { leavingTv: true });
    const { m, f } = c;
    await startCarryOn(c, 'carry-on');
    await pull(c);
    // the master changes nothing of its own before the follower said the copy landed
    expect(readFileKept(m)).toBeNull();
    await w.restartOne(f);
    expectReduced(c, seed);
    const n2 = await reportCopied(c);
    await joinAndReport(c, n2);
    const end = await m.call('GET', '/api/unlink/status');
    expect(end.body.session).toBeNull();
    expect(end.body.last.outcome).toBe('done');
    expect(end.body.kept[0]).toMatchObject({ side: 'master', chosen: 'carry-on' });
    expect(count(m, 'SELECT COUNT(*) AS n FROM finance_entries')).toBeGreaterThan(0);
    expect(count(m, 'SELECT COUNT(*) AS n FROM linked_boxes WHERE removed_at IS NULL')).toBe(0);
    expect(existsSync(join(m.dir, 'link.json'))).toBe(false);
    // the follower's answering person has a PIN now and the join note is gone
    expect(row(f, 'SELECT pin_hash FROM users WHERE id = ?', c.fAdminOnF)?.pin_hash).not.toBeNull();
  }, SLOW);

  it('follower carry-on + master back: the master restores LAST, after joined; its kept note says back', async () => {
    const c = await setup('S');
    const seed = await seedMaster(c, { leavingTv: true });
    const { m, f } = c;
    await startCarryOn(c, 'back');
    await pull(c);
    await w.restartOne(f);
    expectReduced(c, seed);
    const n2 = await reportCopied(c);
    // the copy landed and the join is open; the master has still not touched its own store
    expect((await m.call('GET', '/api/unlink/status', undefined, { as: c.fAdmin })).body.session.stage).toBe('join');
    expect(existsSync(join(m.dir, 'link.json'))).toBe(false);
    expect(readFileKept(m)).toBeNull();
    const restartsBefore = m.restarts;
    await joinAndReport(c, n2);
    // now it plans its restore, writes its note and restarts
    expect(JSON.parse(readFileSync(join(m.dir, 'link.json'), 'utf8'))).toMatchObject({ op: 'restore', linkId: c.linkId });
    await until(() => expect(m.restarts).toBeGreaterThan(restartsBefore));
    await w.restartAll();
    expect(existsSync(join(m.dir, 'link.json'))).toBe(false);
    expect(readFileKept(m)).toMatchObject({ side: 'master', chosen: 'back', outcome: 'done', linkId: c.linkId });
    expect(count(m, 'SELECT COUNT(*) AS n FROM linked_boxes WHERE removed_at IS NULL')).toBe(0);
    expect(m.app.link!.unlinks.status(null).last).toMatchObject({ outcome: 'done' });
    // the master is back on the data it had before the link: the ledger it made after is not in it
    expect(count(m, 'SELECT COUNT(*) AS n FROM finance_entries')).toBe(0);
    // the follower still runs alone on its copy
    expect(f.app.link!.follow.present()).toBe(false);
    // only the entry `expectReduced` made itself to try the triggers; nothing of the master's ledger
    expect((f.app.surau.db.prepare('SELECT id FROM finance_entries').all() as { id: string }[]).map((r) => r.id)).toEqual(['new-1']);
  }, SLOW);
});

function readFileKept(box: XBox): Rec | null {
  try {
    return JSON.parse(readFileSync(join(box.dir, 'link-unlink-kept.json'), 'utf8')) as Rec;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 4: a power cut at every step of the reduce

const hashTree = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const rel of walkFiles(dir)) {
    if (/^surau\.db(-wal|-shm)?$/.test(rel)) continue;
    out[rel] = sha(readFileSync(join(dir, ...rel.split('/'))));
  }
  return out;
};

function endState(dir: string): { db: Record<string, string[]>; files: Record<string, string> } {
  const db = openDb(join(dir, 'surau.db'));
  try {
    return { db: dumpDb(db), files: hashTree(dir) };
  } finally {
    db.close();
  }
}

function bootAt(dir: string, afterStep?: (n: string) => void): BootResult {
  return applyLinkJournalAtBoot(dir, {
    reduce: (d, j, h) => runReduce(d, j, h, { boxId: () => boxIdOf(d), now: () => FIXED }),
    ...(afterStep !== undefined ? { afterStep } : {}),
  });
}

const cloneOf = (dir: string): string => {
  const d = mkdtempSync(join(tmpdir(), 'maxcom-carryon-'));
  tempDirs.push(d);
  cpSync(dir, d, { recursive: true });
  return d;
};

/** The follower's folder at the moment its plan and journal are written, before any restart (copied, the app closed). */
async function plannedFollower(): Promise<{ c: Ctx; base: string; plan: Rec }> {
  const c = await setup('S');
  await seedMaster(c, { leavingTv: true });
  await startCarryOn(c, 'carry-on');
  const plan = await pull(c);
  await c.f.app.close();
  return { c, base: cloneOf(c.f.dir), plan };
}

describe('reduceKillAtEveryStep', () => {
  it('a power cut at every reduce step, then another start, ends in the store a clean start makes', async () => {
    const { base } = await plannedFollower();
    const cleanDir = cloneOf(base);
    const steps: string[] = [];
    expect(bootAt(cleanDir, (n) => steps.push(n))).toBe('reduce');
    const named = steps.filter((n) => n.startsWith('reduce:'));
    expect(named).toEqual(expect.arrayContaining(['reduce:start', 'reduce:clear-done', 'reduce:swap-done', 'reduce:applied', 'reduce:cloud', 'reduce:kept', 'reduce:follow-removed', 'reduce:cleared']));
    expect(named.length).toBeGreaterThanOrEqual(12);
    const clean = endState(cleanDir);
    // the clean end is the reduced store
    expect(clean.db.finance_entries).toEqual([]);
    expect(clean.db.devices).toEqual([]);
    expect(clean.files['link.json']).toBeUndefined();
    expect(clean.files['link-reduce.json']).toBeUndefined();
    expect(clean.files['secret/follow.json']).toBeUndefined();
    expect(clean.files['link-unlink-kept.json']).toBeDefined();
    expect(Object.keys(clean.files).filter((p) => p.startsWith('linkstage'))).toEqual([]);

    for (let k = 0; k < named.length; k++) {
      const dir = cloneOf(base);
      let n = 0;
      let cut: unknown = null;
      try {
        bootAt(dir, (name) => {
          if (name.startsWith('reduce:') && n++ === k) throw new Error(`power cut at ${named[k]}`);
        });
      } catch (e) {
        cut = e;
      }
      expect(cut, `kill ${k} (${named[k]}) must stop the start`).toBeInstanceOf(Error);
      // the box starts again: the reduced store, a third start changes nothing
      expect(['reduce', 'none'], `after kill ${k} (${named[k]})`).toContain(bootAt(dir));
      expect(bootAt(dir)).toBe('none');
      const got = endState(dir);
      expect(got.files, `files after kill at ${named[k]}`).toEqual(clean.files);
      expect(got.db, `rows after kill at ${named[k]}`).toEqual(clean.db);
    }
  }, SLOW);

  it('a second power cut during the second start still ends in the clean store', async () => {
    const { base } = await plannedFollower();
    const cleanDir = cloneOf(base);
    bootAt(cleanDir);
    const clean = endState(cleanDir);
    const dir = cloneOf(base);
    for (const k of [2, 5]) {
      let n = 0;
      expect(() => bootAt(dir, (name) => {
        if (name.startsWith('reduce:') && n++ === k) throw new Error('power cut');
      })).toThrow('power cut');
    }
    bootAt(dir);
    expect(endState(dir)).toEqual(clean);
  }, SLOW);

  it.each([
    ['a listed file is missing', (d: string, p: Rec) => rmSync(join(stageDirOf(d, p.unlinkId), 'assets', 'poster-1.jpg'))],
    ['a listed file has the wrong size', (d: string, p: Rec) => truncateSync(join(stageDirOf(d, p.unlinkId), 'assets', 'poster-1.jpg'), 5)],
    ['a listed file is longer than listed', (d: string, p: Rec) => writeFileSync(join(stageDirOf(d, p.unlinkId), 'themes', 'hijau', 'theme.json'), 'x'.repeat(4000))],
    ['the database copy is missing', (d: string, p: Rec) => rmSync(join(stageDirOf(d, p.unlinkId), 'surau.db'))],
    ['there is no follow record', (d: string) => rmSync(join(d, 'secret', 'follow.json'))],
  ])('a journal at planned with %s: dropped, nothing moved, the follower still follows with its plan dropped', async (name, damage) => {
    const { base, plan } = await plannedFollower();
    const dir = cloneOf(base);
    const beforeDb = sha(readFileSync(join(dir, 'surau.db')));
    const beforeFiles = hashTree(dir);
    damage(dir, plan);
    expect(bootAt(dir)).toBe('dropped');
    expect(sha(readFileSync(join(dir, 'surau.db')))).toBe(beforeDb);
    expect(existsSync(join(dir, 'link.json'))).toBe(false);
    expect(existsSync(join(dir, 'link-reduce.json'))).toBe(false);
    expect(existsSync(join(dir, 'linkstage'))).toBe(false);
    // what the follower had is as it was (a missing follow record is the case's own damage)
    const after = hashTree(dir);
    for (const [rel, h] of Object.entries(beforeFiles)) {
      if (rel === 'link.json' || rel === 'link-reduce.json' || rel.startsWith('linkstage/')) continue;
      if (name === 'there is no follow record' && rel === 'secret/follow.json') continue;
      expect(after[rel], `${rel} after a dropped plan (${name})`).toBe(h);
    }
    if (name !== 'there is no follow record') expect(existsSync(join(dir, 'secret', 'follow.json'))).toBe(true);
    // the box opens as the follower it was
    const db = openDb(join(dir, 'surau.db'));
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM finance_entries').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
    expect(bootAt(dir)).toBe('none');
  }, SLOW);

  it('a plan file left with no journal is dropped at the next start', async () => {
    const { base } = await plannedFollower();
    const dir = cloneOf(base);
    rmSync(join(dir, 'link.json'));
    expect(existsSync(join(dir, 'link-reduce.json'))).toBe(true);
    sweepReduceLeftovers(dir, null);
    expect(existsSync(join(dir, 'link-reduce.json'))).toBe(false);
    expect(bootAt(dir)).toBe('none');
  }, SLOW);
});

// ---------------------------------------------------------------- 5: who may read the copy

let ipN = 0;
/** Every request from its own address: the per-IP limit of the list route is not what these tests are about. */
const freshIp = (): string => `10.168.50.${100 + (ipN++ % 100)}`;

async function listAt(c: Ctx, msg: unknown): Promise<{ status: number; body: Rec }> {
  const r = await c.m.app.inject({ method: 'POST', url: '/api/unlink/peer/store/list', remoteAddress: freshIp(), payload: msg as object });
  return { status: r.statusCode, body: safe(r) };
}

const signedList = (c: Ctx, unlinkId: string, extra: Record<string, unknown> = {}, signer: { dir: string } = c.f, linkId: string = c.linkId): { body: Rec; sig: string } => {
  const body = { unlinkId, boxId: c.f.boxId, page: 0, ...extra };
  return { body, sig: signLink(loadIdentity(signer.dir), 'store-list', linkId, body) };
};

/** Asks until the master's copy is ready. */
async function readyList(c: Ctx, unlinkId: string, extra: Record<string, unknown> = {}): Promise<{ list: MoveList; token: string }> {
  let out: Rec = {};
  await until(async () => {
    const r = await listAt(c, signedList(c, unlinkId, extra));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.state).toBe('ready');
    out = r.body;
  });
  return { list: { linkId: out.linkId, dbLevel: out.dbLevel, release: out.release, files: out.files, bytes: out.bytes } as MoveList, token: String(out.token) };
}

async function fileAt(c: Ctx, q: Record<string, string>, token?: string): Promise<{ status: number; body: Buffer; json: Rec }> {
  const r = await c.m.app.inject({
    method: 'GET', url: `/api/unlink/peer/store/file?${new URLSearchParams(q).toString()}`, remoteAddress: c.f.addr,
    headers: token === undefined ? {} : { [STORE_TOKEN_HEADER]: token },
  });
  return { status: r.statusCode, body: r.rawPayload, json: r.statusCode === 200 ? {} : safe(r) };
}

describe('copy access: the list and the files', () => {
  it('the list is refused (400 bad_message) unless it is the leaving follower\'s signed request in its open carry-on session; the files only for the right token', async () => {
    const c = await setup('S');
    await seedMaster(c, { leavingTv: true });
    const { m, f } = c;
    const unlinkId = await startCarryOn(c, 'carry-on');
    // before the follower fetched its order nothing is given
    const early = await listAt(c, signedList(c, unlinkId));
    expect(early.status).toBe(400);
    expect(early.body.code).toBe('bad_message');
    expect(existsSync(join(m.dir, 'unlinkcopy-out'))).toBe(false);
    await fetchOrder(c);

    const good = signedList(c, unlinkId);
    const refused: [string, unknown][] = [
      ['no signature', { body: good.body }],
      ['a bad signature', { body: good.body, sig: 'x' }],
      ['no body', { sig: good.sig }],
      ['the signature of another box', signedList(c, unlinkId, {}, m)],
      ['a changed body', { body: { ...good.body, freeBytes: 12345 }, sig: good.sig }],
      ['a signature for another step', { body: good.body, sig: signLink(loadIdentity(f.dir), 'unlink-report', c.linkId, good.body) }],
      ['a signature for another link', signedList(c, unlinkId, {}, f, 'f'.repeat(32))],
      ['an extra key', signedList(c, unlinkId, { extra: 1 })],
      ['freeBytes negative', signedList(c, unlinkId, { freeBytes: -1 })],
      ['freeBytes not an integer', signedList(c, unlinkId, { freeBytes: 1.5 })],
      ['freeBytes a string', signedList(c, unlinkId, { freeBytes: '100' })],
      ['freeBytes too big to be exact', signedList(c, unlinkId, { freeBytes: 1e300 })],
      ['another unlinkId', signedList(c, 'e'.repeat(32))],
      ['page negative', signedList(c, unlinkId, { page: -1 })],
      ['page not an integer', signedList(c, unlinkId, { page: 0.5 })],
      ['page a string', signedList(c, unlinkId, { page: '0' })],
      ['page beyond any list', signedList(c, unlinkId, { page: 100_000 })],
      ['another boxId', (() => { const b = { unlinkId, boxId: m.boxId, page: 0 }; return { body: b, sig: signLink(loadIdentity(f.dir), 'store-list', c.linkId, b) }; })()],
    ];
    for (const [name, msg] of refused) {
      const r = await listAt(c, msg);
      expect(r.status, name).toBe(400);
      expect(r.body.code, name).toBe('bad_message');
    }
    // nothing was built for any of those
    expect(existsSync(join(m.dir, 'unlinkcopy-out'))).toBe(false);

    // the right request: preparing, then ready with a token
    const first = await listAt(c, signedList(c, unlinkId));
    expect(first.status).toBe(200);
    expect(first.body.state).toBe('preparing');
    const a = await readyList(c, unlinkId);
    const paths = a.list.files.map((x) => x.path);
    expect(paths).toContain('surau.db');
    expect(paths.filter((p) => /^(finance|secret|live)\//.test(p))).toEqual([]);
    // a follower of the previous release asks without `page`: it is page 0, and the whole list also comes as `list`
    const old = await listAt(c, (() => { const b = { unlinkId, boxId: c.f.boxId }; return { body: b, sig: signLink(loadIdentity(f.dir), 'store-list', c.linkId, b) }; })());
    expect(old.status).toBe(200);
    expect(old.body.state).toBe('ready');
    expect((old.body as unknown as { list?: { files: unknown[] } }).list?.files.length).toBe(a.list.files.length);
    // that call made a fresh read token (the old one stops working), as every page 0 does
    (a as { token: string }).token = String((old.body as unknown as { token: string }).token);

    // files: not without a token, not with a wrong one, not another session, not a path that is not listed
    const asked = (path: string, unlinkIdQ = unlinkId): Record<string, string> => ({ unlinkId: unlinkIdQ, path });
    expect((await fileAt(c, asked('surau.db'))).status).toBe(404);
    expect((await fileAt(c, asked('surau.db'), 'z'.repeat(43))).status).toBe(404);
    expect((await fileAt(c, asked('surau.db'), 'short')).status).toBe(404);
    expect((await fileAt(c, asked('surau.db', 'e'.repeat(32)), a.token)).status).toBe(404);
    for (const p of ['../surau.db', '..\\surau.db', 'secret/box.key', 'secret/youtube-token.json', 'finance/photos/ph-seed-1.jpg', 'finance/photos/x', '', 'assets/../surau.db']) {
      const r = await fileAt(c, asked(p), a.token);
      expect(r.status, `path ${p}`).toBe(404);
      expect(r.json.code).toBe('not_found');
    }
    // the right file, whole and from a position (the follower resumes a cut pull)
    const db1 = await fileAt(c, asked('surau.db'), a.token);
    expect(db1.status).toBe(200);
    const listed = a.list.files.find((x) => x.path === 'surau.db')!;
    expect(db1.body.length).toBe(listed.size);
    expect(sha(db1.body)).toBe(listed.sha256);
    const part = await c.m.app.inject({
      method: 'GET', url: `/api/unlink/peer/store/file?${new URLSearchParams(asked('surau.db')).toString()}`, remoteAddress: f.addr,
      headers: { [STORE_TOKEN_HEADER]: a.token, range: 'bytes=100-' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.length).toBe(listed.size - 100);

    // a new list replaces the token: the old one is dead
    const b = await readyList(c, unlinkId);
    expect(b.token).not.toBe(a.token);
    expect((await fileAt(c, asked('surau.db'), a.token)).status).toBe(404);
    expect((await fileAt(c, asked('surau.db'), b.token)).status).toBe(200);

    // once the follower reported the copy, neither the list nor a file is given and the copy folder is gone
    expect(existsSync(join(m.dir, 'unlinkcopy-out'))).toBe(true);
    const fid = loadIdentity(f.dir);
    const note = { unlinkId, linkId: c.linkId, master: { addresses: [m.origin], ca: m.ca } };
    expect(await sendUnlinkReport(clientTo(m, f) as never, fid, f.boxId, note as never, 'copied')).toBe(true);
    const late = await listAt(c, signedList(c, unlinkId));
    expect(late.status).toBe(400);
    expect(late.body.code).toBe('bad_message');
    const gone = await fileAt(c, asked('surau.db'), b.token);
    expect(gone.status).toBe(404);
    expect(existsSync(join(m.dir, 'unlinkcopy-out'))).toBe(false);
  }, SLOW);

  it('a session where the follower chose back gives no copy', async () => {
    const c = await setup('S');
    await seedMaster(c, { leavingTv: false });
    const unlinkId = await startFollowerBack(c);
    await fetchOrder(c);
    const r = await listAt(c, signedList(c, unlinkId));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('bad_message');
    expect(existsSync(join(c.m.dir, 'unlinkcopy-out'))).toBe(false);
  }, SLOW);

  it('a route that is not on the surau network refuses (403 lan_only) and the report of a stranger changes nothing', async () => {
    const c = await setup('S');
    await seedMaster(c, { leavingTv: true });
    const unlinkId = await startCarryOn(c, 'carry-on');
    await fetchOrder(c);
    const r = await c.m.app.inject({ method: 'POST', url: '/api/unlink/peer/store/list', remoteAddress: '8.8.8.8', payload: signedList(c, unlinkId) });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('lan_only');
    const rep = await c.m.app.inject({ method: 'POST', url: '/api/unlink/peer/report', remoteAddress: c.f.addr, payload: { body: { unlinkId, boxId: c.f.boxId, event: 'copied' }, sig: 'x' } });
    expect(rep.statusCode).toBe(400);
    expect(c.m.app.link!.unlinks.writesBlocked()).toBe(true);
  }, SLOW);
});

describe('a copy still being built when the box stops', () => {
  it('a late build does not touch the closed database (no unhandled rejection), and the copy does not become ready afterwards', async () => {
    const c = await setup('S');
    await seedMaster(c, { leavingTv: true });
    const unlinkId = await startCarryOn(c, 'carry-on');
    await fetchOrder(c);
    const late: unknown[] = [];
    const onLate = (e: unknown): void => { late.push(e); };
    process.on('unhandledRejection', onLate);
    try {
      const first = await listAt(c, signedList(c, unlinkId));
      expect(first.status).toBe(200);
      expect(first.body.state).toBe('preparing');
      // the box stops while the files of the copy are still being hashed
      await c.m.app.close();
      await new Promise((r) => setTimeout(r, 800));
      expect(late.map(String)).toEqual([]);
    } finally {
      process.off('unhandledRejection', onLate);
    }
  }, SLOW);
});

describe('the list route polling limit', () => {
  // SOURCE BUG, not fixed here (file not owned): `apps/box-server/src/link/unlinkRoutes.ts:156` counts EVERY list request
  // in the `authIp` bucket (20 per 5 minutes, key `unlink:<ip>`), and the follower polls that route every 2 seconds
  // while the master prepares the copy (`src/follow/reducedPull.ts:23` and `:88`), so a copy that takes more than
  // about 40 seconds to build (large videos hashed) makes the follower's own polls answer 429 and the pull ends
  // (`reducedPull.ts:80`, "again", then 4 tries). The same bucket also serves `POST /api/unlink/peer/report`
  // (`unlinkRoutes.ts:212`), so the `copied` report is refused until the window slides. A fix gives the polling
  // its own, larger budget (or counts only a request that builds). This test states the wanted behaviour.
  it('a follower polling the list at its own pace (25 signed requests from one address) is never answered 429', async () => {
    const c = await setup('S');
    await seedMaster(c, { leavingTv: true });
    const unlinkId = await startCarryOn(c, 'carry-on');
    await fetchOrder(c);
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const r = await c.m.app.inject({ method: 'POST', url: '/api/unlink/peer/store/list', remoteAddress: c.f.addr, payload: signedList(c, unlinkId) });
      statuses.push(r.statusCode);
    }
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
  }, SLOW);
});

// ---------------------------------------------------------------- 6: copied before joined

describe('copiedBeforeJoined', () => {
  async function onCopy(): Promise<Ctx> {
    const c = await setup('S');
    const seed = await seedMaster(c, { leavingTv: true });
    await startCarryOn(c, 'carry-on');
    await pull(c);
    await w.restartOne(c.f);
    expectReduced(c, seed);
    // the master's address for the reporter (the note may carry none in this harness)
    const fid = loadIdentity(c.f.dir);
    const n = readUnlinkNote(c.f.dir, fid, c.f.boxId)!;
    writeUnlinkNote(c.f.dir, fid, c.f.boxId, { ...n, master: { ...n.master, addresses: [c.m.origin] } });
    return c;
  }
  const reporter = (c: Ctx, client: ReturnType<typeof clientTo>) =>
    startUnlinkReporter({ db: c.f.app.surau.db, dataDir: c.f.dir, identity: loadIdentity(c.f.dir), boxId: c.f.boxId, surauId: 'sdm', client: client as never, now: w.clock.now, everyMs: 3_600_000 });
  /** The phone joined at the follower: the code is spent and a PIN is set. */
  const joined = (c: Ctx): void => {
    const note = readUnlinkNote(c.f.dir, loadIdentity(c.f.dir), c.f.boxId)!;
    c.f.app.surau.db.prepare('UPDATE enrolments SET used_at = ? WHERE code_hash = ?').run(new Date().toISOString(), note.ticketHash);
    c.f.app.surau.db.prepare("UPDATE users SET pin_hash = 'pin-set' WHERE id = ?").run(c.fAdminOnF);
  };

  it('sends copied first and only then joined, and the master ends done', async () => {
    const c = await onCopy();
    const events: string[] = [];
    const r = reporter(c, clientTo(c.m, c.f, { events }));
    try {
      // the copy landed, the phone has not joined yet: only copied goes
      await r.check();
      expect(events).toEqual(['copied']);
      expect(readUnlinkNote(c.f.dir, loadIdentity(c.f.dir), c.f.boxId)).toMatchObject({ copied: true, applied: true });
      expect((await c.m.call('GET', '/api/unlink/status', undefined, { as: c.fAdmin })).body.session.stage).toBe('join');
      // a second look sends nothing new
      await r.check();
      expect(events).toEqual(['copied']);
      joined(c);
      await r.check();
      expect(events).toEqual(['copied', 'joined']);
    } finally {
      r.stop();
    }
    expect(unlinkNotePresent(c.f.dir)).toBe(false);
    expect((await c.m.call('GET', '/api/unlink/status')).body.last.outcome).toBe('done');
  }, SLOW);

  it('a joined phone is not reported while the master is still at working: copied has to be accepted first', async () => {
    const c = await onCopy();
    joined(c);
    const events: string[] = [];
    // the master does not answer the copied report
    const dead = reporter(c, clientTo(c.m, c.f, { events, failCopied: true }));
    try {
      await dead.check();
    } finally {
      dead.stop();
    }
    expect(events).toEqual(['copied']);
    expect(readUnlinkNote(c.f.dir, loadIdentity(c.f.dir), c.f.boxId)).toMatchObject({ copied: false });
    expect((await c.m.call('GET', '/api/unlink/status')).body.session.stage).toBe('working');
    // the master is back: copied, then joined, in that order
    const events2: string[] = [];
    const ok = reporter(c, clientTo(c.m, c.f, { events: events2 }));
    try {
      await ok.check();
    } finally {
      ok.stop();
    }
    expect(events2).toEqual(['copied', 'joined']);
    expect((await c.m.call('GET', '/api/unlink/status')).body.last.outcome).toBe('done');
  }, SLOW);
});

// ---------------------------------------------------------------- 7: writes held during the copy, the TV line

it('the master holds writes during the copy (409 linking) and not after copied; the follower\'s TV says copy with a percent while it pulls', async () => {
  const c = await setup('S');
  const seed = await seedMaster(c, { leavingTv: true });
  const { m, f } = c;
  await startCarryOn(c, 'carry-on');
  const held = await m.call('PUT', '/api/finance/entries/e-seed-2', {}, { as: seed.treasurer });
  expect(held.status).toBe(409);
  expect(held.body.code).toBe('linking');
  expect(m.app.link!.unlinks.writesBlocked()).toBe(true);
  // reads and the unlink's own routes stay open
  expect((await m.call('GET', '/api/unlink/status')).status).toBe(200);
  const samples: Rec[] = [];
  await pull(c, samples);
  // while pulling: step copy and a percent between 0 and 99
  expect(samples.length).toBeGreaterThan(0);
  expect(samples[0]).toMatchObject({ step: 'copy' });
  for (const s of samples.filter((x) => x.step === 'copy')) {
    expect(typeof s.percent).toBe('number');
    expect(s.percent).toBeGreaterThanOrEqual(0);
    expect(s.percent).toBeLessThanOrEqual(99);
  }
  // the pull is whole; the master still waits for the follower to say so
  await until(async () => expect((await f.tv()).body.unlink).toMatchObject({ step: 'carry-on', percent: null }));
  expect((await m.call('PUT', '/api/finance/entries/e-seed-2', {}, { as: seed.treasurer })).body.code).toBe('linking');
  const sheet = (await m.call('GET', '/api/unlink/status')).body.session;
  expect(sheet.progress.step).toBe('copy');
  await w.restartOne(f);
  expectReduced(c, seed);
  expect((await m.call('PUT', '/api/finance/entries/e-seed-2', {}, { as: seed.treasurer })).body.code).toBe('linking');
  await reportCopied(c);
  expect(m.app.link!.unlinks.writesBlocked()).toBe(false);
  const free = await m.call('PUT', '/api/finance/entries/e-seed-2', {}, { as: seed.treasurer });
  expect(free.body.code).not.toBe('linking');
  expect(free.status).not.toBe(409);
}, SLOW);

// ---------------------------------------------------------------- 8: a pull the master refuses

it('a pull the master refuses (its session ended): the note is cleared, the follower still follows, no journal, no stage', async () => {
  const c = await setup('S');
  await seedMaster(c, { leavingTv: true });
  const { m, f } = c;
  await startCarryOn(c, 'carry-on');
  const ord = await fetchOrder(c);
  // the master's work window runs out before the follower takes its order: the session ends failed
  w.clock.tick(61 * 60_000);
  const st = m.app.link!.unlinks.status(null);
  expect(st.session).toBeNull();
  expect(st.last?.outcome).toBe('failed');
  expect(m.app.link!.unlinks.writesBlocked()).toBe(false);
  const rec = f.app.link!.follow.read();
  expect(f.app.link!.takeOrder!(ord)).toBe(true);
  expect(unlinkNotePresent(f.dir)).toBe(true);
  await until(() => expect(unlinkNotePresent(f.dir)).toBe(false));
  expect(f.app.link!.follow.present()).toBe(true);
  expect(f.app.link!.follow.read()).toEqual(rec);
  expect(existsSync(join(f.dir, 'link.json'))).toBe(false);
  expect(existsSync(join(f.dir, 'link-reduce.json'))).toBe(false);
  expect(existsSync(join(f.dir, 'linkstage'))).toBe(false);
  expect(existsSync(join(m.dir, 'unlinkcopy-out'))).toBe(false);
  // the TV line goes back to nothing, and no copy was ever made
  await until(async () => expect((await f.tv()).body.unlink).toBeNull());
  expect(existsSync(join(f.dir, 'finance'))).toBe(false);
}, SLOW);
