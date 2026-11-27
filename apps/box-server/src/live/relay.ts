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

/** B6: the two steps of the quality ladder. */
export type RelayQuality = 'full' | 'low';

/** B6: the H.264 encoders the low step can use; the first that works on the box is probed by lowEncoder.ts. */
export type LowEncoder = 'h264_qsv' | 'h264_mf' | 'libx264';
const LOW_ENCODERS: ReadonlySet<string> = new Set(['h264_qsv', 'h264_mf', 'libx264']);

/** LiveStatus['relay'] plus the ffmpeg progress numbers (the extra fields are optional for readers). */
export interface RelayStatus {
  state: LiveStatus['relay']['state'];
  restarts: number;
  lastError: string | null;
  bitrateKbps: number | null;
  speed: number | null;
  dropFrames: number | null;
  /** B6: seconds the output is behind real time in the current run (null before two progress samples and after a restart). */
  behindSeconds: number | null;
  /** B6: `low` while the 480p ladder step is in use (a `low` request without an encoder stays `full`). */
  quality: RelayQuality;
  /** The planned quality restarts among `restarts` (not failures; the app's reconnect count leaves them out). */
  plannedRestarts: number;
  /** The last ffmpeg stderr lines of the current or latest run (redacted), so a failure is diagnosable from the status. */
  stderrTail: string[];
}

/** `youtube`: the RTMPS push (needs a key). `kioskAudio`: video copy plus Opus republished to a second loopback path. */
export type RelayKind = 'youtube' | 'kioskAudio';

/** B7: the picture lift of a re-encoding relay: none, the two fixed levels, or the mild night gamma of `auto`. */
export type RelayBrightness = 'normal' | 'bright' | 'brighter' | 'night';

/** The ffmpeg `eq` filter of each level; `normal` adds no filter at all. Gamma above 1 lifts the shadows (night pictures). */
export const BRIGHTNESS_FILTER: Record<RelayBrightness, string | null> = {
  normal: null,
  night: 'eq=gamma=1.15',
  bright: 'eq=gamma=1.2:brightness=0.04',
  brighter: 'eq=gamma=1.4:brightness=0.08',
};

export interface RelayStartOptions {
  /** The YouTube stream key; unused (and may be empty) for the kiosk audio leg. */
  key: string;
  relayVideo: RelayVideo;
  maxBitrateKbps: number;
  /** B7: only read when `relayVideo` is `reencode` (a copy relay never changes the picture). */
  brightness?: RelayBrightness;
  /**
   * The sound of a YouTube relay: `aac` (default) encodes AAC 128k 48 kHz stereo; `copy` passes the input's sound
   * through untouched (the input path already carries AAC, e.g. the combined live's `surau-yt`). The picture
   * branch does not depend on it.
   */
  audio?: 'aac' | 'copy';
  /** B6: `low` re-encodes to 480p at 1000 kbps with `lowEncoder`; without an encoder it behaves as `full`. */
  quality?: RelayQuality;
  lowEncoder?: LowEncoder;
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
  /**
   * PEM bundle of trusted roots for rtmps (ffmpeg `-ca_file`). Default: env SSL_CERT_FILE when that file exists.
   * ffmpeg built with mbedTLS verifies the server certificate (default on) but loads no system store and does not
   * read SSL_CERT_FILE itself (libavformat/tls_mbedtls.c: the CA chain is only filled from `ca_file`), so without
   * it every rtmps handshake fails with "I/O error". `null` passes none (Windows builds use the OS store).
   */
  caFile?: string | null;
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
  /** Each stderr line (already redacted) is also handed here, for the live log. Never throws into the relay. */
  log?: (text: string) => void;
  now?: () => number;
  /**
   * Y3: a run whose output has not grown for this long (ffmpeg's `total_size` progress value stands still) is ended
   * as `stalled` and started again (default 45 s). ffmpeg keeps printing progress while a socket is dead, so the
   * state alone never shows a stall.
   */
  stallMs?: number;
}

/** Y3: ffmpeg's own socket timeouts in microseconds: RTSP read (`-timeout`) and the RTMPS output (`-rw_timeout`). */
const IO_TIMEOUT_US = '15000000';
const STALL_MS = 45_000;
/** O9: the `-progress` keys that count work done; any one of them growing shows the run is alive (`total_size` can be N/A). */
const PROGRESS_COUNTERS: ReadonlySet<string> = new Set(['total_size', 'out_time_us', 'out_time_ms', 'frame']);
/** S8: `stop()` never waits longer than this past the kill for a process that does not report its end. */
const STOP_GRACE_MS = 5000;

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

/** How far back the smallest lag of a run is looked for (B12), and the spacing of the kept samples. */
const LAG_WINDOW_MS = 600_000;
const LAG_SAMPLE_MS = 1000;

/**
 * B12: the lag of a run (wall seconds minus output seconds since its first sample) measured against the smallest lag of
 * the last 10 minutes. A clock difference between the source and the box, or an early hiccup, then reads 0 once the
 * window has moved past it, while a real backlog that builds up reads as itself. At most one sample per second is kept.
 */
export class LagWindow {
  private readonly windowMs: number;
  private samples: Array<{ t: number; lag: number }> = [];

  constructor(windowMs: number = LAG_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  add(t: number, lag: number): void {
    const last = this.samples[this.samples.length - 1];
    if (last !== undefined && t - last.t < LAG_SAMPLE_MS) return;
    this.samples.push({ t, lag });
    this.drop(t);
  }

  /** max(0, lag now minus the smallest lag in the window, the current one included). */
  behind(t: number, lag: number): number {
    this.drop(t);
    let min = lag;
    for (const s of this.samples) if (s.lag < min) min = s.lag;
    return Math.max(0, lag - min);
  }

  size(): number {
    return this.samples.length;
  }

  reset(): void {
    this.samples = [];
  }

  private drop(t: number): void {
    let n = 0;
    while (n < this.samples.length && t - this.samples[n]!.t > this.windowMs) n++;
    if (n > 0) this.samples = this.samples.slice(n);
  }
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
  private quality: RelayQuality = 'full';
  /** B6: the first and the latest `out_time_us` sample of the current run, with the clock at the first one. */
  private tFirst: number | null = null;
  private outFirstUs = 0;
  private outLastUs = 0;
  private outSamples = 0;
  /** B12: the run's lag samples of the last 10 minutes. */
  private readonly lags = new LagWindow();
  /** B6: set by setQuality while a run is alive: its end is planned, not a failure. */
  private plannedEnd = false;
  private plannedRestarts = 0;
  private startOpts: RelayStartOptions | null = null;
  private stderrTail: string[] = [];
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
    return {
      state: this.state,
      restarts: this.restarts,
      lastError: this.lastError,
      bitrateKbps: this.bitrateKbps,
      speed: this.speed,
      dropFrames: this.dropFrames,
      behindSeconds: this.behind(),
      quality: this.effectiveQuality(),
      plannedRestarts: this.plannedRestarts,
      stderrTail: [...this.stderrTail],
    };
  }

  /** The run's lag at `t`: wall seconds since the first sample minus output seconds since the first sample. */
  private lagAt(t: number): number {
    return (t - (this.tFirst ?? t)) / 1000 - (this.outLastUs - this.outFirstUs) / 1e6;
  }

  /** B12: the lag now minus the smallest lag of the last 10 minutes of this run; null before two samples. */
  private behind(): number | null {
    if (this.tFirst === null || this.outSamples < 2) return null;
    const t = this.now();
    return this.lags.behind(t, this.lagAt(t));
  }

  private resetBehind(): void {
    this.tFirst = null;
    this.outFirstUs = 0;
    this.outLastUs = 0;
    this.outSamples = 0;
    this.lags.reset();
  }

  private effectiveQuality(): RelayQuality {
    const o = this.startOpts;
    return this.quality === 'low' && o !== null && o.lowEncoder !== undefined && LOW_ENCODERS.has(o.lowEncoder) ? 'low' : 'full';
  }

  /**
   * B6: changes the quality step. No-op when unchanged or not started. A live run is ended and the next one starts
   * at once with the new arguments: it counts in `restarts` but is not a failure and has no back-off.
   */
  setQuality(q: RelayQuality): void {
    if (!this.started || this.stopped || this.kind !== 'youtube' || q === this.quality) return;
    this.quality = q;
    const c = this.child;
    if (c !== null && c.exitCode === null && c.signalCode === null) {
      this.plannedEnd = true;
      this.line(`quality ${q}: restarting`);
      this.killChild();
    }
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
    this.startOpts = opts;
    this.quality = opts.quality === 'low' ? 'low' : 'full';
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
    // S8: a process that never reports its end must not hold up the clean-up chain (every later start waits for it)
    let grace: NodeJS.Timeout | null = null;
    const bound = new Promise<void>((resolve) => {
      grace = setTimeout(resolve, (this.o.killAfterMs ?? 3000) + STOP_GRACE_MS);
      grace.unref();
    });
    await Promise.race([this.loopDone, bound]);
    if (grace !== null) clearTimeout(grace);
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
    // Y3: `-timeout` is the RTSP socket read timeout (ffmpeg 5 and later, the versions the box installs): a dead input ends the run
    const base = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-progress', 'pipe:1', '-rtsp_transport', 'tcp', '-timeout', IO_TIMEOUT_US, '-i', rtsp];
    if (this.kind === 'kioskAudio') {
      // The picture is copied untouched; only the sound is made WebRTC-friendly (Opus, 48 kHz).
      // The phone's AAC timestamps can jump back: regenerate missing PTS on the input and resample
      // the sound against its timestamps (gaps and overlaps fixed) before libopus sees it.
      const out = `rtsp://${this.user}:${this.pass}@127.0.0.1:${this.o.rtspPort ?? 8554}/${KIOSK_AUDIO_PATH}`;
      const head = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-progress', 'pipe:1', '-fflags', '+genpts', '-rtsp_transport', 'tcp', '-timeout', IO_TIMEOUT_US, '-i', rtsp];
      return [...head, '-c:v', 'copy', '-af', 'aresample=async=1:first_pts=0', '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2', '-f', 'rtsp', '-rtsp_transport', 'tcp', out];
    }
    const kbps = Math.round(opts.maxBitrateKbps);
    const lift = opts.relayVideo === 'reencode' ? BRIGHTNESS_FILTER[opts.brightness ?? 'normal'] : null;
    const lowEnc = this.quality === 'low' && opts.lowEncoder !== undefined && LOW_ENCODERS.has(opts.lowEncoder) ? opts.lowEncoder : null;
    const video =
      lowEnc !== null
        ? [
            '-vf',
            opts.relayVideo === 'reencode' && lift !== null ? `${lift},scale=-2:480` : 'scale=-2:480',
            '-c:v',
            lowEnc,
            '-b:v',
            '1000k',
            '-maxrate',
            '1000k',
            '-bufsize',
            '2000k',
            '-g',
            '50',
            '-pix_fmt',
            lowEnc === 'h264_qsv' ? 'nv12' : 'yuv420p',
            ...(lowEnc === 'libx264' ? ['-preset', 'veryfast', '-tune', 'zerolatency'] : []),
          ]
        : opts.relayVideo === 'reencode'
        ? // a keyframe every 2 s whatever the frame rate (-g 60 is 2.4 s at 25 fps), none on scene cuts, CBR signalled (YouTube's encoder guidance)
          [...(lift === null ? [] : ['-vf', lift]), '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-force_key_frames', 'expr:gte(t,n_forced*2)', '-sc_threshold', '0', '-x264-params', 'nal-hrd=cbr', '-b:v', `${kbps}k`, '-minrate', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-pix_fmt', 'yuv420p']
        : ['-c:v', 'copy'];
    const audio = opts.audio === 'copy' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'];
    const url = `${this.o.ingestUrl ?? YOUTUBE_INGEST}/${encodeURIComponent(opts.key)}`;
    const ca = url.startsWith('rtmps://') ? this.caFile() : null;
    // Y3: `-rw_timeout` bounds every read and write of the RTMP(S) connection, so a dead uplink ends the run instead of hanging it
    return [...base, ...video, ...audio, '-f', 'flv', '-rtmp_live', 'live', '-rw_timeout', IO_TIMEOUT_US, ...(ca === null ? [] : ['-ca_file', ca]), url];
  }

  /** The CA bundle for rtmps: the option, else SSL_CERT_FILE when it is a regular file (never on Windows); null when none. */
  private caFile(): string | null {
    if (this.o.caFile !== undefined) return this.o.caFile;
    // Windows builds use the OS store (schannel); an SSL_CERT_FILE there (Git sets one sometimes) must not change that.
    if (process.platform === 'win32') return null;
    const env = process.env.SSL_CERT_FILE;
    if (env === undefined || env === '') return null;
    try {
      return statSync(env).isFile() ? env : null;
    } catch {
      return null;
    }
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
        this.resetBehind();
      } catch {
        reason = 'mediamtx_unreachable';
      }
      if (this.stopped) break;
      if (this.plannedEnd) {
        // B6: a quality change ended this run on purpose: no failure mark, no back-off, the next run starts at once
        this.plannedEnd = false;
        this.restarts++;
        this.plannedRestarts++;
        this.state = 'retrying';
        continue;
      }
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
      let prevLine: string | null = null;
      let settled = false;
      let stalled = false;
      let watchdog: NodeJS.Timeout | null = null;
      const finish = (reason: string): void => {
        if (settled) return;
        settled = true;
        if (watchdog !== null) clearInterval(watchdog);
        this.child = null;
        resolve(stalled ? 'stalled' : (lastLine ?? reason));
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
      this.resetBehind();
      this.stderrTail = [];
      this.line(`spawned pid ${proc.pid ?? 0}`);
      if (this.stopped) this.killChild();
      // Y3: the output size ffmpeg reports must keep growing; when it stands still the run is ended and the loop starts a new one
      const stallMs = this.o.stallMs ?? STALL_MS;
      // O9: some ffmpeg builds report `total_size=N/A` for a live output, so the size alone is not the signal: the run
      // is armed by the first sight of ANY progress counter (size, output time, frame count, numeric or N/A) and every
      // counter that grows keeps it alive. A run whose counters all stand still (or stay N/A) is ended as stalled.
      const counters = new Map<string, number>();
      let armed = false;
      let lastGrowthAt = this.now();
      watchdog = setInterval(
        () => {
          if (!armed || this.stopped || this.now() - lastGrowthAt < stallMs) return;
          stalled = true;
          this.line(`stalled: the output has not grown for ${Math.round(stallMs / 1000)} s, ending this run`);
          this.killChild();
        },
        Math.max(50, Math.min(5000, Math.round(stallMs / 4))),
      );
      watchdog.unref();

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
        // B8: the live log gets the YouTube relay's repeated lines once per 10 s with a count (the kiosk leg is throttled above already)
        const forLive = this.kind === 'kioskAudio' ? shown : this.throttle(r.text);
        if (forLive !== null && this.o.log !== undefined) {
          try {
            this.o.log(forLive);
          } catch {
            /* the live log is a convenience */
          }
        }
        // a line that carried a secret is never offered as the reason
        if (!r.hit) {
          const t = r.text.slice(0, 200);
          // ffmpeg ends with a generic "Error opening output files: I/O error"; the line before it names the cause
          lastLine = prevLine !== null && /^Error opening output files?: I\/O error$/.test(t) ? `${prevLine} | ${t}`.slice(0, 400) : t;
          prevLine = t;
          this.stderrTail.push(t);
          if (this.stderrTail.length > 12) this.stderrTail.shift();
        }
      });
      lines(proc.stdout, (raw) => {
        const eq = raw.indexOf('=');
        if (eq < 0) return;
        const k = raw.slice(0, eq).trim();
        const v = raw.slice(eq + 1);
        if (PROGRESS_COUNTERS.has(k)) {
          if (!armed) {
            armed = true;
            lastGrowthAt = this.now();
          }
          const n = parseNumber(v);
          if (k === 'out_time_us' && n !== null) {
            if (this.tFirst === null) {
              this.tFirst = this.now();
              this.outFirstUs = n;
            }
            this.outLastUs = n;
            this.outSamples++;
            if (this.outSamples >= 2) {
              const t = this.now();
              this.lags.add(t, this.lagAt(t));
            }
          }
          const before = counters.get(k);
          if (n !== null && (before === undefined || n > before)) {
            counters.set(k, n);
            lastGrowthAt = this.now();
          }
          return;
        }
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
