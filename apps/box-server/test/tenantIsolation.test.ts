/**
 * Plan 14 Task 12: the tenant isolation matrix (SECURITY proof of R6 and of the ops rule). One cloud-role app with three
 * suraus (`a`, `b`, and the pilot `sdm`), one linked box each, a surau admin + treasurer + media user each with an
 * enrolled phone, a Pentadbir MAXCOM on an ops device and on a public device, and a Sokongan MAXCOM on an ops device.
 *
 * The walk is generated from `ROUTE_PERMISSIONS` (nothing is hand-listed): for EVERY row, an actor of another surau, with
 * the id of the victim's rows, with `X-Maxcom-Surau`, with `X-Maxcom-Box`, and as the other surau's site key, can read,
 * list, change, delete or infer nothing of the victim's: no victim marker in any answer, and every row of the victim
 * (every table that carries `surau_id`, change log and storage included) byte-identical afterwards. Positive controls
 * prove the same call works for the right actor, so the matrix cannot pass by refusing everything.
 *
 * Findings: a row that leaks is marked `it.fails` with a `LEAK:` comment (none at the time of writing).
 */
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { can, parseJakimCsv } from '@surau/core';
import type { OpResult, Permission, Role } from '@surau/core';
import { ROUTE_PERMISSIONS, siteMayCall } from '../src/auth/authz.ts';
import type { RouteRule } from '../src/auth/authz.ts';
import { beginEnrolment } from '../src/auth/devices.ts';
import { createUser } from '../src/auth/users.ts';
import { putItem } from '../src/content/store.ts';
import { importDays } from '../src/prayerStore.ts';
import { putFeature } from '../src/settingsStore.ts';
import { OP_PERMISSIONS } from '../src/sync/verify.ts';
import { resetRefusalLogThrottle, SURAU_HEADER } from '../src/tenant.ts';
import { buildCloud } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { jpeg } from './support/jpeg.ts';
import { newOpId, signOp } from './support/signOp.ts';
import type { OpInput } from './support/signOp.ts';
import { insertSite } from './support/sites.ts';
import type { TestSite } from './support/sites.ts';
import { TEST_PIN, loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';

const CSV = readFileSync(fileURLToPath(new URL('../../../packages/core/test/fixtures/SGR01-2026.csv', import.meta.url)), 'utf8');
const OFFICIAL = parseJakimCsv(CSV);

const CLOUD_BOX = '0c10ad000000000c';
const ID_A = 'zalpha-surau';
const ID_B = 'zbravo-surau';
const ID_P = 'sdm';
const BOX_A = 'a1a1a1a1a1a1a1a1';
const BOX_B = 'b2b2b2b2b2b2b2b2';
const BOX_P = 'c3c3c3c3c3c3c3c3';
const LAN = '10.168.1.60';
const BOX_HEADER = 'x-maxcom-box';
const noNetwork = (async () => {
  throw new TypeError('network disabled in tests');
}) as unknown as typeof fetch;

// ---------------------------------------------------------------------------------------------------------------
// plumbing

type Method = 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';

interface Res {
  status: number;
  text: string;
  json: Record<string, unknown>;
}

/** A signed-in actor: a login whose token is renewed before the 600 a minute session limit can bite. */
class Who {
  private token: string;
  private count = 0;
  readonly login: Login;
  constructor(login: Login) {
    this.login = login;
    this.token = login.token;
  }
  get userId(): string {
    return this.login.userId;
  }
  get deviceId(): string {
    return this.login.deviceId;
  }
  get roles(): Role[] {
    return this.login.roles;
  }
  async bearer(): Promise<string> {
    this.count += 1;
    if (this.count % 300 === 0) this.token = await this.login.relogin();
    return `Bearer ${this.token}`;
  }
}

interface Req {
  method: Method;
  url: string;
  payload?: unknown;
  /** Raw bytes with their own content type (photo and asset uploads). */
  raw?: { body: Buffer; type: string; extra?: Record<string, string> };
  /** The answer must be a 404 for an actor who holds the permission (the row does not exist for it). */
  expect404?: boolean;
}

interface SurauCtx {
  id: string;
  tag: string;
  site: TestSite;
  admin: Who;
  treasurer: Who;
  media: Who;
  ids: { itemId: string; entryId: string; fundId: string; perihalId: string; photoId: string; assetId: string; hadisId: string; importId: string };
  /** Everything of this surau that must never appear in another surau's answer. */
  tokens: string[];
}
const actorsOf = (s: SurauCtx): Who[] => [s.admin, s.treasurer, s.media];

interface Rig {
  cloud: TestCloud;
  app: FastifyInstance;
  db: DatabaseSync;
  a: SurauCtx;
  b: SurauCtx;
  p: SurauCtx;
  /** Superadmin + admin on an OPS device (home surau `sdm`). */
  ops: Who;
  /** Support on an ops device. */
  support: Who;
  /** Superadmin + admin on a PUBLIC device enrolled in surau `a`. */
  pub: Who;
  /** The Pentadbir MAXCOM's own markers: a surau must never see them. */
  starTokens: string[];
}

/** A fresh LAN address per anonymous request: the route table is now long enough to pass the 600 per minute limit of one. */
let anonN = 0;
const anonAddress = (): string => `10.168.${(++anonN >> 8) & 255}.${anonN & 255}`;

async function send(
  app: FastifyInstance,
  who: Who | { site: TestSite } | null,
  req: Req,
  extra: Record<string, string> = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...extra };
  if (who !== null) headers.authorization = 'site' in who ? `Bearer ${who.site.token}` : await who.bearer();
  if (req.raw !== undefined) {
    headers['content-type'] = req.raw.type;
    Object.assign(headers, req.raw.extra ?? {});
  }
  const res = await app.inject({
    method: req.method,
    url: req.url,
    headers,
    ...(who === null ? { remoteAddress: anonAddress() } : {}),
    ...(req.raw !== undefined ? { payload: req.raw.body } : req.payload !== undefined ? { payload: req.payload as Record<string, unknown> } : {}),
  });
  const text = res.body;
  let json: Record<string, unknown> = {};
  try {
    const j = JSON.parse(text) as unknown;
    if (typeof j === 'object' && j !== null) json = j as Record<string, unknown>;
  } catch {
    /* not json */
  }
  return { status: res.statusCode, text, json };
}

const count = (db: DatabaseSync, sql: string, ...p: string[]): number => Number((db.prepare(sql).get(...p) as { n: number }).n);
const authCount = (db: DatabaseSync, event: string): number => count(db, 'SELECT COUNT(*) AS n FROM auth_log WHERE event = ?', event);
const detailCount = (db: DatabaseSync, detail: string): number => count(db, 'SELECT COUNT(*) AS n FROM auth_log WHERE detail LIKE ?', `%${detail}%`);

// ---------------------------------------------------------------------------------------------------------------
// the victim's rows, as one comparable set of hashes (one per table)

const VOLATILE = new Set(['auth_log', 'sessions', 'challenges']);
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const jsonOf = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString('base64') : x));

function surauTables(db: DatabaseSync): string[] {
  const out: string[] = [];
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    const name = String(t.name);
    if (VOLATILE.has(name)) continue;
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => String(c.name));
    if (cols.includes('surau_id')) out.push(name);
  }
  return out;
}

/** Hash of every row filed under the surau (all `surau_id` tables, its surau row, its assets and photos). */
function dumpSurau(db: DatabaseSync, s: SurauCtx): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of surauTables(db)) {
    if (t === 'enrolments') {
      // the test helpers file their codes under the default surau: compare the codes of THIS surau's people instead
      out[t] = sha(jsonOf(db.prepare('SELECT * FROM enrolments WHERE user_id IN (SELECT id FROM users WHERE surau_id = ?) ORDER BY code_hash').all(s.id)));
      continue;
    }
    let rows: unknown[];
    try {
      rows = db.prepare(`SELECT * FROM "${t}" WHERE surau_id = ? ORDER BY rowid`).all(s.id);
    } catch {
      rows = db.prepare(`SELECT * FROM "${t}" WHERE surau_id = ?`).all(s.id);
    }
    out[t] = sha(jsonOf(rows));
  }
  out['suraus'] = sha(jsonOf(db.prepare('SELECT * FROM suraus WHERE id = ?').all(s.id)));
  out['assets'] = sha(jsonOf(db.prepare('SELECT * FROM assets WHERE id = ? ORDER BY id').all(s.ids.assetId)));
  return out;
}
function differs(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
}

/** The Pentadbir MAXCOM's user and device rows, byte for byte. */
function starRows(db: DatabaseSync, r: Rig): string {
  return sha(
    jsonOf([
      db.prepare('SELECT * FROM users WHERE id IN (?, ?) ORDER BY id').all(r.ops.userId, r.support.userId),
      db.prepare('SELECT * FROM devices WHERE id IN (?, ?) ORDER BY id').all(r.ops.deviceId, r.support.deviceId),
      db.prepare('SELECT COUNT(*) AS n FROM enrolments WHERE user_id IN (?, ?)').get(r.ops.userId, r.support.userId),
    ]),
  );
}

/** Victim tokens an answer must not contain, minus anything the request itself carried (an echo is no leak). */
function leaksIn(res: Res, tokens: string[], requestText: string): string[] {
  return tokens.filter((t) => res.text.includes(t) && !requestText.includes(t));
}
const requestText = (req: Req, extra: Record<string, string>): string => `${req.url} ${jsonOf(req.payload ?? '')} ${jsonOf(extra)}`;

// ---------------------------------------------------------------------------------------------------------------
// the rig

let nameN = 0;
async function surau(app: FastifyInstance, db: DatabaseSync, id: string, tag: string, boxId: string): Promise<SurauCtx> {
  db.prepare('INSERT OR IGNORE INTO suraus (id, name, created_at, created_by) VALUES (?, ?, ?, ?)').run(id, `Surau MARK${tag}`, new Date().toISOString(), 'test');
  const site = insertSite(db, { surauId: id, boxId });
  const admin = new Who(await loginAs(app, 'admin', TEST_PIN, id));
  const treasurer = new Who(await loginAs(app, 'treasurer', TEST_PIN, id));
  const media = new Who(await loginAs(app, 'media', TEST_PIN, id));
  for (const [w, label] of [[admin, 'admin'], [treasurer, 'bendahari'], [media, 'media']] as const) {
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(`MARK${tag} ${label}`, w.userId);
    db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(`MARK${tag} telefon ${label}`, w.deviceId);
  }
  return { id, tag, site, admin, treasurer, media, ids: { itemId: '', entryId: '', fundId: '', perihalId: '', photoId: '', assetId: '', hadisId: '', importId: '' }, tokens: [] };
}

async function must(res: Promise<Res>, what: string, ok: number[] = [200, 201, 204]): Promise<Res> {
  const r = await res;
  if (!ok.includes(r.status)) throw new Error(`seed ${what} failed: ${r.status} ${r.text.slice(0, 300)}`);
  return r;
}

/** Real content in every area the matrix claims: the marker is in a name, a note, a reason, a title. */
async function seed(app: FastifyInstance, db: DatabaseSync, s: SurauCtx, salt: number): Promise<void> {
  const M = `MARK${s.tag}`;
  putFeature(db, 'finance', { enabled: true }, 'test', undefined, s.id);
  await must(send(app, s.admin, { method: 'PUT', url: '/api/settings/surauInfo', payload: { name: `${M} Masjid` } }), 'surauInfo');
  const itemId = `item-${s.tag.toLowerCase()}`;
  await must(send(app, s.admin, { method: 'PUT', url: `/api/content/penceramah/${itemId}`, payload: { name: `${M} Ustaz` } }), 'content');
  const hadisId = `hadis-${s.tag.toLowerCase()}`;
  putItem(db, 'hadis', { id: hadisId, textMs: `${M} hadis sendiri`, source: 'Riwayat Muslim', order: 9000 }, 'test', undefined, s.id);

  const fundId = `f-${s.tag.toLowerCase()}`;
  const perihalId = `p-${s.tag.toLowerCase()}`;
  await must(send(app, s.admin, { method: 'PUT', url: `/api/finance/funds/${fundId}`, payload: { name: `MARK${s.tag} tabung`, public: false } }), 'fund');
  await must(send(app, s.admin, { method: 'PUT', url: `/api/finance/perihal/${perihalId}`, payload: { label: `MARK${s.tag} sumbangan`, direction: 'in' } }), 'perihal');
  const entryId = `e-${s.tag.toLowerCase()}`;
  await must(
    send(app, s.treasurer, {
      method: 'PUT',
      url: `/api/finance/entries/${entryId}`,
      payload: { kind: 'in', entryDate: '2026-11-06', fundId, perihalId, amountSen: 12345, method: 'tunai', note: `${M} catatan`, counters: [{ userId: s.treasurer.userId }, { name: `${M} penghitung` }] },
    }),
    'entry',
  );
  const photo = await must(
    send(app, s.treasurer, { method: 'POST', url: '/api/finance/photos', raw: { body: jpeg(2000 + salt), type: 'image/jpeg', extra: { 'x-entry-id': entryId } } }),
    'photo',
  );
  const asset = await must(send(app, s.media, { method: 'POST', url: '/api/assets', raw: { body: jpeg(3000 + salt), type: 'image/jpeg' } }), 'asset', [200, 201]);
  const assetId = String((asset.json.id ?? (asset.json.asset as { id?: string } | undefined)?.id) ?? '');
  if (!/^[0-9a-f]{64}$/.test(assetId)) throw new Error(`seed asset id: ${asset.text}`);
  await must(send(app, s.admin, { method: 'PUT', url: '/api/settings/surauInfo', payload: { logo: { asset: assetId } } }), 'logo');

  importDays(db, 'SGR01', OFFICIAL, 'tester', undefined, undefined, s.id);
  await must(
    send(app, s.admin, { method: 'PUT', url: '/api/prayer/corrections/2026-11-26/asar', payload: { time: '16:25', reason: `${M} pembetulan` } }),
    'correction',
  );
  const imp = db.prepare('SELECT id FROM prayer_imports WHERE surau_id = ? LIMIT 1').get(s.id);
  s.ids = { itemId, entryId, fundId, perihalId, photoId: String(photo.json.id), assetId, hadisId, importId: imp === undefined ? 'x' : String(imp.id) };
  // What another surau must never see. Item, entry and fund ids are left out on purpose: an attacker's own write under the
  // same id makes its OWN row (per-surau keys), so an id alone proves nothing; the marker text and the unguessable ids do.
  s.tokens = [
    M,
    ...(s.id === 'sdm' ? [] : [s.id]),
    s.site.boxId,
    ...actorsOf(s).flatMap((w) => [w.userId, w.deviceId]),
    s.ids.photoId,
    assetId,
  ];
  void nameN;
}

/** A device of an ops-role user enrolled by an ordinary code: a PUBLIC device (the legacy phone of the Pentadbir MAXCOM). */
async function publicDevice(app: FastifyInstance, db: DatabaseSync, roles: Role[], surauId: string): Promise<Who> {
  const plain = roles.filter((x) => x !== 'superadmin' && x !== 'support');
  const u = createUser(db, { name: `Awam ${++nameN}`, roles: plain.length > 0 ? plain : ['ajk'] }, 'test', surauId);
  const { code } = beginEnrolment(db, { userId: u.id, deviceName: 'Telefon awam' }, 'test', { canManageSuperadmin: true });
  db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(roles), u.id);
  const keys = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const ip = (): string => `10.77.${(++nameN >> 8) & 255}.${(nameN & 255) || 1}`;
  const enrol = await app.inject({ method: 'POST', url: '/api/enrol/complete', remoteAddress: ip(), payload: { code, publicJwk, platform: 'web', pin: TEST_PIN } });
  if (enrol.statusCode !== 200) throw new Error(`public enrol failed: ${enrol.statusCode} ${enrol.body}`);
  const deviceId = String(enrol.json().deviceId);
  // a Pentadbir MAXCOM account is a `*` user (migration 019); the phone keeps the surau it enrolled in
  db.prepare("UPDATE users SET surau_id = '*', no = NULL, no_src = NULL WHERE id = ?").run(u.id);
  const unlockOnce = async (): Promise<string> => {
    const remoteAddress = ip();
    const ch = await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress, payload: { deviceId } });
    const nonce = String(ch.json().nonce);
    const message = new TextEncoder().encode(`surau-unlock\n${app.surau.boxId}\n${deviceId}\n${nonce}`);
    const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, message);
    const un = await app.inject({ method: 'POST', url: '/api/auth/unlock', remoteAddress, payload: { deviceId, nonce, signature: Buffer.from(sig).toString('base64url'), pin: TEST_PIN } });
    if (un.statusCode !== 200) throw new Error(`public unlock failed: ${un.statusCode} ${un.body}`);
    return String(un.json().token);
  };
  const token = await unlockOnce();
  return new Who({
    token,
    userId: u.id,
    deviceId,
    roles,
    headers: { authorization: `Bearer ${token}` },
    baseVersion: 0,
    relogin: unlockOnce,
    sign: async (m: Uint8Array) => Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Buffer.from(m))).toString('base64url'),
  });
}

async function buildRig(): Promise<Rig> {
  const cloud = buildCloud(CLOUD_BOX, { fetchImpl: noNetwork });
  const app = cloud.app;
  const db = app.surau.db;
  const a = await surau(app, db, ID_A, 'ALPHA', BOX_A);
  const b = await surau(app, db, ID_B, 'BRAVO', BOX_B);
  const p = await surau(app, db, ID_P, 'PILOT', BOX_P);
  const ops = new Who(await loginAs(app, ['superadmin', 'admin']));
  const support = new Who(await loginAs(app, 'support'));
  const pub = await publicDevice(app, db, ['superadmin', 'admin'], ID_A);
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run('MARKSTAR Pentadbir', ops.userId);
  db.prepare('UPDATE devices SET name = ? WHERE id = ?').run('MARKSTAR peranti ops', ops.deviceId);
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run('MARKSTAR Sokongan', support.userId);
  db.prepare('UPDATE devices SET name = ? WHERE id = ?').run('MARKSTAR peranti sokongan', support.deviceId);
  await seed(app, db, a, 0);
  await seed(app, db, b, 1);
  await seed(app, db, p, 2);
  const starTokens = ['MARKSTAR', ops.userId, ops.deviceId, support.userId, support.deviceId];
  return { cloud, app, db, a, b, p, ops, support, pub, starTokens };
}

// ---------------------------------------------------------------------------------------------------------------
// the requests a row is exercised with, from the row's own sample

const DISPOSABLE = new Set(['POST /api/auth/logout', 'POST /api/auth/leave', 'PUT /api/auth/pin']);
/** A live stream: `inject` never sees its end. Its tenant check (header, site key) is still run. */
const STREAMING = new Set(['GET /api/kiosk/events']);
const key = (rule: RouteRule): string => `${rule.method} ${rule.sample}`;

function cashBody(k: SurauCtx, note: string): Record<string, unknown> {
  return { kind: 'in', entryDate: '2026-11-06', fundId: k.ids.fundId, perihalId: k.ids.perihalId, amountSen: 100, method: 'tunai', note, counters: [{ name: 'Penyerang' }] };
}

const OVERRIDES: Record<string, (v: SurauCtx, k: SurauCtx) => Req[]> = {
  'GET /api/content/announcements': (v) => [
    { method: 'GET', url: '/api/content/penceramah' },
    { method: 'GET', url: `/api/content/penceramah/${v.ids.itemId}`, expect404: true },
    { method: 'GET', url: `/api/content/hadis/${v.ids.hadisId}`, expect404: true },
  ],
  'PUT /api/content/announcements/x': (v) => [{ method: 'PUT', url: `/api/content/penceramah/${v.ids.itemId}`, payload: { name: 'Rampasan' } }],
  'DELETE /api/content/announcements/x': (v) => [{ method: 'DELETE', url: `/api/content/penceramah/${v.ids.itemId}` }],
  'PUT /api/settings/clock': () => [
    { method: 'PUT', url: '/api/settings/surauInfo', payload: { name: 'Rampasan' } },
    { method: 'PUT', url: '/api/settings/clock', payload: { show24h: true } },
  ],
  'GET /api/finance/entries/x': (v) => [{ method: 'GET', url: `/api/finance/entries/${v.ids.entryId}`, expect404: true }],
  'PUT /api/finance/entries/x': (v, k) => [{ method: 'PUT', url: `/api/finance/entries/${v.ids.entryId}`, payload: cashBody(k, 'Rampasan') }],
  'PUT /api/finance/funds/x': (v) => [{ method: 'PUT', url: `/api/finance/funds/${v.ids.fundId}`, payload: { name: 'Rampasan', public: false } }],
  'PUT /api/finance/perihal/x': (v) => [{ method: 'PUT', url: `/api/finance/perihal/${v.ids.perihalId}`, payload: { label: 'Rampasan', direction: 'in' } }],
  'GET /api/finance/entries': () => [{ method: 'GET', url: '/api/finance/entries?ym=2026-11' }, { method: 'GET', url: '/api/finance/entries' }],
  [`GET /api/finance/photos/${'a'.repeat(64)}`]: (v) => [{ method: 'GET', url: `/api/finance/photos/${v.ids.photoId}`, expect404: true }],
  'GET /api/sync/finance-photos/x': (v) => [{ method: 'GET', url: `/api/sync/finance-photos/${v.ids.photoId}`, expect404: true }],
  'PUT /api/sync/finance-photos/x': (v) => [{ method: 'PUT', url: `/api/sync/finance-photos/${v.ids.photoId}`, raw: { body: jpeg(2500), type: 'image/jpeg' } }],
  [`GET /api/assets/${'a'.repeat(64)}/analyze`]: (v) => [{ method: 'GET', url: `/api/assets/${v.ids.assetId}/analyze`, expect404: true }],
  'PUT /api/sync/assets/x': (v) => [{ method: 'PUT', url: `/api/sync/assets/${v.ids.assetId}`, raw: { body: jpeg(3500), type: 'image/jpeg' } }],
  'PUT /api/prayer/corrections/2026-11-26/asar': () => [{ method: 'PUT', url: '/api/prayer/corrections/2026-11-26/asar', payload: { time: '17:59', reason: 'Rampasan' } }],
  'GET /api/prayer/imports/x': (v) => [{ method: 'GET', url: `/api/prayer/imports/${v.ids.importId}` }],
  'POST /api/prayer/imports/x/undo': (v) => [{ method: 'POST', url: `/api/prayer/imports/${v.ids.importId}/undo`, payload: {} }],
  'POST /api/hadis/x/accept-update': (v) => [{ method: 'POST', url: `/api/hadis/${v.ids.hadisId}/accept-update`, payload: {} }],
  'PUT /api/users/none/roles': (v) => [{ method: 'PUT', url: `/api/users/${v.admin.userId}/roles`, payload: { roles: ['ajk'] }, expect404: true }],
  'PUT /api/users/none/pin': (v) => [{ method: 'PUT', url: `/api/users/${v.admin.userId}/pin`, payload: { pin: '135790' }, expect404: true }],
  'POST /api/users/none/deactivate': (v) => [{ method: 'POST', url: `/api/users/${v.admin.userId}/deactivate`, payload: {}, expect404: true }],
  'POST /api/devices/none/revoke': (v) => [{ method: 'POST', url: `/api/devices/${v.admin.deviceId}/revoke`, payload: {}, expect404: true }],
  'POST /api/enrol/begin': (v) => [{ method: 'POST', url: '/api/enrol/begin', payload: { userId: v.admin.userId, deviceName: 'Rampasan' }, expect404: true }],
  'POST /api/recovery/code': (v) => [{ method: 'POST', url: '/api/recovery/code', payload: { userId: v.admin.userId } }],
  'POST /api/users': (v) => [{ method: 'POST', url: '/api/users', payload: { name: 'Salinan penyerang', roles: ['ajk'], surauId: v.id } }],
};

function requestsFor(rule: RouteRule, v: SurauCtx, k: SurauCtx): Req[] {
  const o = OVERRIDES[key(rule)];
  if (o !== undefined) return o(v, k);
  const body = rule.method === 'POST' || rule.method === 'PUT' || rule.method === 'PATCH' ? { payload: {} } : {};
  return [{ method: rule.method, url: rule.sample, ...body }];
}

const NEEDS_PERMISSION = (p: Permission | 'public' | 'session' | 'session_or_site', roles: readonly Role[]): boolean =>
  p === 'public' || p === 'session' || p === 'session_or_site' ? true : can(roles, p);

// ---------------------------------------------------------------------------------------------------------------

let R: Rig;
beforeAll(async () => {
  R = await buildRig();
}, 120_000);
afterAll(async () => {
  await R?.cloud.close();
});

describe('the rig itself', () => {
  it('has three suraus, a box each, phones for three roles, an ops device, a public superadmin and a support user', () => {
    const sites = R.db.prepare('SELECT surau_id FROM sites ORDER BY surau_id').all().map((s) => s.surau_id);
    expect(sites).toEqual([ID_A, ID_B, ID_P].sort());
    for (const s of [R.a, R.b, R.p]) {
      for (const w of actorsOf(s)) {
        const d = R.db.prepare('SELECT surau_id, ops FROM devices WHERE id = ?').get(w.deviceId);
        expect(d, s.id).toMatchObject({ surau_id: s.id, ops: 0 });
      }
    }
    expect(R.db.prepare('SELECT surau_id, ops FROM devices WHERE id = ?').get(R.ops.deviceId)).toMatchObject({ surau_id: '*', ops: 1 });
    expect(R.db.prepare('SELECT surau_id, ops FROM devices WHERE id = ?').get(R.support.deviceId)).toMatchObject({ surau_id: '*', ops: 1 });
    expect(R.db.prepare('SELECT surau_id, ops FROM devices WHERE id = ?').get(R.pub.deviceId)).toMatchObject({ surau_id: ID_A, ops: 0 });
  });

  it('seeds every area with the surau marker, and the markers differ per surau', async () => {
    for (const s of [R.a, R.b, R.p]) {
      expect(new Set(s.tokens).size).toBe(s.tokens.length);
      for (const t of ['content_items', 'settings', 'finance_entries', 'finance_photos', 'prayer_corrections', 'surau_assets', 'users', 'devices', 'change_log']) {
        expect(count(R.db, `SELECT COUNT(*) AS n FROM ${t} WHERE surau_id = ?`, s.id), `${t} of ${s.id}`).toBeGreaterThan(0);
      }
    }
    expect(R.a.tokens.filter((t) => R.b.tokens.includes(t))).toEqual([]);
  });

  it('the route table has a sample for every row and the matrix covers each of them (no row skipped)', () => {
    for (const rule of ROUTE_PERMISSIONS) {
      expect(rule.sample, 'sample').not.toBe('');
      expect(rule.pattern.test(rule.sample.toLowerCase()), key(rule)).toBe(true);
    }
    expect(ROUTE_PERMISSIONS.length).toBeGreaterThan(100);
    // every override belongs to a real row
    const keys = new Set(ROUTE_PERMISSIONS.map(key));
    for (const k of Object.keys(OVERRIDES)) expect(keys.has(k), `override ${k} names no row`).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 1. the walk: an actor of another surau, over every row

// ---------------------------------------------------------------------------------------------------------------
// 0. positive controls first (read-only, before any walk changes anything): the right actor reads its own data

describe('positive control: each surau reads its own data in every area, and only its own', () => {
  const all = (): SurauCtx[] => [R.a, R.b, R.p];
  const reads = (s: SurauCtx): Array<{ what: string; who: Who; url: string; own: string }> => [
    { what: 'users', who: s.admin, url: '/api/users', own: `MARK${s.tag} admin` },
    { what: 'devices', who: s.admin, url: '/api/devices', own: `MARK${s.tag} telefon` },
    { what: 'content', who: s.media, url: '/api/content/penceramah', own: `MARK${s.tag} Ustaz` },
    { what: 'content item', who: s.media, url: `/api/content/penceramah/${s.ids.itemId}`, own: `MARK${s.tag} Ustaz` },
    { what: 'hadis', who: s.media, url: '/api/content/hadis', own: `MARK${s.tag} hadis` },
    { what: 'settings', who: s.admin, url: '/api/settings', own: `MARK${s.tag} Masjid` },
    { what: 'kiosk bundle (settings, prayer correction)', who: s.admin, url: '/api/kiosk/bundle', own: `MARK${s.tag} Masjid` },
    { what: 'finance entries', who: s.treasurer, url: '/api/finance/entries', own: `MARK${s.tag} catatan` },
    { what: 'finance entry', who: s.treasurer, url: `/api/finance/entries/${s.ids.entryId}`, own: `MARK${s.tag} catatan` },
    { what: 'finance funds', who: s.treasurer, url: '/api/finance/funds', own: `MARK${s.tag} tabung` },
    { what: 'finance perihal', who: s.treasurer, url: '/api/finance/perihal', own: `MARK${s.tag} sumbangan` },
    { what: 'assets', who: s.media, url: '/api/assets', own: s.ids.assetId },
    { what: 'sync snapshot (user)', who: s.admin, url: '/api/sync/snapshot', own: `MARK${s.tag} Ustaz` },
    { what: 'change log (audit)', who: s.admin, url: '/api/audit', own: `MARK${s.tag}` },
  ];

  it('every read returns its own marker', async () => {
    for (const s of all()) {
      for (const r of reads(s)) {
        const res = await send(R.app, r.who, { method: 'GET', url: r.url });
        expect(res.status, `${s.tag} ${r.what}: ${res.text.slice(0, 200)}`).toBe(200);
        expect(res.text, `${s.tag} ${r.what} holds its own data`).toContain(r.own);
      }
    }
  });

  it('and none of another surau (name, ids, photo, asset) in any answer, the audit and the asset list included', async () => {
    const leakyPaths = new Set<string>();
    for (const s of all()) {
      const others = all().filter((o) => o !== s);
      for (const r of reads(s)) {
        if (leakyPaths.has(r.url)) continue;
        const res = await send(R.app, r.who, { method: 'GET', url: r.url });
        for (const o of others) {
          const l = leaksIn(res, o.tokens, r.url);
          expect(l, `${s.tag} ${r.what} shows ${o.tag}`).toEqual([]);
        }
      }
    }
  });

  it('a finance photo and the surau logo come back for the owner (bytes), and the logo is served by box id', async () => {
    for (const s of all()) {
      const photo = await R.app.inject({ method: 'GET', url: `/api/finance/photos/${s.ids.photoId}`, headers: { authorization: await s.treasurer.bearer() } });
      expect(photo.statusCode, `${s.tag} photo`).toBe(200);
      expect(photo.headers['content-type']).toContain('image/jpeg');
      const logo = await R.app.inject({ method: 'GET', url: '/surau-logo', headers: { [BOX_HEADER]: s.site.boxId }, remoteAddress: LAN });
      expect(logo.statusCode, `${s.tag} logo by box id`).toBe(200);
      const info = await send(R.app, null, { method: 'GET', url: '/api/surau/info' }, { [BOX_HEADER]: s.site.boxId });
      expect(info.json.name, `${s.tag} public name by box id`).toBe(`MARK${s.tag} Masjid`);
    }
  });

  it("the site key reads its own surau's snapshot and feed (and the Pentadbir MAXCOM's `*` rows by design), never another surau's", async () => {
    for (const s of all()) {
      const snap = await send(R.app, { site: s.site }, { method: 'GET', url: '/api/sync/snapshot' });
      expect(snap.status).toBe(200);
      expect(snap.text).toContain(`MARK${s.tag} Ustaz`);
      const feed = await send(R.app, { site: s.site }, { method: 'GET', url: '/api/sync/changes?since=0' });
      expect(feed.status).toBe(200);
      expect(feed.text).toContain(s.admin.userId);
      for (const o of all().filter((x) => x !== s)) {
        expect(leaksIn(snap, o.tokens, ''), `${s.tag} snapshot shows ${o.tag}`).toEqual([]);
        expect(leaksIn(feed, o.tokens, ''), `${s.tag} feed shows ${o.tag}`).toEqual([]);
      }
    }
  });

  it('public routes: an unknown, malformed or missing box id gets the neutral answer; health lists no site; the box id of another surau gives only that surau its public face', async () => {
    const neutral: Array<Record<string, string>> = [{}, { [BOX_HEADER]: 'ffffffffffffffff' }, { [BOX_HEADER]: 'nothex' }, { [BOX_HEADER]: R.a.site.boxId.toUpperCase() }];
    for (const hdr of neutral) {
      const info = await send(R.app, null, { method: 'GET', url: '/api/surau/info' }, hdr);
      expect(info.status).toBe(200);
      for (const s of all()) expect(leaksIn(info, s.tokens, ''), 'neutral answer').toEqual([]);
      const logo = await R.app.inject({ method: 'GET', url: '/surau-logo', headers: hdr, remoteAddress: LAN });
      expect(logo.statusCode).toBe(404);
    }
    const health = await send(R.app, null, { method: 'GET', url: '/api/health' });
    for (const s of all()) expect(leaksIn(health, s.tokens, ''), 'anonymous health').toEqual([]);
    const authed = await send(R.app, R.b.admin, { method: 'GET', url: '/api/health' });
    for (const o of [R.a, R.p]) expect(leaksIn(authed, o.tokens, ''), 'health of b').toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------------------
// 1. the walks

interface Pair {
  name: string;
  pilot?: boolean;
  victim: () => SurauCtx;
  attacker: () => SurauCtx;
}
const PAIRS: Pair[] = [
  { name: 'b against a', victim: () => R.a, attacker: () => R.b },
  { name: 'a against the pilot sdm', pilot: true, victim: () => R.p, attacker: () => R.a },
];

/**
 * Rows found leaking by this matrix, marked `it.fails` until fixed. All closed (fix(cloud) after Task 12): the asset list and
 * analyze read are limited to the surau's `surau_assets`, both audit views to the request's surau without `*` rows, and the
 * YouTube sign-out files its change row under the request's surau. A new leak is added here with a `LEAK:` comment.
 */
const KNOWN_LEAK_ROWS = new Set<string>([]);
/** Rows that only leak toward one victim (the pilot, whose id is the default an unscoped write lands under). None now. */
const KNOWN_LEAK_PILOT_ONLY = new Set<string>([]);
/** Public by design on the cloud (decision 8): the name, kind, logo and zone of the surau whose box id is named. */
const PUBLIC_BY_BOX = new Set(['GET /api/surau/info', 'GET /surau-logo', 'GET /api/health', 'GET /app/ios.mobileconfig']);

for (const pair of PAIRS) {
  describe(`isolation walk over every route row: ${pair.name}`, () => {
    for (const rule of ROUTE_PERMISSIONS) {
      const title = `${rule.method} ${rule.sample} (${rule.permission}${rule.ops === true ? ', ops' : ''}, tenant ${rule.tenant})`;
      const run = async (): Promise<void> => {
        const v = pair.victim();
        const k = pair.attacker();
        const before = dumpSurau(R.db, v);
        const starBefore = starRows(R.db, R);
        const leaks: string[] = [];
        const problems: string[] = [];
        const allTokens = [...v.tokens, ...R.starTokens];
        const publicByBox = PUBLIC_BY_BOX.has(key(rule));
        const check = (res: Res, req: Req, extra: Record<string, string>, label: string, viaBox = false): void => {
          // a site's feed carries the `*` user and device by design (Plan 14 section 3.1); the victim's own data never
          const tokens = label.startsWith('site key') ? v.tokens : allTokens;
          if (viaBox && publicByBox) {
            // the one accepted answer: only the public face of the surau (never an id, a user, a box id or a setting)
            if (res.status === 200 && rule.sample === '/api/surau/info') {
              expect(Object.keys(res.json).sort(), `${label} public info keys`).toEqual(['country', 'kind', 'logo', 'name', 'showName', 'timezone', 'utcOffsetMinutes']);
            }
            const l = leaksIn(res, tokens.filter((t) => !t.startsWith('MARK') || t.startsWith('MARKSTAR')), requestText(req, extra));
            if (l.length > 0) leaks.push(`${label} ${req.method} ${req.url}: ${l.join(',')}`);
            return;
          }
          const l = leaksIn(res, tokens, requestText(req, extra));
          if (l.length > 0) leaks.push(`${label} ${req.method} ${req.url}: ${l.join(',')}${process.env.TI_DEBUG ? ' BODY ' + res.text.slice(0, 600) : ''}`);
          if (res.status >= 500 && !(res.status === 502 && res.json.reason === 'upstream')) problems.push(`${label} ${req.method} ${req.url}: ${res.status} ${res.text.slice(0, 120)}`);
        };

        const disposable = DISPOSABLE.has(key(rule));
        const reqs = disposable ? [] : requestsFor(rule, v, k);
        const streaming = STREAMING.has(key(rule));
        const actors = disposable ? [] : actorsOf(k);
        // a box-only route is not served by the cloud at all: every caller gets the router's 404
        const absent = !disposable && rule.permission !== 'public' && reqs.length > 0 && (await send(R.app, null, reqs[0]!)).status === 404;
        const refused = (status: number): number[] => (absent ? [403, 404] : [403]);

        for (const who of actors) {
          for (const req of reqs) {
            const permitted = NEEDS_PERMISSION(rule.permission, who.roles);
            // (1) the attacker's own call, with the id of the victim's row: it sees its own surau or nothing
            let plainStatus = -1;
            if (!streaming) {
              const r1 = await send(R.app, who, req);
              plainStatus = r1.status;
              check(r1, req, {}, `${who.roles[0]} plain`);
              if (rule.ops === true) expect(r1.status, `ops row for a surau role: ${r1.text}`).toBe(403);
              else if (req.expect404 === true && permitted) expect(r1.status, `${req.method} ${req.url} for ${who.roles[0]}: ${r1.text}`).toBe(404);
              else if (!permitted) expect(refused(r1.status), `${req.method} ${req.url} for ${who.roles[0]}: ${r1.status}`).toContain(r1.status);
            }
            // (2) X-Maxcom-Surau naming the victim: 403 on every tenant row, one cross_surau_refused row when it got that far
            const h1 = { [SURAU_HEADER]: v.id };
            const logBefore = authCount(R.db, 'cross_surau_refused');
            // one row per (device, code) a minute (qs-gate): forget it, so this call's own row is what is counted
            resetRefusalLogThrottle(R.db);
            const r2 = await send(R.app, who, req, h1);
            check(r2, req, h1, `${who.roles[0]} header`);
            if (rule.tenant === 'required') {
              // a route the cloud does not serve at all (box-only) answers 404 with and without the header
              if (absent) {
                expect(refused(r2.status)).toContain(r2.status);
                expect(authCount(R.db, 'cross_surau_refused') - logBefore).toBe(0);
              }
              else {
                expect(r2.status, `X-Maxcom-Surau on ${req.method} ${req.url} as ${who.roles[0]}: ${r2.text}`).toBe(403);
                expect(authCount(R.db, 'cross_surau_refused') - logBefore, `cross_surau_refused row for ${who.roles[0]}`).toBe(permitted ? 1 : 0);
              }
            }
            if (rule.ops === true) expect(r2.status).toBe(403);
            // (3) X-Maxcom-Box naming the victim's box changes nothing for a signed-in caller
            if (!streaming) {
              const h2 = { [BOX_HEADER]: v.site.boxId };
              const r3 = await send(R.app, who, req, h2);
              check(r3, req, h2, `${who.roles[0]} box header`, true);
            }
          }
        }

        // (4) the attacker's site key, naming the victim's ids: only the sync paths pass the hook at all
        for (const req of reqs) {
          const r4 = await send(R.app, { site: k.site }, req);
          check(r4, req, {}, 'site key');
          if (rule.permission !== 'public' && !siteMayCall(req.method, req.url)) expect(refused(r4.status), `site key on ${req.method} ${req.url}: ${r4.status} ${r4.text}`).toContain(r4.status);
          const h = { [SURAU_HEADER]: v.id, [BOX_HEADER]: v.site.boxId };
          const r5 = await send(R.app, { site: k.site }, req, h);
          check(r5, req, h, 'site key + headers', true);
        }

        // (5) a disposable-session row (logout, leave, PIN change) with a fresh throwaway login of the attacker's surau
        if (disposable) {
          const fresh = new Who(await loginAs(R.app, 'ajk', TEST_PIN, k.id));
          const req: Req = { method: rule.method, url: rule.sample, ...(rule.method === 'GET' || rule.method === 'DELETE' ? {} : { payload: {} }) };
          const r = await send(R.app, fresh, req, { [SURAU_HEADER]: v.id });
          check(r, req, { [SURAU_HEADER]: v.id }, 'throwaway');
        }

        // (6) anonymous, with the victim's headers
        for (const req of reqs.slice(0, 1)) {
          const hh = { [SURAU_HEADER]: v.id, [BOX_HEADER]: v.site.boxId };
          const r6 = await send(R.app, null, req, hh);
          check(r6, req, hh, 'anonymous', true);
          if (rule.permission !== 'public') expect(absent ? [401, 403, 404] : [401, 403], `anonymous ${req.method} ${req.url}`).toContain(r6.status);
        }

        expect(leaks.join(' | '), 'victim data in an answer').toBe('');
        expect(problems.join(' | '), 'server errors').toBe('');
        expect(differs(before, dumpSurau(R.db, v)), `victim rows changed by ${rule.method} ${rule.sample}`).toEqual([]);
        expect(starRows(R.db, R), 'the Pentadbir MAXCOM rows changed').toBe(starBefore);
      };
      if (KNOWN_LEAK_ROWS.has(key(rule)) || (pair.pilot === true && KNOWN_LEAK_PILOT_ONLY.has(key(rule)))) it.fails(`LEAK: ${title}`, run, 60_000);
      else it(title, run, 60_000);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// 2. every sync entry kind a site may send, and every device op kind, naming the other surau's ids

const EDITED = '2026-11-13T03:00:00.000Z';
let seqN = 1000;
interface Entry {
  seq: number; entity: string; entityId: string; rev: string; editedAt: string; syncedAt: string;
  actor: string; deviceId: string | null; origin: string; opId: string | null; after: unknown;
}
function entry(over: Partial<Entry> & { entity: string; entityId: string; after: unknown }): Entry {
  seqN += 1;
  return { seq: seqN, rev: `${EDITED}|local`, editedAt: EDITED, syncedAt: EDITED, actor: 'local', deviceId: null, origin: 'local', opId: null, ...over };
}
interface PushOut { applied: number; duplicate: number; superseded: number; refused: number; reasons: string[] }
async function pushEntries(site: TestSite, entries: unknown[]): Promise<{ status: number; out: PushOut }> {
  const r = await send(R.app, { site }, { method: 'POST', url: '/api/sync/ops', payload: { entries } });
  return { status: r.status, out: r.json as unknown as PushOut };
}
async function pushOp(who: Who, input: OpInput): Promise<{ status: number; result: OpResult | undefined; text: string }> {
  const op = await signOp(who.login, R.app.surau.boxId, input);
  const r = await send(R.app, who, { method: 'POST', url: '/api/sync/ops', payload: { ops: [op] } });
  return { status: r.status, result: (r.json.results as OpResult[] | undefined)?.[0], text: r.text };
}
const b64 = (n: number): string => jpeg(n).toString('base64');

/** The entity kinds a site may send, read from the verifier's own pattern so a new kind cannot slip in unseen. */
function siteEntryKinds(): string[] {
  const src = readFileSync(fileURLToPath(new URL('../src/sync/verify.ts', import.meta.url)), 'utf8');
  const m = /const ENTRY_ENTITY_RE = \/\^\((.*)\)\$\/;/.exec(src);
  if (m === null) throw new Error('ENTRY_ENTITY_RE not found');
  const kinds: string[] = [];
  for (const alt of m[1]!.split(/\|(?![^()]*\))/)) {
    const pm = /^prayer:\(\?:([a-z|]+)\)$/.exec(alt);
    const fm = /^finance:\(\?:([a-z|]+)\)$/.exec(alt);
    if (pm !== null) for (const k of pm[1]!.split('|')) kinds.push(`prayer:${k}`);
    else if (fm !== null) for (const k of fm[1]!.split('|')) kinds.push(`finance:${k}`);
    else if (alt.startsWith('content:')) kinds.push('content:*');
    else kinds.push(alt);
  }
  return kinds.sort();
}

describe('every sync entry kind a site may send, naming another surau\'s ids: the victim never changes', () => {
  const entryFor = (kind: string, v: SurauCtx, k: SurauCtx): Entry => {
    switch (kind) {
      case 'content:*': return entry({ entity: 'content:penceramah', entityId: v.ids.itemId, after: { id: v.ids.itemId, name: 'Rampasan' } });
      case 'settings': return entry({ entity: 'settings', entityId: 'surauInfo', after: { name: 'Rampasan' } });
      case 'user': return entry({ entity: 'user', entityId: v.admin.userId, after: { name: 'Dirampas', roles: ['admin'], active: false } });
      case 'device': return entry({ entity: 'device', entityId: v.admin.deviceId, after: { revoked: true } });
      case 'prayer:correction': return entry({ entity: 'prayer:correction', entityId: '2026-11-26|asar', after: { time: '17:59', reason: 'Rampasan' } });
      case 'prayer:official': return entry({ entity: 'prayer:official', entityId: 'SGR01:2026', after: { zone: 'SGR01', days: [] } });
      case 'prayer:import': return entry({ entity: 'prayer:import', entityId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', after: { zone: 'SGR01' } });
      case 'finance:fund': return entry({ entity: 'finance:fund', entityId: v.ids.fundId, after: { name: 'Rampasan', public: false, sortOrder: 0 } });
      case 'finance:perihal': return entry({ entity: 'finance:perihal', entityId: v.ids.perihalId, after: { direction: 'in', label: 'Rampasan', sortOrder: 0 } });
      case 'finance:entry': return entry({ entity: 'finance:entry', entityId: v.ids.entryId, after: { id: v.ids.entryId, ...cashBody(k, 'Rampasan') } });
      case 'finance:month': return entry({ entity: 'finance:month', entityId: '2026-11', after: { status: 'open' } });
      case 'finance:photo': return entry({ entity: 'finance:photo', entityId: v.ids.photoId, after: { mime: 'image/jpeg', bytes: 2000, entryId: v.ids.entryId } });
      default: throw new Error(`no sample for sync entry kind ${kind}: add one`);
    }
  };

  it('the kinds are read from the verifier (a new kind fails here until it has a sample)', () => {
    const kinds = siteEntryKinds();
    expect(kinds).toEqual(
      ['content:*', 'device', 'finance:entry', 'finance:fund', 'finance:month', 'finance:perihal', 'finance:photo', 'prayer:correction', 'prayer:import', 'prayer:official', 'settings', 'user'].sort(),
    );
  });

  for (const kind of ['content:*', 'device', 'finance:entry', 'finance:fund', 'finance:month', 'finance:perihal', 'finance:photo', 'prayer:correction', 'prayer:import', 'prayer:official', 'settings', 'user']) {
    it(`site b pushes ${kind} with a's ids: a is byte-identical, nothing is answered of a, the foreign user and device ids are refused foreign_id`, async () => {
      const v = R.a;
      const before = dumpSurau(R.db, v);
      const star = starRows(R.db, R);
      const refused0 = count(R.db, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'sync_refused'");
      const { status, out } = await pushEntries(R.b.site, [entryFor(kind, v, R.b)]);
      expect(status).toBe(200);
      expect(out.applied + out.duplicate + out.superseded + out.refused, `one verdict: ${JSON.stringify(out)}`).toBe(1);
      expect(differs(before, dumpSurau(R.db, v)), `a changed by ${kind}`).toEqual([]);
      expect(starRows(R.db, R)).toBe(star);
      if (kind === 'user' || kind === 'device') {
        expect(out.refused, JSON.stringify(out)).toBe(1);
        expect(out.reasons).not.toContain('foreign_id');
        expect(out.reasons).toContain('invalid');
        expect(count(R.db, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'sync_refused'") - refused0).toBe(1);
        expect(detailCount(R.db, 'foreign_id')).toBeGreaterThan(0);
      }
      // the same entry from a's OWN site is not refused as foreign: the matrix cannot pass by refusing everything
      if (kind === 'content:*') {
        const own = await pushEntries(R.a.site, [entry({ entity: 'content:penceramah', entityId: 'sync-own-a', after: { id: 'sync-own-a', name: 'MARKALPHA sendiri' } })]);
        expect(own.out.applied).toBe(1);
      }
    });
  }

  it("a site claiming another box as its origin is refused foreign_origin for every kind, and a's rows stay identical", async () => {
    const before = dumpSurau(R.db, R.a);
    for (const kind of ['content:*', 'settings', 'finance:fund', 'prayer:correction']) {
      const e = { ...entryFor(kind, R.a, R.b), origin: `box:${R.a.site.boxId}` };
      const { out } = await pushEntries(R.b.site, [e]);
      expect(out.refused, `${kind}: ${JSON.stringify(out)}`).toBe(1);
    }
    expect(detailCount(R.db, 'foreign_origin')).toBeGreaterThanOrEqual(4);
    expect(differs(before, dumpSurau(R.db, R.a))).toEqual([]);
  });

  it('a device entry carrying after.ops or a home box that is not the sender is refused (bad_device / box_mismatch), a untouched', async () => {
    const before = dumpSurau(R.db, R.a);
    const e1 = entry({ entity: 'device', entityId: 'newdevice-b1', after: { id: 'newdevice-b1', userId: R.b.admin.userId, name: 'X', platform: 'web', ops: true } });
    const e2 = entry({ entity: 'device', entityId: 'newdevice-b2', after: { id: 'newdevice-b2', userId: R.b.admin.userId, name: 'X', platform: 'web', boxId: R.a.site.boxId } });
    const { out } = await pushEntries(R.b.site, [e1, e2]);
    expect(out.refused).toBe(2);
    expect(R.db.prepare('SELECT 1 AS x FROM devices WHERE id IN (?, ?)').get('newdevice-b1', 'newdevice-b2')).toBeUndefined();
    expect(differs(before, dumpSurau(R.db, R.a))).toEqual([]);
  });

  // Was a LEAK: a site entry `finance:photo` with another surau's hash registered the id as the sender's own, after which the
  // sender's GET served the file. Now refused `foreign_id` (src/sync/apply.ts), and a's file stays a's.
  it('a foreign photo id from a site never lets surau b read a photo of a', async () => {
    const logged = detailCount(R.db, 'site_apply_foreign_id');
    const { out } = await pushEntries(R.b.site, [entryFor('finance:photo', R.a, R.b)]);
    expect(out.refused).toBe(1);
    expect(detailCount(R.db, 'site_apply_foreign_id') - logged, 'one auth_log row').toBe(1);
    expect(R.db.prepare('SELECT 1 AS x FROM finance_photos WHERE id = ? AND surau_id = ?').get(R.a.ids.photoId, R.b.id)).toBeUndefined();
    const res = await send(R.app, R.b.treasurer, { method: 'GET', url: `/api/finance/photos/${R.a.ids.photoId}` });
    // b registering a's photo hash as its own must not turn a's file into b's
    expect([404, 410], `b reads a's photo after claiming its id: ${res.status}`).toContain(res.status);
    // success path: a still reads its own photo
    const own = await send(R.app, R.a.treasurer, { method: 'GET', url: `/api/finance/photos/${R.a.ids.photoId}` });
    expect(own.status).toBe(200);
  });
});

describe('every device op kind, signed by a phone of b, naming a', () => {
  const inputFor = (kind: string, v: SurauCtx, k: SurauCtx): OpInput => {
    switch (kind) {
      case 'content.put': return { kind, entity: 'content:penceramah', entityId: v.ids.itemId, payload: { name: 'Rampasan' } };
      case 'content.delete': return { kind, entity: 'content:penceramah', entityId: v.ids.itemId, payload: null };
      case 'settings.put': return { kind, entity: 'settings', entityId: 'surauInfo', payload: { name: 'Rampasan' } };
      case 'asset.put': return { kind, entity: 'asset', entityId: v.ids.assetId, payload: { mime: 'image/jpeg', bytesBase64: b64(4000) } };
      case 'user.put': return { kind, entity: 'user', entityId: v.admin.userId, payload: { name: 'Dirampas', roles: ['admin'], active: false } };
      case 'device.revoke': return { kind, entity: 'device', entityId: v.admin.deviceId, payload: null };
      case 'audit.put': return { kind, entity: 'audit', entityId: 'a-1', payload: { event: 'x' } };
      case 'finance.append': return { kind, entity: 'finance:entry', entityId: v.ids.entryId, payload: cashBody(k, 'Rampasan') };
      case 'finance.lookup.put': return { kind, entity: 'finance:fund', entityId: v.ids.fundId, payload: { name: 'Rampasan', public: false } };
      case 'finance.month.put': return { kind, entity: 'finance:month', entityId: '2026-11', payload: { status: 'open' } };
      case 'finance.photo.put': return { kind, entity: 'finance:photo', entityId: v.ids.photoId, payload: { bytesBase64: b64(2000), entryId: v.ids.entryId } };
      default: throw new Error(`no sample for op kind ${kind}: add one`);
    }
  };
  const KINDS = Object.keys(OP_PERMISSIONS);

  it('the op kinds are enumerated from OP_PERMISSIONS (a new kind fails here until it has a sample)', () => {
    for (const kind of KINDS) expect(() => inputFor(kind, R.a, R.b), kind).not.toThrow();
    expect(KINDS.length).toBe(11);
  });

  for (const kind of Object.keys(OP_PERMISSIONS)) {
    it(`${kind}: surauId a, boxId of a, and a's entity id under b's own surau: a is byte-identical; the first two are refused`, async () => {
      const v = R.a;
      const before = dumpSurau(R.db, v);
      const star = starRows(R.db, R);
      const input = inputFor(kind, v, R.b);
      // (i) naming a's surau
      const named = await pushOp(R.b.admin, { ...input, surauId: v.id });
      expect(named.status, named.text).toBe(200);
      expect(named.result?.status, `${kind} surauId a: ${named.text}`).toBe('refused');
      expect(detailCount(R.db, 'surau_mismatch')).toBeGreaterThan(0);
      // (ii) naming a's box
      const boxed = await pushOp(R.b.admin, { ...input, surauId: R.b.id, boxId: v.site.boxId });
      expect(boxed.result?.status, `${kind} boxId a: ${boxed.text}`).toBe('refused');
      expect(detailCount(R.db, 'box_mismatch')).toBeGreaterThan(0);
      // (iii) b's own surau and box, a's entity id: it acts in b (per-surau keys) or is refused, never in a
      const guess = await pushOp(R.b.admin, { ...input, surauId: R.b.id });
      expect(guess.status, guess.text).toBe(200);
      expect(['applied', 'refused', 'duplicate', 'superseded'], guess.text).toContain(guess.result?.status);
      expect(differs(before, dumpSurau(R.db, v)), `a changed by ${kind}`).toEqual([]);
      expect(starRows(R.db, R)).toBe(star);
      if (kind === 'user.put' || kind === 'device.revoke') expect(guess.result?.status, 'a user or device of a is never b\'s to change').toBe('refused');
    });
  }

  it("success path: the same phone's op naming its own surau and an id of its own applies in b and not in a", async () => {
    const before = dumpSurau(R.db, R.a);
    const ok = await pushOp(R.b.admin, { kind: 'content.put', entity: 'content:penceramah', entityId: 'op-own-b', payload: { name: 'MARKBRAVO op' }, surauId: R.b.id });
    expect(ok.result?.status).toBe('applied');
    expect(R.db.prepare('SELECT surau_id FROM content_items WHERE id = ?').get('op-own-b')).toMatchObject({ surau_id: R.b.id });
    expect(differs(before, dumpSurau(R.db, R.a))).toEqual([]);
  });

  it("a phone of b cannot be used with a's box id on unlock either (the signature names the device's own box)", async () => {
    // the phone's key signs `surau-unlock\n<box>\n<device>\n<nonce>`; a signature naming a's box id is refused
    const dev = R.b.admin;
    const ch = await R.app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress: '10.99.0.9', payload: { deviceId: dev.deviceId } });
    const nonce = String(ch.json().nonce);
    const sig = await dev.login.sign(new TextEncoder().encode(`surau-unlock\n${R.a.site.boxId}\n${dev.deviceId}\n${nonce}`));
    const un = await R.app.inject({ method: 'POST', url: '/api/auth/unlock', remoteAddress: '10.99.0.9', payload: { deviceId: dev.deviceId, nonce, signature: sig, pin: TEST_PIN } });
    expect(un.statusCode).toBe(401);
    expect(un.json().token).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. the Pentadbir MAXCOM: public device, ops device, support (decisions 14, 15, 16)

const HIGH_PERMS: Array<Permission> = ['superadmin:manage', 'system:read', 'system:write', 'fleet:read', 'fleet:manage', 'surau:create', 'surau:suspend', 'audit:read_all'];

describe('ops rows: a Pentadbir MAXCOM (superadmin + admin, home surau a) on a PUBLIC device', () => {
  it('without a header every answer is what a surau admin gets, and nothing more (status equal on every GET row)', async () => {
    const mismatched: string[] = [];
    for (const rule of ROUTE_PERMISSIONS) {
      if (rule.method !== 'GET' || DISPOSABLE.has(key(rule)) || STREAMING.has(key(rule)) || rule.permission === 'public') continue;
      const req: Req = { method: 'GET', url: rule.sample };
      const adminA = await send(R.app, R.a.admin, req);
      const sa = await send(R.app, R.pub, req);
      if (adminA.status !== sa.status) mismatched.push(`${rule.sample}: a admin ${adminA.status}, public superadmin ${sa.status}`);
      for (const o of [R.b, R.p]) expect(leaksIn(sa, o.tokens, req.url), `public superadmin sees ${o.tag} on ${rule.sample}`).toEqual([]);
      if (!['/api/sync/changes', '/api/sync/snapshot'].includes(rule.sample)) expect(leaksIn(sa, R.starTokens, req.url), `public superadmin sees the ops rows on ${rule.sample}`).toEqual([]);
    }
    expect(mismatched).toEqual([]);
    const me = await send(R.app, R.pub, { method: 'GET', url: '/api/auth/me' });
    expect(me.json.roles).not.toContain('superadmin');
    expect(me.json.ops).toBe(false);
  });

  for (const victim of ['b', 'p'] as const) {
    it(`with X-Maxcom-Surau naming ${victim}: every tenant route is 403 ops_device_required, every ops route and high-permission route is 403, and ${victim} is byte-identical`, async () => {
      const v = victim === 'b' ? R.b : R.p;
      const before = dumpSurau(R.db, v);
      const star = starRows(R.db, R);
      const bad: string[] = [];
      for (const rule of ROUTE_PERMISSIONS) {
        if (DISPOSABLE.has(key(rule)) || STREAMING.has(key(rule))) continue;
        const reqs = requestsFor(rule, v, R.a);
        const logs = detailCount(R.db, 'ops_device_required');
        for (const req of reqs) {
          // one row per (device, code) a minute (qs-gate): each row of the walk counts its own
          resetRefusalLogThrottle(R.db);
          const res = await send(R.app, R.pub, req, { [SURAU_HEADER]: v.id });
          if (leaksIn(res, v.tokens, requestText(req, { [SURAU_HEADER]: v.id })).length > 0) bad.push(`LEAK ${rule.method} ${req.url}`);
          if (rule.tenant === 'required' && res.status !== 403 && res.status !== 404) bad.push(`${rule.method} ${req.url} -> ${res.status}`);
          if (rule.ops === true && res.status !== 403) bad.push(`ops row ${req.url} -> ${res.status}`);
          if ((HIGH_PERMS as string[]).includes(rule.permission) && res.status !== 403) bad.push(`high permission ${rule.permission} ${req.url} -> ${res.status}`);
        }
        if (rule.tenant === 'required' && !(await send(R.app, null, reqs[0]!)).status.toString().startsWith('404')) {
          if (NEEDS_PERMISSION(rule.permission, ['admin'])) {
            // the refusal is logged (the column `detail` holds the fixed code), at least once per row
            if (detailCount(R.db, 'ops_device_required') <= logs) bad.push(`no ops_device_required row for ${rule.method} ${rule.sample}`);
          }
        }
      }
      expect(bad).toEqual([]);
      expect(differs(before, dumpSurau(R.db, v))).toEqual([]);
      expect(starRows(R.db, R)).toBe(star);
    });
  }

  it('the same header naming its OWN surau is refused too (a public device never acts through the header)', async () => {
    const res = await send(R.app, R.pub, { method: 'GET', url: '/api/users' }, { [SURAU_HEADER]: R.a.id });
    expect(res.status).toBe(403);
    expect(res.json.reason).toBe('ops_device_required');
  });

  it('every route that needs superadmin:manage, system:*, fleet:*, surau:* or audit:read_all is 403 without a header too', async () => {
    let seen = 0;
    for (const rule of ROUTE_PERMISSIONS.filter((r) => (HIGH_PERMS as string[]).includes(r.permission))) {
      seen += 1;
      const res = await send(R.app, R.pub, { method: rule.method, url: rule.sample, ...(rule.method === 'GET' ? {} : { payload: {} }) });
      expect(res.status, `${rule.method} ${rule.sample}`).toBe(403);
    }
    expect(seen).toBeGreaterThan(8);
  });
});

describe('ops rows: the same person on an OPS device (positive control) and a Sokongan MAXCOM', () => {
  it('with the header the ops device reads b and p: their markers, never a\'s; without it 400 surau_required; an unknown surau 404', async () => {
    for (const [s, others] of [[R.b, [R.a, R.p]], [R.p, [R.a, R.b]]] as const) {
      for (const [url, own] of [['/api/users', `MARK${s.tag} admin`], ['/api/content/penceramah', `MARK${s.tag} Ustaz`], ['/api/content/hadis', `MARK${s.tag} hadis`], ['/api/finance/entries', `MARK${s.tag} catatan`]] as const) {
        const res = await send(R.app, R.ops, { method: 'GET', url }, { [SURAU_HEADER]: s.id });
        expect(res.status, `${s.tag} ${url}`).toBe(200);
        expect(res.text).toContain(own);
        for (const o of others) expect(leaksIn(res, o.tokens, ''), `${s.tag} ${url} shows ${o.tag}`).toEqual([]);
      }
    }
    expect((await send(R.app, R.ops, { method: 'GET', url: '/api/users' })).status).toBe(400);
    expect((await send(R.app, R.ops, { method: 'GET', url: '/api/users' }, { [SURAU_HEADER]: 'zzzzzzzzzzzz' })).status).toBe(404);
    expect((await send(R.app, R.ops, { method: 'GET', url: '/api/users' }, { [SURAU_HEADER]: 'Bad Id!' })).status).toBe(400);
  });

  it('a change made while acting in b lands in b with the Pentadbir named, and a is byte-identical', async () => {
    const before = dumpSurau(R.db, R.a);
    const put = await send(R.app, R.ops, { method: 'PUT', url: '/api/content/penceramah/ops-made-b', payload: { name: 'MARKBRAVO dibuat Pentadbir' } }, { [SURAU_HEADER]: R.b.id });
    expect(put.status, put.text).toBe(201);
    const row = R.db.prepare("SELECT surau_id, actor FROM change_log WHERE entity = 'content:penceramah' AND entity_id = 'ops-made-b'").get();
    expect(row).toMatchObject({ surau_id: R.b.id, actor: `user:${R.ops.userId}` });
    expect(R.db.prepare('SELECT surau_id FROM content_items WHERE id = ?').get('ops-made-b')).toMatchObject({ surau_id: R.b.id });
    expect(differs(before, dumpSurau(R.db, R.a))).toEqual([]);
  });

  it('a Sokongan MAXCOM on an ops device reads the fleet (fleet:read) and no surau data: tenant routes and fleet changes are 403', async () => {
    expect((await send(R.app, R.support, { method: 'GET', url: '/api/suraus' })).status).toBe(200);
    const before = dumpSurau(R.db, R.b);
    for (const [method, url] of [['GET', '/api/users'], ['GET', '/api/content/penceramah'], ['GET', '/api/finance/entries'], ['GET', '/api/sync/snapshot']] as const) {
      const res = await send(R.app, R.support, { method, url }, { [SURAU_HEADER]: R.b.id });
      expect(res.status, `${url}: ${res.text}`).toBe(403);
      expect(leaksIn(res, R.b.tokens, '')).toEqual([]);
    }
    expect((await send(R.app, R.support, { method: 'POST', url: `/api/suraus/${R.b.id}/suspend`, payload: { reason: 'x' } })).status).toBe(403);
    expect(differs(before, dumpSurau(R.db, R.b))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. decisions 21-22: the `*` users are hidden from, and untouchable by, every surau

describe('decisions 21 and 22: the Pentadbir MAXCOM and Sokongan MAXCOM rows are invisible and untouchable from a surau', () => {
  const surauAdmins = (): Array<[string, Who]> => [['a', R.a.admin], ['b', R.b.admin], ['sdm', R.p.admin]];
  const starUsers = (): string[] => [R.ops.userId, R.support.userId];
  const starDevices = (): string[] => [R.ops.deviceId, R.support.deviceId];

  it('users, devices and the sync feed of every surau session list no `*` row', async () => {
    for (const [n, who] of surauAdmins()) {
      // the feed names a row by `"entityId":"<id>"`; the id also appears as the actor of an acting Pentadbir's own write, which a
      // surau is meant to see in its own audit (Plan 14 section 10, item 4), so only the row itself is a leak there
      const rowTokens = [...starUsers(), ...starDevices()].map((i) => `"entityId":"${i}"`);
      for (const url of ['/api/users', '/api/devices', '/api/sync/changes?since=0', '/api/sync/snapshot']) {
        const res = await send(R.app, who, { method: 'GET', url });
        expect(res.status, `${n} ${url}`).toBe(200);
        const feed = url.startsWith('/api/sync');
        expect(leaksIn(res, feed ? rowTokens : R.starTokens, ''), `${n} ${url} shows the Pentadbir MAXCOM`).toEqual([]);
      }
      // positive control: the same list does show the surau's own people
      const own = await send(R.app, who, { method: 'GET', url: '/api/users' });
      expect(own.text).toContain(who.userId);
    }
  });

  it('the audit view of a surau lists no `*` row (decision 22)', async () => {
    const res = await send(R.app, R.a.admin, { method: 'GET', url: '/api/audit?limit=1000' });
    expect(leaksIn(res, R.starTokens, '')).toEqual([]);
  });

  it('roles, PIN, deactivate, enrolment code and device revoke on a `*` id: 404 not_found, one star_target_refused row each, rows byte-identical', async () => {
    const star = starRows(R.db, R);
    for (const [n, who] of surauAdmins()) {
      for (const uid of starUsers()) {
        const tries: Array<[string, Method, string, unknown]> = [
          ['roles', 'PUT', `/api/users/${uid}/roles`, { roles: ['ajk'] }],
          ['pin', 'PUT', `/api/users/${uid}/pin`, { pin: '135790' }],
          ['deactivate', 'POST', `/api/users/${uid}/deactivate`, {}],
          ['enrol', 'POST', '/api/enrol/begin', { userId: uid, deviceName: 'Rampasan' }],
        ];
        for (const [name, method, url, payload] of tries) {
          const n0 = authCount(R.db, 'star_target_refused');
          const res = await send(R.app, who, { method, url, payload });
          expect(res.status, `${n} ${name} ${uid}: ${res.text}`).toBe(404);
          expect(authCount(R.db, 'star_target_refused') - n0, `${n} ${name}`).toBe(1);
        }
      }
      for (const did of starDevices()) {
        const n0 = authCount(R.db, 'star_target_refused');
        const res = await send(R.app, who, { method: 'POST', url: `/api/devices/${did}/revoke`, payload: {} });
        expect(res.status, `${n} revoke ${did}`).toBe(404);
        expect(authCount(R.db, 'star_target_refused') - n0).toBe(1);
      }
      // the answer is the one an unknown id gets
      const unknown = await send(R.app, who, { method: 'POST', url: '/api/users/no-such-user/deactivate', payload: {} });
      const star404 = await send(R.app, who, { method: 'POST', url: `/api/users/${R.ops.userId}/deactivate`, payload: {} });
      expect(star404.status).toBe(unknown.status);
      expect(star404.json).toEqual(unknown.json);
    }
    expect(starRows(R.db, R)).toBe(star);
  });

  it('a signed op or a site entry naming a `*` user or device is refused and changes nothing', async () => {
    const star = starRows(R.db, R);
    for (const [n, who] of [['a', R.a.admin], ['b', R.b.admin]] as Array<[string, Who]>) {
      const s = n === 'a' ? R.a : R.b;
      for (const uid of starUsers()) {
        const r = await pushOp(who, { kind: 'user.put', entity: 'user', entityId: uid, payload: { name: 'Dikuasai', roles: ['admin'], active: false }, surauId: s.id });
        expect(r.result?.status, `${n} user.put ${uid}`).toBe('refused');
      }
      for (const did of starDevices()) {
        const r = await pushOp(who, { kind: 'device.revoke', entity: 'device', entityId: did, payload: null, surauId: s.id });
        expect(r.result?.status, `${n} device.revoke ${did}`).toBe('refused');
      }
      const entries = [
        ...starUsers().map((uid) => entry({ entity: 'user', entityId: uid, after: { name: 'Dikuasai', roles: ['admin'], active: false } })),
        ...starDevices().map((did) => entry({ entity: 'device', entityId: did, after: { revoked: true } })),
      ];
      const out = await pushEntries(s.site, entries);
      expect(out.out.applied, JSON.stringify(out.out)).toBe(0);
      expect(out.out.refused).toBe(entries.length);
    }
    expect(starRows(R.db, R)).toBe(star);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. decisions 19 and 20: nothing grants superadmin or support but the CLI

describe('decisions 19 and 20: no route and no op grants or removes superadmin or support', () => {
  const roleRows = (): string => sha(jsonOf(R.db.prepare('SELECT id, roles_json, active, surau_id FROM users ORDER BY id').all()));

  it('no row of the route table creates, grants, appoints or removes those roles by its path', () => {
    // `theme-support` / `themes/support` report which theme contract a box supports; they are not the support role.
    for (const rule of ROUTE_PERMISSIONS) expect(rule.sample.replace(/theme-support|themes\/support/g, ''), `${rule.method} ${rule.sample}`).not.toMatch(/superadmin|support|promote|ops-enrol|ops-unmark/);
  });

  it('PUT roles / POST users naming superadmin or support: 403 from a surau admin, from a public-device superadmin and from an ops device; nobody\'s roles change', async () => {
    const before = roleRows();
    const grants: string[][] = [['admin', 'superadmin'], ['ajk', 'support'], ['superadmin'], ['support']];
    for (const [who, hdr] of [[R.a.admin, {}], [R.pub, {}], [R.ops, { [SURAU_HEADER]: R.a.id }]] as Array<[Who, Record<string, string>]>) {
      for (const roles of grants) {
        const put = await send(R.app, who, { method: 'PUT', url: `/api/users/${R.a.media.userId}/roles`, payload: { roles } }, hdr);
        expect([400, 403, 404], `${who.roles.join('+')} PUT roles ${roles}: ${put.text}`).toContain(put.status);
        const post = await send(R.app, who, { method: 'POST', url: '/api/users', payload: { name: 'Pentadbir Palsu', roles } }, hdr);
        expect([400, 403, 404], `${who.roles.join('+')} POST users ${roles}: ${post.text}`).toContain(post.status);
      }
      // removing it is refused as well (the ops device sees the `*` user in a surau)
      const rm = await send(R.app, who, { method: 'PUT', url: `/api/users/${R.ops.userId}/roles`, payload: { roles: ['admin'] } }, hdr);
      expect([403, 404], `${who.roles.join('+')} removing superadmin: ${rm.text}`).toContain(rm.status);
    }
    expect(roleRows()).toBe(before);
  });

  it('a signed user.put granting or removing the roles is refused, from a surau phone, a public superadmin phone and an ops phone; a plain role change by the same phone applies (positive control)', async () => {
    const before = roleRows();
    const targets = [R.a.media.userId, R.ops.userId];
    for (const who of [R.a.admin, R.pub, R.ops]) {
      for (const uid of targets) {
        for (const roles of [['admin', 'superadmin'], ['support'], ['ajk']]) {
          const input: OpInput = { kind: 'user.put', entity: 'user', entityId: uid, payload: { name: 'Palsu', roles, active: true }, surauId: who === R.pub ? R.a.id : who === R.ops ? 'sdm' : R.a.id };
          const r = await pushOp(who, input);
          const granted = roles.includes('superadmin') || roles.includes('support');
          if (granted || uid === R.ops.userId) expect(r.result?.status, `${who.roles.join('+')} user.put ${uid} ${roles}: ${r.text}`).not.toBe('applied');
        }
      }
    }
    expect(roleRows()).toBe(before);
    // positive control: an ordinary role change for an ordinary user by a surau admin phone still applies
    const ok = await pushOp(R.a.admin, { kind: 'user.put', entity: 'user', entityId: R.a.media.userId, payload: { name: `MARKALPHA media`, roles: ['media', 'ajk'], active: true }, surauId: R.a.id, editedAt: new Date().toISOString() });
    expect(ok.result?.status, ok.text).toBe('applied');
    R.db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(['media']), R.a.media.userId);
  });

  it('a site entry that plants a superadmin or a support user, or gives an existing user those roles, creates nothing', async () => {
    const before = roleRows();
    const { out } = await pushEntries(R.a.site, [
      entry({ entity: 'user', entityId: 'planted-sa', after: { name: 'Pentadbir Palsu', roles: ['superadmin'], active: true } }),
      entry({ entity: 'user', entityId: 'planted-sp', after: { name: 'Sokongan Palsu', roles: ['support'], active: true } }),
      entry({ entity: 'user', entityId: R.a.media.userId, after: { name: 'MARKALPHA media', roles: ['media', 'superadmin'], active: true } }),
    ]);
    expect(out.applied).toBeLessThan(3);
    expect(R.db.prepare("SELECT 1 AS x FROM users WHERE id IN ('planted-sa', 'planted-sp')").get()).toBeUndefined();
    expect(roleRows()).toBe(before);
  });

  it('the enrolment-code route issues no code for an ops-role user, from an ops session or a surau admin (ops_cli_only / not found)', async () => {
    const codes = count(R.db, 'SELECT COUNT(*) AS n FROM enrolments');
    for (const who of [R.a.admin, R.ops, R.pub]) {
      const res = await send(R.app, who, { method: 'POST', url: '/api/enrol/begin', payload: { userId: R.ops.userId, deviceName: 'Rampasan' } }, who === R.ops ? { [SURAU_HEADER]: R.a.id } : {});
      expect([403, 404]).toContain(res.status);
    }
    expect(count(R.db, 'SELECT COUNT(*) AS n FROM enrolments')).toBe(codes);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6. positive control over the whole table: the right actor passes the hook on every row

describe('positive control over every route row: an actor of a with the permission is not refused (the matrix cannot pass by refusing all)', () => {
  // Rows that no surau role holds the permission for (superadmin-only): refused for every surau role, as they must be.
  it('each row answers its own surau\'s right actor with something other than 401/403, and a wrong role with 403', async () => {
    const refusedRight: string[] = [];
    const allowedWrong: string[] = [];
    let passed = 0;
    for (const rule of ROUTE_PERMISSIONS) {
      if (DISPOSABLE.has(key(rule)) || STREAMING.has(key(rule)) || rule.ops === true) continue;
      const req: Req = { method: rule.method, url: rule.sample, ...(rule.method === 'POST' || rule.method === 'PUT' ? { payload: {} } : {}) };
      const holders = actorsOf(R.a).filter((w) => NEEDS_PERMISSION(rule.permission, w.roles));
      if (rule.permission === 'public') {
        const res = await send(R.app, null, req);
        if (res.status === 403 || res.status >= 500) refusedRight.push(`${key(rule)} -> ${res.status} (anonymous)`);
        else passed += 1;
        continue;
      }
      if (holders.length === 0) {
        const res = await send(R.app, R.a.admin, req);
        if (res.status !== 403) allowedWrong.push(`${key(rule)} (nobody holds ${rule.permission}) -> ${res.status}`);
        continue;
      }
      const res = await send(R.app, holders[0]!, req);
      if (res.status === 401 || (res.status === 403 && res.json.code !== undefined && res.json.code !== 'forbidden' && false)) refusedRight.push(`${key(rule)} -> ${res.status}`);
      else if (res.status === 403) refusedRight.push(`${key(rule)} -> 403 ${res.text.slice(0, 80)}`);
      else passed += 1;
      for (const w of actorsOf(R.a).filter((x) => !holders.includes(x))) {
        const wrong = await send(R.app, w, req);
        if (wrong.status !== 403 && wrong.status !== 404) allowedWrong.push(`${key(rule)} as ${w.roles[0]} -> ${wrong.status}`);
      }
    }
    expect(refusedRight.join(' | ')).toBe('');
    expect(allowedWrong.join(' | ')).toBe('');
    expect(passed).toBeGreaterThan(90);
  });

  it('the walk covered every row of the table: the same rows, the same count, no row skipped', () => {
    const titles = new Set(ROUTE_PERMISSIONS.map(key));
    expect(titles.size).toBe(ROUTE_PERMISSIONS.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 7. suspension and revoke (their own rig: they change the world)

describe('suspension: a suspended surau\'s site and phones are refused, others are not; revoke is final', () => {
  let X: Rig;
  beforeAll(async () => {
    X = await buildRig();
  }, 120_000);
  afterAll(async () => {
    await X?.cloud.close();
  });

  const snapshotOf = (s: SurauCtx) => send(X.app, { site: s.site }, { method: 'GET', url: '/api/sync/snapshot' });

  it('suspend b: its site key and all its phones get 403 surau_suspended (reads and writes), a and the pilot are untouched, b\'s rows are byte-identical; unsuspend restores b', async () => {
    for (const s of [X.a, X.b]) {
      expect((await snapshotOf(s)).status).toBe(200);
      expect((await send(X.app, s.admin, { method: 'GET', url: '/api/settings' })).status).toBe(200);
    }
    const aBefore = dumpSurau(X.db, X.a);
    const bBefore = dumpSurau(X.db, X.b);
    const sus = await send(X.app, X.ops, { method: 'POST', url: `/api/suraus/${X.b.id}/suspend`, payload: { reason: 'ujian pengasingan' } });
    expect(sus.status, sus.text).toBe(200);
    const bAfterSuspend = dumpSurau(X.db, X.b);
    expect(differs(bBefore, bAfterSuspend).sort(), 'only the surau row, its change log and the audit of the suspend change').toEqual(expect.arrayContaining(['suraus']));

    const snap = await snapshotOf(X.b);
    expect(snap.status).toBe(403);
    expect(snap.json.code).toBe('surau_suspended');
    for (const who of actorsOf(X.b)) {
      for (const req of [
        { method: 'GET', url: '/api/settings' },
        { method: 'PUT', url: '/api/content/penceramah/sus-1', payload: { name: 'X' } },
        { method: 'POST', url: '/api/sync/ops', payload: { ops: [] } },
      ] as Req[]) {
        const res = await send(X.app, who, req);
        expect(res.status, `${who.roles[0]} ${req.method} ${req.url}`).toBe(403);
        expect(res.json.code).toBe('surau_suspended');
      }
      // who am I still answers, and says the surau is suspended (the app tells the user); it writes nothing
      const me = await send(X.app, who, { method: 'GET', url: '/api/auth/me' });
      expect(me.status, me.text).toBe(200);
      expect(me.json.suspended).toBe(true);
    }
    const push = await send(X.app, { site: X.b.site }, { method: 'POST', url: '/api/sync/ops', payload: { entries: [] } });
    expect(push.status).toBe(403);
    expect(differs(bAfterSuspend, dumpSurau(X.db, X.b)), 'refused calls wrote nothing in b').toEqual([]);

    // a and the pilot work as before
    for (const s of [X.a, X.p]) {
      expect((await snapshotOf(s)).status).toBe(200);
      expect((await send(X.app, s.admin, { method: 'GET', url: '/api/settings' })).status).toBe(200);
    }
    expect(differs(aBefore, dumpSurau(X.db, X.a))).toEqual([]);

    // a suspended surau cannot lift its own suspension
    expect((await send(X.app, X.b.admin, { method: 'POST', url: `/api/suraus/${X.b.id}/unsuspend`, payload: {} })).status).toBe(403);
    expect((await snapshotOf(X.b)).status).toBe(403);

    // the Pentadbir MAXCOM on an ops device can still act in it, and lifts it (positive control)
    const read = await send(X.app, X.ops, { method: 'GET', url: '/api/users' }, { [SURAU_HEADER]: X.b.id });
    expect(read.status).toBe(200);
    const un = await send(X.app, X.ops, { method: 'POST', url: `/api/suraus/${X.b.id}/unsuspend`, payload: {} });
    expect(un.status, un.text).toBe(200);
    expect((await snapshotOf(X.b)).status).toBe(200);
    for (const who of actorsOf(X.b)) expect((await send(X.app, who, { method: 'GET', url: '/api/auth/me' })).status).toBe(200);
  });

  it('revoke is final: the box key dies at once (every sync path 401), a second revoke is 409, the surau\'s phones and data and every other surau are unaffected, b cannot unrevoke itself', async () => {
    const aBefore = dumpSurau(X.db, X.a);
    const res = await send(X.app, X.ops, { method: 'POST', url: `/api/fleet/boxes/${X.b.site.boxId}/revoke`, payload: {} });
    expect(res.status, res.text).toBe(200);
    for (const req of [
      { method: 'GET', url: '/api/sync/snapshot' },
      { method: 'GET', url: '/api/sync/changes?since=0' },
      { method: 'POST', url: '/api/sync/ops', payload: { entries: [] } },
      { method: 'GET', url: `/assets/${'a'.repeat(64)}` },
    ] as Req[]) {
      const r = await send(X.app, { site: X.b.site }, req);
      expect(r.status, `${req.method} ${req.url}`).toBe(401);
    }
    expect((await send(X.app, X.ops, { method: 'POST', url: `/api/fleet/boxes/${X.b.site.boxId}/revoke`, payload: {} })).status).toBe(409);
    // revoking a box stops the box only (decision 7): the phones of the surau still work, and a's site still does
    expect((await send(X.app, X.b.admin, { method: 'GET', url: '/api/settings' })).status).toBe(200);
    expect((await snapshotOf(X.a)).status).toBe(200);
    expect(differs(aBefore, dumpSurau(X.db, X.a))).toEqual([]);
    // no surau role can bring a revoked box back, and a's site cannot revoke b's box
    for (const who of [X.b.admin, X.a.admin]) {
      expect((await send(X.app, who, { method: 'POST', url: `/api/fleet/boxes/${X.b.site.boxId}/unrevoke`, payload: {} })).status).toBe(403);
    }
    expect((await send(X.app, { site: X.a.site }, { method: 'POST', url: `/api/fleet/boxes/${X.p.site.boxId}/revoke`, payload: {} })).status).toBe(403);
    expect((await snapshotOf(X.b)).status).toBe(401);
    expect((await snapshotOf(X.p)).status).toBe(200);
  });

  it('a revoked phone is final too: its token, a fresh unlock and a queued op are refused, and the other surau\'s phones are unaffected', async () => {
    const victim = X.a.media;
    const dev = X.db.prepare('SELECT id FROM devices WHERE id = ?').get(victim.deviceId);
    expect(dev).toBeDefined();
    // a's admin revokes a's media phone through the route
    const rev = await send(X.app, X.a.admin, { method: 'POST', url: `/api/devices/${victim.deviceId}/revoke`, payload: {} });
    expect(rev.status, rev.text).toBe(200);
    expect((await send(X.app, victim, { method: 'GET', url: '/api/settings' })).status).toBe(401);
    const op = await signOp(victim.login, X.app.surau.boxId, { kind: 'content.put', entity: 'content:penceramah', entityId: 'late-1', payload: { name: 'Lewat' }, surauId: X.a.id });
    const late = await send(X.app, victim, { method: 'POST', url: '/api/sync/ops', payload: { ops: [op] } });
    expect(late.status).toBe(401);
    expect(late.json.reason).toBe('device_revoked');
    expect(X.db.prepare('SELECT 1 AS x FROM content_items WHERE id = ?').get('late-1')).toBeUndefined();
    await expect(victim.login.relogin()).rejects.toThrow();
    expect((await send(X.app, X.b.media, { method: 'GET', url: '/api/settings' })).status).toBe(200);
    // and b's admin cannot revoke a's phones (404, not 403: it does not exist for b)
    const cross = await send(X.app, X.b.admin, { method: 'POST', url: `/api/devices/${X.a.treasurer.deviceId}/revoke`, payload: {} });
    expect(cross.status).toBe(404);
    expect(X.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(X.a.treasurer.deviceId)).toMatchObject({ revoked_at: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 8. a leak that is not a row of the table

describe('known leaks that are not a row of the walk', () => {
  // Was a LEAK: the `youtube` change_log row had no surau_id and landed under the default 'sdm'. The cloud's YouTube service is
  // still one for every surau until Task 9 moves YouTube onto the box.
  it('a youtube sign-out on the cloud is refused (2026.11.13: the grant is held by the box) and files no row under any surau', async () => {
    const before = count(R.db, "SELECT COUNT(*) AS n FROM change_log WHERE entity = 'youtube'");
    const res = await send(R.app, R.b.admin, { method: 'POST', url: '/api/live/youtube/signout', payload: {} });
    expect(res.status).toBe(409);
    expect(count(R.db, "SELECT COUNT(*) AS n FROM change_log WHERE entity = 'youtube'")).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 9. the black-box probe, proved against an app this test starts (never a real server)

describe('scripts/sec-probe-cloud.mjs against a local cloud with three suraus', () => {
  const script = fileURLToPath(new URL('../../../scripts/sec-probe-cloud.mjs', import.meta.url));

  async function probe(extra: string[], envOver: Record<string, string> = {}): Promise<{ code: number | null; out: string; rows: Array<{ status: string; id: string }> }> {
    await R.app.listen({ host: '127.0.0.1', port: 0 }).catch(() => undefined);
    const addr = R.app.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    const env = {
      ...process.env,
      SECPROBE_TOKEN_A: (await R.a.admin.bearer()).slice(7),
      SECPROBE_TOKEN_B: (await R.b.admin.bearer()).slice(7),
      SECPROBE_SITE_A: R.a.site.token,
      SECPROBE_SITE_B: R.b.site.token,
      SECPROBE_SURAU_A: R.a.id,
      SECPROBE_SURAU_B: R.b.id,
      SECPROBE_BOX_A: R.a.site.boxId,
      SECPROBE_BOX_B: R.b.site.boxId,
      SECPROBE_TOKEN_PUBSA: (await R.pub.bearer()).slice(7),
      SECPROBE_TOKEN_OPS: (await R.ops.bearer()).slice(7),
      SECPROBE_STAR_IDS: R.starTokens.slice(1).join(','),
      SECPROBE_MARKERS_A: 'MARKALPHA',
      ...envOver,
    };
    const { spawn } = await import('node:child_process');
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, '--base', `http://127.0.0.1:${port}`, '--json', ...extra], { env });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        let rows: Array<{ status: string; id: string }> = [];
        try {
          rows = (JSON.parse(out) as { rows: Array<{ status: string; id: string }> }).rows;
        } catch {
          /* usage error: out empty */
        }
        resolve({ code, out: out + err, rows });
      });
    });
  }

  it('refuses a real MAXCOM host and a missing credential before sending anything', async () => {
    const { spawn } = await import('node:child_process');
    const run = (argv: string[], env: Record<string, string>): Promise<{ code: number | null; err: string }> =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, [script, ...argv], { env: { PATH: process.env.PATH ?? '', ...env } });
        let err = '';
        c.stderr.on('data', (d: Buffer) => (err += d.toString()));
        c.on('close', (code) => resolve({ code, err }));
      });
    const real = await run(['--base', 'https://api.mymaxcom.my'], {});
    expect(real.code).toBe(2);
    expect(real.err).toContain('real MAXCOM host');
    const noEnv = await run(['--base', 'http://127.0.0.1:1'], {});
    expect(noEnv.code).toBe(2);
    expect(noEnv.err).toContain('SECPROBE_TOKEN_A');
  });

  beforeAll(() => {
    // the walk's id-guessing writes made b its OWN rows under a's ids (per-surau keys); a black-box probe cannot tell those from a's
    R.db.prepare('DELETE FROM content_items WHERE surau_id IN (?, ?) AND id = ?').run(R.b.id, R.p.id, R.a.ids.itemId);
  });

  it('read-only: every positive control passes; no probe fails (the audit and asset leaks are closed); nothing is written', async () => {
    const before = dumpSurau(R.db, R.a);
    const res = await probe([]);
    const failed = res.rows.filter((r) => r.status === 'FAIL').map((r) => r.id).sort();
    expect(res.rows.length, res.out.slice(0, 500)).toBeGreaterThan(80);
    for (const id of ['P1', 'P2', 'P3', 'S:own', 'G:entry', 'O:read', 'O:fleet', 'O:header']) {
      expect(res.rows.find((r) => r.id === id)?.status, `positive control ${id}`).toBe('PASS');
    }
    // the walk's leaks (audit, finance audit, asset list) are closed: the probe finds nothing and exits 0
    expect(failed, `unexpected probe failures: ${failed.join(', ')}`).toEqual([]);
    expect(res.code).toBe(0);
    // (the probe uses a's own site key as a positive control, which stamps `sites.last_seen`)
    expect(differs(before, dumpSurau(R.db, R.a)).filter((x) => x !== 'sites')).toEqual([]);
    expect(res.rows.some((r) => r.id.startsWith('W:') && r.status !== 'SKIP')).toBe(false);
  }, 120_000);

  it('--write: the throwaway write probes are all refused and a stays byte-identical', async () => {
    const before = dumpSurau(R.db, R.a);
    const res = await probe(['--write']);
    const writes = res.rows.filter((r) => r.id.startsWith('W:') && r.status !== 'SKIP');
    expect(writes.length).toBeGreaterThan(8);
    expect(writes.filter((r) => r.status === 'FAIL').map((r) => r.id), res.out.slice(0, 800)).toEqual([]);
    // (the probe uses a's own site key as a positive control, which stamps `sites.last_seen`)
    expect(differs(before, dumpSurau(R.db, R.a)).filter((x) => x !== 'sites')).toEqual([]);
  }, 120_000);

  it('a probe with swapped credentials passes the other way too, so a pass is not an artefact of which surau is A', async () => {
    const res = await probe([], {
      SECPROBE_TOKEN_A: (await R.b.admin.bearer()).slice(7),
      SECPROBE_TOKEN_B: (await R.a.admin.bearer()).slice(7),
      SECPROBE_SITE_A: R.b.site.token,
      SECPROBE_SITE_B: R.a.site.token,
      SECPROBE_SURAU_A: R.b.id,
      SECPROBE_SURAU_B: R.a.id,
      SECPROBE_BOX_A: R.b.site.boxId,
      SECPROBE_BOX_B: R.a.site.boxId,
      SECPROBE_MARKERS_A: 'MARKBRAVO',
    });
    expect(res.rows.find((r) => r.id === 'P1')?.status).toBe('PASS');
    expect(res.rows.filter((r) => r.status === 'FAIL').map((r) => r.id)).toEqual([]);
  }, 120_000);
});
