import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { MediamtxPermission } from './mediamtx.ts';

/** One still frame of the picture the box already has (MediaMTX path `surau`), as a JPEG, for the live notice. */

export const FRAME_TTL_MS = 30_000;
/** A failed grab is remembered briefly, so a stream with no picture does not start an ffmpeg per request. */
export const FRAME_FAIL_TTL_MS = 5_000;
export const FRAME_TIMEOUT_MS = 5_000;
const MAX_JPEG_BYTES = 2 * 1024 * 1024;

export interface FrameApi {
  authUserAdd(u: { user: string; pass: string; permissions: MediamtxPermission[]; ips?: string[] }): Promise<void>;
  authUserRemove(user: string): Promise<void>;
}

export interface FrameGrabberOptions {
  /** The ffmpeg binary; null when the live tools are missing. */
  ffmpegPath: () => string | null;
  /** The MediaMTX control API; null when MediaMTX is not running. */
  api: () => FrameApi | null;
  /** The picture is ready on the path (nothing is spawned for a path with no picture). */
  ready: () => boolean;
  /** The live session the frame belongs to (the cache never crosses sessions). */
  sessionId: () => string | null;
  path?: string;
  rtspPort?: number;
  argsPrefix?: string[];
  now?: () => number;
  timeoutMs?: number;
  /** Test hook. */
  spawnFn?: (cmd: string, args: string[], o: SpawnOptions) => ChildProcess;
}

function childEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'SSL_CERT_FILE'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export class FrameGrabber {
  private readonly o: FrameGrabberOptions;
  private cache: { sessionId: string; at: number; jpeg: Buffer | null } | null = null;
  private inflight: { sessionId: string; promise: Promise<Buffer | null> } | null = null;
  /** Read users whose removal failed (S5); removed again at the session end. Names only, never a password. */
  private readonly stale = new Set<string>();

  constructor(o: FrameGrabberOptions) {
    this.o = o;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** A frame can be tried: tools present, MediaMTX up, picture ready and the last try did not just fail. */
  available(): boolean {
    const sid = this.o.sessionId();
    if (sid === null || !this.o.ready() || this.o.ffmpegPath() === null || this.o.api() === null) return false;
    const c = this.cache;
    return !(c !== null && c.sessionId === sid && c.jpeg === null && this.now() - c.at < FRAME_FAIL_TTL_MS);
  }

  /** The JPEG, from the cache (30 s) or from one ffmpeg run at a time; null when there is no frame. Never throws. */
  async get(): Promise<Buffer | null> {
    const sid = this.o.sessionId();
    if (sid === null) {
      this.cache = null;
      return null;
    }
    const c = this.cache;
    if (c !== null && c.sessionId === sid) {
      const age = this.now() - c.at;
      if (age >= 0 && age < (c.jpeg !== null ? FRAME_TTL_MS : FRAME_FAIL_TTL_MS)) return c.jpeg;
    }
    if (this.inflight !== null && this.inflight.sessionId === sid) return this.inflight.promise;
    if (!this.o.ready() || this.o.ffmpegPath() === null || this.o.api() === null) return null;
    const promise = this.grab()
      .catch(() => null)
      .then((jpeg) => {
        this.cache = { sessionId: sid, at: this.now(), jpeg };
        if (this.inflight?.promise === promise) this.inflight = null;
        return jpeg;
      });
    this.inflight = { sessionId: sid, promise };
    return promise;
  }

  private async grab(): Promise<Buffer | null> {
    const ffmpeg = this.o.ffmpegPath();
    const api = this.o.api();
    if (ffmpeg === null || api === null) return null;
    // a short-lived read user, loopback only; its address never leaves this function
    const user = `frm${randomBytes(6).toString('hex')}`;
    const pass = randomBytes(16).toString('hex');
    const path = this.o.path ?? 'surau';
    try {
      await api.authUserAdd({ user, pass, permissions: [{ action: 'read', path }], ips: ['127.0.0.1', '::1'] });
    } catch {
      this.stale.add(user);
      return null;
    }
    try {
      const rtsp = `rtsp://${user}:${pass}@127.0.0.1:${this.o.rtspPort ?? 8554}/${path}`;
      const args = [
        ...(this.o.argsPrefix ?? []),
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-rtsp_transport', 'tcp', '-i', rtsp,
        // The Android box ships a slim ffmpeg built with --disable-swscale: no scale filter and no pixel-format
        // conversion. `-strict -1` lets mjpeg encode the decoder's yuv420p as is, so no scaler is auto-inserted.
        // If a build still lacks the video filter graph the grab fails, the route answers 404 and the app falls
        // back to the YouTube thumbnail.
        '-frames:v', '1', '-an', '-map_metadata', '-1',
        '-c:v', 'mjpeg', '-strict', '-1', '-q:v', '5',
        '-f', 'image2', 'pipe:1',
      ];
      return await this.run(ffmpeg, args);
    } finally {
      await api.authUserRemove(user).catch(() => {
        this.stale.add(user);
      });
    }
  }

  /** At the session end: removes the frame users a failed removal left behind; one log line with the count. Never throws. */
  async sweepStale(): Promise<number> {
    const api = this.o.api();
    if (api === null || this.stale.size === 0) return 0;
    let removed = 0;
    for (const user of [...this.stale]) {
      try {
        await api.authUserRemove(user);
        this.stale.delete(user);
        removed += 1;
      } catch {
        /* still unreachable: tried again at the next session end */
      }
    }
    console.warn(`live: removed ${removed} leftover frame user(s), ${this.stale.size} still pending`);
    return removed;
  }

  private run(ffmpeg: string, args: string[]): Promise<Buffer | null> {
    return new Promise((resolve) => {
      let proc: ChildProcess;
      try {
        proc = (this.o.spawnFn ?? spawn)(ffmpeg, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: childEnv() });
      } catch {
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (jpeg: Buffer | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(jpeg);
      };
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        finish(null);
      }, this.o.timeoutMs ?? FRAME_TIMEOUT_MS);
      proc.stdout?.on('data', (d: Buffer) => {
        size += d.length;
        if (size > MAX_JPEG_BYTES) {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          finish(null);
          return;
        }
        chunks.push(d);
      });
      proc.on('error', () => finish(null));
      proc.on('close', (code) => {
        const buf = Buffer.concat(chunks);
        const ok = code === 0 && buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
        finish(ok ? buf : null);
      });
    });
  }
}
