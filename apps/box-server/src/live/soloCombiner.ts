import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import { ADDED_AUDIO_IDS } from '@surau/core';
import type { AddedAudioId } from '@surau/core';
import { childEnv } from './childEnv.ts';
import { LEVELLER_MISSING_RE, LIFT, LIMITER, MIX_PATHS, URL_LOGIN_RE, deviceNameOk, factor, intIn, rtspUrl, stdinLine, zmqMessage, zmqRequest } from './mixer.ts';
import type { MixCommand, MixControl, MixPlatform, MixUnit, MixerOptions, MixerStartConfig, MixerStatus, VolumeTarget } from './mixer.ts';
import { createRedactor } from './relay.ts';
import type { MixerLike } from './sessions.ts';

/* The solo sound path of build 6 (design 2026-11-26-b6-sound-design 5.1 to 5.4; bench scenario `split`).
   ONE sound per live. When it is a microphone (the box input or the phone's microphone) nothing may hold it up:
   - the SOUND process has a single input (dshow on Windows, or `surau-mic` over loopback RTSP), levels it (LIFT unless the
     Android app levelled it already, the safety LIMITER), applies the user's volume (`volume@snd`, changed at run time over
     stdin or azmq, never a restart) and publishes it as Opus to `surau-snd` and, for YouTube, as AAC to `surau-snd-aac`.
     Its last output is the PCM monitor (mono s16le 16 kHz) on stdout;
   - the JOIN is a remux only (no decode, no filter): the sound path(s) with one fixed `-itsoffset`, the unit's picture
     copied, the unit input LAST (mixer.ts header, input order), `-copyts` (every input is an RTSP loopback input).
   A dshow input never waits for another input here: the mixer's amix took the microphone only as fast as the camera's
   sound arrived, and every loss on the Wi-Fi made it fall further behind for good (bench test 2).
   Only these filters are used, all in the Android box ffmpeg: aresample, asplit, compand, volume, aformat, alimiter (and
   azmq when the control is zmq, which is Windows only). Arguments are arrays of fixed words and validated values. */

export const SOUND_PATHS = { opus: 'surau-snd', aac: 'surau-snd-aac' } as const;
export const SOLO_MAX_DELAY_MS = 2000;
const SOURCE_RATE = 48000;
const MONITOR_CAP_BYTES = 1024 * 1024;
/** dshow lines that say a captured frame was thrown away (its real-time buffer was full). */
const DROP_RE = /frame dropped/i;
const DROP_WINDOW_MS = 30_000;
/** B3: a dshow sound run that ends this soon after its start may be a driver refusing `-audio_buffer_size`. */
const SHORT_RUN_MS = 5000;

export type SoundInput = { kind: 'dshow'; deviceName: string; device?: number } | { kind: 'rtsp'; path: 'surau-mic' };

export interface SoundArgsInput {
  input: SoundInput;
  /** User volume 0..100. */
  volume: number;
  /** The source was levelled already (the Android app's own microphone): the lift is skipped, the limiter stays. */
  levelled: boolean;
  /** The level control at all (false when the box ffmpeg lacks compand or alimiter). */
  leveller: boolean;
  control: MixControl;
  zmqPort?: number;
  platform: MixPlatform;
  rtspPort?: number;
  rtspUser?: string;
  rtspPass?: string;
  /** Publish the AAC rendition for YouTube as well. */
  aac: boolean;
  logLevel?: 'warning' | 'info';
  /** dshow only: pass `-audio_buffer_size 20` (default true; some capture drivers refuse it). */
  bufferSize?: boolean;
}

function head(control: MixControl, logLevel: 'warning' | 'info' | undefined): string[] {
  const args = ['-hide_banner', '-loglevel', logLevel === 'info' ? 'info' : 'warning', '-y'];
  // the debug flag is on: no progress lines to bury the real messages
  if (logLevel === 'info') args.push('-nostats');
  if (control === 'zmq') args.push('-nostdin');
  return args;
}

/** The ffmpeg arguments (without the program) of the sound process. Pure; throws RangeError on anything invalid. */
export function soundArgs(i: SoundArgsInput): string[] {
  if (i.platform !== 'windows' && i.platform !== 'android') throw new RangeError('solo: bad platform');
  if (i.control !== 'zmq' && i.control !== 'stdin') throw new RangeError('solo: bad control');
  if (i.control === 'zmq' && i.platform === 'android') throw new RangeError('solo: the Android ffmpeg has no azmq; use stdin');
  const zmqPort = i.control === 'zmq' ? intIn('zmqPort', i.zmqPort ?? Number.NaN, 1024, 65535) : 0;
  const volume = factor(i.volume);
  const args = head(i.control, i.logLevel);
  if (i.input.kind === 'dshow') {
    if (i.platform !== 'windows') throw new RangeError('solo: box audio input is not available on the Android box');
    if (typeof i.input.deviceName !== 'string' || !deviceNameOk(i.input.deviceName)) throw new RangeError('solo: bad capture device name');
    // 48 kHz: built-in Intel SST microphones deliver silence at 16 kHz; a 20 ms capture buffer keeps the queue short
    args.push('-f', 'dshow', '-sample_rate', String(SOURCE_RATE));
    if (i.bufferSize !== false) args.push('-audio_buffer_size', '20');
    if (i.input.device !== undefined) args.push('-audio_device_number', String(intIn('device', i.input.device, 0, 99)));
    args.push('-i', `audio=${i.input.deviceName}`);
  } else if (i.input.kind === 'rtsp' && i.input.path === MIX_PATHS.deviceMic) {
    args.push('-rtsp_transport', 'tcp', '-i', rtspUrl(i, MIX_PATHS.deviceMic));
  } else {
    throw new RangeError('solo: bad sound input');
  }
  const on = i.leveller;
  const lift = on && !i.levelled ? `${LIFT},` : '';
  const limiter = on ? `,${LIMITER}` : '';
  const zmq = i.control === 'zmq' ? `,azmq=bind_address=tcp\\\\://127.0.0.1\\\\:${zmqPort}` : '';
  const end = i.aac ? ',asplit=2[o][a]' : '[o]';
  const g = [
    // the monitor tap is the raw source (before the lift and the volume), as in the mixer
    '[0:a]aresample=async=1:first_pts=0,asplit=2[m][r]',
    `[r]${lift}volume@snd=volume=${volume},aformat=sample_rates=${SOURCE_RATE}:channel_layouts=stereo${limiter}${zmq}${end}`,
    '[m]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono[mon]',
  ];
  args.push('-filter_complex', g.join(';'));
  args.push('-map', '[o]', '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2', '-f', 'rtsp', '-rtsp_transport', 'tcp', rtspUrl(i, SOUND_PATHS.opus));
  if (i.aac) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-f', 'rtsp', '-rtsp_transport', 'tcp', rtspUrl(i, SOUND_PATHS.aac));
  args.push('-map', '[mon]', '-c:a', 'pcm_s16le', '-ar', '16000', '-f', 's16le', 'pipe:1');
  return args;
}

export interface JoinArgsInput {
  unit: MixUnit;
  /** The sound's delay against the picture, 0..2000 ms. */
  delayMs: number;
  /** A second output with the AAC sound for YouTube. */
  yt: boolean;
  outputPath?: string;
  ytOutputPath?: string;
  rtspPort?: number;
  rtspUser?: string;
  rtspPass?: string;
  logLevel?: 'warning' | 'info';
}

/** The ffmpeg arguments of the join (remux only). Pure; throws RangeError on anything invalid. */
export function joinArgs(i: JoinArgsInput): string[] {
  if (i.unit !== 'camera' && i.unit !== 'ingest') throw new RangeError('solo: bad unit');
  const offset = (intIn('delayMs', i.delayMs, 0, SOLO_MAX_DELAY_MS) / 1000).toFixed(3);
  const out = i.outputPath ?? 'surau';
  const ytOut = i.ytOutputPath ?? 'surau-yt';
  if (i.yt && ytOut === out) throw new RangeError('solo: the YouTube path must differ from the output path');
  const args = ['-copyts', '-hide_banner', '-loglevel', i.logLevel === 'info' ? 'info' : 'warning', '-y'];
  if (i.logLevel === 'info') args.push('-nostats');
  args.push('-nostdin');
  // the sound input(s) first, the picture (unit) input LAST
  args.push('-itsoffset', offset, '-rtsp_transport', 'tcp', '-i', rtspUrl(i, SOUND_PATHS.opus));
  if (i.yt) args.push('-itsoffset', offset, '-rtsp_transport', 'tcp', '-i', rtspUrl(i, SOUND_PATHS.aac));
  const unitIdx = i.yt ? 2 : 1;
  args.push('-rtsp_transport', 'tcp', '-i', rtspUrl(i, MIX_PATHS[i.unit]));
  args.push('-map', `${unitIdx}:v`, '-map', '0:a', '-c', 'copy', '-f', 'rtsp', '-rtsp_transport', 'tcp', rtspUrl(i, out));
  if (i.yt) args.push('-map', `${unitIdx}:v`, '-map', '1:a', '-c', 'copy', '-f', 'rtsp', '-rtsp_transport', 'tcp', rtspUrl(i, ytOut));
  return args;
}

/* ------------------------------------------------------------------ the supervised pair */

export interface SoloCombinerOptions extends MixerOptions {
  /** MediaMTX's API, to see when `surau-snd` is published (the join waits for it). */
  api: { pathGet(name: string): Promise<{ ready: boolean } | null> };
  /** How often the path is polled before the join starts (default 250), and how long at most (default 10000). */
  pathPollMs?: number;
  pathWaitMs?: number;
}

interface Slot {
  name: 'sound' | 'join';
  child: ChildProcess | null;
  state: 'off' | 'running' | 'retrying' | 'failed';
  launches: number;
  failures: number[];
  startedAt: number;
  tail: string[];
  timer: ReturnType<typeof setTimeout> | null;
  /** What the exit of the current child means: relaunch at once, or stay down. null = it was not asked to end. */
  planned: 'relaunch' | 'hold' | null;
}

const newSlot = (name: Slot['name']): Slot => ({ name, child: null, state: 'off', launches: 0, failures: [], startedAt: 0, tail: [], timer: null, planned: null });
const alive = (c: ChildProcess | null): c is ChildProcess => c !== null && c.exitCode === null && c.signalCode === null;

/**
 * The sound process and the join, each supervised with the Mixer's rules (back-off from 2 s up to 30 s, 10 failures in
 * 5 minutes = failed). The join runs only while the sound process runs and its path is published. A volume is a run-time
 * command to the sound process; a delay restarts the join only. Never throws out of `start`.
 */
export class SoloCombiner implements MixerLike {
  /** Monitor PCM (s16le, 16 kHz, TWO channels: 0 = silence for the unit, 1 = the source). Lives across restarts. */
  readonly monitor: Readable;
  private readonly sink = new PassThrough({ highWaterMark: MONITOR_CAP_BYTES });
  private readonly o: SoloCombinerOptions;
  private readonly control: MixControl;
  private readonly now: () => number;
  private readonly redact: (t: string) => { text: string; hit: boolean };
  private readonly snd = newSlot('sound');
  private readonly join = newSlot('join');
  private cfg: { unit: MixUnit; id: AddedAudioId; volume: number; delayMs: number; yt: boolean; ytOutputPath?: string } | null = null;
  private fatal: string | null = null;
  private stopped = false;
  private started = false;
  private lastError: string | null = null;
  private commandsSent = 0;
  private lastCommandError: string | null = null;
  private stalls = 0;
  private lastStall: { reason: string; atMs: number } | null = null;
  private levellerOn: boolean | null;
  private relaunchNoLeveller = false;
  /** B3: dshow sound runs in a row that ended within `SHORT_RUN_MS` of their start; from two on the capture buffer option is left out. */
  private shortDshowRuns = 0;
  private bufferSizeOn = true;
  private probing = false;
  private zmqNow: number | undefined;
  /** Bumped by every sound launch: an older wait for the path ends. */
  private soundRun = 0;
  private watch: ReturnType<typeof setInterval> | null = null;
  private lastDataAt = 0;
  private rest: Buffer = Buffer.alloc(0);
  private dropTimes: number[] = [];
  private seen = new Map<string, number>();
  private suppressed = new Map<string, number>();

  constructor(o: SoloCombinerOptions) {
    this.o = o;
    this.control = o.control ?? (o.platform === 'windows' ? 'zmq' : 'stdin');
    this.now = o.now ?? Date.now;
    this.redact = createRedactor([o.rtspPass ?? '']);
    this.monitor = this.sink;
    this.zmqNow = o.zmqPort;
    this.levellerOn = o.leveller ?? (o.levellerProbe === undefined ? true : null);
  }

  /** dshow "frame dropped" lines of the sound process in the last 30 s. */
  drops(): number {
    const at = this.now();
    this.dropTimes = this.dropTimes.filter((t) => at - t <= DROP_WINDOW_MS);
    return this.dropTimes.length;
  }

  status(): MixerStatus {
    let state: MixerStatus['state'];
    if (this.fatal !== null || this.snd.state === 'failed' || this.join.state === 'failed') state = 'failed';
    else if (this.stopped || !this.started) state = 'off';
    else if (this.snd.state === 'running' && this.join.state === 'running') state = 'running';
    else if (this.snd.state === 'retrying' || this.join.state === 'retrying') state = 'retrying';
    else state = 'starting';
    return {
      state,
      restarts: Math.max(0, this.snd.launches - 1) + Math.max(0, this.join.launches - 1),
      lastError: this.fatal ?? this.lastError,
      stderrTail: this.tails(),
      unit: this.cfg?.unit ?? 'camera',
      channels: this.cfg === null ? ['unit'] : ['unit', this.cfg.id],
      missing: [],
      commandsSent: this.commandsSent,
      lastCommandError: this.lastCommandError,
      stalls: this.stalls,
      lastStall: this.lastStall === null ? null : { ...this.lastStall },
    };
  }

  /** The join's lines then the sound process's, 12 at most (each keeps its share when the other has fewer), URL logins masked. */
  private tails(): string[] {
    const j = this.join.tail;
    const s = this.snd.tail;
    const js = Math.min(j.length, Math.max(6, 12 - s.length));
    const ss = Math.min(s.length, 12 - js);
    return [...j.slice(j.length - js), ...s.slice(s.length - ss)].map((l) => l.replace(URL_LOGIN_RE, '$1***@'));
  }

  start(cfg: MixerStartConfig): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const a = cfg.added.length === 1 ? cfg.added[0] : undefined;
    if (a === undefined || !ADDED_AUDIO_IDS.includes(a.id) || (cfg.unit !== 'camera' && cfg.unit !== 'ingest')) {
      this.fatal = 'solo_bad_config';
      return;
    }
    const delay = Number.isFinite(a.initialDelayMs) ? Math.min(SOLO_MAX_DELAY_MS, Math.max(0, Math.round(a.initialDelayMs))) : 0;
    this.cfg = { unit: cfg.unit, id: a.id, volume: a.volume, delayMs: delay, yt: cfg.ytOutputPath !== undefined, ...(cfg.ytOutputPath !== undefined ? { ytOutputPath: cfg.ytOutputPath } : {}) };
    if (this.levellerOn !== null || this.o.levellerProbe === undefined) {
      this.launchSound();
      return;
    }
    this.probing = true;
    void Promise.resolve()
      .then(() => (this.o.levellerProbe as () => Promise<boolean | null>)())
      .catch(() => null)
      .then((has) => {
        this.probing = false;
        if (this.stopped) return;
        if (has === false) {
          this.warn('solo: this ffmpeg has no compand/alimiter filter, the live runs without the level control');
          this.levellerOn = false;
        } else this.levellerOn = true;
        this.launchSound();
      });
  }

  /** The join delay of the source (0..2000 ms, clamped): restarts only the join. The same value does nothing. */
  async setDelay(id: AddedAudioId, ms: number): Promise<void> {
    const c = this.cfg;
    if (c === null || this.stopped || id !== c.id || !Number.isFinite(ms)) return;
    const v = Math.min(SOLO_MAX_DELAY_MS, Math.max(0, Math.round(ms)));
    if (v === c.delayMs) return;
    c.delayMs = v;
    if (alive(this.join.child)) this.endChild(this.join, 'relaunch');
  }

  /** The volume of the source as a run-time command to the sound process; `'unit'` has no sound here and is ignored. Never restarts. */
  async setVolume(id: VolumeTarget, pct: number): Promise<void> {
    const arg = factor(pct); // validated first: an invalid value throws
    const c = this.cfg;
    if (id === 'unit' || c === null || id !== c.id) return;
    c.volume = pct;
    await this.send({ target: 'volume@snd', command: 'volume', arg });
  }

  /**
   * The output is gone (the session's watchdog): the join is restarted, the sound process keeps running. Counted in
   * `stalls`. A join that is down with nothing pending (no child, no back-off timer) is launched while the sound runs.
   */
  kick(reason: string): void {
    if (this.cfg === null || this.stopped || this.probing) return;
    const c = this.join.child;
    if (alive(c) && this.join.planned !== null) return; // a relaunch is already under way
    this.noteStall(String(reason).replace(/[^\w .:=-]/g, '_').slice(0, 80) || 'kick');
    if (alive(c)) this.endChild(this.join, 'relaunch');
    else if (this.join.timer === null && alive(this.snd.child) && this.snd.planned === null) this.launchJoin();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearWatch();
    for (const slot of [this.join, this.snd]) {
      if (slot.timer !== null) clearTimeout(slot.timer);
      slot.timer = null;
    }
    // the join first (nothing reads the sound path then), then the sound process
    await this.endAndWait(this.join);
    await this.endAndWait(this.snd);
    this.snd.state = 'off';
    this.join.state = 'off';
  }

  /* ------------------------------------------------------------------ internals */

  private warn(message: string): void {
    try {
      (this.o.warn ?? ((m: string) => console.warn(m)))(message);
    } catch {
      /* a logger must not stop the live */
    }
  }

  private emit(kind: string, text: string): void {
    const log = this.o.log;
    if (log === undefined) return;
    try {
      log(kind, this.redact(text).text.replace(URL_LOGIN_RE, '$1***@'));
    } catch {
      /* a logger must not stop the live */
    }
  }

  private throttle(text: string): string | null {
    const kind = text.replace(/0x[0-9a-f]+/gi, '#').replace(/-?\d+(?:\.\d+)?/g, '#');
    const at = this.now();
    const last = this.seen.get(kind);
    if (last !== undefined && at - last < 10_000) {
      this.suppressed.set(kind, (this.suppressed.get(kind) ?? 0) + 1);
      return null;
    }
    if (this.seen.size >= 200) {
      this.seen.clear();
      this.suppressed.clear();
    }
    this.seen.set(kind, at);
    const n = this.suppressed.get(kind);
    this.suppressed.delete(kind);
    return n ? `${text} (${n} similar lines left out)` : text;
  }

  private debugOn(): boolean {
    const p = this.o.debugFlagPath;
    if (p === undefined || p === '') return false;
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  }

  private noteStall(reason: string): void {
    this.stalls++;
    const at = this.now();
    this.lastStall = { reason, atMs: at };
    const since = this.snd.startedAt > 0 ? Math.max(0, Math.round((at - this.snd.startedAt) / 1000)) : 0;
    this.emit('stall', [`reason=${reason}`, `seconds since the sound launch=${since}`, 'stderr tail:', ...this.tails().map((l) => `  ${l}`)].join('\n'));
  }

  private clearWatch(): void {
    if (this.watch !== null) clearInterval(this.watch);
    this.watch = null;
  }

  /** Asks the current child of a slot to end (SIGTERM, SIGKILL after `killAfterMs`); `then` says what its exit means. */
  private endChild(slot: Slot, then: 'relaunch' | 'hold'): void {
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.timer = null;
    const c = slot.child;
    if (!alive(c)) return;
    slot.planned = then;
    slot.state = then === 'relaunch' ? 'retrying' : 'off';
    try {
      c.kill('SIGTERM');
    } catch {
      /* gone */
    }
    const t = setTimeout(() => {
      try {
        c.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, this.o.killAfterMs ?? 3000);
    t.unref();
    c.once('close', () => clearTimeout(t));
  }

  private async endAndWait(slot: Slot): Promise<void> {
    const c = slot.child;
    if (!alive(c)) {
      slot.child = null;
      return;
    }
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        try {
          c.kill('SIGKILL');
        } catch {
          /* gone */
        }
      }, this.o.killAfterMs ?? 3000);
      kill.unref();
      c.once('close', () => {
        clearTimeout(kill);
        resolve();
      });
      try {
        c.kill('SIGTERM');
      } catch {
        clearTimeout(kill);
        resolve();
      }
    });
    slot.child = null;
  }

  /** An unplanned end: back off and relaunch, or give up after too many in a row. */
  private backoff(slot: Slot, relaunch: () => void): void {
    const at = this.now();
    if (slot.startedAt > 0 && at - slot.startedAt >= (this.o.stableMs ?? 60_000)) slot.failures = [];
    slot.failures = [...slot.failures.filter((t) => at - t <= 300_000), at];
    if (slot.failures.length >= (this.o.maxFailures ?? 10)) {
      slot.state = 'failed';
      return;
    }
    slot.state = 'retrying';
    const wait = Math.min(this.o.backoffMaxMs ?? 30_000, (this.o.backoffBaseMs ?? 2000) * 2 ** (slot.failures.length - 1));
    slot.timer = setTimeout(() => {
      slot.timer = null;
      relaunch();
    }, wait);
  }

  /** Spawns one child of a slot and follows its stderr and its end. Returns null when the spawn itself failed. */
  private spawnChild(slot: Slot, args: string[], onExit: (proc: ChildProcess, reason: string, spawnFailed: boolean) => void): ChildProcess | null {
    let proc: ChildProcess;
    try {
      proc = (this.o.spawnFn ?? spawn)(this.o.ffmpegPath, [...(this.o.argsPrefix ?? []), ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: childEnv() });
    } catch (e) {
      this.lastError = this.redact(e instanceof Error ? e.message : 'spawn failed').text.slice(0, 200);
      return null;
    }
    slot.child = proc;
    slot.planned = null;
    slot.launches++;
    slot.startedAt = this.now();
    slot.tail = [];
    slot.state = 'running';
    this.emit('launch', `${slot.name} run ${slot.launches}: ffmpeg ${args.join(' ')}`);
    proc.stdin?.on('error', () => {
      /* a closed pipe at exit; the exit handler reports */
    });
    let buf = '';
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 65_536) buf = buf.slice(-65_536);
      let n: number;
      while ((n = buf.search(/[\r\n]/)) >= 0) {
        const line = this.redact(buf.slice(0, n)).text.slice(0, 300);
        buf = buf.slice(n + 1);
        if (line === '') continue;
        slot.tail.push(line);
        if (slot.tail.length > 12) slot.tail.shift();
        const shown = this.throttle(line);
        if (shown !== null) this.emit('stderr', `${slot.name}: ${shown}`);
        if (slot === this.snd) this.soundLine(line);
      }
    });
    let settled = false;
    const finish = (reason: string, spawnFailed: boolean, code?: number | null, signal?: string | null): void => {
      if (settled) return;
      settled = true;
      if (slot.child === proc) slot.child = null;
      const ran = Math.max(0, Math.round((this.now() - slot.startedAt) / 1000));
      this.emit('exit', `${slot.name}: ${code === undefined ? reason : `code=${code ?? 'null'} signal=${signal ?? 'none'}`} after ${ran} s`);
      if (this.stopped) return;
      onExit(proc, reason, spawnFailed);
    };
    // an error of a child that started (a failed kill, a pipe) is not its end: the slot waits for `close`
    proc.on('error', (e: NodeJS.ErrnoException) => {
      if (proc.pid === undefined) finish(`spawn ${e.code ?? 'error'}`, true);
      else this.emit('error', `${slot.name}: ${e.code ?? 'error'}`);
    });
    proc.on('close', (code, signal) => finish(`ffmpeg exited with code ${code ?? 'null'}`, false, code, signal));
    return proc;
  }

  private soundLine(line: string): void {
    if (DROP_RE.test(line)) {
      const at = this.now();
      this.dropTimes = [...this.dropTimes.filter((t) => at - t <= DROP_WINDOW_MS), at];
    }
    if (this.levellerOn === true && LEVELLER_MISSING_RE.test(line)) {
      this.levellerOn = false;
      this.relaunchNoLeveller = true;
      this.warn('solo: ffmpeg has no compand/alimiter filter, relaunching the sound without the level control');
      try {
        this.o.onLevellerMissing?.();
      } catch {
        /* a callback must not stop the live */
      }
    }
  }

  private launchSound(): void {
    const c = this.cfg;
    if (this.stopped || c === null || this.probing || alive(this.snd.child)) return;
    let args: string[];
    try {
      if (this.o.zmqPortFn !== undefined) this.zmqNow = this.o.zmqPortFn();
      const input: SoundInput =
        c.id === 'boxInput'
          ? { kind: 'dshow', deviceName: this.o.deviceName ?? '', ...(this.o.device !== undefined ? { device: this.o.device } : {}) }
          : { kind: 'rtsp', path: 'surau-mic' };
      args = soundArgs({
        input,
        volume: c.volume,
        levelled: this.o.appLevelled === true && c.id === 'deviceMic',
        leveller: this.levellerOn !== false,
        control: this.control,
        ...(this.zmqNow !== undefined ? { zmqPort: this.zmqNow } : {}),
        platform: this.o.platform,
        ...(this.o.rtspPort !== undefined ? { rtspPort: this.o.rtspPort } : {}),
        ...(this.o.rtspUser !== undefined ? { rtspUser: this.o.rtspUser } : {}),
        ...(this.o.rtspPass !== undefined ? { rtspPass: this.o.rtspPass } : {}),
        aac: c.yt,
        logLevel: this.debugOn() ? 'info' : 'warning',
        bufferSize: this.bufferSizeOn,
      });
    } catch (e) {
      this.fatal = e instanceof Error ? e.message : 'solo_bad_config';
      return;
    }
    const run = ++this.soundRun;
    // a new run starts on a frame boundary: readers drop what is left of the old one
    this.rest = Buffer.alloc(0);
    this.sink.emit('restart');
    const proc = this.spawnChild(this.snd, args, (p, _reason, spawnFailed) => this.soundEnded(p, spawnFailed));
    if (proc === null) {
      this.soundEnded(null, true);
      return;
    }
    this.lastDataAt = this.snd.startedAt;
    proc.stdout?.on('data', (d: Buffer) => {
      if (this.snd.child !== proc) return;
      this.lastDataAt = this.now();
      this.toMonitor(d);
    });
    // the monitor watchdog: silence for stallMs after the start grace relaunches the sound process (a stuck capture prints nothing and never exits)
    this.clearWatch();
    const stallMs = this.o.stallMs ?? 20_000;
    const graceMs = this.o.startGraceMs ?? 25_000;
    this.watch = setInterval(
      () => {
        if (this.snd.child !== proc || this.stopped || this.snd.planned !== null) return;
        const at = this.now();
        if (at - this.snd.startedAt < graceMs || at - this.lastDataAt < stallMs) return;
        this.noteStall('monitor_silent');
        this.endChild(this.snd, 'relaunch');
      },
      Math.max(10, Math.min(2000, Math.round(Math.min(stallMs, graceMs) / 4))),
    );
    this.watch.unref();
    void this.joinWhenReady(run);
  }

  /** Mono s16le from the sound process to the two-channel monitor (channel 0 silence). An odd byte waits for the next chunk. */
  private toMonitor(d: Buffer): void {
    const buf = this.rest.length > 0 ? Buffer.concat([this.rest, d]) : d;
    const frames = buf.length >> 1;
    this.rest = Buffer.from(buf.subarray(frames * 2));
    if (frames === 0) return;
    const out = Buffer.alloc(frames * 4);
    for (let f = 0; f < frames; f++) {
      out[f * 4 + 2] = buf[f * 2] as number;
      out[f * 4 + 3] = buf[f * 2 + 1] as number;
    }
    if (this.sink.writableLength < MONITOR_CAP_BYTES) this.sink.write(out);
  }

  /** Polls MediaMTX until the sound path(s) are published (or the wait ends), then starts the join. */
  private async joinWhenReady(run: number): Promise<void> {
    const poll = this.o.pathPollMs ?? 250;
    const tries = Math.max(1, Math.ceil((this.o.pathWaitMs ?? 10_000) / poll));
    const paths: string[] = this.cfg?.yt === true ? [SOUND_PATHS.opus, SOUND_PATHS.aac] : [SOUND_PATHS.opus];
    for (let n = 0; n < tries; n++) {
      if (this.stopped || run !== this.soundRun || !alive(this.snd.child)) return;
      let ready = true;
      for (const p of paths) {
        try {
          if ((await this.o.api.pathGet(p))?.ready !== true) ready = false;
        } catch {
          ready = false;
        }
        if (!ready) break;
      }
      if (ready) break;
      await new Promise((r) => setTimeout(r, poll));
    }
    if (this.stopped || run !== this.soundRun || !alive(this.snd.child)) return;
    this.launchJoin();
  }

  private launchJoin(): void {
    const c = this.cfg;
    if (this.stopped || c === null || !alive(this.snd.child)) return;
    if (alive(this.join.child)) {
      // the old join is still shutting down (held when the sound went down): it comes back as soon as it has ended
      if (this.join.planned !== null) {
        this.join.planned = 'relaunch';
        this.join.state = 'retrying';
      }
      return;
    }
    if (this.join.timer !== null) clearTimeout(this.join.timer);
    this.join.timer = null;
    let args: string[];
    try {
      args = joinArgs({
        unit: c.unit,
        delayMs: c.delayMs,
        yt: c.yt,
        ...(this.o.outputPath !== undefined ? { outputPath: this.o.outputPath } : {}),
        ...(c.ytOutputPath !== undefined ? { ytOutputPath: c.ytOutputPath } : {}),
        ...(this.o.rtspPort !== undefined ? { rtspPort: this.o.rtspPort } : {}),
        ...(this.o.rtspUser !== undefined ? { rtspUser: this.o.rtspUser } : {}),
        ...(this.o.rtspPass !== undefined ? { rtspPass: this.o.rtspPass } : {}),
        logLevel: this.debugOn() ? 'info' : 'warning',
      });
    } catch (e) {
      this.fatal = e instanceof Error ? e.message : 'solo_bad_config';
      return;
    }
    const proc = this.spawnChild(this.join, args, (p) => this.joinEnded(p));
    if (proc === null) this.joinEnded(null);
  }

  private soundEnded(proc: ChildProcess | null, spawnFailed = false): void {
    void proc;
    this.clearWatch();
    this.noteShortRun(spawnFailed);
    // the join reads the sound path: it goes down with it and comes back once the path is published again
    this.endChild(this.join, 'hold');
    if (!alive(this.join.child) && this.join.state !== 'failed') this.join.state = 'off';
    const planned = this.snd.planned;
    this.snd.planned = null;
    if (this.relaunchNoLeveller) {
      this.relaunchNoLeveller = false;
      this.launchSound();
      return;
    }
    if (planned === 'relaunch') {
      this.launchSound();
      return;
    }
    if (planned === 'hold') {
      this.snd.state = 'off';
      return;
    }
    // an ffmpeg that never started is not the microphone's fault: `sound_spawn` (the session does not bench for it)
    if (spawnFailed) {
      this.lastError = this.lastError ?? 'sound_spawn';
      this.noteStall('sound_spawn');
      this.backoff(this.snd, () => this.launchSound());
      return;
    }
    // an unplanned end of the microphone (unplugged, a capture error): the session counts it like a silent monitor
    this.lastError = this.snd.tail[this.snd.tail.length - 1] ?? this.lastError ?? 'sound_exit';
    this.noteStall('sound_exit');
    this.backoff(this.snd, () => this.launchSound());
  }

  /** B3: two dshow sound runs in a row that ended within 5 s of their start: later launches leave `-audio_buffer_size` out. */
  private noteShortRun(spawnFailed: boolean): void {
    if (spawnFailed || this.cfg?.id !== 'boxInput' || !this.bufferSizeOn) return;
    if (this.snd.startedAt > 0 && this.now() - this.snd.startedAt < SHORT_RUN_MS) this.shortDshowRuns++;
    else this.shortDshowRuns = 0;
    if (this.shortDshowRuns >= 2) {
      this.bufferSizeOn = false;
      this.warn('solo: the capture device ended twice right after its start, relaunching without -audio_buffer_size');
    }
  }

  private joinEnded(proc: ChildProcess | null): void {
    void proc;
    const planned = this.join.planned;
    this.join.planned = null;
    if (planned === 'relaunch') {
      this.launchJoin();
      return;
    }
    if (planned === 'hold') {
      this.join.state = 'off';
      // the sound came back while this join was still shutting down: it follows the current sound run
      if (!this.stopped && alive(this.snd.child) && this.snd.planned === null) void this.joinWhenReady(this.soundRun);
      return;
    }
    this.lastError = this.join.tail[this.join.tail.length - 1] ?? this.lastError ?? 'join_exit';
    this.backoff(this.join, () => this.launchJoin());
  }

  /** Sends one run-time command to the sound process. Never throws; the outcome shows in status(). */
  private async send(cmd: MixCommand): Promise<void> {
    try {
      if (this.control === 'stdin') {
        const w = this.snd.child?.stdin;
        if (!w || w.destroyed || !w.writable) throw new Error('solo_not_running');
        w.write(stdinLine(cmd));
      } else {
        if (this.snd.child === null) throw new Error('solo_not_running');
        const port = intIn('zmqPort', this.zmqNow ?? Number.NaN, 1024, 65535);
        await (this.o.zmqSend ?? zmqRequest)(port, zmqMessage(cmd));
      }
      this.commandsSent++;
      this.lastCommandError = null;
    } catch (e) {
      this.lastCommandError = e instanceof Error ? e.message : 'command_failed';
    }
  }
}
