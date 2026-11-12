import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { readImageHeader } from './imageHeader.ts';

export class AssetError extends Error {
  readonly errors: string[];
  /** HTTP status the upload route answers with (400 bad file, 413 storage quota). */
  readonly status: number;

  constructor(errors: string[], status = 400) {
    super(errors.join('; '));
    this.name = 'AssetError';
    this.errors = errors;
    this.status = status;
  }
}

export interface AssetMeta {
  id: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  created: boolean;
}

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
// A decoded 4096 x 4096 RGBA image is 64 MB; larger ones can exhaust the kiosk browser's memory.
export const MAX_IMAGE_SIDE = 4096;
export const MAX_IMAGE_PIXELS = 16_000_000;
const DEFAULT_ASSETS_MAX_MB = 2048;

/** Total asset storage quota in bytes: SURAU_ASSETS_MAX_MB, default 2 GB; invalid values fall back. */
export function assetsMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.SURAU_ASSETS_MAX_MB ?? '').trim();
  const mb = /^\d{1,7}$/.test(raw) ? Number(raw) : 0;
  return (mb > 0 ? mb : DEFAULT_ASSETS_MAX_MB) * 1024 * 1024;
}

const ID_RE = /^[0-9a-f]{64}$/;
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'audio/mpeg': 'mp3',
};

export const isAssetId = (id: string): boolean => ID_RE.test(id);

export const assetsDirOf = (dataDir: string): string => join(dataDir, 'assets');

/** ID3 tag, or an MPEG audio frame sync (11 set bits) with a valid layer. */
function looksLikeMp3(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf.toString('ascii', 0, 3) === 'ID3') return true;
  return buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0 && (buf[1]! & 0x06) !== 0;
}

export function putAsset(
  db: DatabaseSync,
  dataDir: string,
  buf: Buffer,
  declaredMime: string,
  actor: string,
): AssetMeta {
  const declared = declaredMime.split(';')[0]!.trim().toLowerCase();
  if (buf.length === 0) throw new AssetError(['empty upload']);

  let mime: string;
  let width: number | null = null;
  let height: number | null = null;
  if (declared === 'audio/mpeg') {
    if (buf.length > MAX_AUDIO_BYTES) throw new AssetError(['audio is larger than 20 MB']);
    if (!looksLikeMp3(buf)) throw new AssetError(['file is not an MP3 (type mismatch with audio/mpeg)']);
    mime = 'audio/mpeg';
  } else if (declared === 'image/jpeg' || declared === 'image/png' || declared === 'image/webp') {
    if (buf.length > MAX_IMAGE_BYTES) throw new AssetError(['image is larger than 8 MB']);
    const header = readImageHeader(buf);
    if (header === null) throw new AssetError(['file is not a readable JPEG, PNG or WebP image']);
    if (header.mime !== declared) {
      throw new AssetError([`image type mismatch: content is ${header.mime}, declared ${declared}`]);
    }
    if (header.width > MAX_IMAGE_SIDE || header.height > MAX_IMAGE_SIDE) {
      throw new AssetError([`image is larger than ${MAX_IMAGE_SIDE} px on a side`]);
    }
    if (header.width * header.height > MAX_IMAGE_PIXELS) {
      throw new AssetError(['image is larger than 16 megapixels']);
    }
    mime = header.mime;
    width = header.width;
    height = header.height;
  } else {
    throw new AssetError(['unsupported type; use image/jpeg, image/png, image/webp or audio/mpeg']);
  }

  const id = createHash('sha256').update(buf).digest('hex');
  const dir = assetsDirOf(dataDir);
  const path = join(dir, `${id}.${EXT[mime]}`);
  const existing = db.prepare('SELECT 1 AS ok FROM assets WHERE id = ?').get(id);

  if (existing === undefined && assetsTotalBytes(db) + buf.length > assetsMaxBytes()) {
    throw new AssetError(
      ['Ruang simpanan aset penuh. Padam fail yang tidak digunakan atau tambah had SURAU_ASSETS_MAX_MB.'],
      413,
    );
  }

  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, buf);
      renameSync(tmp, path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
  if (existing !== undefined) {
    return { id, mime, bytes: buf.length, width, height, created: false };
  }
  db.prepare(
    'INSERT INTO assets (id, mime, bytes, width, height, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, mime, buf.length, width, height, new Date().toISOString(), actor);
  return { id, mime, bytes: buf.length, width, height, created: true };
}

export function getAssetPath(db: DatabaseSync, dataDir: string, id: string): { path: string; mime: string } | null {
  if (!ID_RE.test(id)) return null;
  const row = db.prepare('SELECT mime FROM assets WHERE id = ?').get(id);
  if (row === undefined || typeof row.mime !== 'string') return null;
  const ext = EXT[row.mime];
  if (ext === undefined) return null;
  const path = join(assetsDirOf(dataDir), `${id}.${ext}`);
  return existsSync(path) ? { path, mime: row.mime } : null;
}

export function assetsTotalBytes(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM assets').get();
  return Number(row?.total ?? 0);
}

export const MAX_LISTED_ASSETS = 500;

export interface ListedAudio {
  id: string;
  bytes: number;
  createdAt: string;
}

/** The stored MP3 files, newest first, at most [MAX_LISTED_ASSETS] (for the first-azan picker). Ids and sizes only. */
export function listAudioAssets(db: DatabaseSync): { assets: ListedAudio[]; truncated: boolean } {
  const rows = db
    .prepare("SELECT id, bytes, created_at FROM assets WHERE mime = 'audio/mpeg' ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(MAX_LISTED_ASSETS + 1);
  const assets = rows.slice(0, MAX_LISTED_ASSETS).map((r) => ({ id: String(r.id), bytes: Number(r.bytes), createdAt: String(r.created_at) }));
  return { assets, truncated: rows.length > MAX_LISTED_ASSETS };
}

export interface ListedImage {
  id: string;
  width: number | null;
  height: number | null;
  bytes: number;
  createdAt: string;
}

/**
 * The stored pictures, newest first, at most [MAX_LISTED_ASSETS]. Renders the box made itself
 * (derived assets) are left out, so only the originals show. `truncated` is true when more
 * than the cap exist. No paths, no file names, no audio.
 */
export function listImageAssets(db: DatabaseSync): { assets: ListedImage[]; truncated: boolean } {
  const rows = db
    .prepare(
      `SELECT id, width, height, bytes, created_at FROM assets
       WHERE mime LIKE 'image/%' AND id NOT IN (SELECT derived_id FROM asset_derivatives)
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(MAX_LISTED_ASSETS + 1);
  const assets = rows.slice(0, MAX_LISTED_ASSETS).map((r) => ({
    id: String(r.id),
    width: r.width === null ? null : Number(r.width),
    height: r.height === null ? null : Number(r.height),
    bytes: Number(r.bytes),
    createdAt: String(r.created_at),
  }));
  return { assets, truncated: rows.length > MAX_LISTED_ASSETS };
}
