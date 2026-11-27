import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../db.ts';
import { loadIdentity } from '../setup/identity.ts';
import type { BoxIdentity } from '../setup/identity.ts';
import { newRecoveryCode, RECOVERY_META_KEY } from '../setup/codes.ts';
import { CARRIED_META_KEYS, CARRIED_SYNC_KEYS, SWAP_ITEMS, writeRecoveryNote } from './adopt.ts';
import { AT_UNLINK_KEEP_DAYS } from './backupInfo.ts';
import { clearJournal, LINK_ID_RE, writeJournal } from './journal.ts';
import type { LinkJournal } from './journal.ts';
import {
  backupDirOf, backupOf, CLOUD_RESET_REL, FOLLOW_REL, journalIsOpen, MOVES_REL, pathExists, STORE_ITEMS, writeFileAtomic,
} from './setAside.ts';
import type { BootHooks, BootResult } from './setAside.ts';
import { parseMoveList, stageDirOf, sweepStage } from './storeMove.ts';
import type { MoveList } from './storeMove.ts';
import { writeKeptNote } from './unlink.ts';

/*
 * "Teruskan dengan data sekarang" at a FOLLOWER (multi-box phase 2D, D3): the box runs alone on the reduced copy its
 * master made (`reducedCopy.ts`), pulled into `linkstage/<unlinkId>/` (`follow/reducedPull.ts`). SECURITY code.
 *
 * The plan (`link-reduce.json`, the pulled list) and the journal (op `reduce`) are written once the whole copy landed.
 * At the next start, BEFORE the database opens (`runReduce`, from `applyLinkJournalAtBoot`):
 *   `planned` the follow record and the complete stage are checked (else the plan is dropped: the box still follows);
 *   `clear`   the store the follower ran on goes (it held nothing of its own: its data is its backup of link day);
 *   `swap`    the copy moves into place;
 *   `apply`   the database opens and, in ONE transaction (a marker row makes a repeat a no-op), the box's own setup
 *             id, recovery code and cloud link come back from its backup of link day (a box that had none gets a new
 *             recovery code, shown once), the change log gets its marker and floor;
 * then the cloud key comes back from the backup with the cloud-reset mark (its sleeping cloud surau is made equal to
 * this store), the backup is kept 7 days ("Tukar pilihan" / "Buang data lama"), the follow record goes, and the stage,
 * the plan and the journal go. From `clear` on the op only goes forward.
 */

export const REDUCE_REL = 'link-reduce.json';
const UNLINK_ID_RE = /^[0-9a-f]{32}$/;

export interface ReducePlan {
  v: 1;
  /** The link this box followed by (its backup folder). */
  linkId: string;
  unlinkId: string;
  list: MoveList;
  followerName: string;
  masterName: string;
}

const planPath = (dataDir: string): string => join(dataDir, REDUCE_REL);

/** The copy landed: the next start runs on it. Throws `reduce: <code>` with `bad_link_id` or `journal_open`. */
export function planReduce(dataDir: string, plan: ReducePlan, now: Date): void {
  if (!LINK_ID_RE.test(plan.linkId) || !UNLINK_ID_RE.test(plan.unlinkId) || plan.list.linkId !== plan.unlinkId) throw new Error('reduce: bad_link_id');
  if (journalIsOpen(dataDir)) throw new Error('reduce: journal_open');
  writeFileAtomic(planPath(dataDir), JSON.stringify(plan));
  writeJournal(dataDir, { v: 1, op: 'reduce', linkId: plan.linkId, step: 'planned', at: now.toISOString(), dbLevel: plan.list.dbLevel, release: plan.list.release });
}

export function dropReducePlan(dataDir: string): void {
  rmSync(planPath(dataDir), { force: true });
  rmSync(`${planPath(dataDir)}.tmp`, { force: true });
}

function readPlan(dataDir: string, linkId: string): ReducePlan | null {
  try {
    const p = JSON.parse(readFileSync(planPath(dataDir), 'utf8')) as Partial<ReducePlan> | null;
    if (p === null || typeof p !== 'object' || p.v !== 1 || p.linkId !== linkId || typeof p.unlinkId !== 'string' || !UNLINK_ID_RE.test(p.unlinkId)) return null;
    if (typeof p.followerName !== 'string' || typeof p.masterName !== 'string') return null;
    // the list is read as strictly as the one that came from the master
    const list = parseMoveList(p.list, p.unlinkId);
    return { v: 1, linkId, unlinkId: p.unlinkId, list, followerName: p.followerName.slice(0, 80), masterName: p.masterName.slice(0, 80) };
  } catch {
    return null;
  }
}

function stageComplete(dataDir: string, p: ReducePlan): boolean {
  const root = stageDirOf(dataDir, p.unlinkId);
  return p.list.files.every((f) => {
    try {
      return statSync(join(root, ...f.path.split('/'))).size === f.size;
    } catch {
      return false;
    }
  });
}

function move(from: string, to: string): boolean {
  if (!pathExists(from)) return false;
  if (pathExists(to)) throw new Error(`reduce: collision at ${to}`);
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

/** The box's own rows of link day, read from its backup's database (read-only). Empty for a box that had no store. */
function ownOfBackup(dataDir: string, linkId: string): { meta: { surau_id: string; key: string; value: string | null }[]; sync: { key: string; value: string | null }[] } {
  const path = join(backupDirOf(dataDir, linkId), 'surau.db');
  if (!existsSync(path)) return { meta: [], sync: [] };
  let b: DatabaseSync | null = null;
  try {
    b = new DatabaseSync(path, { readOnly: true });
    const keys = ['surau_id', RECOVERY_META_KEY];
    const meta = b.prepare(`SELECT surau_id, key, value FROM meta WHERE key IN (${keys.map(() => '?').join(', ')})`).all(...keys)
      .map((r) => ({ surau_id: String(r.surau_id ?? 'sdm'), key: String(r.key), value: r.value === null ? null : String(r.value) }));
    const sync = b.prepare(`SELECT key, value FROM sync_state WHERE key IN (${CARRIED_SYNC_KEYS.map(() => '?').join(', ')})`).all(...CARRIED_SYNC_KEYS)
      .map((r) => ({ key: String(r.key), value: r.value === null ? null : String(r.value) }));
    return { meta, sync };
  } catch {
    return { meta: [], sync: [] };
  } finally {
    try {
      b?.close();
    } catch {
      // nothing more to do
    }
  }
}

const applied = (db: DatabaseSync, unlinkId: string): boolean =>
  db.prepare("SELECT 1 AS x FROM change_log WHERE entity = 'box' AND entity_id = ? AND actor = 'system:unlink' AND json_extract(after_json, '$.reason') = 'carry-on'").get(unlinkId) !== undefined;

export interface ReduceBootDeps {
  boxId: () => string;
  identity?: BoxIdentity;
  now?: () => Date;
}

export function runReduce(dataDir: string, j0: LinkJournal, h: BootHooks, deps: ReduceBootDeps): BootResult {
  const hook = (n: string): void => h.afterStep?.(n);
  const now = deps.now ?? (() => new Date());
  const plan = readPlan(dataDir, j0.linkId);
  const drop = (): BootResult => {
    if (plan !== null) sweepStage(dataDir, null);
    dropReducePlan(dataDir);
    clearJournal(dataDir);
    return 'dropped';
  };
  let j = j0;
  if (j.step === 'planned') {
    // only a follower carries on alone, and only with the whole copy
    if (plan === null || !existsSync(join(dataDir, FOLLOW_REL)) || !stageComplete(dataDir, plan)) return drop();
    j = { ...j, step: 'clear', done: [] };
    writeJournal(dataDir, j);
    hook('reduce:start');
  }
  if (plan === null) throw new Error('reduce: plan lost after the store moved');

  if (j.step === 'clear') {
    for (const item of STORE_ITEMS) {
      rmSync(join(dataDir, item.rel), { recursive: true, force: true });
      hook(`reduce:clear:${item.rel}`);
    }
    j = { ...j, step: 'swap', done: [] };
    writeJournal(dataDir, j);
    hook('reduce:clear-done');
  }

  if (j.step === 'swap') {
    const stage = stageDirOf(dataDir, plan.unlinkId);
    for (const rel of SWAP_ITEMS) {
      if (move(join(stage, ...rel.split('/')), join(dataDir, ...rel.split('/')))) hook(`reduce:swap:${rel}`);
    }
    if (!existsSync(join(dataDir, 'surau.db'))) throw new Error('reduce: no database after the swap');
    j = { ...j, step: 'apply', done: [] };
    writeJournal(dataDir, j);
    hook('reduce:swap-done');
  }

  // step `apply`: repeatable (the marker row makes a second run change nothing)
  const own = ownOfBackup(dataDir, j.linkId);
  const linked = own.sync.some((r) => r.key === 'linked' && r.value === '1');
  const db = openDb(join(dataDir, 'surau.db'));
  try {
    if (!applied(db, plan.unlinkId)) {
      const at = now().toISOString();
      const recovery = own.meta.find((r) => r.key === RECOVERY_META_KEY && r.value !== null) ?? null;
      const fresh = recovery === null ? newRecoveryCode() : null;
      // the plain code is kept (sealed) BEFORE its hash is committed: a stop between the two leaves a note for a hash
      // that a repeat replaces with a new pair, never a hash with no code
      if (fresh !== null) writeRecoveryNote(dataDir, deps.identity ?? loadIdentity(dataDir), j.linkId, deps.boxId(), fresh.code);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`DELETE FROM meta WHERE key IN (?, ${CARRIED_META_KEYS.filter((k) => k !== 'box_name' && k !== 'box_name_basis').map(() => '?').join(', ')})`)
          .run(RECOVERY_META_KEY, ...CARRIED_META_KEYS.filter((k) => k !== 'box_name' && k !== 'box_name_basis'));
        for (const r of own.meta) {
          if (r.key === RECOVERY_META_KEY) continue;
          db.prepare('INSERT INTO meta (surau_id, key, value) VALUES (?, ?, ?)').run(r.surau_id, r.key, r.value);
        }
        db.prepare('INSERT INTO meta (surau_id, key, value) VALUES (?, ?, ?)').run('sdm', RECOVERY_META_KEY, recovery?.value ?? fresh!.hash);
        for (const r of own.sync) {
          db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(r.key, r.value);
        }
        const head = Number(db.prepare('SELECT MAX(id) AS n FROM change_log').get()?.n ?? 0);
        const marker = (Number.isSafeInteger(head) ? head : 0) + 1;
        db.prepare(
          `INSERT INTO change_log (surau_id, id, at, actor, entity, entity_id, before_json, after_json, origin)
           VALUES ('sdm', ?, ?, 'system:unlink', 'box', ?, NULL, ?, 'local')`,
        ).run(marker, at, plan.unlinkId, JSON.stringify({ reason: 'carry-on', linkId: j.linkId }));
        db.prepare("INSERT INTO sync_state (key, value) VALUES ('log_floor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(marker));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  } finally {
    db.close();
  }
  hook('reduce:applied');
  // the box's own cloud link of link day comes back; its cloud copy is made equal to this store before any sync
  const backup = backupDirOf(dataDir, j.linkId);
  if (linked && existsSync(join(backup, 'secret', 'sync.key'))) {
    for (const rel of ['secret/sync.key', 'secret/sync.claim']) copyIfMissing(join(backup, ...rel.split('/')), join(dataDir, ...rel.split('/')));
    writeFileAtomic(join(dataDir, CLOUD_RESET_REL), JSON.stringify({ v: 1, linkId: j.linkId, at: j.at, reason: 'reduce' }));
  }
  hook('reduce:cloud');
  // the data of link day is kept 7 days: "Tukar pilihan" goes back to it, "Buang data lama" drops it
  if (backupOf(dataDir, j.linkId) !== null) {
    writeKeptNote(dataDir, {
      v: 1, linkId: j.linkId, side: 'follower', chosen: 'carry-on', folder: j.linkId,
      keptUntil: new Date(now().getTime() + AT_UNLINK_KEEP_DAYS * 86_400_000).toISOString(),
      followerName: plan.followerName, masterName: plan.masterName, finishedAt: now().toISOString(), outcome: 'done', unlinkId: plan.unlinkId,
    });
  }
  hook('reduce:kept');
  // the box runs alone now
  rmSync(join(dataDir, 'follow'), { recursive: true, force: true });
  rmSync(join(dataDir, MOVES_REL), { force: true });
  rmSync(join(dataDir, FOLLOW_REL), { force: true });
  hook('reduce:follow-removed');
  sweepStage(dataDir, null);
  dropReducePlan(dataDir);
  clearJournal(dataDir);
  hook('reduce:cleared');
  return 'reduce';
}

/** At a start with no reduce journal: a plan file is what a cut-short copy left. */
export function sweepReduceLeftovers(dataDir: string, journal: LinkJournal | null): void {
  if (journal !== null && journal.op === 'reduce') return;
  dropReducePlan(dataDir);
}
