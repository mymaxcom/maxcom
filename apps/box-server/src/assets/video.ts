import { createHash, randomBytes } from 'node:crypto';
import { closeSync, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DatabaseSync } from 'node:sqlite';
import { VIDEO_LIMITS, VIDEO_MIME } from '@surau/core';
import type { VideoErrorCode } from '@surau/core';
import { AssetError, assetsDirOf, assetsMaxBytes, assetsTotalBytes } from './store.ts';

/** A refused video upload: `code` is the stable answer the app maps to its own text, `status` the HTTP status. */
export class VideoError extends AssetError {
  readonly code: VideoErrorCode;
  constructor(code: VideoErrorCode, message: string, status = 400) {
    super([message], status);
    this.name = 'VideoError';
    this.code = code;
  }
}

/** The BM sentence that goes with each code (`errors[0]`, for an older app that shows the sentence). */
const MSG: Record<VideoErrorCode, string> = {
  too_big: 'Video terlalu besar (paling besar 300 MB dan 720p)',
  too_long: 'Video terlalu panjang (paling lama 10 minit)',
  not_h264: 'Video mesti MP4 dengan H.264',
  no_space: 'Ruang storan kotak tidak mencukupi',
  upload_failed: 'Muat naik video gagal',
  busy: 'Video lain sedang dimuat naik ke kotak. Cuba sebentar lagi.',
};

const fail = (code: VideoErrorCode, status = 400): VideoError => new VideoError(code, MSG[code], status);

/** What the box learns from a stored MP4 without decoding it. */
export interface Mp4Facts {
  /** First video track's sample entry type (`avc1` and `avc3` are H.264). */
  codec: string | null;
  width: number;
  height: number;
  durationSec: number;
}

const MAX_MOOV_BYTES = 32 * 1024 * 1024;
/** At most this many boxes are walked at the top level, and at most this many inside `moov` (a hostile file of tiny boxes is refused, not walked). */
export const MAX_TOP_BOXES = 10_000;
export const MAX_MOOV_BOXES = 10_000;
/** The top-level walk reads the file in blocks of this size, never one small read per box. */
const BLOCK_BYTES = 64 * 1024;
/** Top-level boxes that may be empty (encoders write an 8-byte `free`); any other needs at least 8 bytes of payload. */
const MAY_BE_EMPTY = new Set(['mdat', 'free', 'skip', 'wide']);

function readAt(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, pos + got);
    if (n <= 0) break;
    got += n;
  }
  return got === len ? buf : buf.subarray(0, got);
}

interface BoxAt { type: string; start: number; size: number; header: number }

/** The box that starts at `pos` inside [pos, end), or null when it is malformed. */
function boxAt(read: (pos: number, len: number) => Buffer, pos: number, end: number): BoxAt | null {
  if (pos + 8 > end) return null;
  const h = read(pos, 16);
  if (h.length < 8) return null;
  let size = h.readUInt32BE(0);
  const type = h.toString('latin1', 4, 8);
  let header = 8;
  if (size === 1) {
    if (h.length < 16) return null;
    const big = h.readBigUInt64BE(8);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(big);
    header = 16;
  } else if (size === 0) {
    size = end - pos;
  }
  if (size < header || pos + size > end) return null;
  return { type, start: pos, size, header };
}

class TooManyBoxes extends Error {}

/** The boxes inside `box`; `budget.left` counts down across every call of one file and throws when it runs out. */
function children(read: (pos: number, len: number) => Buffer, box: BoxAt, budget: { left: number }): BoxAt[] {
  const out: BoxAt[] = [];
  let pos = box.start + box.header;
  const end = box.start + box.size;
  while (pos < end) {
    const b = boxAt(read, pos, end);
    if (b === null) break;
    if (--budget.left < 0) throw new TooManyBoxes();
    out.push(b);
    pos += b.size;
  }
  return out;
}

/** Reads through a 64 KB block cache: the top-level walk costs one read per block, not one per box. */
function blockReader(fd: number, total: number): (pos: number, len: number) => Buffer {
  let blockStart = -1;
  let block: Buffer = Buffer.alloc(0);
  return (pos, len) => {
    if (len > BLOCK_BYTES) return readAt(fd, pos, len);
    if (blockStart < 0 || pos < blockStart || pos + len > blockStart + block.length) {
      blockStart = pos;
      block = readAt(fd, pos, Math.min(BLOCK_BYTES, Math.max(0, total - pos)));
    }
    return block.subarray(pos - blockStart, pos - blockStart + len);
  };
}

/**
 * Reads the facts of an MP4 (ISO base media file) from its boxes: `ftyp` first, `moov` anywhere at the top level,
 * then the movie header (length) and the first video track's sample entry (codec, picture size). Null when the file is
 * not an MP4 or its `moov` is missing, too big or unreadable. Only box headers and `moov` are read, never the media.
 */
export function readMp4Facts(path: string): Mp4Facts | null {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const total = fstatSync(fd).size;
    const read = blockReader(fd, total);
    const first = boxAt(read, 0, total);
    if (first === null || first.type !== 'ftyp') return null;
    let moov: BoxAt | null = null;
    let count = 0;
    for (let pos = 0; pos < total;) {
      if (++count > MAX_TOP_BOXES) return null;
      const b = boxAt(read, pos, total);
      if (b === null) return null;
      if (b.size - b.header < 8 && !MAY_BE_EMPTY.has(b.type)) return null;
      if (b.type === 'moov') {
        moov = b;
        break;
      }
      pos += b.size;
    }
    if (moov === null || moov.size > MAX_MOOV_BYTES) return null;
    const body = readAt(fd, moov.start, moov.size);
    const mem = (pos: number, len: number): Buffer => body.subarray(pos - moov.start, pos - moov.start + len);
    const budget = { left: MAX_MOOV_BOXES };
    let durationSec: number | null = null;
    let codec: string | null = null;
    let width = 0;
    let height = 0;
    for (const c of children(mem, moov, budget)) {
      if (c.type === 'mvhd') {
        const v = mem(c.start + c.header, 32);
        const version = v[0];
        let scale = 0;
        let dur = 0;
        if (version === 1 && v.length >= 32) {
          scale = v.readUInt32BE(20);
          dur = Number(v.readBigUInt64BE(24));
        } else if (version === 0 && v.length >= 20) {
          scale = v.readUInt32BE(12);
          dur = v.readUInt32BE(16);
        }
        // no time scale or no length (a fragmented file says 0 here): the length cannot be checked, so it is refused
        if (scale === 0 || dur === 0) return null;
        durationSec = dur / scale;
      } else if (c.type === 'trak' && codec === null) {
        const mdia = children(mem, c, budget).find((x) => x.type === 'mdia');
        if (!mdia) continue;
        const parts = children(mem, mdia, budget);
        const hdlr = parts.find((x) => x.type === 'hdlr');
        const minf = parts.find((x) => x.type === 'minf');
        if (!hdlr || !minf) continue;
        if (mem(hdlr.start + 16, 4).toString('latin1') !== 'vide') continue;
        const stbl = children(mem, minf, budget).find((x) => x.type === 'stbl');
        const stsd = stbl ? children(mem, stbl, budget).find((x) => x.type === 'stsd') : undefined;
        if (!stsd) continue;
        // stsd: header, version/flags (4), entry count (4), then the first sample entry.
        const entry = stsd.start + stsd.header + 8;
        const e = mem(entry, 36);
        if (e.length < 36) continue;
        codec = e.toString('latin1', 4, 8);
        width = e.readUInt16BE(32);
        height = e.readUInt16BE(34);
      }
    }
    // no movie header: the length is unknown, so it is refused
    if (durationSec === null) return null;
    return { codec, width, height, durationSec };
  } catch {
    return null;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

const H264 = new Set(['avc1', 'avc3']);

/** Checks the facts of an MP4 against the limits; throws a coded VideoError. */
export function checkMp4Facts(facts: Mp4Facts | null): Mp4Facts {
  if (facts === null || facts.codec === null || !H264.has(facts.codec)) throw fail('not_h264');
  const long = Math.max(facts.width, facts.height);
  const short = Math.min(facts.width, facts.height);
  // 720p: the long side up to 1280 and the short side up to 720 (a portrait phone video is 720 x 1280).
  if (long > Math.round((VIDEO_LIMITS.maxHeight * 16) / 9) || short > VIDEO_LIMITS.maxHeight) throw fail('too_big', 413);
  if (facts.durationSec > VIDEO_LIMITS.maxSeconds + 1) throw fail('too_long');
  return facts;
}

export interface VideoLimits {
  maxFileBytes: number;
  totalBytes: number;
  minFreeBytes: number;
}

export const defaultVideoLimits = (): VideoLimits => ({
  maxFileBytes: VIDEO_LIMITS.maxFileBytes,
  totalBytes: VIDEO_LIMITS.totalBytes,
  minFreeBytes: VIDEO_LIMITS.minFreeBytes,
});

/** Free bytes on the disk holding `dir`, or null when it cannot be read (then the free-space rule is not applied). */
export type FreeBytes = (dir: string) => number | null;
export const statfsFreeBytes: FreeBytes = (dir) => {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
};

export function videoBytesUsed(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM assets WHERE mime = ?').get(VIDEO_MIME);
  return Number(row?.n ?? 0);
}

/** What the editor's "Ruang storan kotak" line shows. */
export interface VideoStorage {
  usedBytes: number;
  totalBytes: number;
  /** Room left for videos: the quota left, the room the box would still keep free, whichever is smaller (never negative). */
  availableBytes: number;
  maxFileBytes: number;
  maxSeconds: number;
  maxHeight: number;
}

/**
 * What is going on with uploads on one database: whether one is being received (the box takes one at a time) and the
 * bytes it declared, which are counted as used until it ends (so the room shown and the checks never promise the same
 * space twice). Kept per database so the tests' apps do not see each other.
 */
interface UploadState { busy: boolean; reservedBytes: number }
const uploads = new WeakMap<DatabaseSync, UploadState>();
const uploadState = (db: DatabaseSync): UploadState => {
  let s = uploads.get(db);
  if (s === undefined) {
    s = { busy: false, reservedBytes: 0 };
    uploads.set(db, s);
  }
  return s;
};

/** The bytes promised to an upload in progress (0 when none is running). */
export function videoBytesReserved(db: DatabaseSync): number {
  return uploads.get(db)?.reservedBytes ?? 0;
}

/**
 * Holds on stored videos that were just received but are not yet in a saved item. One hold per received upload (a
 * second editor that uploads the same file adds its own); a hold lasts an hour at most. A held video is never removed
 * because some other item stopped pointing at it, so the editor's save that follows finds its file.
 */
export const VIDEO_HOLD_MS = 60 * 60_000;
const holds = new WeakMap<DatabaseSync, Map<string, number[]>>();

function liveHolds(db: DatabaseSync, id: string, nowMs: number): number[] {
  const m = holds.get(db);
  const list = (m?.get(id) ?? []).filter((until) => until > nowMs);
  if (m !== undefined) {
    if (list.length === 0) m.delete(id);
    else m.set(id, list);
  }
  return list;
}

export function holdVideo(db: DatabaseSync, id: string, nowMs: number = Date.now()): void {
  let m = holds.get(db);
  if (m === undefined) {
    m = new Map();
    holds.set(db, m);
  }
  m.set(id, [...liveHolds(db, id, nowMs), nowMs + VIDEO_HOLD_MS]);
}

/** Ends one hold of `id` (an item now points at it, or the editor gave up its pick). */
export function releaseVideoHold(db: DatabaseSync, id: string, nowMs: number = Date.now()): void {
  const list = liveHolds(db, id, nowMs);
  if (list.length === 0) return;
  list.sort((a, b) => a - b).shift();
  const m = holds.get(db)!;
  if (list.length === 0) m.delete(id);
  else m.set(id, list);
}

export function isVideoHeld(db: DatabaseSync, id: string, nowMs: number = Date.now()): boolean {
  return liveHolds(db, id, nowMs).length > 0;
}

export function videoStorage(db: DatabaseSync, dataDir: string, free: FreeBytes = statfsFreeBytes, limits: VideoLimits = defaultVideoLimits()): VideoStorage {
  const used = videoBytesUsed(db);
  const reserved = videoBytesReserved(db);
  const quotaLeft = Math.max(0, limits.totalBytes - used - reserved);
  const f = free(dataDir);
  const diskLeft = f === null ? Number.POSITIVE_INFINITY : Math.max(0, f - reserved - limits.minFreeBytes);
  const assetsLeft = Math.max(0, assetsMaxBytes() - assetsTotalBytes(db) - reserved);
  return {
    usedBytes: used,
    totalBytes: limits.totalBytes,
    availableBytes: Math.min(quotaLeft, diskLeft, assetsLeft),
    maxFileBytes: limits.maxFileBytes,
    maxSeconds: VIDEO_LIMITS.maxSeconds,
    maxHeight: VIDEO_LIMITS.maxHeight,
  };
}

export interface VideoMeta {
  id: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  durationSec: number;
  created: boolean;
}

const TMP_PREFIX = '.video-';

/** The slowest an upload may be, on average over this window, before it is cut off (a client that trickles bytes). */
export const VIDEO_MIN_RATE = { bytesPerSec: 20 * 1024, windowMs: 60_000 };
/** The whole upload must end by its deadline: the declared size at 100 KB/s, never under 2 or over 30 minutes. */
export function videoDeadlineMs(declaredBytes: number): number {
  return Math.min(30 * 60_000, Math.max(2 * 60_000, Math.ceil((declaredBytes / (100 * 1024)) * 1000)));
}

export interface ReceiveVideoOptions {
  free?: FreeBytes;
  limits?: VideoLimits;
  /** Test hooks: the whole-upload deadline (default from the declared size) and the minimum rate. */
  deadlineMs?: number;
  minRate?: { bytesPerSec: number; windowMs: number };
  /** How often the rate is looked at (default 5 s). */
  rateCheckMs?: number;
}

/**
 * Stores an uploaded MP4. The body is streamed to a temporary file in the assets folder (never held in memory) while it
 * is hashed; the file is then read as an MP4 (H.264, picture size, length) and only a good one is renamed to
 * `<sha256>.mp4` and recorded. Every refusal and every failed or cut-off upload removes the temporary file, so a
 * failure leaves nothing behind. `declaredBytes` is the request's Content-Length: size, quota and free space are checked
 * against it before a byte is read, and it is reserved until the upload ends. One upload at a time (`busy`, 409). The
 * upload is cut off (`upload_failed`, 408) when it passes its deadline or runs slower than the minimum rate.
 * A received video is held (see `holdVideo`) until an item points at it.
 */
export async function receiveVideo(
  db: DatabaseSync,
  dataDir: string,
  body: Readable,
  declaredBytes: number | null,
  actor: string,
  opts: ReceiveVideoOptions = {},
): Promise<VideoMeta> {
  const limits = opts.limits ?? defaultVideoLimits();
  const free = opts.free ?? statfsFreeBytes;
  if (declaredBytes === null || !Number.isSafeInteger(declaredBytes) || declaredBytes <= 0) throw fail('upload_failed', 411);
  if (declaredBytes > limits.maxFileBytes) throw fail('too_big', 413);
  const state = uploadState(db);
  if (state.busy) throw fail('busy', 409);
  const dir = assetsDirOf(dataDir);
  mkdirSync(dir, { recursive: true });
  const reserved = state.reservedBytes;
  if (videoBytesUsed(db) + reserved + declaredBytes > limits.totalBytes) throw fail('no_space', 413);
  if (assetsTotalBytes(db) + reserved + declaredBytes > assetsMaxBytes()) throw fail('no_space', 413);
  const f = free(dir);
  if (f !== null && f - reserved - declaredBytes < limits.minFreeBytes) throw fail('no_space', 413);

  state.busy = true;
  state.reservedBytes += declaredBytes;
  const tmp = join(dir, `${TMP_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  const hash = createHash('sha256');
  let size = 0;
  const minRate = opts.minRate ?? VIDEO_MIN_RATE;
  const startedMs = Date.now();
  // the bytes seen at each rate check, oldest first, so the rate over the last window can be read
  const samples: { at: number; size: number }[] = [{ at: startedMs, size: 0 }];
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      // A body longer than it said it was (or than the limit) is cut off at once.
      if (size > declaredBytes || size > limits.maxFileBytes) return cb(fail('too_big', 413));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  const cutOff = (): void => {
    meter.destroy(fail('upload_failed', 408));
  };
  const deadline = setTimeout(cutOff, opts.deadlineMs ?? videoDeadlineMs(declaredBytes));
  const rateTimer = setInterval(() => {
    const now = Date.now();
    samples.push({ at: now, size });
    while (samples.length > 1 && samples[1]!.at <= now - minRate.windowMs) samples.shift();
    const oldest = samples[0]!;
    // judged only once a whole window has passed since the start
    if (now - startedMs >= minRate.windowMs && now - oldest.at >= minRate.windowMs) {
      const rate = ((size - oldest.size) * 1000) / (now - oldest.at);
      if (rate < minRate.bytesPerSec) cutOff();
    }
  }, opts.rateCheckMs ?? 5_000);
  try {
    await pipeline(body, meter, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    if (size !== declaredBytes) throw fail('upload_failed');
    const facts = checkMp4Facts(readMp4Facts(tmp));
    const id = hash.digest('hex');
    const final = join(dir, `${id}.mp4`);
    const existing = db.prepare('SELECT 1 AS ok FROM assets WHERE id = ?').get(id);
    if (existing !== undefined) {
      rmSync(tmp, { force: true });
      // the same file is already stored: it is marked fresh (the sweep's age counts from now) and held for this editor
      db.prepare('UPDATE assets SET created_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      holdVideo(db, id);
      return { id, mime: VIDEO_MIME, bytes: size, width: facts.width, height: facts.height, durationSec: Math.round(facts.durationSec), created: false };
    }
    if (existsSync(final)) rmSync(final, { force: true });
    renameSync(tmp, final);
    try {
      db.prepare('INSERT INTO assets (id, mime, bytes, width, height, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, VIDEO_MIME, size, facts.width, facts.height, new Date().toISOString(), actor);
    } catch (error) {
      rmSync(final, { force: true });
      throw error;
    }
    holdVideo(db, id);
    return { id, mime: VIDEO_MIME, bytes: size, width: facts.width, height: facts.height, durationSec: Math.round(facts.durationSec), created: true };
  } catch (error) {
    rmSync(tmp, { force: true });
    if (error instanceof VideoError) throw error;
    throw fail('upload_failed');
  } finally {
    clearTimeout(deadline);
    clearInterval(rateTimer);
    state.busy = false;
    state.reservedBytes = Math.max(0, state.reservedBytes - declaredBytes);
  }
}

/** The video asset ids a live or any-state content item points at (all suraus on this database). */
export function referencedVideoIds(db: DatabaseSync): Set<string> {
  const ids = new Set<string>();
  for (const row of db.prepare("SELECT json FROM content_items WHERE kind = 'video' AND deleted_at IS NULL").all()) {
    try {
      const j = JSON.parse(String(row.json)) as { assetId?: unknown };
      if (typeof j.assetId === 'string') ids.add(j.assetId);
    } catch {
      /* an unreadable row refers to nothing */
    }
  }
  return ids;
}

/**
 * Removes one stored video (file and row) when no live video item refers to it and no editor holds it (a fresh upload
 * not yet saved in its item); false when it is kept or absent.
 */
export function removeVideoIfUnused(db: DatabaseSync, dataDir: string, id: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(id)) return false;
  const row = db.prepare('SELECT mime FROM assets WHERE id = ?').get(id);
  if (row === undefined || row.mime !== VIDEO_MIME) return false;
  if (isVideoHeld(db, id)) return false;
  if (referencedVideoIds(db).has(id)) return false;
  db.prepare('DELETE FROM assets WHERE id = ?').run(id);
  rmSync(join(assetsDirOf(dataDir), `${id}.mp4`), { force: true });
  return true;
}

/** The box's own orphan sweep: at start and every 6 hours, removing unused videos older than a day. */
export const VIDEO_SWEEP_EVERY_MS = 6 * 60 * 60_000;
export const VIDEO_SWEEP_MIN_AGE_MS = 24 * 60 * 60_000;

/** How young a video must be for the editor's "drop my pick" to remove it (an older one may be someone's library). */
export const VIDEO_DROP_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * The editor gave up a video it uploaded (another pick, or the editor was closed): its hold ends, and the video is
 * removed when no item refers to it, no other editor still holds it, and it is younger than a day.
 * `removed` false with `found` true: it was kept (in use, held or old).
 */
export function dropFreshVideo(db: DatabaseSync, dataDir: string, id: string, now: Date = new Date()): { found: boolean; removed: boolean } {
  if (!/^[0-9a-f]{64}$/.test(id)) return { found: false, removed: false };
  const row = db.prepare('SELECT mime, created_at FROM assets WHERE id = ?').get(id);
  if (row === undefined || row.mime !== VIDEO_MIME) return { found: false, removed: false };
  releaseVideoHold(db, id, now.getTime());
  const created = Date.parse(String(row.created_at));
  if (!Number.isFinite(created) || now.getTime() - created > VIDEO_DROP_MAX_AGE_MS) return { found: true, removed: false };
  return { found: true, removed: removeVideoIfUnused(db, dataDir, id) };
}

/**
 * Deletes what no video item refers to: stored videos older than `minAgeMs` (a video just uploaded is not yet in an
 * item, so a fresh one is kept), stray temporary files of cut-off uploads, and an `.mp4` file with no row. Returns the
 * number of videos and files removed.
 */
export function sweepVideoOrphans(db: DatabaseSync, dataDir: string, minAgeMs: number, now: Date = new Date()): number {
  const dir = assetsDirOf(dataDir);
  let removed = 0;
  const used = referencedVideoIds(db);
  // never younger than the hold: a video an editor has just uploaded (or matched) is waiting for its item
  const cutoff = new Date(now.getTime() - Math.max(minAgeMs, VIDEO_HOLD_MS)).toISOString();
  for (const row of db.prepare('SELECT id, created_at FROM assets WHERE mime = ?').all(VIDEO_MIME)) {
    const id = String(row.id);
    if (used.has(id) || String(row.created_at) > cutoff || isVideoHeld(db, id, now.getTime())) continue;
    db.prepare('DELETE FROM assets WHERE id = ?').run(id);
    rmSync(join(dir, `${id}.mp4`), { force: true });
    removed += 1;
  }
  if (!existsSync(dir)) return removed;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      const old = now.getTime() - statSync(path).mtimeMs > minAgeMs;
      if (name.startsWith(TMP_PREFIX) && name.endsWith('.tmp') && old) {
        rmSync(path, { force: true });
        removed += 1;
      } else if (/^[0-9a-f]{64}\.mp4$/.test(name) && old && db.prepare('SELECT 1 AS ok FROM assets WHERE id = ?').get(name.slice(0, 64)) === undefined) {
        rmSync(path, { force: true });
        removed += 1;
      }
    } catch {
      /* gone meanwhile */
    }
  }
  return removed;
}
