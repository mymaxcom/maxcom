import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MAX_TVS, SELF_TV } from '@surau/core';
import { sha256hex } from '../auth/crypto.ts';
import { assignNewNo, numberTaken } from '../auth/ids.ts';
import { authLog } from '../auth/sessions.ts';
import { tx } from '../auth/users.ts';
import { openDb } from '../db.ts';
import { CameraStore } from '../live/camera.ts';
import type { CameraBackup } from '../live/camera.ts';
import { TokenStore } from '../live/youtube/tokenStore.ts';
import type { YoutubeTokens } from '../live/youtube/tokenStore.ts';
import { boxVersion } from '../productVersion.ts';
import { MIGRATIONS } from '../migrations/index.ts';
import { loadIdentity } from '../setup/identity.ts';
import type { BoxIdentity } from '../setup/identity.ts';
import { RECOVERY_META_KEY } from '../setup/codes.ts';
import { openWithBoxKey, sealToBoxKey, sealedRe } from '../sync/boxSeal.ts';
import { clearJournal, LINK_ID_RE, readJournal, writeJournal } from './journal.ts';
import type { LinkJournal } from './journal.ts';
import {
  backupDirOf, CLOUD_RESET_REL, listManifestFiles, pathExists, STORE_ITEMS, writeFileAtomic, writeManifest,
} from './setAside.ts';
import type { BootHooks, BootResult } from './setAside.ts';
import { stageDirOf, sweepStage } from './storeMove.ts';
import type { MoveFile } from './storeMove.ts';

/*
 * Cases X and N-X at the box that becomes the master (M): it opens the store of the giving box (G) as its own.
 * SECURITY code. The table this file applies is `docs/design/plans/2026-11-23-adopt-store-table.md` (B0).
 *
 * 1. `planAdopt` (at the commit, M's own store still open): M's carry set (its own people, phones, TVs, box name,
 *    cloud link, the link session), the follower's TV token hash, the phone-move ticket hashes and a new recovery code
 *    are written to `link-adopt.json`, sealed to M's identity key. The journal is written only once G has taken the
 *    commit (`commitAdopt`), so a link that fails before that leaves M as it was.
 * 2. At the next start, BEFORE the database opens (`runAdopt`, from `applyLinkJournalAtBoot`):
 *    `planned`  the stage is checked complete (else the plan is dropped: fully old);
 *    `set-aside` M's store moves to `linkundo/<linkId>/` (case X: its backup; its cloud key stays in place, a copy goes
 *               with the backup), N-X: the empty store of a new box is removed;
 *    `swap`     the staged store moves into place;
 *    `adopt`    the database opens and `adoptStore` applies the table in ONE transaction (a marker row makes a repeat
 *               a no-op), then the cloud-reset mark and the one-time recovery note are written;
 *    then the stage, the carry file and the journal go. From `set-aside` on the op only goes forward.
 */

export const ADOPT_REL = 'link-adopt.json';
/** The new recovery code, sealed, until the admin's done screen read it once (`takeRecoveryNote`). */
export const RECOVERY_NOTE_REL = 'secret/link-recovery.json';
const ADOPT_LABEL = 'maxcom-link-adopt-v1';
/** The giver's YouTube sign-in and camera address on their way to the receiver (sealed to its identity key). */
export const YT_CROSS_LABEL = 'maxcom-link-yt-v1';
export const CAM_CROSS_LABEL = 'maxcom-link-cam-v1';
const CROSS_SEALED = sealedRe(64 * 1024);
const NOTE_LABEL = 'maxcom-link-recovery-v1';
const ADOPT_SEALED = sealedRe(48 * 1024 * 1024);
const NOTE_SEALED = sealedRe(4096);
/** What the swap moves from the stage: the received copy of G's database and its media folders. */
export const SWAP_ITEMS = ['surau.db', 'assets', 'finance/photos', 'themes'] as const;
/** sync_state keys that are this box's own housekeeping (not the cloud's): kept from G's store. */
export const LOCAL_SYNC_KEY = (k: string): boolean =>
  k === 'log_floor' || k === 'poster_stretch_keep' || k.startsWith('clean_') || k.startsWith('ayat_daily_anchor:');
/** M's cloud link carried into the adopted store (its `sync.key` never moved). */
export const CARRIED_SYNC_KEYS = ['linked', 'cloud_url', 'link_history'] as const;
export const CARRIED_META_KEYS = ['box_name', 'box_name_basis', 'surau_id'] as const;
/** Cleared in the adopted store: short-lived, G's own, or cloud-only (empty on a box). */
export const CLEARED_TABLES = [
  'link_people', 'kiosk_cookies', 'linked_boxes', 'sessions', 'challenges', 'box_codes', 'kiosk_pairings', 'enrolments',
  'link_sessions', 'live_sessions', 'uploads', 'youtube_pending_complete', 'parked_settings', 'sites', 'site_approvals',
  'suraus', 'worker_outbox', 'youtube_flag', 'youtube_handover', 'camera_secrets',
] as const;
const SDM = 'sdm';

type Row = Record<string, unknown>;

export interface AdoptTicket {
  /** The person's id in G's store (= in the adopted store). */
  userId: string;
  codeHash: string;
  deviceName: string;
  expiresAt: string;
}

export interface AdoptCarry {
  v: 1;
  linkId: string;
  case: 'X' | 'N-X';
  /** M's box id. */
  boxId: string;
  /** M's change_log head when the plan was made. */
  oldHead: number;
  people: Row[];
  devices: Row[];
  cookies: Row[];
  /** M's `tvProfiles.tvs` (its `self` entry and the entries of its carried TVs). */
  tvs: Record<string, unknown>;
  linkSession: Row | null;
  meta: Row[];
  sync: Row[];
  /** M was linked to the cloud: no sync until the cloud copy is made equal to the adopted store. */
  cloudReset: boolean;
  follower: {
    deviceId: string;
    tokenHash: string;
    tokenExpiresAt: string;
    /** The admin the follower's TV row is made in the name of: M's PIN-proof admin (X) or G's linking admin (N-X). */
    owner: string;
    boxId: string;
    keyFp: string;
    pub: unknown;
    name: string;
    addresses: unknown;
    release: string;
    linkedAt: string;
  };
  tickets: AdoptTicket[];
  recovery: { code: string; hash: string };
  /** The staged files (the pulled list): the start checks every one is there before anything moves. */
  files: MoveFile[];
  /** The kept data's YouTube sign-in (L6: it wins over this box's own, which stays in this box's backup). */
  youtube?: YoutubeTokens | null;
  /** The kept data's camera address with no password (typed again here). */
  camera?: CameraBackup | null;
}

/** The receiver opens what the giver sealed for it; anything that does not open or parse is left out. */
export function openCrossing(identity: BoxIdentity, v: unknown, linkId: string, giverBoxId: string, ownBoxId: string): { youtube: YoutubeTokens | null; camera: CameraBackup | null } {
  const m = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const aadOf = `${linkId}|${giverBoxId}|${ownBoxId}`;
  const open = (x: unknown, label: string): Record<string, unknown> | null => {
    if (typeof x !== 'string') return null;
    try {
      const o = JSON.parse(openWithBoxKey(identity.privateJwk, x, label, aadOf, CROSS_SEALED)) as unknown;
      return typeof o === 'object' && o !== null && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const y = open(m.youtube, YT_CROSS_LABEL);
  const youtube = y !== null && typeof y.refreshToken === 'string' && y.refreshToken !== '' && typeof y.channelId === 'string'
    ? {
        refreshToken: y.refreshToken, accessToken: typeof y.accessToken === 'string' ? y.accessToken : '',
        expiresAt: typeof y.expiresAt === 'number' ? y.expiresAt : 0, channelId: y.channelId,
        channelTitle: typeof y.channelTitle === 'string' ? y.channelTitle : '', scope: typeof y.scope === 'string' ? y.scope : '',
        streamId: typeof y.streamId === 'string' ? y.streamId : null,
      }
    : null;
  const c = open(m.camera, CAM_CROSS_LABEL);
  const camera = c !== null && typeof c.url === 'string'
    ? { url: c.url, ...(typeof c.username === 'string' ? { username: c.username } : {}), hasPassword: c.hasPassword === true }
    : null;
  return { youtube, camera };
}

const carryPath = (dataDir: string): string => join(dataDir, ADOPT_REL);
const aad = (linkId: string, boxId: string): string => `${linkId}|${boxId}`;

// ------------------------------------------------------------------------------------------------ plan (M, running)

const has = (db: DatabaseSync, table: string): boolean =>
  db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;

/** M's own part of the adopted store, read from M's open database. */
export function carryOf(db: DatabaseSync, now: Date, linkId: string): Pick<AdoptCarry, 'oldHead' | 'people' | 'devices' | 'cookies' | 'tvs' | 'linkSession' | 'meta' | 'sync' | 'cloudReset'> {
  const people = db.prepare('SELECT * FROM users WHERE active = 1 AND deleted_at IS NULL ORDER BY created_at, id').all() as Row[];
  const ids = new Set(people.map((p) => String(p.id)));
  const devices = (db.prepare('SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY enrolled_at, id').all() as Row[])
    .filter((d) => ids.has(String(d.user_id)));
  const devIds = new Set(devices.map((d) => String(d.id)));
  const cookies = (db.prepare('SELECT * FROM kiosk_cookies WHERE expires_at > ?').all(now.toISOString()) as Row[])
    .filter((c) => devIds.has(String(c.device_id)));
  const tvRow = db.prepare("SELECT json FROM settings WHERE surau_id = ? AND feature = 'tvProfiles'").get(SDM);
  let tvs: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(tvRow?.json ?? '{}')) as { tvs?: unknown };
    if (typeof parsed.tvs === 'object' && parsed.tvs !== null && !Array.isArray(parsed.tvs)) {
      for (const [k, v] of Object.entries(parsed.tvs as Record<string, unknown>)) {
        // M's own TV and its carried TVs only, and never a removal mark
        if (v !== null && (k === SELF_TV || devIds.has(k))) tvs[k] = v;
      }
    }
  } catch {
    tvs = {};
  }
  const meta = db.prepare(`SELECT surau_id, key, value FROM meta WHERE key IN (${CARRIED_META_KEYS.map(() => '?').join(', ')})`).all(...CARRIED_META_KEYS) as Row[];
  const sync = db.prepare(`SELECT key, value FROM sync_state WHERE key IN (${CARRIED_SYNC_KEYS.map(() => '?').join(', ')})`).all(...CARRIED_SYNC_KEYS) as Row[];
  const linked = sync.some((r) => r.key === 'linked' && r.value === '1');
  const linkSession = (db.prepare('SELECT * FROM link_sessions WHERE id = ?').get(linkId) as Row | undefined) ?? null;
  const head = Number(db.prepare('SELECT MAX(id) AS n FROM change_log').get()?.n ?? 0);
  return { oldHead: Number.isSafeInteger(head) ? head : 0, people, devices, cookies, tvs, linkSession, meta, sync, cloudReset: linked };
}

/** Write the sealed carry file (no journal yet). Throws `adopt: <code>` with `bad_link_id` or `journal_open`. */
export function planAdopt(dataDir: string, identity: BoxIdentity, carry: AdoptCarry): void {
  if (!LINK_ID_RE.test(carry.linkId)) throw new Error('adopt: bad_link_id');
  if (readJournalSafe(dataDir) !== 'none') throw new Error('adopt: journal_open');
  const sealed = sealToBoxKey(identity.publicJwk, JSON.stringify(carry), ADOPT_LABEL, aad(carry.linkId, carry.boxId));
  writeFileAtomic(carryPath(dataDir), sealed);
}

/** G took the commit: the journal makes the next start adopt. */
export function commitAdopt(dataDir: string, linkId: string, now: Date): void {
  if (!existsSync(carryPath(dataDir))) throw new Error('adopt: no_plan');
  writeJournal(dataDir, { v: 1, op: 'adopt', linkId, step: 'planned', at: now.toISOString(), release: boxVersion(), dbLevel: MIGRATIONS.length });
}

/** The link failed before G took the commit: nothing of the plan stays. */
export function dropAdoptPlan(dataDir: string): void {
  rmSync(carryPath(dataDir), { force: true });
  rmSync(`${carryPath(dataDir)}.tmp`, { force: true });
}

function readJournalSafe(dataDir: string): 'none' | 'open' {
  try {
    return readJournal(dataDir) === null ? 'none' : 'open';
  } catch {
    return 'open';
  }
}

/** At a start with no adopt journal: a carry file or a stage folder is what a failed link left. */
export function sweepAdoptLeftovers(dataDir: string): void {
  let j: LinkJournal | null = null;
  try {
    j = readJournal(dataDir);
  } catch {
    j = null;
  }
  // an open adopt or reduce (a follower carrying on alone) still needs its stage
  if (j !== null && (j.op === 'adopt' || j.op === 'reduce')) return;
  dropAdoptPlan(dataDir);
  sweepStage(dataDir, null);
}

function readCarry(dataDir: string, linkId: string, identity: BoxIdentity, boxId: string): AdoptCarry {
  const sealed = readFileSync(carryPath(dataDir), 'utf8');
  const c = JSON.parse(openWithBoxKey(identity.privateJwk, sealed, ADOPT_LABEL, aad(linkId, boxId), ADOPT_SEALED)) as AdoptCarry;
  if (c === null || typeof c !== 'object' || c.v !== 1 || c.linkId !== linkId || c.boxId !== boxId || (c.case !== 'X' && c.case !== 'N-X')) {
    throw new Error('adopt: carry unreadable');
  }
  return c;
}

// ------------------------------------------------------------------------------------------------ start (before the DB)

export interface AdoptBootDeps {
  /** M's box id (`secret/box.key`), asked only when an adopt journal is open. */
  boxId: () => string;
  identity?: BoxIdentity;
  now?: () => Date;
}

/** Every staged file is there with its listed size (each was hash-checked when it landed). */
function stageComplete(dataDir: string, c: AdoptCarry): boolean {
  const root = stageDirOf(dataDir, c.linkId);
  if (!c.files.some((f) => f.path === 'surau.db')) return false;
  return c.files.every((f) => {
    try {
      return statSync(join(root, ...f.path.split('/'))).size === f.size;
    } catch {
      return false;
    }
  });
}

function move(from: string, to: string): boolean {
  if (!pathExists(from)) return false;
  if (pathExists(to)) throw new Error(`adopt: collision at ${to}`);
  mkdirSync(join(to, '..'), { recursive: true });
  renameSync(from, to);
  return true;
}

function copyIfMissing(from: string, to: string): void {
  if (!existsSync(from) || existsSync(to)) return;
  mkdirSync(join(to, '..'), { recursive: true });
  copyFileSync(from, `${to}.tmp`);
  renameSync(`${to}.tmp`, to);
}

export function runAdopt(dataDir: string, j0: LinkJournal, h: BootHooks, deps: AdoptBootDeps): BootResult {
  const hook = (n: string): void => h.afterStep?.(n);
  const identity = deps.identity ?? loadIdentity(dataDir);
  const boxId = deps.boxId();
  const now = deps.now ?? (() => new Date());
  let carry: AdoptCarry;
  try {
    carry = readCarry(dataDir, j0.linkId, identity, boxId);
  } catch (error) {
    // Before anything moved the plan is simply dropped; after, a lost carry is a fault a person must look at.
    if (j0.step === 'planned') {
      dropAdoptPlan(dataDir);
      sweepStage(dataDir, null);
      clearJournal(dataDir);
      return 'dropped';
    }
    throw error;
  }
  let j = j0;
  if (j.step === 'planned') {
    if (!stageComplete(dataDir, carry)) {
      dropAdoptPlan(dataDir);
      sweepStage(dataDir, null);
      clearJournal(dataDir);
      return 'dropped';
    }
    j = { ...j, step: 'set-aside', done: [] };
    writeJournal(dataDir, j);
    hook('adopt:start');
  }

  if (j.step === 'set-aside') {
    const dest = backupDirOf(dataDir, j.linkId);
    for (const item of STORE_ITEMS) {
      const from = join(dataDir, item.rel);
      if (item.secret === 'cloud') {
        // M keeps its own cloud key in place; its backup gets a copy (a local revert puts M back as it was)
        if (carry.case === 'X') copyIfMissing(from, join(dest, item.rel));
        continue;
      }
      if (carry.case === 'N-X') {
        // a new box: nothing of value, the place is only cleared
        rmSync(from, { recursive: true, force: true });
      } else if (!move(from, join(dest, item.rel))) {
        continue;
      }
      j = { ...j, done: [...(j.done ?? []), item.rel] };
      writeJournal(dataDir, j);
      hook(`adopt:aside:${item.rel}`);
    }
    if (carry.case === 'X') {
      mkdirSync(dest, { recursive: true });
      const { files, bytes } = listManifestFiles(dest, h);
      writeManifest(dest, {
        v: 1, kind: 'set-aside', linkId: j.linkId, at: j.at, release: j.release ?? boxVersion(), dbLevel: j.dbLevel ?? MIGRATIONS.length, files, bytes,
      });
    }
    j = { ...j, step: 'swap', done: [] };
    writeJournal(dataDir, j);
    hook('adopt:aside-done');
  }

  if (j.step === 'swap') {
    const stage = stageDirOf(dataDir, j.linkId);
    for (const rel of SWAP_ITEMS) {
      if (!move(join(stage, ...rel.split('/')), join(dataDir, ...rel.split('/')))) continue;
      hook(`adopt:swap:${rel}`);
    }
    if (!existsSync(join(dataDir, 'surau.db'))) throw new Error('adopt: no database after the swap');
    j = { ...j, step: 'adopt', done: [] };
    writeJournal(dataDir, j);
    hook('adopt:swap-done');
  }

  // step `adopt`: repeatable (the marker row makes a second run change nothing)
  const db = openDb(join(dataDir, 'surau.db'));
  try {
    if (!adopted(db, j.linkId)) adoptStore(db, carry, now());
  } finally {
    db.close();
  }
  hook('adopt:applied');
  // the kept data's sign-ins, now under this box's own key; a failure leaves them out (the admin signs in again)
  if (carry.youtube) {
    try {
      new TokenStore(dataDir).save(carry.youtube);
    } catch {
      console.warn('adopt: the YouTube sign-in could not be kept; sign in again');
    }
  }
  if (carry.camera) {
    try {
      const b = carry.camera;
      new CameraStore(dataDir).save({ url: b.url, ...(b.username !== undefined ? { username: b.username } : {}) }, { passwordNeeded: b.hasPassword });
    } catch {
      console.warn('adopt: the camera address could not be kept; enter it again');
    }
  }
  if (carry.cloudReset) writeFileAtomic(join(dataDir, CLOUD_RESET_REL), JSON.stringify({ v: 1, linkId: j.linkId, at: j.at, reason: 'adopt' }));
  writeRecoveryNote(dataDir, identity, j.linkId, boxId, carry.recovery.code);
  hook('adopt:marked');
  sweepStage(dataDir, null);
  dropAdoptPlan(dataDir);
  clearJournal(dataDir);
  hook('adopt:cleared');
  return 'adopt';
}

/** Keep a new recovery code, sealed, until the admin's done screen reads it once (`takeRecoveryNote`). */
export function writeRecoveryNote(dataDir: string, identity: BoxIdentity, linkId: string, boxId: string, code: string): void {
  const note = sealToBoxKey(identity.publicJwk, code, NOTE_LABEL, aad(linkId, boxId));
  writeFileAtomic(join(dataDir, RECOVERY_NOTE_REL), JSON.stringify({ linkId, sealed: note }));
}

/** How long the new recovery code can still be read after its first read (a lost answer, a reload of the screen). */
export const RECOVERY_NOTE_READ_MS = 15 * 60_000;

/**
 * The new recovery code of the last adopt (or reduce). The first read starts a 15-minute window in which the code can
 * be read again; after it the file goes. Only the box's own status route calls this, for the person who linked.
 */
export function takeRecoveryNote(dataDir: string, identity: BoxIdentity, boxId: string, now: Date = new Date()): { linkId: string; code: string } | null {
  const path = join(dataDir, RECOVERY_NOTE_REL);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const note = JSON.parse(raw) as { linkId?: unknown; sealed?: unknown; firstReadAt?: unknown };
    if (typeof note.linkId !== 'string' || !LINK_ID_RE.test(note.linkId) || typeof note.sealed !== 'string') {
      rmSync(path, { force: true });
      return null;
    }
    const first = typeof note.firstReadAt === 'string' ? Date.parse(note.firstReadAt) : NaN;
    if (Number.isFinite(first) && now.getTime() - first > RECOVERY_NOTE_READ_MS) {
      rmSync(path, { force: true });
      return null;
    }
    const code = openWithBoxKey(identity.privateJwk, note.sealed, NOTE_LABEL, aad(note.linkId, boxId), NOTE_SEALED);
    if (!Number.isFinite(first)) writeFileAtomic(path, JSON.stringify({ linkId: note.linkId, sealed: note.sealed, firstReadAt: now.toISOString() }));
    return { linkId: note.linkId, code };
  } catch {
    // a note that does not open (another box, another key, edited, junk) is never kept
    rmSync(path, { force: true });
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ the table

function adopted(db: DatabaseSync, linkId: string): boolean {
  return db.prepare("SELECT 1 AS x FROM change_log WHERE entity = 'box' AND entity_id = ? AND actor = 'system:link'").get(linkId) !== undefined;
}

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Row[]).map((r) => String(r.name)));
}

/** Insert a carried row into `table`, columns the table has only (a carry from an older level still lands). */
function insertRow(db: DatabaseSync, table: string, cols: Set<string>, row: Row): void {
  const keys = Object.keys(row).filter((k) => cols.has(k));
  const vals = keys.map((k) => {
    const v = row[k];
    return v === undefined ? null : (v as string | number | null);
  });
  db.prepare(`INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...vals);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Apply the adopt table to G's database (now this box's) in ONE transaction. Never throws for a single bad carried
 * row (a start that throws here would stop at every start): such a row is left out and counted.
 */
export function adoptStore(db: DatabaseSync, c: AdoptCarry, now: Date): { people: number; devices: number; skipped: number } {
  const at = now.toISOString();
  let skipped = 0;
  let people = 0;
  let devices = 0;
  tx(db, () => {
    // ---- cleared: short-lived, G's own, cloud-only (FK order: rows naming devices or users first)
    for (const t of CLEARED_TABLES) if (has(db, t)) db.prepare(`DELETE FROM ${t}`).run();
    // G's phones and TVs: their box id is G's (the cloud refuses them); G's phones move by ticket
    db.prepare('DELETE FROM devices').run();
    // G's Pentadbir / Sokongan MAXCOM: the operator grants again on this box by CLI
    db.prepare("DELETE FROM users WHERE surau_id = '*'").run();
    // G's PIN hashes are peppered with G's key: useless here, and every failure would count toward a lockout
    db.prepare('UPDATE users SET pin_hash = NULL, pin_fail_count = 0, pin_locked_until = NULL, lock_round = 0').run();
    // G's people get NEW ids (operator 23 Nov): a person id is one global key on the cloud, where G's own (sleeping)
    // surau still holds the old ones. As in case S, where a merged person is a new account on the master.
    const rekey = rekeyPeople(db);

    // ---- M's people (Q1): one list; a person with the same phone is ONE person (G's row and role win)
    const userCols = columnsOf(db, 'users');
    const idMap = new Map<string, string>();
    const byPhone = db.prepare("SELECT id FROM users WHERE phone = ? AND surau_id <> '*' AND active = 1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1");
    for (const p of c.people) {
      const id = str(p.id);
      if (id === null) {
        skipped++;
        continue;
      }
      try {
        const phone = str(p.phone);
        const same = p.surau_id !== '*' && phone !== null ? (byPhone.get(phone) as Row | undefined) : undefined;
        const exists = db.prepare('SELECT id FROM users WHERE id = ?').get(id) as Row | undefined;
        if (same !== undefined || exists !== undefined) {
          const keep = String((same ?? exists)!.id);
          db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(str(p.pin_hash), keep);
          idMap.set(id, keep);
          continue;
        }
        const row: Row = { ...p };
        const kind = 'user' as const;
        if (typeof row.no === 'number' && typeof row.no_src === 'string' && numberTaken(db, String(row.surau_id ?? SDM), kind, row.no_src as never, row.no)) {
          row.no = null;
        }
        insertRow(db, 'users', userCols, row);
        if (row.no === null) assignNewNo(db, kind, id, String(row.surau_id ?? SDM));
        idMap.set(id, id);
        people++;
      } catch {
        skipped++;
      }
    }

    // ---- M's phones and TVs, pointed at the merged people
    const devCols = columnsOf(db, 'devices');
    const carriedDevices = new Set<string>();
    for (const d of c.devices) {
      const id = str(d.id);
      const user = idMap.get(String(d.user_id));
      if (id === null || user === undefined) {
        skipped++;
        continue;
      }
      try {
        const row: Row = { ...d, user_id: user };
        if (typeof row.no === 'number' && typeof row.no_src === 'string' && numberTaken(db, String(row.surau_id ?? SDM), 'device', row.no_src as never, row.no)) {
          row.no = null;
        }
        insertRow(db, 'devices', devCols, row);
        if (row.no === null) assignNewNo(db, 'device', id, String(row.surau_id ?? SDM));
        carriedDevices.add(id);
        devices++;
      } catch {
        skipped++;
      }
    }
    const cookieCols = columnsOf(db, 'kiosk_cookies');
    for (const k of c.cookies) {
      if (!carriedDevices.has(String(k.device_id))) continue;
      try {
        insertRow(db, 'kiosk_cookies', cookieCols, k);
      } catch {
        skipped++;
      }
    }

    // ---- the follower (G's own TV, now a follower TV of this box), as in case S
    const f = c.follower;
    const owner = ownerOf(db, idMap.get(f.owner) ?? rekey.get(f.owner) ?? f.owner);
    db.prepare(`INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at, surau_id, box_id) VALUES (?, ?, ?, 'kiosk', NULL, ?, ?, ?)`)
      .run(f.deviceId, owner, f.name.slice(0, 80), f.linkedAt, SDM, c.boxId);
    assignNewNo(db, 'device', f.deviceId, SDM);
    db.prepare('INSERT INTO kiosk_cookies (token_hash, device_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(f.tokenHash, f.deviceId, f.linkedAt, f.tokenExpiresAt);
    db.prepare(
      `INSERT INTO linked_boxes (device_id, box_id, key_fp, public_jwk, name, local_name, addresses_json, version, linked_at, link_id)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    ).run(f.deviceId, f.boxId, f.keyFp, JSON.stringify(f.pub), f.name, JSON.stringify(f.addresses), f.release, f.linkedAt, c.linkId);

    // ---- the phone-move tickets for G's people (hashes only; the plain codes went to G sealed in the commit)
    const ticket = db.prepare('INSERT INTO enrolments (code_hash, user_id, device_name, expires_at, created_by, ops) VALUES (?, ?, ?, ?, ?, 0)');
    for (const t of c.tickets) {
      // a ticket names the person by G's id (G's phones know only that one); here it is the person's new id
      const userId = rekey.get(t.userId) ?? t.userId;
      const u = db.prepare('SELECT 1 AS x FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL').get(userId);
      if (u === undefined) {
        skipped++;
        continue;
      }
      ticket.run(t.codeHash, userId, t.deviceName.slice(0, 80), t.expiresAt, `link:${c.linkId}`);
    }

    // ---- tvProfiles: G's own TV entry follows G's new device id; M's own and carried TVs are added
    rewriteTvs(db, c, at);

    // ---- the link session as M finished it
    if (c.linkSession !== null) {
      try {
        // the person who linked, by their id here (merged by phone into a giver's row, they hold that row's id)
        const linker = str(c.linkSession.pin_proof_user);
        const pinProofUser = linker === null ? null : idMap.get(linker) ?? linker;
        insertRow(db, 'link_sessions', columnsOf(db, 'link_sessions'), { ...c.linkSession, pin_proof_user: pinProofUser, step: 'done', finished_at: at, outcome: 'linked', committed_at: f.linkedAt });
      } catch {
        skipped++;
      }
    }

    // ---- sync_state: every cloud key of G goes; M's own link comes back (no sync until the cloud reset)
    for (const r of db.prepare('SELECT key FROM sync_state').all() as Row[]) {
      if (!LOCAL_SYNC_KEY(String(r.key))) db.prepare('DELETE FROM sync_state WHERE key = ?').run(r.key as string);
    }
    for (const r of c.sync) db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(String(r.key), r.value as string | null);

    // ---- meta: M's box name and setup id; G's recovery code dies, the new one's hash
    db.prepare('DELETE FROM meta WHERE key = ?').run(RECOVERY_META_KEY);
    db.prepare(`DELETE FROM meta WHERE key IN (${CARRIED_META_KEYS.map(() => '?').join(', ')})`).run(...CARRIED_META_KEYS);
    for (const r of c.meta) db.prepare('INSERT INTO meta (surau_id, key, value) VALUES (?, ?, ?)').run(String(r.surau_id ?? SDM), String(r.key), r.value as string | null);
    db.prepare('INSERT INTO meta (surau_id, key, value) VALUES (?, ?, ?)').run(SDM, RECOVERY_META_KEY, c.recovery.hash);

    // ---- change_log: the marker above both heads; every app cursor of either old log gets snapshot_required
    const gHead = Number(db.prepare('SELECT MAX(id) AS n FROM change_log').get()?.n ?? 0);
    const marker = Math.max(gHead, c.oldHead) + 1;
    db.prepare(
      `INSERT INTO change_log (surau_id, id, at, actor, entity, entity_id, before_json, after_json, origin)
       VALUES (?, ?, ?, 'system:link', 'box', ?, NULL, ?, 'local')`,
    ).run(SDM, marker, at, c.linkId, JSON.stringify({ reason: 'adopt', case: c.case, fromBoxId: f.boxId }));
    db.prepare("INSERT INTO sync_state (key, value) VALUES ('log_floor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(marker));
    authLog(db, now, 'link_adopt', true, { userId: owner, detail: `${c.case} ${c.linkId.slice(0, 8)}` });
  });
  return { people, devices, skipped };
}

/**
 * Plain user-id columns and attribution columns (`user:<id>` or a bare id) that follow a person to the new id. NOT
 * `finance_entries.created_by`: a finance entry never changes (trigger), so its old attribution stays as history.
 */
const USER_ID_COLUMNS: readonly [string, string][] = [['auth_log', 'user_id']];
const ATTRIBUTION_COLUMNS: readonly [string, string][] = [
  ['users', 'created_by'], ['users', 'deleted_by'], ['assets', 'created_by'], ['finance_months', 'closed_by'],
  ['settings', 'updated_by'], ['prayer_imports', 'actor'], ['prayer_imports', 'undone_by'], ['prayer_corrections', 'actor'],
  ['content_items', 'updated_by'], ['finance_funds', 'updated_by'], ['finance_perihal', 'updated_by'],
  ['finance_photos', 'created_by'], ['change_log', 'actor'],
];

/** Every person of G (any state, not `'*'`: those are gone) gets a new UUID; old id to new id. Caller owns the transaction. */
function rekeyPeople(db: DatabaseSync): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of db.prepare("SELECT id FROM users WHERE surau_id <> '*'").all() as Row[]) map.set(String(r.id), randomUUID());
  return rekeyPeopleWith(db, map);
}

/**
 * Give people the ids of `map` (old id to new id) in `users` and in every column that names a person. No new id may be
 * an id still in use by a person outside the map. Caller owns the transaction (and has cleared the FK rows first).
 */
export function rekeyPeopleWith(db: DatabaseSync, map: Map<string, string>): Map<string, string> {
  if (map.size === 0) return map;
  db.exec('CREATE TEMP TABLE IF NOT EXISTS adopt_rekey (old TEXT PRIMARY KEY, new TEXT NOT NULL)');
  db.exec('DELETE FROM adopt_rekey');
  const put = db.prepare('INSERT INTO adopt_rekey (old, new) VALUES (?, ?)');
  for (const [o, n] of map) put.run(o, n);
  // no row names a person by FK any more (devices and link_people were cleared above)
  db.exec('UPDATE users SET id = (SELECT new FROM adopt_rekey WHERE old = users.id) WHERE id IN (SELECT old FROM adopt_rekey)');
  for (const [t, col] of [...USER_ID_COLUMNS, ...ATTRIBUTION_COLUMNS]) {
    if (!has(db, t) || !columnsOf(db, t).has(col)) continue;
    db.exec(`UPDATE ${t} SET ${col} = (SELECT new FROM adopt_rekey WHERE old = ${t}.${col}) WHERE ${col} IN (SELECT old FROM adopt_rekey)`);
    db.exec(`UPDATE ${t} SET ${col} = 'user:' || (SELECT new FROM adopt_rekey WHERE 'user:' || old = ${t}.${col}) WHERE ${col} IN (SELECT 'user:' || old FROM adopt_rekey)`);
  }
  db.exec("UPDATE change_log SET entity_id = (SELECT new FROM adopt_rekey WHERE old = change_log.entity_id) WHERE entity IN ('users', 'user') AND entity_id IN (SELECT old FROM adopt_rekey)");
  db.exec('DROP TABLE adopt_rekey');
  return map;
}

/** The admin the follower row is made for: the given one when active, else the first active admin, else anyone. */
function ownerOf(db: DatabaseSync, wanted: string): string {
  if (db.prepare('SELECT 1 AS x FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL').get(wanted) !== undefined) return wanted;
  const admin = db.prepare(`SELECT id FROM users WHERE active = 1 AND deleted_at IS NULL AND surau_id <> '*' AND roles_json LIKE '%"admin"%' ORDER BY created_at LIMIT 1`).get() as Row | undefined;
  if (admin !== undefined) return String(admin.id);
  const any = db.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get() as Row | undefined;
  if (any === undefined) throw new Error('adopt: the adopted store has no person');
  return String(any.id);
}

function rewriteTvs(db: DatabaseSync, c: AdoptCarry, at: string): void {
  const row = db.prepare("SELECT json FROM settings WHERE surau_id = ? AND feature = 'tvProfiles'").get(SDM) as Row | undefined;
  let obj: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row?.json ?? '{}')) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
  } catch {
    obj = {};
  }
  const old = (typeof obj.tvs === 'object' && obj.tvs !== null && !Array.isArray(obj.tvs) ? obj.tvs : {}) as Record<string, unknown>;
  const tvs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(old)) if (k !== SELF_TV && v !== null) tvs[k] = v;
  if (old[SELF_TV] !== undefined && old[SELF_TV] !== null) tvs[c.follower.deviceId] = old[SELF_TV];
  const live = (): number => Object.values(tvs).filter((v) => v !== null).length;
  if (c.tvs[SELF_TV] !== undefined) tvs[SELF_TV] = c.tvs[SELF_TV];
  for (const [k, v] of Object.entries(c.tvs)) {
    if (k === SELF_TV || tvs[k] !== undefined) continue;
    if (live() >= MAX_TVS) break; // a profile is optional: a TV past the cap follows the surau's choices
    tvs[k] = v;
  }
  if (row === undefined && Object.keys(tvs).length === 0) return;
  const json = JSON.stringify({ ...obj, tvs });
  if (row === undefined) {
    db.prepare("INSERT INTO settings (surau_id, feature, json, updated_at, updated_by) VALUES (?, 'tvProfiles', ?, ?, 'system:link')").run(SDM, json, at);
  } else {
    db.prepare("UPDATE settings SET json = ?, updated_at = ?, updated_by = 'system:link' WHERE surau_id = ? AND feature = 'tvProfiles'").run(json, at, SDM);
  }
}
