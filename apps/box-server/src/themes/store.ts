import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isBuiltInTheme, SCREEN_IDS, THEME_BUNDLE_FORMAT, THEME_CONTRACT } from '@surau/core';
import type { InstalledPack } from '@surau/core';
import { AssetError, deletePackAsset, getAssetPath, putAsset } from '../assets/store.ts';
import { keepFolderBeforeDelete, keepMediaBeforeDelete } from '../assets/video.ts';
import { getSettings, putFeature, SettingsError } from '../settingsStore.ts';
import { LOCAL_SURAU_ID } from '../tenant.ts';
import { rewriteUrls, scopePackCss } from './cssCheck.ts';
import { isReservedName, issue, PACK_MIME, ThemeError } from './packFormat.ts';
import type { PackFiles, ThemeIssue } from './packFormat.ts';
import { validatePack, validatePackAsync } from './validate.ts';
import type { PackReport } from './validate.ts';

export const STAGED_TTL_MS = 15 * 60 * 1000;
export const MAX_STAGED = 3;
/** Installs one box accepts in an hour: a stuck upload loop cannot churn the disk and the box's settings. */
export const MAX_INSTALLS_PER_HOUR = 10;
export const INSTALL_WINDOW_MS = 60 * 60 * 1000;
/** Checks (stage) one box accepts in an hour: each one decodes pictures, so an upload loop cannot keep the box busy. */
export const MAX_CHECKS_PER_HOUR = 30;
/** All extracted packs together (bundle.css and pictures on the box's disk). */
export const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
/**
 * The folder name (and URL segment) of an installed pack: the first 16 hex of its file's sha-256 (a changed file is a new
 * address) and the bundle format (a box upgrade that changes what the validator or the scoper make is a new address too).
 */
export const hashOf = (assetId: string): string => `${assetId.slice(0, 16)}-${THEME_BUNDLE_FORMAT}`;
export const themesDirOf = (dataDir: string): string => join(dataDir, 'themes');

export interface ThemeStoreDeps {
  db: DatabaseSync;
  dataDir: string;
  now: () => Date;
  /** Test hooks: a counter called each time a synced pack is checked, and a smaller allowance for all extracted packs. */
  onValidate?: () => void;
  extractedMaxBytes?: number;
  /** Cloud: many surau, so the extracted-bytes allowance and the problems memo are per surau. Default 'box'. */
  role?: 'box' | 'cloud';
}

/** A refusal that is not about the file's content: the staged copy is gone, the theme is in use, built in or unknown. */
export class ThemeStoreError extends Error {
  readonly code: 'gone' | 'in_use' | 'built_in' | 'not_found';
  constructor(code: ThemeStoreError['code'], message: string) {
    super(message);
    this.name = 'ThemeStoreError';
    this.code = code;
  }
}

export interface ThemeStore {
  /** Validates, and when ok keeps the bytes (memory) and an extracted copy under themes/.staged/<id>/ for the preview. The id is 32 hex from randomBytes(16). */
  stage(buf: Buffer): Promise<{ report: PackReport; stagedId: string | null }>;
  /** Re-validates against the packs installed NOW, stores the asset, extracts, writes themeStyle.packs[name]. Throws ThemeError; ThemeStoreError('gone') when the staged id is unknown or expired. */
  install(stagedId: string, actor: string, deviceId?: string): Promise<InstalledPack & { name: string }>;
  /** Removes the record (a removal marker, so it syncs); the surau's styles[name] are kept. Throws ThemeStoreError. */
  remove(name: string, actor: string, deviceId?: string): void;
  /** The folder of an installed pack's current file (its hash is the URL segment), extracting it from its asset first when missing (a pack that arrived by sync). Null when the record or the asset is missing or the pack fails this box's validator. */
  ensureExtracted(name: string, surauId?: string): Promise<{ dir: string; version: number; hash: string } | null>;
  stagedDir(stagedId: string): string | null;
  /** Why an installed pack cannot be served here, for the app: null when fine. */
  problemOf(name: string): Promise<ThemeIssue | null>;
}

/** A sub-folder name this store made: `<16 hex>-<bundle format>`, or the older `<16 hex>` and `<version>` forms (removed at start). */
const FOLDER_NAME = /^(?:[0-9a-f]{16}(?:-[1-9][0-9]{0,2})?|[1-9][0-9]{0,5})$/;

/** A folder this store made: only sub-folders of those names that hold a bundle.css. */
function isPackFolder(dir: string): boolean {
  try {
    const subs = readdirSync(dir);
    return subs.length > 0 && subs.every((v) => FOLDER_NAME.test(v) && existsSync(join(dir, v, 'bundle.css')));
  } catch {
    return false;
  }
}

const STAGED_ID = /^[0-9a-f]{32}$/;
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** The bytes of every file under a folder (0 when it is not there). */
function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      total += e.isDirectory() ? dirBytes(p) : statSync(p).size;
    }
  } catch {
    return total;
  }
  return total;
}

/**
 * One stylesheet for a whole pack: theme.css, then each screens/<id>.css (catalog order), then arabic.css. Every rule is
 * put under this theme's own stage (scopePackCss) and every address becomes an absolute path under `base`.
 */
export function buildBundleCss(files: PackFiles, base: string): string {
  const name = files.manifest.name;
  const out: string[] = [];
  const theme = files.css.get('theme.css');
  if (theme !== undefined) out.push(rewriteUrls(scopePackCss(theme, { theme: name }), base));
  for (const id of SCREEN_IDS) {
    const css = files.css.get(`screens/${id}.css`);
    if (css !== undefined) out.push(rewriteUrls(scopePackCss(css, { theme: name, screen: id }), base));
  }
  const arabic = files.css.get('arabic.css');
  if (arabic !== undefined) out.push(rewriteUrls(scopePackCss(arabic, { theme: name }), base));
  return `${out.join('\n')}\n`;
}

interface Staged { buf: Buffer; at: number; name: string; version: number }

export function createThemeStore(deps: ThemeStoreDeps): ThemeStore {
  const { db, dataDir } = deps;
  const root = themesDirOf(dataDir);
  const stagedRoot = join(root, '.staged');
  const staged = new Map<string, Staged>();
  const cloudRole = deps.role === 'cloud';
  const problems = new Map<string, { assetId: string; version: number; issue: ThemeIssue }>();
  /** The problems memo key: the name on a box, surau + name on the cloud (one surau's bad pack never hides another's). */
  const problemKey = (name: string, surauId: string): string => (cloudRole ? `${surauId}/${name}` : name);

  const installedPacks = (surauId: string = LOCAL_SURAU_ID): Record<string, InstalledPack> => getSettings(db, surauId).themeStyle.packs;

  /** Everything is written to a temporary folder and renamed, so a half-extracted pack is never served. */
  function extractTo(final: string, files: PackFiles, base: string): void {
    mkdirSync(root, { recursive: true });
    const tmp = join(root, `.tmp-${randomBytes(6).toString('hex')}`);
    try {
      mkdirSync(join(tmp, 'images'), { recursive: true });
      writeFileSync(join(tmp, 'bundle.css'), buildBundleCss(files, base));
      // File names come from the validated key set and extension list, never from a zip entry name.
      for (const [key, img] of files.images) writeFileSync(join(tmp, 'images', `${key}.${img.ext}`), img.data);
      mkdirSync(join(final, '..'), { recursive: true });
      keepThemeFolder(final);
      rmSync(final, { recursive: true, force: true });
      renameSync(tmp, final);
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true });
      throw error;
    }
  }

  const dirOf = (name: string, hash: string): string => join(root, name, hash);

  /** A kept-data master's `keep-on-delete` backup takes the link-day files of a theme folder before it goes. */
  const keepThemeFolder = (abs: string): void => keepFolderBeforeDelete(dataDir, relative(dataDir, abs));

  /** Folders nobody needs: the old versions of a theme (keeping `keep`), and everything of a theme that is gone. */
  function pruneVersions(name: string, keep: ReadonlySet<string>): void {
    const dir = join(root, name);
    if (!existsSync(dir)) return;
    for (const v of readdirSync(dir)) {
      if (!FOLDER_NAME.test(v) || !keep.has(v)) {
        keepThemeFolder(join(dir, v));
        rmSync(join(dir, v), { recursive: true, force: true });
      }
    }
  }

  function startUpClean(): void {
    if (!existsSync(root)) return;
    if (cloudRole) return; // the cloud keeps the packs of every surau; only a box prunes by its own one surau's records
    rmSync(stagedRoot, { recursive: true, force: true });
    const packs = installedPacks();
    for (const entry of readdirSync(root)) {
      const p = join(root, entry);
      if (entry.startsWith('.tmp-')) { rmSync(p, { recursive: true, force: true }); continue; }
      if (entry.startsWith('.') || !isPackFolder(p)) continue; // only what this store made is ever removed
      const rec = Object.prototype.hasOwnProperty.call(packs, entry) ? packs[entry] : undefined;
      if (rec === undefined) {
        keepThemeFolder(p);
        rmSync(p, { recursive: true, force: true });
      }
      else pruneVersions(entry, new Set([hashOf(rec.assetId)]));
    }
  }
  startUpClean();

  function dropStaged(id: string): void {
    staged.delete(id);
    rmSync(join(stagedRoot, id), { recursive: true, force: true });
  }

  function expireStaged(): void {
    const t = deps.now().getTime();
    for (const [id, s] of [...staged]) if (t - s.at > STAGED_TTL_MS) dropStaged(id);
  }

  /** Install times (ms) of the last hour. In memory: a restart is a new hour, and only a signed-in admin can install at all. */
  let installTimes: number[] = [];
  function installBudgetLeft(): boolean {
    const t = deps.now().getTime();
    installTimes = installTimes.filter((x) => t - x < INSTALL_WINDOW_MS && x <= t);
    return installTimes.length < MAX_INSTALLS_PER_HOUR;
  }

  /** Check times (ms) of the last hour, same idea as the installs. */
  let checkTimes: number[] = [];
  function checkBudgetLeft(): boolean {
    const t = deps.now().getTime();
    checkTimes = checkTimes.filter((x) => t - x < INSTALL_WINDOW_MS && x <= t);
    return checkTimes.length < MAX_CHECKS_PER_HOUR;
  }

  const extractedCap = deps.extractedMaxBytes ?? MAX_EXTRACTED_BYTES;
  /** Would this pack, added to the packs of the other themes already on the disk, stay within the allowance for all extracted packs? */
  function extractedFits(files: PackFiles, name: string, surauId: string = LOCAL_SURAU_ID): boolean {
    let add = 0;
    for (const img of files.images.values()) add += img.data.length;
    for (const c of files.css.values()) add += c.length * 2;
    let used = 0;
    try {
      if (cloudRole) {
        // only this surau's own installed packs count (folders are shared by name, so the current address of each)
        for (const [n, rec] of Object.entries(installedPacks(surauId))) {
          if (n !== name) used += dirBytes(dirOf(n, hashOf(rec.assetId)));
        }
      } else {
        for (const entry of readdirSync(root)) {
          if (entry.startsWith('.') || entry === name) continue;
          used += dirBytes(join(root, entry));
        }
      }
    } catch {
      used = 0;
    }
    return used + add <= extractedCap;
  }

  /** The stored .maxtheme asset goes when no installed pack points at it any more. */
  function dropAssetIfUnused(assetId: string): void {
    const stillUsed = Object.values(installedPacks()).some((p) => p.assetId === assetId);
    if (!stillUsed) deletePackAsset(db, dataDir, assetId, (rel) => keepMediaBeforeDelete(dataDir, rel));
  }

  const inflight = new Map<string, Promise<{ dir: string; version: number; hash: string } | null>>();

  async function extractNow(name: string, surauId: string): Promise<{ dir: string; version: number; hash: string } | null> {
    const packs = installedPacks(surauId);
    const rec = Object.prototype.hasOwnProperty.call(packs, name) ? packs[name] : undefined;
    if (rec === undefined) return null;
    const hash = hashOf(rec.assetId);
    const dir = dirOf(name, hash);
    const pkey = problemKey(name, surauId);
    const known = problems.get(pkey);
    if (known !== undefined && known.assetId === rec.assetId && known.version === rec.version) return null;
    if (existsSync(join(dir, 'bundle.css'))) return { dir, version: rec.version, hash };

    // Arrived by sync (or left by an older box): this box checks the pack itself, exactly as it checks an upload, without blocking the event loop.
    const asset = getAssetPath(db, dataDir, rec.assetId);
    if (asset === null || asset.mime !== PACK_MIME) return null;
    let buf: Buffer;
    try { buf = readFileSync(asset.path); } catch { return null; }
    const remember = (i: ThemeIssue): null => {
      problems.set(pkey, { assetId: rec.assetId, version: rec.version, issue: i });
      return null;
    };
    if (sha256(buf) !== rec.assetId) {
      return remember(issue('not_zip', null, null, 'Fail tema rosak.', 'The theme file is damaged.'));
    }
    deps.onValidate?.();
    const { report, files } = await validatePackAsync(buf, { installed: {}, contract: THEME_CONTRACT, enforceVersion: false });
    if (!report.ok || files === null) return remember(report.errors[0]!);
    if (files.manifest.name !== name || files.manifest.version !== rec.version) {
      return remember(issue('bad_theme_json', 'theme.json', null,
        'theme.json tidak sah: nama atau versi tidak sepadan dengan rekod tema.', 'theme.json is not valid: the name or version does not match the theme record.'));
    }
    if (!extractedFits(files, name, surauId)) {
      return remember(issue('storage_full', null, null, 'Ruang tema penuh. Padam tema yang tidak digunakan.', 'The theme space is full. Delete a theme that is not used.'));
    }
    // the installed record may have changed while the pictures were being checked
    const now = installedPacks(surauId);
    if (!Object.prototype.hasOwnProperty.call(now, name) || now[name]!.assetId !== rec.assetId) return null;
    extractTo(dir, files, `/themes/${name}/${hash}/`);
    return { dir, version: rec.version, hash };
  }

  const store: ThemeStore = {
    async stage(buf) {
      expireStaged();
      if (!checkBudgetLeft()) {
        throw new ThemeError([issue('too_many_installs', null, null,
          `Terlalu banyak semakan tema. Had ${MAX_CHECKS_PER_HOUR} sejam. Cuba lagi dalam sejam.`,
          `Too many theme checks. The limit is ${MAX_CHECKS_PER_HOUR} an hour. Try again in an hour.`)]);
      }
      checkTimes.push(deps.now().getTime());
      const { report, files } = await validatePackAsync(buf, { installed: installedPacks(), contract: THEME_CONTRACT, enforceVersion: true });
      if (!report.ok || files === null) return { report, stagedId: null };
      const id = randomBytes(16).toString('hex');
      extractTo(join(stagedRoot, id), files, `/api/themes/staged/${id}/`);
      staged.set(id, { buf, at: deps.now().getTime(), name: files.manifest.name, version: files.manifest.version });
      while (staged.size > MAX_STAGED) {
        const oldest = [...staged.entries()].sort((x, y) => x[1].at - y[1].at)[0]![0];
        dropStaged(oldest);
      }
      return { report, stagedId: id };
    },

    async install(stagedId, actor, deviceId) {
      expireStaged();
      const s = STAGED_ID.test(stagedId) ? staged.get(stagedId) : undefined;
      if (s === undefined) {
        throw new ThemeStoreError('gone', 'The check has expired. Check the file again.');
      }
      if (!installBudgetLeft()) {
        throw new ThemeError([issue('too_many_installs', null, null,
          `Terlalu banyak pemasangan tema. Had ${MAX_INSTALLS_PER_HOUR} sejam. Cuba lagi dalam sejam.`,
          `Too many theme installs. The limit is ${MAX_INSTALLS_PER_HOUR} an hour. Try again in an hour.`)]);
      }
      const { report, files } = await validatePackAsync(s.buf, { installed: installedPacks(), contract: THEME_CONTRACT, enforceVersion: true });
      if (!report.ok || files === null) throw new ThemeError(report.errors);
      const m = files.manifest;
      if (!extractedFits(files, m.name)) {
        throw new ThemeError([issue('storage_full', null, null,
          'Ruang tema penuh. Padam tema yang tidak digunakan.', 'The theme space is full. Delete a theme that is not used.')]);
      }
      // From here to the end nothing waits: what was read is still true when it is written.
      const current = installedPacks();
      const before = Object.prototype.hasOwnProperty.call(current, m.name) ? current[m.name]! : null;
      if (before !== null && m.version <= before.version) {
        throw new ThemeError([issue('version_not_higher', 'theme.json', null,
          `Versi sama atau lebih rendah. ${m.title} versi ${before.version} sudah dipasang. Naikkan nombor versi dalam theme.json.`,
          `Same or lower version. ${m.title} version ${before.version} is already installed. Raise the version number in theme.json.`)]);
      }

      let asset;
      try {
        asset = putAsset(db, dataDir, s.buf, PACK_MIME, actor);
      } catch (error) {
        if (error instanceof AssetError && error.status === 413) {
          throw new ThemeError([issue('storage_full', null, null,
            'Ruang simpanan penuh. Padam fail yang tidak digunakan.', 'Storage is full. Delete files that are not used.')]);
        }
        throw error;
      }
      const hash = hashOf(asset.id);
      const final = dirOf(m.name, hash);
      const undo = (): void => {
        keepThemeFolder(final);
        rmSync(final, { recursive: true, force: true });
        if (asset.created) deletePackAsset(db, dataDir, asset.id, (rel) => keepMediaBeforeDelete(dataDir, rel)); // a file this install stored, that no record points at
      };

      try {
        // Leftovers of older updates go now; the folder in use (the file being replaced) stays for kiosks still reading it.
        pruneVersions(m.name, new Set(before === null ? [] : [hashOf(before.assetId)]));
        extractTo(final, files, `/themes/${m.name}/${hash}/`);
      } catch (error) {
        undo();
        throw error;
      }

      const record: InstalledPack = {
        assetId: asset.id, version: m.version, title: m.title, base: m.base, contract: m.contract, bytes: s.buf.length,
        fonts: [], screens: report.screens, images: report.images, defaults: m.defaults,
      };
      try {
        putFeature(db, 'themeStyle', { packs: { [m.name]: record } }, actor, deviceId, LOCAL_SURAU_ID);
      } catch (error) {
        undo();
        if (error instanceof SettingsError) {
          throw new ThemeError([issue('storage_full', null, null,
            'Ruang tema penuh. Padam tema yang tidak digunakan.', 'The theme space is full. Delete a theme that is not used.')]);
        }
        throw error;
      }
      installTimes.push(deps.now().getTime());
      // The file of the version just replaced is not needed any more.
      if (before !== null && before.assetId !== asset.id) dropAssetIfUnused(before.assetId);
      problems.delete(m.name);
      return { name: m.name, ...record };
    },

    remove(name, actor, deviceId) {
      if (isBuiltInTheme(name) || isReservedName(name)) {
        throw new ThemeStoreError('built_in', 'A built-in theme cannot be deleted.');
      }
      const packs = installedPacks();
      if (!Object.prototype.hasOwnProperty.call(packs, name)) throw new ThemeStoreError('not_found', 'No such theme.');
      if (getSettings(db, LOCAL_SURAU_ID).kioskTemplate.templateId === name) {
        throw new ThemeStoreError('in_use', 'This theme is in use. Choose another theme first.');
      }
      const assetId = packs[name]!.assetId;
      putFeature(db, 'themeStyle', { packs: { [name]: { removed: true } } }, actor, deviceId, LOCAL_SURAU_ID);
      problems.delete(name);
      keepThemeFolder(join(root, name));
      rmSync(join(root, name), { recursive: true, force: true });
      dropAssetIfUnused(assetId);
    },

    ensureExtracted(name, surauId = LOCAL_SURAU_ID) {
      // One check at a time per theme (and surau, on the cloud): requests that arrive together share it.
      // The key is the folder (name and address), so two suraus holding the same file never race on one folder.
      const rec0 = installedPacks(surauId)[name];
      const key = rec0 === undefined || !Object.prototype.hasOwnProperty.call(installedPacks(surauId), name) ? `${surauId}/${name}` : `${name}/${hashOf(rec0.assetId)}`;
      const running = inflight.get(key);
      if (running !== undefined) return running;
      const p = extractNow(name, surauId).finally(() => { inflight.delete(key); });
      inflight.set(key, p);
      return p;
    },

    stagedDir(stagedId) {
      expireStaged();
      if (!STAGED_ID.test(stagedId) || !staged.has(stagedId)) return null;
      const dir = join(stagedRoot, stagedId);
      return existsSync(dir) ? dir : null;
    },

    async problemOf(name) {
      const packs = installedPacks();
      const rec = Object.prototype.hasOwnProperty.call(packs, name) ? packs[name] : undefined;
      if (rec === undefined) return null;
      await store.ensureExtracted(name);
      const p = problems.get(name);
      return p !== undefined && p.assetId === rec.assetId && p.version === rec.version ? p.issue : null;
    },
  };
  return store;
}
