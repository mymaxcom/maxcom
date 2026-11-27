import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

/**
 * What a follower box keeps of its master on its own disk, under `<dataDir>/follow/`:
 * the last bundle, content and live state as JSON, and the files they name (pictures, audio, theme files, videos).
 *
 * Every write is atomic (a temporary name, then a rename), so a power cut leaves the old copy or the new one and never
 * a half file. A file is VERIFIED before it takes its name: a picture, audio file or video whose id is the sha256 of
 * its bytes must hash to that id; any other file must have the length the master announced. The JSON is never evicted.
 */

/** The free space kept for the rest of the box (the kiosk page, the database, the log). */
export const DEFAULT_FLOOR_BYTES = 500 * 1024 * 1024;

export type FileKind = 'video' | 'image' | 'theme' | 'other';

export interface FileSpec {
  kind: FileKind;
  mime: string;
  /** The id of a content-addressed file: the bytes must hash to it, else the file is refused. */
  sha256?: string;
  /** The length the master announced (`content-length`); a file of another length is refused. */
  length?: number | null;
  /** The master's `etag`, kept beside the file. */
  etag?: string | null;
}

export type PutResult = 'stored' | 'corrupt' | 'no_space' | 'failed';

export interface CachedFile {
  key: string;
  path: string;
  size: number;
  mime: string;
  kind: FileKind;
  etag: string | null;
  /** True when the bytes were checked against their sha256 id (false: only the length was checked). */
  hashChecked: boolean;
}

export interface FollowCache {
  /** Atomic. False when the disk refused it (the old copy stays). */
  putJson(name: string, value: unknown): boolean;
  getJson<T = unknown>(name: string): T | null;
  /** The stored file, or null. Does not count as shown. */
  info(key: string): CachedFile | null;
  /** The stored file for serving: counts as shown now (least-recently-shown eviction). */
  open(key: string): CachedFile | null;
  /** Writes `source` under `key` when it verifies and fits. A file that does not fit is not stored. */
  putFile(key: string, spec: FileSpec, source: Readable): Promise<PutResult>;
  remove(key: string): void;
  stats(): { bytes: number; files: number };
}

export interface FollowCacheOptions {
  /** `<dataDir>/follow`. */
  dir: string;
  /** Free bytes on the disk that holds `dir`; null when unknown (then nothing is held back). */
  freeBytes: () => number | null;
  floorBytes?: number;
  now?: () => Date;
}

interface Meta {
  kind: FileKind;
  mime: string;
  size: number;
  etag: string | null;
  hashChecked: boolean;
  shownAt: number;
}

const KEY_RE = /^[A-Za-z0-9_-]{1,100}$/;
const JSON_NAME_RE = /^[a-z0-9-]{1,40}$/;
const MIME_RE = /^[a-z0-9][a-z0-9.+-]{0,60}\/[a-z0-9][a-z0-9.+-]{0,100}(?:\s*;\s*[a-z0-9=._-]{1,60})?$/i;
const SHA_RE = /^[0-9a-f]{64}$/;
const KINDS: readonly FileKind[] = ['video', 'image', 'theme', 'other'];
/** How often the shown-at time of a file is written back to its small sidecar. */
const TOUCH_WRITE_MS = 60_000;
/** While one file is written, the free space is looked at again this often. */
const RECHECK_BYTES = 4 * 1024 * 1024;

/** Key of an asset file: its sha256 id. */
export const assetKey = (id: string): string => `a-${id}`;
/** Key of a theme file: from the request path, which is not a safe file name. */
export const themeKey = (path: string): string => `t-${createHash('sha256').update(path).digest('hex').slice(0, 40)}`;

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function createFollowCache(o: FollowCacheOptions): FollowCache {
  const floor = o.floorBytes ?? DEFAULT_FLOOR_BYTES;
  const now = o.now ?? ((): Date => new Date());
  const jsonDir = join(o.dir, 'json');
  const filesDir = join(o.dir, 'files');
  mkdirSync(jsonDir, { recursive: true });
  mkdirSync(filesDir, { recursive: true });

  const index = new Map<string, Meta>();
  const persistedAt = new Map<string, number>();
  let tmpSeq = 0;
  const pathOf = (key: string): string => join(filesDir, key);
  const metaPath = (key: string): string => join(filesDir, `${key}.meta`);

  // Start-up: drop what a crash left half done, and read back what is whole.
  for (const name of readdirSync(filesDir)) {
    if (name.endsWith('.tmp')) rmSync(join(filesDir, name), { force: true });
  }
  for (const name of readdirSync(filesDir)) {
    if (!name.endsWith('.meta')) continue;
    const key = name.slice(0, -5);
    try {
      const m = JSON.parse(readFileSync(join(filesDir, name), 'utf8')) as Partial<Meta>;
      if (
        !KEY_RE.test(key) || !KINDS.includes(m.kind as FileKind) || typeof m.mime !== 'string' || !MIME_RE.test(m.mime) ||
        typeof m.size !== 'number' || typeof m.shownAt !== 'number' || statSync(pathOf(key)).size !== m.size
      ) throw new Error('bad');
      index.set(key, {
        kind: m.kind as FileKind, mime: m.mime, size: m.size, etag: typeof m.etag === 'string' ? m.etag : null,
        hashChecked: m.hashChecked === true, shownAt: m.shownAt,
      });
    } catch {
      rmSync(join(filesDir, name), { force: true });
      rmSync(pathOf(key), { force: true });
    }
  }
  // A body file without a sidecar was never finished.
  for (const name of readdirSync(filesDir)) {
    if (!name.endsWith('.meta') && !index.has(name)) rmSync(join(filesDir, name), { force: true });
  }

  const free = (): number => {
    const f = o.freeBytes();
    return f === null ? Number.POSITIVE_INFINITY : f;
  };

  const persistMeta = (key: string, m: Meta): void => {
    try {
      writeAtomic(metaPath(key), JSON.stringify(m));
      persistedAt.set(key, now().getTime());
    } catch {
      // The sidecar is a convenience for eviction order; the file stays valid.
    }
  };

  const drop = (key: string): void => {
    index.delete(key);
    persistedAt.delete(key);
    rmSync(metaPath(key), { force: true });
    rmSync(pathOf(key), { force: true });
  };

  const view = (key: string, m: Meta): CachedFile => ({ key, path: pathOf(key), size: m.size, mime: m.mime, kind: m.kind, etag: m.etag, hashChecked: m.hashChecked });

  /**
   * Makes `need` more bytes fit above the floor by deleting the least recently shown files: videos first, then the
   * rest (a new video never costs a picture). False when it cannot be done; nothing is deleted then... except what was
   * already freed on the way, which was evictable by the same rule.
   */
  const makeRoom = (need: number, kind: FileKind, self: string): boolean => {
    if (free() - need >= floor) return true;
    const order = (k: FileKind): number => (k === 'video' ? 0 : 1);
    const victims = [...index.entries()]
      .filter(([key, m]) => key !== self && (kind !== 'video' || m.kind === 'video'))
      .sort((a, b) => order(a[1].kind) - order(b[1].kind) || a[1].shownAt - b[1].shownAt);
    for (const [key] of victims) {
      drop(key);
      if (free() - need >= floor) return true;
    }
    return free() - need >= floor;
  };

  return {
    putJson(name, value) {
      if (!JSON_NAME_RE.test(name)) return false;
      try {
        writeAtomic(join(jsonDir, `${name}.json`), JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },

    getJson<T>(name: string): T | null {
      if (!JSON_NAME_RE.test(name)) return null;
      try {
        return JSON.parse(readFileSync(join(jsonDir, `${name}.json`), 'utf8')) as T;
      } catch {
        return null;
      }
    },

    info(key) {
      const m = index.get(key);
      return m === undefined || !existsSync(pathOf(key)) ? null : view(key, m);
    },

    open(key) {
      const m = index.get(key);
      if (m === undefined || !existsSync(pathOf(key))) return null;
      const t = now().getTime();
      m.shownAt = t;
      if (t - (persistedAt.get(key) ?? 0) >= TOUCH_WRITE_MS) persistMeta(key, m);
      return view(key, m);
    },

    async putFile(key, spec, source) {
      // A stream that errors before the copy starts reading must not become an uncaught exception.
      source.on('error', () => undefined);
      const fail = (r: PutResult): PutResult => {
        source.destroy();
        return r;
      };
      if (!KEY_RE.test(key) || !KINDS.includes(spec.kind) || !MIME_RE.test(spec.mime)) return fail('failed');
      if (spec.sha256 !== undefined && !SHA_RE.test(spec.sha256)) return fail('corrupt');
      const announced = typeof spec.length === 'number' && Number.isSafeInteger(spec.length) && spec.length >= 0 ? spec.length : null;
      if (announced === 0) return fail('corrupt');
      if (!makeRoom(announced ?? 0, spec.kind, key)) return fail('no_space');

      const tmp = pathOf(`${key}.${process.pid}.${++tmpSeq}.tmp`);
      const hash = createHash('sha256');
      let size = 0;
      let sinceCheck = 0;
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        handle = await open(tmp, 'w', 0o600);
        for await (const chunk of source) {
          const buf = chunk as Buffer;
          size += buf.length;
          sinceCheck += buf.length;
          if (announced !== null && size > announced) {
            await handle.close();
            handle = null;
            rmSync(tmp, { force: true });
            return fail('corrupt');
          }
          if (sinceCheck >= RECHECK_BYTES) {
            sinceCheck = 0;
            if (!makeRoom(0, spec.kind, key)) {
              await handle.close();
              handle = null;
              rmSync(tmp, { force: true });
              return fail('no_space');
            }
          }
          hash.update(buf);
          await handle.write(buf);
        }
        await handle.close();
        handle = null;
      } catch {
        if (handle !== null) await handle.close().catch(() => undefined);
        rmSync(tmp, { force: true });
        return fail('failed');
      }

      // Verify before the file takes its name.
      if (size === 0 || (announced !== null && size !== announced) || (spec.sha256 !== undefined && hash.digest('hex') !== spec.sha256)) {
        rmSync(tmp, { force: true });
        return 'corrupt';
      }
      if (!makeRoom(0, spec.kind, key)) {
        rmSync(tmp, { force: true });
        return 'no_space';
      }
      try {
        renameSync(tmp, pathOf(key));
      } catch {
        rmSync(tmp, { force: true });
        return 'failed';
      }
      const meta: Meta = {
        kind: spec.kind, mime: spec.mime, size, etag: spec.etag ?? null, hashChecked: spec.sha256 !== undefined, shownAt: now().getTime(),
      };
      index.set(key, meta);
      persistMeta(key, meta);
      return 'stored';
    },

    remove(key) {
      if (KEY_RE.test(key)) drop(key);
    },

    stats() {
      let bytes = 0;
      for (const m of index.values()) bytes += m.size;
      return { bytes, files: index.size };
    },
  };
}
