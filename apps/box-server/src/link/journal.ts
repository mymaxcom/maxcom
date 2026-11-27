import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { isKeptList } from './keepAdmins.ts';
import type { KeptDevice } from './keepAdmins.ts';

/**
 * The step journal of a store move (`link.json`, next to `box.json` in the data folder).
 *
 * It lives OUTSIDE every folder a link moves (`surau.db`, `assets/`, `secret/` items ...), because the store is what
 * moves. One journal at a time: a second operation is refused while one is open. Every write is atomic (temp file,
 * fsync, rename), so a power cut leaves either the old journal or the new one, never half of one.
 *
 * Steps by operation (written by `setAside.ts`):
 * - `set-aside`: `planned`, `moving`, `manifest`
 * - `restore`: `planned`, `aside`, `back`, `follow`
 * - `drop-at-unlink`: `planned`
 * - `forget`: `planned` (a follower taken off its surau empties itself)
 * - `adopt` (written by `adopt.ts`, cases X and N-X at the new master): `planned`, `set-aside`, `swap`, `adopt`
 * - `reduce` (written by `reduce.ts`, a follower that carries on alone with the copy its master gave): `planned`,
 *   `clear`, `swap`, `apply`
 */
export type JournalOp = 'set-aside' | 'restore' | 'drop-at-unlink' | 'forget' | 'adopt' | 'reduce';

export interface LinkJournal {
  v: 1;
  op: JournalOp;
  linkId: string;
  step: string;
  /** ISO time of the plan: the commit point, by this box's clock. */
  at: string;
  /** A set-aside is only carried out when the follow record exists at the next start. */
  needsFollow?: boolean;
  /** Items (relative store paths) finished in the current step. */
  done?: string[];
  /** Software version and database level at the plan, for the manifest. */
  release?: string;
  dbLevel?: number;
  /**
   * A restore: the recovery code hash in use (planned, and read again at the swap), carried into the store that comes
   * back (SECURITY). `null` is an explicit "none": the live store had no code, so the restored one loses its old hash.
   * Absent: it could not be read, the restored store keeps its own.
   */
  recoveryHash?: string | null;
  /** A restore: the Pentadbir phones of the store in use that the restore keeps (SECURITY, `keepAdmins.ts`). Absent: none. */
  keepDevices?: KeptDevice[];
}

export const LINK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OPS: readonly string[] = ['set-aside', 'restore', 'drop-at-unlink', 'forget', 'adopt', 'reduce'];

export const journalPath = (dataDir: string): string => join(dataDir, 'link.json');

function parse(raw: string): LinkJournal {
  const j = JSON.parse(raw) as Partial<LinkJournal> | null;
  if (
    j === null ||
    typeof j !== 'object' ||
    j.v !== 1 ||
    typeof j.op !== 'string' ||
    !OPS.includes(j.op) ||
    typeof j.linkId !== 'string' ||
    !LINK_ID_RE.test(j.linkId) ||
    typeof j.step !== 'string' ||
    typeof j.at !== 'string' ||
    (j.needsFollow !== undefined && typeof j.needsFollow !== 'boolean') ||
    (j.done !== undefined && !(Array.isArray(j.done) && j.done.every((d) => typeof d === 'string'))) ||
    (j.release !== undefined && typeof j.release !== 'string') ||
    (j.dbLevel !== undefined && typeof j.dbLevel !== 'number') ||
    (j.recoveryHash !== undefined && j.recoveryHash !== null && !(typeof j.recoveryHash === 'string' && /^[0-9a-f]{64}$/.test(j.recoveryHash))) ||
    (j.keepDevices !== undefined && !isKeptList(j.keepDevices))
  ) {
    throw new Error('journal: unreadable');
  }
  return j as LinkJournal;
}

/** The open journal, null when there is none. Throws `journal: unreadable` for a file that is not a journal. */
export function readJournal(dataDir: string): LinkJournal | null {
  let raw: string;
  try {
    raw = readFileSync(journalPath(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return parse(raw);
  } catch {
    throw new Error('journal: unreadable');
  }
}

/** Atomic write: temp file, fsync, rename, then a best-effort fsync of the folder. */
export function writeJournal(dataDir: string, journal: LinkJournal): void {
  mkdirSync(dataDir, { recursive: true });
  const path = journalPath(dataDir);
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(journal));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  syncFolder(dataDir);
}

export function clearJournal(dataDir: string): void {
  rmSync(journalPath(dataDir), { force: true });
  rmSync(`${journalPath(dataDir)}.tmp`, { force: true });
  syncFolder(dataDir);
}

function syncFolder(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Windows cannot open a folder for fsync; the rename above is what matters there
  }
}
