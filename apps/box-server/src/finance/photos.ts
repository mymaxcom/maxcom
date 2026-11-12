/**
 * Count-sheet and receipt photos. They never enter the public `/assets/` store (the kiosk identity can read that):
 * they live under <dataDir>/finance/photos/<sha256>.jpg and are served only by a `finance:write` route.
 * JPEG only, at most 2 MB and 4096 px a side. Nothing here logs a photo id or its bytes.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MAX_PHOTO_BYTES } from '@surau/core';
import type { PhotoMeta } from '@surau/core';
import { readImageHeader } from '../assets/imageHeader.ts';
import { logChange } from '../auth/users.ts';
import type { ChangeMeta } from '../sync/meta.ts';
import { DEFAULT_SURAU_ID } from '../sync/verify.ts';

export { MAX_PHOTO_BYTES };
export const MAX_PHOTO_SIDE_PX = 4096;
const DEFAULT_PHOTOS_MAX_MB = 500;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
export const PHOTO_ID_RE = /^[0-9a-f]{64}$/;

export class PhotoError extends Error {
  status: 400 | 413;
  errors: string[];
  constructor(errors: string[], status: 400 | 413 = 400) {
    super(errors.join('; '));
    this.name = 'PhotoError';
    this.status = status;
    this.errors = errors;
  }
}

export const photosDirOf = (dataDir: string): string => join(dataDir, 'finance', 'photos');

/** Folder quota in bytes: SURAU_FINANCE_PHOTOS_MAX_MB, default 500 MB; invalid values fall back. */
export function photosMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const mb = Number((env.SURAU_FINANCE_PHOTOS_MAX_MB ?? '').trim());
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_PHOTOS_MAX_MB) * 1024 * 1024;
}

export function photosTotalBytes(db: DatabaseSync): number {
  return Number(db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM finance_photos WHERE present = 1').get()!.n);
}

function rowOf(r: Record<string, unknown>): PhotoMeta {
  return { id: String(r.id), entryId: String(r.entry_id), mime: String(r.mime), bytes: Number(r.bytes), present: Number(r.present) === 1 };
}

export function photoMeta(db: DatabaseSync, id: string): PhotoMeta | null {
  if (!PHOTO_ID_RE.test(id)) return null;
  const r = db.prepare('SELECT * FROM finance_photos WHERE id = ?').get(id);
  return r === undefined ? null : rowOf(r);
}

export function listPhotoMeta(db: DatabaseSync): PhotoMeta[] {
  return db.prepare('SELECT * FROM finance_photos ORDER BY created_at, id').all().map(rowOf);
}

/** Header check shared by the upload route, the sync op and the site route; returns the dimensions. */
export function checkJpeg(buf: Buffer): { width: number; height: number } {
  if (buf.length === 0) throw new PhotoError(['empty upload']);
  if (buf.length > MAX_PHOTO_BYTES) throw new PhotoError(['photo is larger than 2 MB'], 413);
  const h = readImageHeader(buf);
  if (h === null || h.mime !== 'image/jpeg') throw new PhotoError(['photo must be a JPEG image']);
  if (h.width > MAX_PHOTO_SIDE_PX || h.height > MAX_PHOTO_SIDE_PX) {
    throw new PhotoError([`photo is larger than ${MAX_PHOTO_SIDE_PX} px on a side`]);
  }
  return { width: h.width, height: h.height };
}

export const sha256Of = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/**
 * The checks for bytes that arrive for a photo row another server made (the sync route and the cloud puller): the
 * length must be what the row says and the folder quota that `putPhoto` enforces holds here too.
 */
export function checkReplicatedBytes(db: DatabaseSync, meta: PhotoMeta, buf: Buffer): void {
  if (buf.length !== meta.bytes) throw new PhotoError(['photo size does not match its record']);
  if (photosTotalBytes(db) + buf.length > photosMaxBytes()) throw new PhotoError(['Ruang simpanan foto kewangan penuh.'], 413);
}

/** Writes the bytes under their hash (tmp file then rename, owner-only where the OS allows). */
export function writePhotoFile(dataDir: string, id: string, buf: Buffer): void {
  if (!PHOTO_ID_RE.test(id)) throw new PhotoError(['invalid photo id']);
  const dir = photosDirOf(dataDir);
  const path = join(dir, `${id}.jpg`);
  if (existsSync(path)) return;
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, buf, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Store one photo for an entry. An existing id returns its row (the same bytes are never stored twice); a photo
 * whose row exists without its bytes (`present = 0`, the cloud before the box pushed them) gets them filled in.
 * The caller owns the transaction.
 */
export function putPhoto(
  db: DatabaseSync, dataDir: string, buf: Buffer, entryId: string, actor: string, now: Date, meta?: ChangeMeta,
): PhotoMeta {
  if (!SAFE_ID.test(entryId)) throw new PhotoError(['entry id is not valid']);
  const dims = checkJpeg(buf);
  const id = sha256Of(buf);
  const existing = photoMeta(db, id);
  if (existing !== null && existing.present) return existing;
  if (photosTotalBytes(db) + buf.length > photosMaxBytes()) {
    throw new PhotoError(['Ruang simpanan foto kewangan penuh.'], 413);
  }
  writePhotoFile(dataDir, id, buf);
  if (existing !== null) {
    db.prepare('UPDATE finance_photos SET present = 1 WHERE id = ?').run(id);
    return { ...existing, present: true };
  }
  const saved: PhotoMeta = { id, entryId, mime: 'image/jpeg', bytes: buf.length, present: true };
  db.prepare(
    `INSERT INTO finance_photos (surau_id, id, entry_id, mime, bytes, width, height, created_at, created_by, present)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(DEFAULT_SURAU_ID, id, entryId, 'image/jpeg', buf.length, dims.width, dims.height, now.toISOString(), actor);
  // Metadata only: the bytes are never in the change history.
  logChange(db, actor, 'finance:photo', id, undefined, { entryId, mime: 'image/jpeg', bytes: buf.length }, meta);
  return saved;
}

/** The file of a photo whose bytes are on this server, or null. */
export function photoPath(db: DatabaseSync, dataDir: string, id: string): { path: string; mime: string } | null {
  const m = photoMeta(db, id);
  if (m === null || !m.present) return null;
  const path = join(photosDirOf(dataDir), `${id}.jpg`);
  return existsSync(path) ? { path, mime: m.mime } : null;
}

export function markPresent(db: DatabaseSync, id: string): void {
  db.prepare('UPDATE finance_photos SET present = 1 WHERE id = ?').run(id);
}
