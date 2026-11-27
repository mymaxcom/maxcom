import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { assignNewNo } from '../../src/auth/ids.ts';
import { sha256hex } from '../../src/auth/crypto.ts';
import { boxId as boxIdOf } from '../../src/auth/secrets.ts';
import { createUserIn } from '../../src/auth/users.ts';
import { openDb } from '../../src/db.ts';
import { carryOf, commitAdopt, planAdopt, runAdopt, takeRecoveryNote } from '../../src/link/adopt.ts';
import type { AdoptCarry, AdoptTicket } from '../../src/link/adopt.ts';
import { applyLinkJournalAtBoot } from '../../src/link/setAside.ts';
import type { BootResult } from '../../src/link/setAside.ts';
import { hashFile, stageDirOf } from '../../src/link/storeMove.ts';
import type { MoveFile } from '../../src/link/storeMove.ts';
import { CameraStore } from '../../src/live/camera.ts';
import { TokenStore } from '../../src/live/youtube/tokenStore.ts';
import type { YoutubeTokens } from '../../src/live/youtube/tokenStore.ts';
import { issueRecoveryCode, newRecoveryCode } from '../../src/setup/codes.ts';
import { loadIdentity } from '../../src/setup/identity.ts';

/**
 * Two real data folders for the adopt tests (multi-box cases X and N-X): G, the giving box, whose store is staged on M
 * with `VACUUM INTO`, and M, the receiving box, whose own store is carried over. Everything is real `node:sqlite` rows
 * and real files. `buildRig` leaves M exactly as a commit that G accepted leaves it: the sealed carry file, the adopt
 * journal at `planned` and the staged store. `cloneM` makes a byte copy of that M so one prepared start can be run
 * many times (a power cut at every step).
 */

export type Row = Record<string, unknown>;
export const LINK = 'c1'.repeat(16);
export const NOW = new Date('2026-11-23T10:00:00.000Z');
const FAR = '2126-01-01T00:00:00.000Z';

const dirs: string[] = [];
export function tempDir(prefix = 'maxcom-adopt-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
export function removeTempDirs(): void {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // a temp folder that is still held is left to the system
    }
  }
}

export const rowsOf = (db: DatabaseSync, sql: string, ...p: (string | number | null)[]): Row[] => db.prepare(sql).all(...p) as Row[];
export const oneOf = (db: DatabaseSync, sql: string, ...p: (string | number | null)[]): Row | undefined => db.prepare(sql).get(...p) as Row | undefined;
export const count = (db: DatabaseSync, table: string): number => Number(oneOf(db, `SELECT COUNT(*) AS n FROM ${table}`)!.n);

const put = (dir: string, rel: string, data: Buffer | string): void => {
  const abs = join(dir, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
};

/** Every row of a table as a sorted list of canonical JSON lines (column order never matters). */
export function dumpTable(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`SELECT * FROM ${table}`).all() as Row[]).map((r) => JSON.stringify(r, Object.keys(r).sort())).sort();
}
export function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[]).map((r) => String(r.name));
}
export function dumpDb(db: DatabaseSync): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of tableNames(db)) out[t] = dumpTable(db, t);
  return out;
}

export interface RigOptions {
  /** `X`: M is a set-up box (default). `N-X`: M was never set up (an empty new store, no people). */
  case?: 'X' | 'N-X';
  /** M was linked to the cloud before (the cloud keys and the reset mark). */
  mLinked?: boolean;
  /** Extra change_log rows on each side (so either head can be the higher one). */
  gLog?: number;
  mLog?: number;
  /** G's sign-ins that cross sealed (the adopt keeps them). */
  /** X: the master's PIN-proof admin is the person who is also on G (same phone), so the follower row is made for the merged person. */
  ownerIsMerged?: boolean;
  youtube?: YoutubeTokens;
  camera?: { url: string; username?: string; password?: string };
}

export interface Rig {
  case: 'X' | 'N-X';
  now: Date;
  linkId: string;
  /** M's data folder, prepared for the start (the template: never run in place, always `cloneM`). */
  mDir: string;
  mBoxId: string;
  gBoxId: string;
  recovery: { code: string; hash: string };
  /** G's old recovery code (it must die). */
  gCode: string;
  ids: {
    gAdmin: string; gMedia: string; gAjk: string; gStar: string;
    mAdmin: string; mCik: string; mOwner: string; mGone: string; mStar: string;
    gAdminDev: string; gMediaDev: string; gTv: string;
    mAdminDev: string; mCikDev: string; mOwnerDev: string; mRevokedDev: string; mTvDev: string;
  };
  tickets: AdoptTicket[];
  followerDeviceId: string;
  /** What was planned (the carry as written). */
  carry: AdoptCarry;
  /** G's tables before the adopt (rows as canonical JSON), and M's. */
  gBefore: Record<string, string[]>;
  mBefore: Record<string, string[]>;
  gHead: number;
  mHead: number;
  gMedia: string[];
  /** The wire form of what G sent sealed, when it had a sign-in. */
  files: MoveFile[];
}

const b64 = (s: string): string => createHash('sha256').update(s).digest('base64url');
const jwkOf = (id: string): string => JSON.stringify({ kty: 'EC', crv: 'P-256', x: b64(`x${id}`), y: b64(`y${id}`) });

function addDevice(db: DatabaseSync, d: { id: string; user: string; name: string; platform: string; box: string; revoked?: boolean; jwk?: string | null }): void {
  db.prepare('INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at, revoked_at, surau_id, box_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(d.id, d.user, d.name, d.platform, d.jwk === undefined ? jwkOf(d.id) : d.jwk, '2026-10-01T08:00:00.000Z', d.revoked === true ? '2026-10-20T08:00:00.000Z' : null, 'sdm', d.box);
  assignNewNo(db, 'device', d.id, 'sdm');
}

function addLog(db: DatabaseSync, n: number, tag: string): void {
  for (let i = 0; i < n; i++) db.prepare("INSERT INTO change_log (at, actor, entity, entity_id) VALUES ('2026-11-01T00:00:00.000Z', ?, 'settings', ?)").run(`test:${tag}`, `${tag}-${i}`);
}

const setting = (db: DatabaseSync, feature: string, json: unknown): void => {
  db.prepare("INSERT INTO settings (surau_id, feature, json, updated_at, updated_by) VALUES ('sdm', ?, ?, '2026-11-01T00:00:00.000Z', 'test') ON CONFLICT(surau_id, feature) DO UPDATE SET json = excluded.json")
    .run(feature, JSON.stringify(json));
};
const meta = (db: DatabaseSync, key: string, value: string): void => {
  db.prepare("INSERT INTO meta (surau_id, key, value) VALUES ('sdm', ?, ?) ON CONFLICT(surau_id, key) DO UPDATE SET value = excluded.value").run(key, value);
};
const sync = (db: DatabaseSync, key: string, value: string): void => {
  db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
};

export const G_MEDIA_FILES: { rel: string; data: Buffer }[] = [
  { rel: 'assets/poster-1.jpg', data: Buffer.from('poster one: bytes of a picture') },
  { rel: 'assets/sub/video-1.mp4', data: Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) % 251)) },
  { rel: 'finance/photos/receipt-1.jpg', data: Buffer.from('receipt bytes') },
  { rel: 'themes/hijau/theme.json', data: Buffer.from('{"name":"Hijau"}') },
];

/** The giving box: a surau with people, phones, credentials, content, finance and a cloud link, in a real folder. */
function seedG(dir: string, o: RigOptions): { ids: Pick<Rig['ids'], 'gAdmin' | 'gMedia' | 'gAjk' | 'gStar' | 'gAdminDev' | 'gMediaDev' | 'gTv'>; gCode: string; db: DatabaseSync } {
  const db = openDb(join(dir, 'surau.db'));
  const gBox = boxIdOf(dir);
  const mk = (name: string, roles: ('admin' | 'media' | 'ajk' | 'support')[], phone: string | null) =>
    createUserIn(db, { name, roles, phone }, 'test', 'sdm').id;
  const gAdmin = mk('Ahmad Salleh', ['admin'], '012-000 0001');
  const gMedia = mk('Bilal Hamid', ['media'], '012-000 0002');
  const gAjk = mk('Cik Aminah', ['ajk'], '012-000 0003');
  const gStar = mk('Sokongan Ruang Utama', ['support'], null);
  db.prepare("UPDATE users SET pin_hash = 'g-pin-' || id, pin_fail_count = 3, pin_locked_until = '2099-01-01T00:00:00.000Z', lock_round = 2").run();
  const gAdminDev = 'g-dev-admin';
  const gMediaDev = 'g-dev-media';
  const gTv = 'g-dev-tv';
  addDevice(db, { id: gAdminDev, user: gAdmin, name: 'Telefon Ahmad', platform: 'android', box: gBox });
  addDevice(db, { id: gMediaDev, user: gMedia, name: 'Telefon Bilal', platform: 'android', box: gBox });
  addDevice(db, { id: gTv, user: gAdmin, name: 'TV Dewan', platform: 'kiosk', box: gBox, jwk: null });
  db.prepare("INSERT INTO sessions (id, token_hash, device_id, user_id, created_at, expires_at, last_used_at) VALUES ('g-s1', ?, ?, ?, 'x', '2126-01-01T00:00:00.000Z', 'x')").run(sha256hex('g-session-token'), gMediaDev, gMedia);
  db.prepare("INSERT INTO challenges (nonce, device_id, expires_at) VALUES ('g-nonce-1', ?, '2126-01-01T00:00:00.000Z')").run(gMediaDev);
  db.prepare("INSERT INTO box_codes (nonce_hash, type, created_at, expires_at) VALUES (?, 'join', 'x', '2126-01-01T00:00:00.000Z')").run(sha256hex('g-box-code'));
  db.prepare("INSERT INTO kiosk_pairings (code_hash, poll_token_hash, created_at, expires_at) VALUES (?, ?, 'x', '2126-01-01T00:00:00.000Z')").run(sha256hex('g-pair'), sha256hex('g-poll'));
  db.prepare("INSERT INTO kiosk_cookies (token_hash, device_id, created_at, expires_at) VALUES (?, ?, 'x', '2126-01-01T00:00:00.000Z')").run(sha256hex('g-kiosk-cookie'), gTv);
  db.prepare("INSERT INTO enrolments (code_hash, user_id, device_name, expires_at, created_by) VALUES (?, ?, 'Telefon baru', '2126-01-01T00:00:00.000Z', 'test')").run(sha256hex('GENROLCODE'), gAjk);
  const gCode = issueRecoveryCode(db);
  // content, finance, prayer rows, settings
  db.prepare("INSERT INTO content_items (surau_id, kind, id, json, updated_at, updated_by) VALUES ('sdm', 'announcements', 'a-1', ?, '2026-11-01T00:00:00.000Z', ?)").run('{"title":"Kuliah Subuh"}', `user:${gAdmin}`);
  db.prepare("INSERT INTO content_items (surau_id, kind, id, json, updated_at, updated_by) VALUES ('sdm', 'penceramah', 'p-1', ?, '2026-11-01T00:00:00.000Z', ?)").run('{"name":"Ustaz Zaki"}', gMedia);
  db.prepare(`INSERT INTO finance_funds (id, name, updated_at, updated_by, rev, edited_at) VALUES ('fund-1', 'Tabung Am', '2026-11-01T00:00:00.000Z', '${gAdmin}', 1, '2026-11-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO finance_entries (id, kind, entry_date, fund_id, amount_sen, created_by, edited_at, received_at, rev) VALUES ('fe-1', 'in', '2026-11-02', 'fund-1', 5000, '${gAdmin}', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 1)`).run();
  db.prepare(`INSERT INTO prayer_corrections (date, prayer, time, reason, actor, created_at) VALUES ('2026-11-03', 'subuh', '05:51', 'semakan', 'user:${gMedia}', '2026-11-03T00:00:00.000Z')`).run();
  db.prepare("INSERT INTO prayer_days (zone, date, json) VALUES ('WLY01', '2026-11-03', '{}')").run();
  setting(db, 'surauInfo', { name: 'Surau Al-Hidayah' });
  db.prepare("UPDATE settings SET updated_by = ? WHERE feature = 'surauInfo'").run(gAdmin);
  db.prepare('UPDATE users SET created_by = ? WHERE id = ?').run(gAdmin, gMedia);
  db.prepare("INSERT INTO auth_log (at, event, user_id, ok) VALUES ('2026-11-05T00:00:00.000Z', 'unlock', ?, 1)").run(gMedia);
  db.prepare("INSERT INTO change_log (at, actor, entity, entity_id) VALUES ('2026-11-05T00:00:00.000Z', ?, 'content', 'a-1')").run(`user:${gAdmin}`);
  setting(db, 'tvProfiles', { tvs: { self: { name: 'Dewan Utama', lang: 'ms' }, 'g-old-tv': { name: 'TV Lama' } } });
  meta(db, 'box_name', 'Dewan Utama');
  meta(db, 'box_name_basis', 'manual');
  meta(db, 'surau_id', 'g-setup-id');
  meta(db, 'prayer_official_feed_backfill', 'done');
  meta(db, 'jakimZones.checked', '2026-11-01');
  for (const [k, v] of Object.entries({
    linked: '1', cloud_url: 'https://cloud.example.test', last_pull_seq: '999', last_push_at: 'x', pending_out: '3', refused_total: '2', site_role: 'primary',
    peer_token: 'ptok', parked_token: 'park', 'theme_support_a': '1', people_resync: '1', ids_push: '1', device_seen_x: '1', 'photo_up/abc': '1',
    'dev_revoked/abc': '1', camera_hash: 'c', youtube_state: 'y', autolink_try: '1', link_history: '1',
    log_floor: '2', clean_posters: 'keep-1', poster_stretch_keep: '1', 'ayat_daily_anchor:2026-11-01': 'anchor',
  })) sync(db, k, v);
  addLog(db, o.gLog ?? 20, 'g');
  return { ids: { gAdmin, gMedia, gAjk, gStar, gAdminDev, gMediaDev, gTv }, gCode, db };
}

/** The receiving box: its own people, phones, TV, name and (optionally) cloud link; or an empty store (N-X). */
function seedM(dir: string, o: RigOptions): { ids: Pick<Rig['ids'], 'mAdmin' | 'mCik' | 'mOwner' | 'mGone' | 'mStar' | 'mAdminDev' | 'mCikDev' | 'mOwnerDev' | 'mRevokedDev' | 'mTvDev'>; db: DatabaseSync } {
  const db = openDb(join(dir, 'surau.db'));
  const none = { mAdmin: '', mCik: '', mOwner: '', mGone: '', mStar: '', mAdminDev: '', mCikDev: '', mOwnerDev: '', mRevokedDev: '', mTvDev: '' };
  db.prepare("INSERT INTO link_sessions (id, kind, role, step, answers_rev, started_at, expires_at) VALUES (?, 'link', 'show', 'agreed', 2, '2026-11-23T09:00:00.000Z', '2026-11-23T11:00:00.000Z')").run(LINK);
  if (o.case === 'N-X') return { ids: none, db };
  const mBox = boxIdOf(dir);
  const mk = (name: string, roles: ('admin' | 'media' | 'ajk' | 'support')[], phone: string | null) =>
    createUserIn(db, { name, roles, phone }, 'test', 'sdm').id;
  // the same phone as G's Ahmad: ONE person after the adopt
  const mAdmin = mk('Ahmad (Ruang Muslimat)', ['media'], '012-000 0001');
  const mCik = mk('Che Mariam', ['ajk'], '012-000 0009');
  const mOwner = mk('Ustaz Zakaria', ['admin'], '012-000 0010');
  const mGone = mk('Pak Din', ['ajk'], '012-000 0011');
  const mStar = mk('Sokongan MAXCOM M', ['support'], null);
  db.prepare("UPDATE users SET pin_hash = 'm-pin-' || id").run();
  db.prepare("UPDATE users SET active = 0, deleted_at = '2026-11-10T00:00:00.000Z', deleted_by = 'test' WHERE id = ?").run(mGone);
  const mAdminDev = 'm-dev-admin';
  const mCikDev = 'm-dev-cik';
  const mOwnerDev = 'm-dev-owner';
  const mRevokedDev = 'm-dev-revoked';
  const mTvDev = 'm-dev-tv';
  addDevice(db, { id: mAdminDev, user: mAdmin, name: 'Telefon Ahmad M', platform: 'android', box: mBox });
  addDevice(db, { id: mCikDev, user: mCik, name: 'Telefon Mariam', platform: 'android', box: mBox });
  addDevice(db, { id: mOwnerDev, user: mOwner, name: 'Telefon Ustaz', platform: 'android', box: mBox });
  addDevice(db, { id: mRevokedDev, user: mCik, name: 'Telefon lama', platform: 'android', box: mBox, revoked: true });
  addDevice(db, { id: mTvDev, user: mOwner, name: 'TV Ruang Muslimat', platform: 'kiosk', box: mBox, jwk: null });
  addDevice(db, { id: 'm-dev-gone', user: mGone, name: 'Telefon Pak Din', platform: 'android', box: mBox });
  db.prepare("INSERT INTO kiosk_cookies (token_hash, device_id, created_at, expires_at) VALUES (?, ?, 'x', '2126-01-01T00:00:00.000Z')").run(sha256hex('m-kiosk-cookie'), mTvDev);
  db.prepare("INSERT INTO sessions (id, token_hash, device_id, user_id, created_at, expires_at, last_used_at) VALUES ('m-s1', ?, ?, ?, 'x', '2126-01-01T00:00:00.000Z', 'x')").run(sha256hex('m-session-token'), mOwnerDev, mOwner);
  db.prepare("INSERT INTO enrolments (code_hash, user_id, device_name, expires_at, created_by) VALUES (?, ?, 'Telefon M', '2126-01-01T00:00:00.000Z', 'test')").run(sha256hex('MENROLCODE'), mCik);
  setting(db, 'tvProfiles', { tvs: { self: { name: 'TV Ruang Muslimat', lang: 'en' }, [mTvDev]: { name: 'TV Muslimat dua' }, 'm-orphan': { name: 'TV hilang' } } });
  setting(db, 'surauInfo', { name: 'Surau M lama' });
  db.prepare("INSERT INTO content_items (surau_id, kind, id, json, updated_at, updated_by) VALUES ('sdm', 'announcements', 'm-a-1', ?, '2026-11-01T00:00:00.000Z', 'test')").run('{"title":"Hanya M"}');
  meta(db, 'box_name', 'Ruang Muslimat');
  meta(db, 'box_name_basis', 'manual');
  meta(db, 'surau_id', 'm-setup-id');
  sync(db, 'clean_m', 'm-only');
  if (o.mLinked === true) {
    sync(db, 'linked', '1');
    sync(db, 'cloud_url', 'https://cloud.example.test/m');
    sync(db, 'link_history', '1');
    sync(db, 'last_pull_seq', '555');
  }
  addLog(db, o.mLog ?? 60, 'm');
  put(dir, 'assets/mine.jpg', 'm-picture');
  put(dir, 'secret/sync.key', 'M-cloud-key-bytes');
  put(dir, 'secret/sync.claim', 'M-claim');
  return { ids: { mAdmin, mCik, mOwner, mGone, mStar, mAdminDev, mCikDev, mOwnerDev, mRevokedDev, mTvDev }, db };
}

export async function buildRig(o: RigOptions = {}): Promise<Rig> {
  const kase = o.case ?? 'X';
  const gDir = tempDir('maxcom-adopt-g-');
  const mDir = tempDir('maxcom-adopt-m-');
  const gBoxId = boxIdOf(gDir);
  const mBoxId = boxIdOf(mDir);
  const g = seedG(gDir, o);
  const m = seedM(mDir, { ...o, case: kase });
  const gHead = Number(oneOf(g.db, 'SELECT MAX(id) AS n FROM change_log')!.n);
  const mHead = Number(oneOf(m.db, 'SELECT MAX(id) AS n FROM change_log')?.n ?? 0);
  const gBefore = dumpDb(g.db);

  // G's youtube sign-in and camera, sealed under G's own key (the real routes seal them to M's key; the adopt re-seals)
  for (const f of G_MEDIA_FILES) put(gDir, f.rel, f.data);
  put(gDir, 'secret/sync.key', 'G-cloud-key-bytes');

  // the stage on M: the received copy and the media (what a finished pull leaves)
  const stage = stageDirOf(mDir, LINK);
  mkdirSync(stage, { recursive: true });
  g.db.prepare('VACUUM INTO ?').run(join(stage, 'surau.db'));
  for (const f of G_MEDIA_FILES) put(stage, f.rel, f.data);
  g.db.close();
  const paths = ['surau.db', ...G_MEDIA_FILES.map((f) => f.rel)];
  const files: MoveFile[] = [];
  for (const p of paths) files.push({ path: p, ...(await hashFile(join(stage, ...p.split('/')))) });

  const mBefore = dumpDb(m.db);
  const recovery = newRecoveryCode();
  const identity = loadIdentity(mDir);
  const followerDeviceId = 'follower-tv-1';
  const owner = kase === 'X' ? (o.ownerIsMerged === true ? m.ids.mAdmin : m.ids.mOwner) : g.ids.gAdmin;
  const exp = new Date(NOW.getTime() + 30 * 24 * 3600_000).toISOString();
  const tickets: AdoptTicket[] = [
    { userId: g.ids.gMedia, codeHash: sha256hex('TICKETMEDIA'), deviceName: 'Telefon dari Dewan Utama', expiresAt: exp },
    { userId: g.ids.gAjk, codeHash: sha256hex('TICKETAJK'), deviceName: 'Telefon dari Dewan Utama', expiresAt: exp },
  ];
  if (kase === 'N-X') tickets.push({ userId: g.ids.gAdmin, codeHash: sha256hex('TICKETADMIN'), deviceName: 'Telefon dari Dewan Utama', expiresAt: new Date(NOW.getTime() + 30 * 60_000).toISOString() });
  const carry: AdoptCarry = {
    v: 1, linkId: LINK, case: kase, boxId: mBoxId, ...carryOf(m.db, NOW, LINK),
    follower: {
      deviceId: followerDeviceId, tokenHash: sha256hex('follower-token'), tokenExpiresAt: FAR, owner, boxId: gBoxId, keyFp: 'fp-giver',
      pub: { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) }, name: 'Dewan Utama', addresses: ['https://10.168.50.12:8443'], release: '2026.11.15', linkedAt: NOW.toISOString(),
    },
    tickets, recovery, files,
    ...(o.youtube !== undefined ? { youtube: o.youtube } : {}),
    ...(o.camera !== undefined ? { camera: { url: o.camera.url, ...(o.camera.username !== undefined ? { username: o.camera.username } : {}), hasPassword: o.camera.password !== undefined } } : {}),
  };
  planAdopt(mDir, identity, carry);
  m.db.close();
  commitAdopt(mDir, LINK, NOW);
  return {
    case: kase, now: NOW, linkId: LINK, mDir, mBoxId, gBoxId, recovery, gCode: g.gCode,
    ids: { ...g.ids, ...m.ids }, tickets, followerDeviceId, carry, gBefore, mBefore, gHead, mHead,
    gMedia: paths.slice(1), files,
  };
}

/** A byte copy of the prepared M (identity, journal, carry file, stage, old store) in a new folder. */
export function cloneM(rig: Rig): string {
  const d = tempDir('maxcom-adopt-run-');
  cpSync(rig.mDir, d, { recursive: true });
  return d;
}

/** The start-up step of `main.ts`: the journal, with the adopt runner bound to this box's id and a fixed clock. */
export function boot(dir: string, rig: Rig, afterStep?: (n: string) => void): BootResult {
  return applyLinkJournalAtBoot(dir, {
    adopt: (d, j, h) => runAdopt(d, j, h, { boxId: () => boxIdOf(d), now: () => rig.now }),
    ...(afterStep !== undefined ? { afterStep } : {}),
  });
}

const walk = (root: string): string[] => {
  const out: string[] = [];
  const go = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) go(p);
      else out.push(relative(root, p).split('\\').join('/'));
    }
  };
  if (existsSync(root)) go(root);
  return out.sort();
};
export const filesOf = walk;

/** Files whose bytes change at every write (sealed with a fresh nonce): compared by what they open to instead. */
const SEALED_FILES = new Set(['secret/youtube-token.json', 'secret/live-camera.json', 'secret/link-recovery.json']);
const LIVE_DB = new Set(['surau.db', 'surau.db-wal', 'surau.db-shm']);

export interface EndState {
  db: Record<string, string[]>;
  files: Record<string, string>;
  youtube: YoutubeTokens | null;
  camera: unknown;
  recovery: string | null;
}

/** Everything a person could see of a store at rest: all rows, all files (by hash), the sealed sign-ins opened. */
export function endState(dir: string, rig: Rig): EndState {
  const db = openDb(join(dir, 'surau.db'));
  let dump: Record<string, string[]>;
  try {
    dump = dumpDb(db);
    // person ids of G are new at every run: name them instead, so a killed run and a clean run compare
    const names = (db.prepare('SELECT id, name FROM users').all() as Row[]).map((r) => [String(r.id), `<${String(r.name)}>`] as const);
    for (const t of Object.keys(dump)) dump[t] = dump[t]!.map((l) => names.reduce((x, [id, n]) => x.split(id).join(n), l)).sort();
  } finally {
    db.close();
  }
  const files: Record<string, string> = {};
  for (const rel of walk(dir)) {
    if (LIVE_DB.has(rel) || SEALED_FILES.has(rel)) {
      files[rel] = 'present';
      continue;
    }
    files[rel] = createHash('sha256').update(readFileSync(join(dir, ...rel.split('/')))).digest('hex');
  }
  const camera = new CameraStore(dir).getMasked();
  return {
    db: dump, files,
    youtube: new TokenStore(dir).load(),
    camera,
    recovery: takeRecoveryNote(dir, loadIdentity(dir), rig.mBoxId)?.code ?? null,
  };
}

/** A person's id in a store, by name (G's people have new ids after the adopt). */
export const personId = (db: DatabaseSync, name: string): string => String(oneOf(db, 'SELECT id FROM users WHERE name = ?', name)!.id);
export const G_NAMES = { admin: 'Ahmad Salleh', media: 'Bilal Hamid', ajk: 'Cik Aminah', star: 'Sokongan Ruang Utama' } as const;

export const sizeOf = (p: string): number => statSync(p).size;
export { boxIdOf };
