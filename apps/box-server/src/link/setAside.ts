import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { MIGRATIONS } from '../migrations/index.ts';
import { boxVersion } from '../productVersion.ts';
import { recoveryHashOf } from '../setup/codes.ts';
import { adminDevices } from './keepAdmins.ts';
import type { KeptDevice } from './keepAdmins.ts';
import { clearJournal, LINK_ID_RE, journalPath, readJournal, writeJournal } from './journal.ts';
import type { LinkJournal } from './journal.ts';

/*
 * What a "store" is, and what never moves (the controller reviews this table).
 *
 * MOVED (set aside at the commit point, put back at a restore), all relative to the data folder:
 *
 *   surau.db, surau.db-wal, surau.db-shm   the database: content, people, PIN hashes, device rows, pairings, finance
 *                                          rows, the prayer days (they live in the database, not in files)
 *   assets/                                pictures and videos
 *   finance/photos/                        finance receipt photos
 *   themes/                                installed theme packs
 *   import/                                spreadsheet import scratch (also swept by removeLegacyImportDir at start)
 *   secret/sync.key, secret/sync.claim     the cloud link key and its claim file
 *   secret/youtube-token.json              the YouTube sign-in
 *   secret/youtube-state.json              the YouTube live state
 *   live/youtube-open.json                 the open YouTube broadcast record
 *   secret/live-camera.json                the camera record
 *
 * STAYS (never moved, never deleted by this code):
 *
 *   secret/box.key, secret/identity.key    the box key and the identity key (every sealed secret hangs on them)
 *   secret/follow.json                     the follow record (removed only by a restore, which ends the follow)
 *   secret/box.pfx, pfx.pass, box-key.pem, tls.json, mediamtx.pass, mediamtx.yml, youtube-client.json
 *                                          TLS files and tool files (not surau data)
 *   pki/                                   the box CA and leaf
 *   box.json                               the setup state
 *   link.json                              the step journal (outside every moved folder, on purpose)
 *   linkundo/, linkstage/                  the backups themselves and the staging area of a later phase
 *   logs/, update/, live/ (but the open-broadcast record above), islamic/ (a downloaded public cache of Quran text
 *   and audio, the same on every box)
 *   release folders and the install root (outside the data folder)
 */

export type StoreItemGroup = 'db' | 'media' | 'secret';
export interface StoreItem {
  /** Path relative to the data folder, forward slashes. */
  rel: string;
  kind: 'file' | 'dir';
  group: StoreItemGroup;
  /** Which sign-in a secret file is (sign-out removes it from every backup). */
  secret?: 'cloud' | 'youtube' | 'camera';
}

export const STORE_ITEMS: readonly StoreItem[] = [
  { rel: 'surau.db', kind: 'file', group: 'db' },
  { rel: 'surau.db-wal', kind: 'file', group: 'db' },
  { rel: 'surau.db-shm', kind: 'file', group: 'db' },
  { rel: 'assets', kind: 'dir', group: 'media' },
  { rel: 'finance/photos', kind: 'dir', group: 'media' },
  { rel: 'themes', kind: 'dir', group: 'media' },
  { rel: 'import', kind: 'dir', group: 'media' },
  { rel: 'secret/sync.key', kind: 'file', group: 'secret', secret: 'cloud' },
  { rel: 'secret/sync.claim', kind: 'file', group: 'secret', secret: 'cloud' },
  { rel: 'secret/youtube-token.json', kind: 'file', group: 'secret', secret: 'youtube' },
  { rel: 'secret/youtube-state.json', kind: 'file', group: 'secret', secret: 'youtube' },
  { rel: 'live/youtube-open.json', kind: 'file', group: 'secret', secret: 'youtube' },
  { rel: 'secret/live-camera.json', kind: 'file', group: 'secret', secret: 'camera' },
];

/** A file larger than this is listed in the manifest with `sha256: null`: start-up on a T95 must not wait minutes. */
export const HASH_FILE_CAP = 64 * 1024 * 1024;
/** Per manifest: once this many bytes were hashed, the remaining files are listed with `sha256: null` too. */
export const HASH_TOTAL_CAP = 256 * 1024 * 1024;

export type ManifestKind = 'set-aside' | 'copy' | 'at-unlink';
export interface ManifestFile {
  path: string;
  size: number;
  sha256: string | null;
}
export interface BackupManifest {
  v: 1;
  kind: ManifestKind;
  linkId: string;
  /** The commit point (ISO), by this box's clock. */
  at: string;
  release: string;
  dbLevel: number;
  files: ManifestFile[];
  bytes: number;
  /** `copy` only: `hardlink` (media files are second names) or `keep-on-delete` (see `backupCopy.ts`). */
  mode?: 'hardlink' | 'keep-on-delete';
}

export interface BackupEntry {
  folder: string;
  atUnlink: boolean;
  manifest: BackupManifest;
}

export const FOLLOW_REL = 'secret/follow.json';
/** Phase 2C: the phone-move list, removed wherever the follow record is (`follow/moves.ts`). */
export const MOVES_REL = 'secret/follow-moves.json';
/** Left by a restore for the first start on the restored store: every device row of that store is revoked then. */
export const RESTORED_REL = 'link-restored.json';
/** While this file exists the box does not sync with the cloud: the cloud copy must first be made equal to the box. */
export const CLOUD_RESET_REL = 'link-cloud-reset.json';
const AT_UNLINK = '-at-unlink';
const MANIFEST = 'manifest.json';

export const undoRoot = (dataDir: string): string => join(dataDir, 'linkundo');
export const backupDirOf = (dataDir: string, folder: string): string => join(undoRoot(dataDir), folder);
export const atUnlinkFolder = (linkId: string): string => `${linkId}${AT_UNLINK}`;

export function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Write a file so a power cut leaves the old one or the new one: temp file, fsync, rename. */
export function writeFileAtomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Size and SHA-256 (hex) of a file; `sha256` null above `cap`. Reads in 1 MB blocks. */
export function hashFileSync(path: string, cap: number = HASH_FILE_CAP): { size: number; sha256: string | null } {
  const size = statSync(path).size;
  if (size > cap) return { size, sha256: null };
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return { size, sha256: hash.digest('hex') };
}

/** Every regular file below `root` (relative, forward slashes, sorted); links and special files are not followed. */
export function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(join(abs, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

export interface HashLimits {
  hashFileCap?: number;
  hashTotalCap?: number;
}

/** The manifest's file list for a folder: sizes exact, hashes up to the caps. `manifest.json` itself is not listed. */
export function listManifestFiles(root: string, limits: HashLimits = {}): { files: ManifestFile[]; bytes: number } {
  const fileCap = limits.hashFileCap ?? HASH_FILE_CAP;
  let budget = limits.hashTotalCap ?? HASH_TOTAL_CAP;
  const files: ManifestFile[] = [];
  let bytes = 0;
  for (const path of walkFiles(root)) {
    if (path === MANIFEST) continue;
    const abs = join(root, path);
    const size = statSync(abs).size;
    let sha256: string | null = null;
    if (size <= fileCap && size <= budget) {
      sha256 = hashFileSync(abs, fileCap).sha256;
      budget -= size;
    }
    files.push({ path, size, sha256 });
    bytes += size;
  }
  return { files, bytes };
}

export function writeManifest(dir: string, manifest: BackupManifest): void {
  writeFileAtomic(join(dir, MANIFEST), JSON.stringify(manifest));
}

function parseManifest(raw: string): BackupManifest | null {
  try {
    const m = JSON.parse(raw) as Partial<BackupManifest> | null;
    if (
      m === null ||
      typeof m !== 'object' ||
      m.v !== 1 ||
      (m.kind !== 'set-aside' && m.kind !== 'copy' && m.kind !== 'at-unlink') ||
      typeof m.linkId !== 'string' ||
      !LINK_ID_RE.test(m.linkId) ||
      typeof m.at !== 'string' ||
      typeof m.release !== 'string' ||
      typeof m.dbLevel !== 'number' ||
      typeof m.bytes !== 'number' ||
      !Array.isArray(m.files) ||
      !m.files.every((f) => f !== null && typeof f === 'object' && typeof f.path === 'string' && typeof f.size === 'number' && (f.sha256 === null || typeof f.sha256 === 'string')) ||
      (m.mode !== undefined && m.mode !== 'hardlink' && m.mode !== 'keep-on-delete')
    ) {
      return null;
    }
    return m as BackupManifest;
  } catch {
    return null;
  }
}

export function readManifest(dir: string): BackupManifest | null {
  try {
    return parseManifest(readFileSync(join(dir, MANIFEST), 'utf8'));
  } catch {
    return null;
  }
}

/** The manifest of the backup of that link, or null. */
export function backupOf(dataDir: string, linkId: string): BackupManifest | null {
  if (!LINK_ID_RE.test(linkId)) return null;
  return readManifest(backupDirOf(dataDir, linkId));
}

/** Every complete backup folder (finished ones only: `.partial` and `.dropping` folders are not listed). */
export function listBackups(dataDir: string): BackupEntry[] {
  let names: string[];
  try {
    names = readdirSync(undoRoot(dataDir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const out: BackupEntry[] = [];
  for (const folder of names.sort()) {
    const manifest = readManifest(backupDirOf(dataDir, folder));
    if (manifest === null) continue;
    out.push({ folder, atUnlink: folder.endsWith(AT_UNLINK), manifest });
  }
  return out;
}

type DevOf = (path: string) => number | bigint;
const statDev: DevOf = (p) => statSync(p).dev;

export interface PlanOptions {
  /** The device number of a path (default `statSync(p).dev`); tests inject another volume. */
  devOf?: DevOf;
  release?: string;
  dbLevel?: number;
}

/** A move must never become a copy: the backup folder and every item (and its parent) must be on one volume. */
function onOneVolume(dataDir: string, devOf: DevOf): boolean {
  const undo = undoRoot(dataDir);
  const ref = BigInt(devOf(existsSync(undo) ? undo : dataDir));
  for (const item of STORE_ITEMS) {
    const path = join(dataDir, item.rel);
    if (!pathExists(path)) continue;
    if (BigInt(devOf(path)) !== ref || BigInt(devOf(dirname(path))) !== ref) return false;
  }
  return true;
}

export function journalIsOpen(dataDir: string): boolean {
  try {
    return readJournal(dataDir) !== null;
  } catch {
    return true;
  }
}

/**
 * Write the journal for a set-aside of the whole store into `linkundo/<linkId>/`. Nothing moves now: the move happens
 * at the next start, before the database opens (`applyLinkJournalAtBoot`). Throws `set-aside: <code>` with code
 * `bad_link_id`, `journal_open`, `backup_exists` or `other_volume`.
 */
export function planSetAside(dataDir: string, linkId: string, now: Date, opts: PlanOptions = {}): void {
  if (!LINK_ID_RE.test(linkId)) throw new Error('set-aside: bad_link_id');
  if (journalIsOpen(dataDir)) throw new Error('set-aside: journal_open');
  if (pathExists(backupDirOf(dataDir, linkId))) throw new Error('set-aside: backup_exists');
  if (!onOneVolume(dataDir, opts.devOf ?? statDev)) throw new Error('set-aside: other_volume');
  writeJournal(dataDir, {
    v: 1,
    op: 'set-aside',
    linkId,
    step: 'planned',
    at: now.toISOString(),
    needsFollow: true,
    release: opts.release ?? boxVersion(),
    dbLevel: opts.dbLevel ?? MIGRATIONS.length,
  });
}

/**
 * A follower store (its follow record is there) never carries a recovery hash across a restore: the follower's own way
 * back (and the master's order) verified the typed code against the restored store's hash, so that one must stay.
 */
function carriesRecovery(dataDir: string): boolean {
  return !existsSync(join(dataDir, FOLLOW_REL));
}

/**
 * SECURITY. The recovery code hash of the store in use now (read through a second, read-only handle on the database
 * file): the hash, `null` when the store has no code (carried as an explicit "none"), or `undefined` when it cannot be
 * read (logged; the restored store then keeps its own hash). The newest code an admin was shown must stay valid after
 * a restore, and the restored store holds the hash of link day, so the plan carries this one across the swap.
 */
function liveRecoveryHash(dataDir: string): string | null | undefined {
  let db: DatabaseSync | null = null;
  try {
    const path = join(dataDir, 'surau.db');
    if (!existsSync(path)) return undefined;
    db = new DatabaseSync(path, { readOnly: true });
    return recoveryHashOf(db);
  } catch (e) {
    // never the hash itself: only that the read failed and why
    console.error(`link: the recovery code of the store in use could not be read (${e instanceof Error ? e.message : 'unknown'}); the restored store keeps its own`);
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // nothing more to do
    }
  }
}

/**
 * SECURITY. The Pentadbir phones of the store in use now (read through a second, read-only handle): the ones a restore
 * keeps if the restored store agrees (`keepAdmins.ts`). `undefined` when the store cannot be read (logged): then the
 * restore keeps none, which is the safe side.
 */
function liveKeptDevices(dataDir: string): KeptDevice[] | undefined {
  let db: DatabaseSync | null = null;
  try {
    const path = join(dataDir, 'surau.db');
    if (!existsSync(path)) return undefined;
    db = new DatabaseSync(path, { readOnly: true });
    return adminDevices(db);
  } catch (e) {
    console.error(`link: the Pentadbir phones of the store in use could not be read (${e instanceof Error ? e.message : 'unknown'}); the restore keeps none`);
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // nothing more to do
    }
  }
}

/**
 * Write the journal for a restore of the backup of that link (a set-aside one or a `copy` one). The current store goes
 * to `linkundo/<linkId>-at-unlink/`, the backup comes back, the follow record is removed. Throws `restore: <code>`
 * with code `bad_link_id`, `journal_open`, `no_backup`, `at_unlink_exists` or `other_volume`.
 */
export function planRestore(dataDir: string, linkId: string, now: Date, opts: PlanOptions = {}): void {
  if (!LINK_ID_RE.test(linkId)) throw new Error('restore: bad_link_id');
  if (journalIsOpen(dataDir)) throw new Error('restore: journal_open');
  const manifest = backupOf(dataDir, linkId);
  if (manifest === null || manifest.kind === 'at-unlink') throw new Error('restore: no_backup');
  if (pathExists(backupDirOf(dataDir, atUnlinkFolder(linkId)))) throw new Error('restore: at_unlink_exists');
  if (!onOneVolume(dataDir, opts.devOf ?? statDev)) throw new Error('restore: other_volume');
  const recoveryHash = carriesRecovery(dataDir) ? liveRecoveryHash(dataDir) : undefined;
  const keepDevices = liveKeptDevices(dataDir);
  writeJournal(dataDir, {
    v: 1,
    op: 'restore',
    linkId,
    step: 'planned',
    at: now.toISOString(),
    release: opts.release ?? boxVersion(),
    dbLevel: opts.dbLevel ?? MIGRATIONS.length,
    ...(recoveryHash === undefined ? {} : { recoveryHash }),
    ...(keepDevices === undefined ? {} : { keepDevices }),
  });
}

/** What a follower holds besides its store: the mirror's copy of the master's screens and the staging area. */
const FOLLOWER_DIRS = ['follow', 'linkstage'] as const;

/**
 * SECURITY code. Write the journal that empties this box: the store it runs on, every backup under `linkundo/`, the
 * mirror's copy and, last, the follow record, so the next start is a first setup. Only a follower is ever emptied:
 * the caller has verified the master's signed order to forget (`follow/orders.ts`), and the start that carries the
 * plan out drops it when no follow record is there. Throws `forget: bad_link_id` or `forget: journal_open`.
 */
export function planForget(dataDir: string, linkId: string, now: Date): void {
  if (!LINK_ID_RE.test(linkId)) throw new Error('forget: bad_link_id');
  if (journalIsOpen(dataDir)) throw new Error('forget: journal_open');
  writeJournal(dataDir, { v: 1, op: 'forget', linkId, step: 'planned', at: now.toISOString() });
}

export interface BootHooks {
  /** Called after every finished step with its name; a test throws from it to stand for a power cut. */
  afterStep?: (name: string) => void;
  hashFileCap?: number;
  hashTotalCap?: number;
  /**
   * Cases X / N-X (`adopt` op): carries the adopt out (`runAdopt` of `adopt.ts`, bound to this box's id). Passed in,
   * not imported, because `adopt.ts` builds on this file. Without it an adopt journal stops the start.
   */
  adopt?: (dataDir: string, journal: LinkJournal, hooks: BootHooks) => BootResult;
  /** A follower that carries on alone after an unlink (`reduce` op, `reduce.ts`), passed in for the same reason. */
  reduce?: (dataDir: string, journal: LinkJournal, hooks: BootHooks) => BootResult;
}

export type BootResult = 'none' | 'dropped' | 'set-aside' | 'restore' | 'drop-at-unlink' | 'forget' | 'unreadable' | 'adopt' | 'reduce';

/** Rename one store item. false: the source is not there (never was, or an earlier run moved it). */
function moveItem(from: string, to: string): boolean {
  if (!pathExists(from)) return false;
  if (pathExists(to)) throw new Error(`link: collision at ${to}`);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  return true;
}

function moveAll(dataDir: string, j: LinkJournal, fromRoot: string, toRoot: string, tag: string, hook: (n: string) => void): LinkJournal {
  let cur = j;
  for (const item of STORE_ITEMS) {
    if (!moveItem(join(fromRoot, item.rel), join(toRoot, item.rel))) continue;
    cur = { ...cur, done: [...(cur.done ?? []), item.rel] };
    writeJournal(dataDir, cur);
    hook(`${tag}:${item.rel}`);
  }
  return cur;
}

function runSetAside(dataDir: string, j0: LinkJournal, h: BootHooks): BootResult {
  const hook = (n: string): void => h.afterStep?.(n);
  const dest = backupDirOf(dataDir, j0.linkId);
  let j = j0;
  if (j.step === 'planned') {
    // no follow record at this start: the link never happened, nothing moves
    if (j.needsFollow === true && !existsSync(join(dataDir, FOLLOW_REL))) {
      clearJournal(dataDir);
      return 'dropped';
    }
    j = { ...j, step: 'moving', done: [] };
    writeJournal(dataDir, j);
  }
  hook('set-aside:start');
  if (j.step === 'moving') {
    j = moveAll(dataDir, j, dataDir, dest, 'set-aside:moved', hook);
    j = { ...j, step: 'manifest' };
    writeJournal(dataDir, j);
    hook('set-aside:moved-all');
  }
  mkdirSync(dest, { recursive: true });
  const { files, bytes } = listManifestFiles(dest, h);
  writeManifest(dest, {
    v: 1,
    kind: 'set-aside',
    linkId: j.linkId,
    at: j.at,
    release: j.release ?? boxVersion(),
    dbLevel: j.dbLevel ?? MIGRATIONS.length,
    files,
    bytes,
  });
  hook('set-aside:manifest');
  clearJournal(dataDir);
  hook('set-aside:cleared');
  return 'set-aside';
}

const MEDIA_ITEMS = STORE_ITEMS.filter((i) => i.group === 'media');

function runRestore(dataDir: string, j0: LinkJournal, h: BootHooks): BootResult {
  const hook = (n: string): void => h.afterStep?.(n);
  const backup = backupDirOf(dataDir, j0.linkId);
  const aside = backupDirOf(dataDir, atUnlinkFolder(j0.linkId));
  let j = j0;
  if (j.step === 'planned') {
    if (readManifest(backup) === null) {
      clearJournal(dataDir);
      return 'dropped';
    }
    // the code may have been rotated since the plan: the store about to be set aside is still in place, read it again
    const fresh = carriesRecovery(dataDir) ? liveRecoveryHash(dataDir) : undefined;
    const { recoveryHash: planned, keepDevices: plannedKeep, ...rest } = j;
    const carried = fresh !== undefined ? fresh : planned;
    // the same for the Pentadbir phones: a phone revoked or a person demoted since the plan must not be kept
    const freshKeep = liveKeptDevices(dataDir);
    const keep = freshKeep !== undefined ? freshKeep : plannedKeep;
    j = { ...rest, ...(carried === undefined ? {} : { recoveryHash: carried }), ...(keep === undefined ? {} : { keepDevices: keep }), step: 'aside', done: [] };
    writeJournal(dataDir, j);
  }
  hook('restore:start');
  if (j.step === 'aside') {
    j = moveAll(dataDir, j, dataDir, aside, 'restore:aside', hook);
    mkdirSync(aside, { recursive: true });
    const { files, bytes } = listManifestFiles(aside, h);
    writeManifest(aside, {
      v: 1,
      kind: 'at-unlink',
      linkId: j.linkId,
      at: j.at,
      release: j.release ?? boxVersion(),
      dbLevel: j.dbLevel ?? MIGRATIONS.length,
      files,
      bytes,
    });
    j = { ...j, step: 'back', done: [] };
    writeJournal(dataDir, j);
    hook('restore:aside-done');
  }
  if (j.step === 'back') {
    const manifest = readManifest(backup);
    if (manifest === null) throw new Error('restore: backup manifest lost');
    j = moveAll(dataDir, j, backup, dataDir, 'restore:back', hook);
    if (manifest.kind === 'copy' && manifest.mode === 'keep-on-delete') {
      // only the files deleted or replaced after the link were kept in the backup; every other file the backup names
      // is still in the store that was just moved aside
      for (const f of manifest.files) {
        if (!MEDIA_ITEMS.some((i) => f.path === i.rel || f.path.startsWith(`${i.rel}/`))) continue;
        // a file that was replaced after the link is already back (the old one, from the backup); leave it
        if (pathExists(join(dataDir, f.path))) continue;
        if (moveItem(join(aside, f.path), join(dataDir, f.path))) hook(`restore:back:${f.path}`);
      }
    }
    j = { ...j, step: 'follow', done: [] };
    writeJournal(dataDir, j);
    hook('restore:back-done');
  }
  // SECURITY: the store that is back holds the device rows and sessions of link day. This mark makes the first start
  // on it revoke them before anything is served (`afterRestore.ts`); it is written before the journal can clear, and
  // lives outside the store.
  writeFileAtomic(join(dataDir, RESTORED_REL), JSON.stringify({ v: 1, linkId: j.linkId, at: j.at, ...(j.recoveryHash === undefined ? {} : { recoveryHash: j.recoveryHash }), ...(j.keepDevices === undefined ? {} : { keepDevices: j.keepDevices }) }));
  hook('restore:marked');
  // the box runs alone again
  rmSync(join(dataDir, FOLLOW_REL), { force: true });
  rmSync(join(dataDir, MOVES_REL), { force: true });
  hook('restore:follow-removed');
  rmSync(backup, { recursive: true, force: true });
  hook('restore:backup-removed');
  clearJournal(dataDir);
  hook('restore:cleared');
  return 'restore';
}

function runForget(dataDir: string, h: BootHooks): BootResult {
  const hook = (n: string): void => h.afterStep?.(n);
  // A box that follows nobody is never emptied by a journal, whoever wrote it.
  if (!existsSync(join(dataDir, FOLLOW_REL))) {
    clearJournal(dataDir);
    return 'dropped';
  }
  hook('forget:start');
  for (const item of STORE_ITEMS) {
    rmSync(join(dataDir, item.rel), { recursive: true, force: true });
    hook(`forget:${item.rel}`);
  }
  rmSync(undoRoot(dataDir), { recursive: true, force: true });
  hook('forget:backups');
  for (const rel of FOLLOWER_DIRS) rmSync(join(dataDir, rel), { recursive: true, force: true });
  // an emptied box keeps no note of a link or an unlink (secret/unlink-note.json, secret/link-cloud-sleep.json)
  for (const rel of [RESTORED_REL, CLOUD_RESET_REL, 'secret/unlink-note.json', 'secret/link-cloud-sleep.json']) rmSync(join(dataDir, rel), { force: true });
  hook('forget:mirror');
  // Last: while the record is there a start that was cut short comes back here and finishes.
  rmSync(join(dataDir, FOLLOW_REL), { force: true });
  rmSync(join(dataDir, MOVES_REL), { force: true });
  hook('forget:follow-removed');
  clearJournal(dataDir);
  hook('forget:cleared');
  return 'forget';
}

/**
 * Called once at start, BEFORE the database opens (the server cannot swap its open database, so every move of the
 * store happens here). Finishes whatever the journal says; every step can be repeated, so a kill at any point followed
 * by another call ends in exactly "fully old" (the plan was dropped) or "fully new", never between.
 */
export function applyLinkJournalAtBoot(dataDir: string, hooks: BootHooks = {}): BootResult {
  let j: LinkJournal | null;
  try {
    j = readJournal(dataDir);
  } catch {
    // not a journal we can trust: keep the file for a person to look at and start with the store as it is
    try {
      renameSync(journalPath(dataDir), `${journalPath(dataDir)}.bad`);
    } catch {
      // nothing more to do
    }
    console.error('link.json is unreadable; kept as link.json.bad and ignored');
    return 'unreadable';
  }
  if (j === null) return 'none';
  if (j.op === 'set-aside') return runSetAside(dataDir, j, hooks);
  if (j.op === 'restore') return runRestore(dataDir, j, hooks);
  if (j.op === 'forget') return runForget(dataDir, hooks);
  if (j.op === 'adopt') {
    if (hooks.adopt === undefined) throw new Error('link: an adopt journal needs the adopt runner');
    return hooks.adopt(dataDir, j, hooks);
  }
  if (j.op === 'reduce') {
    if (hooks.reduce === undefined) throw new Error('link: a reduce journal needs the reduce runner');
    return hooks.reduce(dataDir, j, hooks);
  }
  // drop-at-unlink: the kept data of an unlink is removed
  rmSync(backupDirOf(dataDir, atUnlinkFolder(j.linkId)), { recursive: true, force: true });
  clearJournal(dataDir);
  return 'drop-at-unlink';
}
