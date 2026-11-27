import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../migrations/index.ts';
import { boxVersion } from '../productVersion.ts';
import { defaultVideoLimits, statfsFreeBytes } from '../assets/video.ts';
import type { FreeBytes } from '../assets/video.ts';
import { LINK_ID_RE } from './journal.ts';
import { backupDirOf, hashFileSync, HASH_FILE_CAP, HASH_TOTAL_CAP, journalIsOpen, listBackups, listManifestFiles, pathExists, STORE_ITEMS, undoRoot, walkFiles, writeManifest } from './setAside.ts';
import type { BackupManifest, ManifestFile } from './setAside.ts';

/*
 * The kept-data master's own backup, taken while the server runs (plan section 5, "Pre-link backup").
 *
 *   surau.db            a consistent copy (VACUUM INTO, the way surau/prune.ts does it)
 *   secret/ ... live/   copies of the small per-surau secret files
 *   assets/ finance/photos/ themes/ import/   a hard link for every file (a second name, no space)
 *
 * The folder is built as `linkundo/<linkId>.partial/` and renamed to `linkundo/<linkId>/` only when the manifest is
 * written, so a kill never leaves something that looks like a finished backup.
 *
 * Where hard links are missing (FAT, exFAT, a store on another volume) the manifest says `mode: 'keep-on-delete'`:
 * nothing is linked, and every site that deletes or replaces a media file must call `keepInBackupBeforeDelete` first,
 * which MOVES the file into the backup instead. (Callers are NOT wired; see the report for the list of sites.)
 *
 * A restore is the same journal `restore` op as for a set-aside backup (`setAside.ts`): the current store moves to
 * `linkundo/<linkId>-at-unlink/`, the backup's items are moved back (a hard link moved to the old path is just the
 * file again).
 */

/** Free space needed on top of the database copy and the floor. */
export const BACKUP_HEADROOM_BYTES = 100 * 1024 * 1024;

const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EMLINK']);

export interface MasterBackupOptions {
  db: DatabaseSync;
  dataDir: string;
  linkId: string;
  now: Date;
  /** Free bytes on the data disk (default `statfsFreeBytes`); null means "cannot tell": the rule is not applied. */
  free?: FreeBytes;
  /** The free-space floor (default the video floor, 500 MB). */
  minFreeBytes?: number;
  /** Makes a hard link (default `fs.linkSync`); tests inject a failing one. */
  link?: (existing: string, created: string) => void;
  release?: string;
  dbLevel?: number;
  hashFileCap?: number;
  hashTotalCap?: number;
}

export type MasterBackupResult = { taken: false; reason: 'exists' } | { taken: true; manifest: BackupManifest };

const yieldNow = (): Promise<void> => new Promise((done) => setImmediate(done));

function databaseBytes(db: DatabaseSync): number {
  const pages = Number((db.prepare('PRAGMA page_count').get() as { page_count: number } | undefined)?.page_count ?? 0);
  const size = Number((db.prepare('PRAGMA page_size').get() as { page_size: number } | undefined)?.page_size ?? 4096);
  return pages * size;
}

/**
 * One backup per box, taken before its FIRST follower: a box that already has a backup (of any kind) is skipped.
 * Throws `backup: <code>` with code `bad_link_id`, `journal_open`, `backup_exists` or `no_space`; all of them before
 * anything on the disk changed.
 */
export async function takeMasterBackup(o: MasterBackupOptions): Promise<MasterBackupResult> {
  const { dataDir, linkId } = o;
  if (!LINK_ID_RE.test(linkId)) throw new Error('backup: bad_link_id');
  if (listBackups(dataDir).some((b) => !b.atUnlink)) return { taken: false, reason: 'exists' };
  if (journalIsOpen(dataDir)) throw new Error('backup: journal_open');
  const final = backupDirOf(dataDir, linkId);
  if (pathExists(final)) throw new Error('backup: backup_exists');
  const floor = o.minFreeBytes ?? defaultVideoLimits().minFreeBytes;
  const free = (o.free ?? statfsFreeBytes)(dataDir);
  if (free !== null && free < databaseBytes(o.db) + BACKUP_HEADROOM_BYTES + floor) throw new Error('backup: no_space');

  const partial = `${final}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  try {
    o.db.prepare('VACUUM INTO ?').run(join(partial, 'surau.db'));
    for (const item of STORE_ITEMS) {
      if (item.group !== 'secret') continue;
      const from = join(dataDir, item.rel);
      if (!existsSync(from)) continue;
      mkdirSync(dirname(join(partial, item.rel)), { recursive: true });
      copyFileSync(from, join(partial, item.rel));
    }
    const link = o.link ?? linkSync;
    let mode: 'hardlink' | 'keep-on-delete' = 'hardlink';
    const media = STORE_ITEMS.filter((i) => i.group === 'media');
    linking: for (const item of media) {
      for (const file of walkFiles(join(dataDir, item.rel))) {
        const to = join(partial, item.rel, file);
        mkdirSync(dirname(to), { recursive: true });
        try {
          link(join(dataDir, item.rel, file), to);
        } catch (error) {
          if (!NO_LINKS.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
          mode = 'keep-on-delete';
          break linking;
        }
        await yieldNow();
      }
    }
    if (mode === 'keep-on-delete') for (const item of media) rmSync(join(partial, item.rel), { recursive: true, force: true });

    const limits = { hashFileCap: o.hashFileCap, hashTotalCap: o.hashTotalCap };
    const listed = listManifestFiles(partial, limits);
    const files: ManifestFile[] = [...listed.files];
    let bytes = listed.bytes;
    if (mode === 'keep-on-delete') {
      // the media files are not in the backup: the manifest still names what the store held on link day
      let budget = o.hashTotalCap ?? HASH_TOTAL_CAP;
      for (const item of media) {
        for (const file of walkFiles(join(dataDir, item.rel))) {
          const abs = join(dataDir, item.rel, file);
          const size = statSync(abs).size;
          const cap = o.hashFileCap ?? HASH_FILE_CAP;
          const sha256 = size <= cap && size <= budget ? hashFileSync(abs, cap).sha256 : null;
          if (sha256 !== null) budget -= size;
          files.push({ path: `${item.rel}/${file}`, size, sha256 });
          bytes += size;
          await yieldNow();
        }
      }
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }
    const manifest: BackupManifest = {
      v: 1,
      kind: 'copy',
      linkId,
      at: o.now.toISOString(),
      release: o.release ?? boxVersion(),
      dbLevel: o.dbLevel ?? MIGRATIONS.length,
      files,
      bytes,
      mode,
    };
    writeManifest(partial, manifest);
    mkdirSync(undoRoot(dataDir), { recursive: true });
    renameSync(partial, final);
    return { taken: true, manifest };
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

/**
 * For a backup in `keep-on-delete` mode: call this INSTEAD of deleting (or before replacing) a media file of the store.
 * `relPath` is relative to the data folder (`assets/<file>`). Returns
 * - `not-needed`: the box has no such backup, or the backup does not name that file (added after the link); the caller
 *   deletes or replaces it as usual;
 * - `moved`: the file was moved into the backup (it is no longer at its old path; the caller must not delete it);
 * - `already-kept`: the backup already holds the file as it was on link day, so this newer one was removed.
 */
export function keepInBackupBeforeDelete(dataDir: string, relPath: string): 'not-needed' | 'moved' | 'already-kept' {
  const rel = relPath.replace(/\\/g, '/');
  if (rel === '' || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').some((p) => p === '..' || p === '' || p === '.')) {
    throw new Error('keep: bad_path');
  }
  const backup = listBackups(dataDir).find((b) => !b.atUnlink && b.manifest.kind === 'copy' && b.manifest.mode === 'keep-on-delete');
  if (backup === undefined) return 'not-needed';
  if (!backup.manifest.files.some((f) => f.path === rel)) return 'not-needed';
  const from = join(dataDir, rel);
  if (!pathExists(from)) return 'not-needed';
  const to = join(backupDirOf(dataDir, backup.folder), rel);
  if (pathExists(to)) {
    rmSync(from, { force: true });
    return 'already-kept';
  }
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  return 'moved';
}

/**
 * The folder variant for a theme folder that is about to be removed or replaced: every file under `relDir` goes through
 * `keepInBackupBeforeDelete`. Returns how many files were moved into the backup; the caller then removes what is left
 * of the folder. A throw leaves the folder as it is (files already moved stay kept).
 */
export function keepFolderInBackupBeforeDelete(dataDir: string, relDir: string): number {
  const rel = relDir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (rel === '' || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').some((p) => p === '..' || p === '' || p === '.')) {
    throw new Error('keep: bad_path');
  }
  let moved = 0;
  for (const file of walkFiles(join(dataDir, rel))) {
    if (keepInBackupBeforeDelete(dataDir, `${rel}/${file}`) === 'moved') moved += 1;
  }
  return moved;
}

/**
 * At start (no copy can be running then): a `linkundo/<linkId>.partial/` folder is a master backup that was cut short
 * (power, kill). It is never a backup (it has no manifest under its final name) and only takes space: it goes.
 */
export function sweepPartialBackups(dataDir: string): number {
  const root = undoRoot(dataDir);
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.endsWith('.partial')) continue;
    rmSync(join(root, e.name), { recursive: true, force: true });
    n += 1;
  }
  return n;
}
