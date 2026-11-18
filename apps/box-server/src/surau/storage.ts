import { createHash } from 'node:crypto';
import { statfsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { AssetError, putAsset } from '../assets/store.ts';
import type { AssetMeta } from '../assets/store.ts';

/**
 * The cloud storage limit of one surau (Plan 14 decision 24). Counted per surau: the assets its sites and phones put
 * (`surau_assets`, one row per surau and asset, so a content-addressed asset two suraus share counts for each), its
 * and the finance photos held on this server. Catch-up video never counts: it goes from the box to YouTube and is
 * never stored on the cloud (operator decision 25). The limit is
 * `suraus.storage_limit_bytes`, null meaning the default 2 GiB. A database with no `suraus` row for the id (every box)
 * has no per-surau limit and keeps its old folder quotas.
 */

export const DEFAULT_STORAGE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
export const STORAGE_FULL_MSG = 'Storan awan surau penuh';
export const STORAGE_FULL_CODE = 'storage_full';

/** An asset refused because the surau is at its limit (status 413). */
export class StorageFullError extends AssetError {
  readonly code = STORAGE_FULL_CODE;
  constructor() {
    super([STORAGE_FULL_MSG], 413);
    this.name = 'StorageFullError';
  }
}

/** The effective limit in bytes, or null when the surau has no row here (a box). */
export function storageLimitOf(db: DatabaseSync, surauId: string): number | null {
  const row = db.prepare('SELECT storage_limit_bytes AS l FROM suraus WHERE id = ?').get(surauId);
  if (row === undefined) return null;
  const l = row.l === null ? Number.NaN : Number(row.l);
  return Number.isSafeInteger(l) && l > 0 ? l : DEFAULT_STORAGE_LIMIT_BYTES;
}

/**
 * Whether the surau may read the asset by id through a tenant route. On a box (one surau) every asset is its own;
 * on the cloud only an asset the surau holds (`surau_assets`): the content hash alone is not a licence to read.
 */
export function surauHoldsAsset(db: DatabaseSync, role: 'box' | 'cloud', surauId: string, assetId: string): boolean {
  if (role !== 'cloud') return true;
  return db.prepare('SELECT 1 AS x FROM surau_assets WHERE surau_id = ? AND asset_id = ?').get(surauId, assetId) !== undefined;
}

/** What the surau holds on this server now, in bytes. */
export function storageUsedBytes(db: DatabaseSync, surauId: string): number {
  const row = db
    .prepare(
      `SELECT (SELECT COALESCE(SUM(bytes), 0) FROM surau_assets WHERE surau_id = ?)
            + (SELECT COALESCE(SUM(bytes), 0) FROM finance_photos WHERE surau_id = ? AND present = 1) AS n`,
    )
    .get(surauId, surauId);
  return Number(row?.n ?? 0);
}

// ---- the cloud's own data disk (qs-gate S1): every surau under its limit can still fill the disk together ----

/** Free space on a disk, or null when it cannot be read (then nothing is refused for it). */
export type DiskFree = (dir: string) => { freeBytes: number; totalBytes: number } | null;
/** New uploads are refused while the data disk has less free than the larger of these. */
export const DISK_MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024;
export const DISK_MIN_FREE_FRACTION = 0.1;
/** How long one disk reading is trusted. */
export const DISK_CHECK_TTL_MS = 60_000;

const statfsFree: DiskFree = (dir) => {
  try {
    const s = statfsSync(dir);
    return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return null;
  }
};

/** Off until the cloud process turns it on (`main.ts`); a box never does. */
let diskGuard: { dir: string; probe: DiskFree; now: () => number; checkedAt: number; low: boolean } | null = null;

/** Turn on the data-disk guard for the cloud (`dir`: its data folder). `probe` and `now` are test hooks. */
export function enableCloudDiskGuard(dir: string, probe: DiskFree = statfsFree, now: () => number = Date.now): void {
  diskGuard = { dir, probe, now, checkedAt: Number.NEGATIVE_INFINITY, low: false };
}

/** Turn the guard off again (tests). */
export function disableCloudDiskGuard(): void {
  diskGuard = null;
}

/** True when the guard is on and the data disk is below its floor; read at most once a minute. */
export function cloudDiskLow(): boolean {
  const g = diskGuard;
  if (g === null) return false;
  const t = g.now();
  if (!(t >= g.checkedAt && t - g.checkedAt < DISK_CHECK_TTL_MS)) {
    const f = g.probe(g.dir);
    g.low = f !== null && Number.isFinite(f.freeBytes) && f.freeBytes < Math.max(DISK_MIN_FREE_BYTES, f.totalBytes * DISK_MIN_FREE_FRACTION);
    g.checkedAt = t;
  }
  return g.low;
}

/** True when `bytes` more still fit under the surau's limit and on the cloud's disk (always true where there is no limit). */
export function storageFits(db: DatabaseSync, surauId: string, bytes: number): boolean {
  const limit = storageLimitOf(db, surauId);
  if (limit === null) return true;
  if (cloudDiskLow()) return false;
  return storageUsedBytes(db, surauId) + bytes <= limit;
}

/**
 * `putAsset` for one surau: an asset the surau already holds is the plain repeat; a new one must fit under the
 * surau's limit (`StorageFullError` otherwise, nothing written) and is then counted for the surau. The check and the
 * count run with no await between them, so two uploads cannot both pass on the last bytes.
 */
export function putSurauAsset(db: DatabaseSync, dataDir: string, buf: Buffer, declaredMime: string, actor: string, surauId: string): AssetMeta {
  const limit = storageLimitOf(db, surauId);
  if (limit === null) return putAsset(db, dataDir, buf, declaredMime, actor);
  const id = createHash('sha256').update(buf).digest('hex');
  const held = db.prepare('SELECT 1 AS x FROM surau_assets WHERE surau_id = ? AND asset_id = ?').get(surauId, id) !== undefined;
  if (!held && (cloudDiskLow() || storageUsedBytes(db, surauId) + buf.length > limit)) throw new StorageFullError();
  const meta = putAsset(db, dataDir, buf, declaredMime, actor);
  if (!held) {
    db.prepare('INSERT OR IGNORE INTO surau_assets (surau_id, asset_id, bytes, created_at) VALUES (?, ?, ?, ?)').run(
      surauId,
      meta.id,
      meta.bytes,
      new Date().toISOString(),
    );
  }
  return meta;
}
