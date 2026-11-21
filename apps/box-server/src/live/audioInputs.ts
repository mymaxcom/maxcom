import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { actorOf, deviceOf } from '../actor.ts';
import { reqSurau } from '../reqSurau.ts';

/** Mic-in pada kotak (M1): the box's own capture devices (Windows dshow), the chosen one, a level probe. */

export type AudioInputPlatform = 'windows' | 'android';

export interface AudioDevice {
  /** dshow friendly name, the only thing handed to ffmpeg (as `audio=<name>`, in an args array). */
  name: string;
  /** dshow alternative name (moniker); informational, never used to capture. */
  alt: string | null;
  /** false when the name cannot be passed safely to the combiner (control characters, quote, `:` or `=`). */
  usable: boolean;
}

export interface AudioInputsView {
  platform: AudioInputPlatform;
  available: boolean;
  devices: Array<{ name: string; usable: boolean }>;
  selected: string | null;
  reason?: string;
  /** Why not available: `no_device` (nothing to capture from), `list_failed` (the device list could not be read). */
  code?: AudioInputCode;
}

/**
 * Coded answers of Mic-in: `no_device` (no capture device found), `list_failed`, `access_denied` (ffmpeg says Windows refuses
 * the device: an access error), `device_unavailable` (the device cannot be opened for another reason: busy, unplugged,
 * renamed) and `silent` (it opens but the probe is digital silence, -91 dB: unplugged or muted). The app maps each code
 * to its own text; `access_denied` is "Windows tidak membenarkan MAXCOM menggunakan Mic-in. Jalankan Semak MAXCOM."
 */
export type AudioInputCode = 'no_device' | 'list_failed' | 'access_denied' | 'device_unavailable' | 'silent' | 'no_tool';

export const AUDIO_INPUT_MSG = {
  android: 'Kotak Android belum menyokong Mic-in',
  none: 'Tiada input audio pada kotak ini',
  noTool: 'Alat siaran tidak tersedia di kotak.',
  listFailed: 'Senarai input audio kotak tidak dapat dibaca.',
  badChoice: 'Input audio itu tidak dijumpai pada kotak.',
  unusable: 'Nama input audio itu tidak boleh digunakan.',
  tooMany: 'Terlalu banyak percubaan. Cuba sebentar lagi.',
  liveBusy: 'Siaran sedang berjalan. Aras bunyi tidak boleh diukur sekarang.',
  accessDenied: 'Windows tidak membenarkan MAXCOM menggunakan Mic-in. Jalankan Semak MAXCOM.',
  deviceUnavailable: 'Mic-in tidak dapat dibuka. Semak mikrofon disambung dan tidak sedang digunakan oleh aplikasi lain.',
  silent: 'Tiada bunyi dari mikrofon. Semak mikrofon disambung dan tidak dibisukan.',
} as const;

/** What ffmpeg prints when Windows really refuses the capture device (microphone privacy, wrong account). A device that is busy, missing or renamed prints other errors and is `device_unavailable`. */
const ACCESS_ERROR = /access is denied|permission denied|0x80070005/i;

/** Digital silence from volumedetect (-inf is read as -91): the sound never reaches the box. */
export const SILENT_DB = -90;

/** Strips ffmpeg's `[in#0 @ 0000..] ` / `[dshow @ 0000..] ` prefix. */
const PREFIX = /^\[[^\]]*\]\s*/;
const DEVICE_LINE = /^"(.*)"\s*\(([a-z, ]+)\)\s*$/; // ffmpeg >= 5: "name" (audio)
const OLD_DEVICE_LINE = /^"(.*)"\s*$/; // older ffmpeg: "name" under a section header
const ALT_LINE = /^Alternative name\s+"(.*)"\s*$/;
const SECTION = /^DirectShow\s+(audio|video)\s+devices/i;

/** A name is usable when it holds nothing the dshow input string or the argument list could misread. */
export function isUsableDeviceName(name: string): boolean {
  if (name.length < 1 || name.length > 120) return false;
  if (name.includes('�')) return false; // output decoded wrongly: the real name is unknown
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f"=:]/u.test(name);
}

/**
 * Parses the stderr of `ffmpeg -list_devices true -f dshow -i dummy` into audio devices.
 * Handles the ffmpeg 5+ format (type tag per line) and the older one (section headers); names may hold quotes
 * and parentheses (the line is anchored on its tail, not split on quotes); the localised Windows text never
 * matters because only ffmpeg's own markers are read.
 */
export function parseDshowAudioDevices(text: string): AudioDevice[] {
  const out: AudioDevice[] = [];
  let section: 'audio' | 'video' | null = null;
  let last: AudioDevice | null = null; // the audio device the next "Alternative name" belongs to
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(PREFIX, '').trim();
    if (line === '') continue;
    const sec = SECTION.exec(line);
    if (sec !== null) {
      section = sec[1]!.toLowerCase() as 'audio' | 'video';
      last = null;
      continue;
    }
    const alt = ALT_LINE.exec(line);
    if (alt !== null) {
      if (last !== null && last.alt === null) last.alt = alt[1]!;
      continue;
    }
    const m = DEVICE_LINE.exec(line);
    if (m !== null) {
      const types = m[2]!.split(',').map((t) => t.trim());
      if (types.includes('audio')) {
        last = { name: m[1]!, alt: null, usable: isUsableDeviceName(m[1]!) };
        out.push(last);
      } else last = null;
      continue;
    }
    if (section === 'audio') {
      const o = OLD_DEVICE_LINE.exec(line);
      if (o !== null) {
        last = { name: o[1]!, alt: null, usable: isUsableDeviceName(o[1]!) };
        out.push(last);
        continue;
      }
    }
    if (section !== null && !line.startsWith('"')) last = null;
  }
  // the same friendly name twice cannot be told apart by `audio=<name>`: keep the first
  const seen = new Set<string>();
  return out.filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)));
}

export interface RunResult {
  /** ffmpeg writes the device list to stderr and exits 1 ("dummy" does not exist): never read the exit code. */
  output: string;
  ok: boolean;
}

export type Runner = (ffmpeg: string, args: readonly string[], timeoutMs: number) => Promise<RunResult>;

/** Spawns with an args array (no shell); output decoded as UTF-8, bounded. */
export const spawnRunner: Runner = (ffmpeg, args, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ output: Buffer.concat(chunks).toString('utf8'), ok });
    };
    let child;
    try {
      child = spawn(ffmpeg, [...args], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      resolve({ output: '', ok: false });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done(false);
    }, timeoutMs);
    child.stderr.on('data', (b: Buffer) => {
      if (size < 256 * 1024) {
        chunks.push(b);
        size += b.length;
      }
    });
    child.on('error', () => done(false));
    child.on('close', () => done(true));
  });

export const LIST_ARGS: readonly string[] = ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];

/** Args of the level probe: 1 s of the device at 48 kHz (the Intel SST microphone is silent at 16 kHz). */
export function levelArgs(deviceName: string): string[] {
  return ['-hide_banner', '-nostats', '-f', 'dshow', '-sample_rate', '48000', '-i', `audio=${deviceName}`, '-t', '1', '-af', 'volumedetect', '-f', 'null', '-'];
}

/** mean/max volume (dBFS) from volumedetect output; null when absent. */
export function parseVolumeDetect(text: string): { meanDb: number; maxDb: number } | null {
  const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?|-inf)\s*dB/.exec(text);
  const max = /max_volume:\s*(-?\d+(?:\.\d+)?|-inf)\s*dB/.exec(text);
  if (mean === null || max === null) return null;
  const n = (s: string): number => (s === '-inf' ? -91 : Number(s));
  return { meanDb: n(mean[1]!), maxDb: n(max[1]!) };
}

export interface AudioInputOptions {
  /** Pinned ffmpeg (runtime.tools.ffmpeg); null/absent: no tool. */
  ffmpegPath: () => string | null;
  /** Where the choice is kept (`<dataDir>/live-audio-input.json`); absent: kept in memory only. */
  dataDir?: string;
  platform?: AudioInputPlatform;
  /** Minimum seconds between two real listings (default 10). */
  minRefreshMs?: number;
  /** Minimum ms between two level probes (default 1500). */
  minLevelMs?: number;
  /** The doctor's check answer is reused for this long (default 30 s). */
  minCheckMs?: number;
  now?: () => number;
  run?: Runner;
  /** True while a live runs: the device may be in use, no probe then. */
  isLive?: () => boolean;
}

interface Snapshot {
  at: number;
  devices: AudioDevice[];
  failed: boolean;
}

export class AudioInputs {
  readonly platform: AudioInputPlatform;
  private readonly o: AudioInputOptions;
  private readonly now: () => number;
  private readonly run: Runner;
  private snap: Snapshot | null = null;
  private inflight: Promise<Snapshot> | null = null;
  private choice: string | null = null;
  private loaded = false;
  private lastLevelAt = 0;
  private lastLevel: { meanDb: number; maxDb: number } | null = null;
  private lastProblem: 'access_denied' | 'device_unavailable' | 'silent' | null = null;
  private probing = false;
  private lastCheck: { at: number; answer: { devices: number; code: 'ok' | AudioInputCode | 'untested' } } | null = null;
  private checking: Promise<{ devices: number; code: 'ok' | AudioInputCode | 'untested' }> | null = null;

  constructor(o: AudioInputOptions) {
    this.o = o;
    this.platform = o.platform ?? (process.platform === 'win32' ? 'windows' : 'android');
    this.now = o.now ?? Date.now;
    this.run = o.run ?? spawnRunner;
  }

  private file(): string | null {
    return this.o.dataDir === undefined ? null : join(this.o.dataDir, 'live-audio-input.json');
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const f = this.file();
    if (f === null || !existsSync(f)) return;
    try {
      const v = JSON.parse(readFileSync(f, 'utf8')) as { deviceName?: unknown };
      if (typeof v.deviceName === 'string' && isUsableDeviceName(v.deviceName)) this.choice = v.deviceName;
    } catch {
      /* unreadable: no choice */
    }
  }

  /** The chosen device name (may be gone from the box; `current` checks that). */
  selected(): string | null {
    this.load();
    return this.choice;
  }

  setSelected(name: string | null): void {
    this.load();
    this.choice = name;
    const f = this.file();
    if (f === null) return;
    mkdirSync(this.o.dataDir!, { recursive: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify({ deviceName: name }));
    renameSync(tmp, f);
  }

  /** The cached list, refreshed when older than minRefreshMs or when `force` (still limited by minRefreshMs). */
  async list(force = false): Promise<Snapshot> {
    const min = this.o.minRefreshMs ?? 10_000;
    const t = this.now();
    if (this.snap !== null && (t - this.snap.at < min || (!force && t - this.snap.at < 60_000))) return this.snap;
    if (this.inflight !== null) return this.inflight;
    this.inflight = this.refresh(t).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(t: number): Promise<Snapshot> {
    const ff = this.o.ffmpegPath();
    let snap: Snapshot;
    if (this.platform !== 'windows' || ff === null) {
      snap = { at: t, devices: [], failed: false };
    } else {
      const r = await this.run(ff, LIST_ARGS, 8000);
      const devices = parseDshowAudioDevices(r.output);
      snap = { at: t, devices, failed: !r.ok && devices.length === 0 };
    }
    this.snap = snap;
    return snap;
  }

  /** Synchronous view of the last list (empty before the first refresh). */
  devicesNow(): AudioDevice[] {
    return this.snap?.devices ?? [];
  }

  /** What the combiner needs: the chosen device, or the only usable one; null when none (never throws). */
  boxInput(): { deviceName: string } | null {
    if (this.platform !== 'windows' || this.o.ffmpegPath() === null) return null;
    const usable = this.devicesNow().filter((d) => d.usable);
    const chosen = this.selected();
    if (chosen !== null) return usable.some((d) => d.name === chosen) ? { deviceName: chosen } : null;
    return usable.length === 1 ? { deviceName: usable[0]!.name } : null;
  }

  async view(force = false): Promise<AudioInputsView> {
    const base = { platform: this.platform } as const;
    if (this.platform !== 'windows') return { ...base, available: false, devices: [], selected: null, reason: AUDIO_INPUT_MSG.android };
    if (this.o.ffmpegPath() === null) return { ...base, available: false, devices: [], selected: null, reason: AUDIO_INPUT_MSG.noTool, code: 'no_tool' };
    const s = await this.list(force);
    const devices = s.devices.map((d) => ({ name: d.name, usable: d.usable }));
    const current = this.boxInput();
    if (s.failed) return { ...base, available: false, devices, selected: null, reason: AUDIO_INPUT_MSG.listFailed, code: 'list_failed' };
    if (!s.devices.some((d) => d.usable)) return { ...base, available: false, devices, selected: null, reason: AUDIO_INPUT_MSG.none, code: 'no_device' };
    return { ...base, available: true, devices, selected: current?.deviceName ?? null };
  }

  /**
   * Level meter: a 1 s volumedetect probe of the chosen device, at most once per minLevelMs (the last answer is
   * repeated in between). Chosen over reusing the combiner monitor because it works before the live starts, which
   * is when the operator checks the input; while a live runs the device is the combiner's, so no probe then.
   */
  async level(): Promise<{ level: { meanDb: number; maxDb: number } | null; reason?: string; code?: AudioInputCode }> {
    const input = this.boxInput();
    const ff = this.o.ffmpegPath();
    if (input === null || ff === null) {
      this.lastProblem = null;
      this.lastLevel = null;
      return { level: null, reason: AUDIO_INPUT_MSG.none, code: ff === null ? 'no_tool' : 'no_device' };
    }
    if (this.o.isLive?.() === true) return { level: null, reason: AUDIO_INPUT_MSG.liveBusy };
    const t = this.now();
    if (this.probing || t - this.lastLevelAt < (this.o.minLevelMs ?? 1500)) return this.levelAnswer();
    this.probing = true;
    this.lastLevelAt = t;
    // a probe that throws leaves no stale answer behind
    this.lastProblem = null;
    this.lastLevel = null;
    try {
      const r = await this.run(ff, levelArgs(input.deviceName), 6000);
      this.lastLevel = parseVolumeDetect(r.output);
      if (this.lastLevel === null) {
        // no reading at all: Windows refused the device (ffmpeg says so), or it cannot be opened (busy, unplugged, renamed)
        this.lastProblem = ACCESS_ERROR.test(r.output) ? 'access_denied' : 'device_unavailable';
      } else if (this.lastLevel.maxDb <= SILENT_DB) {
        // it opened but gives digital silence: not plugged in, or muted
        this.lastProblem = 'silent';
      }
    } finally {
      this.probing = false;
    }
    return this.levelAnswer();
  }

  private levelAnswer(): { level: { meanDb: number; maxDb: number } | null; reason?: string; code?: AudioInputCode } {
    switch (this.lastProblem) {
      case 'access_denied':
        return { level: this.lastLevel, reason: AUDIO_INPUT_MSG.accessDenied, code: 'access_denied' };
      case 'device_unavailable':
        return { level: this.lastLevel, reason: AUDIO_INPUT_MSG.deviceUnavailable, code: 'device_unavailable' };
      case 'silent':
        return { level: this.lastLevel, reason: AUDIO_INPUT_MSG.silent, code: 'silent' };
      default:
        return { level: this.lastLevel };
    }
  }

  /**
   * The doctor's question (loopback health `?mic=1`): how many capture devices the box sees and, with one 1-second probe of
   * the chosen or only device, whether sound reaches it. `untested` while a live runs (the device is the combiner's).
   */
  async check(): Promise<{ devices: number; code: 'ok' | AudioInputCode | 'untested' }> {
    // the doctor may ask often (and the route is open to the machine's own programs): the last answer stands for 30 s
    const t = this.now();
    if (this.lastCheck !== null && t - this.lastCheck.at < (this.o.minCheckMs ?? 30_000)) return this.lastCheck.answer;
    if (this.checking !== null) return this.checking;
    this.checking = this.checkNow().then((answer) => {
      this.lastCheck = { at: this.now(), answer };
      return answer;
    }).finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async checkNow(): Promise<{ devices: number; code: 'ok' | AudioInputCode | 'untested' }> {
    const v = await this.view(true);
    const usable = v.devices.filter((d) => d.usable).length;
    if (v.code !== undefined) return { devices: v.devices.length, code: v.code };
    if (this.boxInput() === null) return { devices: usable, code: 'untested' };
    const l = await this.level();
    if (l.code !== undefined) return { devices: usable, code: l.code };
    return { devices: usable, code: l.reason !== undefined ? 'untested' : 'ok' };
  }
}

export interface AudioInputRouteDeps {
  db: DatabaseSync;
  inputs: AudioInputs;
}

/** Routes of Mic-in; every one has a row in ROUTE_PERMISSIONS (auth/authz.ts). */
export function registerAudioInputRoutes(app: FastifyInstance, deps: AudioInputRouteDeps): void {
  const { inputs } = deps;
  const send = (reply: FastifyReply, code: number, body: unknown): FastifyReply => reply.code(code).header('Cache-Control', 'no-store').send(body);

  app.get('/api/live/audio-inputs', async (request, reply) => {
    const force = (request.query as { refresh?: unknown } | null)?.refresh === '1';
    return send(reply, 200, await inputs.view(force));
  });

  app.put('/api/live/audio-input', async (request, reply) => {
    const body = request.body;
    const asked = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { deviceName?: unknown }).deviceName : undefined;
    if (asked !== null && typeof asked !== 'string') return send(reply, 400, { errors: [AUDIO_INPUT_MSG.badChoice], code: 'bad_choice' });
    if (typeof asked === 'string') {
      const view = await inputs.view(true);
      const hit = view.devices.find((d) => d.name === asked);
      if (!view.available || hit === undefined) return send(reply, 400, { errors: [AUDIO_INPUT_MSG.badChoice], code: 'bad_choice' });
      if (!hit.usable) return send(reply, 400, { errors: [AUDIO_INPUT_MSG.unusable], code: 'unusable' });
    }
    inputs.setSelected(asked as string | null);
    // the device name is a hardware label, not a secret
    deps.db
      .prepare('INSERT INTO change_log (surau_id, at, actor, entity, entity_id, before_json, after_json, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(reqSurau(request), new Date().toISOString(), actorOf(request), 'live-audio-input', 'choose', null, JSON.stringify({ deviceName: asked }), deviceOf(request) ?? null);
    return send(reply, 200, await inputs.view());
  });

  app.get('/api/live/audio-inputs/level', async (_request, reply) => {
    const r = await inputs.level();
    return send(reply, 200, r);
  });
}
