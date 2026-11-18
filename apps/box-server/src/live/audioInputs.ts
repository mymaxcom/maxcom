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
}

export const AUDIO_INPUT_MSG = {
  android: 'Kotak Android belum menyokong Mic-in',
  none: 'Tiada input audio pada kotak ini',
  noTool: 'Alat siaran tidak tersedia di kotak.',
  listFailed: 'Senarai input audio kotak tidak dapat dibaca.',
  badChoice: 'Input audio itu tidak dijumpai pada kotak.',
  unusable: 'Nama input audio itu tidak boleh digunakan.',
  tooMany: 'Terlalu banyak percubaan. Cuba sebentar lagi.',
  liveBusy: 'Siaran sedang berjalan. Aras bunyi tidak boleh diukur sekarang.',
} as const;

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
  private probing = false;

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
    if (this.o.ffmpegPath() === null) return { ...base, available: false, devices: [], selected: null, reason: AUDIO_INPUT_MSG.noTool };
    const s = await this.list(force);
    const devices = s.devices.map((d) => ({ name: d.name, usable: d.usable }));
    const current = this.boxInput();
    if (s.failed) return { ...base, available: false, devices, selected: null, reason: AUDIO_INPUT_MSG.listFailed };
    if (!s.devices.some((d) => d.usable)) return { ...base, available: false, devices, selected: null, reason: AUDIO_INPUT_MSG.none };
    return { ...base, available: true, devices, selected: current?.deviceName ?? null };
  }

  /**
   * Level meter: a 1 s volumedetect probe of the chosen device, at most once per minLevelMs (the last answer is
   * repeated in between). Chosen over reusing the combiner monitor because it works before the live starts, which
   * is when the operator checks the input; while a live runs the device is the combiner's, so no probe then.
   */
  async level(): Promise<{ level: { meanDb: number; maxDb: number } | null; reason?: string }> {
    const input = this.boxInput();
    const ff = this.o.ffmpegPath();
    if (input === null || ff === null) return { level: null, reason: AUDIO_INPUT_MSG.none };
    if (this.o.isLive?.() === true) return { level: null, reason: AUDIO_INPUT_MSG.liveBusy };
    const t = this.now();
    if (this.probing || t - this.lastLevelAt < (this.o.minLevelMs ?? 1500)) return { level: this.lastLevel };
    this.probing = true;
    this.lastLevelAt = t;
    try {
      const r = await this.run(ff, levelArgs(input.deviceName), 6000);
      this.lastLevel = parseVolumeDetect(r.output);
    } finally {
      this.probing = false;
    }
    return { level: this.lastLevel };
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
