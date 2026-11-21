import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import { ADDED_AUDIO_IDS } from '@surau/core';
import type { AddedAudioId } from '@surau/core';
import { createRedactor } from './relay.ts';

/* The combiner of the box path (plan 2026-11-16-live-external-source rev 4, 3.2, 3.3, 4.6; T0 results 2026-11-17).
   One supervised ffmpeg: the unit (camera picture + its own sound, or a phone's / iPad's own picture and sound) is
   read from MediaMTX over loopback RTSP, its picture is COPIED with the timestamps it arrives with, its sound is
   always consumed (volume, never dropped), added sources are delayed (`adelay@<id>`) and scaled (`volume@<id>`),
   mixed, and published as Opus to `surau`. A second output is the PCM monitor on stdout for the aligner.

   Rules proven in T0 and kept here:
   - never `-use_wallclock_as_timestamps` (it lost ~90% of the video packets);
   - the unit's audio is always consumed: volume 0 for "mic only" (an unconsumed track made MediaMTX discard frames);
   - `-itsoffset <headroom>` on the unit input only, so added sources are always the earlier signal;
   - input ORDER (sync-repeat spike 2026-11-17): added sources first, the unit (camera/ingest) input LAST. The picture
     input must be opened last: opening it first while ffmpeg probes the next input overflowed MediaMTX's write queue
     (150-230 of ~740 video packets lost) and made the picture-to-sound gap random;
   - `-copyts` (global, first argument) when every added source is an RTSP loopback input: both inputs then keep the
     timestamps of the RTP-Info at PLAY, so the gap repeats from start to start. Not with the dshow box input (not RTP
     based; -copyts may misplace it), which keeps the old behaviour;
   - `arealtime` on the silent reference only when NO added source exists (the added input paces the graph; with
     arealtime the muxer queue stalls and video is lost); without any added source it stays, else it runs unthrottled;
   - `adelay` starts at a NON-ZERO delay (starting at 0 and growing produced broken output);
   - an added source stays out of the mix (volume 0) until aligned, when the reference is audible;
   - run-time commands are built from validated integers and fixed words only: stdin as `c` + `<target> -1 <cmd> <arg>\n`
     (no newline after `c`), or azmq on 127.0.0.1. */

export type MixPlatform = 'windows' | 'android';
export type MixUnit = 'camera' | 'ingest';
export type MixControl = 'zmq' | 'stdin';
/** A volume target: an added source or the unit's own sound. */
export type VolumeTarget = AddedAudioId | 'unit';

export interface MixAdded {
  id: AddedAudioId;
  /** Starting delay in ms (the manual offset when the unit has no audio). 0 is raised to 1 (T0: a start at 0 broke the output). */
  initialDelayMs: number;
  /** User volume 0..100. */
  volume: number;
  /**
   * Hold the source out of the mix (volume 0) until told. Default: true when the reference is audible
   * (unit has audio and unitVolume > 0), false otherwise (nothing can double).
   */
  held?: boolean;
}

export interface MixArgsInput {
  unit: MixUnit;
  unitHasAudio: boolean;
  added: MixAdded[];
  /** Unit volume 0..100 (0 = "mic only"; the audio is still consumed). */
  unitVolume: number;
  /** Fixed delay of the whole unit input (picture and sound), in ms. */
  headroomMs: number;
  control: MixControl;
  /** Required for `control: 'zmq'` (bound on 127.0.0.1 only). */
  zmqPort?: number;
  /** dshow `-audio_device_number` for the box capture input (Windows). */
  device?: number;
  /** dshow device name for the box capture input (Windows; required when boxInput is added). */
  deviceName?: string;
  platform: MixPlatform;
  /** MediaMTX RTSP port on loopback (default 8554). */
  rtspPort?: number;
  /** Per-session MediaMTX user for reading the unit/mic paths and publishing the mix. */
  rtspUser?: string;
  rtspPass?: string;
  /** Path the mix is published to (default `surau`). */
  outputPath?: string;
  /**
   * The level control (default true): the quiet-sound lift PER INPUT (before the mix) and the safety limiter on the final
   * mix. False when the box's ffmpeg lacks the filters, and for diagnosis.
   */
  leveller?: boolean;
  /**
   * The phone/tablet comes from the Android app, which levels its own microphone: its feed (the `ingest` unit and the
   * `deviceMic` source) is not lifted again. Everything else (web/iPad feed, box Mic-in, IP camera sound) is.
   */
  appLevelled?: boolean;
}

export const MIX_PATHS = { camera: 'surau-cam', ingest: 'surau-in', deviceMic: 'surau-mic' } as const;
export const MONITOR_RATE = 16000;
export const MAX_DELAY_MS = 10_000;
const DEFAULT_SOURCE_RATE = 48000;

/* The level control of the box path, split in two parts (design 2026-11-21: one job per stage, no stacking).
   LIFT: a quiet-sound lift on EACH INPUT before the mix (before its `volume`), only on inputs that are not levelled yet (the
   web/iPad feed, the box Mic-in, the IP camera sound). The Android app levels its own microphone, so its feed (the
   `ingest` unit and `deviceMic` while the session source is 'android') skips it (`appLevelled`). LIMITER: one safety
   `alimiter` on the final mix for everything (limit 0.89 = -1 dBFS, 5 ms attack, `level=0` = no makeup). The monitor tap is
   built from the raw sources before both.
   LIFT is a `compand` (attack 100 ms, decay 300 ms, soft-knee 2, no delay) whose curve leaves normal sound alone: unity at
   about -22 dBFS RMS and above, quiet speech (-34 .. -28) pulled to about -21 .. -20, room noise (white, -43 and below)
   raised by at most +3 dB. Measured on the input level (a mono source is 3 dB lower after the existing stereo `aformat`, which
   is outside this stage) with the real ffmpeg 8.1.2 and 9.0.2 (identical to 0.1 dB), `volumedetect` mean, input -> output:
   300 Hz sine of the given RMS through LIFT + LIMITER:
     -60 -> -56.3   -50 -> -46.7   -46 -> -42.6   -43 -> -39.2   -40 -> -35.1   -37 -> -28.7   -34 -> -21.5
     -31 -> -20.3   -28 -> -20.1   -25 -> -21.1   -22 -> -21.3   -21 -> -20.8   -18 -> -18.0   -15 -> -15.0   -9 -> -9.0
   white noise (anoisesrc): -60 -> -57.2   -50 -> -48.1   -46 -> -44.2   -43 -> -40.8   -40 -> -36.3   -37 -> -28.6
   the 36 s sample (mono AAC tablet live):
     speech 15-27 s mean  -31.1 -> -20.8 dBFS   (target -19 +-3)
     noise 28-36 s mean   -40.2 -> -38.0 dBFS   (+2.2)
     0-12 s mean (noise with a few -35 dBFS speech-like blips)  -38.5 -> -29.6 dBFS
     whole-file peak       -8.1 ->  -1.0 dBFS   (no clip)
   Known limits: a pure tone at -43 / -40 reads +3.9 / +5.0 (white noise passes the +3 / +5 limits); between the tone levels
   -40 and -34 the measured slope is about 2.3:1 (lifting speech out of room noise needs it); the curve points are not
   monotone (-28 -> -17.5, -21 -> -21.0) because compand's envelope ripple pulls the measured plateau down.
   The Android box ffmpeg must have `compand` and `alimiter` (scripts/android/ffmpeg-features.json); without either the
   mixer runs with no leveller at all (levellerProbe.ts, and a "No such filter" relaunch). */
export const LIFT =
  'compand=attacks=0.1:decays=0.3:points=-90/-90|-55/-55|-43/-53.91|-40/-44.06|-34/-18.98|-28/-17.48|-21/-20.98|-15/-14.91|-9/-8.91|0/0:soft-knee=2';
export const LIMITER = 'alimiter=limit=0.89:attack=5:release=50:level=0';
/** One input through LIFT then the final limiter (what a lifted input sees); used by tests and measurements. */
export const LEVELLER = `${LIFT},${LIMITER}`;

const USER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PASS_RE = /^[A-Za-z0-9]{8,128}$/;
// Same rule as audioInputs.ts isUsableDeviceName: real Windows names hold (R), accents and so on. The name goes
// through an argument array (never a shell); only what the dshow input string could misread is refused.
// eslint-disable-next-line no-control-regex
const DEVICE_NAME_BAD = /[\u0000-\u001f\u007f"=:�]/u;
function deviceNameOk(name: string): boolean {
  return name.length >= 1 && name.length <= 120 && !DEVICE_NAME_BAD.test(name);
}
const PATH_RE = /^[a-z][a-z0-9-]{0,31}$/;

function intIn(name: string, v: number, lo: number, hi: number): number {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`mixer: ${name} must be an integer ${lo}..${hi}`);
  return v;
}

/** 0..100 percent to the ffmpeg volume factor, two decimals (only digits and one dot can result). */
function factor(pct: number): string {
  return (intIn('volume', pct, 0, 100) / 100).toFixed(2);
}

function seconds(ms: number): string {
  return (intIn('headroomMs', ms, 0, MAX_DELAY_MS) / 1000).toFixed(3);
}

function rtspUrl(i: MixArgsInput, path: string): string {
  const port = intIn('rtspPort', i.rtspPort ?? 8554, 1, 65535);
  if (!PATH_RE.test(path)) throw new RangeError('mixer: bad path');
  let auth = '';
  if (i.rtspUser !== undefined || i.rtspPass !== undefined) {
    if (!USER_RE.test(i.rtspUser ?? '') || !PASS_RE.test(i.rtspPass ?? '')) throw new RangeError('mixer: bad rtsp login');
    auth = `${i.rtspUser}:${i.rtspPass}@`;
  }
  return `rtsp://${auth}127.0.0.1:${port}/${path}`;
}

/** The ffmpeg arguments (without the program) of one combiner run. Pure; throws RangeError on anything invalid. */
export function mixArgs(i: MixArgsInput): string[] {
  if (i.platform !== 'windows' && i.platform !== 'android') throw new RangeError('mixer: bad platform');
  if (i.unit !== 'camera' && i.unit !== 'ingest') throw new RangeError('mixer: bad unit');
  if (i.control !== 'zmq' && i.control !== 'stdin') throw new RangeError('mixer: bad control');
  if (i.control === 'zmq' && i.platform === 'android') throw new RangeError('mixer: the Android ffmpeg has no azmq; use stdin');
  const zmqPort = i.control === 'zmq' ? intIn('zmqPort', i.zmqPort ?? Number.NaN, 1024, 65535) : 0;
  const unitVolume = factor(i.unitVolume);
  const seen = new Set<AddedAudioId>();
  for (const a of i.added) {
    if (!ADDED_AUDIO_IDS.includes(a.id) || seen.has(a.id)) throw new RangeError('mixer: bad or repeated added source');
    seen.add(a.id);
    if (a.id === 'boxInput' && i.platform === 'android') throw new RangeError('mixer: box audio input is not available on the Android box');
  }
  const referenceAudible = i.unitHasAudio && i.unitVolume > 0;

  const allRtsp = i.added.length > 0 && i.added.every((a) => a.id === 'deviceMic');
  const args: string[] = allRtsp ? ['-copyts'] : [];
  args.push('-hide_banner', '-loglevel', 'warning', '-y');
  if (i.control === 'zmq') args.push('-nostdin');

  // Added sources first (inputs 0..n-1), the unit LAST (input n): see the header, input order.
  let next = 0;
  const inputOf = new Map<AddedAudioId, number>();
  for (const a of i.added) {
    if (a.id === 'deviceMic') {
      args.push('-rtsp_transport', 'tcp', '-i', rtspUrl(i, MIX_PATHS.deviceMic));
    } else if (i.platform === 'windows') {
      if (i.deviceName === undefined || !deviceNameOk(i.deviceName)) throw new RangeError('mixer: bad capture device name');
      // 48 kHz: built-in Intel SST microphones deliver silence at 16 kHz
      args.push('-f', 'dshow', '-sample_rate', String(DEFAULT_SOURCE_RATE));
      if (i.device !== undefined) args.push('-audio_device_number', String(intIn('device', i.device, 0, 99)));
      args.push('-i', `audio=${i.deviceName}`);
    }
    inputOf.set(a.id, next++);
  }
  // The unit input: its own timestamps; the headroom delays picture and sound together.
  const unitIdx = next;
  args.push('-itsoffset', seconds(i.headroomMs), '-rtsp_transport', 'tcp', '-i', rtspUrl(i, MIX_PATHS[i.unit]));

  const norm = `aformat=sample_rates=${DEFAULT_SOURCE_RATE}:channel_layouts=stereo`;
  const tap = `aresample=${MONITOR_RATE},aformat=sample_fmts=s16:channel_layouts=mono`;
  const g: string[] = [];
  const on = i.leveller !== false;
  // the safety limiter sits on the final mix (everything); the quiet-sound lift sits on each input that is not levelled yet
  const level = on ? `,${LIMITER}` : '';
  const lift = (levelled: boolean): string => (on && !levelled ? `${LIFT},` : '');
  // a unit without an audio track: the silent reference is a SOURCE FILTER inside the graph (the Android ffmpeg has no
  // avdevice, so no `-f lavfi` input); it keeps channel 0 of the monitor and the graph shape
  const paced = i.added.length === 0 ? ',arealtime' : '';
  g.push(i.unitHasAudio ? `[${unitIdx}:a]asplit=2[m0][r0]` : `anullsrc=r=${DEFAULT_SOURCE_RATE}:cl=stereo${paced},asplit=2[m0][r0]`);
  g.push(`[r0]${lift(i.appLevelled === true && i.unit === 'ingest')}volume@unit=volume=${unitVolume},${norm}[c0]`);
  g.push(`[m0]${tap}[t0]`);
  const mixIn = ['[c0]'];
  const taps = ['[t0]'];
  i.added.forEach((a, n) => {
    const idx = inputOf.get(a.id) as number;
    const held = a.held ?? referenceAudible;
    const delay = intIn(`${a.id} delay`, a.initialDelayMs, 0, MAX_DELAY_MS);
    g.push(`[${idx}:a]adelay@${a.id}=delays=${Math.max(1, delay)}:all=1,asplit=2[m${n + 1}][r${n + 1}]`);
    const vol = factor(a.volume); // validated even while held out
    g.push(`[r${n + 1}]${lift(i.appLevelled === true && a.id === 'deviceMic')}volume@${a.id}=volume=${held ? '0.00' : vol},${norm}[c${n + 1}]`);
    g.push(`[m${n + 1}]${tap}[t${n + 1}]`);
    mixIn.push(`[c${n + 1}]`);
    taps.push(`[t${n + 1}]`);
  });
  const zmq = i.control === 'zmq' ? `,azmq=bind_address=tcp\\\\://127.0.0.1\\\\:${zmqPort}` : '';
  g.push(mixIn.length > 1 ? `${mixIn.join('')}amix=inputs=${mixIn.length}:normalize=0,aresample=async=1${zmq}${level}[mix]` : `[c0]aresample=async=1${zmq}${level}[mix]`);
  g.push(taps.length > 1 ? `${taps.join('')}amerge=inputs=${taps.length},aformat=sample_fmts=s16[mon]` : '[t0]aformat=sample_fmts=s16[mon]');

  args.push('-filter_complex', g.join(';'));
  // Output 1: the copied picture + the mix as Opus, to MediaMTX.
  const out = i.outputPath ?? 'surau';
  args.push('-map', `${unitIdx}:v`, '-map', '[mix]', '-c:v', 'copy', '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2', '-f', 'rtsp', '-rtsp_transport', 'tcp', rtspUrl(i, out));
  // Output 2: the PCM monitor (s16le, 16 kHz, channel 0 = reference, channel n = added source n after its delay).
  args.push('-map', '[mon]', '-c:a', 'pcm_s16le', '-ar', String(MONITOR_RATE), '-f', 's16le', 'pipe:1');
  return args;
}

/** The channel order of the monitor for a given set of added sources: 'unit' (the reference) then each added source. */
export function monitorChannels(added: ReadonlyArray<{ id: AddedAudioId }>): VolumeTarget[] {
  return ['unit', ...added.map((a) => a.id)];
}

/**
 * Splits interleaved s16le into one Int16Array per channel. Bytes of an incomplete frame are returned in `rest`
 * (prepend them to the next chunk).
 */
export function demuxMonitor(buf: Buffer, channels: number): { channels: Int16Array[]; rest: Buffer } {
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) throw new RangeError('mixer: bad channel count');
  const frameBytes = channels * 2;
  const frames = Math.floor(buf.length / frameBytes);
  const out = Array.from({ length: channels }, () => new Int16Array(frames));
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) (out[c] as Int16Array)[f] = buf.readInt16LE(f * frameBytes + c * 2); // out has `channels` entries, c < channels
  return { channels: out, rest: buf.subarray(frames * frameBytes) };
}

/* ------------------------------------------------------------------ run-time commands */

const COMMAND_WORDS = { delay: 'delays', volume: 'volume' } as const;

export interface MixCommand {
  /** Filter instance, e.g. `adelay@deviceMic`. */
  target: string;
  /** Fixed word: `delays` or `volume`. */
  command: string;
  /** Digits (and one dot for a volume factor) only. */
  arg: string;
}

export function delayCommand(id: AddedAudioId, ms: number): MixCommand {
  if (!ADDED_AUDIO_IDS.includes(id)) throw new RangeError('mixer: bad source');
  return { target: `adelay@${id}`, command: COMMAND_WORDS.delay, arg: String(Math.max(1, intIn('delay', ms, 0, MAX_DELAY_MS))) };
}

export function volumeCommand(id: VolumeTarget, pct: number): MixCommand {
  if (id !== 'unit' && !ADDED_AUDIO_IDS.includes(id)) throw new RangeError('mixer: bad source');
  return { target: `volume@${id}`, command: COMMAND_WORDS.volume, arg: factor(pct) };
}

/** stdin form: `c` immediately followed by `<target> -1 <command> <arg>\n` (no newline after `c`; T0 proven on Windows). */
export function stdinLine(c: MixCommand): string {
  return `c${c.target} -1 ${c.command} ${c.arg}\n`;
}

/** azmq form: `<target> <command> <arg>`. */
export function zmqMessage(c: MixCommand): string {
  return `${c.target} ${c.command} ${c.arg}`;
}

/**
 * One azmq request over loopback (ZMTP 3.0, NULL mechanism, REQ socket). Resolves with the reply text; rejects on
 * a transport error, a timeout, or a reply whose status is not 0. Only 127.0.0.1 is ever dialled.
 */
export function zmqRequest(port: number, message: string, timeoutMs = 2000): Promise<string> {
  intIn('zmqPort', port, 1024, 65535);
  return new Promise((resolve, reject) => {
    const sock = connect({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    let stage: 'greeting' | 'ready' | 'reply' = 'greeting';
    let done = false;
    const end = (err: Error | null, text = ''): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(text);
    };
    const timer = setTimeout(() => end(new Error('zmq_timeout')), timeoutMs);
    const frame = (flags: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([flags, body.length]), body]);
    const greeting = Buffer.alloc(64);
    greeting[0] = 0xff;
    greeting[9] = 0x7f;
    greeting[10] = 3;
    greeting.write('NULL', 12, 'latin1');
    sock.write(greeting);
    const ready = Buffer.concat([Buffer.from([5]), Buffer.from('READY'), Buffer.from([11]), Buffer.from('Socket-Type'), Buffer.from([0, 0, 0, 3]), Buffer.from('REQ')]);
    const frames: Array<{ flags: number; body: Buffer }> = [];
    const parse = (): void => {
      for (;;) {
        if (stage === 'greeting') {
          if (buf.length < 64) return;
          if (buf[0] !== 0xff || (buf[10] ?? 0) < 3) return end(new Error('zmq_bad_greeting'));
          buf = buf.subarray(64);
          sock.write(frame(0x04, ready));
          stage = 'ready';
          continue;
        }
        if (buf.length < 2) return;
        const flags = buf[0] ?? 0; // buf.length >= 2 checked above
        const long = (flags & 0x02) !== 0;
        if (long) return end(new Error('zmq_frame_too_long'));
        const size = buf[1] ?? 0;
        if (buf.length < 2 + size) return;
        const f = { flags, body: Buffer.from(buf.subarray(2, 2 + size)) };
        buf = buf.subarray(2 + size);
        if (stage === 'ready') {
          if ((f.flags & 0x04) === 0 || f.body.subarray(1, 6).toString('latin1') !== 'READY') return end(new Error('zmq_bad_ready'));
          // REQ envelope: an empty delimiter frame (more), then the body
          sock.write(Buffer.concat([frame(0x01, Buffer.alloc(0)), frame(0x00, Buffer.from(message, 'utf8'))]));
          stage = 'reply';
          continue;
        }
        frames.push(f);
        if ((f.flags & 0x01) === 0) {
          const text = f.body.toString('utf8'); // f was just pushed: it is the last frame
          const code = /^\s*(-?\d+)/.exec(text);
          return end(code !== null && Number(code[1]) !== 0 ? new Error(`zmq_reply_${code[1]}`) : null, text);
        }
      }
    };
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      parse();
    });
    sock.on('error', () => end(new Error('zmq_unreachable')));
    sock.on('close', () => end(new Error('zmq_closed')));
  });
}

/* ------------------------------------------------------------------ the supervised combiner */

export interface MixerStatus {
  state: 'off' | 'starting' | 'running' | 'retrying' | 'failed';
  restarts: number;
  lastError: string | null;
  stderrTail: string[];
  unit: MixUnit;
  /** Monitor channel order for the current run. */
  channels: VolumeTarget[];
  /** Added sources that are currently lost (not in the graph). */
  missing: AddedAudioId[];
  commandsSent: number;
  lastCommandError: string | null;
}

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

export interface MixerOptions {
  ffmpegPath: string;
  /** Arguments placed before ffmpeg's own (tests run a node script as the "ffmpeg"). */
  argsPrefix?: string[];
  platform: MixPlatform;
  /** Default: azmq on Windows, stdin on Android. */
  control?: MixControl;
  zmqPort?: number;
  /** Picks the azmq port of every launch (a port that is taken then fails one run, not every retry). Wins over `zmqPort`. */
  zmqPortFn?: () => number;
  headroomMs: number;
  rtspPort?: number;
  rtspUser?: string;
  rtspPass?: string;
  outputPath?: string;
  deviceName?: string;
  device?: number;
  /**
   * The leveller (compand + alimiter) on the mix. `true`/`false` force it; left out, the mixer asks `levellerProbe` once
   * before its first start (no probe: on). A box whose ffmpeg lacks either filter runs without it, never without the live.
   */
  leveller?: boolean;
  /** true: both filters exist; false: one is missing; null/throws: could not tell (then the leveller is tried and the "No such filter" fallback guards it). */
  levellerProbe?: () => Promise<boolean | null>;
  /** Called once when a run proved the leveller filters missing ("No such filter"), so the owner can remember it for later Mixers. Must not throw. */
  onLevellerMissing?: () => void;
  /** The phone/tablet is the Android app (session source 'android'): its feed is levelled by the app, not lifted here. */
  appLevelled?: boolean;
  /** One-line warnings (default: console.warn). */
  warn?: (message: string) => void;
  /** Injectable for tests. */
  spawnFn?: SpawnFn;
  zmqSend?: (port: number, message: string) => Promise<unknown>;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Consecutive failed runs before giving up (default 10). */
  maxFailures?: number;
  /** A run at least this long clears the failure streak (default 60000). */
  stableMs?: number;
  killAfterMs?: number;
  now?: () => number;
}

export interface MixerStartConfig {
  unit: MixUnit;
  unitHasAudio: boolean;
  unitVolume: number;
  added: MixAdded[];
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP']) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/** ffmpeg's words for a filter this build does not have (only the two of the leveller count). */
const LEVELLER_MISSING_RE = /(?:no such filter|unknown filter)\W+(?:compand|alimiter)(?![a-z])/i;

const MONITOR_CAP_BYTES = 1024 * 1024;

export class Mixer {
  /** Monitor PCM (s16le, 16 kHz). Lives across restarts; chunks are dropped, never queued, when nobody reads it. */
  readonly monitor: Readable;
  private readonly sink = new PassThrough({ highWaterMark: MONITOR_CAP_BYTES });
  private readonly o: MixerOptions;
  private readonly control: MixControl;
  private readonly now: () => number;
  private readonly redact: (t: string) => { text: string; hit: boolean };
  private cfg: MixerStartConfig | null = null;
  private lost = new Set<AddedAudioId>();
  private child: ChildProcess | null = null;
  private state: MixerStatus['state'] = 'off';
  private restarts = 0;
  private lastError: string | null = null;
  private stderrTail: string[] = [];
  private commandsSent = 0;
  private lastCommandError: string | null = null;
  private stopped = false;
  private planned = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures: number[] = [];
  private startedAt = 0;
  private channelsNow: VolumeTarget[] = ['unit'];
  private zmqNow: number | undefined;
  /** Leveller in the graph now: null until the probe answered. */
  private levellerOn: boolean | null;
  /** A run died on a missing leveller filter: relaunch at once without it (once). */
  private relaunchNoLeveller = false;
  /** The leveller probe is pending: no launch from any other path until it settles (the one launch after it uses the latest cfg). */
  private probing = false;

  constructor(o: MixerOptions) {
    this.o = o;
    this.control = o.control ?? (o.platform === 'windows' ? 'zmq' : 'stdin');
    this.now = o.now ?? Date.now;
    this.redact = createRedactor([o.rtspPass ?? '']);
    this.monitor = this.sink;
    this.zmqNow = o.zmqPort;
    this.levellerOn = o.leveller ?? (o.levellerProbe === undefined ? true : null);
  }

  private warn(message: string): void {
    try {
      (this.o.warn ?? ((m: string) => console.warn(m)))(message);
    } catch {
      /* a logger must not stop the live */
    }
  }

  status(): MixerStatus {
    return {
      state: this.state,
      restarts: this.restarts,
      lastError: this.lastError,
      stderrTail: [...this.stderrTail],
      unit: this.cfg?.unit ?? 'camera',
      channels: [...this.channelsNow],
      missing: [...this.lost],
      commandsSent: this.commandsSent,
      lastCommandError: this.lastCommandError,
    };
  }

  /** Begins mixing in the background. Never throws; a bad configuration shows as state `failed`. */
  start(cfg: MixerStartConfig): void {
    if (this.cfg !== null || this.stopped) return;
    this.cfg = { ...cfg, added: cfg.added.map((a) => ({ ...a })) };
    this.state = 'starting';
    if (this.levellerOn !== null || this.o.levellerProbe === undefined) {
      this.launch();
      return;
    }
    // ask the box's ffmpeg once for compand + alimiter before the first run
    this.probing = true;
    void Promise.resolve()
      .then(() => (this.o.levellerProbe as () => Promise<boolean | null>)())
      .catch(() => null)
      .then((has) => {
        this.probing = false;
        if (this.stopped) return;
        if (has === false) {
          this.warn('mixer: this ffmpeg has no compand/alimiter filter, the live runs without the level control');
          this.levellerOn = false;
        } else this.levellerOn = true;
        this.launch();
      });
  }

  /** Delay of an added source, in ms (T0: a runtime adelay change; values below 1 become 1). */
  async setDelay(id: AddedAudioId, ms: number): Promise<void> {
    const cmd = delayCommand(id, ms);
    const a = this.cfg?.added.find((x) => x.id === id);
    if (a !== undefined) a.initialDelayMs = Number(cmd.arg);
    await this.send(cmd);
  }

  /** Volume 0..100 of an added source or of the unit's own sound (`'unit'`). The graph value, so it also serves hold-out and release. */
  async setVolume(id: VolumeTarget, pct: number): Promise<void> {
    const cmd = volumeCommand(id, pct);
    if (this.cfg !== null) {
      if (id === 'unit') this.cfg.unitVolume = pct;
      else {
        const a = this.cfg.added.find((x) => x.id === id);
        if (a !== undefined) {
          a.volume = pct;
          a.held = false;
        }
      }
    }
    await this.send(cmd);
  }

  /**
   * A source went away (`ok` false) or came back (true). The combiner restarts without a lost input (a stalled input
   * must never stall the picture) and with it again on return, held out of the mix until the next lock.
   */
  setSourceAvailable(id: AddedAudioId, ok: boolean): void {
    if (this.cfg === null || this.stopped || !ADDED_AUDIO_IDS.includes(id)) return;
    if (ok) {
      if (!this.lost.delete(id)) return;
    } else {
      if (this.lost.has(id)) return;
      this.lost.add(id);
    }
    if (ok) {
      const a = this.cfg.added.find((x) => x.id === id);
      if (a !== undefined) delete a.held; // default rule: held until aligned when the reference is audible
    }
    this.restartNow();
  }

  /** Makes the other picture source the unit (camera pull to a phone's or iPad's own stream); a break of a few seconds. */
  switchUnit(unit: MixUnit, unitHasAudio?: boolean): void {
    if (this.cfg === null || this.stopped) return;
    if (this.cfg.unit === unit && (unitHasAudio === undefined || unitHasAudio === this.cfg.unitHasAudio)) return;
    this.cfg.unit = unit;
    if (unitHasAudio !== undefined) this.cfg.unitHasAudio = unitHasAudio;
    for (const a of this.cfg.added) delete a.held; // new unit, new lock
    this.restartNow();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const c = this.child;
    if (c !== null && c.exitCode === null && c.signalCode === null) {
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
    }
    this.child = null;
    this.state = 'off';
  }

  /* ------------------------------------------------------------------ internals */

  /** The arguments for the current configuration (lost sources left out). */
  buildArgs(): string[] {
    const cfg = this.cfg as MixerStartConfig;
    const added = cfg.added.filter((a) => !this.lost.has(a.id));
    this.channelsNow = monitorChannels(added);
    return mixArgs({
      unit: cfg.unit,
      unitHasAudio: cfg.unitHasAudio,
      unitVolume: cfg.unitVolume,
      added,
      headroomMs: this.o.headroomMs,
      control: this.control,
      zmqPort: this.zmqNow,
      device: this.o.device,
      deviceName: this.o.deviceName,
      platform: this.o.platform,
      rtspPort: this.o.rtspPort,
      rtspUser: this.o.rtspUser,
      rtspPass: this.o.rtspPass,
      outputPath: this.o.outputPath,
      leveller: this.levellerOn !== false,
      appLevelled: this.o.appLevelled === true,
    });
  }

  private restartNow(): void {
    if (this.probing) return; // the launch after the probe reads the latest cfg/lost state
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const c = this.child;
    if (c === null || c.exitCode !== null || c.signalCode !== null) {
      this.launch();
      return;
    }
    this.planned = true;
    this.state = 'retrying';
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

  private launch(): void {
    if (this.stopped || this.cfg === null || this.probing) return;
    let args: string[];
    try {
      if (this.o.zmqPortFn !== undefined) this.zmqNow = this.o.zmqPortFn();
      args = this.buildArgs();
    } catch (e) {
      this.state = 'failed';
      this.lastError = e instanceof Error ? e.message : 'mixer_bad_config';
      return;
    }
    let proc: ChildProcess;
    try {
      proc = (this.o.spawnFn ?? spawn)(this.o.ffmpegPath, [...(this.o.argsPrefix ?? []), ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: childEnv() });
    } catch (e) {
      this.lastError = this.redact(e instanceof Error ? e.message : 'spawn failed').text.slice(0, 200);
      this.afterExit();
      return;
    }
    this.child = proc;
    this.planned = false;
    // a new run starts on a frame boundary: readers drop what is left of the old one
    this.sink.emit('restart');
    this.startedAt = this.now();
    this.stderrTail = [];
    this.state = 'running';
    proc.stdin?.on('error', () => {
      /* a closed pipe at exit; the exit handler reports */
    });
    proc.stdout?.on('data', (d: Buffer) => {
      if (this.sink.writableLength < MONITOR_CAP_BYTES) this.sink.write(d);
    });
    let buf = '';
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 65_536) buf = buf.slice(-65_536);
      let n: number;
      while ((n = buf.indexOf('\n')) >= 0) {
        const line = this.redact(buf.slice(0, n).replace(/\r$/, '')).text.slice(0, 300);
        buf = buf.slice(n + 1);
        if (line === '') continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 12) this.stderrTail.shift();
        if (this.levellerOn === true && LEVELLER_MISSING_RE.test(line)) {
          this.levellerOn = false;
          this.relaunchNoLeveller = true;
          this.warn('mixer: ffmpeg has no compand/alimiter filter, relaunching the live without the level control');
          try {
            this.o.onLevellerMissing?.();
          } catch {
            /* a callback must not stop the live */
          }
        }
      }
    });
    let settled = false;
    const finish = (reason: string): void => {
      if (settled) return;
      settled = true;
      if (this.child === proc) this.child = null;
      if (this.stopped) return;
      if (this.relaunchNoLeveller) {
        this.relaunchNoLeveller = false;
        this.restarts++;
        this.launch();
        return;
      }
      if (this.planned) {
        this.restarts++;
        this.launch();
        return;
      }
      this.lastError = this.stderrTail[this.stderrTail.length - 1] ?? reason;
      this.afterExit();
    };
    proc.on('error', (e: NodeJS.ErrnoException) => {
      this.lastError = `spawn ${e.code ?? 'error'}`;
      finish(this.lastError);
    });
    proc.on('close', (code) => finish(`ffmpeg exited with code ${code ?? 'null'}`));
  }

  /** An unplanned end of a run: back off and start again, or give up after too many in a row. */
  private afterExit(): void {
    const at = this.now();
    if (this.startedAt > 0 && at - this.startedAt >= (this.o.stableMs ?? 60_000)) this.failures = [];
    this.failures = [...this.failures.filter((t) => at - t <= 300_000), at];
    if (this.failures.length >= (this.o.maxFailures ?? 10)) {
      this.state = 'failed';
      return;
    }
    this.restarts++;
    this.state = 'retrying';
    const wait = Math.min(this.o.backoffMaxMs ?? 30_000, (this.o.backoffBaseMs ?? 2000) * 2 ** (this.failures.length - 1));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.launch();
    }, wait);
  }

  /** Sends one run-time command on the configured channel. Never throws; the outcome shows in status(). */
  private async send(cmd: MixCommand): Promise<void> {
    try {
      if (this.control === 'stdin') {
        const w = this.child?.stdin;
        if (!w || w.destroyed || !w.writable) throw new Error('mixer_not_running');
        w.write(stdinLine(cmd));
      } else {
        if (this.child === null) throw new Error('mixer_not_running');
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
