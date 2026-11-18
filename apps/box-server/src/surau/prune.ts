import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { deleteEmptySurau, surauUsage } from './registry.ts';

/**
 * Clearing out empty suraus (cloud). A surau is empty by `surauUsage` (nothing in any surau table except the audit,
 * the version counter, the prayer cache and unclaimed approvals; no live box). `surau-prune` and the daily automatic
 * prune delete only those, and write a database backup first.
 */

export const PRUNE_ACTOR = 'system:prune';
export const DEFAULT_AUTO_PRUNE_DAYS = 7;
const HOUR_MS = 3_600_000;

/** Env MAXCOM_AUTO_PRUNE_DAYS: a whole number of days; 0 = off; default 7. */
export function autoPruneDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.MAXCOM_AUTO_PRUNE_DAYS ?? '').trim();
  return /^\d{1,4}$/.test(raw) ? Number(raw) : DEFAULT_AUTO_PRUNE_DAYS;
}

export interface PruneCandidate {
  id: string;
  name: string;
  createdAt: string;
}

/** How many `pre-prune-*.db` backups are kept in the backups folder. */
export const KEEP_BACKUPS = 7;
const BACKUP_RE = /^pre-prune-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}\.db$/;

/**
 * Every empty, not suspended surau whose age is over `olderThanMs`, oldest first. Age counts from the latest of the
 * surau's creation and any approval of a box into it (an approval reused today makes the surau young again).
 */
export function emptySuraus(db: DatabaseSync, olderThanMs: number, now: Date): PruneCandidate[] {
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
  return db
    .prepare(
      `SELECT s.id, s.name, s.created_at FROM suraus s
        WHERE s.created_at < ? AND s.suspended_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM site_approvals a WHERE a.surau_id = s.id AND a.approved_at >= ?)
        ORDER BY s.created_at, s.id`,
    )
    .all(cutoff, cutoff)
    .filter((r) => surauUsage(db, String(r.id)).empty)
    .map((r) => ({ id: String(r.id), name: String(r.name), createdAt: String(r.created_at) }));
}

/** Rows of the prayer cache and the version counter whose surau no longer exists (an auto-fetch can write them after a delete). */
export function orphanCacheRows(db: DatabaseSync): { prayerDays: number; meta: number } {
  const n = (t: string): number =>
    Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE surau_id NOT IN (SELECT id FROM suraus) AND surau_id NOT IN ('sdm', '*')`).get()?.n ?? 0);
  return { prayerDays: n('prayer_days'), meta: n('meta') };
}

export function removeOrphanCache(db: DatabaseSync): { prayerDays: number; meta: number } {
  const found = orphanCacheRows(db);
  if (found.prayerDays > 0) db.exec("DELETE FROM prayer_days WHERE surau_id NOT IN (SELECT id FROM suraus) AND surau_id NOT IN ('sdm', '*')");
  if (found.meta > 0) db.exec("DELETE FROM meta WHERE surau_id NOT IN (SELECT id FROM suraus) AND surau_id NOT IN ('sdm', '*')");
  return found;
}

function bestChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Windows dev machines: not supported, not fatal
  }
}

/**
 * A consistent copy of the database in `<dir>/pre-prune-<UTC ms>-<random>.db` (`VACUUM INTO`), the folder 0700 and the
 * file 0600; only the newest KEEP_BACKUPS files of that exact name pattern are kept. Returns the path.
 */
export function backupBeforePrune(db: DatabaseSync, dir: string, now: Date): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  bestChmod(dir, 0o700);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `pre-prune-${stamp}-${randomBytes(3).toString('hex')}.db`);
  db.prepare('VACUUM INTO ?').run(path);
  bestChmod(path, 0o600);
  const old = readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort().reverse().slice(KEEP_BACKUPS);
  for (const f of old) {
    try {
      unlinkSync(join(dir, f));
    } catch {
      // keep going
    }
  }
  return path;
}

export interface PruneOptions {
  now: Date;
  olderThanMs: number;
  /** false (default): list only. */
  apply?: boolean;
  /** Where the backup goes when something is deleted. */
  backupDir: string;
  actor?: string;
  /** Called once per deleted surau, after the delete (drops in-memory per-surau state). */
  onDeleted?: (id: string) => void;
  log?: (line: string) => void;
}

export interface PruneResult {
  candidates: PruneCandidate[];
  deleted: PruneCandidate[];
  backup: string | null;
}

/**
 * List the empty suraus older than `olderThanMs`; with `apply`, write the backup (only when there is something to
 * delete) and delete them one by one (each in its own transaction; a surau that stopped being empty meanwhile is
 * skipped, never forced).
 */
export function pruneEmptySuraus(db: DatabaseSync, o: PruneOptions): PruneResult {
  // orphan cache rows: removed on apply, only reported on a dry run
  const orphans = o.apply === true ? removeOrphanCache(db) : orphanCacheRows(db);
  if (orphans.prayerDays + orphans.meta > 0) {
    o.log?.(`prune: cache yatim ${o.apply === true ? 'dibuang' : 'ditemui'} (prayer_days ${orphans.prayerDays}, meta ${orphans.meta})`);
  }
  const candidates = emptySuraus(db, o.olderThanMs, o.now);
  if (o.apply !== true || candidates.length === 0) return { candidates, deleted: [], backup: null };
  const backup = backupBeforePrune(db, o.backupDir, o.now);
  const deleted: PruneCandidate[] = [];
  for (const c of candidates) {
    try {
      deleteEmptySurau(db, c.id, o.actor ?? PRUNE_ACTOR);
    } catch {
      continue;
    }
    deleted.push(c);
    o.onDeleted?.(c.id);
    o.log?.(`prune: surau ${c.id} (${c.name}) dipadam (kosong, dicipta ${c.createdAt})`);
  }
  return { candidates, deleted, backup };
}

export interface AutoPruneOptions {
  db: DatabaseSync;
  now: () => Date;
  /** Delete empty suraus older than this many days; 0 = never. */
  days: number;
  backupDir: string;
  onDeleted?: (id: string) => void;
  log?: (line: string) => void;
  firstDelayMs?: number;
  intervalMs?: number;
}

/** The daily automatic prune (cloud only). Returns the stop function. */
export function startAutoPrune(o: AutoPruneOptions): () => void {
  if (o.days <= 0) return () => undefined;
  const log = o.log ?? ((line: string): void => console.log(line));
  const tick = (): void => {
    try {
      pruneEmptySuraus(o.db, { now: o.now(), olderThanMs: o.days * 24 * HOUR_MS, apply: true, backupDir: o.backupDir, ...(o.onDeleted ? { onDeleted: o.onDeleted } : {}), log });
    } catch (error) {
      console.error('auto prune failed', error);
    }
  };
  const first = setTimeout(tick, o.firstDelayMs ?? 5 * 60_000);
  const every = setInterval(tick, o.intervalMs ?? 24 * HOUR_MS);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
