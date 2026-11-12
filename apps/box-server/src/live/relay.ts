import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LiveStatus } from '@surau/core';
import type { MediamtxPath, MediamtxPermission } from './mediamtx.ts';

/* The box YouTube leg for a browser publisher (iPad): ffmpeg reads the picture from MediaMTX over loopback
   RTSP as a per-session read-only user and pushes it to YouTube over RTMPS. The stream key and that
   per-session password are on ffmpeg's command line (accepted limit, plan builder's call 14); every line
   that ffmpeg prints is redacted of both before it reaches the log or the status. */

export type RelayVideo = 'copy' | 'reencode';

/** LiveStatus['relay'] plus the ffmpeg progress numbers (the extra fields are optional for readers). */
export interface RelayStatus {
  state: LiveStatus['relay']['state'];
  restarts: number;
  lastError: string | null;
  bitrateKbps: number | null;
  speed: number | null;
  dropFrames: number | null;
}

/** `youtube`: the RTMPS push (needs a key). `kioskAudio`: video copy plus Opus republished to a second loopback path. */
export type RelayKind = 'youtube' | 'kioskAudio';

export interface RelayStartOptions {
  /** The YouTube stream key; unused (and may be empty) for the kiosk audio leg. */
  key: string;
  relayVideo: RelayVideo;
  maxBitrateKbps: number;
}

/** The slice of MediamtxApi the relay uses (a fake satisfies it too). */
export interface RelayApi {
  pathGet(name: string): Promise<Pick<MediamtxPath, 'ready'>>;
  authUserAdd(u: { user: string; pass: string; permissions: MediamtxPermission[]; ips?: string[] }): Promise<void>;
  authUserRemove(user: string): Promise<void>;
}

/** MediaMTX path the kiosk audio leg republishes to (the WHEP proxy serves it while the leg runs). */
export const KIOSK_AUDIO_PATH = 'surau-kiosk';

export interface RelayOptions {
  ffmpegPath: string;
  /** Arguments placed before ffmpeg's own (tests run a node script as the "ffmpeg"). */
  argsPrefix?: string[];
  api: RelayApi;
  dataDir: string;
  sessionId: string;
  /** MediaMTX path to read (default `surau`). */
  path?: string;
  /** What this relay does (default `youtube`). */
  kind?: RelayKind;
  /** Log file name under <dataDir>/live (default `relay.log`, `kiosk-audio.log` for the audio leg). */
  logName?: string;
  rtspPort?: number;
  ingestUrl?: string;
  /** How often the path is polled while waiting for the picture (default 1000). */
  pollMs?: number;
  /** How long one wait for the picture lasts before it starts over (default 60000). */
  readyTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Consecutive exits inside `windowMs` that make the relay give up (default 10). */
  maxFailures?: number;
  windowMs?: number;
  /** A run at least this long clears the failure streak (default 60000). */
  stableMs?: number;
  killAfterMs?: number;
  logMaxBytes?: number;
  now?: () => number;
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const KEY_RE = /^[A-Za-z0-9._-]{4,100}$/;
const YOUTUBE_INGEST = 'rtmps://a.rtmps.youtube.com:443/live2';

function randomAlnum(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALNUM[randomInt(ALNUM.length)];
  return out;
}

/** Replaces every secret (longest first) with `***`; `hit` says whether anything was replaced. */
export function createRedactor(secrets: string[]): (text: string) => { text: string; hit: boolean } {
  const list = [...new Set(secrets.filter((s) => s.length > 0))].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    let hit = false;
    for (const s of list) {
      if (out.includes(s)) {
        out = out.split(s).join('***');
        hit = true;
      }
    }
    return { text: out, hit };
  };
}

class RelayLog {
  private size: number;
  private readonly path: string;
  private readonly maxBytes: number;
  // no parameter properties: the box runs under Node's strip-only TypeScript mode
  constructor(path: string, maxBytes: number) {
    this.path = path;
    this.maxBytes = maxBytes;
    mkdirSync(join(path, '..'), { recursive: true });
    this.size = existsSync(path) ? statSync(path).size : 0;
  }
  write(text: string): void {
    const len = Buffer.byteLength(text);
    if (this.size > 0 && this.size + len > this.maxBytes) {
      try {
        renameSync(this.path, `${this.path}.1`);
      } catch {
        /* rotation is best effort */
      }
      this.size = 0;
    }
    try {
      appendFileSync(this.path, text, { mode: 0o600 });
      this.size += len;
    } catch {
      /* a full disk must not break live */
    }
  }
}

/** ffmpeg gets a bare environment: nothing of the box's own variables is passed on. */
function childEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'SSL_CERT_FILE'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

function parseNumber(value: string): number | null {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)/.exec(value);
  return m ? Number(m[1]) : null;
}

export class Relay {
  private readonly o: RelayOptions;
  private readonly pathName: string;
  private readonly user: string;
  private readonly kind: RelayKind;
  private readonly now: () => number;
  private readonly log: RelayLog;
  private state: RelayStatus['state'] = 'off';
  private restarts = 0;
  private lastError: string | null = null;
  private bitrateKbps: number | null = null;
  private speed: number | null = null;
  private dropFrames: number | null = null;
  private started = false;
  private stopped = false;
  private child: ChildProcess | null = null;
  private loopDone: Promise<void> = Promise.resolve();
  private wake: (() => void) | null = null;
  private pass = '';
  private redact: (text: string) => { text: string; hit: boolean } = createRedactor([]);

  constructor(o: RelayOptions) {
    this.o = o;
    this.pathName = o.path ?? 'surau';
    this.kind = o.kind ?? 'youtube';
    this.user = this.kind === 'kioskAudio' ? `kioskaudio-${o.sessionId}` : `relay-${o.sessionId}`;
    this.now = o.now ?? Date.now;
    this.log = new RelayLog(join(o.dataDir, 'live', o.logName ?? (this.kind === 'kioskAudio' ? 'kiosk-audio.log' : 'relay.log')), o.logMaxBytes ?? 2 * 1024 * 1024);
  }

  /** The relay's MediaMTX read password (empty before start and after stop); for log redaction only. */
  readPassword(): string {
    return this.pass;
  }

  status(): RelayStatus {
    return { state: this.state, restarts: this.restarts, lastError: this.lastError, bitrateKbps: this.bitrateKbps, speed: this.speed, dropFrames: this.dropFrames };
  }

  /** Begins relaying in the background. Never throws; problems show in status(). */
  start(opts: RelayStartOptions): void {
    if (this.started || this.stopped) return;
    this.started = true;
    if (this.kind === 'youtube' && !KEY_RE.test(opts.key)) {
      this.state = 'failed';
      this.lastError = 'bad_key';
      return;
    }
    this.pass = randomAlnum(32);
    this.redact = createRedactor([opts.key, encodeURIComponent(opts.key), this.pass]);
    this.state = 'starting';
    this.loopDone = this.loop(opts).catch(() => {
      if (!this.stopped) {
        this.state = 'failed';
        this.lastError ??= 'relay_error';
      }
    });
  }

  /** Ends ffmpeg, deletes the read user. Safe to call twice and before start(). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    this.killChild();
    await this.loopDone;
    if (this.started && this.pass !== '') {
      try {
        await this.o.api.authUserRemove(this.user);
      } catch {
        console.warn('live: could not remove the relay user (reason: mediamtx_unreachable)');
      }
    }
    this.pass = '';
    if (this.started) this.line('stopped');
    this.state = 'off';
  }

  /* ------------------------------------------------------------------ internals */

  private killChild(): void {
    const c = this.child;
    if (c === null || c.exitCode !== null || c.signalCode !== null) return;
    try {
      c.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    const t = setTimeout(() => {
      try {
        c.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, this.o.killAfterMs ?? 3000);
    t.unref();
    c.once('close', () => clearTimeout(t));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      const self = this;
      function done(): void {
        clearTimeout(t);
        if (self.wake === done) self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  /** Polls MediaMTX until the path has a picture; false when `readyTimeoutMs` passes or the relay is stopped. */
  private async waitReady(): Promise<boolean> {
    const poll = this.o.pollMs ?? 1000;
    const end = this.now() + (this.o.readyTimeoutMs ?? 60_000);
    while (!this.stopped) {
      try {
        if ((await this.o.api.pathGet(this.pathName)).ready) return true;
      } catch {
        /* MediaMTX restarting: keep waiting */
      }
      if (this.stopped || this.now() >= end) return false;
      await this.sleep(poll);
    }
    return false;
  }

  private permissions(): MediamtxPermission[] {
    return this.kind === 'kioskAudio'
      ? [
          { action: 'read', path: this.pathName },
          { action: 'publish', path: KIOSK_AUDIO_PATH },
        ]
      : [{ action: 'read', path: this.pathName }];
  }

  private args(opts: RelayStartOptions): string[] {
    const rtsp = `rtsp://${this.user}:${this.pass}@127.0.0.1:${this.o.rtspPort ?? 8554}/${this.pathName}`;
    const base = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-progress', 'pipe:1', '-rtsp_transport', 'tcp', '-i', rtsp];
    if (this.kind === 'kioskAudio') {
      // The picture is copied untouched; only the sound is made WebRTC-friendly (Opus, 48 kHz).
      // The phone's AAC timestamps can jump back: regenerate missing PTS on the input and resample
      // the sound against its timestamps (gaps and overlaps fixed) before libopus sees it.
      const out = `rtsp://${this.user}:${this.pass}@127.0.0.1:${this.o.rtspPort ?? 8554}/${KIOSK_AUDIO_PATH}`;
      const head = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-progress', 'pipe:1', '-fflags', '+genpts', '-rtsp_transport', 'tcp', '-i', rtsp];
      return [...head, '-c:v', 'copy', '-af', 'aresample=async=1:first_pts=0', '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2', '-f', 'rtsp', '-rtsp_transport', 'tcp', out];
    }
    const kbps = Math.round(opts.maxBitrateKbps);
    const video =
      opts.relayVideo === 'reencode'
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-g', '60', '-keyint_min', '60', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-pix_fmt', 'yuv420p']
        : ['-c:v', 'copy'];
    const audio = ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'];
    return [...base, ...video, ...audio, '-f', 'flv', '-rtmp_live', 'live', `${this.o.ingestUrl ?? YOUTUBE_INGEST}/${encodeURIComponent(opts.key)}`];
  }

  /** Message kind to its last logged time (kiosk audio leg only); see {@link throttle}. */
  private seen = new Map<string, number>();
  private suppressed = new Map<string, number>();

  /**
   * The kiosk audio leg's ffmpeg can print the same warning (`Non-monotonic DTS`, `libopus: Queue input is
   * backward in time`) for every packet. A message kind (digits and addresses folded away) is logged at most
   * once per 10 s; the next line that gets through says how many were left out. Returns null to drop a line.
   */
  private throttle(text: string): string | null {
    const kind = text.replace(/0x[0-9a-f]+/gi, '#').replace(/-?\d+(?:\.\d+)?/g, '#');
    const now = this.now();
    const last = this.seen.get(kind);
    if (last !== undefined && now - last < 10_000) {
      this.suppressed.set(kind, (this.suppressed.get(kind) ?? 0) + 1);
      return null;
    }
    if (this.seen.size >= 200) {
      this.seen.clear();
      this.suppressed.clear();
    }
    this.seen.set(kind, now);
    const n = this.suppressed.get(kind);
    this.suppressed.delete(kind);
    return n ? `${text} (${n} similar lines left out)` : text;
  }

  private line(text: string): void {
    this.log.write(`${new Date(this.now()).toISOString()} ${this.redact(text).text}\n`);
  }

  private async loop(opts: RelayStartOptions): Promise<void> {
    const base = this.o.backoffBaseMs ?? 2000;
    const max = this.o.backoffMaxMs ?? 30_000;
    const maxFailures = this.o.maxFailures ?? 10;
    const windowMs = this.o.windowMs ?? 300_000;
    const stableMs = this.o.stableMs ?? 60_000;
    let exits: number[] = [];
    while (!this.stopped) {
      if (!(await this.waitReady())) {
        if (!this.stopped) this.lastError = 'ingest_not_ready';
        continue;
      }
      if (this.stopped) break;
      let reason: string | null = null;
      let ranMs = 0;
      try {
        // the relay and the kiosk audio leg are ffmpeg on this box: loopback only
        await this.o.api.authUserAdd({ user: this.user, pass: this.pass, permissions: this.permissions(), ips: ['127.0.0.1', '::1'] });
        const t0 = this.now();
        reason = await this.runOnce(opts);
        ranMs = this.now() - t0;
      } catch {
        reason = 'mediamtx_unreachable';
      }
      if (this.stopped) break;
      this.lastError = reason;
      // an exit while the ingest picture is gone (the phone dropped, MediaMTX restarted) is the input's fault,
      // not ffmpeg's: it does not count toward giving up; the loop waits for the picture and starts again
      let ingestUp = true;
      try {
        ingestUp = (await this.o.api.pathGet(this.pathName)).ready;
      } catch {
        ingestUp = true;
      }
      if (this.stopped) break;
      if (!ingestUp) {
        this.restarts++;
        this.state = 'retrying';
        await this.sleep(base);
        continue;
      }
      const at = this.now();
      if (ranMs >= stableMs) exits = [];
      exits = [...exits.filter((t) => at - t <= windowMs), at];
      if (exits.length >= maxFailures) {
        this.state = 'failed';
        this.line(`gave up after ${exits.length} exits`);
        return;
      }
      this.restarts++;
      this.state = 'retrying';
      await this.sleep(Math.min(max, base * 2 ** (exits.length - 1)));
    }
  }

  /** One ffmpeg run; resolves with a reason (last non-secret stderr line, or the exit code). */
  private runOnce(opts: RelayStartOptions): Promise<string> {
    return new Promise((resolve) => {
      let lastLine: string | null = null;
      let settled = false;
      const finish = (reason: string): void => {
        if (settled) return;
        settled = true;
        this.child = null;
        resolve(lastLine ?? reason);
      };
      let proc: ChildProcess;
      try {
        proc = spawn(this.o.ffmpegPath, [...(this.o.argsPrefix ?? []), ...this.args(opts)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv() });
      } catch (e) {
        const msg = this.redact(e instanceof Error ? e.message : 'spawn failed').text.slice(0, 200);
        this.line(`spawn failed: ${msg}`);
        finish(msg);
        return;
      }
      this.child = proc;
      this.state = 'starting';
      this.bitrateKbps = null;
      this.speed = null;
      this.dropFrames = null;
      this.line(`spawned pid ${proc.pid ?? 0}`);
      if (this.stopped) this.killChild();

      const lines = (stream: NodeJS.ReadableStream | null, onLine: (text: string) => void): void => {
        if (stream === null) return;
        let buf = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          buf += chunk;
          if (buf.length > 65_536) buf = buf.slice(-65_536);
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            const l = buf.slice(0, i).replace(/\r$/, '');
            buf = buf.slice(i + 1);
            if (l !== '') onLine(l);
          }
        });
      };
      lines(proc.stderr, (raw) => {
        const r = this.redact(raw);
        // the kiosk audio leg repeats timestamp warnings per packet: throttle them (the YouTube relay logs every line)
        const shown = this.kind === 'kioskAudio' ? this.throttle(r.text) : r.text;
        if (shown !== null) this.log.write(`${new Date(this.now()).toISOString()} ffmpeg: ${shown}\n`);
        // a line that carried a secret is never offered as the reason
        if (!r.hit) lastLine = r.text.slice(0, 200);
      });
      lines(proc.stdout, (raw) => {
        const eq = raw.indexOf('=');
        if (eq < 0) return;
        const k = raw.slice(0, eq).trim();
        const v = raw.slice(eq + 1);
        if (k === 'bitrate') this.bitrateKbps = parseNumber(v);
        else if (k === 'speed') this.speed = parseNumber(v);
        else if (k === 'drop_frames') this.dropFrames = parseNumber(v);
        else return;
        if (this.state !== 'running' && !this.stopped) {
          this.state = 'running';
          this.lastError = null;
        }
      });
      proc.on('error', (e: NodeJS.ErrnoException) => {
        const msg = this.redact(`spawn ${e.code ?? 'error'}`).text;
        this.line(`process error: ${msg}`);
        lastLine = msg;
        finish(msg);
      });
      proc.on('close', (code, signal) => {
        this.line(`exited code ${code ?? 'null'} signal ${signal ?? 'none'}`);
        finish(`ffmpeg exited with code ${code ?? 'null'}`);
      });
    });
  }
}
