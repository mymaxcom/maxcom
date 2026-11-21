import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { VIDEO_LIMITS } from '@surau/core';
import { identityCan } from '../auth/authz.ts';
import { exemptFromRequestTimeout } from '../serverLimits.ts';
import { VIDEO_MIN_RATE, statfsFreeBytes, videoDeadlineMs } from '../assets/video.ts';
import type { FreeBytes } from '../assets/video.ts';

/**
 * Recording merge (2026.11.14, contract C, web and iPad): a live recorded in the browser is several pieces in the
 * browser store. After the live the app uploads the pieces of that live here, the box joins them into ONE file with ffmpeg's
 * concat demuxer (`-c copy`: never re-encoded, so it works on the slim Android ffmpeg), offers it for download and
 * forgets pieces and file once the app confirms it saved the file (or after 7 days).
 *
 * Routes (box only; the device that ran the live, or an administrator, as for stopping a live):
 *   POST   /api/live/recordings/<liveId>/pieces/<n>  raw bytes, Content-Type video/mp4 | video/webm (also audio/*), Content-Length
 *   POST   /api/live/recordings/<liveId>/join        optional JSON { count }
 *   GET    /api/live/recordings/<liveId>/file        the joined file
 *   DELETE /api/live/recordings/<liveId>             saved or given up: pieces and file go
 * A refusal is `{ errors, code }`; codes: unknown_live 404, not_owner 403, bad_piece 400, upload_failed 408/411,
 * too_big 413, no_space 413, mixed_types 409, already_joined 409, busy 409, no_pieces 409, missing_piece 409, join_failed 500, not_ready 404.
 */

export const RECORDING_LIMITS = {
  /** One piece, as big as one uploaded video. */
  maxPieceBytes: VIDEO_LIMITS.maxFileBytes,
  /** All pieces of one live together (a long live, joined once). */
  maxLiveBytes: 4 * 1024 * 1024 * 1024,
  /** At most this many pieces for one live. */
  maxPieces: 1000,
  /** A recording nobody saved is removed after this long. */
  keepMs: 7 * 24 * 60 * 60 * 1000,
  /** The join may take this long (a long live copied once). */
  joinTimeoutMs: 20 * 60 * 1000,
  /** Piece uploads running at once on the whole box. */
  maxConcurrentUploads: 2,
} as const;

const LIVE_ID = /^[A-Za-z0-9_-]{6,64}$/;
const CONTAINER_OF: Record<string, 'mp4' | 'webm'> = { 'video/mp4': 'mp4', 'audio/mp4': 'mp4', 'video/webm': 'webm', 'audio/webm': 'webm' };
const MIME_OF = { mp4: 'video/mp4', webm: 'video/webm' } as const;

export class RecordingError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status: number, code: string, message = code): RecordingError => new RecordingError(status, code, message);

interface Meta {
  liveId: string;
  deviceId: string | null;
  /** 'mp4' or 'webm', fixed by the first piece. */
  container: 'mp4' | 'webm';
  createdAt: string;
  updatedAt: string;
  joined: { file: string; bytes: number; at: string } | null;
}

export interface JoinRun {
  code: number | null;
  stderr: string;
}
/** Runs ffmpeg with an args array (no shell). A test passes a fake. */
export type JoinRunner = (ffmpeg: string, args: readonly string[], timeoutMs: number) => Promise<JoinRun>;

export const spawnJoin: JoinRunner = (ffmpeg, args, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    let err = '';
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stderr: err.slice(-4000) });
    };
    let child;
    try {
      child = spawn(ffmpeg, [...args], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      resolve({ code: null, stderr: 'spawn failed' });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, timeoutMs);
    child.stderr.on('data', (b: Buffer) => {
      err += b.toString('utf8');
      if (err.length > 16_000) err = err.slice(-8000);
    });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });

export interface RecordingOptions {
  dataDir: string;
  ffmpegPath: () => string | null;
  now?: () => Date;
  free?: FreeBytes;
  run?: JoinRunner;
  keepMs?: number;
  maxPieceBytes?: number;
  maxLiveBytes?: number;
  minFreeBytes?: number;
  /** Test hooks: the piece upload's deadline, minimum rate, rate check interval and concurrency cap. */
  deadlineMs?: number;
  minRate?: { bytesPerSec: number; windowMs: number };
  rateCheckMs?: number;
  maxConcurrentUploads?: number;
  /** Where the details of a failed join go (never to the caller). */
  log?: (message: string) => void;
}

const pieceName = (n: number, container: string): string => `piece-${String(n).padStart(5, '0')}.${container}`;
const PIECE_RE = /^piece-(\d{5})\.(mp4|webm)$/;

/** The concat demuxer list: one `file '<name>'` per piece, bare file names (the list sits in the pieces folder); a single quote in a name is written as `'\''`. */
export function concatList(names: readonly string[]): string {
  return names.map((p) => `file '${p.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`).join('\n') + '\n';
}

/** The containers a piece may be (what `-format_whitelist` lets the demuxers open). */
const JOIN_FORMATS = 'concat,mov,mp4,m4a,3gp,3g2,mj2,matroska,webm';

/**
 * The ffmpeg arguments of the join: copy every stream of every piece into one file. Only the local file protocol and the
 * container demuxers are allowed (no network, no playlists), and the list holds bare names, so there is no `-safe 0`.
 */
export function joinArgs(listFile: string, out: string): string[] {
  return ['-hide_banner', '-nostats', '-loglevel', 'error', '-protocol_whitelist', 'file', '-format_whitelist', JOIN_FORMATS, '-f', 'concat', '-i', listFile, '-c', 'copy', '-y', out];
}

/** True when the first bytes are the container: the mp4 family has `ftyp` at offset 4, webm/mkv starts with the EBML id 1A 45 DF A3. */
export function magicOk(container: 'mp4' | 'webm', head: Buffer): boolean {
  if (container === 'mp4') return head.length >= 8 && head.toString('latin1', 4, 8) === 'ftyp';
  return head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
}

export class Recordings {
  private readonly o: RecordingOptions;
  private readonly root: string;
  private readonly joining = new Set<string>();
  private readonly uploading = new Set<string>();
  private active = 0;

  constructor(o: RecordingOptions) {
    this.o = o;
    this.root = join(o.dataDir, 'live-recordings');
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }
  private dirOf(liveId: string): string {
    return join(this.root, liveId);
  }
  private readMeta(liveId: string): Meta | null {
    try {
      return JSON.parse(readFileSync(join(this.dirOf(liveId), 'meta.json'), 'utf8')) as Meta;
    } catch {
      return null;
    }
  }
  private writeMeta(m: Meta): void {
    const dir = this.dirOf(m.liveId);
    const tmp = join(dir, `meta.${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
    renameSync(tmp, join(dir, 'meta.json'));
  }
  private pieces(liveId: string): Array<{ n: number; bytes: number; file: string }> {
    const dir = this.dirOf(liveId);
    if (!existsSync(dir)) return [];
    const out: Array<{ n: number; bytes: number; file: string }> = [];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    for (const f of names) {
      const m = PIECE_RE.exec(f);
      if (m === null) continue;
      try {
        out.push({ n: Number(m[1]), bytes: statSync(join(dir, f)).size, file: join(dir, f) });
      } catch {
        // the file went away between the listing and the stat: it is not a piece any more
      }
    }
    return out.sort((a, b) => a.n - b.n);
  }

  /** Whose live this is: the device that started it (read from the live's start record), or undefined when no such live. */
  static ownerOf(db: DatabaseSync, liveId: string): { deviceId: string | null } | undefined {
    const row = db.prepare("SELECT after_json AS j FROM change_log WHERE entity = 'live' AND entity_id = ? ORDER BY id ASC LIMIT 1").get(liveId);
    if (typeof row?.j !== 'string') return undefined;
    try {
      const j = JSON.parse(row.j) as { deviceId?: unknown };
      return { deviceId: typeof j.deviceId === 'string' ? j.deviceId : null };
    } catch {
      return { deviceId: null };
    }
  }

  /** Receives piece `n` (streamed to disk, replacing an earlier upload of the same piece). */
  async putPiece(liveId: string, deviceId: string | null, n: number, mime: string, declared: number | null, body: NodeJS.ReadableStream): Promise<{ n: number; bytes: number; pieces: number; totalBytes: number }> {
    const container = CONTAINER_OF[mime];
    if (container === undefined) throw fail(400, 'bad_piece', 'unsupported type');
    if (!Number.isInteger(n) || n < 0 || n >= RECORDING_LIMITS.maxPieces) throw fail(400, 'bad_piece', 'bad piece number');
    if (declared === null || !Number.isSafeInteger(declared) || declared <= 0) throw fail(411, 'upload_failed', 'Content-Length required');
    const maxPiece = this.o.maxPieceBytes ?? RECORDING_LIMITS.maxPieceBytes;
    if (declared > maxPiece) throw fail(413, 'too_big');
    if (this.joining.has(liveId) || this.uploading.has(liveId)) throw fail(409, 'busy');
    // at most this many piece uploads at once on the whole box (each holds a disk file and a socket)
    if (this.active >= (this.o.maxConcurrentUploads ?? RECORDING_LIMITS.maxConcurrentUploads)) throw fail(409, 'busy');
    const dir = this.dirOf(liveId);
    mkdirSync(dir, { recursive: true });
    let meta = this.readMeta(liveId);
    const have = this.pieces(liveId);
    if (meta !== null && meta.joined !== null) {
      // the joined file stands and the pieces are gone: a late piece must never destroy the recording
      if (existsSync(join(dir, meta.joined.file))) throw fail(409, 'already_joined');
      meta.joined = null;
    }
    // a first attempt that failed leaves no piece behind: its container is forgotten
    if (meta !== null && have.length === 0) meta = null;
    if (meta !== null && meta.container !== container) throw fail(409, 'mixed_types');
    const replaced = have.find((p) => p.n === n)?.bytes ?? 0;
    const total = have.reduce((s, p) => s + p.bytes, 0) - replaced + declared;
    if (total > (this.o.maxLiveBytes ?? RECORDING_LIMITS.maxLiveBytes)) throw fail(413, 'too_big');
    // the join needs about as much room again as the pieces take
    const f = (this.o.free ?? statfsFreeBytes)(dir);
    if (f !== null && f - declared < (this.o.minFreeBytes ?? VIDEO_LIMITS.minFreeBytes)) throw fail(413, 'no_space');

    this.uploading.add(liveId);
    this.active += 1;
    const tmp = join(dir, `.upload-${randomBytes(6).toString('hex')}.tmp`);
    let size = 0;
    // the first bytes must be the container the type names (a text, playlist or list file is refused)
    const need = container === 'mp4' ? 8 : 4;
    let head = Buffer.alloc(0);
    let headChecked = false;
    // a refused body is read to its end and thrown away (not cut off): the client then gets its answer instead of a reset connection
    let refused: RecordingError | null = null;
    const checkHead = (): void => {
      headChecked = true;
      if (!magicOk(container, head)) refused = fail(400, 'bad_piece', 'not a recording');
    };
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > declared) return cb(fail(413, 'too_big'));
        if (!headChecked) {
          head = Buffer.concat([head, chunk.subarray(0, need)]).subarray(0, need);
          if (head.length >= need) checkHead();
        }
        if (refused !== null) return cb();
        cb(null, chunk);
      },
      flush(cb) {
        if (!headChecked) checkHead();
        cb(refused);
      },
    });
    // the whole upload has a deadline and a minimum rate, as a video upload has (a trickle must not hold the live's slot)
    const minRate = this.o.minRate ?? VIDEO_MIN_RATE;
    const startedMs = Date.now();
    const samples: Array<{ at: number; size: number }> = [{ at: startedMs, size: 0 }];
    const cutOff = (): void => {
      meter.destroy(fail(408, 'upload_failed', 'too slow'));
    };
    const deadline = setTimeout(cutOff, this.o.deadlineMs ?? videoDeadlineMs(declared));
    const rateTimer = setInterval(() => {
      const now = Date.now();
      samples.push({ at: now, size });
      while (samples.length > 1 && samples[1]!.at <= now - minRate.windowMs) samples.shift();
      const oldest = samples[0]!;
      if (now - startedMs >= minRate.windowMs && now - oldest.at >= minRate.windowMs && ((size - oldest.size) * 1000) / (now - oldest.at) < minRate.bytesPerSec) cutOff();
    }, this.o.rateCheckMs ?? 5_000);
    try {
      await pipeline(body as NodeJS.ReadableStream, meter, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      if (size !== declared) throw fail(408, 'upload_failed', 'short body');
      renameSync(tmp, join(dir, pieceName(n, container)));
      // the first stored piece fixes the container; a failed first attempt leaves no meta behind
      const iso = this.now().toISOString();
      if (meta === null) meta = { liveId, deviceId, container, createdAt: iso, updatedAt: iso, joined: null };
      meta.updatedAt = iso;
      this.writeMeta(meta);
    } catch (error) {
      rmSync(tmp, { force: true });
      if (error instanceof RecordingError) throw error;
      throw fail(408, 'upload_failed');
    } finally {
      clearTimeout(deadline);
      clearInterval(rateTimer);
      this.uploading.delete(liveId);
      this.active -= 1;
    }
    const after = this.pieces(liveId);
    return { n, bytes: size, pieces: after.length, totalBytes: after.reduce((s, p) => s + p.bytes, 0) };
  }

  /** Joins the pieces (0..count-1, all present) into one file with `-c copy`; the pieces are removed once the joined file exists. */
  async join(liveId: string, count: number | null): Promise<{ bytes: number; container: 'mp4' | 'webm'; pieces: number }> {
    const meta = this.readMeta(liveId);
    const have = this.pieces(liveId);
    // asked again after a good join (the answer was lost): the joined file stands, nothing more to do
    if (meta !== null && meta.joined !== null && have.length === 0 && existsSync(join(this.dirOf(liveId), meta.joined.file))) {
      return { bytes: meta.joined.bytes, container: meta.container, pieces: 0 };
    }
    if (meta === null || have.length === 0) throw fail(409, 'no_pieces');
    if (this.joining.has(liveId) || this.uploading.has(liveId)) throw fail(409, 'busy');
    const wanted = count ?? have.length;
    if (!Number.isInteger(wanted) || wanted < 1 || have.length !== wanted || have.some((p, i) => p.n !== i)) throw fail(409, 'missing_piece');
    const ff = this.o.ffmpegPath();
    if (ff === null) throw fail(500, 'join_failed', 'no ffmpeg');
    const dir = this.dirOf(liveId);
    const sum = have.reduce((s, p) => s + p.bytes, 0);
    const f = (this.o.free ?? statfsFreeBytes)(dir);
    if (f !== null && f - sum < (this.o.minFreeBytes ?? VIDEO_LIMITS.minFreeBytes)) throw fail(413, 'no_space');

    this.joining.add(liveId);
    const list = join(dir, 'list.txt');
    const outName = `joined.${meta.container}`;
    const tmpOut = join(dir, `joined-tmp.${meta.container}`);
    try {
      writeFileSync(list, concatList(have.map((p) => basename(p.file))), { mode: 0o600 });
      rmSync(tmpOut, { force: true });
      const r = await (this.o.run ?? spawnJoin)(ff, joinArgs(list, tmpOut), RECORDING_LIMITS.joinTimeoutMs);
      const ok = r.code === 0 && existsSync(tmpOut) && statSync(tmpOut).size > 0;
      if (!ok) {
        // the detail (paths) goes to the log only
        this.o.log?.(`recording join failed for ${liveId}: code ${String(r.code)} ${r.stderr.trim().split(/\r?\n/).pop() ?? ''}`);
        throw fail(500, 'join_failed', 'join failed');
      }
      rmSync(join(dir, outName), { force: true });
      renameSync(tmpOut, join(dir, outName));
      const bytes = statSync(join(dir, outName)).size;
      meta.joined = { file: outName, bytes, at: this.now().toISOString() };
      meta.updatedAt = meta.joined.at;
      this.writeMeta(meta);
      // the pieces are no longer needed once the joined file stands
      for (const p of have) rmSync(p.file, { force: true });
      return { bytes, container: meta.container, pieces: have.length };
    } catch (error) {
      rmSync(tmpOut, { force: true });
      if (error instanceof RecordingError) throw error;
      throw fail(500, 'join_failed');
    } finally {
      rmSync(list, { force: true });
      this.joining.delete(liveId);
    }
  }

  /** The joined file to hand out, or null when there is none yet. */
  file(liveId: string): { path: string; bytes: number; container: 'mp4' | 'webm'; at: string } | null {
    const meta = this.readMeta(liveId);
    if (meta?.joined == null) return null;
    const path = join(this.dirOf(liveId), meta.joined.file);
    if (!existsSync(path)) return null;
    return { path, bytes: statSync(path).size, container: meta.container, at: meta.joined.at };
  }

  /** Forgets one live's pieces and joined file (the app saved it, or gave up). Safe to call twice. */
  remove(liveId: string): boolean {
    const dir = this.dirOf(liveId);
    if (!existsSync(dir) || this.joining.has(liveId) || this.uploading.has(liveId)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** Removes every recording nobody touched for 7 days; returns the live ids removed. */
  sweep(): string[] {
    const gone: string[] = [];
    if (!existsSync(this.root)) return gone;
    const limit = this.now().getTime() - (this.o.keepMs ?? RECORDING_LIMITS.keepMs);
    for (const id of readdirSync(this.root)) {
      if (!LIVE_ID.test(id)) continue;
      const meta = this.readMeta(id);
      let at = meta === null ? NaN : Date.parse(meta.updatedAt);
      if (!Number.isFinite(at)) {
        try {
          at = statSync(this.dirOf(id)).mtimeMs;
        } catch {
          continue;
        }
      }
      if (at < limit && this.remove(id)) gone.push(id);
    }
    return gone;
  }
}

export interface RecordingRouteDeps {
  db: DatabaseSync;
  recordings: Recordings;
}

const sendFail = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof RecordingError) return reply.code(error.status).header('Cache-Control', 'no-store').send({ errors: [error.message], code: error.code });
  throw error;
};

/** Box only. Every route has a row in ROUTE_PERMISSIONS (live:control); the owner rule is checked here. */
export function registerRecordingRoutes(app: FastifyInstance, deps: RecordingRouteDeps): void {
  const { db, recordings } = deps;

  void app.register(async (scope) => {
    // the raw stream is the body (never buffered); the handler enforces its own limits
    for (const t of Object.keys(CONTAINER_OF)) scope.addContentTypeParser(t, (_request, payload, done) => done(null, payload));

    /** The live must have existed on this box, and the caller must be the device that ran it or an administrator (settings:write, as for stopping a live). */
    const authorise = (request: FastifyRequest, liveId: string): string | null => {
      if (!LIVE_ID.test(liveId)) throw fail(404, 'unknown_live');
      const owner = Recordings.ownerOf(db, liveId);
      if (owner === undefined) throw fail(404, 'unknown_live');
      const a = request.auth;
      const device = a !== null && a !== undefined && a.kind === 'user' ? a.deviceId : null;
      const mine = device !== null && owner.deviceId !== null && owner.deviceId === device;
      if (!mine && !identityCan(request.auth, 'settings:write')) throw fail(403, 'not_owner');
      return owner.deviceId;
    };

    scope.post('/api/live/recordings/:liveId/pieces/:n', async (request, reply) => {
      const { liveId, n } = request.params as { liveId: string; n: string };
      const restore = exemptFromRequestTimeout(request.raw.socket);
      try {
        const owner = authorise(request, liveId);
        if (!/^\d{1,4}$/.test(n)) throw fail(400, 'bad_piece');
        const len = request.headers['content-length'];
        const declared = typeof len === 'string' && /^\d{1,12}$/.test(len) ? Number(len) : null;
        const mime = String(request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        const body = request.body as NodeJS.ReadableStream & { pipe?: unknown };
        if (typeof body?.pipe !== 'function') throw fail(400, 'bad_piece', 'body must be the raw piece');
        const out = await recordings.putPiece(liveId, owner, Number(n), mime, declared, body);
        return reply.header('Cache-Control', 'no-store').send(out);
      } catch (error) {
        return sendFail(reply, error);
      } finally {
        restore();
        try {
          recordings.sweep();
        } catch {
          // the hourly sweep tries again; a clean-up problem never turns a good upload into an error
        }
      }
    });

    scope.post('/api/live/recordings/:liveId/join', async (request, reply) => {
      const { liveId } = request.params as { liveId: string };
      try {
        authorise(request, liveId);
        const b = request.body;
        const c = typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as { count?: unknown }).count : undefined;
        if (c !== undefined && (typeof c !== 'number' || !Number.isInteger(c))) throw fail(400, 'bad_piece', 'count must be a whole number');
        const out = await recordings.join(liveId, typeof c === 'number' ? c : null);
        return reply.header('Cache-Control', 'no-store').send(out);
      } catch (error) {
        return sendFail(reply, error);
      }
    });

    scope.get('/api/live/recordings/:liveId/file', async (request, reply) => {
      const { liveId } = request.params as { liveId: string };
      try {
        authorise(request, liveId);
        const f = recordings.file(liveId);
        if (f === null) throw fail(404, 'not_ready');
        const day = f.at.slice(0, 10);
        return reply
          .header('Cache-Control', 'no-store')
          .header('Content-Type', MIME_OF[f.container])
          .header('Content-Length', String(f.bytes))
          .header('Content-Disposition', `attachment; filename="MAXCOM-${day}-${liveId}.${f.container}"`)
          .send(createReadStream(f.path));
      } catch (error) {
        return sendFail(reply, error);
      }
    });

    scope.delete('/api/live/recordings/:liveId', async (request, reply) => {
      const { liveId } = request.params as { liveId: string };
      try {
        authorise(request, liveId);
        return reply.header('Cache-Control', 'no-store').send({ removed: recordings.remove(liveId) });
      } catch (error) {
        return sendFail(reply, error);
      }
    });
  });
}
