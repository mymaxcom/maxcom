import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DatabaseSync as Db } from 'node:sqlite';
import { SELF_TV } from '@surau/core';
import { RECOVERY_META_KEY } from '../setup/codes.ts';
import { CARRIED_META_KEYS, CLEARED_TABLES, LOCAL_SYNC_KEY, rekeyPeopleWith } from './adopt.ts';
import { walkFiles } from './setAside.ts';
import { listOut, outDbOf, StoreMoveError, UNLINK_OUT_DIR } from './storeMove.ts';
import type { MoveList } from './storeMove.ts';

/*
 * "Teruskan dengan data sekarang" at a FOLLOWER (multi-box phase 2D, D3): the master makes the copy the follower will
 * run on alone. SECURITY code: what is NOT in this copy never reaches the leaving box.
 *
 * A consistent copy of the master's database (VACUUM INTO, in `unlinkcopy-out/<unlinkId>/`) is reduced in ONE
 * transaction, with secure delete on, and then rebuilt (VACUUM) so no removed row survives in a free page:
 *   - finance: the ledger (entries, photos, month closings, counters) is emptied; the triggers that forbid a delete
 *     are dropped for that and made again as they were. Funds and perihal (the lists the ledger is kept with) stay.
 *   - people: only the follower's own people of link day and the person who answered for it, each given back the id
 *     it had on the follower when known (else a new one: an id is one global key on the cloud); every PIN hash goes.
 *   - phones, TVs, sessions, pairings, link rows, the cloud's tables and keys, the auth log and the change history
 *     (it holds the before and after of every removed row) go; the log keeps its head so a cursor never goes back.
 *   - the leaving TV's profile becomes the box's own TV (`self`); the box name is the follower's; no recovery code.
 *   - videos that do not fit the follower's free space (largest first) are left out with their video items.
 * The list names the reduced database and the media of `assets/` and `themes/` (never `finance/photos/`, never a
 * secret file: no YouTube sign-in, camera or cloud key crosses).
 */

const SDM = 'sdm';
const VIDEO_MIME = 'video/mp4';
const MEDIA_DIRS = ['assets', 'themes'] as const;
/** The finance ledger; funds and perihal are its lists, kept. */
const LEDGER_TABLES = ['finance_photos', 'finance_entries', 'finance_months', 'finance_counters'] as const;
/** Gone besides the adopt's cleared tables: this box's own logs, replay stores and op records. */
const MORE_CLEARED = ['auth_log', 'applied_ops', 'sync_nonces', 'surau_resets'] as const;

type Row = Record<string, unknown>;

export interface ReducedCopyInput {
  dataDir: string;
  /** The master's open database (only read, by VACUUM INTO). */
  db: Db;
  unlinkId: string;
  dbLevel: number;
  release: string;
  /** The people who go: the master's user id -> the id they get in the copy (their id on the follower when known). */
  people: Map<string, string | null>;
  /** The follower's name, its box name from now on. */
  boxName: string;
  /** The leaving TV's device id at the master (its profile becomes the box's own TV). */
  tvDeviceId: string;
  /** The follower's free bytes (it said so in its signed list request); null: unknown, nothing is left out. */
  followerFreeBytes: number | null;
  floorBytes: number;
}

export interface ReducedCopy {
  list: MoveList;
  videosNotFit: { title: string; bytes: number }[];
}

const has = (db: Db, table: string): boolean =>
  db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;

const parseObj = (s: unknown): Record<string, unknown> | null => {
  if (typeof s !== 'string') return null;
  try {
    const v = JSON.parse(s) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const fileSize = (p: string): number => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};

function inTx(db: Db, fn: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Empty the ledger: its no-delete triggers are dropped for the delete and made again exactly as they were. */
function emptyLedger(db: Db): void {
  const triggers = (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name LIKE 'finance%'").all() as Row[])
    .filter((t) => typeof t.sql === 'string');
  for (const t of triggers) db.exec(`DROP TRIGGER "${String(t.name).replaceAll('"', '""')}"`);
  for (const t of LEDGER_TABLES) if (has(db, t)) db.exec(`DELETE FROM ${t}`);
  for (const t of triggers) db.exec(String(t.sql));
}

/** Only the people that go; each with the id it gets in the copy. */
function keepPeople(db: Db, people: Map<string, string | null>): void {
  db.exec('CREATE TEMP TABLE IF NOT EXISTS reduce_keep (id TEXT PRIMARY KEY)');
  db.exec('DELETE FROM reduce_keep');
  const put = db.prepare('INSERT OR IGNORE INTO reduce_keep (id) VALUES (?)');
  for (const id of people.keys()) put.run(id);
  db.exec('DELETE FROM users WHERE id NOT IN (SELECT id FROM reduce_keep)');
  db.exec('DROP TABLE reduce_keep');
  db.exec('UPDATE users SET pin_hash = NULL, pin_fail_count = 0, pin_locked_until = NULL, lock_round = 0');
  const present = new Set((db.prepare('SELECT id FROM users').all() as Row[]).map((r) => String(r.id)));
  const taken = new Set<string>();
  const map = new Map<string, string>();
  for (const [id, wanted] of people) {
    if (!present.has(id)) continue;
    // a wanted id is used once, and never one a kept person still holds under another name
    const ok = wanted !== null && !taken.has(wanted) && (wanted === id || !present.has(wanted));
    const next = ok ? wanted : randomUUID();
    taken.add(next);
    if (next !== id) map.set(id, next);
  }
  rekeyPeopleWith(db, map);
}

/** The leaving TV's profile becomes the box's own TV; no other TV of the master stays. */
function ownTvProfile(db: Db, tvDeviceId: string): void {
  const row = db.prepare("SELECT json FROM settings WHERE surau_id = ? AND feature = 'tvProfiles'").get(SDM) as Row | undefined;
  if (row === undefined) return;
  const obj = parseObj(row.json) ?? {};
  const tvs = typeof obj.tvs === 'object' && obj.tvs !== null && !Array.isArray(obj.tvs) ? (obj.tvs as Record<string, unknown>) : {};
  const mine = tvs[tvDeviceId];
  const next = { ...obj, tvs: mine !== undefined && mine !== null ? { [SELF_TV]: mine } : {} };
  db.prepare("UPDATE settings SET json = ?, updated_by = 'system:unlink' WHERE surau_id = ? AND feature = 'tvProfiles'").run(JSON.stringify(next), SDM);
}

function reduce(db: Db, o: ReducedCopyInput): void {
  inTx(db, () => {
    emptyLedger(db);
    // rows naming a device or a person first (no foreign key may point at a removed row)
    for (const t of [...CLEARED_TABLES, ...MORE_CLEARED]) if (has(db, t)) db.exec(`DELETE FROM ${t}`);
    db.exec('DELETE FROM devices');
    db.exec("DELETE FROM users WHERE surau_id = '*'");
    keepPeople(db, o.people);
    ownTvProfile(db, o.tvDeviceId);
    // the history holds the before and after of every removed row: it goes, its head stays (a cursor never goes back)
    const head = Number(db.prepare('SELECT MAX(id) AS n FROM change_log').get()?.n ?? 0);
    db.exec('DELETE FROM change_log');
    if (Number.isSafeInteger(head) && head > 0) {
      db.prepare(
        `INSERT INTO change_log (surau_id, id, at, actor, entity, entity_id, before_json, after_json, origin)
         VALUES (?, ?, ?, 'system:unlink', 'box', ?, NULL, ?, 'local')`,
      ).run(SDM, head, new Date().toISOString(), o.unlinkId, JSON.stringify({ reason: 'reduced-copy' }));
    }
    if (has(db, 'worker_outbox')) db.exec('DELETE FROM worker_outbox');
    // the box's own name; the master's recovery code and setup id never go
    db.prepare(`DELETE FROM meta WHERE key IN (?, ${CARRIED_META_KEYS.map(() => '?').join(', ')})`).run(RECOVERY_META_KEY, ...CARRIED_META_KEYS);
    db.prepare('INSERT INTO meta (surau_id, key, value) VALUES (?, ?, ?)').run(SDM, 'box_name', o.boxName.slice(0, 60));
    for (const r of db.prepare('SELECT key FROM sync_state').all() as Row[]) {
      if (!LOCAL_SYNC_KEY(String(r.key))) db.prepare('DELETE FROM sync_state WHERE key = ?').run(String(r.key));
    }
  });
}

/** The videos to leave out so the copy fits: largest first, until the rest fits above the floor. */
function videosToLeave(db: Db, dataDir: string, otherBytes: number, free: number | null, floor: number): { id: string; title: string; bytes: number }[] {
  if (free === null) return [];
  const videos = (db.prepare('SELECT id FROM assets WHERE mime = ?').all(VIDEO_MIME) as Row[])
    .map((r) => ({ id: String(r.id), bytes: fileSize(join(dataDir, 'assets', `${String(r.id)}.mp4`)) }))
    .filter((v) => v.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id));
  let total = otherBytes + videos.reduce((n, v) => n + v.bytes, 0);
  const titles = new Map<string, string>();
  for (const r of db.prepare("SELECT json FROM content_items WHERE kind = 'video' AND deleted_at IS NULL").all() as Row[]) {
    const j = parseObj(r.json);
    if (j !== null && typeof j.assetId === 'string' && !titles.has(j.assetId)) titles.set(j.assetId, typeof j.title === 'string' ? j.title.slice(0, 120) : '');
  }
  const out: { id: string; title: string; bytes: number }[] = [];
  for (const v of videos) {
    if (free - total >= floor) break;
    out.push({ id: v.id, title: titles.get(v.id) ?? '', bytes: v.bytes });
    total -= v.bytes;
  }
  return out;
}

/** Drop the left-out videos and the items that show them, in the copy. */
function dropVideos(db: Db, ids: Set<string>): void {
  if (ids.size === 0) return;
  inTx(db, () => {
    const at = new Date().toISOString();
    for (const r of db.prepare("SELECT id, json FROM content_items WHERE kind = 'video' AND deleted_at IS NULL").all() as Row[]) {
      const j = parseObj(r.json);
      if (j !== null && typeof j.assetId === 'string' && ids.has(j.assetId)) db.prepare('UPDATE content_items SET deleted_at = ? WHERE id = ?').run(at, r.id as string);
    }
    for (const id of ids) db.prepare('DELETE FROM assets WHERE id = ?').run(id);
  });
}

/** Master: the reduced copy and its list (the list's `linkId` is the unlink's id). */
export async function buildReducedCopy(o: ReducedCopyInput): Promise<ReducedCopy> {
  if (!/^[0-9a-f]{32}$/.test(o.unlinkId)) throw new StoreMoveError('bad_list');
  const outDb = outDbOf(o.dataDir, o.unlinkId, UNLINK_OUT_DIR);
  rmSync(join(o.dataDir, UNLINK_OUT_DIR), { recursive: true, force: true });
  mkdirSync(join(outDb, '..'), { recursive: true });
  o.db.prepare('VACUUM INTO ?').run(outDb);
  let notFit: { id: string; title: string; bytes: number }[] = [];
  const copy = new DatabaseSync(outDb, { enableForeignKeyConstraints: false });
  try {
    copy.exec('PRAGMA journal_mode = DELETE');
    copy.exec('PRAGMA secure_delete = ON');
    reduce(copy, o);
    // rebuilt: nothing removed is left in a free page of the file
    copy.exec('VACUUM');
    const videoFiles = new Set((copy.prepare('SELECT id FROM assets WHERE mime = ?').all(VIDEO_MIME) as Row[]).map((r) => `assets/${String(r.id)}.mp4`));
    let other = fileSize(outDb);
    for (const dir of MEDIA_DIRS) {
      for (const rel of walkFiles(join(o.dataDir, dir))) if (!videoFiles.has(`${dir}/${rel}`)) other += fileSize(join(o.dataDir, dir, ...rel.split('/')));
    }
    notFit = videosToLeave(copy, o.dataDir, other, o.followerFreeBytes, o.floorBytes);
    dropVideos(copy, new Set(notFit.map((v) => v.id)));
  } finally {
    copy.close();
  }
  const left = new Set(notFit.map((v) => `assets/${v.id}.mp4`));
  const list = await listOut({
    dataDir: o.dataDir, linkId: o.unlinkId, dbLevel: o.dbLevel, release: o.release, outRel: UNLINK_OUT_DIR, mediaDirs: MEDIA_DIRS,
    skip: (rel) => left.has(rel),
  });
  return { list, videosNotFit: notFit.map((v) => ({ title: v.title, bytes: v.bytes })) };
}
