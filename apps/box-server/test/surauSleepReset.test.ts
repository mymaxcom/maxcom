import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import type { JsonWebKey } from '../src/auth/crypto.ts';
import { checkIds } from '../src/auth/ids.ts';
import { createUser, tx } from '../src/auth/users.ts';
import { putFeature } from '../src/settingsStore.ts';
import { run as runUsersCli } from '../src/cli/users.ts';
import { HDR_NONCE, HDR_SIG, HDR_TS, signBoxCall } from '../src/sync/boxCall.ts';
import { RESET_ASSET_MAX, RESET_ENTRY_MAX } from '../src/sync/surauReset.ts';
import { registerSurauSleepRoutes, sleepOf, surauLogFloor, wakeSurau } from '../src/sync/surauSleep.ts';
import type { SurauSleepDeps } from '../src/sync/surauSleep.ts';
import { emptySuraus, pruneEmptySuraus, sweepResetBackups } from '../src/surau/prune.ts';
import { loginAs, TEST_PIN } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { insertSite } from './support/sites.ts';
import type { TestSite } from './support/sites.ts';
import { ensureSurau } from './support/surauRow.ts';

/*
 * Multi-box 2B, block B3 (cloud side): sleep, wake and reset-from-box. Contract:
 * `docs/design/plans/2026-11-23-cloud-sleep-reset-contract.md`. Every test asserts the status, the code AND the
 * database. The cloud is a real `buildApp` (role cloud, a file database in a temp folder); two suraus, each with its
 * own linked site and its own key pair.
 */

const BOX_A = 'a1a1a1a1a1a1a1a1';
const BOX_A2 = 'a2a2a2a2a2a2a2a2';
const BOX_B = 'b2b2b2b2b2b2b2b2';
const A = 's1';
const B = 's2';
const T0 = '2026-11-20T01:00:00.000Z';
const RESET = '/api/sync/reset-from-box';
const SLEEP = '/api/sync/sleep';
const WAKE = '/api/sync/wake';

type Rec = Record<string, unknown>;

interface Side {
  surauId: string;
  boxId: string;
  site: TestSite;
  priv: JsonWebKey;
  pub: JsonWebKey;
}

interface World {
  dir: string;
  dbPath: string;
  app: FastifyInstance;
  db: DatabaseSync;
  a: Side;
  b: Side;
}

interface Answer {
  status: number;
  code: string | null;
  body: Rec;
}

interface CallOpts {
  nonce?: string;
  at?: Date;
  /** Sign with another key than the side's own. */
  sigBy?: JsonWebKey;
  /** Send these bytes instead of the ones that were signed. */
  rawOverride?: string;
  /** Headers left out. */
  drop?: string[];
  /** Replace the signature header. */
  sig?: string;
  /** Use another side's bearer token. */
  tokenOf?: Side;
}

const open: World[] = [];
const extraApps: FastifyInstance[] = [];
let savedPlain: string | undefined;
let savedRecipient: string | undefined;

beforeEach(() => {
  savedPlain = process.env.MAXCOM_PRUNE_PLAIN_BACKUP;
  savedRecipient = process.env.MAXCOM_BACKUP_RECIPIENT_FILE;
  process.env.MAXCOM_PRUNE_PLAIN_BACKUP = '1';
});

afterEach(async () => {
  for (const x of extraApps.splice(0)) await x.close().catch(() => undefined);
  for (const w of open.splice(0)) {
    await w.app.close().catch(() => undefined);
    rmSync(w.dir, { recursive: true, force: true });
  }
  if (savedPlain === undefined) delete process.env.MAXCOM_PRUNE_PLAIN_BACKUP;
  else process.env.MAXCOM_PRUNE_PLAIN_BACKUP = savedPlain;
  if (savedRecipient === undefined) delete process.env.MAXCOM_BACKUP_RECIPIENT_FILE;
  else process.env.MAXCOM_BACKUP_RECIPIENT_FILE = savedRecipient;
});

// ---- the world -------------------------------------------------------------------------------------------------------

function makeSide(db: DatabaseSync, surauId: string, boxId: string): Side {
  ensureSurau(db, surauId, `Surau ${surauId}`);
  const site = insertSite(db, { surauId, boxId });
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const pub = { kty: 'EC', crv: 'P-256', x: pubJwk.x, y: pubJwk.y } as unknown as JsonWebKey;
  db.prepare('UPDATE sites SET public_jwk = ? WHERE box_id = ?').run(JSON.stringify(pub), boxId);
  return { surauId, boxId, site, priv: privateKey.export({ format: 'jwk' }) as unknown as JsonWebKey, pub };
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'surau-sleepreset-'));
  const dbPath = join(dir, 'cloud.db');
  const app = buildApp(dbPath, { role: 'cloud', dataDir: dir, boxId: '0c10ad000000000d' });
  const db = app.surau.db;
  const w: World = { dir, dbPath, app, db, a: makeSide(db, A, BOX_A), b: makeSide(db, B, BOX_B) };
  open.push(w);
  return w;
}

async function call(w: World, side: Side, path: string, body: unknown, o: CallOpts = {}): Promise<Answer> {
  const raw = JSON.stringify(body);
  const nonce = o.nonce ?? randomBytes(16).toString('base64url');
  const h: Record<string, string> = signBoxCall(o.sigBy ?? side.priv, { method: 'POST', path, boxId: side.boxId, body: raw, now: o.at ?? new Date(), nonce });
  if (o.sig !== undefined) h[HDR_SIG] = o.sig;
  for (const k of o.drop ?? []) delete h[k];
  const res = await w.app.inject({
    method: 'POST',
    url: path,
    payload: o.rawOverride ?? raw,
    headers: { ...(o.tokenOf ?? side).site.headers, 'content-type': 'application/json', ...h },
  });
  return answer(res.statusCode, res.body);
}

function answer(status: number, text: string): Answer {
  let body: Rec = {};
  try {
    body = JSON.parse(text) as Rec;
  } catch {
    body = {};
  }
  return { status, code: typeof body.code === 'string' ? body.code : null, body };
}

// ---- state builders --------------------------------------------------------------------------------------------------

function entry(entity: string, entityId: string, after: unknown, extra: Rec = {}): Rec {
  return { seq: 1, entity, entityId, rev: `${T0}|local`, editedAt: T0, syncedAt: T0, actor: 'user:x', deviceId: null, origin: 'local', opId: null, after, ...extra };
}

const content = (id: string, name: string): Rec => entry('content:penceramah', id, { name });
const fund = (id: string, name: string): Rec => entry('finance:fund', id, { name, public: true, sortOrder: 1 });
const perihal = (id: string, label: string): Rec => entry('finance:perihal', id, { direction: 'in', label, sortOrder: 1 });
const ledger = (id: string, fundId: string, perihalId: string, amountSen: number, entryDate = '2026-11-08'): Rec =>
  entry('finance:entry', id, { id, kind: 'in', entryDate, fundId, perihalId, amountSen, method: 'bank', reference: 'FPX99', refNo: null, createdBy: 'u1', editedAt: T0 });
const month = (ym: string): Rec => entry('finance:month', ym, { ym, status: 'closed' });
const userE = (id: string, name: string, roles: string[] = ['admin']): Rec => entry('user', id, { name, roles, active: true });

function keyJwk(): { x: string; y: string; kty: 'EC'; crv: 'P-256' } {
  const j = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  return { kty: 'EC', crv: 'P-256', x: String(j.x), y: String(j.y) };
}
const deviceE = (id: string, userId: string, publicJwk: unknown): Rec =>
  entry('device', id, { id, userId, name: 'Telefon Dewan Utama', platform: 'android', publicJwk, enrolledAt: T0 });

/** The surau's people and phones as the cloud holds them now (what a box that kept them would send). */
function peopleOf(db: DatabaseSync, surauId: string): Rec[] {
  const out: Rec[] = [];
  for (const u of db.prepare('SELECT id, name, roles_json, active FROM users WHERE surau_id = ? AND deleted_at IS NULL').all(surauId)) {
    out.push(userE(String(u.id), String(u.name), JSON.parse(String(u.roles_json)) as string[]));
  }
  for (const d of db.prepare('SELECT id, user_id, name, platform, public_jwk, enrolled_at FROM devices WHERE surau_id = ? AND revoked_at IS NULL').all(surauId)) {
    out.push(entry('device', String(d.id), { id: String(d.id), userId: String(d.user_id), name: String(d.name), platform: String(d.platform), publicJwk: JSON.parse(String(d.public_jwk)), enrolledAt: String(d.enrolled_at) }));
  }
  return out;
}

const body = (entries: Rec[], assets: string[] = [], reason = 'adopt'): Rec => ({ linkId: 'L1', reason, state: { entries, assets } });
const reset = (w: World, side: Side, entries: Rec[], assets: string[] = [], o: CallOpts = {}): Promise<Answer> => call(w, side, RESET, body(entries, assets), o);
const hex = (n: number): string => createHash('sha256').update(`asset-${n}`).digest('hex');

// ---- observers -------------------------------------------------------------------------------------------------------

const SURAU_TABLES = [
  'content_items', 'settings', 'users', 'devices', 'finance_funds', 'finance_perihal', 'finance_entries', 'finance_months',
  'finance_photos', 'surau_assets', 'prayer_imports', 'prayer_file_days', 'prayer_corrections', 'change_log',
];

/** Everything the database holds for one surau, as text. */
function fingerprint(db: DatabaseSync, surauId: string): string {
  const out: Record<string, unknown> = {};
  for (const t of SURAU_TABLES) out[t] = db.prepare(`SELECT * FROM ${t} WHERE surau_id = ? ORDER BY rowid`).all(surauId);
  out.surau = db.prepare('SELECT * FROM suraus WHERE id = ?').get(surauId);
  return JSON.stringify(out);
}

const count = (db: DatabaseSync, sql: string, ...args: string[]): number => Number(db.prepare(sql).get(...args)?.n ?? 0);
const resetRows = (db: DatabaseSync, surauId: string): Rec[] => db.prepare('SELECT * FROM surau_resets WHERE surau_id = ? ORDER BY id').all(surauId);
const ids = (db: DatabaseSync, sql: string, ...args: string[]): string[] => db.prepare(sql).all(...args).map((r) => String(r.id));

function resetBackups(dir: string): string[] {
  try {
    return readdirSync(join(dir, 'backups')).filter((f) => f.startsWith('pre-reset-')).sort();
  } catch {
    return [];
  }
}

/** The same without the nonce count: a call that passed the signature check spends its nonce, whatever it is refused for. */
function settled(w: World): string {
  return JSON.stringify([fingerprint(w.db, A), fingerprint(w.db, B), count(w.db, 'SELECT COUNT(*) AS n FROM surau_resets'), resetBackups(w.dir)]);
}

/** Everything a refused reset must leave exactly as it was. */
function mark(w: World): string {
  return JSON.stringify([fingerprint(w.db, A), fingerprint(w.db, B), count(w.db, 'SELECT COUNT(*) AS n FROM surau_resets'), count(w.db, 'SELECT COUNT(*) AS n FROM sync_nonces'), resetBackups(w.dir)]);
}

async function phone(w: World, surauId: string): Promise<Login> {
  return loginAs(w.app, 'admin', TEST_PIN, surauId);
}

async function getAs(w: World, headers: Rec, url: string): Promise<Answer> {
  const res = await w.app.inject({ method: 'GET', url, headers: headers as Record<string, string> });
  return answer(res.statusCode, res.body);
}

async function postAs(w: World, headers: Rec, url: string, payload: unknown): Promise<Answer> {
  const res = await w.app.inject({ method: 'POST', url, headers: headers as Record<string, string>, payload: payload as Rec });
  return answer(res.statusCode, res.body);
}

/** A reset that must be accepted (used to put state on the cloud through the real door). */
async function seed(w: World, side: Side, entries: Rec[], assets: string[] = []): Promise<Answer> {
  const r = await reset(w, side, entries, assets);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r;
}

// =====================================================================================================================
describe('signed box calls', () => {
  it('resetReplayRefused: the same signed call twice, the second is 409 replay and changes nothing', async () => {
    const w = world();
    const nonce = randomBytes(16).toString('base64url');
    const req = body([content('new1', 'Ustaz Baru')]);
    const first = await call(w, w.a, RESET, req, { nonce });
    expect([first.status, first.code]).toEqual([200, null]);
    expect(ids(w.db, 'SELECT id FROM content_items WHERE surau_id = ?', A)).toEqual(['new1']);
    expect(count(w.db, 'SELECT COUNT(*) AS n FROM sync_nonces WHERE box_id = ? AND nonce = ?', BOX_A, nonce)).toBe(1);
    const before = mark(w);
    const second = await call(w, w.a, RESET, req, { nonce });
    expect([second.status, second.code]).toEqual([409, 'replay']);
    expect(mark(w)).toBe(before);
    expect(resetRows(w.db, A)).toHaveLength(1);
  });

  it('resetReplayRefused: a captured call of the sleep route cannot be sent twice either', async () => {
    const w = world();
    const nonce = randomBytes(16).toString('base64url');
    expect((await call(w, w.a, SLEEP, { linkId: 'L1', reason: 'link' }, { nonce })).status).toBe(200);
    const again = await call(w, w.a, SLEEP, { linkId: 'L1', reason: 'link' }, { nonce });
    expect([again.status, again.code]).toEqual([409, 'replay']);
  });

  it('resetWrongKeyRefused: every forged or stale call is refused, changes nothing, and does not spend the nonce', async () => {
    const w = world();
    const nonce = randomBytes(16).toString('base64url');
    const req = body([content('new1', 'Ustaz Baru')]);
    const base = mark(w);
    const refusals: [string, Answer][] = [
      ['bad signature', await call(w, w.a, RESET, req, { nonce, sig: 'A'.repeat(86) })],
      ['another site key', await call(w, w.a, RESET, req, { nonce, sigBy: w.b.priv })],
      ['body changed after signing', await call(w, w.a, RESET, req, { nonce, rawOverride: JSON.stringify(body([content('new1', 'Ustaz Lain')])) })],
      ['11 minutes old', await call(w, w.a, RESET, req, { nonce, at: new Date(Date.now() - 11 * 60_000) })],
      ['11 minutes ahead', await call(w, w.a, RESET, req, { nonce, at: new Date(Date.now() + 11 * 60_000) })],
      ['no ts', await call(w, w.a, RESET, req, { nonce, drop: [HDR_TS] })],
      ['no nonce', await call(w, w.a, RESET, req, { nonce, drop: [HDR_NONCE] })],
      ['no sig', await call(w, w.a, RESET, req, { nonce, drop: [HDR_SIG] })],
    ];
    const expected = ['bad_sig', 'bad_sig', 'bad_sig', 'clock', 'clock', 'bad_sig', 'bad_sig', 'bad_sig'];
    refusals.forEach(([why, r], i) => {
      expect([why, r.status, r.code]).toEqual([why, 403, expected[i]]);
    });
    // nothing changed and no nonce was spent (a forged call must not burn the one the real box is about to use)
    expect(mark(w)).toBe(base);
    expect(count(w.db, 'SELECT COUNT(*) AS n FROM sync_nonces')).toBe(0);
    expect(ids(w.db, 'SELECT id FROM content_items WHERE surau_id = ?', A)).toEqual([]);
    const real = await call(w, w.a, RESET, req, { nonce });
    expect([real.status, real.code]).toEqual([200, null]);
    expect(ids(w.db, 'SELECT id FROM content_items WHERE surau_id = ?', A)).toEqual(['new1']);
    // each refusal left one auth_log row
    expect(count(w.db, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'box_call_refused'")).toBe(8);
  });

  it('resetWrongKeyRefused: a site with no public key is 403 no_key', async () => {
    const w = world();
    w.db.prepare('UPDATE sites SET public_jwk = NULL WHERE box_id = ?').run(BOX_A);
    const before = mark(w);
    const r = await reset(w, w.a, [content('new1', 'Ustaz Baru')]);
    expect([r.status, r.code]).toEqual([403, 'no_key']);
    expect(mark(w)).toBe(before);
  });

  it('resetWrongKeyRefused: a signature made for another path is refused (a sleep signature cannot reset)', async () => {
    const w = world();
    const raw = JSON.stringify(body([content('new1', 'Ustaz Baru')]));
    const h = signBoxCall(w.a.priv, { method: 'POST', path: SLEEP, boxId: w.a.boxId, body: raw, now: new Date(), nonce: randomBytes(16).toString('base64url') });
    const res = await w.app.inject({ method: 'POST', url: RESET, payload: raw, headers: { ...w.a.site.headers, 'content-type': 'application/json', ...h } });
    expect([res.statusCode, answer(res.statusCode, res.body).code]).toEqual([403, 'bad_sig']);
    expect(ids(w.db, 'SELECT id FROM content_items WHERE surau_id = ?', A)).toEqual([]);
  });
});

// =====================================================================================================================
describe('reset stays inside the site\'s own surau', () => {
  it('resetOtherSurauRefused: the body cannot name a surau', async () => {
    const w = world();
    const before = mark(w);
    const top = await call(w, w.a, RESET, { ...body([content('new1', 'Ustaz Baru')]), surauId: B });
    expect([top.status, top.code, top.body.detail]).toEqual([400, 'bad_state', 'body']);
    const inState = await call(w, w.a, RESET, { linkId: 'L1', reason: 'adopt', state: { entries: [], assets: [], surauId: B } });
    expect([inState.status, inState.code, inState.body.detail]).toEqual([400, 'bad_state', 'state']);
    const inEntry = await reset(w, w.a, [{ ...content('new1', 'Ustaz Baru'), surauId: B }]);
    expect([inEntry.status, inEntry.code, inEntry.body.detail]).toEqual([400, 'bad_state', 'entries[0]:bad_shape']);
    // the nonces of the three refused calls are spent, nothing else moved
    expect(count(w.db, 'SELECT COUNT(*) AS n FROM sync_nonces')).toBe(3);
    expect(JSON.parse(mark(w))).toEqual([...(JSON.parse(before) as unknown[]).slice(0, 2), 0, 3, []]);
  });

  it('resetOtherSurauRefused: site A resets only surau A; surau B is byte for byte the same (content, people, finance, log floor)', async () => {
    const w = world();
    const key = keyJwk();
    await seed(w, w.b, [
      content('shared1', 'Ustaz B'), entry('settings', 'ticker', { speed: 'fast' }), fund('fb', 'Tabung B'), perihal('pb', 'Derma B'), ledger('eb1', 'fb', 'pb', 7000),
      month('2026-10'), userE('ub1', 'Pengurus B'), deviceE('db1', 'ub1', key),
    ]);
    w.db.prepare("INSERT INTO surau_assets (surau_id, asset_id, bytes, created_at) VALUES (?, ?, 10, ?)").run(B, hex(1), T0);
    const floorB = surauLogFloor(w.db, B);
    expect(floorB).toBeGreaterThan(0);
    const fpB = fingerprint(w.db, B);
    // A resets with a content id equal to one of B's: per-surau keys, so B's row stays
    const r = await reset(w, w.a, [content('shared1', 'Ustaz A'), fund('fa', 'Tabung A')]);
    expect(r.status).toBe(200);
    expect(fingerprint(w.db, B)).toBe(fpB);
    expect(surauLogFloor(w.db, B)).toBe(floorB);
    expect(w.db.prepare("SELECT json FROM content_items WHERE surau_id = ? AND id = 'shared1'").get(B)?.json).toContain('Ustaz B');
    expect(ids(w.db, 'SELECT id FROM content_items WHERE surau_id = ?', A)).toEqual(['shared1']);
    expect(ids(w.db, 'SELECT id FROM users WHERE surau_id = ?', B)).toEqual(['ub1']);
    expect(ids(w.db, 'SELECT id FROM devices WHERE surau_id = ?', B)).toEqual(['db1']);
    expect(resetRows(w.db, A)).toHaveLength(1);
    expect(resetRows(w.db, B)).toHaveLength(1);
    // and the other way round: B's token resets B only
    const fpA = fingerprint(w.db, A);
    const floorA = surauLogFloor(w.db, A);
    const rb = await reset(w, w.b, [content('shared1', 'Ustaz B Baharu'), userE('ub1', 'Pengurus B'), deviceE('db1', 'ub1', key)]);
    expect(rb.status).toBe(200);
    expect(fingerprint(w.db, A)).toBe(fpA);
    expect(surauLogFloor(w.db, A)).toBe(floorA);
    expect(w.db.prepare("SELECT json FROM content_items WHERE surau_id = ? AND id = 'shared1'").get(B)?.json).toContain('Ustaz B Baharu');
  });

  it('resetOtherSurauRefused: a state naming a person or phone of another surau is 409 foreign_id (see resetForeignPersonRefused)', async () => {
    const w = world();
    await seed(w, w.b, [userE('ub1', 'Pengurus B')]);
    const before = settled(w);
    const r = await reset(w, w.a, [userE('ub1', 'Pengurus B')]);
    expect([r.status, r.code]).toEqual([409, 'foreign_id']);
    expect(settled(w)).toBe(before);
  });
});

// =====================================================================================================================
describe('a sleeping surau', () => {
  it('sleepingSurauRefusesWrites: sites and phones cannot write, reads answer, wake is the sleeper\'s', async () => {
    const w = world();
    const a2 = makeSide(w.db, A, BOX_A2);
    const phoneA = await phone(w, A);
    const phoneB = await phone(w, B);
    const write = (headers: Rec): Promise<Answer> => postAs(w, headers, '/api/sync/ops', { ops: [] });

    // awake: nothing refuses these
    expect((await write(w.a.site.headers)).code).not.toBe('surau_asleep');
    expect((await write(phoneA.headers)).code).not.toBe('surau_asleep');

    const slept = await call(w, w.a, SLEEP, { linkId: 'L1', reason: 'link' });
    expect([slept.status, slept.code, slept.body.ok]).toEqual([200, null, true]);
    const row = w.db.prepare('SELECT asleep_at, asleep_box FROM suraus WHERE id = ?').get(A)!;
    expect(row.asleep_box).toBe(BOX_A);
    expect(typeof row.asleep_at).toBe('string');
    expect(sleepOf(w.db, A)?.asleepBox).toBe(BOX_A);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM change_log WHERE entity = 'surau' AND entity_id = ?", A)).toBe(1);
    // surau B is not asleep
    expect(sleepOf(w.db, B)).toBeNull();

    // the site's writes
    const push = await write(w.a.site.headers);
    expect([push.status, push.code]).toEqual([409, 'surau_asleep']);
    const putAsset = await w.app.inject({ method: 'PUT', url: `/api/sync/assets/${'a'.repeat(64)}`, headers: { ...w.a.site.headers, 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
    expect([putAsset.statusCode, answer(putAsset.statusCode, putAsset.body).code]).toEqual([409, 'surau_asleep']);
    // a phone of that surau: POST and PUT
    const phonePost = await write(phoneA.headers);
    expect([phonePost.status, phonePost.code]).toEqual([409, 'surau_asleep']);
    const phoneUser = await postAs(w, phoneA.headers, '/api/users', { name: 'Orang Baru', roles: ['ajk'] });
    expect([phoneUser.status, phoneUser.code]).toEqual([409, 'surau_asleep']);
    const phonePut = await w.app.inject({ method: 'PUT', url: '/api/settings/ticker', headers: phoneA.headers as Record<string, string>, payload: { speed: 'slow' } });
    expect([phonePut.statusCode, answer(phonePut.statusCode, phonePut.body).code]).toEqual([409, 'surau_asleep']);
    // the other surau's phone and site are not touched
    expect((await write(phoneB.headers)).code).not.toBe('surau_asleep');
    expect((await write(w.b.site.headers)).code).not.toBe('surau_asleep');
    expect((await postAs(w, phoneB.headers, '/api/users', { name: 'Orang Lain', roles: ['ajk'] })).code).not.toBe('surau_asleep');

    // reads still answer
    expect((await getAs(w, w.a.site.headers, '/api/sync/snapshot')).status).toBe(200);
    expect((await getAs(w, w.a.site.headers, '/api/sync/changes?since=0')).status).toBe(200);
    expect((await getAs(w, phoneA.headers, '/api/sync/snapshot')).status).toBe(200);
    expect((await getAs(w, phoneA.headers, '/api/sync/changes?since=0')).status).toBe(200);

    // reset of a sleeping surau
    const before = mark(w);
    const rs = await reset(w, w.a, [content('new1', 'Ustaz Baru')]);
    expect([rs.status, rs.code]).toEqual([409, 'surau_asleep']);
    expect(mark(w)).toBe(before);

    // sleeping again by the same box is fine; another box of the same surau cannot take the sleep over
    const again = await call(w, w.a, SLEEP, { linkId: 'L1', reason: 'link' });
    expect([again.status, again.body.ok]).toEqual([200, true]);
    expect(sleepOf(w.db, A)?.asleepBox).toBe(BOX_A);
    const other = await call(w, a2, SLEEP, { linkId: 'L2', reason: 'link' });
    expect([other.status, other.code]).toEqual([409, 'surau_asleep']);
    expect(sleepOf(w.db, A)?.asleepBox).toBe(BOX_A);

    // wake: by ANOTHER site of the same surau is refused, by the sleeper it works
    const wrong = await call(w, a2, WAKE, { linkId: 'L1', reason: 'unlink-back' });
    expect([wrong.status, wrong.code]).toEqual([403, 'not_sleeper']);
    expect(sleepOf(w.db, A)).not.toBeNull();
    const right = await call(w, w.a, WAKE, { linkId: 'L1', reason: 'unlink-back' });
    expect([right.status, right.body.ok]).toEqual([200, true]);
    expect(sleepOf(w.db, A)).toBeNull();
    expect(w.db.prepare('SELECT asleep_at, asleep_box FROM suraus WHERE id = ?').get(A)).toMatchObject({ asleep_at: null, asleep_box: null });
    expect((await write(w.a.site.headers)).code).not.toBe('surau_asleep');
    expect((await write(phoneA.headers)).code).not.toBe('surau_asleep');
    expect((await postAs(w, phoneA.headers, '/api/users', { name: 'Orang Baru', roles: ['ajk'] })).code).not.toBe('surau_asleep');
    // waking an awake surau is a quiet 200
    expect((await call(w, w.a, WAKE, { linkId: 'L1', reason: 'unlink-on' })).status).toBe(200);
  });

  it('sleepingSurauRefusesWrites: a sleep or wake body that names more than linkId and reason, or a wrong reason, is 400 bad_body', async () => {
    const w = world();
    for (const b of [{ linkId: 'L1', reason: 'link', surauId: B }, { linkId: 'L1', reason: 'restore' }, { linkId: 'nope nope', reason: 'link' }, { reason: 'link' }]) {
      const r = await call(w, w.a, SLEEP, b);
      expect([r.status, r.code]).toEqual([400, 'bad_body']);
    }
    expect((await call(w, w.a, WAKE, { linkId: 'L1', reason: 'link' })).code).toBe('bad_body');
    expect(sleepOf(w.db, A)).toBeNull();
    expect(sleepOf(w.db, B)).toBeNull();
  });

  it('sleepingSurauRefusesWrites: the operator CLI surau-wake wakes it, and says so when it was awake', async () => {
    const w = world();
    expect((await call(w, w.a, SLEEP, { linkId: 'L1', reason: 'link' })).status).toBe(200);
    expect((await call(w, w.b, SLEEP, { linkId: 'L9', reason: 'link' })).status).toBe(200);
    const out: string[] = [];
    const err: string[] = [];
    const saved = process.env.SURAU_ROLE;
    process.env.SURAU_ROLE = 'cloud';
    try {
      const code = await runUsersCli(['--db', w.dbPath, 'surau-wake', '--surau', A], { out: (l) => out.push(l), err: (l) => err.push(l) });
      expect([code, err.join('\n')]).toEqual([0, '']);
      expect(out.join('\n')).toContain('dibangunkan');
      const again = await runUsersCli(['--db', w.dbPath, 'surau-wake', '--surau', A], { out: (l) => out.push(l), err: (l) => err.push(l) });
      expect(again).toBe(0);
      expect(out.at(-1)).toContain('tidak dibekukan');
    } finally {
      if (saved === undefined) delete process.env.SURAU_ROLE;
      else process.env.SURAU_ROLE = saved;
    }
    expect(sleepOf(w.db, A)).toBeNull();
    // the other surau still sleeps
    expect(sleepOf(w.db, B)?.asleepBox).toBe(BOX_B);
    // the wake is on record, under the surau, with the operator as the actor
    const logged = w.db.prepare("SELECT actor, after_json FROM change_log WHERE entity = 'surau' AND entity_id = ? ORDER BY id DESC").get(A)!;
    expect(logged.actor).toBe('local');
    expect(String(logged.after_json)).toContain('operator');
    expect(w.db.prepare('SELECT asleep_box FROM suraus WHERE id = ?').get(A)?.asleep_box).toBeNull();
  });

  it('sleepingSurauSurvivesPrune: an empty surau that sleeps is not listed and not pruned; awake it is both', async () => {
    const w = world();
    ensureSurau(w.db, 'kosong1', 'Surau Kosong');
    const hour = 3_600_000;
    const now = new Date();
    const listed = (): string[] => emptySuraus(w.db, hour, now).map((c) => c.id);
    expect(listed()).toContain('kosong1');
    w.db.prepare("UPDATE suraus SET asleep_at = ?, asleep_box = 'ffffffffffffffff' WHERE id = 'kosong1'").run(now.toISOString());
    expect(listed()).not.toContain('kosong1');
    const pruned = pruneEmptySuraus(w.db, { now, olderThanMs: hour, apply: true, backupDir: join(w.dir, 'backups'), backup: { allowPlain: true } });
    expect(pruned.candidates.map((c) => c.id)).not.toContain('kosong1');
    expect(pruned.deleted.map((c) => c.id)).not.toContain('kosong1');
    expect(w.db.prepare("SELECT id FROM suraus WHERE id = 'kosong1'").get()).toBeDefined();
    // the surau woke: it is a candidate again, and the prune removes it
    expect(wakeSurau(w.db, 'kosong1', 'local', 'operator', now)).toBe(true);
    expect(listed()).toContain('kosong1');
    const second = pruneEmptySuraus(w.db, { now, olderThanMs: hour, apply: true, backupDir: join(w.dir, 'backups'), backup: { allowPlain: true } });
    expect(second.deleted.map((c) => c.id)).toContain('kosong1');
    expect(w.db.prepare("SELECT id FROM suraus WHERE id = 'kosong1'").get()).toBeUndefined();
  });
});

// =====================================================================================================================
describe('reset refusals', () => {
  /** The routes on a bare app, the way the cloud mounts them, with the caller made a site by hand. */
  async function bare(w: World, side: Side, deps: Partial<SurauSleepDeps>): Promise<FastifyInstance> {
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      (request as unknown as { auth: unknown }).auth = { kind: 'site', surauId: side.surauId, boxId: side.boxId };
    });
    registerSurauSleepRoutes(app, {
      role: 'cloud',
      db: w.db,
      now: () => new Date(),
      dataDir: w.dir,
      bus: { emit: () => undefined } as never,
      backupDir: join(w.dir, 'backups'),
      openBroadcast: () => false,
      ...deps,
    });
    await app.ready();
    extraApps.push(app);
    return app;
  }

  async function callBare(app: FastifyInstance, side: Side, req: unknown): Promise<Answer> {
    const raw = JSON.stringify(req);
    const h = signBoxCall(side.priv, { method: 'POST', path: RESET, boxId: side.boxId, body: raw, now: new Date(), nonce: randomBytes(16).toString('base64url') });
    const res = await app.inject({ method: 'POST', url: RESET, payload: raw, headers: { 'content-type': 'application/json', ...h } });
    return answer(res.statusCode, res.body);
  }

  it('resetWhileOpenBroadcastRefused: an open live broadcast of the surau is 409 live_open and nothing changes', async () => {
    const w = world();
    await seed(w, w.a, [content('old1', 'Ustaz Lama')]);
    const asked: string[] = [];
    const app = await bare(w, w.a, { openBroadcast: (id) => { asked.push(id); return true; } });
    const before = mark(w);
    const r = await callBare(app, w.a, body([content('new1', 'Ustaz Baru')]));
    expect([r.status, r.code]).toEqual([409, 'live_open']);
    expect(asked).toEqual([A]);
    expect(ids(w.db, 'SELECT id FROM content_items WHERE surau_id = ?', A)).toEqual(['old1']);
    // only the nonce moved
    expect(JSON.parse(mark(w)).slice(0, 3)).toEqual(JSON.parse(before).slice(0, 3));
    expect(resetBackups(w.dir)).toHaveLength(1);
    // with no broadcast open, the same bare app route resets
    const ok = await bare(w, w.a, { openBroadcast: () => false });
    const r2 = await callBare(ok, w.a, body([content('new1', 'Ustaz Baru')]));
    expect(r2.status).toBe(200);
    expect(ids(w.db, 'SELECT id FROM content_items WHERE surau_id = ?', A)).toEqual(['new1']);
  });

  it('resetSizeLimit: a body over 64 MB is 413 and nothing changes', async () => {
    const w = world();
    await seed(w, w.a, [content('old1', 'Ustaz Lama')]);
    const before = mark(w);
    const big = JSON.stringify({ ...body([content('new1', 'Ustaz Baru')]), pad: 'x'.repeat(65 * 1024 * 1024) });
    const r = await call(w, w.a, RESET, JSON.parse('{}'), { rawOverride: big });
    expect(r.status).toBe(413);
    expect(mark(w)).toBe(before);
    expect(ids(w.db, 'SELECT id FROM content_items WHERE surau_id = ?', A)).toEqual(['old1']);
  }, 60_000);

  it('resetSizeLimit: one asset over the cap and one entry over the cap are 400 bad_state; exactly the asset cap works', async () => {
    const w = world();
    await seed(w, w.a, [content('old1', 'Ustaz Lama')]);
    const before = mark(w);
    const tooManyAssets = await reset(w, w.a, [], Array.from({ length: RESET_ASSET_MAX + 1 }, (_, i) => hex(i)));
    expect([tooManyAssets.status, tooManyAssets.code, tooManyAssets.body.detail]).toEqual([400, 'bad_state', 'assets']);
    const tooManyEntries = await call(w, w.a, RESET, { linkId: 'L1', reason: 'adopt', state: { entries: new Array<number>(RESET_ENTRY_MAX + 1).fill(0), assets: [] } });
    expect([tooManyEntries.status, tooManyEntries.code, tooManyEntries.body.detail]).toEqual([400, 'bad_state', 'entries']);
    expect(JSON.parse(mark(w)).slice(0, 2)).toEqual(JSON.parse(before).slice(0, 2));
    expect(ids(w.db, 'SELECT id FROM content_items WHERE surau_id = ?', A)).toEqual(['old1']);
    // a non-hex asset id is refused with its place
    const badId = await reset(w, w.a, [], ['not-a-hash']);
    expect([badId.status, badId.code, badId.body.detail]).toEqual([400, 'bad_state', 'assets[0]']);
    // exactly the cap: accepted, every id the cloud does not hold is answered back as missing, none is granted
    const ids50k = Array.from({ length: RESET_ASSET_MAX }, (_, i) => hex(i));
    const ok = await reset(w, w.a, [content('new1', 'Ustaz Baru')], ids50k);
    expect(ok.status).toBe(200);
    expect((ok.body.missing as string[]).length).toBe(RESET_ASSET_MAX);
    expect(count(w.db, 'SELECT COUNT(*) AS n FROM surau_assets WHERE surau_id = ?', A)).toBe(0);
  }, 60_000);

  it('resetForeignPersonRefused: a person or phone another surau holds, a * person, a phone of a foreign person: 409 foreign_id, nothing changed, no backup', async () => {
    const w = world();
    const keyB = keyJwk();
    await seed(w, w.b, [userE('ub1', 'Pengurus B'), deviceE('db1', 'ub1', keyB)]);
    const star = createUser(w.db, { name: 'Sokongan Ujian', roles: ['ajk'] }, 'test', A);
    w.db.prepare("UPDATE users SET surau_id = '*', no = NULL, no_src = NULL WHERE id = ?").run(star.id);
    const sleepBackups = resetBackups(w.dir);
    const before = mark(w);
    const cases: [string, Rec[]][] = [
      ['a user id of another surau', [userE('ub1', 'Pengurus B')]],
      ['a device id of another surau', [userE('ua1', 'Pengurus A'), deviceE('db1', 'ua1', keyB)]],
      ['a * user id', [userE(star.id, 'Sokongan Ujian')]],
      ['a device of a foreign person', [deviceE('dnew', 'ub1', keyJwk())]],
      ['a device of a * person', [deviceE('dnew2', star.id, keyJwk())]],
    ];
    for (const [why, entries] of cases) {
      const r = await reset(w, w.a, entries);
      expect([why, r.status, r.code]).toEqual([why, 409, 'foreign_id']);
      expect(resetBackups(w.dir)).toEqual(sleepBackups);
    }
    const snapshotsOnly = JSON.parse(mark(w)) as unknown[];
    expect(snapshotsOnly.slice(0, 3)).toEqual((JSON.parse(before) as unknown[]).slice(0, 3));
    expect(ids(w.db, 'SELECT id FROM users WHERE surau_id = ?', A)).toEqual([]);
    expect(w.db.prepare('SELECT surau_id FROM users WHERE id = ?').get(star.id)?.surau_id).toBe('*');
    expect(w.db.prepare('SELECT surau_id FROM users WHERE id = ?').get('ub1')?.surau_id).toBe(B);
    expect(count(w.db, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'box_reset_refused'")).toBe(cases.length);
  });

  it('sessionCallerRefused: a person\'s session, even an admin of that surau, is 404 not_found on all three routes (as device-seen)', async () => {
    const w = world();
    const admin = await phone(w, A);
    const before = mark(w);
    for (const [path, req] of [
      [SLEEP, { linkId: 'L1', reason: 'link' }],
      [WAKE, { linkId: 'L1', reason: 'unlink-back' }],
      [RESET, body([content('new1', 'Ustaz Baru')])],
    ] as [string, unknown][]) {
      const r = await postAs(w, admin.headers, path, req);
      expect([path, r.status, r.code]).toEqual([path, 404, 'not_found']);
    }
    expect(mark(w)).toBe(before);
    expect(sleepOf(w.db, A)).toBeNull();
  });

  it('sessionCallerRefused: a box-role app answers each of the three routes 404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-sleepreset-box-'));
    const app = buildApp(join(dir, 'box.db'), { role: 'box', dataDir: dir });
    extraApps.push(app);
    try {
      const admin = await loginAs(app, 'admin');
      for (const [path, req] of [
        [SLEEP, { linkId: 'L1', reason: 'link' }],
        [WAKE, { linkId: 'L1', reason: 'unlink-back' }],
        [RESET, { linkId: 'L1', reason: 'adopt', state: { entries: [], assets: [] } }],
      ] as [string, unknown][]) {
        const res = await app.inject({ method: 'POST', url: path, headers: admin.headers as Record<string, string>, payload: req as Rec });
        expect([path, res.statusCode, answer(res.statusCode, res.body).code]).toEqual([path, 404, 'not_found']);
      }
      expect(count(app.surau.db, 'SELECT COUNT(*) AS n FROM surau_resets')).toBe(0);
    } finally {
      await app.close().catch(() => undefined);
      extraApps.splice(extraApps.indexOf(app), 1);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =====================================================================================================================
describe('the backup before a reset', () => {
  it('resetKeepsBackup30Days: the backup is written before anything changes and holds the old state', async () => {
    const w = world();
    w.db.prepare("INSERT INTO content_items (surau_id, kind, id, json, rev, edited_at, origin, updated_at, updated_by) VALUES (?, 'penceramah', 'old1', '{}', 'r', ?, 'cloud', ?, 'x')").run(A, T0, T0);
    const r = await reset(w, w.a, [content('new1', 'Ustaz Baru')]);
    expect(r.status).toBe(200);
    const files = resetBackups(w.dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^pre-reset-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}\.db$/);
    const copy = new DatabaseSync(join(w.dir, 'backups', files[0]!), { readOnly: true });
    try {
      expect(copy.prepare('SELECT id FROM content_items WHERE surau_id = ?').all(A).map((x) => x.id)).toEqual(['old1']);
      expect(Number(copy.prepare('SELECT log_floor FROM suraus WHERE id = ?').get(A)?.log_floor)).toBe(0);
    } finally {
      copy.close();
    }
    expect(ids(w.db, 'SELECT id FROM content_items WHERE surau_id = ?', A)).toEqual(['new1']);
    // the audit names the backup file
    expect(resetRows(w.db, A)[0]?.backup).toBe(files[0]);
  });

  it('resetKeepsBackup30Days: each reset sweeps pre-reset files older than 30 days and leaves the newer ones and every pre-prune file', async () => {
    const w = world();
    const dir = join(w.dir, 'backups');
    mkdirSync(dir, { recursive: true });
    const stamp = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace(/[:.]/g, '-');
    const old31 = `pre-reset-${stamp(31)}-aaaaaa.db.age`;
    const new29 = `pre-reset-${stamp(29)}-bbbbbb.db.age`;
    const prune100 = `pre-prune-${stamp(100)}-cccccc.db.age`;
    const prune1 = `pre-prune-${stamp(1)}-dddddd.db`;
    for (const f of [old31, new29, prune100, prune1, 'notes.txt']) writeFileSync(join(dir, f), 'x');
    expect((await reset(w, w.a, [content('new1', 'Ustaz Baru')])).status).toBe(200);
    const left = readdirSync(dir).sort();
    expect(left).not.toContain(old31);
    expect(left).toEqual(expect.arrayContaining([new29, prune100, prune1, 'notes.txt']));
    expect(left.filter((f) => f.startsWith('pre-reset-'))).toHaveLength(2);
  });

  it('resetKeepsBackup30Days: sweepResetBackups removes a 31 day old file, keeps 29 days, keeps every pre-prune file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-sweep-'));
    try {
      const now = new Date('2026-12-31T12:00:00.000Z');
      const at = (days: number): string => new Date(now.getTime() - days * 86_400_000).toISOString().replace(/[:.]/g, '-');
      const names = {
        old31: `pre-reset-${at(31)}-000001.db.age`,
        old31plain: `pre-reset-${at(31)}-000002.db`,
        new29: `pre-reset-${at(29)}-000003.db.age`,
        new1: `pre-reset-${at(1)}-000004.db`,
        prune200: `pre-prune-${at(200)}-000005.db.age`,
        prune31: `pre-prune-${at(31)}-000006.db`,
      };
      for (const f of Object.values(names)) writeFileSync(join(dir, f), 'x');
      const gone = sweepResetBackups(dir, now);
      expect(gone.sort()).toEqual([names.old31, names.old31plain].sort());
      expect(readdirSync(dir).sort()).toEqual([names.new29, names.new1, names.prune200, names.prune31].sort());
      expect(sweepResetBackups(join(dir, 'missing'), now)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resetKeepsBackup30Days: no recipient and no plain permission is 503 backup_unavailable and nothing changes', async () => {
    const w = world();
    await seed(w, w.a, [content('old1', 'Ustaz Lama')]);
    delete process.env.MAXCOM_PRUNE_PLAIN_BACKUP;
    process.env.MAXCOM_BACKUP_RECIPIENT_FILE = join(w.dir, 'no-such-recipient');
    const before = mark(w);
    const r = await reset(w, w.a, [content('new1', 'Ustaz Baru')]);
    expect([r.status, r.code]).toEqual([503, 'backup_unavailable']);
    expect(ids(w.db, 'SELECT id FROM content_items WHERE surau_id = ?', A)).toEqual(['old1']);
    expect(JSON.parse(mark(w)).slice(0, 3)).toEqual(JSON.parse(before).slice(0, 3));
    expect(resetBackups(w.dir)).toHaveLength(1);
    expect(resetRows(w.db, A)).toHaveLength(1);
  });

  it('resetKeepsBackup30Days: a backup step that throws is 503 backup_unavailable, nothing changes and no plain copy is left behind', async () => {
    const w = world();
    await seed(w, w.a, [content('old1', 'Ustaz Lama')]);
    const filesBefore = readdirSync(join(w.dir, 'backups')).sort();
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      (request as unknown as { auth: unknown }).auth = { kind: 'site', surauId: A, boxId: BOX_A };
    });
    registerSurauSleepRoutes(app, {
      role: 'cloud',
      db: w.db,
      now: () => new Date(),
      dataDir: w.dir,
      bus: { emit: () => undefined } as never,
      backupDir: join(w.dir, 'backups'),
      openBroadcast: () => false,
      backup: { env: {}, recipient: `age1${'q'.repeat(58)}`, encrypt: () => { throw new Error('age is broken'); } },
    });
    await app.ready();
    extraApps.push(app);
    const raw = JSON.stringify(body([content('new1', 'Ustaz Baru')]));
    const h = signBoxCall(w.a.priv, { method: 'POST', path: RESET, boxId: BOX_A, body: raw, now: new Date(), nonce: randomBytes(16).toString('base64url') });
    const res = await app.inject({ method: 'POST', url: RESET, payload: raw, headers: { 'content-type': 'application/json', ...h } });
    expect([res.statusCode, answer(res.statusCode, res.body).code]).toEqual([503, 'backup_unavailable']);
    expect(ids(w.db, 'SELECT id FROM content_items WHERE surau_id = ?', A)).toEqual(['old1']);
    expect(readdirSync(join(w.dir, 'backups')).sort()).toEqual(filesBefore);
    expect(resetRows(w.db, A)).toHaveLength(1);
    expect(surauLogFloor(w.db, A)).toBeGreaterThan(0);
    const floor = surauLogFloor(w.db, A);
    expect(floor).toBe(Number(w.db.prepare('SELECT log_floor FROM suraus WHERE id = ?').get(A)?.log_floor));
  });

  it('resetKeepsBackup30Days: with a recipient the backup is the encrypted file and no plain copy stays', async () => {
    const w = world();
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      (request as unknown as { auth: unknown }).auth = { kind: 'site', surauId: A, boxId: BOX_A };
    });
    registerSurauSleepRoutes(app, {
      role: 'cloud',
      db: w.db,
      now: () => new Date(),
      dataDir: w.dir,
      bus: { emit: () => undefined } as never,
      backupDir: join(w.dir, 'backups'),
      openBroadcast: () => false,
      backup: { env: {}, recipient: `age1${'q'.repeat(58)}`, encrypt: (plain, out) => copyFileSync(plain, out) },
    });
    await app.ready();
    extraApps.push(app);
    const raw = JSON.stringify(body([content('new1', 'Ustaz Baru')]));
    const h = signBoxCall(w.a.priv, { method: 'POST', path: RESET, boxId: BOX_A, body: raw, now: new Date(), nonce: randomBytes(16).toString('base64url') });
    const res = await app.inject({ method: 'POST', url: RESET, payload: raw, headers: { 'content-type': 'application/json', ...h } });
    expect(res.statusCode).toBe(200);
    const files = resetBackups(w.dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.db\.age$/);
    expect(existsSync(join(w.dir, 'backups', files[0]!.replace(/\.age$/, '')))).toBe(false);
  });
});

// =====================================================================================================================
describe('what a reset replaces, keeps and refuses', () => {
  it('resetKeepsFinanceEntries: entries only the cloud has stay unchanged; the box\'s missing ones come in; funds, perihal and months follow the rules', async () => {
    const w = world();
    // the cloud's side of things, put there through the real door
    await seed(w, w.a, [
      fund('f1', 'Tabung Am'), fund('f2', 'Tabung Lama'), perihal('p1', 'Sumbangan Am'), perihal('p2', 'Perihal Lama'),
      ledger('x1', 'f1', 'p1', 50000), month('2026-10'),
    ]);
    const kept = w.db.prepare('SELECT * FROM finance_entries WHERE surau_id = ? AND id = ?').get(A, 'x1')!;
    expect(kept.amount_sen).toBe(50000);
    // the box has not got x1, f1, f2, p1, p2; it has x2 and its own fund and perihal, and says x1 had another amount
    const r = await reset(w, w.a, [
      fund('f3', 'Tabung Baharu'), perihal('p3', 'Derma Baharu'), ledger('x2', 'f3', 'p3', 12000, '2026-11-09'), ledger('x1', 'f3', 'p3', 99999), month('2026-11'),
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // the entry the box lacks is still there, field for field
    expect(w.db.prepare('SELECT * FROM finance_entries WHERE surau_id = ? AND id = ?').get(A, 'x1')).toEqual(kept);
    // the entry the cloud lacked is inserted
    expect(ids(w.db, 'SELECT id FROM finance_entries WHERE surau_id = ? ORDER BY id', A)).toEqual(['x1', 'x2']);
    expect(w.db.prepare('SELECT amount_sen, fund_id FROM finance_entries WHERE surau_id = ? AND id = ?').get(A, 'x2')).toMatchObject({ amount_sen: 12000, fund_id: 'f3' });
    // a fund / perihal a kept entry names survives although the state omits it; one nobody names and the state omits is gone
    expect(ids(w.db, 'SELECT id FROM finance_funds WHERE surau_id = ? ORDER BY id', A)).toEqual(['f1', 'f3']);
    expect(ids(w.db, 'SELECT id FROM finance_perihal WHERE surau_id = ? ORDER BY id', A)).toEqual(['p1', 'p3']);
    // months are replaced
    expect(w.db.prepare('SELECT ym FROM finance_months WHERE surau_id = ? ORDER BY ym').all(A).map((m) => m.ym)).toEqual(['2026-11']);
    // the audit counts it
    const last = resetRows(w.db, A).at(-1)!;
    expect(last.ok).toBe(1);
    expect(JSON.parse(String(last.counts_json))).toMatchObject({ financeKept: 2, duplicate: 1 });
    // the append-only triggers are untouched
    expect(() => w.db.prepare('DELETE FROM finance_entries WHERE surau_id = ? AND id = ?').run(A, 'x1')).toThrow();
  });

  it('resetForcesSnapshotForThatSurauOnly: after the reset an old cursor of that surau gets 410; another surau\'s cursor, below the new marker, does not', async () => {
    const w = world();
    const phoneA = await phone(w, A);
    const phoneB = await phone(w, B);
    // both surau's phones have some history behind them
    for (let i = 0; i < 3; i++) putFeature(w.db, 'ticker', { speed: i % 2 === 0 ? 'slow' : 'fast' }, 'test', undefined, B);
    const headA = Number((await getAs(w, phoneA.headers, '/api/sync/changes?since=0')).body.head);
    expect(headA).toBeGreaterThan(0);
    const r = await reset(w, w.a, [content('new1', 'Ustaz Baru'), ...peopleOf(w.db, A)]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const floor = surauLogFloor(w.db, A);
    expect(floor).toBe(Number(r.body.seq));
    expect(floor).toBeGreaterThan(headA);
    // the surau's own phone and site, with an old cursor: snapshot_required
    for (const headers of [phoneA.headers, w.a.site.headers]) {
      const old = await getAs(w, headers, `/api/sync/changes?since=${headA}`);
      expect([old.status, old.code]).toEqual([410, 'snapshot_required']);
      const zero = await getAs(w, headers, '/api/sync/changes?since=0');
      expect([zero.status, zero.code]).toEqual([410, 'snapshot_required']);
    }
    // at the marker itself the cursor is current
    expect((await getAs(w, phoneA.headers, `/api/sync/changes?since=${floor}`)).status).toBe(200);
    expect((await getAs(w, phoneA.headers, '/api/sync/snapshot')).status).toBe(200);
    // another surau, cursors below the new marker id: not told to start over
    expect(surauLogFloor(w.db, B)).toBe(0);
    for (const headers of [phoneB.headers, w.b.site.headers]) {
      const low = await getAs(w, headers, '/api/sync/changes?since=1');
      expect([low.status, low.code]).toEqual([200, null]);
      expect((await getAs(w, headers, '/api/sync/changes?since=0')).status).toBe(200);
    }
    // the marker is filed under the reset surau, so B's feed never carries it
    expect(w.db.prepare('SELECT surau_id, entity FROM change_log WHERE id = ?').get(floor)).toMatchObject({ surau_id: A, entity: 'surau' });
    const feedB = await getAs(w, phoneB.headers, '/api/sync/changes?since=0');
    expect((feedB.body.entries as { entity: string }[]).some((x) => x.entity === 'surau')).toBe(false);
  });

  it('resetForeignPersonRefused: see the foreign id cases above; a device whose person is another surau\'s on a surau of its own is refused too', async () => {
    const w = world();
    await seed(w, w.b, [userE('ub1', 'Pengurus B')]);
    await seed(w, w.a, [userE('ua1', 'Pengurus A')]);
    const before = settled(w);
    const r = await reset(w, w.a, [userE('ua1', 'Pengurus A'), deviceE('dx', 'ub1', keyJwk())]);
    expect([r.status, r.code]).toEqual([409, 'foreign_id']);
    expect(settled(w)).toBe(before);
  });

  it('reset content: content, settings (not the app lock) and prayer rows are replaced; others of the surau and "*" rows are untouched', async () => {
    const w = world();
    putFeature(w.db, 'appLock', { enabled: true }, 'test', undefined, A);
    await seed(w, w.a, [content('old1', 'Ustaz Lama'), entry('settings', 'ticker', { speed: 'fast' }), entry('settings', 'hijriDate', { adjustDays: 1 })]);
    w.db.prepare(
      `INSERT INTO prayer_imports (surau_id, id, kind, file_name, sha256, rows, date_from, date_to, overlap, inserted, replaced, skipped, actor, created_at)
       VALUES (?, ?, 'csv', 'waktu.csv', ?, 1, '2026-11-01', '2026-11-30', 'none', 1, 0, 0, 'user:x', ?)`,
    ).run(A, 'A'.repeat(26), 'b'.repeat(64), T0);
    w.db.prepare("INSERT INTO prayer_file_days (surau_id, date, import_id, json) VALUES (?, '2026-11-01', ?, '{}')").run(A, 'A'.repeat(26));
    w.db.prepare("INSERT INTO prayer_corrections (surau_id, date, prayer, time, reason, actor, created_at) VALUES (?, '2026-11-02', 'subuh', '05:50', 'Lama', 'user:x', ?)").run(A, T0);
    w.db.prepare("INSERT INTO content_items (surau_id, kind, id, json, rev, edited_at, origin, updated_at, updated_by) VALUES ('*', 'penceramah', 'star1', '{}', 'r', ?, 'cloud', ?, 'x')").run(T0, T0);
    const star = createUser(w.db, { name: 'Sokongan Ujian', roles: ['ajk'] }, 'test', A);
    w.db.prepare("UPDATE users SET surau_id = '*', no = NULL, no_src = NULL WHERE id = ?").run(star.id);
    const starBefore = JSON.stringify(w.db.prepare("SELECT * FROM users WHERE id = ?").get(star.id));
    const starContent = JSON.stringify(w.db.prepare("SELECT * FROM content_items WHERE surau_id = '*'").all());
    const lockBefore = JSON.stringify(w.db.prepare("SELECT * FROM settings WHERE surau_id = ? AND feature = 'appLock'").all(A));
    expect(JSON.parse(lockBefore)).toHaveLength(1);

    const r = await reset(w, w.a, [
      content('new1', 'Ustaz Baru'), content('new2', 'Ustaz Kedua'), entry('settings', 'ticker', { speed: 'slow' }),
      entry('prayer:correction', '2026-11-26|asar', { date: '2026-11-26', prayer: 'asar', time: '16:25', reason: 'Ikut takwim' }),
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(ids(w.db, 'SELECT id FROM content_items WHERE surau_id = ? ORDER BY id', A)).toEqual(['new1', 'new2']);
    expect(w.db.prepare('SELECT feature FROM settings WHERE surau_id = ? ORDER BY feature').all(A).map((s) => s.feature)).toEqual(['appLock', 'ticker']);
    expect(String(w.db.prepare("SELECT json FROM settings WHERE surau_id = ? AND feature = 'ticker'").get(A)?.json)).toContain('slow');
    expect(JSON.stringify(w.db.prepare("SELECT * FROM settings WHERE surau_id = ? AND feature = 'appLock'").all(A))).toBe(lockBefore);
    expect(count(w.db, 'SELECT COUNT(*) AS n FROM prayer_imports WHERE surau_id = ?', A)).toBe(0);
    expect(count(w.db, 'SELECT COUNT(*) AS n FROM prayer_file_days WHERE surau_id = ?', A)).toBe(0);
    expect(w.db.prepare('SELECT date, prayer FROM prayer_corrections WHERE surau_id = ?').all(A).map((c) => `${c.date}|${c.prayer}`)).toEqual(['2026-11-26|asar']);
    // '*' rows are the cloud's own
    expect(JSON.stringify(w.db.prepare('SELECT * FROM users WHERE id = ?').get(star.id))).toBe(starBefore);
    expect(JSON.stringify(w.db.prepare("SELECT * FROM content_items WHERE surau_id = '*'").all())).toBe(starContent);
  });

  it('reset content: people and phones not in the state are removed and revoked; the ones in it stay; a phone of the surau not listed is revoked', async () => {
    const w = world();
    const keep = await phone(w, A);
    const drop = await phone(w, A);
    const keepUser = String(w.db.prepare('SELECT user_id FROM devices WHERE id = ?').get(keep.deviceId)?.user_id);
    const dropUser = drop.userId;
    expect(keepUser).not.toBe(dropUser);
    // a third person with a phone, kept as a person but the phone is not listed
    const lone = await phone(w, A);
    const entries = peopleOf(w.db, A).filter((x) => x.entityId !== dropUser && x.entityId !== drop.deviceId && x.entityId !== lone.deviceId);
    const r = await reset(w, w.a, entries);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // the dropped person is deleted and their phone revoked
    expect(w.db.prepare('SELECT deleted_at, active FROM users WHERE id = ?').get(dropUser)?.deleted_at).not.toBeNull();
    expect(w.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(drop.deviceId)?.revoked_at).not.toBeNull();
    // the kept person and phone work
    expect(w.db.prepare('SELECT deleted_at FROM users WHERE id = ?').get(keepUser)?.deleted_at).toBeNull();
    expect(w.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(keep.deviceId)?.revoked_at).toBeNull();
    // the phone not listed is revoked although its person is still listed
    expect(w.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(lone.deviceId)?.revoked_at).not.toBeNull();
    // a revoked phone's token no longer works; the kept phone's does
    expect((await getAs(w, drop.headers, '/api/sync/snapshot')).status).toBe(401);
    expect((await getAs(w, lone.headers, '/api/sync/snapshot')).status).toBe(401);
    expect((await getAs(w, keep.headers, '/api/sync/snapshot')).status).toBe(200);
    const counts = JSON.parse(String(resetRows(w.db, A).at(-1)!.counts_json)) as Rec;
    expect(counts).toMatchObject({ peopleRemoved: 1, devicesRevoked: 2 });
  });

  it('reset content: a phone in the state with a DIFFERENT key than the cloud holds is 400 bad_state and nothing changes', async () => {
    const w = world();
    const p = await phone(w, A);
    await seed(w, w.a, [content('old1', 'Ustaz Lama'), ...peopleOf(w.db, A)]);
    const before = fingerprint(w.db, A);
    const bad = peopleOf(w.db, A).map((x) => (x.entity === 'device' ? deviceE(String(x.entityId), String((x.after as Rec).userId), keyJwk()) : x));
    const r = await reset(w, w.a, [content('new1', 'Ustaz Baru'), ...bad]);
    expect([r.status, r.code]).toEqual([400, 'bad_state']);
    expect(String(r.body.detail)).toContain(p.deviceId);
    expect(String(r.body.detail)).toContain('device_key_mismatch');
    expect(fingerprint(w.db, A)).toBe(before);
    // the refusal is on the audit with ok = 0, and does not count toward the daily limit
    const rows = resetRows(w.db, A);
    expect(rows.map((x) => x.ok)).toEqual([1, 0]);
    expect(JSON.parse(String(rows[1]!.counts_json))).toMatchObject({ refused: 'bad_state' });
  });

  it('reset content: a Pentadbir MAXCOM or Sokongan person in the state is 400 bad_state and nothing changes', async () => {
    const w = world();
    await seed(w, w.a, [content('old1', 'Ustaz Lama')]);
    const before = fingerprint(w.db, A);
    for (const role of ['superadmin', 'support']) {
      const r = await reset(w, w.a, [content('new1', 'Ustaz Baru'), userE('ux1', 'Orang Istimewa', [role])]);
      expect([role, r.status, r.code]).toEqual([role, 400, 'bad_state']);
      expect(fingerprint(w.db, A)).toBe(before);
      expect(w.db.prepare('SELECT id FROM users WHERE id = ?').get('ux1')).toBeUndefined();
    }
    expect(resetRows(w.db, A).map((x) => x.ok)).toEqual([1, 0, 0]);
  });

  it('reset content: assets not listed are dropped, a listed one the cloud holds stays, a listed one it lacks is answered as missing and NOT granted', async () => {
    const w = world();
    const ins = w.db.prepare('INSERT INTO surau_assets (surau_id, asset_id, bytes, created_at) VALUES (?, ?, 10, ?)');
    ins.run(A, hex(1), T0);
    ins.run(A, hex(2), T0);
    ins.run(B, hex(3), T0);
    const r = await reset(w, w.a, [content('new1', 'Ustaz Baru')], [hex(2), hex(3), hex(4)]);
    expect(r.status).toBe(200);
    // hex(3) is held by surau B: a hash is never a licence to read, so A does not get it
    expect((r.body.missing as string[]).sort()).toEqual([hex(3), hex(4)].sort());
    expect(w.db.prepare('SELECT asset_id FROM surau_assets WHERE surau_id = ? ORDER BY asset_id').all(A).map((x) => x.asset_id)).toEqual([hex(2)]);
    expect(w.db.prepare('SELECT asset_id FROM surau_assets WHERE surau_id = ?').all(B).map((x) => x.asset_id)).toEqual([hex(3)]);
    expect(JSON.parse(String(resetRows(w.db, A)[0]!.counts_json))).toMatchObject({ assetsDropped: 1 });
  });

  it('reset content: the audit row is ok = 1 with counts; the answer carries at, seq and missing', async () => {
    const w = world();
    const r = await reset(w, w.a, [content('new1', 'Ustaz Baru'), content('new2', 'Ustaz Kedua')]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, missing: [] });
    expect(typeof r.body.at).toBe('string');
    const row = resetRows(w.db, A)[0]!;
    expect(row).toMatchObject({ surau_id: A, box_id: BOX_A, link_id: 'L1', reason: 'adopt', ok: 1 });
    expect(String(row.backup)).toMatch(/^pre-reset-/);
    expect(JSON.parse(String(row.counts_json))).toMatchObject({ applied: 2, duplicate: 0, superseded: 0, peopleRemoved: 0, devicesRevoked: 0, assetsDropped: 0, financeKept: 0 });
    expect(Number(r.body.seq)).toBe(surauLogFloor(w.db, A));
  });

  it('reset content: the 4th accepted reset within 24 hours is 429 reset_limit; refused ones do not count; old ones do not count', async () => {
    const w = world();
    const log = w.db.prepare('INSERT INTO surau_resets (surau_id, box_id, link_id, reason, at, backup, counts_json, ok) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)');
    const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();
    // three REFUSED resets and three accepted ones older than a day: none of them counts
    for (let i = 0; i < 3; i++) log.run(A, BOX_A, 'L0', 'adopt', hoursAgo(1), '{}', 0);
    for (let i = 0; i < 3; i++) log.run(A, BOX_A, 'L0', 'adopt', hoursAgo(25), '{}', 1);
    // another surau's three accepted ones: not this surau's
    for (let i = 0; i < 3; i++) log.run(B, BOX_B, 'L0', 'adopt', hoursAgo(1), '{}', 1);
    expect((await reset(w, w.a, [content('c1', 'Satu')])).status).toBe(200);
    expect((await reset(w, w.a, [content('c2', 'Dua')])).status).toBe(200);
    expect((await reset(w, w.a, [content('c3', 'Tiga')])).status).toBe(200);
    const before = mark(w);
    const fourth = await reset(w, w.a, [content('c4', 'Empat')]);
    expect([fourth.status, fourth.code]).toEqual([429, 'reset_limit']);
    expect(ids(w.db, 'SELECT id FROM content_items WHERE surau_id = ?', A)).toEqual(['c3']);
    expect(JSON.parse(mark(w)).slice(0, 3)).toEqual(JSON.parse(before).slice(0, 3));
    expect(resetBackups(w.dir)).toHaveLength(3);
    // another surau is still allowed one
    expect((await reset(w, w.b, [content('b1', 'Satu')])).status).toBe(429);
  });

  it('gate fix Q5/S1: refused resets count too, at twice the cap: the 7th try within a day is 429 before any backup', async () => {
    const w = world();
    const log = w.db.prepare('INSERT INTO surau_resets (surau_id, box_id, link_id, reason, at, backup, counts_json, ok) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)');
    for (let i = 0; i < 6; i++) log.run(A, BOX_A, 'L0', 'adopt', new Date(Date.now() - 3_600_000).toISOString(), '{}', 0);
    const r = await reset(w, w.a, [content('c1', 'Satu')]);
    expect([r.status, r.code]).toEqual([429, 'reset_limit']);
    expect(resetBackups(w.dir)).toEqual([]);
  });

  it('gate fix S4: a secondary site cannot put the surau to sleep', async () => {
    const w = world();
    const second = makeSide(w.db, A, BOX_A2);
    w.db.prepare("UPDATE sites SET role = 'secondary' WHERE box_id = ?").run(BOX_A2);
    const r = await call(w, second, '/api/sync/sleep', { linkId: 'L1', reason: 'link' });
    expect([r.status, r.code]).toEqual([403, 'forbidden']);
    expect(w.db.prepare('SELECT asleep_at FROM suraus WHERE id = ?').get(A)?.asleep_at ?? null).toBeNull();
  });

  it('reset content: a secondary site of the surau is 403 forbidden', async () => {
    const w = world();
    const second = makeSide(w.db, A, BOX_A2);
    w.db.prepare("UPDATE sites SET role = 'secondary' WHERE box_id = ?").run(BOX_A2);
    const before = mark(w);
    const r = await reset(w, second, [content('new1', 'Ustaz Baru')]);
    expect([r.status, r.code]).toEqual([403, 'forbidden']);
    expect(JSON.parse(mark(w)).slice(0, 2)).toEqual(JSON.parse(before).slice(0, 2));
    expect(resetBackups(w.dir)).toEqual([]);
    expect(resetRows(w.db, A)).toEqual([]);
  });

  it('reset content: two entries for the same row are 400 bad_state; so are an unknown entity, a bad reason and a bad link id', async () => {
    const w = world();
    const before = fingerprint(w.db, A);
    const twice = await reset(w, w.a, [content('new1', 'Satu'), content('new1', 'Dua')]);
    expect([twice.status, twice.code, twice.body.detail]).toEqual([400, 'bad_state', 'entries[1]:twice']);
    const official = await reset(w, w.a, [entry('prayer:official', 'SGR01:2026', {})]);
    expect([official.status, official.code]).toEqual([400, 'bad_state']);
    const reason = await call(w, w.a, RESET, { ...body([]), reason: 'link' });
    expect([reason.status, reason.code, reason.body.detail]).toEqual([400, 'bad_state', 'reason']);
    const link = await call(w, w.a, RESET, { ...body([]), linkId: 'a b' });
    expect([link.status, link.code, link.body.detail]).toEqual([400, 'bad_state', 'linkId']);
    const notJson = await call(w, w.a, RESET, 'plain text');
    expect([notJson.status, notJson.code]).toEqual([400, 'bad_state']);
    expect(fingerprint(w.db, A)).toBe(before);
    expect(resetBackups(w.dir)).toEqual([]);
  });
});

// =====================================================================================================================
describe('reset and box-numbered ids of the same surau', () => {
  const numbered = (id: string, name: string, no: number, roles: string[] = ['admin']): Rec => entry('user', id, { name, roles, active: true, no, noSrc: 'b' });
  const numberedDev = (id: string, userId: string, no: number): Rec =>
    entry('device', id, { id, userId, name: 'Telefon Dewan Utama', platform: 'android', publicJwk: keyJwk(), enrolledAt: T0, no, noSrc: 'b' });
  const nums = (db: DatabaseSync, table: string, surauId: string): string[] =>
    db.prepare(`SELECT id, no, no_src FROM ${table} WHERE surau_id = ? AND no IS NOT NULL ORDER BY no, id`).all(surauId).map((r) => `${String(r.id)}:${String(r.no_src)}${String(r.no)}`);

  it('reset numbers: old people and phones holding U-0001..U-0003 do not refuse a state that carries other ids with the same numbers', async () => {
    const w = world();
    await seed(w, w.a, [
      numbered('old1', 'Orang Lama Satu', 1), numbered('old2', 'Orang Lama Dua', 2, ['treasurer']), numbered('old3', 'Orang Lama Tiga', 3, ['treasurer']),
      numberedDev('oldd1', 'old1', 1), numberedDev('oldd2', 'old2', 2),
    ]);
    expect(nums(w.db, 'users', A)).toEqual(['old1:b1', 'old2:b2', 'old3:b3']);
    const before = count(w.db, 'SELECT COUNT(*) AS n FROM surau_resets WHERE surau_id = ?', A);
    const r = await reset(w, w.a, [
      numbered('new1', 'Pak Imam', 1), numbered('new3', 'Cik Bendahari', 3, ['treasurer']), numbered('new4', 'Tuan Setiausaha', 4, ['treasurer']),
      numberedDev('newd1', 'new1', 1), numberedDev('newd3', 'new3', 3),
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(resetRows(w.db, A).at(-1)!.ok).toBe(1);
    expect(count(w.db, 'SELECT COUNT(*) AS n FROM surau_resets WHERE surau_id = ?', A)).toBe(before + 1);
    // exactly the state's people, with the state's numbers
    expect(ids(w.db, 'SELECT id FROM users WHERE surau_id = ? AND deleted_at IS NULL ORDER BY id', A)).toEqual(['new1', 'new3', 'new4']);
    expect(w.db.prepare('SELECT id, no, no_src FROM users WHERE surau_id = ? AND deleted_at IS NULL ORDER BY id').all(A).map((u) => `${String(u.id)}:${String(u.no_src)}${String(u.no)}`)).toEqual(['new1:b1', 'new3:b3', 'new4:b4']);
    expect(ids(w.db, 'SELECT id FROM devices WHERE surau_id = ? AND revoked_at IS NULL ORDER BY id', A)).toEqual(['newd1', 'newd3']);
    expect(w.db.prepare('SELECT id, no, no_src FROM devices WHERE surau_id = ? AND revoked_at IS NULL ORDER BY id').all(A).map((u) => `${String(u.id)}:${String(u.no_src)}${String(u.no)}`)).toEqual(['newd1:b1', 'newd3:b3']);
    // the old ones are gone and revoked
    expect(count(w.db, 'SELECT COUNT(*) AS n FROM users WHERE surau_id = ? AND deleted_at IS NULL AND id LIKE ?', A, 'old%')).toBe(0);
    expect(count(w.db, 'SELECT COUNT(*) AS n FROM devices WHERE surau_id = ? AND revoked_at IS NULL AND id LIKE ?', A, 'old%')).toBe(0);
    // the check-ids invariant: no two rows share (surau, series, number)
    for (const t of ['users', 'devices']) {
      expect(count(w.db, `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${t} WHERE no IS NOT NULL GROUP BY surau_id, no_src, no HAVING COUNT(*) > 1)`)).toBe(0);
    }
    expect(checkIds(w.db, 'cloud')).toEqual([]);
  });

  it('reset numbers: a person kept under the same id whose old number another state person now carries gets the state numbers too', async () => {
    const w = world();
    await seed(w, w.a, [numbered('p1', 'Pak Imam', 1), numbered('p2', 'Cik Bendahari', 2, ['treasurer'])]);
    const r = await reset(w, w.a, [numbered('p1', 'Pak Imam', 2), numbered('p2', 'Cik Bendahari', 1, ['treasurer'])]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(nums(w.db, 'users', A)).toEqual(['p2:b1', 'p1:b2']);
    expect(checkIds(w.db, 'cloud')).toEqual([]);
  });

  it('reset numbers: a kept person whose old number another state person took, and whose entry has no number, is not left without one', async () => {
    const w = world();
    await seed(w, w.a, [numbered('p1', 'Pak Imam', 1), numbered('p2', 'Cik Bendahari', 2, ['treasurer'])]);
    const r = await reset(w, w.a, [entry('user', 'p1', { name: 'Pak Imam', roles: ['admin'], active: true }), numbered('p3', 'Tuan Setiausaha', 1, ['treasurer'])]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = w.db.prepare("SELECT no, no_src FROM users WHERE id = 'p1'").get();
    expect(row?.no, 'p1 has a number').not.toBeNull();
    expect(row?.no_src).toBe('c');
    expect(w.db.prepare("SELECT no, no_src FROM users WHERE id = 'p3'").get()).toMatchObject({ no: 1, no_src: 'b' });
    expect(count(w.db, 'SELECT COUNT(*) AS n FROM users WHERE surau_id = ? AND deleted_at IS NULL AND no IS NULL', A)).toBe(0);
    expect(checkIds(w.db, 'cloud')).toEqual([]);
  });

  it('reset numbers: a state id held by another surau is still 409 foreign_id and nothing changes', async () => {
    const w = world();
    await seed(w, w.b, [numbered('other1', 'Orang Surau Lain', 1)]);
    await seed(w, w.a, [numbered('old1', 'Orang Lama Satu', 1)]);
    const m = mark(w);
    const r = await reset(w, w.a, [numbered('other1', 'Orang Surau Lain', 5), numbered('new1', 'Pak Imam', 1)]);
    expect([r.status, r.code]).toEqual([409, 'foreign_id']);
    expect(ids(w.db, 'SELECT id FROM users WHERE surau_id = ? ORDER BY id', B)).toEqual(['other1']);
    expect(nums(w.db, 'users', B)).toEqual(['other1:b1']);
    expect(nums(w.db, 'users', A)).toEqual(['old1:b1']);
    void m;
  });

  it('reset numbers: the same number in another surau is no clash; that surau keeps its rows and numbers', async () => {
    const w = world();
    await seed(w, w.b, [numbered('other1', 'Orang Surau Lain', 1)]);
    await seed(w, w.a, [numbered('old1', 'Orang Lama Satu', 1)]);
    const r = await reset(w, w.a, [numbered('new1', 'Pak Imam', 1)]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(nums(w.db, 'users', B)).toEqual(['other1:b1']);
    expect(ids(w.db, 'SELECT id FROM users WHERE surau_id = ? AND deleted_at IS NULL', A)).toEqual(['new1']);
  });
});

describe('tx nesting', () => {
  it('a throw inside a nested tx rolls back only its own writes; the outer commit keeps the rest', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (k TEXT)');
    const put = (k: string): void => void db.prepare('INSERT INTO t (k) VALUES (?)').run(k);
    const keys = (): string[] => db.prepare('SELECT k FROM t ORDER BY rowid').all().map((r) => String(r.k));
    tx(db, () => {
      put('outer-1');
      expect(() => tx(db, () => {
        put('inner');
        throw new Error('inner failed');
      })).toThrow('inner failed');
      expect(keys()).toEqual(['outer-1']);
      put('outer-2');
    });
    expect(db.isTransaction).toBe(false);
    expect(keys()).toEqual(['outer-1', 'outer-2']);
  });

  it('a nested tx that succeeds is kept with the outer one, and rolled back with it when the outer throws', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (k TEXT)');
    const put = (k: string): void => void db.prepare('INSERT INTO t (k) VALUES (?)').run(k);
    const keys = (): string[] => db.prepare('SELECT k FROM t ORDER BY rowid').all().map((r) => String(r.k));
    tx(db, () => {
      tx(db, () => {
        put('a');
        tx(db, () => put('b'));
        expect(() => tx(db, () => { put('c'); throw new Error('c failed'); })).toThrow('c failed');
        put('d');
      });
    });
    expect(keys()).toEqual(['a', 'b', 'd']);
    expect(() => tx(db, () => {
      put('e');
      tx(db, () => put('f'));
      throw new Error('outer failed');
    })).toThrow('outer failed');
    expect(db.isTransaction).toBe(false);
    expect(keys()).toEqual(['a', 'b', 'd']);
  });
});
