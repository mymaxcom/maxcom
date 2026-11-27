import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { STORE_ITEMS, walkFiles } from './setAside.ts';

/*
 * The store move of cases X and N-X (plan 2026-11-19 phase 2B; table `docs/design/plans/2026-11-23-adopt-store-table.md`).
 * SECURITY code.
 *
 * The GIVER (the box whose data is kept and which becomes the follower) makes a consistent copy of its database and
 * lists it with its media files, each with its size and sha256. The RECEIVER (the box that becomes the master) pulls
 * every file over the pinned box-to-box channel into `linkstage/<linkId>/`, resumes after a drop with a range request,
 * and accepts a file only when its size and hash match the list. Nothing in the receiver's store changes here: the
 * staged store is adopted at the next start (journal op `adopt`).
 *
 * Who may read: the list is given only in answer to a signed `store-list` message of the session's peer, and comes
 * with a fresh read token (32 random bytes; only its hash is kept; a new list replaces the token). A file request
 * must carry that token, name the open session, and ask for a path that is IN the list: a path is never joined from
 * the request, so `..`, absolute paths and backslashes cannot reach anything else.
 *
 * Never listed: `import/` (scratch), every secret file (the cloud key never crosses; the YouTube sign-in and the
 * camera address cross sealed inside the commit, see `work.ts`), the live state files.
 */

export const STAGE_DIR = 'linkstage';
const OUT_DIR = 'linkstage-out';
const DB_REL = 'surau.db';
/** Media folders that move with a store, from STORE_ITEMS; `import/` is scratch and stays. */
const MOVED_MEDIA = STORE_ITEMS.filter((i) => i.group === 'media' && i.rel !== 'import').map((i) => i.rel);
const TOKEN_HEADER = 'x-link-store';
const LINK_ID_RE = /^[0-9a-f]{32}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
/** A listed path: forward slashes, no empty, `.` or `..` segment, no drive or root. */
const SEGMENT_RE = /^[^\\/\0:]{1,200}$/;
const isListedPath = (p: string): boolean => {
  if (p.length === 0 || p.length > 400) return false;
  const segs = p.split('/');
  // no empty segment (so no leading, trailing or double slash), no `.` or `..`, no backslash, colon or NUL
  return segs.every((s) => SEGMENT_RE.test(s) && s !== '.' && s !== '..');
};
/**
 * The list travels in pages of at most PAGE_FILES entries, each one JSON answer read with a 2 MiB cap
 * (`peerClient.ts`; 2,000 entries of the longest listed path stay near 1 MiB). A store of more files than this
 * fails before anything changed.
 */
export const MAX_FILES = 100_000;
export const PAGE_FILES = 2000;

export interface MoveFile {
  path: string;
  size: number;
  sha256: string;
}
export interface MoveList {
  linkId: string;
  dbLevel: number;
  release: string;
  files: MoveFile[];
  bytes: number;
}

export class StoreMoveError extends Error {
  readonly code: 'no_space' | 'hash' | 'peer' | 'bad_list';
  readonly detail: { needBytes?: number; freeBytes?: number; path?: string };
  constructor(code: StoreMoveError['code'], detail: StoreMoveError['detail'] = {}) {
    super(`store move: ${code}`);
    this.code = code;
    this.detail = detail;
  }
}

/** sha256 and size of a file, read as a stream (a 1 GB video must not stop the server for seconds). */
export function hashFile(path: string): Promise<{ size: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    let size = 0;
    const s = createReadStream(path);
    s.on('data', (c: Buffer | string) => {
      const b = typeof c === 'string' ? Buffer.from(c) : c;
      size += b.length;
      h.update(b);
    });
    s.on('error', reject);
    s.on('end', () => resolve({ size, sha256: h.digest('hex') }));
  });
}

/** The unlink's reduced copy (phase 2D, D3) is made and served from its own out folder. */
export const UNLINK_OUT_DIR = 'unlinkcopy-out';
const outDirOf = (dataDir: string, linkId: string, outRel: string = OUT_DIR): string => join(dataDir, outRel, linkId);
export const stageDirOf = (dataDir: string, linkId: string): string => join(dataDir, STAGE_DIR, linkId);
/** Where the giver's database copy is made (a caller that changes the copy before listing it). */
export const outDbOf = (dataDir: string, linkId: string, outRel: string = OUT_DIR): string => join(outDirOf(dataDir, linkId, outRel), DB_REL);

/** Where a listed path lives on the giver: the database copy in the out folder, media in the data folder. */
const giverPath = (dataDir: string, outRel: string, linkId: string, rel: string): string =>
  rel === DB_REL ? join(outDirOf(dataDir, linkId, outRel), DB_REL) : join(dataDir, ...rel.split('/'));

/** Giver: a consistent copy of the database and the list of everything that moves. */
export async function buildMoveList(o: { dataDir: string; db: DatabaseSync; linkId: string; dbLevel: number; release: string }): Promise<MoveList> {
  if (!LINK_ID_RE.test(o.linkId)) throw new StoreMoveError('bad_list');
  const out = outDirOf(o.dataDir, o.linkId);
  rmSync(join(o.dataDir, OUT_DIR), { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  o.db.prepare('VACUUM INTO ?').run(join(out, DB_REL));
  return listOut({ ...o, outRel: OUT_DIR, mediaDirs: MOVED_MEDIA });
}

/**
 * The list of a database copy already in `<outRel>/<linkId>/surau.db` and of the media of `mediaDirs` (a subset of
 * the moved media), less what `skip` names.
 */
export async function listOut(o: {
  dataDir: string; linkId: string; dbLevel: number; release: string; outRel: string; mediaDirs: readonly string[]; skip?: (rel: string) => boolean;
}): Promise<MoveList> {
  if (!LINK_ID_RE.test(o.linkId) || o.mediaDirs.some((d) => !MOVED_MEDIA.includes(d))) throw new StoreMoveError('bad_list');
  const files: MoveFile[] = [];
  const add = async (rel: string): Promise<void> => {
    const h = await hashFile(giverPath(o.dataDir, o.outRel, o.linkId, rel));
    files.push({ path: rel, size: h.size, sha256: h.sha256 });
  };
  await add(DB_REL);
  const media = o.mediaDirs.flatMap((dir) => walkFiles(join(o.dataDir, ...dir.split('/'))).map((rel) => `${dir}/${rel}`))
    .filter((rel) => o.skip === undefined || !o.skip(rel));
  // More files than one list answer can carry: the link fails before anything changed (recorded limit).
  if (media.length + 1 > MAX_FILES) throw new StoreMoveError('bad_list');
  for (const rel of media) await add(rel);
  return { linkId: o.linkId, dbLevel: o.dbLevel, release: o.release, files, bytes: files.reduce((n, f) => n + f.size, 0) };
}

/** Giver: drop the database copy (link finished, failed or cancelled). */
export function dropMoveOut(dataDir: string, outRel: string = OUT_DIR): void {
  rmSync(join(dataDir, outRel), { recursive: true, force: true });
}

/** One entry of a list that came from the peer, read strictly; `seen` holds the lower-cased paths taken so far. */
function parseFile(f: unknown, seen: Set<string>): MoveFile {
  const r = (typeof f === 'object' && f !== null ? f : {}) as Record<string, unknown>;
  const path = r.path;
  if (typeof path !== 'string' || !isListedPath(path) || seen.has(path.toLowerCase())) throw new StoreMoveError('bad_list');
  if (path !== DB_REL && !MOVED_MEDIA.some((d) => path.startsWith(`${d}/`))) throw new StoreMoveError('bad_list');
  if (!Number.isSafeInteger(r.size) || (r.size as number) < 0 || typeof r.sha256 !== 'string' || !SHA_RE.test(r.sha256)) throw new StoreMoveError('bad_list');
  seen.add(path.toLowerCase());
  return { path, size: r.size as number, sha256: r.sha256 };
}

/** Strict reading of a list that came from the peer (or of the plan this box wrote from one). */
export function parseMoveList(v: unknown, linkId: string): MoveList {
  const m = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  if (m.linkId !== linkId || !Array.isArray(m.files) || m.files.length === 0 || m.files.length > MAX_FILES) throw new StoreMoveError('bad_list');
  if (!Number.isSafeInteger(m.dbLevel) || typeof m.release !== 'string') throw new StoreMoveError('bad_list');
  const seen = new Set<string>();
  const files: MoveFile[] = [];
  for (const f of m.files as unknown[]) files.push(parseFile(f, seen));
  if (!files.some((f) => f.path === DB_REL)) throw new StoreMoveError('bad_list');
  return { linkId, dbLevel: m.dbLevel as number, release: m.release, files, bytes: files.reduce((n, f) => n + f.size, 0) };
}

// ---------------------------------------------------------------- the list in pages

/** What the giver answers for one page of the list (page 0 also carries the read token, added by the route). */
export interface MovePage {
  linkId: string;
  dbLevel: number;
  release: string;
  bytes: number;
  /** All entries of the list, over all pages. */
  total: number;
  page: number;
  pages: number;
  files: MoveFile[];
}

export const pagesOf = (total: number): number => Math.max(1, Math.ceil(total / PAGE_FILES));

/**
 * Giver, page 0: the same page, plus the older `list` field when the whole list fits this one page, so a receiver of the
 * previous release (which reads `list`) works with this box. A longer list has no such form: that receiver then stops
 * with its own "bad list" and nothing changes (it never retries a list it cannot read).
 */
export function firstPageOf(list: MoveList): MovePage & { list?: MoveList } {
  const p = pageOfList(list, 0)!;
  return p.pages === 1 ? { ...p, list } : p;
}

/** Giver: page `page` of a finished list, or null for a page that does not exist. The list is built once and sliced. */
export function pageOfList(list: MoveList, page: unknown): MovePage | null {
  const pages = pagesOf(list.files.length);
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 0 || page >= pages) return null;
  return {
    linkId: list.linkId, dbLevel: list.dbLevel, release: list.release, bytes: list.bytes, total: list.files.length, page, pages,
    files: list.files.slice(page * PAGE_FILES, (page + 1) * PAGE_FILES),
  };
}

/**
 * The page number a signed `store-list` body asks for: a whole number inside the cap, else null. A body without
 * `page` (a box of the older release, or page 0 asked the old way) is page 0.
 */
export function requestedPage(v: unknown): number | null {
  if (v === undefined) return 0;
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < pagesOf(MAX_FILES) ? v : null;
}

/**
 * Receiver: the whole list from its pages. `first` is the answer to page 0 (already known to be `ready`); `fetchPage(n)`
 * returns the JSON of the answer to page n, or throws. Every page must belong to the same list (link, level, release,
 * total, page count), hold exactly the entries its place calls for, repeat no path of an earlier page, and page 0 must
 * hold the database file. The sum of the entries is the only `bytes` believed.
 */
export async function collectPages(first: unknown, fetchPage: (page: number) => Promise<unknown>, linkId: string): Promise<MoveList> {
  // A giver of the older release (2026.11.14) answers the whole list in a `list` field and knows no pages.
  const old = (typeof first === 'object' && first !== null ? first : {}) as Record<string, unknown>;
  if (old.list !== undefined && old.files === undefined) return parseMoveList(old.list, linkId);
  const seen = new Set<string>();
  const files: MoveFile[] = [];
  let head: { dbLevel: number; release: string; total: number; pages: number } | null = null;
  const take = (v: unknown, want: number): void => {
    const m = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
    if (m.linkId !== linkId || m.page !== want || !Array.isArray(m.files)) throw new StoreMoveError('bad_list');
    const { dbLevel, release, total, pages } = m;
    if (!Number.isSafeInteger(dbLevel) || typeof release !== 'string') throw new StoreMoveError('bad_list');
    if (!Number.isSafeInteger(total) || (total as number) < 1 || (total as number) > MAX_FILES || pages !== pagesOf(total as number)) throw new StoreMoveError('bad_list');
    const h = { dbLevel: dbLevel as number, release, total: total as number, pages: pages as number };
    if (head === null) head = h;
    else if (head.dbLevel !== h.dbLevel || head.release !== h.release || head.total !== h.total || head.pages !== h.pages) throw new StoreMoveError('bad_list');
    const expect = want < h.pages - 1 ? PAGE_FILES : h.total - PAGE_FILES * (h.pages - 1);
    if (m.files.length !== expect) throw new StoreMoveError('bad_list');
    const here = (m.files as unknown[]).map((f) => parseFile(f, seen));
    if (want === 0 && !here.some((f) => f.path === DB_REL)) throw new StoreMoveError('bad_list');
    files.push(...here);
  };
  take(first, 0);
  for (let n = 1; n < head!.pages; n++) take(await fetchPage(n), n);
  if (files.length !== head!.total) throw new StoreMoveError('bad_list');
  return { linkId, dbLevel: head!.dbLevel, release: head!.release, files, bytes: files.reduce((n, f) => n + f.size, 0) };
}

// ---------------------------------------------------------------- giver: the read grant

export interface StoreGrant {
  /** Answer to a signed `store-list` of the session's peer: the list and a fresh token (the old one stops working). */
  issue(list: MoveList): string;
  /** The file a request may read, or null (wrong link, wrong token, path not listed, grant ended). */
  fileFor(linkId: string, token: string | undefined, rel: string): { abs: string; size: number } | null;
  /** End the grant (session finished) and drop the database copy. */
  end(): void;
}

export function createStoreGrant(dataDir: string, outRel: string = OUT_DIR): StoreGrant {
  let open: { linkId: string; tokenHash: Buffer; files: Map<string, MoveFile> } | null = null;
  const hashOf = (t: string): Buffer => createHash('sha256').update(t).digest();
  return {
    issue(list) {
      const token = randomBytes(32).toString('base64url');
      open = { linkId: list.linkId, tokenHash: hashOf(token), files: new Map(list.files.map((f) => [f.path, f])) };
      return token;
    },
    fileFor(linkId, token, rel) {
      if (open === null || linkId !== open.linkId || typeof token !== 'string' || token.length < 40 || token.length > 64) return null;
      if (!timingSafeEqual(hashOf(token), open.tokenHash)) return null;
      const f = open.files.get(rel);
      if (f === undefined) return null;
      return { abs: giverPath(dataDir, outRel, open.linkId, rel), size: f.size };
    },
    end() {
      open = null;
      dropMoveOut(dataDir, outRel);
    },
  };
}

export const STORE_TOKEN_HEADER = TOKEN_HEADER;

/** `Range: bytes=<start>-` (the only form the receiver sends); null when absent or not that form. */
export function rangeStart(header: string | undefined, size: number): number | null {
  if (header === undefined) return null;
  const m = /^bytes=(\d{1,15})-$/.exec(header.trim());
  if (m === null) return null;
  const n = Number(m[1]);
  return n <= size ? n : null;
}

// ---------------------------------------------------------------- receiver: the pull

export interface PullOptions {
  list: MoveList;
  stageDir: string;
  /** GET one listed file from the giver, from `start` on (a `Range` request when start > 0). */
  fetch(path: string, start: number): Promise<IncomingMessage>;
  freeBytes(): number | null;
  /** The disk must keep this many bytes free after the whole store landed (K10 floor). */
  floorBytes: number;
  onProgress?(doneBytes: number, totalBytes: number): void;
  /** Tries per file after a dropped connection (each resumes where the last stopped). */
  retries?: number;
  sleep?(ms: number): Promise<void>;
}

const partOf = (abs: string): string => `${abs}.part`;
const sizeOf = (p: string): number => {
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
};

/** The giver answered 429: how many seconds it asked the receiver to wait. */
class ThrottledError extends Error {
  readonly waitSec: number;
  constructor(waitSec: number) {
    super('peer: throttled');
    this.waitSec = waitSec;
  }
}
/** How many pauses one file may take before the pull gives up (each is at most two minutes). */
const MAX_THROTTLED = 30;

/** Receiver: pull every listed file into the stage folder; resumes; accepts a file only when size and hash match. */
export async function pullStore(o: PullOptions): Promise<void> {
  const retries = o.retries ?? 5;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const total = o.list.bytes;
  mkdirSync(o.stageDir, { recursive: true });

  // What is still to come, and the space check BEFORE the first byte.
  let have = 0;
  let need = 0;
  for (const f of o.list.files) {
    const abs = join(o.stageDir, ...f.path.split('/'));
    if (sizeOf(abs) === f.size) have += f.size;
    else need += f.size - Math.max(0, Math.min(sizeOf(partOf(abs)), f.size));
  }
  const free = o.freeBytes();
  if (free !== null && free - need < o.floorBytes) {
    throw new StoreMoveError('no_space', { needBytes: need + o.floorBytes, freeBytes: free });
  }

  let done = have;
  o.onProgress?.(done, total);
  for (const f of o.list.files) {
    const abs = join(o.stageDir, ...f.path.split('/'));
    if (sizeOf(abs) === f.size) {
      // landed in an earlier try: still checked, a file is never trusted by its size
      if ((await hashFile(abs)).sha256 === f.sha256) continue;
      rmSync(abs, { force: true });
      done -= f.size;
    }
    mkdirSync(dirname(abs), { recursive: true });
    const part = partOf(abs);
    // An empty listed file has nothing to fetch: it is made here and checked like any other.
    if (f.size === 0) writeFileSync(part, '');
    let throttled = 0;
    for (let attempt = 0; ; attempt++) {
      let start = Math.max(0, sizeOf(part));
      if (start > f.size) {
        rmSync(part, { force: true });
        start = 0;
      }
      try {
        if (start < f.size) await receiveInto(part, start, await o.fetch(f.path, start), f.size, (n) => o.onProgress?.(done + n, total));
        break;
      } catch (e) {
        if (e instanceof ThrottledError && throttled++ < MAX_THROTTLED) {
          // the same try again after the pause the giver asked for; it does not use up a retry
          attempt--;
          await sleep(e.waitSec * 1000);
          continue;
        }
        if (e instanceof StoreMoveError || attempt >= retries) throw e instanceof StoreMoveError ? e : new StoreMoveError('peer', { path: f.path });
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      }
    }
    const h = await hashFile(part);
    if (h.size !== f.size || h.sha256 !== f.sha256) {
      rmSync(part, { force: true });
      throw new StoreMoveError('hash', { path: f.path });
    }
    renameSync(part, abs);
    done += f.size;
    o.onProgress?.(done, total);
  }
}

/** Append the answer to `part` from `start`; refuses an answer that does not start where it was asked to. */
function receiveInto(part: string, start: number, res: IncomingMessage, size: number, progress: (n: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const status = res.statusCode ?? 0;
    const okStatus = start === 0 ? status === 200 || status === 206 : status === 206;
    const cr = res.headers['content-range'];
    const from = typeof cr === 'string' ? /^bytes (\d+)-/.exec(cr) : null;
    if (status === 429) {
      // the giver's general limiter (600 a minute) said wait: not a failure of the file, the pull pauses and asks again
      const ra = Number(res.headers['retry-after']);
      res.resume();
      reject(new ThrottledError(Number.isFinite(ra) && ra > 0 ? Math.min(120, Math.ceil(ra)) : 5));
      return;
    }
    if (!okStatus || (start > 0 && (from === null || Number(from[1]) !== start))) {
      res.resume();
      reject(new Error(`peer status ${status}`));
      return;
    }
    if (start === 0 && existsSync(part)) rmSync(part, { force: true });
    const out = createWriteStream(part, { flags: start === 0 ? 'w' : 'a' });
    let got = start;
    res.on('data', (c: Buffer) => {
      got += c.length;
      if (got > size) {
        // more than listed: the partial file is worthless, drop it so the next try starts clean
        res.unpipe(out);
        res.destroy();
        out.destroy();
        out.once('close', () => {
          rmSync(part, { force: true });
          reject(new StoreMoveError('hash', {}));
        });
        return;
      }
      progress(got);
    });
    res.on('error', (e) => out.destroy(e));
    res.pipe(out);
    out.on('error', reject);
    out.on('finish', () => (res.complete ? resolve() : reject(new Error('peer: cut'))));
  });
}

/** Receiver: remove every stage folder except the one a planned adopt still needs (at start, and after a failure). */
export function sweepStage(dataDir: string, keepLinkId: string | null): void {
  const root = join(dataDir, STAGE_DIR);
  if (!existsSync(root)) return;
  if (keepLinkId === null) {
    rmSync(root, { recursive: true, force: true });
    return;
  }
  // One folder per link id under the stage root: drop every folder (and stray file) but the one kept.
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory() && e.name === keepLinkId) continue;
    rmSync(join(root, e.name), { recursive: true, force: true });
  }
}
