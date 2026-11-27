import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { deleteEmptySurau, surauUsage } from './registry.ts';

/**
 * Clearing out empty suraus (cloud). A surau is empty by `surauUsage` (nothing in any surau table except the audit,
 * the version counter, the prayer cache and unclaimed approvals; no live box). `surau-prune` and the daily automatic
 * prune delete only those, and write a database backup first.
 */

/** The pre-prune backup failed, so nothing was deleted. Not an app-facing error code: prune never runs from a route. */
export class PruneBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PruneBackupError';
  }
}

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

/** How many `pre-prune-*` backups (plain `.db` and encrypted `.db.age` together) are kept in the backups folder. */
export const KEEP_BACKUPS = 7;
const BACKUP_RE = /^pre-prune-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}\.db(\.age)?$/;
const PLAIN_RE = /^pre-prune-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}\.db$/;
/** Backups written before a reset-from-box (multi-box 2B) are kept by AGE: 30 days, whatever their number. */
export const RESET_BACKUP_KEEP_MS = 30 * 24 * HOUR_MS;
const RESET_BACKUP_RE = /^pre-reset-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]{6}\.db(\.age)?$/;
/** An age X25519 public recipient. Anything else is never handed to a command. */
const RECIPIENT_RE = /^age1[0-9a-z]{58}$/;
export const DEFAULT_BACKUP_RECIPIENT_FILE = '/etc/maxcom/backup.recipient';
const AGE_TIMEOUT_MS = 120_000;

/** Encrypts `plainPath` to `outPath` for `recipient`; throws when it cannot. Injectable for tests. */
export type EncryptFn = (plainPath: string, outPath: string, recipient: string) => void;

export interface BackupOptions {
  env?: NodeJS.ProcessEnv;
  /** Explicit recipient (`null` = none: refused unless `allowPlain`); default: read from MAXCOM_BACKUP_RECIPIENT_FILE. */
  recipient?: string | null;
  /** Allow an UNENCRYPTED copy when there is no valid recipient (also env MAXCOM_PRUNE_PLAIN_BACKUP=1). Default: refused. */
  allowPlain?: boolean;
  encrypt?: EncryptFn;
  /** Removes a file; injectable for tests (default: rmSync with force). A failure is reported, never hidden. */
  remove?: (path: string) => void;
  log?: (line: string) => void;
  /** `reset`: a `pre-reset-*` backup, kept 30 days by age (default `prune`: `pre-prune-*`, the newest 7 kept). */
  kind?: 'prune' | 'reset';
}

type RecipientLookup = { recipient: string } | { reason: 'missing' | 'invalid'; file: string };

function lookupRecipient(env: NodeJS.ProcessEnv): RecipientLookup {
  const file = (env.MAXCOM_BACKUP_RECIPIENT_FILE ?? '').trim() || DEFAULT_BACKUP_RECIPIENT_FILE;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8').trim();
  } catch {
    return { reason: 'missing', file };
  }
  return RECIPIENT_RE.test(raw) ? { recipient: raw } : { reason: 'invalid', file };
}

/**
 * The backup recipient (public age key) from the file named by env MAXCOM_BACKUP_RECIPIENT_FILE (default
 * /etc/maxcom/backup.recipient), or null when the file is missing, unreadable or does not hold a valid recipient.
 */
export function backupRecipient(env: NodeJS.ProcessEnv = process.env, log?: (line: string) => void): string | null {
  const found = lookupRecipient(env);
  if ('recipient' in found) return found.recipient;
  if (found.reason === 'invalid') log?.('prune: fail penerima sandaran tidak sah (bukan kunci awam age)');
  return null;
}

/** The real encrypt step: the `age` binary, no shell, arguments as an array. */
export function ageEncrypt(plainPath: string, outPath: string, recipient: string, env: NodeJS.ProcessEnv = process.env): void {
  const bin = (env.MAXCOM_AGE_BIN ?? '').trim() || 'age';
  const r = spawnSync(bin, ['-r', recipient, '-o', outPath, plainPath], { timeout: AGE_TIMEOUT_MS, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  if (r.error) throw new Error(`age gagal: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`age gagal (kod ${String(r.status ?? r.signal)})`);
}

function rmQuiet(path: string, remove?: (path: string) => void): void {
  try {
    if (remove) remove(path);
    else rmSync(path, { force: true });
  } catch {
    // keep going; callers that must know check existsSync afterwards
  }
}

/**
 * Encrypts one plain copy to `<plain>.age` (0600) and removes the plain file. On failure the partial .age goes too and it
 * throws; the plain file is then removed as well when `dropPlainOnFail` (the fresh copy: never left behind), and kept
 * for an older copy (it is deleted only after its .age was written non-empty).
 */
function encryptAndRemovePlain(
  plain: string,
  recipient: string,
  encrypt: EncryptFn,
  dropPlainOnFail: boolean,
  remove?: (path: string) => void,
  log?: (line: string) => void,
): string {
  const out = `${plain}.age`;
  try {
    encrypt(plain, out, recipient);
    if (!existsSync(out) || statSync(out).size === 0) throw new Error('age gagal: fail keluaran tiada atau kosong');
    bestChmod(out, 0o600);
  } catch (error) {
    if (dropPlainOnFail) rmQuiet(plain, remove);
    rmQuiet(out, remove);
    if (dropPlainOnFail && existsSync(plain)) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(`${why}; AMARAN: salinan biasa (tidak disulitkan) tidak dapat dibuang dan masih ada: ${plain}`);
    }
    throw error;
  }
  rmQuiet(plain, remove);
  if (existsSync(plain)) {
    log?.(`prune: AMARAN: sandaran disulitkan ditulis (${out}) tetapi salinan biasa tidak dapat dibuang dan masih ada: ${plain}; buang dengan tangan`);
  }
  return out;
}

/**
 * Every empty, not suspended surau whose age is over `olderThanMs`, oldest first. Age counts from the latest of the
 * surau's creation and any approval of a box into it (an approval reused today makes the surau young again).
 */
export function emptySuraus(db: DatabaseSync, olderThanMs: number, now: Date): PruneCandidate[] {
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
  return db
    .prepare(
      `SELECT s.id, s.name, s.created_at FROM suraus s
        WHERE s.created_at < ? AND s.suspended_at IS NULL AND s.asleep_at IS NULL
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
 * file 0600. Encryption fails CLOSED: without a valid age recipient (file MAXCOM_BACKUP_RECIPIENT_FILE or `opts.recipient`)
 * it THROWS before any file is written, so nothing is pruned without an encrypted backup; a plain copy is written only
 * when `opts.allowPlain` or env MAXCOM_PRUNE_PLAIN_BACKUP=1 says so (and one line says it is not encrypted). With a
 * recipient the copy is encrypted with `age` to `<name>.db.age` and the plain copy is removed (always); if encryption
 * fails nothing is left behind and it THROWS, so nothing is deleted without a backup. Only the newest KEEP_BACKUPS
 * files of that exact name pattern (plain and encrypted together) are kept; older plain copies still in the folder are
 * encrypted when a recipient exists (a failure there is logged only). Returns the path.
 */
export function backupBeforePrune(db: DatabaseSync, dir: string, now: Date, opts: BackupOptions = {}): string {
  const env = opts.env ?? process.env;
  const plainAllowed = opts.allowPlain === true || env.MAXCOM_PRUNE_PLAIN_BACKUP === '1';
  let recipient: string | null = null;
  let whyNone = '';
  if (typeof opts.recipient === 'string') recipient = opts.recipient;
  else if (opts.recipient === null) whyNone = 'tiada penerima sandaran diberi';
  else {
    const found = lookupRecipient(env);
    if ('recipient' in found) recipient = found.recipient;
    else if (found.reason === 'missing') whyNone = `fail penerima sandaran ${found.file} tiada atau tidak boleh dibaca`;
    else whyNone = `kandungan fail penerima sandaran ${found.file} bukan kunci awam age yang sah`;
  }
  if (recipient === null && !plainAllowed) {
    throw new Error(`${whyNone}; sandaran tanpa sulit tidak dibenarkan (tiada surau dipadam). Tetapkan kunci awam age yang sah, atau benarkan salinan biasa dengan MAXCOM_PRUNE_PLAIN_BACKUP=1`);
  }
  const encrypt: EncryptFn = opts.encrypt ?? ((plain, out, rcpt) => ageEncrypt(plain, out, rcpt, env));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  bestChmod(dir, 0o700);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const prefix = opts.kind === 'reset' ? 'pre-reset' : 'pre-prune';
  const plain = join(dir, `${prefix}-${stamp}-${randomBytes(3).toString('hex')}.db`);
  let path = plain;
  try {
    db.prepare('VACUUM INTO ?').run(plain);
    bestChmod(plain, 0o600);
    if (recipient !== null) path = encryptAndRemovePlain(plain, recipient, encrypt, true, opts.remove, opts.log);
    else opts.log?.('prune: sandaran pra-pangkas tidak disulitkan (dibenarkan secara jelas)');
  } catch (error) {
    rmQuiet(plain, opts.remove);
    const msg = error instanceof Error ? error.message : String(error);
    if (existsSync(plain) && !msg.includes(plain)) {
      throw new Error(`${msg}; AMARAN: salinan biasa (tidak disulitkan) tidak dapat dibuang dan masih ada: ${plain}`);
    }
    throw error;
  }
  if (opts.kind === 'reset') {
    sweepResetBackups(dir, now, opts.remove);
    return path;
  }
  const names = readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort().reverse();
  for (const f of names.slice(KEEP_BACKUPS)) rmQuiet(join(dir, f), opts.remove);
  if (recipient !== null) {
    for (const f of names.slice(0, KEEP_BACKUPS)) {
      if (!PLAIN_RE.test(f)) continue;
      try {
        encryptAndRemovePlain(join(dir, f), recipient, encrypt, false, opts.remove, opts.log);
      } catch (error) {
        opts.log?.(`prune: sandaran lama ${f} gagal disulitkan: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return path;
}

/** Removes the `pre-reset-*` backups older than 30 days (by the time in their name). Returns the names removed. */
export function sweepResetBackups(dir: string, now: Date, remove?: (path: string) => void): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const gone: string[] = [];
  for (const f of names) {
    const m = RESET_BACKUP_RE.exec(f);
    if (m === null) continue;
    const at = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
    if (Number.isFinite(at) && now.getTime() - at > RESET_BACKUP_KEEP_MS) {
      rmQuiet(join(dir, f), remove);
      gone.push(f);
    }
  }
  return gone;
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
  /** Backup settings (env, explicit recipient, injectable encrypt step); default: the process env. */
  backup?: Omit<BackupOptions, 'log'>;
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
  const candidates = emptySuraus(db, o.olderThanMs, o.now);
  // with apply and candidates, nothing is modified until the backup has succeeded
  let backup: string | null = null;
  if (o.apply === true && candidates.length > 0) {
    try {
      backup = backupBeforePrune(db, o.backupDir, o.now, { ...o.backup, ...(o.log ? { log: o.log } : {}) });
    } catch (error) {
      // no backup, no delete, no orphan cleanup: nothing was touched
      const why = error instanceof Error ? error.message : String(error);
      o.log?.(`prune: sandaran gagal, tiada surau dipadam (${why})`);
      throw new PruneBackupError(`Sandaran pangkalan data gagal (${why}); tiada surau dipadam`);
    }
  }
  // orphan cache rows: removed on apply, only reported on a dry run
  const orphans = o.apply === true ? removeOrphanCache(db) : orphanCacheRows(db);
  if (orphans.prayerDays + orphans.meta > 0) {
    o.log?.(`prune: cache yatim ${o.apply === true ? 'dibuang' : 'ditemui'} (prayer_days ${orphans.prayerDays}, meta ${orphans.meta})`);
  }
  if (o.apply !== true || backup === null) return { candidates, deleted: [], backup: null };
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
  backup?: Omit<BackupOptions, 'log'>;
}

/** The daily automatic prune (cloud only). Returns the stop function. */
export function startAutoPrune(o: AutoPruneOptions): () => void {
  if (o.days <= 0) return () => undefined;
  const log = o.log ?? ((line: string): void => console.log(line));
  const tick = (): void => {
    // the reset backups age out on the same daily beat, whether or not a surau is pruned
    sweepResetBackups(o.backupDir, o.now());
    try {
      pruneEmptySuraus(o.db, { now: o.now(), olderThanMs: o.days * 24 * HOUR_MS, apply: true, backupDir: o.backupDir, ...(o.backup ? { backup: o.backup } : {}), ...(o.onDeleted ? { onDeleted: o.onDeleted } : {}), log });
    } catch (error) {
      // a PruneBackupError was already logged (one line) by pruneEmptySuraus: do not report it again
      if (error instanceof PruneBackupError) return;
      log(`prune: larian automatik gagal: ${error instanceof Error ? error.message : String(error)}`);
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
