import { LOCAL_SURAU_ID } from '../tenant.ts';
import { randomInt } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Readable } from 'node:stream';
import { audioPlanOf, cleanYoutubeText, normaliseAudioMix, youtubeMetaFor } from '@surau/core';
import type {
  AddedAudioId,
  AlignState,
  AudioCaps,
  AudioPlan,
  KioskLive,
  LiveAudioMix,
  LiveAudioSourceStatus,
  LiveOutputs,
  LiveSource,
  LiveStartRequest,
  LiveStatus,
  LiveVideoSource,
  YoutubeMeta,
  YoutubeVia,
} from '@surau/core';
import { randomToken } from '../auth/crypto.ts';
import { getItem } from '../content/store.ts';
import { getSettings } from '../settingsStore.ts';
import { Aligner, DEFAULT_INITIAL_DELAY_MS } from './align.ts';
import type { AlignerOptions } from './align.ts';
import { cameraPullUrl, cameraSecrets } from './camera.ts';
import { EncoderCapability } from './encoder.ts';
import type { EncoderProbe } from './encoder.ts';
import type { CameraRecord, CameraTestResult } from './camera.ts';
import type { FirewallState } from './firewall.ts';
import type { LiveRuntime, MediamtxPath } from './mediamtx.ts';
import { LevelMeter } from './levels.ts';
import { MONITOR_RATE, Mixer } from './mixer.ts';
import type { MixerOptions, MixerStartConfig, MixerStatus, MixUnit, VolumeTarget } from './mixer.ts';
import { KIOSK_AUDIO_PATH, Relay } from './relay.ts';
import { FrameGrabber } from './noticeFrame.ts';
import type { RelayOptions } from './relay.ts';

/** A refusal with the HTTP status and a stable code the app switches on. Messages carry no secret. */
export class LiveError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'LiveError';
    this.status = status;
    this.code = code;
  }
}

export const LIVE_MSG = {
  liveOff: 'Siaran langsung di skrin dimatikan',
  toolsMissing: 'Perisian siaran belum dipasang di kotak',
  mediamtxDown: 'Pelayan siaran tidak berjalan',
  busy: 'Siaran sedang berjalan dari peranti lain',
  noKuliah: 'Kuliah tidak dijumpai',
  kuliahBatal: 'Kuliah ini telah dibatalkan',
  badRequest: 'Permintaan siaran tidak sah',
  noSession: 'Tiada siaran sedang berjalan',
  noNotice: 'Tiada siaran YouTube yang sedang berjalan',
  badNotice: 'Teks tidak sah: perlu mengandungi pautan siaran dan tidak lebih 1000 aksara',
  wrongSource: 'Siaran ini tidak dihantar dari pelayar',
  forbidden: 'Siaran ini dimulakan oleh peranti lain',
  rate: 'Terlalu banyak cubaan mula siaran. Cuba lagi sebentar lagi.',
  ytSignoutBusy: 'Siaran sedang berjalan. Hentikan siaran sebelum log keluar YouTube.',
  cameraOff: 'Kamera luaran dimatikan di Tetapan',
  cameraTestBusy: 'Ujian sambungan kamera sedang berjalan. Cuba lagi sebentar lagi.',
  cameraNotSet: 'Kamera luaran belum disediakan',
  cameraH265: 'Kamera H.265 hanya boleh disiarkan dari telefon Android. Untuk iPad, tukar kamera kepada H.264.',
  audioUnsupported: 'Sumber audio ini tidak boleh ditukar semasa siaran berjalan',
} as const;

/** Start limiter: rolling hour. */
const START_WINDOW_MS = 3_600_000;
const START_MAX_PER_DEVICE = 6;
const START_MAX_PER_BOX = 12;

/** The warning code the app shows for a YouTube failure (the reason is a fixed vocabulary, never Google's text). */
function youtubeWarning(e: unknown): string {
  const reason = typeof e === 'object' && e !== null ? (e as { reason?: unknown }).reason : undefined;
  if (reason === 'quota') return 'youtube_quota';
  if (reason === 'reauthorise') return 'youtube_reauthorise';
  if (reason === 'forbidden') return 'youtube_forbidden';
  // the box's YouTube leg goes through the cloud (Plan 6): the cloud itself could not be reached
  if (reason === 'cloud_unreachable') return 'cloud_unreachable';
  return 'no_internet';
}

/** The YouTube side (Task 4 supplies the real one). Absent or signed out: the leg is skipped with a warning. */
export interface YoutubeLeg {
  signedIn(): boolean;
  /** Creates and binds the broadcast. The stream key it returns is held in memory only. */
  createBroadcastFor(req: { sessionId: string; meta: YoutubeMeta }): Promise<{ broadcastId: string; watchUrl: string; key: string }>;
  complete(broadcastId: string): Promise<void>;
  status(): LiveStatus['youtube'];
}

export interface LiveSessionsDeps {
  db: DatabaseSync;
  now: () => Date;
  runtime: LiveRuntime | null;
  /** Called with every new KioskLive (only when it differs from the previous one). */
  onKiosk: (live: KioskLive) => void;
  youtube?: YoutubeLeg | null;
  /** How often the ingest state is polled while a session is open (default 2000). */
  monitorMs?: number;
  /** No ingest for this long, at start or after it vanished, ends the session (default 10 min). */
  idleTimeoutMs?: number;
  /** How long an ended session's YouTube broadcast stays open for a restart of the same kuliah (default 5 min; 0 = never). */
  youtubeGraceMs?: number;
  /** The media-ports firewall check (cached by the check itself); without it the state is always unknown. */
  firewall?: { check(): Promise<FirewallState>; state(): FirewallState } | null;
  /** No picture for this long after the start (or after it vanished) shows `no_video_from_device` (default 12 s). */
  noVideoMs?: number | (() => number);
  /** Where relay.log is written; without it the box relay is not available. */
  dataDir?: string;
  /** Test hook: replaces the ffmpeg executable, arguments and timings of the relay. */
  relayOptions?: Partial<RelayOptions>;
  /** Test hook: options of the live-notice frame grabber (a spawn stand-in, a clock). */
  frameOptions?: Partial<import('./noticeFrame.ts').FrameGrabberOptions>;
  /** Test hook: replaces the H.264 encoder probe (default: runs `ffmpeg -h encoder=libx264` once per ffmpeg path). */
  encoderProbe?: EncoderProbe;
  /** Pause between tries to set the publisher user and passphrase again after a MediaMTX respawn (default 500). */
  reprovisionMs?: number;
  /** The saved external camera (B1); also set later with `attachCamera`. Only the box reads the full address. */
  camera?: CameraSource | null;
  /** The box's capture device for "Mic-in pada kotak" (M1); null or absent: not available. */
  boxInput?: () => { deviceName: string; device?: number } | null;
  /** Test hooks: replace the combiner and the aligner. */
  mixerFactory?: (o: MixerOptions) => MixerLike;
  alignerFactory?: (o: AlignerOptions) => AlignerLike;
  /** Test hook: extra options of every combiner (an ffmpeg stand-in, say). */
  mixOptions?: Partial<MixerOptions>;
  /** Combiner timings (plan 4.6); the defaults are the plan's. */
  combiner?: Partial<CombinerTimings>;
}

/** The slice of CameraStore the sessions use. */
export interface CameraSource {
  get(): CameraRecord | null;
  readonly lastTest: CameraTestResult | null;
}

/** The slice of Mixer the sessions use (a fake satisfies it too). */
export interface MixerLike {
  readonly monitor: Readable;
  start(cfg: MixerStartConfig): void;
  setDelay(id: AddedAudioId, ms: number): Promise<void>;
  setVolume(id: VolumeTarget, pct: number): Promise<void>;
  stop(): Promise<void>;
  status(): MixerStatus;
}

/** The slice of Aligner the sessions use. */
export interface AlignerLike {
  start(): void;
  stop(): void;
  state(id: AddedAudioId): AlignState;
  delayMs(id: AddedAudioId): number;
  residualMs(id: AddedAudioId): number | undefined;
  setManual(id: AddedAudioId): void;
  reset(id: AddedAudioId): void;
}

export interface CombinerTimings {
  /** Fixed delay of the unit input (picture and sound), so every added source is the earlier signal (plan 4.3a). */
  headroomMs: number;
  /** An added microphone gone this long leaves the graph (the picture must never stall behind it). */
  micLostMs: number;
  /** An added microphone must have been steady this long before it is added back. */
  micSteadyMs: number;
  /** After the picture arrives the combiner waits this long for the added microphone, then starts without it. */
  micWaitMs: number;
  /** The fade-in of an added source after its first lock (0: at once). */
  fadeMs: number;
  fadeSteps: number;
  /** With Automatik, a camera that gave no picture this long is pulled with the other transport. */
  transportSwitchMs: number;
}

const COMBINER_DEFAULTS: CombinerTimings = {
  headroomMs: 2000,
  micLostMs: 5000,
  micSteadyMs: 3000,
  micWaitMs: 8000,
  fadeMs: 500,
  fadeSteps: 5,
  transportSwitchMs: 15_000,
};

/** MediaMTX paths of the box path (plan 4.6). */
const CAM_PATH = 'surau-cam';
const MIC_PATH = 'surau-mic';
const IN_PATH = 'surau-in';

/** The credentials never leave this object except in the start answer to the owning device and in the proxies. */
interface Session {
  id: string;
  kuliahId: string | null;
  source: LiveSource;
  outputs: LiveOutputs;
  youtubeVia: YoutubeVia;
  startedAt: string;
  startedAtMs: number;
  startedBy: string;
  deviceId: string;
  kuliah: { label: string; penceramah: string; topic: string | null } | null;
  /** The kuliah's start (HH:MM) for the live notice. */
  kuliahTime: string | null;
  pubUser: string;
  pubPass: string;
  passphrase: string | null;
  broadcastId: string | null;
  watchUrl: string | null;
  youtubeKey: string | null;
  /** The broadcast is being created after the start answer (a sleeping cloud can take ~20 s). */
  ytPending: boolean;
  /** The visibility its YouTube broadcast was made with (a restart inside the grace window reuses it only for the same one). */
  ytPrivacy: string | null;
  /** Why the YouTube leg could not start (a fixed warning code); shown through the status. */
  ytWarning: string | null;
  /** "Kod semula" was asked but this box cannot encode H.264: the relay runs `copy` (warning `reencode_unsupported`). */
  reencodeFallback: boolean;
  /** The ffmpeg relay of the box YouTube leg (youtubeVia 'box' with a key); null otherwise. */
  relay: Relay | null;
  /** The kiosk audio leg (ffmpeg: video copy + Opus republished to `surau-kiosk`); null while the kiosk audio is off. */
  audioLeg: Relay | null;
  /** The ingest dropped after the audio leg failed: the next return of the picture may replace the failed leg. */
  audioRetryArmed: boolean;
  /** WHIP session ids created through the proxy (only these may be deleted through it). */
  whipIds: Set<string>;
  lastReadyAtMs: number;
  everReadyAtMs: number | null;
  readySince: string | null;
  ready: boolean;
  ingestSource: MediamtxPath['source'];
  bitrateKbps: number;
  lastBytes: number;
  lastBytesAtMs: number;
  ingestMs: number;
  /** MediaMTX has not had the publisher path ready for `noVideoMs`: the app shows `no_video_from_device`. */
  noVideo: boolean;
  /** The picture source and the audio mix as normalised at the start (and changed by `POST /api/live/audio`). */
  video: LiveVideoSource;
  mix: LiveAudioMix;
  plan: AudioPlan;
  /** The start request carried an audio mix (or the box mixes): the status reports it. */
  reportAudio: boolean;
  /** The box pulls the camera into `surau-cam` (iPad or web with Kamera luaran). */
  pulled: boolean;
  /** A combiner runs on the box (box-pulled camera, or Mic-in added to a device's own stream). */
  combined: boolean;
  unit: MixUnit | null;
  /** Where the starting device publishes: `surau`, or `surau-mic` / `surau-in` when the box combines. */
  publishPath: string;
  mixUser: string;
  mixPass: string;
  cameraHasAudio: boolean;
  /** The camera pull is being tried with this transport; `camAuto` lets the box switch to the other. */
  camTransport: 'tcp' | 'udp';
  camAuto: boolean;
  camPatchedAtMs: number;
  /** The unit (camera or ingest) and the iPad microphone as the last poll saw them. */
  unitReady: boolean;
  unitEverReady: boolean;
  /** An ingest unit (a device's own stream) whose tracks were seen and hold no sound: the in-graph silent reference is used. */
  ingestNoAudio: boolean;
  /** The combiner state last logged. */
  mixLogged: string;
  /** The box capture device (Mic-in) as it was when the session started or Mic-in was chosen; the combiner never re-reads the live list. */
  boxDevice: { deviceName: string; device?: number } | null;
  unitReadySinceMs: number | null;
  unitLastReadyAtMs: number;
  micReady: boolean;
  micEverReady: boolean;
  micReadySinceMs: number | null;
  micLostSinceMs: number | null;
  /** No picture from the camera for `noVideoMs` (box-pulled sessions; the device watchdog `noVideo` is not used there). */
  noCamera: boolean;
  /** The last status poll of the starting device (a box-pulled live can outlive its controller). */
  lastPollAtMs: number;
  /** The running combiner and aligner (null while the unit is absent). */
  mixer: MixerLike | null;
  aligner: AlignerLike | null;
  /** The added sources in the running graph, and the graph's signature (unit, unit audio, sources). */
  graphAdded: Set<AddedAudioId>;
  graphSig: string;
  /** The volume last sent to the graph per added source, and the unit's. */
  applied: Map<AddedAudioId, number>;
  appliedUnit: number;
  alignStates: Map<AddedAudioId, AlignState>;
  fades: Map<AddedAudioId, NodeJS.Timeout[]>;
  /** Serialises combiner starts and stops (two ffmpeg must never publish to `surau` at once). */
  combinerOp: Promise<void>;
  /** WHEP preview sessions of the starting device. */
  previewIds: Set<string>;
  /** The iPad's own camera is the unit (a mid-live switch of a box-pulled live); the camera pull keeps running. */
  ownCamera: boolean;
  /** Offset (ms) of the added microphone sent in a mix change while a camera without sound is mixed by hand; null = the saved setting. */
  offsetMs: number | null;
  /** Levels of the running combiner's sources (dBFS), measured on its monitor. */
  meter: LevelMeter | null;
  meterOff: (() => void) | null;
}

export interface StartResult {
  session: NonNullable<LiveStatus['session']>;
  ingest: {
    whip: string;
    /** The MediaMTX path the device publishes to: `surau`, or `surau-mic` / `surau-in` when the box combines. */
    path?: string;
    srt: { host: string; port: number; streamId: string; passphrase: string } | null;
  };
  /** `state: 'starting'` (additive): the broadcast is still being created; the box relay starts by itself when it is ready. */
  youtube: { via: YoutubeVia; ingest: string | null; key: string | null; state?: 'starting' } | null;
  kiosk: KioskLive;
  warnings?: string[];
}

/** Warning codes the app switches on (see LiveStatus.warnings and StartResult.warnings). */
export const MEDIA_PORTS_BLOCKED = 'media_ports_blocked';
export const NO_VIDEO_FROM_DEVICE = 'no_video_from_device';
const NO_VIDEO_MS = 12_000;
const YOUTUBE_GRACE_MS = 300_000;
const isBlocked = (s: FirewallState): boolean => s === 'missing' || s === 'wrong';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PATH = 'surau';
const YOUTUBE_INGEST = 'rtmps://a.rtmps.youtube.com:443/live2';

/** Crypto-random alphanumeric string (rejection-free: randomInt is uniform). */
function randomAlnum(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALNUM[randomInt(ALNUM.length)];
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates the body of POST /api/live/start. Throws 400 on anything unexpected. */
export function parseStartRequest(body: unknown): LiveStartRequest {
  const bad = (): never => {
    throw new LiveError(400, 'bad_request', LIVE_MSG.badRequest);
  };
  if (!isRecord(body)) return bad();
  const { kuliahId, source, outputs, youtubeVia, video, audio } = body;
  if (kuliahId !== null && (typeof kuliahId !== 'string' || kuliahId === '' || kuliahId.length > 100)) return bad();
  if (source !== 'android' && source !== 'web') return bad();
  if (!isRecord(outputs) || outputs.kiosk !== true || typeof outputs.youtube !== 'boolean') return bad();
  if (youtubeVia !== 'device' && youtubeVia !== 'box') return bad();
  // a browser cannot push RTMPS itself: its YouTube leg is always the box relay
  if (source === 'web' && outputs.youtube && youtubeVia !== 'box') return bad();
  // the picture source and the audio mix (plan 4.2); both optional so an older app still starts a live
  if (video !== undefined && video !== 'phone' && video !== 'external') return bad();
  if (audio !== undefined && !isRecord(audio)) return bad();
  return {
    kuliahId: kuliahId as string | null,
    source,
    outputs: { kiosk: true, youtube: outputs.youtube },
    youtubeVia,
    ...(video !== undefined ? { video } : {}),
    ...(audio !== undefined ? { audio: audio as unknown as LiveAudioMix } : {}),
  };
}

/** MediaMTX track names of a picture (the rest are sound). */
const VIDEO_TRACK = /^(H264|H265|H\.264|H\.265|AV1|VP8|VP9|MPEG-4 Video|MPEG-1\/2 Video|M-JPEG|Motion JPEG)$/i;
const isVideoTrack = (t: string): boolean => VIDEO_TRACK.test(t);
const isH264 = (t: string): boolean => /^H\.?264$/i.test(t);
const isH265 = (t: string): boolean => /^H\.?265$/i.test(t);

export class LiveSessions {
  private session: Session | null = null;
  private starting: Promise<StartResult> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastKiosk = '';
  /** The surau-level live notice edit (one per live; ends with it). */
  private noticeEdit: { sessionId: string; text: string; by: string; at: string } | null = null;
  private readonly frames: FrameGrabber;
  private ticking = false;
  /** Slow MediaMTX/ffmpeg/YouTube clean-up of ended sessions and legs; a new start waits for it. */
  private cleanup: Promise<void> = Promise.resolve();
  private readonly monitorMs: number;
  private readonly idleMs: number;
  /** Bumped by every respawn so an older re-provision loop ends. */
  private provisionGen = 0;
  /** Starts of the last hour (device and time) for the limiter. */
  private starts: Array<{ at: number; deviceId: string }> = [];
  /**
   * The YouTube broadcast of a session that ended a moment ago. It stays open for the grace window so a new start
   * of the same kuliah on the same leg carries on with it (one kuliah, one recording: an encoder reconnecting to
   * the same key); it is completed when the window ends or a start for something else comes.
   */
  private lingering: { kuliahId: string | null; via: YoutubeVia; broadcastId: string; watchUrl: string | null; key: string; privacy: string | null; timer: NodeJS.Timeout } | null = null;

  private readonly d: LiveSessionsDeps;
  private readonly encoder: EncoderCapability;
  private camera: CameraSource | null;
  private cameraBusy: (() => boolean) | null = null;
  private readonly timing: CombinerTimings;

  /** How long without a picture before `no_video_from_device`: read fresh each check, so a settings change applies at once. */
  private noVideoMs(): number {
    const v = this.d.noVideoMs;
    const n = typeof v === 'function' ? v() : v;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : NO_VIDEO_MS;
  }

  constructor(deps: LiveSessionsDeps) {
    this.d = deps;
    this.encoder = new EncoderCapability(deps.encoderProbe);
    this.camera = deps.camera ?? null;
    this.timing = { ...COMBINER_DEFAULTS, ...(deps.combiner ?? {}) };
    this.monitorMs = deps.monitorMs ?? 2000;
    this.frames = new FrameGrabber({
      ffmpegPath: () => this.d.relayOptions?.ffmpegPath ?? this.d.runtime?.tools.ffmpeg ?? null,
      api: () => this.d.runtime?.api ?? null,
      ready: () => this.session?.ready === true,
      sessionId: () => this.session?.id ?? null,
      path: PATH,
      ...(this.d.relayOptions?.rtspPort !== undefined ? { rtspPort: this.d.relayOptions.rtspPort } : {}),
      ...(this.d.relayOptions?.argsPrefix !== undefined ? { argsPrefix: this.d.relayOptions.argsPrefix } : {}),
      ...(deps.frameOptions ?? {}),
    });
    this.idleMs = deps.idleTimeoutMs ?? 600_000;
    // MediaMTX keeps the publisher user and the SRT passphrase in memory only: a respawn loses them
    deps.runtime?.spawnListeners.add(() => this.reprovision());
  }

  /** Sets the session's publisher user and SRT passphrase in MediaMTX. */
  private async provision(s: Session, api: NonNullable<LiveRuntime['api']>): Promise<void> {
    await api.authUserAdd({ user: s.pubUser, pass: s.pubPass, permissions: [{ action: 'publish', path: s.publishPath }] });
    await api.pathsPatch(s.publishPath, { srtPublishPassphrase: s.passphrase ?? '' });
    if (s.combined) {
      // the combiner's own ffmpeg: reads the unit and the added microphone, publishes the mix; loopback only
      await api.authUserAdd({
        user: s.mixUser,
        pass: s.mixPass,
        permissions: [
          { action: 'read', path: CAM_PATH },
          { action: 'read', path: MIC_PATH },
          { action: 'read', path: IN_PATH },
          { action: 'publish', path: PATH },
        ],
        ips: ['127.0.0.1', '::1'],
      });
    }
    if (s.pulled) await this.patchCamera(s, api, s.camTransport);
  }

  /** Points `surau-cam` at the camera (the address reaches MediaMTX only as a JSON string through its API). */
  private async patchCamera(s: Session, api: NonNullable<LiveRuntime['api']>, transport: 'tcp' | 'udp'): Promise<void> {
    const record = this.camera?.get() ?? null;
    if (record === null) return;
    const url = cameraPullUrl(record);
    this.d.runtime?.secrets.add(...cameraSecrets({ ...record, url }));
    await api.pathsPatch(CAM_PATH, { source: url, sourceOnDemand: false, rtspTransport: transport });
    s.camTransport = transport;
    s.camPatchedAtMs = this.d.now().getTime();
  }

  /** Gives the sessions the saved camera (the store is made after them in app.ts). */
  /** The camera test uses the one test path of MediaMTX: a live with the external camera waits until it is done. */
  attachCameraBusy(busy: (() => boolean) | null): void {
    this.cameraBusy = busy;
  }

  attachCamera(camera: CameraSource | null): void {
    this.camera = camera;
  }

  /**
   * MediaMTX was (re)spawned while a session is open: set its credentials again, retrying until the API
   * answers (the process is up before its API is). The relays re-add their own read users every loop.
   */
  private reprovision(): void {
    const s = this.session;
    const api = this.d.runtime?.api;
    if (s === null || !api) return;
    const gen = ++this.provisionGen;
    const pause = this.d.reprovisionMs ?? 500;
    void (async () => {
      for (let i = 0; i < 120; i++) {
        if (this.session !== s || gen !== this.provisionGen) return;
        try {
          await this.provision(s, api);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, pause).unref());
        }
      }
      console.warn('live: the publisher credentials could not be restored after a MediaMTX restart (reason: mediamtx_unreachable)');
    })();
  }

  /** The limiter: false when this device or the box started too often in the last hour. */
  private startAllowed(deviceId: string): boolean {
    const nowMs = this.d.now().getTime();
    this.starts = this.starts.filter((x) => nowMs - x.at < START_WINDOW_MS);
    return this.starts.length < START_MAX_PER_BOX && this.starts.filter((x) => x.deviceId === deviceId).length < START_MAX_PER_DEVICE;
  }

  /* ------------------------------------------------------------------ reads */

  current(): { id: string; deviceId: string; source: LiveSource } | null {
    const s = this.session;
    return s === null ? null : { id: s.id, deviceId: s.deviceId, source: s.source };
  }

  /** The state the kiosk shows. Computed on every call from the cached ingest state and the live settings. */
  kioskLive(): KioskLive {
    const k = this.kioskLiveBase();
    // the live notice was edited: the number changes with every edit, so the open apps re-read it
    const rev = this.noticeRev();
    return rev !== undefined ? { ...k, noticeRev: rev } : k;
  }

  /** The edit counter of the live notice (same value as the kiosk view's `noticeRev`); undefined while it was not edited in this live. */
  noticeRev(): number | undefined {
    const e = this.noticeEdit;
    return e !== null && e.sessionId === this.session?.id ? Date.parse(e.at) : undefined;
  }

  private kioskLiveBase(): KioskLive {
    const settings = getSettings(this.d.db, LOCAL_SURAU_ID).liveOnKiosk;
    const s = this.session;
    const audio = settings.audio === true;
    const volume = typeof settings.volume === 'number' ? settings.volume : 50;
    const path = this.kioskPath();
    if (s === null || settings.enabled !== true) {
      return { live: false, since: null, kuliah: s?.kuliah ?? null, audio, volume, path };
    }
    // a box-pulled camera that was showing and is lost: the kiosk keeps the last picture with the waiting card
    if (!s.ready && s.pulled && s.unitEverReady && s.everReadyAtMs !== null) {
      return { live: true, since: s.readySince ?? new Date(s.everReadyAtMs).toISOString(), kuliah: s.kuliah, audio, volume, waiting: true, path };
    }
    if (!s.ready) return { live: false, since: null, kuliah: s.kuliah, audio, volume, path };
    return { live: true, since: s.readySince, kuliah: s.kuliah, audio, volume, path };
  }

  /* ------------------------------------------------------------------ live notice (surau-level, one per live) */

  /** The 11-character YouTube video id of the session's watch link (or of its broadcast), null when there is none. */
  private noticeVideoId(s: Session): string | null {
    const url = s.watchUrl ?? '';
    const m = /(?:[?&]v=|\/live\/|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(url);
    if (m !== null) return m[1]!;
    return s.watchUrl !== null && s.broadcastId !== null && /^[A-Za-z0-9_-]{11}$/.test(s.broadcastId) ? s.broadcastId : null;
  }

  /** The notice of the running YouTube live; `{ active: false }` when there is none. No credential or address of a camera is in it. */
  noticeView(): Record<string, unknown> {
    const s = this.session;
    const id = s === null ? null : this.noticeVideoId(s);
    if (s === null || id === null) return { active: false };
    const e = this.noticeEdit !== null && this.noticeEdit.sessionId === s.id ? this.noticeEdit : null;
    return {
      active: true,
      videoId: id,
      watchUrl: `https://www.youtube.com/live/${id}`,
      startedAt: s.startedAt,
      kuliah: s.kuliah === null ? null : { title: s.kuliah.label, speaker: s.kuliah.penceramah, time: s.kuliahTime },
      editedText: e?.text ?? null,
      editedBy: e?.by ?? null,
      editedAt: e?.at ?? null,
      frame: this.frames.available(),
    };
  }

  /** Saves (or, with null, clears) the surau's edited notice text; last edit wins. Throws LiveError. */
  editNotice(text: unknown, by: string): Record<string, unknown> {
    const s = this.session;
    const id = s === null ? null : this.noticeVideoId(s);
    if (s === null || id === null) throw new LiveError(404, 'no_notice', LIVE_MSG.noNotice);
    if (text === null) this.noticeEdit = null;
    else {
      // the watch link must stay in the text, and the text stays one short plain message
      if (typeof text !== 'string' || text.trim() === '' || text.length > 1000 || !text.includes(`https://www.youtube.com/live/${id}`) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
        throw new LiveError(400, 'bad_notice', LIVE_MSG.badNotice);
      }
      // strictly increasing, so the open apps see every edit as a new number
      const prev = this.noticeEdit !== null && this.noticeEdit.sessionId === s.id ? Date.parse(this.noticeEdit.at) : 0;
      const at = new Date(Math.max(this.d.now().getTime(), prev + 1)).toISOString();
      this.noticeEdit = { sessionId: s.id, text, by, at };
    }
    this.publishKiosk();
    return this.noticeView();
  }

  /** One frame of the running picture as a JPEG; null when there is no live notice or no frame. */
  async noticeFrame(): Promise<Buffer | null> {
    const s = this.session;
    if (s === null || this.noticeVideoId(s) === null) return null;
    return this.frames.get();
  }

  /** The media-ports firewall state (a cached read-only check); unknown when no check is wired. Never throws. */
  async checkFirewall(): Promise<FirewallState> {
    try {
      return (await this.d.firewall?.check()) ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Asks the firewall check for a fresh state without waiting (the check itself reuses a result under 60 s old). */
  private refreshFirewall(): void {
    void this.checkFirewall();
  }

  /** Standing warnings for the app: the firewall state and the no-picture watchdog. */
  private warnings(): string[] {
    const out: string[] = [];
    if (isBlocked(this.d.firewall?.state() ?? 'unknown')) out.push(MEDIA_PORTS_BLOCKED);
    const s = this.session;
    if (s?.pulled === true && !s.ownCamera) {
      if (s.noCamera) out.push('no_video_from_camera');
    } else if (s?.noVideo === true) out.push(NO_VIDEO_FROM_DEVICE);
    if (s?.ytWarning != null) out.push(s.ytWarning);
    if (s?.reencodeFallback === true) out.push('reencode_unsupported');
    if (s !== null && s.reportAudio) {
      const sources = this.audioStatus(s);
      if (sources.some((x) => x.id !== 'camera' && x.state === 'lost')) out.push('audio_source_lost');
      if (sources.some((x) => x.align?.state === 'searching')) out.push('audio_align_searching');
      if (sources.some((x) => x.align?.state === 'failed')) out.push('audio_align_failed');
      if (s.mixer?.status().state === 'failed') out.push('audio_mix_failed');
      if (s.plan.notes.includes('audio_all_muted')) out.push('audio_all_muted');
      if (s.plan.notes.includes('camera_no_audio')) out.push('camera_no_audio');
    }
    return out;
  }

  status(): LiveStatus {
    const rt = this.d.runtime;
    const s = this.session;
    const yt = this.d.youtube?.status();
    return {
      session:
        s === null
          ? null
          : { id: s.id, kuliahId: s.kuliahId, source: s.source, outputs: s.outputs, youtubeVia: s.youtubeVia, startedAt: s.startedAt, startedBy: s.startedBy },
      mediamtx: {
        running: rt?.supervisor?.status().running === true,
        tools: { mediamtx: rt?.tools.mediamtx != null, ffmpeg: rt?.tools.ffmpeg != null },
      },
      warnings: this.warnings(),
      ...(s !== null ? { video: s.video } : {}),
      ...(s !== null && s.reportAudio ? { audio: { sources: this.audioStatus(s) } } : {}),
      ingest: {
        ready: s?.ready === true,
        protocol: s?.ready !== true ? null : s.ingestSource?.type === 'webRTCSession' ? 'whip' : s.ingestSource?.type === 'srtConn' ? 'srt' : null,
        bitrateKbps: s?.ready === true ? s.bitrateKbps : 0,
        since: s?.ready === true ? s.readySince : null,
      },
      relay: s?.relay?.status() ?? { state: 'off', restarts: 0, lastError: null },
      youtube: yt ?? { signedIn: false, channelTitle: null, broadcastId: s?.broadcastId ?? null, state: 'none', health: null, watchUrl: s?.watchUrl ?? null, lastError: null },
    };
  }

  /** Health block for the admin answer. */
  healthBlock(): {
    tools: { mediamtx: boolean; ffmpeg: boolean };
    mediamtx: { running: boolean; restarts: number; reason?: 'mediamtx_version'; version?: string };
    /** `ok`, `missing`, `wrong` (the media-port rules) or `unknown` (not Windows, not checked, query failed). */
    firewall: FirewallState;
    session: string | null;
  } {
    const rt = this.d.runtime;
    const st = rt?.supervisor?.status();
    return {
      tools: { mediamtx: rt?.tools.mediamtx != null, ffmpeg: rt?.tools.ffmpeg != null },
      mediamtx: {
        running: st?.running === true,
        restarts: st?.restarts ?? 0,
        // an installed MediaMTX older than the template needs is never started: say why
        ...(rt?.tools.mediamtxTooOld != null ? { reason: 'mediamtx_version' as const, version: rt.tools.mediamtxTooOld } : {}),
      },
      firewall: this.d.firewall?.state() ?? 'unknown',
      session: this.session?.id ?? null,
    };
  }

  /** Credentials for the WHIP proxy; null unless this device owns the open session. Throws the right refusal otherwise. */
  publisherFor(deviceId: string): { sessionId: string; authorization: string; whipIds: Set<string>; path: string } {
    const s = this.session;
    if (s === null) throw new LiveError(409, 'no_session', LIVE_MSG.noSession);
    if (s.deviceId !== deviceId) throw new LiveError(403, 'not_owner', LIVE_MSG.forbidden);
    if (s.source !== 'web') throw new LiveError(409, 'wrong_source', LIVE_MSG.wrongSource);
    return { sessionId: s.id, authorization: `Basic ${Buffer.from(`${s.pubUser}:${s.pubPass}`).toString('base64')}`, whipIds: s.whipIds, path: s.publishPath };
  }

  /** The starting device's preview of the combined stream (WHEP of `surau`); throws the right refusal for anyone else. */
  previewFor(deviceId: string): { sessionId: string; path: string; ids: Set<string> } {
    const s = this.session;
    if (s === null) throw new LiveError(409, 'no_session', LIVE_MSG.noSession);
    if (s.deviceId !== deviceId) throw new LiveError(403, 'not_owner', LIVE_MSG.forbidden);
    return { sessionId: s.id, path: PATH, ids: s.previewIds };
  }

  /** The starting device polled the status: a box-pulled live without this for 10 minutes ends by itself. */
  heartbeat(deviceId: string): void {
    const s = this.session;
    if (s !== null && s.deviceId === deviceId) s.lastPollAtMs = this.d.now().getTime();
  }

  /** The stream key held for the box relay (Task 5); null when the leg is not via the box. */
  relayKey(): string | null {
    const s = this.session;
    return s !== null && s.youtubeVia === 'box' ? s.youtubeKey : null;
  }

  /**
   * The phone's own YouTube leg (youtubeVia 'device') after a start that answered before the broadcast existed:
   * only the owning device may read it, for as long as the session is open (it may read it again, for example
   * after the app restarts mid-live). `starting` while pending, `failed` when the warning is set.
   */
  deviceYoutubeFor(deviceId: string): { state: 'none' | 'starting' | 'ready' | 'failed'; ingest: string | null; key: string | null } {
    const s = this.session;
    if (s === null) throw new LiveError(409, 'no_session', LIVE_MSG.noSession);
    if (s.deviceId !== deviceId) throw new LiveError(403, 'not_owner', LIVE_MSG.forbidden);
    if (s.youtubeVia !== 'device') return { state: 'none', ingest: null, key: null };
    if (s.ytPending) return { state: 'starting', ingest: null, key: null };
    if (s.youtubeKey === null) return { state: s.ytWarning !== null ? 'failed' : 'none', ingest: null, key: null };
    return { state: 'ready', ingest: YOUTUBE_INGEST, key: s.youtubeKey };
  }

  /**
   * Can this box's ffmpeg encode H.264? Never waits: the answer known now (false while the probe runs, when there is no
   * ffmpeg, or when the last probe could not tell); a probe still needed is started in the background.
   */
  relayReencodeCapable(): boolean {
    const ffmpegPath = this.d.relayOptions?.ffmpegPath ?? this.d.runtime?.tools.ffmpeg;
    if (ffmpegPath == null) return false;
    const known = this.encoder.peek(ffmpegPath);
    if (known !== null) return known;
    void this.encoder.check(ffmpegPath);
    return false;
  }

  /** Starts the encoder probe in the background (at boot), so the first status read already has the answer. */
  warmEncoderProbe(): void {
    this.relayReencodeCapable();
  }

  /** Starts ffmpeg for the box YouTube leg. It waits for the picture itself; a problem shows in the status, never in the start. */
  private startRelay(s: Session, yt: { relayVideo: unknown; maxBitrateKbps: unknown }): void {
    const key = this.relayKey();
    const rt = this.d.runtime;
    if (key === null || s.relay !== null || this.d.dataDir === undefined || rt?.api == null) return;
    const ffmpegPath = this.d.relayOptions?.ffmpegPath ?? rt.tools.ffmpeg;
    if (ffmpegPath == null) return;
    const launch = (mode: 'copy' | 'reencode'): void => {
      try {
        const relay = new Relay({ ...this.d.relayOptions, ffmpegPath, api: rt.api!, dataDir: this.d.dataDir!, sessionId: s.id, path: PATH });
        s.relay = relay;
        relay.start({
          key,
          relayVideo: mode,
          maxBitrateKbps: typeof yt.maxBitrateKbps === 'number' ? yt.maxBitrateKbps : 2500,
        });
        rt.secrets.add(relay.readPassword());
      } catch {
        console.warn('live: the YouTube relay could not be started (reason: relay_error)');
      }
    };
    if (yt.relayVideo !== 'reencode') {
      launch('copy');
      return;
    }
    // "Kod semula" needs libx264: a box without it (the Android build) relays the picture as is, never fails the live
    const decide = (ok: boolean): void => {
      if (!ok) {
        s.reencodeFallback = true;
        console.warn('live: re-encode is not supported by this box ffmpeg, the relay copies the picture (reason: reencode_unsupported)');
      }
      launch(ok ? 'reencode' : 'copy');
    };
    const known = this.encoder.peek(ffmpegPath);
    if (known !== null) {
      decide(known);
      return;
    }
    void this.encoder.check(ffmpegPath).then((ok) => {
      // the session may have ended, or another start made the relay, while the probe ran
      if (this.session !== s || s.relay !== null) return;
      decide(ok);
    });
  }

  /** Resolves when every clean-up left running by an earlier stop has finished (tests, shutdown, the next start). */
  settled(): Promise<void> {
    return this.cleanup;
  }

  private track(job: Promise<unknown>): void {
    this.cleanup = this.cleanup.then(
      () => job.then(() => undefined, () => undefined),
      () => job.then(() => undefined, () => undefined),
    );
  }

  /**
   * The MediaMTX path the kiosk's WHEP reads. WebRTC cannot carry the phone's AAC sound, so while the
   * kiosk audio is ON and the audio leg is actually `running` the kiosk reads the Opus copy `surau-kiosk`.
   * While the leg starts or retries, after it failed, and with the audio OFF, it reads `surau` directly,
   * so the kiosk always has a picture. A change of this value is part of the kiosk live event.
   */
  kioskPath(): 'surau' | 'surau-kiosk' {
    const leg = this.session?.audioLeg;
    if (leg == null) return PATH;
    return leg.status().state === 'running' ? KIOSK_AUDIO_PATH : PATH;
  }

  /** Starts or ends the kiosk audio leg so it matches the live settings and the open session. */
  private syncAudioLeg(): void {
    const s = this.session;
    if (s === null) return;
    const settings = getSettings(this.d.db, LOCAL_SURAU_ID).liveOnKiosk;
    const want = settings.enabled === true && settings.audio === true;
    if (!want) {
      const leg = s.audioLeg;
      if (leg !== null) {
        s.audioLeg = null;
        this.track(leg.stop());
      }
      return;
    }
    if (s.audioLeg !== null) {
      // a leg that gave up while the ingest was down is replaced as soon as the picture is back
      if (s.audioLeg.status().state !== 'failed' || !s.ready || !s.audioRetryArmed) return;
      s.audioRetryArmed = false;
      const dead = s.audioLeg;
      s.audioLeg = null;
      this.track(dead.stop());
    }
    const rt = this.d.runtime;
    if (this.d.dataDir === undefined || rt?.api == null) return;
    const ffmpegPath = this.d.relayOptions?.ffmpegPath ?? rt.tools.ffmpeg;
    if (ffmpegPath == null) return;
    try {
      const leg = new Relay({
        ...this.d.relayOptions,
        ffmpegPath,
        api: rt.api,
        dataDir: this.d.dataDir,
        sessionId: s.id,
        path: PATH,
        kind: 'kioskAudio',
        logName: 'kiosk-audio.log',
      });
      s.audioLeg = leg;
      // a leg ended a moment ago removes its own user: start after that so the new user is not removed under it
      void this.cleanup.then(() => {
        if (s.audioLeg !== leg) return;
        leg.start({ key: '', relayVideo: 'copy', maxBitrateKbps: 0 });
        rt.secrets.add(leg.readPassword());
      });
    } catch {
      console.warn('live: the kiosk audio leg could not be started (reason: relay_error)');
    }
  }

  /* ------------------------------------------------------------------ start */

  start(req: LiveStartRequest, actor: string, deviceId: string, lanHost: string): Promise<StartResult> {
    const existing = this.session;
    if (existing !== null) {
      if (existing.deviceId !== deviceId) return Promise.reject(this.busy(existing));
      // the same device asking again gets its own session back (a reconnect after an app restart)
      // (a reconnect is not counted by the start limiter)
      this.refreshFirewall();
      existing.lastPollAtMs = this.d.now().getTime();
      return (this.starting ?? Promise.resolve(null)).then(() => this.answer(existing, lanHost, isBlocked(this.d.firewall?.state() ?? 'unknown') ? [MEDIA_PORTS_BLOCKED] : []));
    }
    if (!this.startAllowed(deviceId)) return Promise.reject(new LiveError(429, 'live_rate', LIVE_MSG.rate));
    const job = this.doStart(req, actor, deviceId, lanHost);
    this.starting = job;
    const clear = (): void => {
      if (this.starting === job) this.starting = null;
    };
    job.then(clear, clear);
    return job;
  }

  private busy(s: Session): LiveError {
    const row = this.d.db.prepare('SELECT name FROM devices WHERE id = ?').get(s.deviceId) as { name?: unknown } | undefined;
    const name = typeof row?.name === 'string' && row.name !== '' ? ` (${row.name})` : '';
    return new LiveError(409, 'live_busy', `${LIVE_MSG.busy}${name}`);
  }

  private async doStart(req: LiveStartRequest, actor: string, deviceId: string, lanHost: string): Promise<StartResult> {
    const rt = this.d.runtime;
    const settings = getSettings(this.d.db, LOCAL_SURAU_ID);
    if (settings.liveOnKiosk.enabled !== true) throw new LiveError(409, 'live_off', LIVE_MSG.liveOff);
    const mixing = this.planFor(req, settings.liveCamera);
    const needsFfmpeg = (req.outputs.youtube && req.youtubeVia === 'box') || mixing.combined;
    if (rt === null || rt.tools.mediamtx === null || (needsFfmpeg && rt.tools.ffmpeg === null)) {
      throw new LiveError(503, 'tools_missing', LIVE_MSG.toolsMissing);
    }
    if (rt.supervisor?.status().running !== true || rt.api === null) throw new LiveError(503, 'mediamtx_down', LIVE_MSG.mediamtxDown);
    const api = rt.api;

    let kuliah: Session['kuliah'] = null;
    let kuliahTime: string | null = null;
    let meta: YoutubeMeta | null = null;
    const surauName = settings.surauInfo.name.trim();
    if (req.kuliahId !== null) {
      const k = getItem(this.d.db, 'kuliah', req.kuliahId, LOCAL_SURAU_ID);
      if (k === null) throw new LiveError(404, 'kuliah_not_found', LIVE_MSG.noKuliah);
      if (k.status !== 'aktif') throw new LiveError(409, 'kuliah_batal', LIVE_MSG.kuliahBatal);
      const p = getItem(this.d.db, 'penceramah', k.penceramahId, LOCAL_SURAU_ID);
      kuliahTime = typeof k.time === 'string' && /^\d{2}:\d{2}$/.test(k.time) ? k.time : null;
      kuliah = { label: k.label, penceramah: p?.name ?? '', topic: k.topic !== undefined && k.topic !== '' ? k.topic : null };
      if (p !== null) {
        const kitab = k.kitabId !== undefined ? getItem(this.d.db, 'kitab', k.kitabId, LOCAL_SURAU_ID) : null;
        meta = youtubeMetaFor({ kuliah: k, penceramah: p, kitab, surauName, settings: settings.liveYoutube, now: this.d.now() });
      }
    }

    const nowMs = this.d.now().getTime();
    const id = randomToken(12);
    const session: Session = {
      id,
      kuliahId: req.kuliahId,
      source: req.source,
      outputs: req.outputs,
      youtubeVia: req.youtubeVia,
      startedAt: new Date(nowMs).toISOString(),
      startedAtMs: nowMs,
      startedBy: actor,
      deviceId,
      kuliah,
      kuliahTime,
      pubUser: `pub-${id}`,
      pubPass: randomAlnum(32),
      // MediaMTX user-name and password rules: alphanumeric only, so the ffmpeg address needs no escaping
      mixUser: `mix-${id}`,
      mixPass: randomAlnum(32),
      passphrase: req.source === 'android' ? randomAlnum(24) : null,
      broadcastId: null,
      watchUrl: null,
      youtubeKey: null,
      ytPending: false,
      ytPrivacy: null,
      ytWarning: null,
      reencodeFallback: false,
      relay: null,
      audioLeg: null,
      audioRetryArmed: false,
      whipIds: new Set(),
      lastReadyAtMs: nowMs,
      everReadyAtMs: null,
      readySince: null,
      ready: false,
      ingestSource: null,
      bitrateKbps: 0,
      lastBytes: 0,
      lastBytesAtMs: nowMs,
      ingestMs: 0,
      noVideo: false,
      video: mixing.video,
      mix: mixing.mix,
      plan: mixing.plan,
      reportAudio: req.audio !== undefined || mixing.combined,
      pulled: mixing.pulled,
      combined: mixing.combined,
      unit: mixing.unit,
      publishPath: mixing.publishPath,
      cameraHasAudio: mixing.cameraHasAudio,
      camTransport: mixing.transport,
      camAuto: mixing.auto,
      camPatchedAtMs: nowMs,
      unitReady: false,
      unitEverReady: false,
      ingestNoAudio: false,
      mixLogged: 'off',
      boxDevice: mixing.boxDevice,
      unitReadySinceMs: null,
      unitLastReadyAtMs: nowMs,
      micReady: false,
      micEverReady: false,
      micReadySinceMs: null,
      micLostSinceMs: null,
      noCamera: false,
      lastPollAtMs: nowMs,
      mixer: null,
      aligner: null,
      graphAdded: new Set(),
      graphSig: '',
      applied: new Map(),
      appliedUnit: -1,
      alignStates: new Map(),
      fades: new Map(),
      combinerOp: Promise.resolve(),
      previewIds: new Set(),
      ownCamera: false,
      offsetMs: null,
      meter: null,
      meterOff: null,
    };
    // claim the box before any await: a second start now sees the session and is refused
    this.session = session;
    this.starts.push({ at: nowMs, deviceId });
    // MediaMTX logs the SRT stream id: its log is scrubbed of these for good
    this.d.runtime?.secrets.add(session.pubPass, session.passphrase, session.mixPass);
    try {
      // an earlier session's clean-up must finish first: it clears the shared passphrase and its own user
      await this.cleanup;
      await this.provision(session, api);
    } catch {
      await this.release(session);
      if (this.session === session) this.session = null;
      throw new LiveError(503, 'mediamtx_down', LIVE_MSG.mediamtxDown);
    }

    const warnings: string[] = [];
    let pendingYoutube: (() => void) | null = null;
    try {
      // the phone's video needs the two UDP rules: live still starts without them (the phone records), but says so
      if (isBlocked(await this.checkFirewall())) warnings.push(MEDIA_PORTS_BLOCKED);
      if (req.outputs.youtube) {
        const yt = this.d.youtube;
        if (settings.liveYoutube.enabled !== true) warnings.push('youtube_off');
        else if (!yt || !yt.signedIn()) warnings.push('youtube_not_signed_in');
        else {
          const youtubeMeta: YoutubeMeta = meta ?? { title: Array.from(cleanYoutubeText(`Kuliah ${surauName}`).trim()).slice(0, 100).join('').trim(), description: '', privacy: settings.liveYoutube.privacy };
          const kept = this.takeLingering(req.kuliahId, req.youtubeVia, youtubeMeta.privacy);
          if (kept !== null) {
            // the same kuliah again inside the grace window: the open broadcast and its key carry on
            session.broadcastId = kept.broadcastId;
            session.watchUrl = kept.watchUrl;
            session.youtubeKey = kept.key;
            session.ytPrivacy = youtubeMeta.privacy;
          } else {
            session.ytPrivacy = youtubeMeta.privacy;
            // the broadcast is made after the answer: a sleeping cloud must not delay the phone or the kiosk
            session.ytPending = true;
            pendingYoutube = () => this.createBroadcastLater(session, yt, youtubeMeta, settings.liveYoutube);
          }
        }
      }

      this.startRelay(session, settings.liveYoutube);
      this.audit('live', id, actor, null, {
        kuliahId: session.kuliahId,
        source: session.source,
        outputs: session.outputs,
        youtubeVia: session.youtubeVia,
        broadcastId: session.broadcastId,
        video: session.video,
        audio: session.mix,
      });
      // the no-picture window starts now, when the phone is about to get its ingest URL, not when the session was claimed
      session.lastReadyAtMs = this.d.now().getTime();
      session.unitLastReadyAtMs = session.lastReadyAtMs;
      this.startMonitor();
      this.publishKiosk();
      const answer = this.answer(session, lanHost, warnings);
      pendingYoutube?.();
      return answer;
    } catch (error) {
      // a throw after the claim must not leave a half-open session that blocks every later start
      if (this.session === session) {
        this.session = null;
        this.stopMonitor();
        this.track(this.teardown(session));
        this.publishKiosk();
      }
      throw error;
    }
  }

  /** Creates the broadcast after the start answer; completes it when the session is gone by then, warns when it fails. */
  private createBroadcastLater(s: Session, yt: YoutubeLeg, meta: YoutubeMeta, settings: { relayVideo: unknown; maxBitrateKbps: unknown }): void {
    // not tracked as a whole: a broadcast that never answers must not hold up the box shutdown
    void (async (): Promise<void> => {
      let made: { broadcastId: string; watchUrl: string; key: string };
      try {
        made = await yt.createBroadcastFor({ sessionId: s.id, meta });
      } catch (e) {
        if (this.session === s) {
          s.ytPending = false;
          s.ytWarning = youtubeWarning(e);
        }
        return;
      }
      if (this.session !== s) {
        // the session ended while the broadcast was being made: never leave it open
        this.track(yt.complete(made.broadcastId).catch(() => undefined));
        return;
      }
      s.broadcastId = made.broadcastId;
      s.watchUrl = made.watchUrl;
      s.youtubeKey = made.key;
      s.ytPending = false;
      this.startRelay(s, settings);
    })();
  }

  private answer(s: Session, lanHost: string, warnings: string[]): StartResult {
    const hasKey = s.youtubeKey !== null;
    const result: StartResult = {
      session: { id: s.id, kuliahId: s.kuliahId, source: s.source, outputs: s.outputs, youtubeVia: s.youtubeVia, startedAt: s.startedAt, startedBy: s.startedBy },
      ingest: {
        whip: '/api/live/whip',
        path: s.publishPath,
        srt:
          s.passphrase === null
            ? null
            : { host: lanHost, port: 8890, streamId: `publish:${s.publishPath}:${s.pubUser}:${s.pubPass}`, passphrase: s.passphrase },
      },
      youtube: s.ytPending
        ? { via: s.youtubeVia, ingest: null, key: null, state: 'starting' }
        : !hasKey
        ? null
        : s.youtubeVia === 'device'
          ? { via: 'device', ingest: YOUTUBE_INGEST, key: s.youtubeKey }
          : { via: 'box', ingest: null, key: null },
      kiosk: this.kioskLive(),
    };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  /* ------------------------------------------------------------------ stop */

  /**
   * Ends the session (when `id` is given it must match). Safe to call twice. The session is gone for every
   * caller at once; with `background` the slow clean-up (ffmpeg, MediaMTX users, YouTube) runs after this
   * returns (the HTTP stop answers promptly) and a new start waits for it.
   */
  async stop(id: string | undefined, actor: string, reason = 'stopped', opts: { background?: boolean; emergency?: boolean } = {}): Promise<{ stopped: boolean }> {
    const s = this.session;
    if (s === null || (id !== undefined && id !== s.id)) return { stopped: false };
    // a session still being created is waited for so its credentials are not orphaned
    await this.starting?.catch(() => undefined);
    if (this.session !== s) return { stopped: false };
    this.session = null;
    this.stopMonitor();
    const stoppedMs = this.d.now().getTime();
    this.audit('live', s.id, actor, null, {
      kuliahId: s.kuliahId,
      source: s.source,
      outputs: s.outputs,
      youtubeVia: s.youtubeVia,
      broadcastId: s.broadcastId,
      stoppedAt: new Date(stoppedMs).toISOString(),
      reason,
      ingestSeconds: Math.round(s.ingestMs / 1000),
    });
    // the Pentadbir's override of a live another device started: both actors are on record (plan 4.1, 6)
    if (opts.emergency === true) this.audit('live', 'emergency-stop', actor, null, { sessionId: s.id, startedBy: s.startedBy, stoppedBy: actor });
    // the kiosk goes dark at once; the box clean-up follows
    this.publishKiosk();
    // the broadcast lingers only for a kuliah (a later start of the same kuliah carries on with it); never after an
    // ad-hoc live (two of those are not one recording) and never after an emergency stop (it must end at once)
    const job = this.teardown(s, reason !== 'shutdown' && opts.emergency !== true && s.kuliahId !== null);
    this.track(job);
    if (opts.background !== true) await job;
    return { stopped: true };
  }

  /** Completes the lingering broadcast now (window over, another start, shutdown). Never throws. */
  private endLingering(): Promise<void> {
    const l = this.lingering;
    if (l === null) return Promise.resolve();
    this.lingering = null;
    clearTimeout(l.timer);
    return (this.d.youtube?.complete(l.broadcastId) ?? Promise.resolve()).catch(() => undefined);
  }

  /** The lingering broadcast when this start continues it; any other lingering broadcast is completed. */
  private takeLingering(kuliahId: string | null, via: YoutubeVia, privacy: string): { broadcastId: string; watchUrl: string | null; key: string } | null {
    const l = this.lingering;
    if (l === null) return null;
    if (kuliahId !== null && l.kuliahId === kuliahId && l.via === via && l.privacy === privacy) {
      this.lingering = null;
      clearTimeout(l.timer);
      return l;
    }
    this.track(this.endLingering());
    return null;
  }

  /** Everything slow about ending a session; never throws. `linger`: keep the broadcast open for the grace window. */
  private async teardown(s: Session, linger = false): Promise<void> {
    // the relays go first: ffmpeg must not outlive the credentials it reads with
    const legs = [s.relay, s.audioLeg];
    s.audioLeg = null;
    await Promise.all(legs.map((leg) => leg?.stop().catch(() => undefined)));
    // the combiner too: its ffmpeg reads with the per-session user that is removed next
    await s.combinerOp.catch(() => undefined);
    await this.destroyCombiner(s).catch(() => undefined);
    await this.release(s);
    const grace = this.d.youtubeGraceMs ?? YOUTUBE_GRACE_MS;
    if (linger && grace > 0 && s.broadcastId !== null && s.youtubeKey !== null) {
      this.track(this.endLingering());
      const timer = setTimeout(() => this.track(this.endLingering()), grace);
      timer.unref();
      // a power cut inside the window is covered like one mid-live: the open-broadcast record ends it at the next start
      this.lingering = { kuliahId: s.kuliahId, via: s.youtubeVia, broadcastId: s.broadcastId, watchUrl: s.watchUrl, key: s.youtubeKey, privacy: s.ytPrivacy, timer };
      return;
    }
    if (s.broadcastId !== null) {
      try {
        await this.d.youtube?.complete(s.broadcastId);
      } catch {
        /* the YouTube state shows the error; stopping the local side never waits on the internet */
      }
    }
  }

  /** Removes the per-session MediaMTX user and passphrase and disconnects the publisher. Best effort. */
  private async release(s: Session): Promise<void> {
    const api = this.d.runtime?.api;
    if (!api) return;
    for (const path of new Set([s.publishPath, ...(s.pulled ? [MIC_PATH, IN_PATH] : []), ...(s.combined ? [PATH] : [])])) {
      try {
        const p = await api.pathGet(path);
        if (p.source !== null) await api.kickPublisher(p.source);
      } catch {
        /* MediaMTX may already be gone */
      }
    }
    if (s.pulled) {
      try {
        // the camera address leaves MediaMTX's memory with the session
        await api.pathsPatch(CAM_PATH, { source: 'publisher' });
      } catch {
        console.warn('live: the camera path could not be put back (reason: mediamtx_unreachable)');
      }
    }
    for (const user of s.combined ? [s.pubUser, s.mixUser] : [s.pubUser]) {
      try {
        await api.authUserRemove(user);
      } catch {
        console.warn('live: could not remove a session user (reason: mediamtx_unreachable)');
      }
    }
    await this.frames.sweepStale().catch(() => 0);
    if (s.passphrase !== null) {
      try {
        await api.pathsPatch(s.publishPath, { srtPublishPassphrase: '' });
      } catch {
        /* the user is gone, so the passphrase alone opens nothing */
      }
    }
  }

  /** Stops the session if one is open and the box is closing. */
  async shutdown(): Promise<void> {
    this.stopMonitor();
    await this.stop(undefined, 'system', 'shutdown');
    this.track(this.endLingering());
    await this.cleanup;
  }

  /* ------------------------------------------------------------------ monitor */

  private startMonitor(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.monitorMs);
    this.timer.unref();
  }

  private stopMonitor(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One monitor round: poll MediaMTX, update readiness, end an idle session, announce a changed KioskLive. */
  async tick(): Promise<void> {
    const s = this.session;
    if (s === null || this.ticking) return;
    this.ticking = true;
    try {
      this.refreshFirewall();
      let path: MediamtxPath | null = null;
      try {
        path = (await this.d.runtime?.api?.pathGet(PATH)) ?? null;
      } catch {
        path = null;
      }
      if (this.session !== s) return;
      const nowMs = this.d.now().getTime();
      const ready = path?.ready === true;
      if (ready) {
        if (!s.ready) {
          s.readySince = new Date(nowMs).toISOString();
          s.lastBytes = path!.bytesReceived;
          s.lastBytesAtMs = nowMs;
        } else {
          const dt = nowMs - s.lastBytesAtMs;
          if (dt >= 1000) {
            s.bitrateKbps = Math.max(0, Math.round(((path!.bytesReceived - s.lastBytes) * 8) / dt));
            s.lastBytes = path!.bytesReceived;
            s.lastBytesAtMs = nowMs;
          }
          s.ingestMs += Math.max(0, nowMs - s.lastReadyAtMs);
        }
        s.everReadyAtMs ??= nowMs;
        s.lastReadyAtMs = nowMs;
        s.ingestSource = path!.source;
      } else {
        s.readySince = null;
        s.bitrateKbps = 0;
        s.ingestSource = null;
        if (s.audioLeg?.status().state === 'failed') s.audioRetryArmed = true;
      }
      s.ready = ready;
      // the watchdog: no picture for noVideoMs since the start (or since it vanished); cleared when it returns
      s.noVideo = !ready && nowMs - s.lastReadyAtMs >= this.noVideoMs();
      if (s.combined) {
        await this.pollInputs(s, nowMs);
        this.logMixState(s);
        if (this.session !== s) return;
        if (s.pulled) s.noCamera = !s.ownCamera && !s.unitReady && nowMs - s.unitLastReadyAtMs >= this.noVideoMs();
      }
      // the camera has been gone (or never came) for 10 minutes; a controller that stopped polling for 10 minutes
      if (s.pulled && !s.unitReady && nowMs - s.unitLastReadyAtMs >= this.idleMs) {
        await this.stop(s.id, 'system', 'camera_lost');
        return;
      }
      if (s.pulled && nowMs - s.lastPollAtMs >= this.idleMs) {
        await this.stop(s.id, 'system', 'controller_lost');
        return;
      }
      if (!ready && nowMs - s.lastReadyAtMs >= this.idleMs) {
        await this.stop(s.id, 'system', 'timeout');
        return;
      }
      this.publishKiosk();
    } finally {
      this.ticking = false;
    }
  }

  /** Emits a `live` event when the kiosk-visible state changed (also called when the settings change). */
  publishKiosk(): void {
    this.syncAudioLeg();
    const k = this.kioskLive();
    const text = JSON.stringify(k);
    if (text === this.lastKiosk) return;
    this.lastKiosk = text;
    try {
      this.d.onKiosk(k);
    } catch {
      /* a broken listener never breaks live */
    }
  }

  /* ------------------------------------------------------------------ video source, audio mix, combiner (plan 4.5, 4.6) */

  /** What the start request means: the picture source, the normalised mix and where the box combines. Throws the refusals. */
  private planFor(
    req: LiveStartRequest,
    cam: { enabled: boolean; transport: 'auto' | 'tcp' | 'udp' },
  ): {
    video: LiveVideoSource;
    mix: LiveAudioMix;
    plan: AudioPlan;
    pulled: boolean;
    combined: boolean;
    boxDevice: { deviceName: string; device?: number } | null;
    unit: MixUnit | null;
    publishPath: string;
    cameraHasAudio: boolean;
    transport: 'tcp' | 'udp';
    auto: boolean;
  } {
    const video: LiveVideoSource = req.video ?? 'phone';
    let cameraHasAudio = false;
    const test = this.camera?.lastTest ?? null;
    if (video === 'external') {
      if (cam.enabled !== true) throw new LiveError(409, 'camera_off', LIVE_MSG.cameraOff);
      if ((this.camera?.get() ?? null) === null) throw new LiveError(409, 'camera_not_set', LIVE_MSG.cameraNotSet);
      if (this.cameraBusy?.() === true) throw new LiveError(409, 'camera_test_busy', LIVE_MSG.cameraTestBusy);
      // the box can only decode H.264 (plan 3.3); the phone path decodes H.265 itself
      if (req.source === 'web' && test !== null && (test.code === 'codec' || (test.codecs.some(isH265) && !test.codecs.some(isH264)))) {
        throw new LiveError(409, 'camera_h265', LIVE_MSG.cameraH265);
      }
      cameraHasAudio = test?.hasAudio ?? true;
    }
    const boxDevice = this.d.boxInput?.() ?? null;
    const caps = this.capsFor(req.source, cameraHasAudio, boxDevice);
    const mix = normaliseAudioMix(video, req.audio, caps);
    const plan = audioPlanOf(video, mix, caps);
    const pulled = video === 'external' && req.source === 'web';
    const combined = pulled || plan.added.includes('boxInput');
    return {
      video,
      mix,
      plan,
      pulled,
      combined,
      boxDevice,
      unit: pulled ? 'camera' : combined ? 'ingest' : null,
      publishPath: pulled ? MIC_PATH : combined ? IN_PATH : PATH,
      cameraHasAudio,
      transport: cam.transport === 'udp' ? 'udp' : cam.transport === 'tcp' ? 'tcp' : (test?.transport ?? 'tcp'),
      auto: cam.transport === 'auto',
    };
  }

  private capsFor(runner: LiveSource, cameraHasAudio: boolean, boxDevice: Session['boxDevice']): AudioCaps {
    return { cameraHasAudio, deviceMic: true, boxInput: boxDevice !== null, runner };
  }

  /** The camera showed or lost its audio track: the mix and the plan follow. */
  private replan(s: Session): void {
    const caps = this.capsFor(s.source, s.cameraHasAudio, s.boxDevice);
    s.mix = normaliseAudioMix(s.video, s.mix, caps);
    s.plan = audioPlanOf(s.video, s.mix, caps);
  }

  /** How the unit enters the graph. An ingest unit (a device's own stream) always carries sound: the box mutes it for "Mic-in only". */
  private unitCfg(s: Session): { unit: MixUnit; unitHasAudio: boolean; unitVolume: number } {
    if (s.unit === 'camera') {
      const has = s.plan.reference === 'camera';
      return { unit: 'camera', unitHasAudio: has, unitVolume: has ? s.mix.camera.volume : 0 };
    }
    // a track the stream carries is always consumed (volume 0 when nothing phone-side is audible); the silent source only when it has none
    const phoneSide = this.phoneSide(s);
    return { unit: 'ingest', unitHasAudio: !s.ingestNoAudio, unitVolume: !s.ingestNoAudio && phoneSide.some((m) => m.enabled && m.volume > 0) ? 100 : 0 };
  }

  /** The sources the phone mixes into its own stream (the box never reads `surau-mic` for an ingest unit). */
  private phoneSide(s: Session): LiveAudioMix[keyof LiveAudioMix][] {
    return s.video === 'external' ? [s.mix.camera, s.mix.deviceMic] : [s.mix.deviceMic];
  }

  /** An ingest unit that carries no reference sound: nothing phone-side is on, or its tracks hold no audio. */
  private ingestSilent(s: Session): boolean {
    return s.unit === 'ingest' && (s.ingestNoAudio || !this.phoneSide(s).some((m) => m.enabled));
  }

  private alignMode(s: Session, added: AddedAudioId[]): 'auto' | 'manual' | 'none' {
    if (added.length === 0) return 'none';
    if (s.unit === 'ingest') return this.ingestSilent(s) ? 'manual' : 'auto';
    return s.plan.align === 'manual' ? 'manual' : 'auto';
  }

  /** One line per change of the combiner's state (never an address, a login or the error text of ffmpeg). */
  private logMixState(s: Session): void {
    const st = s.mixer?.status().state ?? 'off';
    if (st === s.mixLogged) return;
    s.mixLogged = st;
    if (st === 'failed' || st === 'retrying') console.warn(`live: the combiner is ${st}`);
  }

  /** Reads the unit and the added microphone from MediaMTX, then lets the combiner follow. */
  private async pollInputs(s: Session, nowMs: number): Promise<void> {
    const api = this.d.runtime?.api;
    if (!api || s.unit === null) return;
    let unit: MediamtxPath;
    let mic: MediamtxPath | null = null;
    try {
      unit = await api.pathGet(s.unit === 'camera' ? CAM_PATH : IN_PATH);
      if (s.pulled && s.unit === 'camera' && s.plan.added.includes('deviceMic')) mic = await api.pathGet(MIC_PATH);
    } catch {
      return; // MediaMTX did not answer: keep what is known
    }
    if (this.session !== s) return;
    s.unitReady = unit.ready;
    if (unit.ready) {
      s.unitEverReady = true;
      s.unitLastReadyAtMs = nowMs;
      s.unitReadySinceMs ??= nowMs;
    } else {
      s.unitReadySinceMs = null;
    }
    // the tracks of the pulled camera say whether it has sound (the last test only guesses)
    if (s.pulled && s.unit === 'camera' && unit.ready && unit.tracks.length > 0) {
      const has = unit.tracks.some((t) => !isVideoTrack(t));
      if (has !== s.cameraHasAudio) {
        s.cameraHasAudio = has;
        this.replan(s);
      }
    }
    // the tracks of a device's own stream: a picture without sound uses the silent reference (a tracks list that is still empty says nothing)
    if (s.unit === 'ingest' && unit.ready && unit.tracks.length > 0) s.ingestNoAudio = !unit.tracks.some((t) => !isVideoTrack(t));
    if (mic !== null) {
      s.micReady = mic.ready;
      if (mic.ready) {
        s.micEverReady = true;
        s.micReadySinceMs ??= nowMs;
        s.micLostSinceMs = null;
      } else {
        s.micReadySinceMs = null;
        s.micLostSinceMs ??= nowMs;
      }
    }
    // Automatik: TCP first, then UDP when no picture comes (and back again; a camera that never answered keeps being tried)
    if (s.pulled && s.unit === 'camera' && !unit.ready && s.camAuto && nowMs - s.camPatchedAtMs >= this.timing.transportSwitchMs) {
      try {
        await this.patchCamera(s, api, s.camTransport === 'tcp' ? 'udp' : 'tcp');
      } catch {
        /* the next poll tries again */
      }
    }
    await this.reconcile(s, nowMs);
  }

  /** Brings the combiner in line with the unit, the microphone and the plan. Serialised: two ffmpeg never publish together. */
  private reconcile(s: Session, nowMs: number): Promise<void> {
    const run = s.combinerOp.then(
      () => this.reconcileNow(s, nowMs),
      () => this.reconcileNow(s, nowMs),
    );
    s.combinerOp = run.catch(() => undefined);
    return run;
  }

  private async reconcileNow(s: Session, nowMs: number): Promise<void> {
    if (this.session !== s || !s.combined) return;
    if (!s.unitReady) {
      // the camera is gone: the combiner waits (its ffmpeg would only retry against a path that is not there)
      if (s.mixer !== null) await this.destroyCombiner(s);
      return;
    }
    const wantMic = s.pulled && s.unit === 'camera' && s.plan.added.includes('deviceMic');
    let micIn = s.graphAdded.has('deviceMic');
    if (s.mixer === null) {
      // the first start waits a little for the iPad microphone, then goes on without it
      if (wantMic && !s.micReady && s.unitReadySinceMs !== null && nowMs - s.unitReadySinceMs < this.timing.micWaitMs) return;
      micIn = wantMic && s.micReady;
    } else if (!wantMic) {
      micIn = false;
    } else if (micIn && !s.micReady && s.micLostSinceMs !== null && nowMs - s.micLostSinceMs >= this.timing.micLostMs) {
      micIn = false; // a stalled input must never stall the picture
    } else if (!micIn && s.micReady && s.micReadySinceMs !== null && nowMs - s.micReadySinceMs >= this.timing.micSteadyMs) {
      micIn = true; // steady again: added back, held out until the next lock
    }
    // the added microphone is read from `surau-mic` only when the box pulls the camera; an ingest unit's phone mic is phone-side
    // Mic-in needs the device captured at the start: without it the input is left out (a status warning says so), never a throw
    const added = s.plan.added.filter((id) => (id !== 'deviceMic' || (s.pulled && s.unit === 'camera' && micIn)) && (id !== 'boxInput' || s.boxDevice !== null));
    const cfg = this.unitCfg(s);
    const sig = `${cfg.unit}|${cfg.unitHasAudio ? 1 : 0}|${added.join(',')}|${this.alignMode(s, added)}`;
    if (s.mixer !== null && sig === s.graphSig) return;
    await this.destroyCombiner(s);
    if (this.session !== s || !s.unitReady) return;
    this.buildCombiner(s, cfg, added, sig);
  }

  private buildCombiner(s: Session, cfg: { unit: MixUnit; unitHasAudio: boolean; unitVolume: number }, added: AddedAudioId[], sig: string): void {
    const rt = this.d.runtime;
    const ffmpegPath = this.d.mixOptions?.ffmpegPath ?? rt?.tools.ffmpeg ?? null;
    if (ffmpegPath === null) return;
    const mode = this.alignMode(s, added);
    const headroom = this.timing.headroomMs;
    const win = process.platform === 'win32';
    const input = added.includes('boxInput') ? s.boxDevice : null;
    const mixer = (this.d.mixerFactory ?? ((o: MixerOptions) => new Mixer(o)))({
      ffmpegPath,
      platform: win ? 'windows' : 'android',
      headroomMs: headroom,
      rtspUser: s.mixUser,
      rtspPass: s.mixPass,
      ...(win ? { zmqPortFn: () => randomInt(20000, 40000) } : {}),
      ...(input !== null ? { deviceName: input.deviceName, ...(input.device !== undefined ? { device: input.device } : {}) } : {}),
      // the camera can be gone for minutes: keep retrying with short pauses, never give up
      backoffMaxMs: 5000,
      maxFailures: 1_000_000,
      ...(this.d.mixOptions ?? {}),
    });
    s.mixer = mixer;
    s.graphAdded = new Set(added);
    s.graphSig = sig;
    s.applied = new Map();
    s.alignStates = new Map();
    s.appliedUnit = cfg.unitVolume;
    const audible = cfg.unitHasAudio && cfg.unitVolume > 0;
    const initial = (id: AddedAudioId): number => (mode === 'manual' ? headroom + this.settingsOffset(id, s) : DEFAULT_INITIAL_DELAY_MS);
    // an added source starts held out of the mix (volume 0 in the graph) while the reference is audible, until it locks
    for (const id of added) {
      const held = audible && mode !== 'manual';
      s.applied.set(id, held ? 0 : s.mix[id].volume);
      s.alignStates.set(id, mode === 'manual' ? 'manual' : 'searching');
    }
    let aligner: AlignerLike | null = null;
    if (added.length > 0) {
      aligner = (this.d.alignerFactory ?? ((o: AlignerOptions) => new Aligner(o)))({
        monitor: mixer.monitor,
        added,
        sampleRate: MONITOR_RATE,
        maxLagMs: headroom + 2000,
        initialDelayMs: DEFAULT_INITIAL_DELAY_MS,
        apply: (id, ms) => void mixer.setDelay(id, ms),
        onState: (id, st) => this.onAlignState(s, mixer, id, st),
      });
    }
    s.aligner = aligner;
    mixer.start({
      unit: cfg.unit,
      unitHasAudio: cfg.unitHasAudio,
      unitVolume: cfg.unitVolume,
      added: added.map((id) => ({ id, initialDelayMs: initial(id), volume: s.mix[id].volume })),
    });
    aligner?.start();
    const meter = new LevelMeter([cfg.unit === 'camera' ? 'camera' : 'deviceMic', ...added], MONITOR_RATE, () => this.d.now().getTime());
    const onData = (chunk: Buffer): void => meter.feed(chunk);
    const onRestart = (): void => meter.reset();
    mixer.monitor.on('data', onData);
    mixer.monitor.on('restart', onRestart);
    s.meter = meter;
    s.meterOff = (): void => {
      mixer.monitor.off('data', onData);
      mixer.monitor.off('restart', onRestart);
    };
    if (mode === 'manual') for (const id of added) aligner?.setManual(id);
  }

  /** The fixed fallback offset of an added source (a unit with no audio track), 0 to 2000 ms. */
  private settingsOffset(id: AddedAudioId, s?: Session): number {
    if (id === 'deviceMic' && s?.offsetMs != null) return s.offsetMs;
    const v = getSettings(this.d.db, LOCAL_SURAU_ID).liveCamera?.avOffsetMs?.[id];
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(2000, Math.max(0, Math.round(v))) : 0;
  }

  private async destroyCombiner(s: Session): Promise<void> {
    for (const timers of s.fades.values()) for (const t of timers) clearTimeout(t);
    s.fades.clear();
    const mixer = s.mixer;
    const aligner = s.aligner;
    s.mixer = null;
    s.aligner = null;
    s.graphAdded = new Set();
    s.graphSig = '';
    s.meterOff?.();
    s.meter = null;
    s.meterOff = null;
    aligner?.stop();
    await mixer?.stop().catch(() => undefined);
  }

  /** An alignment state changed: a lock lets the source in (a fade), a new search holds it out again while the reference plays. */
  private onAlignState(s: Session, mixer: MixerLike, id: AddedAudioId, st: AlignState): void {
    if (s.mixer !== mixer) return; // a combiner that was replaced
    s.alignStates.set(id, st);
    this.syncVolumes(s, true);
  }

  /**
   * The volume every added source should have now. Held out (0) while the reference is audible and the source is not
   * aligned; otherwise the user's volume. Rising from 0 after a lock is a short fade, anything else is at once.
   */
  private syncVolumes(s: Session, fade: boolean): void {
    const mixer = s.mixer;
    if (mixer === null) return;
    const cfg = this.unitCfg(s);
    if (cfg.unitVolume !== s.appliedUnit) {
      s.appliedUnit = cfg.unitVolume;
      void mixer.setVolume('unit', cfg.unitVolume);
    }
    const audible = cfg.unitHasAudio && cfg.unitVolume > 0;
    for (const id of s.graphAdded) {
      const st = s.alignStates.get(id) ?? 'searching';
      const held = audible && st !== 'locked' && st !== 'holding' && st !== 'manual';
      const target = held ? 0 : s.mix[id].volume;
      const prev = s.applied.get(id) ?? 0;
      if (target === prev) continue;
      for (const t of s.fades.get(id) ?? []) clearTimeout(t);
      s.fades.delete(id);
      s.applied.set(id, target);
      const { fadeMs, fadeSteps } = this.timing;
      if (fade && prev === 0 && target > 0 && fadeMs > 0 && fadeSteps > 1) {
        const timers: NodeJS.Timeout[] = [];
        for (let k = 1; k <= fadeSteps; k++) {
          const step = k === fadeSteps ? target : Math.round((target * k) / fadeSteps);
          const t = setTimeout(
            () => {
              if (s.mixer === mixer) void mixer.setVolume(id, step);
            },
            Math.round((fadeMs * (k - 1)) / (fadeSteps - 1)),
          );
          t.unref();
          timers.push(t);
        }
        s.fades.set(id, timers);
      } else {
        void mixer.setVolume(id, target);
      }
    }
  }

  /**
   * `POST /api/live/audio`: the starting device changes the mix. A volume is a run-time command; a different set of sources restarts the combiner.
   * Optional `video` (box-pulled live only): `phone` makes the iPad's own camera the unit, `external` goes back to the camera.
   * Optional `avOffsetMs`: the hand-set offset of the added microphone (a camera without sound).
   */
  async changeAudio(deviceId: string, body: unknown): Promise<LiveStatus> {
    const s = this.session;
    if (s === null) throw new LiveError(409, 'no_session', LIVE_MSG.noSession);
    if (s.deviceId !== deviceId) throw new LiveError(403, 'not_owner', LIVE_MSG.forbidden);
    const audio = isRecord(body) ? body.audio : undefined;
    if (!isRecord(audio)) throw new LiveError(400, 'bad_request', LIVE_MSG.badRequest);
    const askedVideo = isRecord(body) ? body.video : undefined;
    if (askedVideo !== undefined && askedVideo !== 'phone' && askedVideo !== 'external') throw new LiveError(400, 'bad_request', LIVE_MSG.badRequest);
    const askedOffset = isRecord(body) ? body.avOffsetMs : undefined;
    if (askedOffset !== undefined && (typeof askedOffset !== 'number' || !Number.isInteger(askedOffset) || askedOffset < 0 || askedOffset > 2000 || askedOffset % 50 !== 0)) {
      throw new LiveError(400, 'bad_request', LIVE_MSG.badRequest);
    }
    const switching = askedVideo !== undefined && askedVideo !== s.video;
    // only a live that the box pulls can switch between the camera and the iPad's own camera
    if (switching && !s.pulled) throw new LiveError(409, 'audio_unsupported', LIVE_MSG.audioUnsupported);
    const video: LiveVideoSource = switching ? askedVideo : s.video;
    const boxDevice = this.d.boxInput?.() ?? null;
    const caps = this.capsFor(s.source, s.cameraHasAudio, boxDevice);
    const mix = normaliseAudioMix(video, audio, caps);
    const plan = audioPlanOf(video, mix, caps);
    if (!s.combined) {
      // a phone mixes for itself; the box only needs Mic-in to stay as it was at the start
      if (plan.added.includes('boxInput') !== s.plan.added.includes('boxInput')) throw new LiveError(409, 'audio_unsupported', LIVE_MSG.audioUnsupported);
      s.mix = mix;
      s.plan = plan;
      s.reportAudio = true;
      return this.status();
    }
    if (plan.added.includes('boxInput') && boxDevice !== null) s.boxDevice = boxDevice;
    if (switching) await this.switchVideo(s, video);
    if (askedOffset !== undefined) s.offsetMs = askedOffset;
    s.mix = mix;
    s.plan = plan;
    s.reportAudio = true;
    if (switching) await this.pollInputs(s, this.d.now().getTime());
    else await this.reconcile(s, this.d.now().getTime());
    if (askedOffset !== undefined && !switching) this.applyOffset(s);
    this.syncVolumes(s, false);
    return this.status();
  }

  /** The unit moves between the pulled camera (`surau-cam`, iPad mic on `surau-mic`) and the iPad's own stream (`surau-in`). */
  private async switchVideo(s: Session, video: LiveVideoSource): Promise<void> {
    const api = this.d.runtime?.api;
    const old = s.publishPath;
    s.video = video;
    s.ownCamera = video === 'phone';
    s.unit = s.ownCamera ? 'ingest' : 'camera';
    s.publishPath = s.ownCamera ? IN_PATH : MIC_PATH;
    s.unitReady = false;
    // the iPad's own camera has not shown yet: no camera waiting card, no camera warning for it
    if (s.ownCamera) s.unitEverReady = false;
    s.unitReadySinceMs = null;
    s.unitLastReadyAtMs = this.d.now().getTime();
    s.micReady = false;
    s.micEverReady = false;
    s.micReadySinceMs = null;
    s.micLostSinceMs = null;
    if (!api) return;
    try {
      // the publisher may now publish to the new path only; the old connection is dropped (the device ends its own leg too)
      await api.authUserAdd({ user: s.pubUser, pass: s.pubPass, permissions: [{ action: 'publish', path: s.publishPath }] });
      const p = await api.pathGet(old);
      if (p.source !== null) await api.kickPublisher(p.source);
    } catch {
      /* the next poll and the device's own retry carry on */
    }
  }

  /** A new hand-set offset reaches the running combiner as the added microphone's delay (headroom + offset). */
  private applyOffset(s: Session): void {
    const mixer = s.mixer;
    if (mixer === null || !s.graphAdded.has('deviceMic') || this.alignMode(s, [...s.graphAdded]) !== 'manual') return;
    void mixer.setDelay('deviceMic', this.timing.headroomMs + this.settingsOffset('deviceMic', s));
  }

  /** Per-source health of the mix as the box knows it (plan 4.7). Never holds a camera address or login. */
  private audioStatus(s: Session): LiveAudioSourceStatus[] {
    const out: LiveAudioSourceStatus[] = [];
    for (const id of ['camera', 'deviceMic', 'boxInput'] as const) {
      const m = s.mix[id];
      if (!m.enabled) continue;
      const added = id !== 'camera' && s.plan.added.includes(id);
      let state: LiveAudioSourceStatus['state'] = m.volume === 0 ? 'silent' : 'ok';
      if (id === 'boxInput' && added && s.combined && s.boxDevice === null) state = 'lost';
      if (s.pulled && id === 'camera' && !s.unitReady && s.unitEverReady) state = 'lost';
      if (s.pulled && id === 'deviceMic' && added && !s.graphAdded.has('deviceMic') && s.graphSig !== '') {
        // out of the graph: lost once it has been heard, or once the combiner started without waiting for it any longer
        const waited = s.unitReadySinceMs !== null && this.d.now().getTime() - s.unitReadySinceMs >= this.timing.micWaitMs;
        if (s.micEverReady || waited) state = 'lost';
      }
      const row: LiveAudioSourceStatus = { id, enabled: true, volume: m.volume, state };
      const ch = s.meter?.channelOf(id) ?? -1;
      const level = ch >= 0 ? s.meter?.level(ch) : undefined;
      if (level !== undefined) row.level = level;
      if (added && s.combined) {
        const mode = this.alignMode(s, s.plan.added);
        const inGraph = s.graphAdded.has(id);
        const delayMs = mode === 'manual' ? this.timing.headroomMs + this.settingsOffset(id, s) : (s.aligner?.delayMs(id) ?? DEFAULT_INITIAL_DELAY_MS);
        const alignState: AlignState = mode === 'manual' ? 'manual' : inGraph ? (s.aligner?.state(id) ?? 'searching') : 'searching';
        const residual = inGraph ? s.aligner?.residualMs(id) : undefined;
        row.align = { state: alignState, delayMs, ...(residual !== undefined ? { residualMs: residual } : {}) };
      }
      out.push(row);
    }
    return out;
  }

  /* ------------------------------------------------------------------ audit */

  private audit(entity: string, entityId: string, actor: string, before: unknown, after: Record<string, unknown>): void {
    this.d.db
      .prepare('INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(this.d.now().toISOString(), actor, entity, entityId, before === null ? null : JSON.stringify(before), JSON.stringify(after));
  }
}
