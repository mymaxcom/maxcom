import { readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LINK_ID_RE, readJournal } from './journal.ts';
import { backupDirOf, backupOf, journalIsOpen, listBackups, pathExists, STORE_ITEMS, undoRoot, writeManifest } from './setAside.ts';
import type { ManifestKind } from './setAside.ts';

/** How long the data kept at an unlink stays (`linkundo/<linkId>-at-unlink/`). Backups of a linked box never expire. */
export const AT_UNLINK_KEEP_DAYS = 7;

export interface BackupInfo {
  linkId: string;
  kind: ManifestKind;
  /** The commit point (ISO), by this box's clock. */
  at: string;
  /** What the backup holds in all (the sizes of the files it names; the app words the line). */
  bytes: number;
  files: number;
}

/**
 * The backup this box holds for the app's line "Sandaran sebelum pautan: <date>, <size>": the backup of a link (not
 * the data kept at an unlink), the newest if there were ever two. null when there is none.
 */
export function backupInfo(dataDir: string): BackupInfo | null {
  const mine = listBackups(dataDir)
    .filter((b) => !b.atUnlink)
    .sort((a, b) => (a.manifest.at < b.manifest.at ? 1 : a.manifest.at > b.manifest.at ? -1 : 0));
  const top = mine[0];
  if (top === undefined) return null;
  const m = top.manifest;
  return { linkId: m.linkId, kind: m.kind, at: m.at, bytes: m.bytes, files: m.files.length };
}

/**
 * "Buang sandaran": removes the backup folder of that link. Refused (`backup: journal_open`) while a link move is
 * running, and `backup: no_backup` when there is none. The folder is renamed first, so a kill during the removal never
 * leaves a half folder that still looks like a backup; the sweep removes what a kill left.
 */
export function dropBackup(dataDir: string, linkId: string): void {
  if (!LINK_ID_RE.test(linkId)) throw new Error('backup: bad_link_id');
  if (journalIsOpen(dataDir)) throw new Error('backup: journal_open');
  if (backupOf(dataDir, linkId) === null) throw new Error('backup: no_backup');
  const dir = backupDirOf(dataDir, linkId);
  const going = `${dir}.dropping`;
  rmSync(going, { recursive: true, force: true });
  renameSync(dir, going);
  rmSync(going, { recursive: true, force: true });
}

/**
 * A sign-out removes the secret from every backup folder (the data kept at an unlink included) and rewrites each
 * manifest. `youtube`: the token, the live state and the open-broadcast record; `camera`: the camera record.
 * Returns how many files were removed.
 */
export function removeSecretFromBackups(dataDir: string, which: 'youtube' | 'camera'): number {
  const rels = new Set(STORE_ITEMS.filter((i) => i.secret === which).map((i) => i.rel));
  let removed = 0;
  for (const b of listBackups(dataDir)) {
    const dir = backupDirOf(dataDir, b.folder);
    let hit = false;
    for (const rel of rels) {
      if (pathExists(join(dir, rel))) {
        rmSync(join(dir, rel), { force: true });
        removed += 1;
        hit = true;
      }
    }
    const files = b.manifest.files.filter((f) => !rels.has(f.path));
    if (hit || files.length !== b.manifest.files.length) {
      writeManifest(dir, { ...b.manifest, files, bytes: files.reduce((n, f) => n + f.size, 0) });
    }
  }
  return removed;
}

/**
 * The daily sweep: deletes the `*-at-unlink` folders that are at least 7 days old (by their manifest, else by the
 * folder's own time) and the leftovers of a dropped backup. NOTHING here ever touches the backup of a linked box, and
 * the folder of a restore that is still running is left alone. Returns the folders removed.
 */
export function sweepKeptAtUnlink(dataDir: string, now: Date): string[] {
  let names: string[];
  try {
    names = readdirSync(undoRoot(dataDir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  let busy: string | null = null;
  try {
    busy = readJournal(dataDir)?.linkId ?? null;
  } catch {
    busy = '';
  }
  const removed: string[] = [];
  const limit = AT_UNLINK_KEEP_DAYS * 86_400_000;
  for (const folder of names) {
    const dir = backupDirOf(dataDir, folder);
    if (folder.endsWith('.dropping')) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(folder);
      continue;
    }
    if (!folder.endsWith('-at-unlink')) continue;
    if (busy !== null && (busy === '' || folder === `${busy}-at-unlink`)) continue;
    const manifest = listBackups(dataDir).find((b) => b.folder === folder)?.manifest;
    const at = manifest !== undefined ? Date.parse(manifest.at) : statSync(dir).mtimeMs;
    if (!Number.isFinite(at) || now.getTime() - at < limit) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(folder);
  }
  return removed;
}
