import { LOCAL_SURAU_ID } from '../tenant.ts';
import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Readable } from 'node:stream';
import { SOLO_DEFAULT_DELAY_MS, SOLO_PRIORITY, applyTvProfileToLive, audioPlanOf, isTvId, cleanYoutubeText, klDateOf, klInstant, normaliseAudioMix, parseLiveStartOptions, tvProfileFor, videoPathOf, youtubeMetaFor } from '@surau/core';
import type {
  AddedAudioId,
  AlignState,
  AudioCaps,
  AudioPlan,
  KioskLive,
  LiveAudioMix,
  LiveAudioSourceStatus,
  LiveCameraUse,
  LiveOutputs,
  LiveSessionSummary,
  LiveSource,
  LiveStartRequest,
  LiveStatus,
  LiveVideoPath,
  LiveVideoSource,
  YoutubeMeta,
  YoutubeVia,
} from '@surau/core';
import { randomToken } from '../auth/crypto.ts';
import { getItem } from '../content/store.ts';
import { getSettings, putFeature } from '../settingsStore.ts';
import { Aligner, DEFAULT_INITIAL_DELAY_MS } from './align.ts';
import type { AlignerOptions } from './align.ts';
import { cameraPullUrl, cameraSecrets } from './camera.ts';
import { EncoderCapability } from './encoder.ts';
import type { EncoderProbe } from './encoder.ts';
import { LevellerCapability } from './levellerProbe.ts';
import type { LevellerProbe } from './levellerProbe.ts';
import type { CameraRecord, CameraTestResult } from './camera.ts';
import type { FirewallState } from './firewall.ts';
import type { LiveRuntime, MediamtxPath } from './mediamtx.ts';
import { BOX_MIC_SILENT_DB, BOX_MIC_SOUND_DB, LevelMeter } from './levels.ts';
import { CpuSampler } from './cpu.ts';
import { NULL_LIVE_LOG } from './liveLog.ts';
import type { LiveLogFields, LiveLogLike } from './liveLog.ts';
import { MONITOR_RATE, Mixer } from './mixer.ts';
import { youtubeErrorCode } from './youtube/oauth.ts';
import type { YoutubeReason } from './youtube/oauth.ts';
import type { MixerOptions, MixerStartConfig, MixerStatus, MixUnit, VolumeTarget } from './mixer.ts';
import { KIOSK_AUDIO_PATH, Relay } from './relay.ts';
import { QualityLadder } from './qualityLadder.ts';
import { probeLowEncoder } from './lowEncoder.ts';
import { SOLO_MAX_DELAY_MS, SOUND_PATHS, SoloCombiner } from './soloCombiner.ts';
import type { SoloCombinerOptions } from './soloCombiner.ts';
import type { LowEncoder, RelayBrightness, RelayStartOptions } from './relay.ts';
import { resolveDay } from '../prayer/resolve.ts';
import { FrameGrabber } from './noticeFrame.ts';
import type { RelayOptions } from './relay.ts';
import type { LiveSessionStore } from './sessionStore.ts';
import { mergedGapSeconds } from './sessionStore.ts';

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
  resumeMismatch: 'Siaran yang sedang berjalan tidak sama dengan permintaan ini',
  cameraInUse: 'Kamera sedang digunakan untuk siaran. Sertai gambar siaran melalui MAXCOM.',
  cameraH265Box: 'Kamera H.265 tidak boleh ditarik oleh MAXCOM. Tukar kamera kepada H.264, atau biar telefon yang menarik kamera.',
  tooManyJoined: 'Terlalu banyak peranti sedang melihat gambar siaran',
  ytSignoutLinger: 'Siaran YouTube baru sahaja tamat dan masih terbuka. Cuba log keluar selepas beberapa minit.',
  ytAlreadyOn: 'YouTube sudah dihidupkan untuk siaran ini',
  ytStartBusy: 'YouTube sedang disediakan untuk siaran ini. Cuba lagi sebentar lagi.',
  ytNotSignedIn: 'Log masuk YouTube diperlukan di MAXCOM',
  ytOffSetting: 'Siaran YouTube dimatikan di Tetapan',
  ytFailed: 'Siaran YouTube tidak dapat disediakan sekarang',
  previewOff: 'Gambar siaran tidak dipaparkan pada peranti ini. Lihat pada TV atau YouTube.',
  noDestination: 'Pilih sekurang-kurangnya satu destinasi',
  lastOutput: 'Destinasi terakhir tidak boleh dimatikan semasa siaran berjalan',
  unknownTv: 'TV tidak dijumpai',
} as const;

/** S1: how open a YouTube visibility is. */
const PRIVACY_RANK: Record<string, number> = { private: 0, unlisted: 1, public: 2 };
/** S8: attempts of `youtube/start` per device per rolling hour. */
const YT_START_MAX_PER_DEVICE = 6;
/** Start limiter: rolling hour. */
const START_WINDOW_MS = 3_600_000;
const START_MAX_PER_DEVICE = 6;
const START_MAX_PER_BOX = 12;
/**
 * S6: the limits above count only lives that reached the box with a picture (a stop and start again on flaky Wi-Fi
 * that never got as far is not a live). Every start request still has a ceiling of its own, so a device cannot make
 * the box create sessions and YouTube broadcasts without end.
 */
const ATTEMPT_MAX_PER_DEVICE = 30;
const ATTEMPT_MAX_PER_BOX = 60;
/** S1: no picture AND no status poll of the starting device for this long ends any session with `controller_lost`. */
const ORPHAN_MS = 90_000;
/** D3: after the picture of a device's own stream vanishes the TV holds the last picture with the waiting card this long. */
const WAITING_MS = 60_000;
/** The one camera record of a box (see `LiveCameraUse.cameraId`). */
export const CAMERA_ID = 'external';
/** How many other devices may watch the shared picture of a live that holds the camera (each with one viewer). */
const MAX_JOINED_DEVICES = 4;
/** Q5: a joined device that neither opened or closed a viewer nor polled the status for this long has gone away: its slot is free (the TTL of the TV viewers). */
export const JOINED_TTL_MS = 30 * 60 * 1000;
/** C3: the pulled camera sends this much more than the configured maximum before the copy relay warns. */
const BITRATE_WARN_FACTOR = 1.2;
/** Y2: a YouTube relay that gave up is tried again this long after it failed while the picture is there (the internet came back). */
const RELAY_REVIVE_MS = 60_000;
/** S8: a new start waits this long at most for the clean-up of earlier sessions (a YouTube call or a process that hangs). */
const CLEANUP_WAIT_MS = 20_000;
/** A3: no status poll of the starting device for this long shows `controller_quiet` (a box-pulled live never ends by itself). */
const CONTROLLER_QUIET_MS = 600_000;
/** A16: the camera's own bitrate is averaged over this window; no verdict before `CAM_MIN_SPAN_MS` of samples. */
const CAM_WINDOW_MS = 30_000;
const CAM_MIN_SPAN_MS = 20_000;
/** A16: warn above maximum x 1.2, clear below maximum x 1.05. */
const CAM_CLEAR_FACTOR = 1.05;
/** A19: the camera is slow under 25 percent of its own running level and normal again from 40 percent; the level follows over about 5 minutes and ignores a slow stretch. */
const CAM_SLOW_RATIO = 0.25;
const CAM_SLOW_CLEAR_RATIO = 0.4;
const CAM_LEVEL_TAU_MS = 300_000;
/** A19: a running level under this (kbps) is a still scene, not a verdict. */
const CAM_LEVEL_FLOOR_KBPS = 150;
/** A7: the output watchdog: no output for this long, a combiner at least this old, a kick at most this often. */
const OUTPUT_STALL_MS = 15_000;
const COMBINER_MIN_AGE_MS = 35_000;
const KICK_MIN_GAP_MS = 35_000;
/** A8: two stalls inside this window bench the box microphone for `BENCH_MS`. */
const STALL_WINDOW_MS = 120_000;
const BENCH_MS = 60_000;
/** Gate fix B2: the bench time of the n-th bench of a source in one live (0-based): 60 s, 120 s, 240 s, then 300 s. */
const BENCH_STEPS_MS = [60_000, 120_000, 240_000, 300_000];
const benchMsFor = (n: number): number => BENCH_STEPS_MS[Math.min(n, BENCH_STEPS_MS.length - 1)]!;
/** B3: a stall only points at the capture device when the unit's own bytes grew this recently (the camera is fine). */
const UNIT_GROW_FRESH_MS = 12_000;
/** Build 5: the box microphone is silent after this long at or under `BOX_MIC_SILENT_DB`, and heard again after this long at or above `BOX_MIC_SOUND_DB`. */
const BOX_MIC_SILENT_MS = 60_000;
const BOX_MIC_SOUND_MS = 3_000;
/** Build 5: CPU above `BUSY_ON_PERCENT` for `BUSY_SPAN_MS` (the window is 30 s; a little slack for the tick) is busy; the average under `BUSY_OFF_PERCENT` clears it. */
const BUSY_ON_PERCENT = 85;
const BUSY_OFF_PERCENT = 75;
const BUSY_SPAN_MS = 28_000;
/** A21: the AAC rendition of the combined mix, read by the YouTube relay. */
const YT_PATH = 'surau-yt';
export const CAMERA_BITRATE_HIGH = 'camera_bitrate_high';
export const CAMERA_SLOW = 'camera_slow';
export const CONTROLLER_QUIET = 'controller_quiet';
export const CAMERA_H265 = 'camera_h265';
export const KIOSK_RESTORED = 'kiosk_restored';
export const BOX_MIC_SILENT = 'box_mic_silent';
export const SERVER_BUSY = 'server_busy';
export const BOX_MIC_DROPS = 'box_mic_drops';
export const UPLOAD_BEHIND = 'upload_behind';
export const QUALITY_LOWERED = 'quality_lowered';
/** B6: the YouTube leg shows `upload_behind` from this many seconds behind real time. */
const UPLOAD_BEHIND_S = 4;
/** B6: ffmpeg reports 0.99x on a healthy run, so the ladder gives the low step up only below this speed. */
const LADDER_SLOW_SPEED = 0.9;
/** Gate fix B5: a low step whose relay is not running for this long gave up. */
const LOW_FAIL_MS = 15_000;

/** Gate fix B8: the restarts of a relay that were not planned quality changes. */
function unplannedRestarts(r: { restarts: number; plannedRestarts?: number }): number {
  return Math.max(0, r.restarts - (typeof r.plannedRestarts === 'number' ? r.plannedRestarts : 0));
}

/** The host of a camera address (`rtsp://login@host:554/path`), brackets of an IPv6 host removed; null when there is none. */
function cameraHost(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url === '') return null;
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h.length >= 3 ? h : null;
  } catch {
    return null;
  }
}

/** The YouTube reasons a live start shows as their own warning; any other failure reads as `no_internet`. */
const YOUTUBE_WARNING_REASONS: readonly YoutubeReason[] = ['quota', 'reauthorise', 'forbidden', 'clock_wrong', 'live_not_enabled', 'client_refused', 'busy_other_box'];

/** The warning code the app shows for a YouTube failure (the reason is a fixed vocabulary, never Google's text). */
function youtubeWarning(e: unknown): string {
  const reason = typeof e === 'object' && e !== null ? (e as { reason?: unknown }).reason : undefined;
  // the box's YouTube leg goes through the cloud (Plan 6): the cloud itself could not be reached
  if (reason === 'cloud_unreachable') return 'cloud_unreachable';
  // the reasons the app has a sentence for, by the YouTube lane's own code table (Y9, Y11 included)
  if (typeof reason === 'string' && (YOUTUBE_WARNING_REASONS as readonly string[]).includes(reason)) return youtubeErrorCode(reason as YoutubeReason);
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
  /** Test hook: replaces the low-quality encoder probe of the YouTube ladder (default: `probeLowEncoder`, run once per instance). A failure counts as null. */
  lowEncoderProbe?: (ffmpegPath: string) => Promise<LowEncoder | null>;
  /** Test hook: replaces the YouTube relay (a stand-in with the Relay methods). */
  relayFactory?: (o: RelayOptions) => Relay;
  /** Test hook: replaces the H.264 encoder probe (default: runs `ffmpeg -h encoder=libx264` once per ffmpeg path). */
  encoderProbe?: EncoderProbe;
  /** Test hook: replaces the compand/alimiter probe of the mixer's leveller (default: `ffmpeg -h filter=...` once per ffmpeg path). */
  levellerProbe?: LevellerProbe;
  /** Pause between tries to set the publisher user and passphrase again after a MediaMTX respawn (default 500). */
  reprovisionMs?: number;
  /** The saved external camera (B1); also set later with `attachCamera`. Only the box reads the full address. */
  camera?: CameraSource | null;
  /** The box's capture device for "Mic-in pada kotak" (M1); null or absent: not available. */
  boxInput?: () => { deviceName: string; device?: number } | null;
  /** Resolves when no microphone probe or test runs any more; a start awaits it before the combiner opens the box microphone. */
  audioIdle?: () => Promise<void>;
  /** Test hooks: replace the combiner and the aligner. */
  mixerFactory?: (o: MixerOptions) => MixerLike;
  /** Test hook: replaces the solo sound path (build 6: one microphone in its own process, joined to the picture by remux). Absent, `mixerFactory` (when given) stands in for it. */
  soloFactory?: (o: SoloCombinerOptions) => SoloLike;
  alignerFactory?: (o: AlignerOptions) => AlignerLike;
  /** Test hook: extra options of every combiner (an ffmpeg stand-in, say). */
  mixOptions?: Partial<MixerOptions>;
  /** Combiner timings (plan 4.6); the defaults are the plan's. */
  combiner?: Partial<CombinerTimings>;
  /** The persisted record of the lives (table `live_sessions`); without it nothing is recorded. */
  store?: LiveSessionStore | null;
  /** This box's id, for the record. */
  boxId?: string;
  /** No picture and no owner poll for this long ends the session with `controller_lost` (default 90 s). */
  orphanMs?: number;
  /** How long the TV holds the last picture of a device's own stream after it vanished (default 60 s). */
  waitingMs?: number;
  /** How long a start waits for the clean-up of earlier sessions before it goes on (default 20 s). */
  cleanupWaitMs?: number;
  /** The box live log (C2); default: nothing is written. */
  liveLog?: LiveLogLike;
  /** Controller quiet notice after this long without a status poll of the starting device (default 10 min). */
  controllerQuietMs?: number;
  /** Build 5: the CPU reader (a test stand-in); default: `os.cpus()`. */
  cpu?: CpuSampler;
  /** Build 5: this box's own name, the name of the box's own TV in the viewer list when its profile has none. */
  boxName?: () => string | null;
  /** Called (not awaited) when a live that uses the external camera starts; the box sends the camera profile there. Never throws. */
  onExternalCameraLive?: () => void;
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
  /** Ends the current run and relaunches at once (the output watchdog). */
  kick(reason: string): void;
  status(): MixerStatus;
}

/** The solo sound path (SoloCombiner): a combiner that also counts the box microphone's dropped frames. */
export interface SoloLike extends MixerLike {
  /** dshow "frame dropped" lines in the last 30 s. */
  drops(): number;
}

/** The slice of Aligner the sessions use. */
export interface AlignerLike {
  start(): void;
  stop(): void;
  state(id: AddedAudioId): AlignState;
  delayMs(id: AddedAudioId): number;
  residualMs(id: AddedAudioId): number | undefined;
  setManual(id: AddedAudioId): void;
  /** Back from a hand-set offset: searching again, starting at this delay. */
  setAuto(id: AddedAudioId, delayMs: number): void;
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
  /** B2: YouTube did not deliver and the box turned Skrin back on by itself (warning `kiosk_restored` until a person changes the Skrin switch). */
  kioskRestored: boolean;
  /** "Kod semula" was asked but this box cannot encode H.264: the relay runs `copy` (warning `reencode_unsupported`). */
  reencodeFallback: boolean;
  /** The ffmpeg relay of the box YouTube leg (youtubeVia 'box' with a key); null otherwise. */
  relay: Relay | null;
  /** B6: the quality ladder of the box YouTube leg (kept across relay revivals of one live); null while the leg is not a copy relay. */
  ladder: QualityLadder | null;
  /** B6: the low encoder the ladder may use (set when the probe has answered); null until then and on a box without one. */
  lowEncoder: LowEncoder | null;
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
  /** Build 6: the running combiner when it is the solo sound path (the same object as `mixer`); null otherwise. Never has an aligner. */
  solo: SoloLike | null;
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
  /** Who pulls the camera of this live (`videoPathOf` of the start request). */
  videoPath: LiveVideoPath;
  /** Display name of the starting device (for the "camera in use" flag); never its id. */
  deviceName: string;
  /** The "camera in use" flag: set on the first pull of this live (the start of an external-camera live, or the owner reading the address mid-live). */
  cameraUse: { via: LiveVideoPath; sinceMs: number } | null;
  /** WHEP viewers of other devices that joined the shared picture of a live that holds the camera: device id -> session ids and when the device was last heard of. */
  joined: Map<string, { ids: Set<string>; atMs: number }>;
  /** Every YouTube broadcast of this live, oldest first. */
  broadcastIds: string[];
  /** The picture had been there and is gone since this moment (an open ingest gap); null while it is there or never came. */
  gapFromMs: number | null;
  /** Whole seconds of the closed ingest gaps. */
  gapSeconds: number;
  /** This live reached the box with a picture: counted once by the start limiter (S6). */
  counted: boolean;
  /** The pulled camera's tracks are H.265 with no H.264 (C11): the box cannot show or relay it. */
  camH265: boolean;
  /** D3: the `since` of the picture that just vanished: the waiting state and a return inside the waiting window keep it, so the TV keeps its player. */
  heldSince: string | null;
  /** Y2: when the YouTube relay was first seen failed (null while it is not), and whether the picture dropped since. */
  relayFailedAtMs: number | null;
  relayRetryArmed: boolean;
  /** A21: the combiner also publishes an AAC rendition to `surau-yt` and the box relay reads it (combined, box YouTube leg, YouTube on in the settings). */
  ytRendition: boolean;
  /** A8: the box microphone is out of the graph now (benched after two stalls); the camera sound is audible meanwhile. */
  benchActive: boolean;
  /** A3: the last status poll of the STARTING device (the quiet notice); another device's poll never moves it. Also set when the starter re-attaches. */
  starterPollAtMs: number;
  quietLogged: boolean;
  /** Build 5: the box microphone is in the mix and has been silent for a minute (the warning `box_mic_silent`). */
  boxMicSilent: boolean;
  /** Build 5: since when the box microphone has been in the mix above volume 0 without a break (null while it is not): silence before that does not count. */
  boxMicSinceMs: number | null;
  /** Build 5: the box is busy (the warning `server_busy`). */
  serverBusy: boolean;
  /** A7: when the combiner was built, when its output was last seen healthy, when it was last kicked, the last bytes of `surau`. */
  mixerBuiltAtMs: number;
  /** Start of the combiner's current run: the build, the last kick or the last relaunch the watchdog saw (the grace per run). */
  runStartAtMs: number;
  /** The combiner's `restarts` count at the last tick. */
  runRestartsSeen: number;
  outOkAtMs: number;
  lastKickAtMs: number;
  outBytes: number;
  /** A8: stalls of the current combiner already counted, stall times in the window, and the box microphone's bench end. */
  stallsSeen: number;
  stallTimes: number[];
  boxInputBenchedUntilMs: number;
  /** Gate fix B2: the phone microphone's bench end (a `sound_exit` of the solo path), and the benches of each source in this live (the bench time grows). */
  deviceMicBenchedUntilMs: number;
  benchCounts: Map<AddedAudioId, number>;
  /** The path the YouTube relay reads (`surau` or `surau-yt`) and whether it was started as a copy relay (only then a ladder). */
  relayPath: string | null;
  relayCopy: boolean;
  /** Gate fix B4: the bytes of the relay's source path at the last tick, and whether they stood still (the input paused, not the upload). */
  relayInBytes: number | null;
  relayInputPaused: boolean;
  /** Gate fix B5: since when the ladder is low while the relay is not running (null while it runs or the ladder is full). */
  lowNotRunningSinceMs: number | null;
  /** Gate fix B8: unplanned restarts of the relays of this live that were replaced (revivals): the app's reconnect count. */
  relayRestartsBase: number;
  /** A12: the hand-set offset of the box microphone (null = the aligner decides). */
  boxOffsetMs: number | null;
  /** A16: samples of the camera path (time, bytes) and the verdicts built from them. */
  camSamples: Array<{ t: number; bytes: number }>;
  /** B3: the unit path's byte counter at the last poll and the time it last grew. */
  unitBytesLast: number;
  unitGrowAtMs: number;
  cameraKbps: number | null;
  camHigh: boolean;
  camSlow: boolean;
  camLevelKbps: number | null;
  camLevelAtMs: number;
  /** The relay state last logged, and the unit and microphone ready flags last logged. */
  relayLogged: string;
  unitReadyLogged: boolean | null;
  micReadyLogged: boolean | null;
  /** The camera path and the output path as the last tick saw them (for the stall block of the live log). */
  camInfo: { ready: boolean; readers: number; bytes: number } | null;
  outInfo: { ready: boolean; readers: number; bytes: number } | null;
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
  if (!isRecord(outputs) || typeof outputs.kiosk !== 'boolean' || typeof outputs.youtube !== 'boolean') return bad();
  if (outputs.recording !== undefined && typeof outputs.recording !== 'boolean') return bad();
  // build 4: Skrin may be off at the start, but at least one destination must stay on (older apps always send kiosk true)
  if (!outputs.kiosk && !outputs.youtube && outputs.recording !== true) throw new LiveError(400, 'no_destination', LIVE_MSG.noDestination);
  if (youtubeVia !== 'device' && youtubeVia !== 'box') return bad();
  // a browser cannot push RTMPS itself: its YouTube leg is always the box relay
  if (source === 'web' && outputs.youtube && youtubeVia !== 'box') return bad();
  // the picture source and the audio mix (plan 4.2); both optional so an older app still starts a live
  if (video !== undefined && video !== 'phone' && video !== 'external') return bad();
  if (audio !== undefined && !isRecord(audio)) return bad();
  // 2026.11.15 (frozen contract): `resume` and `videoPath` are checked for shape and carried; what they do comes with the live lanes
  const options = parseLiveStartOptions(body);
  if (options === null) return bad();
  // B2: an Android phone whose camera the box pulls has no stream of its own to record: Merakam is no destination there
  if (source === 'android' && videoPathOf({ source, video, videoPath: options.videoPath }) === 'box' && !outputs.kiosk && !outputs.youtube) {
    throw new LiveError(400, 'no_destination', LIVE_MSG.noDestination);
  }
  // the box pulls the camera for an Android phone: the phone has no picture to push, so YouTube leaves from the box relay
  if (source === 'android' && video === 'external' && options.videoPath === 'box' && outputs.youtube && youtubeVia !== 'box') return bad();
  return {
    kuliahId: kuliahId as string | null,
    source,
    outputs: { kiosk: outputs.kiosk, youtube: outputs.youtube, ...(outputs.recording !== undefined ? { recording: outputs.recording } : {}) },
    youtubeVia,
    ...(video !== undefined ? { video } : {}),
    ...(audio !== undefined ? { audio: audio as unknown as LiveAudioMix } : {}),
    ...options,
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
  /** The session whose start is waiting for a microphone probe or test to end: its combiner is not built meanwhile. */
  private audioWaiting: Session | null = null;
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
  /** S8: attempts of `youtube/start` in the last hour (device and time). */
  private ytStarts: Array<{ deviceId: string; at: number }> = [];
  /** Starts of the last hour (device and time) for the limiter. */
  private starts: Array<{ at: number; deviceId: string }> = [];
  /** Every start request of the last hour that claimed the box (the ceiling of S6). */
  private attempts: Array<{ at: number; deviceId: string }> = [];
  /**
   * The YouTube broadcast of a session that ended a moment ago. It stays open for the grace window so a new start
   * of the same kuliah on the same leg carries on with it (one kuliah, one recording: an encoder reconnecting to
   * the same key); it is completed when the window ends or a start for something else comes.
   */
  private lingering: { kuliahId: string | null; via: YoutubeVia; broadcastId: string; watchUrl: string | null; key: string; privacy: string | null; timer: NodeJS.Timeout } | null = null;
  private readonly orphanMs: number;
  private readonly waitingMs: number;
  private readonly log: LiveLogLike;
  private readonly quietMs: number;
  /** Build 5: the CPU figure of this box, and the average of the last ended live (memory only). */
  private readonly cpu: CpuSampler;
  private cpuLiveId: string | null = null;
  private lastLiveCpu: number | undefined;
  /** A11: the last delay the aligner locked at, per added source (the next live on this box starts there). */
  private readonly lastGoodDelay = new Map<AddedAudioId, number>();

  private readonly d: LiveSessionsDeps;
  private readonly encoder: EncoderCapability;
  /** B6: the low-quality encoder probe, started lazily at the first relay start and shared by every live. */
  private lowProbe: Promise<LowEncoder | null> | null = null;
  /** The live the probe was last asked for, and its answer (undefined while it runs). */
  private lowProbeLive: string | null = null;
  private lowProbeAnswer: LowEncoder | null | undefined = undefined;
  private readonly leveller: LevellerCapability;
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
    this.leveller = new LevellerCapability(deps.levellerProbe);
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
    this.orphanMs = deps.orphanMs ?? ORPHAN_MS;
    this.waitingMs = deps.waitingMs ?? WAITING_MS;
    this.log = deps.liveLog ?? NULL_LIVE_LOG;
    this.quietMs = deps.controllerQuietMs ?? CONTROLLER_QUIET_MS;
    this.cpu = deps.cpu ?? new CpuSampler();
    // MediaMTX keeps the publisher user and the SRT passphrase in memory only: a respawn loses them
    deps.runtime?.spawnListeners.add(() => this.reprovision());
  }

  /** One entry of the live log; the log never throws, a stand-in might. */
  private ev(kind: string, fields?: LiveLogFields): void {
    try {
      this.log.event(kind, fields);
    } catch {
      /* the log is a convenience */
    }
  }

  /** The live log redacts every secret the runtime holds plus this session's own (publisher, combiner, SRT passphrase, YouTube key). */
  private syncLogSecrets(s: Session | null): void {
    try {
      const all: string[] = [...(this.d.runtime?.secrets.list() ?? [])];
      if (s !== null) for (const v of [s.pubPass, s.mixPass, s.passphrase, s.youtubeKey, s.relay?.readPassword(), s.audioLeg?.readPassword()]) if (typeof v === 'string' && v !== '') all.push(v);
      // B8: the camera's host name (an address is masked by its shape; a name is not) never goes to the live log
      const host = cameraHost(this.d.camera?.get()?.url);
      if (host !== null) all.push(host);
      this.log.setSecrets(all);
    } catch {
      /* the log is a convenience */
    }
  }

  /** The box pulls the camera and the unit is that camera (not the iPad's own camera): the live has no automatic end. */
  private boxPulled(s: Session): boolean {
    return s.pulled && !s.ownCamera;
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
          ...(s.ytRendition ? [{ action: 'publish' as const, path: YT_PATH }] : []),
          // build 6: the solo sound process publishes the microphone, the join reads it back
          { action: 'read', path: SOUND_PATHS.opus },
          { action: 'read', path: SOUND_PATHS.aac },
          { action: 'publish', path: SOUND_PATHS.opus },
          { action: 'publish', path: SOUND_PATHS.aac },
        ],
        ips: ['127.0.0.1', '::1'],
      });
    }
    if (s.pulled) await this.patchCamera(s, api, s.camTransport);
    this.syncLogSecrets(s);
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

  /** S8: the limiter of `youtube/start`: at most YT_START_MAX_PER_DEVICE attempts per device per rolling hour (the attempt is recorded). */
  private ytStartAllowed(deviceId: string): boolean {
    const nowMs = this.d.now().getTime();
    this.ytStarts = this.ytStarts.filter((x) => nowMs - x.at < START_WINDOW_MS);
    if (this.ytStarts.filter((x) => x.deviceId === deviceId).length >= YT_START_MAX_PER_DEVICE) return false;
    this.ytStarts.push({ deviceId, at: nowMs });
    return true;
  }

  /** The limiter: false when this device or the box started too often in the last hour. */
  private startAllowed(deviceId: string): boolean {
    const nowMs = this.d.now().getTime();
    this.starts = this.starts.filter((x) => nowMs - x.at < START_WINDOW_MS);
    this.attempts = this.attempts.filter((x) => nowMs - x.at < START_WINDOW_MS);
    if (this.attempts.length >= ATTEMPT_MAX_PER_BOX || this.attempts.filter((x) => x.deviceId === deviceId).length >= ATTEMPT_MAX_PER_DEVICE) return false;
    return this.starts.length < START_MAX_PER_BOX && this.starts.filter((x) => x.deviceId === deviceId).length < START_MAX_PER_DEVICE;
  }

  /* ------------------------------------------------------------------ reads */

  /** `boxPulled` here is the "never ends" predicate: the live STARTED box-pulled (B1). */
  current(): { id: string; deviceId: string; source: LiveSource; boxPulled: boolean } | null {
    const s = this.session;
    return s === null ? null : { id: s.id, deviceId: s.deviceId, source: s.source, boxPulled: s.pulled };
  }

  /** The state the kiosk shows. Computed on every call from the cached ingest state and the live settings. */
  kioskLive(tvId?: string | null): KioskLive {
    const k = this.kioskLiveBase();
    // the live notice was edited: the number changes with every edit, so the open apps re-read it
    const rev = this.noticeRev();
    const all = rev !== undefined ? { ...k, noticeRev: rev } : k;
    return tvId == null ? all : this.liveForTv(all, tvId);
  }

  /** What one TV is told of the live: its own profile (`live.show`, `audio`, `volume`) over the surau's state. */
  liveForTv(live: KioskLive, tvId: string | null | undefined): KioskLive {
    if (tvId == null) return live;
    return applyTvProfileToLive(live, tvProfileFor(getSettings(this.d.db, LOCAL_SURAU_ID), tvId));
  }

  /** False when this TV's profile switches the live picture off (`live.show === false`): its WHEP is refused. */
  tvMayWatch(tvId: string | null | undefined): boolean {
    // Skrin switched off for this live: no TV is offered the picture
    if (this.session?.outputs.kiosk === false) return false;
    if (tvId == null) return true;
    return tvProfileFor(getSettings(this.d.db, LOCAL_SURAU_ID), tvId)?.live?.show !== false;
  }

  /** The WHEP proxy's list of TVs that are watching (one entry per TV); set once by the proxy. */
  private viewerSource: (() => Array<{ tvId: string; state: 'playing' | 'connecting' }>) | null = null;

  attachViewers(source: (() => Array<{ tvId: string; state: 'playing' | 'connecting' }>) | null): void {
    this.viewerSource = source;
  }

  /**
   * Who watches, one entry per TV: `playing` (a WHEP session is open), `connecting` (an offer is being answered), `off`
   * (its profile switches the live picture off, so it never gets a session). The name is the TV profile's, else the
   * paired screen's device name, else the TV id.
   */
  private viewers(): NonNullable<LiveStatus['viewers']> {
    const tvs = getSettings(this.d.db, LOCAL_SURAU_ID).tvProfiles.tvs;
    const byId = new Map<string, 'playing' | 'connecting' | 'off'>();
    for (const [tvId, p] of Object.entries(tvs)) if (p.live?.show === false) byId.set(tvId, 'off');
    for (const v of this.viewerSource?.() ?? []) if (byId.get(v.tvId) !== 'off') byId.set(v.tvId, v.state);
    const out: NonNullable<LiveStatus['viewers']> = [];
    for (const [tvId, state] of byId) {
      let name = tvs[tvId]?.name;
      if (typeof name !== 'string' || name.trim() === '') {
        const row = this.d.db.prepare('SELECT name FROM devices WHERE id = ?').get(tvId) as { name?: unknown } | undefined;
        // the box's own TV has no device row: it carries the name of the box
        const own = tvId === 'self' ? this.ownName() : null;
        name = typeof row?.name === 'string' && row.name !== '' ? row.name : (own ?? tvId);
      }
      out.push({ tvId, name, state });
    }
    return out;
  }

  /** The box's own name, or null when it has none; the live never fails over it. */
  private ownName(): string | null {
    try {
      const n = this.d.boxName?.();
      return typeof n === 'string' && n.trim() !== '' ? n : null;
    } catch {
      return null;
    }
  }

  /**
   * Build 5: the per-TV switch "Paparkan siaran langsung". Writes `tvProfiles.tvs[tvId].live.show`: `false` stores false,
   * `true` removes the key (the TV follows the surau again). The TV's whole entry is read, changed in one key and written
   * back (an entry is atomic in the store). `tvId` is `self` (this box's own TV), a paired screen or a linked box (a
   * kiosk device that is not revoked; a phone is not a TV), or a TV that already has a profile. Returns whether anything was written.
   */
  setTvShow(tvId: unknown, show: unknown, actor: string, deviceId: string | undefined): { tvId: string; show: boolean; changed: boolean } {
    if (!isTvId(tvId) || typeof show !== 'boolean') throw new LiveError(400, 'bad_request', LIVE_MSG.badRequest);
    const tvs = getSettings(this.d.db, LOCAL_SURAU_ID).tvProfiles.tvs;
    const stored = Object.hasOwn(tvs, tvId) ? tvs[tvId] : undefined;
    if (tvId !== 'self' && stored === undefined) {
      const row = this.d.db.prepare("SELECT 1 AS ok FROM devices WHERE id = ? AND platform = 'kiosk' AND revoked_at IS NULL").get(tvId) as { ok?: unknown } | undefined;
      if (row === undefined) throw new LiveError(404, 'unknown_tv', LIVE_MSG.unknownTv);
    }
    const entry = JSON.parse(JSON.stringify(stored ?? {})) as { live?: { show?: boolean } };
    const wasOff = entry.live?.show === false;
    if (show) {
      // already following the surau: nothing to write (and no empty entry that would count against the TV cap)
      if (!wasOff) return { tvId, show, changed: false };
      delete entry.live!.show;
      if (Object.keys(entry.live!).length === 0) delete entry.live;
    } else {
      if (wasOff) return { tvId, show, changed: false };
      entry.live = { ...(entry.live ?? {}), show: false };
    }
    putFeature(this.d.db, 'tvProfiles', { tvs: { [tvId]: entry } }, actor, deviceId, LOCAL_SURAU_ID);
    this.ev('tv_show', { tvId, show });
    this.publishKiosk();
    return { tvId, show, changed: true };
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
    if (s === null || settings.enabled !== true || s.outputs.kiosk === false) {
      return { live: false, since: null, kuliah: s?.kuliah ?? null, audio, volume, path };
    }
    // a box-pulled camera that was showing and is lost: the kiosk keeps the last picture with the waiting card
    if (!s.ready && s.pulled && s.unitEverReady && s.everReadyAtMs !== null) {
      return { live: true, since: s.readySince ?? new Date(s.everReadyAtMs).toISOString(), kuliah: s.kuliah, audio, volume, waiting: true, path };
    }
    // D3: a device's own stream that was showing and vanished: the TV holds the last picture with the waiting card for a
    // minute (a Wi-Fi blip, an app restart), then goes back to the slides
    if (!s.ready && !s.pulled && s.everReadyAtMs !== null && this.d.now().getTime() - s.lastReadyAtMs < this.waitingMs) {
      return { live: true, since: s.heldSince ?? new Date(s.everReadyAtMs).toISOString(), kuliah: s.kuliah, audio, volume, waiting: true, path };
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
    if (s?.kioskRestored === true) out.push(KIOSK_RESTORED);
    if (s?.reencodeFallback === true) out.push('reencode_unsupported');
    if (s?.camH265 === true) out.push(CAMERA_H265);
    if (s !== null && this.bitrateTooHigh(s)) out.push(CAMERA_BITRATE_HIGH);
    if (s !== null && this.boxPulled(s) && s.camSlow && s.unitReady) out.push(CAMERA_SLOW);
    if (s?.boxMicSilent === true) out.push(BOX_MIC_SILENT);
    // build 6: the box microphone's capture threw frames away in the last 30 s (the solo path counts the dshow lines)
    if (s !== null && s.solo !== null && s.mixer === s.solo && this.soloDrops(s.solo) > 0) out.push(BOX_MIC_DROPS);
    if (s?.serverBusy === true) out.push(SERVER_BUSY);
    if (s?.relay != null) {
      const rs = s.relay.status();
      // gate fix B4: not while the relay's input stands still (a paused picture is no upload lag)
      if (rs.behindSeconds !== null && Math.round(rs.behindSeconds) >= UPLOAD_BEHIND_S && !s.relayInputPaused) out.push(UPLOAD_BEHIND);
      if (rs.quality === 'low') out.push(QUALITY_LOWERED);
    }
    // B1: one predicate, a live that STARTED box-pulled (it never ends by itself, also after a switch to the iPad's camera)
    if (s !== null && s.pulled && this.controllerQuietMsOf(s) >= this.quietMs) out.push(CONTROLLER_QUIET);
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

  /**
   * C3: the box relays the pulled camera's picture to YouTube as it is (copy, or a box that cannot encode) and the
   * camera sends well above the configured maximum: the uplink may not carry it. Advice only; the live goes on.
   */
  private bitrateTooHigh(s: Session): boolean {
    if (!s.pulled || s.ownCamera || !s.ready || s.relay === null) return false;
    const yt = getSettings(this.d.db, LOCAL_SURAU_ID).liveYoutube;
    if (yt.relayVideo === 'reencode' && !s.reencodeFallback) return false;
    // A16: the verdict is the camera's own 30 s average with a hysteresis (see `sampleCamera`), not one 2 s sample of the output
    return s.camHigh;
  }

  /** The configured YouTube maximum (kbps) the camera bitrate is judged against. */
  private maxBitrateKbps(): number {
    const yt = getSettings(this.d.db, LOCAL_SURAU_ID).liveYoutube;
    return this.relayMaxKbps(yt.maxBitrateKbps);
  }

  /** The bitrate cap (kbps): fixed at 3500 (the setting is hidden from the app; a stored value is ignored). The one guard of both uses. */
  private relayMaxKbps(_stored: unknown): number {
    return 3500;
  }

  /** Milliseconds since the starting device last polled the status (the quiet notice). */
  private controllerQuietMsOf(s: Session): number {
    return Math.max(0, this.d.now().getTime() - s.starterPollAtMs);
  }

  /** The session as an app sees it: `mine` for the asking device, never the device id. */
  private sessionView(s: Session, deviceId: string | null | undefined): NonNullable<LiveStatus['session']> {
    return {
      id: s.id,
      kuliahId: s.kuliahId,
      source: s.source,
      outputs: s.outputs,
      youtubeVia: s.youtubeVia,
      startedAt: s.startedAt,
      startedBy: s.startedBy,
      mine: deviceId != null && s.deviceId === deviceId,
      videoPath: s.videoPath,
      boxPulled: this.boxPulled(s),
      startedBoxPulled: s.pulled,
    };
  }

  /** The "camera in use" flag as the asking device sees it: which device holds the camera (its name, and whether it is the caller's). */
  cameraUse(deviceId?: string | null): LiveCameraUse[] {
    const s = this.session;
    if (s === null || s.cameraUse === null) return [];
    return [
      {
        cameraId: CAMERA_ID,
        sessionId: s.id,
        via: s.cameraUse.via,
        by: { name: s.deviceName, mine: deviceId != null && s.deviceId === deviceId },
        since: new Date(s.cameraUse.sinceMs).toISOString(),
      },
    ];
  }

  /**
   * C5 and the "camera in use" flag: may this device read the full camera address now? Returns when it may and throws
   * the refusal otherwise. With no live anyone holding `live:control` may (the phone reads it before it starts). While
   * a live holds the camera only the device that pulls it does; everyone else joins the shared picture through the box
   * (`camera_in_use`). During a live that does not use the camera only its own device may, and that read is the first
   * pull: it sets the flag.
   */
  cameraAddressFor(deviceId: string | null): void {
    const s = this.session;
    if (s === null) return;
    const mine = deviceId !== null && s.deviceId === deviceId;
    if (s.cameraUse !== null) {
      if (mine && s.cameraUse.via === 'device') return;
      throw new LiveError(409, 'camera_in_use', LIVE_MSG.cameraInUse);
    }
    if (!mine) throw new LiveError(403, 'not_owner', LIVE_MSG.forbidden);
    // the starting phone switches to the external camera during its own live
    if (s.source === 'android') s.cameraUse = { via: 'device', sinceMs: this.d.now().getTime() };
  }

  /**
   * O4: the starting device lets go of the camera it pulled itself ("camera in use" flag, via `device`). Only the
   * session's owner may; a flag held by the box's own pull stays. Idempotent: no flag set is a plain success.
   */
  releaseCamera(deviceId: string | null, sessionId: string): void {
    const s = this.session;
    if (s === null || s.id !== sessionId) throw new LiveError(409, 'no_session', LIVE_MSG.noSession);
    if (deviceId === null || s.deviceId !== deviceId) throw new LiveError(403, 'not_owner', LIVE_MSG.forbidden);
    if (s.cameraUse !== null && s.cameraUse.via === 'device') s.cameraUse = null;
  }

  /** Gap seconds of the running live so far: the closed gaps on record (the YouTube ones too) plus the open ingest gap. */
  private gapSecondsNow(s: Session): number {
    let closed = s.gapSeconds;
    try {
      closed = this.d.store?.get(s.id)?.gapSeconds ?? s.gapSeconds;
    } catch {
      /* the record is a convenience: the live's own count stands */
    }
    if (s.gapFromMs === null) return closed;
    const nowMs = this.d.now().getTime();
    const open = Math.max(0, Math.round((nowMs - s.gapFromMs) / 1000));
    // O7: the open ingest gap may overlap a closed YouTube gap: the union of both counts each second once
    try {
      const rec = this.d.store?.get(s.id) ?? null;
      if (rec !== null) {
        // Q5: only what the open gap adds beyond the listed gaps; the list can be capped while `closed` keeps every second
        const added = mergedGapSeconds([...rec.gaps, { from: new Date(s.gapFromMs).toISOString(), to: new Date(nowMs).toISOString() }]) - mergedGapSeconds(rec.gaps);
        return closed + Math.max(0, added);
      }
    } catch {
      /* the record is a convenience: the plain sum stands */
    }
    return closed + open;
  }

  /** The last lives of this box for a surau, newest first, without the device id (`mine` for the asking device instead). */
  recentSessions(surauId: string, deviceId: string | null): LiveSessionSummary[] {
    let rows: ReturnType<LiveSessionStore['recent']> = [];
    try {
      rows = this.d.store?.recent(surauId) ?? [];
    } catch {
      rows = [];
    }
    return rows.map(({ ownerDeviceId, ...rest }) => ({ ...rest, mine: deviceId !== null && ownerDeviceId === deviceId }));
  }

  /** The YouTube broadcast a live that just ended keeps open for a restart of the same kuliah; null when none is held. */
  lingeringBroadcast(): string | null {
    return this.lingering?.broadcastId ?? null;
  }

  /**
   * S3: a live a box restart cut short still has an open row. It is closed with reason `shutdown` and its broadcast is
   * completed (the session itself died with the process). Never throws; answers how many rows it closed.
   */
  async recoverOpen(): Promise<number> {
    const store = this.d.store;
    if (store == null) return 0;
    let closed = 0;
    try {
      for (const row of store.open()) {
        if (this.session?.id === row.id) continue;
        const at = this.d.now().toISOString();
        store.end(row.id, at, 'shutdown');
        this.audit('live', row.id, 'system', null, { kuliahId: row.kuliahId, stoppedAt: at, reason: 'shutdown', recovered: true });
        closed += 1;
        const last = row.broadcastIds[row.broadcastIds.length - 1];
        if (last !== undefined && this.d.youtube?.signedIn() === true) await this.d.youtube.complete(last).catch(() => undefined);
      }
    } catch {
      console.warn('live: the record of an interrupted live could not be closed (reason: store_error)');
    }
    return closed;
  }

  /** A write to the record of the lives never breaks a live. */
  private record(write: (store: LiveSessionStore) => void): void {
    const store = this.d.store;
    if (store == null) return;
    try {
      write(store);
    } catch {
      console.warn('live: the record of this live could not be written (reason: store_error)');
    }
  }

  /** A YouTube broadcast now belongs to this live (made for it, or carried on from the grace window). */
  private noteBroadcast(s: Session, broadcastId: string): void {
    if (!s.broadcastIds.includes(broadcastId)) s.broadcastIds.push(broadcastId);
    this.record((store) => store.addBroadcast(s.id, broadcastId));
  }

  /** The picture is back, or the live ends: the open ingest gap is closed and recorded. */
  private closeGap(s: Session, nowMs: number): void {
    const from = s.gapFromMs;
    if (from === null) return;
    s.gapFromMs = null;
    if (nowMs <= from) return;
    const gap = { from: new Date(from).toISOString(), to: new Date(nowMs).toISOString(), kind: 'ingest' as const };
    s.gapSeconds += Math.round((nowMs - from) / 1000);
    this.record((store) => store.appendGap(s.id, gap));
    // O7: the record merges overlapping gaps (the YouTube one of the same stretch), so its total is the live's count
    try {
      const stored = this.d.store?.get(s.id)?.gapSeconds;
      if (stored !== undefined) s.gapSeconds = stored;
    } catch {
      /* the record is a convenience: the live's own count stands */
    }
  }

  /** Build 5: `cpuPercent` while a live runs, `lastLiveCpuPercent` otherwise; each only when the platform gave a figure. */
  private cpuFields(s: Session | null): { cpuPercent?: number; lastLiveCpuPercent?: number } {
    if (s !== null) {
      const p = this.cpu.percent(this.d.now().getTime());
      return p === undefined ? {} : { cpuPercent: p };
    }
    return this.lastLiveCpu === undefined ? {} : { lastLiveCpuPercent: this.lastLiveCpu };
  }

  status(deviceId?: string | null): LiveStatus {
    const rt = this.d.runtime;
    const s = this.session;
    const raw = this.d.youtube?.status();
    // No session means no live: a broadcast still held open for a restart (grace window) or not yet completed is not
    // "live" to anyone asking. Never `live` (or `testing`) with `session: null`; its health is not a live health either.
    const yt: LiveStatus['youtube'] | undefined =
      raw !== undefined && s === null && (raw.state === 'live' || raw.state === 'testing') ? { ...raw, state: 'complete', health: null } : raw;
    return {
      session: s === null ? null : this.sessionView(s, deviceId),
      // B5: this box's stored choice for its next live; the box is the single truth
      nextLiveOn: getSettings(this.d.db, LOCAL_SURAU_ID).liveYoutube.nextLiveOn !== false,
      gapSeconds: s === null ? 0 : this.gapSecondsNow(s),
      canToggleKiosk: true,
      ...(s !== null ? { controllerQuietSeconds: s.pulled ? Math.floor(this.controllerQuietMsOf(s) / 1000) : 0 } : {}),
      ...(s !== null && this.boxPulled(s) && s.cameraKbps !== null ? { cameraKbps: s.cameraKbps } : {}),
      ...this.cpuFields(s),
      broadcastIds: s === null ? [] : [...s.broadcastIds],
      cameraUse: this.cameraUse(deviceId),
      mediamtx: {
        running: rt?.supervisor?.status().running === true,
        tools: { mediamtx: rt?.tools.mediamtx != null, ffmpeg: rt?.tools.ffmpeg != null },
      },
      warnings: this.warnings(),
      ...(s !== null ? { video: s.video, viewers: this.viewers() } : {}),
      ...(s !== null && s.reportAudio ? { audio: { sources: this.audioStatus(s) } } : {}),
      ingest: {
        ready: s?.ready === true,
        protocol: s?.ready !== true ? null : s.ingestSource?.type === 'webRTCSession' ? 'whip' : s.ingestSource?.type === 'srtConn' ? 'srt' : null,
        bitrateKbps: s?.ready === true ? s.bitrateKbps : 0,
        since: s?.ready === true ? s.readySince : null,
      },
      relay: this.relayView(s),
      youtube: yt ?? { signedIn: false, channelTitle: null, broadcastId: s?.broadcastId ?? null, state: 'none', health: null, watchUrl: s?.watchUrl ?? null, lastError: null },
    };
  }

  /** The relay part of the status: only what the app type has; `behindSeconds` once measured (whole seconds). */
  private relayView(s: Session | null): LiveStatus['relay'] {
    const r = s?.relay?.status();
    if (r === undefined || s === null) return { state: 'off', restarts: s?.relayRestartsBase ?? 0, lastError: null };
    return {
      state: r.state,
      // gate fix B8: the app's "reconnected N times": unplanned restarts of every relay of this live, quality restarts left out
      restarts: s.relayRestartsBase + unplannedRestarts(r),
      lastError: r.lastError,
      stderrTail: r.stderrTail,
      ...(r.behindSeconds !== null ? { behindSeconds: Math.round(r.behindSeconds) } : {}),
      quality: r.quality,
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
  previewFor(deviceId: string): { sessionId: string; path: string; ids: Set<string>; max?: number; stale?: string[] } {
    const s = this.session;
    if (s === null) throw new LiveError(409, 'no_session', LIVE_MSG.noSession);
    if (s.deviceId === deviceId) {
      // A14: a box-pulled live shows no picture on a phone; the iPad (web) owner keeps its one reader, to record
      if (this.boxPulled(s) && s.source !== 'web') throw new LiveError(409, 'preview_off', LIVE_MSG.previewOff);
      return { sessionId: s.id, path: PATH, ids: s.previewIds };
    }
    // A14: joiners get no picture of a box-pulled live either (the TVs and YouTube show it)
    if (this.boxPulled(s)) throw new LiveError(409, 'preview_off', LIVE_MSG.previewOff);
    // Another device: only while this live holds the camera. It may not pull the camera a second time, so it JOINS the
    // shared picture here, one viewer per device and a few devices at most (each one is a WebRTC reader on the box).
    if (s.cameraUse === null) throw new LiveError(403, 'not_owner', LIVE_MSG.forbidden);
    const nowMs = this.d.now().getTime();
    // Q5: a device that died without a DELETE does not keep its slot for the whole live. Its viewers go back to the
    // caller (`stale`), which closes them at MediaMTX.
    const stale: string[] = [];
    for (const [id, j] of s.joined) {
      if (id === deviceId || nowMs - j.atMs <= JOINED_TTL_MS) continue;
      stale.push(...j.ids);
      s.joined.delete(id);
    }
    let mine = s.joined.get(deviceId);
    if (mine === undefined) {
      for (const [id, j] of s.joined) if (j.ids.size === 0) s.joined.delete(id);
      if (s.joined.size >= MAX_JOINED_DEVICES) throw new LiveError(429, 'too_many_viewers', LIVE_MSG.tooManyJoined);
      mine = { ids: new Set(), atMs: nowMs };
      s.joined.set(deviceId, mine);
    }
    mine.atMs = nowMs;
    return { sessionId: s.id, path: PATH, ids: mine.ids, max: 1, stale };
  }

  /** Q8: how many preview readers (the starting device's and the joined devices') the live session holds on this path. */
  previewReaders(path: string): number {
    const s = this.session;
    if (s === null || path !== PATH) return 0;
    let n = s.previewIds.size;
    for (const j of s.joined.values()) n += j.ids.size;
    return n;
  }

  /** A device polled the status: the starting device's poll is the orphan watchdog of a device-sourced live and clears the quiet notice. */
  heartbeat(deviceId: string): void {
    const s = this.session;
    if (s === null) return;
    // only the starting device's poll counts as the controller: other phones polling see the quiet notice, the starter's poll clears it
    if (s.deviceId === deviceId) {
      s.lastPollAtMs = this.d.now().getTime();
      s.starterPollAtMs = s.lastPollAtMs;
    }
    // Q5: a joined device's status poll keeps its viewer slot
    const j = s.joined.get(deviceId);
    if (j !== undefined) j.atMs = this.d.now().getTime();
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
   * O34: turns YouTube on for a RUNNING live that started without it. The mixer, the TV leg and the ingest are not
   * touched: only the broadcast is made (as `createBroadcastLater` does) and, for a box leg, the relay is started
   * against the running ingest. The owner device may; so may a caller holding `settings:write` (like an emergency stop).
   * The stream key of a phone leg is returned to the owning device only; anyone else is told to let the phone ask
   * `GET /api/live/youtube/ingest`. Every refusal is a code: no_session, not_owner, already_on, busy,
   * not_signed_in, youtube_off, tools_missing, bad_request, or the YouTube failure code (a fixed vocabulary).
   */
  async startYoutube(
    req: { sessionId: string; title?: string; privacy?: string },
    caller: { deviceId: string | null; admin: boolean },
  ): Promise<{ session: NonNullable<LiveStatus['session']>; youtube: { via: YoutubeVia; ingest: string | null; key: string | null; legState: 'ready' | 'starting' } }> {
    const s = this.session;
    if (s === null || s.id !== req.sessionId) throw new LiveError(409, 'no_session', LIVE_MSG.noSession);
    const owner = caller.deviceId !== null && s.deviceId === caller.deviceId;
    if (!owner && !caller.admin) throw new LiveError(403, 'not_owner', LIVE_MSG.forbidden);
    // F26: on only when a broadcast really exists; `outputs.youtube` can stay true when YouTube was asked at start and never came up
    if (s.broadcastId !== null) throw new LiveError(409, 'already_on', LIVE_MSG.ytAlreadyOn);
    if (s.ytPending) throw new LiveError(409, 'busy', LIVE_MSG.ytStartBusy);
    // the same rules a start applies to the pairing of source, path and YouTube leg
    if ((s.source === 'web' || (s.source === 'android' && s.video === 'external' && s.videoPath === 'box')) && s.youtubeVia !== 'box') {
      throw new LiveError(400, 'bad_request', LIVE_MSG.badRequest);
    }
    const settings = getSettings(this.d.db, LOCAL_SURAU_ID);
    if (settings.liveYoutube.enabled !== true) throw new LiveError(409, 'youtube_off', LIVE_MSG.ytOffSetting);
    const yt = this.d.youtube;
    if (!yt || !yt.signedIn()) throw new LiveError(409, 'not_signed_in', LIVE_MSG.ytNotSignedIn);
    if (s.youtubeVia === 'box') {
      const ffmpeg = this.d.relayOptions?.ffmpegPath ?? this.d.runtime?.tools.ffmpeg;
      if (ffmpeg == null || this.d.runtime?.api == null) throw new LiveError(503, 'tools_missing', LIVE_MSG.toolsMissing);
    }
    const meta = this.metaForRunning(s, settings, req);
    if (meta === null) throw new LiveError(400, 'bad_request', LIVE_MSG.badRequest);
    // S1: a caller without the settings permission may not make the live more open than the surau's own setting
    if (!caller.admin && (PRIVACY_RANK[meta.privacy] ?? 2) > (PRIVACY_RANK[settings.liveYoutube.privacy] ?? 2)) throw new LiveError(403, 'privacy_not_allowed', LIVE_MSG.forbidden);
    // S8: every attempt that reaches Google counts, so a loop cannot use up the channel's daily quota
    if (!this.ytStartAllowed(caller.deviceId ?? '')) throw new LiveError(429, 'live_rate', LIVE_MSG.rate);

    // claim before the await: a second call now answers `busy`
    s.ytPending = true;
    s.ytWarning = null;
    let made: { broadcastId: string; watchUrl: string; key: string };
    try {
      made = await yt.createBroadcastFor({ sessionId: s.id, meta });
    } catch (e) {
      if (this.session === s) {
        s.ytPending = false;
        s.ytWarning = youtubeWarning(e);
        this.restoreKioskIfNoDestination(s, s.ytWarning);
      }
      throw new LiveError(502, youtubeWarning(e), LIVE_MSG.ytFailed);
    }
    if (this.session !== s) {
      // the live ended while the broadcast was being made: never leave it open
      this.track(yt.complete(made.broadcastId).catch(() => undefined));
      throw new LiveError(409, 'no_session', LIVE_MSG.noSession);
    }
    s.broadcastId = made.broadcastId;
    this.noteBroadcast(s, made.broadcastId);
    s.watchUrl = made.watchUrl;
    s.youtubeKey = made.key;
    s.ytPrivacy = meta.privacy;
    s.outputs = { ...s.outputs, youtube: true };
    s.ytPending = false;
    this.record((store) => store.markYoutube(s.id, yt.status().channelId ?? null));
    this.audit('live', s.id, 'youtube-on', null, { deviceId: caller.deviceId, broadcastId: made.broadcastId, youtubeVia: s.youtubeVia, privacy: meta.privacy });
    // the box leg: ffmpeg starts against the running ingest (it waits for the picture by itself)
    this.startRelay(s, settings.liveYoutube);
    const youtube =
      s.youtubeVia === 'device'
        ? owner
          ? { via: 'device' as const, ingest: YOUTUBE_INGEST, key: made.key, legState: 'ready' as const }
          : { via: 'device' as const, ingest: null, key: null, legState: 'starting' as const }
        : { via: 'box' as const, ingest: null, key: null, legState: 'ready' as const };
    return { session: this.sessionView(s, caller.deviceId), youtube };
  }

  /** The broadcast text for a running live: the caller's title and visibility over the kuliah's own text (or the plain fallback). */
  private metaForRunning(s: Session, settings: ReturnType<typeof getSettings>, req: { title?: string; privacy?: string }): YoutubeMeta | null {
    const surauName = settings.surauInfo.name.trim();
    let meta: YoutubeMeta | null = null;
    if (s.kuliahId !== null) {
      const k = getItem(this.d.db, 'kuliah', s.kuliahId, LOCAL_SURAU_ID);
      const p = k === null ? null : getItem(this.d.db, 'penceramah', k.penceramahId, LOCAL_SURAU_ID);
      if (k !== null && p !== null) {
        const kitab = k.kitabId !== undefined ? getItem(this.d.db, 'kitab', k.kitabId, LOCAL_SURAU_ID) : null;
        meta = youtubeMetaFor({ kuliah: k, penceramah: p, kitab, surauName, settings: settings.liveYoutube, now: this.d.now() });
      }
    }
    const base: YoutubeMeta = meta ?? { title: Array.from(cleanYoutubeText(`Kuliah ${surauName}`).trim()).slice(0, 100).join('').trim(), description: '', privacy: settings.liveYoutube.privacy };
    let title = base.title;
    if (req.title !== undefined) {
      title = Array.from(cleanYoutubeText(req.title).trim()).slice(0, 100).join('').trim();
      if (title === '') return null;
    }
    let privacy = base.privacy;
    if (req.privacy !== undefined) {
      if (req.privacy !== 'private' && req.privacy !== 'unlisted' && req.privacy !== 'public') return null;
      privacy = req.privacy;
    }
    return { ...base, title, privacy };
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

  /**
   * B7: the picture lift of the box relay for the external camera (setting `liveCamera.brightness`: `auto` default,
   * `normal`, `bright`, `brighter`). Read defensively: a missing or odd value is `auto`. `auto` is a mild fixed gamma
   * only when the relay starts between maghrib and subuh of the surau's own prayer times, else none. The phone's own
   * camera is lifted by the phone, never here.
   */
  private relayBrightness(s: Session): RelayBrightness {
    // F5: only when the BOX pulls the camera; a picture sent by the phone is lifted by the phone
    if (s.video !== 'external' || s.videoPath !== 'box') return 'normal';
    const raw = (getSettings(this.d.db, LOCAL_SURAU_ID).liveCamera as unknown as { brightness?: unknown }).brightness;
    if (raw === 'normal' || raw === 'bright' || raw === 'brighter') return raw;
    return this.isNightNow() ? 'night' : 'normal';
  }

  /** Is it after maghrib or before subuh on the surau's clock? False when the day's times are not known. */
  private isNightNow(): boolean {
    try {
      const now = this.d.now();
      const day = resolveDay(this.d.db, getSettings(this.d.db, LOCAL_SURAU_ID), klDateOf(now), LOCAL_SURAU_ID);
      if (day === null) return false;
      const date = klDateOf(now);
      return now >= klInstant(date, day.times.maghrib) || now < klInstant(date, day.times.subuh);
    } catch {
      return false;
    }
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
        // A21: a combined live with the AAC rendition is relayed from `surau-yt` as it is (no decode, no encode)
        const relayOpts: RelayOptions = { ...this.d.relayOptions, ffmpegPath, api: rt.api!, dataDir: this.d.dataDir!, sessionId: s.id, path: s.ytRendition ? YT_PATH : PATH, log: (text: string): void => this.log.line('relay', text) };
        const relay = this.d.relayFactory?.(relayOpts) ?? new Relay(relayOpts);
        s.relay = relay;
        s.relayPath = relayOpts.path ?? PATH;
        s.relayCopy = mode === 'copy';
        s.relayInBytes = null;
        s.relayInputPaused = false;
        s.lowNotRunningSinceMs = null;
        // B6: the ladder needs a copy relay (a re-encoding one has its own bitrate) and the setting not explicitly off
        const ladderOn = mode === 'copy' && getSettings(this.d.db, LOCAL_SURAU_ID).liveYoutube.autoQuality !== false;
        if (ladderOn) s.ladder ??= new QualityLadder({ slowSpeed: LADDER_SLOW_SPEED });
        // gate fix B7a: a re-encoding relay has no ladder at all
        if (mode === 'reencode') s.ladder = null;
        const opts: RelayStartOptions = {
          ...(s.ytRendition ? { audio: 'copy' as const } : {}),
          key,
          relayVideo: mode,
          maxBitrateKbps: this.relayMaxKbps(yt.maxBitrateKbps),
          // B7: the picture lift only exists on a re-encoding relay (a copy relay never changes the picture)
          ...(mode === 'reencode' ? { brightness: this.relayBrightness(s) } : {}),
          // a revived relay of a live whose ladder is low starts low at once (the encoder is already known)
          ...(ladderOn && s.lowEncoder !== null ? { lowEncoder: s.lowEncoder, ...(s.ladder?.quality === 'low' ? { quality: 'low' as const } : {}) } : {}),
        };
        relay.start(opts);
        rt.secrets.add(relay.readPassword());
        this.syncLogSecrets(s);
        // the live starts at full; the encoder is attached to the same options object when the probe answers (the relay reads it on every run)
        if (ladderOn && s.lowEncoder === null) {
          void this.lowEncoderFor(ffmpegPath, s.id).then((enc) => {
            if (enc === null || this.session !== s || s.relay !== relay) return;
            s.lowEncoder = enc;
            opts.lowEncoder = enc;
          });
        }
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

  /**
   * B6: the low-quality encoder of this box; a failed probe is null. An encoder found is kept for the life of the
   * process; a null answer only for the live it was asked in (gate fix B9): the next live start probes again, at most
   * once per live.
   */
  private lowEncoderFor(ffmpegPath: string, liveId: string): Promise<LowEncoder | null> {
    const keep = this.lowProbe !== null && (this.lowProbeLive === liveId || this.lowProbeAnswer !== null);
    if (keep) return this.lowProbe!;
    this.lowProbeLive = liveId;
    this.lowProbeAnswer = undefined;
    const job = (async (): Promise<LowEncoder | null> => {
      try {
        return await (this.d.lowEncoderProbe ?? probeLowEncoder)(ffmpegPath);
      } catch {
        return null;
      }
    })();
    this.lowProbe = job;
    void job.then((enc) => {
      if (this.lowProbe === job) this.lowProbeAnswer = enc;
    });
    return job;
  }

  /**
   * B6: one reading of the quality ladder per poll. Without a low encoder nothing is ever asked of the relay. The relay
   * reports no `behindSeconds` during start-up or after a planned restart, and a null reading breaks the ladder's run.
   */
  private async driveLadder(s: Session, nowMs: number): Promise<void> {
    const relay = s.relay;
    if (relay === null) {
      s.relayInputPaused = false;
      return;
    }
    // gate fix B4: a pause of the INPUT (the picture stopped coming) is not upload lag: no reading on such a tick
    const paused = await this.relayInputPaused(s);
    if (this.session !== s || s.relay !== relay) return;
    s.relayInputPaused = paused;
    const ladder = s.ladder;
    // gate fix B7a: only a relay started in copy mode has a ladder to drive
    if (ladder === null || s.lowEncoder === null || !s.relayCopy) return;
    const st = relay.status();
    const behind = st.behindSeconds === null ? null : Math.round(st.behindSeconds);
    if (getSettings(this.d.db, LOCAL_SURAU_ID).liveYoutube.autoQuality === false) {
      if (ladder.quality === 'low') {
        ladder.reset();
        relay.setQuality('full');
        this.ev('relay_quality', { quality: 'full', behindSeconds: behind });
      }
      return;
    }
    const running = st.state === 'running';
    // gate fix B5: a low step whose relay does not run for 15 s in a row failed: back to full for the rest of the live
    if (ladder.quality === 'low' && !running) {
      s.lowNotRunningSinceMs ??= nowMs;
      if (nowMs - s.lowNotRunningSinceMs >= LOW_FAIL_MS) {
        s.lowNotRunningSinceMs = null;
        ladder.abandon();
        relay.setQuality('full');
        this.ev('relay_quality', { quality: 'full', behindSeconds: behind, reason: 'low_failed' });
        return;
      }
    } else {
      s.lowNotRunningSinceMs = null;
    }
    const read = running && !paused;
    const next = ladder.tick(nowMs, { behindSeconds: read ? st.behindSeconds : null, speed: read ? st.speed : null });
    if (next === null) return;
    relay.setQuality(next);
    this.ev('relay_quality', { quality: next, behindSeconds: behind });
  }

  /** Gate fix B4: the bytes of the relay's source path did not grow since the last tick (false when unknown or the first reading). */
  private async relayInputPaused(s: Session): Promise<boolean> {
    const api = this.d.runtime?.api;
    if (!api || s.relayPath === null) return false;
    let bytes: number;
    try {
      bytes = (await api.pathGet(s.relayPath)).bytesReceived;
    } catch {
      return false;
    }
    if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return false;
    const prev = s.relayInBytes;
    s.relayInBytes = bytes;
    return prev !== null && bytes <= prev;
  }

  /** Resolves when every clean-up left running by an earlier stop has finished (tests, shutdown, the next start). */
  settled(): Promise<void> {
    return this.cleanup;
  }

  /** Waits for the clean-up chain, `cleanupWaitMs` at most. */
  private cleanupBounded(): Promise<void> {
    return this.bounded(this.cleanup, 'start');
  }

  /** Waits for a clean-up job, `cleanupWaitMs` at most; says so once when it gives up waiting. */
  private async bounded(job: Promise<void>, what: 'start' | 'shutdown'): Promise<void> {
    let timer: NodeJS.Timeout | null = null;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.warn(`live: the clean-up of an earlier live is still running, the ${what} goes on without waiting longer (reason: cleanup_slow)`);
        resolve();
      }, this.d.cleanupWaitMs ?? CLEANUP_WAIT_MS);
      timer.unref();
    });
    await Promise.race([job, bound]);
    if (timer !== null) clearTimeout(timer);
  }

  /**
   * Y2: the YouTube relay gave up (about 3 minutes of failures, an internet outage). It is replaced by a fresh one as
   * soon as the picture returns after a drop, or a minute after the failure while the picture is there, so the stream
   * comes back by itself when the internet does. A key YouTube refused is never retried.
   */
  private reviveRelay(s: Session, ready: boolean, nowMs: number): void {
    const relay = s.relay;
    const st = relay?.status();
    // B2: a key YouTube refused never delivers: with Skrin and Merakam off the live would have no destination at all
    if (relay != null && st?.state === 'failed' && st.lastError === 'bad_key') this.restoreKioskIfNoDestination(s, 'bad_key');
    if (relay == null || st === undefined || st.state !== 'failed' || st.lastError === 'bad_key') {
      s.relayFailedAtMs = null;
      s.relayRetryArmed = false;
      return;
    }
    s.relayFailedAtMs ??= nowMs;
    if (!ready) {
      s.relayRetryArmed = true;
      return;
    }
    if (!s.relayRetryArmed && nowMs - s.relayFailedAtMs < RELAY_REVIVE_MS) return;
    s.relayFailedAtMs = null;
    s.relayRetryArmed = false;
    s.relay = null;
    // gate fix B8: the reconnect count of the live survives the new relay object
    s.relayRestartsBase += unplannedRestarts(st);
    this.track(relay.stop());
    // the dead relay removes its own read user: the new one (same user name) starts after that
    void this.cleanup.then(() => {
      if (this.session !== s || s.relay !== null) return;
      this.startRelay(s, getSettings(this.d.db, LOCAL_SURAU_ID).liveYoutube);
    });
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
    // one shared audio leg: it runs when the surau wants the sound OR any TV profile does (each TV is told its own `audio`)
    const tvs = getSettings(this.d.db, LOCAL_SURAU_ID).tvProfiles.tvs;
    // a TV whose profile switches the picture off never watches, so it does not ask for sound
    const tvWants = Object.values(tvs).some((p) => p.live?.audio === true && p.live?.show !== false);
    // A20: a combined live already publishes Opus on `surau`: no TV sound leg. S2: Skrin off: no TV, no leg.
    const want = settings.enabled === true && s.outputs.kiosk !== false && !s.combined && (settings.audio === true || tvWants);
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
      // S2: a re-attach that names a different live is refused, never answered with a session it did not ask for
      if (req.resume === true && !this.sameLive(existing, req)) return Promise.reject(new LiveError(409, 'resume_mismatch', LIVE_MSG.resumeMismatch));
      // the same device asking again gets its own session back (a reconnect after an app restart)
      // (a reconnect is not counted by the start limiter)
      this.refreshFirewall();
      existing.lastPollAtMs = this.d.now().getTime();
      existing.starterPollAtMs = existing.lastPollAtMs;
      return (this.starting ?? Promise.resolve(null)).then(() => this.answer(existing, lanHost, isBlocked(this.d.firewall?.state() ?? 'unknown') ? [MEDIA_PORTS_BLOCKED] : []));
    }
    // a resume asks for the running session back: with none (the box ended it meanwhile) it never starts a new live
    if (req.resume === true) return Promise.reject(new LiveError(409, 'no_session', LIVE_MSG.noSession));
    if (!this.startAllowed(deviceId)) return Promise.reject(new LiveError(429, 'live_rate', LIVE_MSG.rate));
    const job = this.doStart(req, actor, deviceId, lanHost);
    this.starting = job;
    const clear = (): void => {
      if (this.starting === job) this.starting = null;
    };
    job.then(clear, clear);
    return job;
  }

  /**
   * Is this start request the running session? The kuliah, the sending side and the outputs must match; who pulls the
   * camera too when both name the external camera (the picture source itself may have been switched during the live).
   */
  private sameLive(s: Session, req: LiveStartRequest): boolean {
    if (req.kuliahId !== s.kuliahId || req.source !== s.source || req.outputs.youtube !== s.outputs.youtube) return false;
    if (req.video === 'external' && s.video === 'external' && videoPathOf(req) !== s.videoPath) return false;
    return true;
  }

  /** The display name of a device; empty when it has none (never its id). */
  private deviceName(deviceId: string): string {
    const row = this.d.db.prepare('SELECT name FROM devices WHERE id = ?').get(deviceId) as { name?: unknown } | undefined;
    return typeof row?.name === 'string' ? row.name : '';
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
    // one destination must stay on: YouTube counts only when it can really be made (enabled in the settings and signed in)
    const youtubeReal = req.outputs.youtube && settings.liveYoutube.enabled === true && this.d.youtube?.signedIn() === true;
    // B2: Merakam counts as a destination only where the starting device can record (not an Android phone whose camera the box pulls)
    const canRecord = !(req.source === 'android' && videoPathOf(req) === 'box');
    if (!req.outputs.kiosk && !youtubeReal && !(req.outputs.recording === true && canRecord)) throw new LiveError(400, 'no_destination', LIVE_MSG.noDestination);
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
      kioskRestored: false,
      reencodeFallback: false,
      relay: null,
      ladder: null,
      lowEncoder: null,
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
      solo: null,
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
      videoPath: mixing.videoPath,
      deviceName: this.deviceName(deviceId),
      // the first pull: a live with the external camera holds the camera from its start
      cameraUse: mixing.video === 'external' ? { via: mixing.videoPath, sinceMs: nowMs } : null,
      joined: new Map(),
      broadcastIds: [],
      gapFromMs: null,
      gapSeconds: 0,
      counted: false,
      camH265: false,
      heldSince: null,
      relayFailedAtMs: null,
      relayRetryArmed: false,
      // A21: only the box relay reads it; a device's own YouTube leg needs no AAC rendition
      ytRendition: mixing.combined && req.youtubeVia === 'box' && settings.liveYoutube.enabled === true,
      starterPollAtMs: nowMs,
      quietLogged: false,
      boxMicSilent: false,
      boxMicSinceMs: null,
      serverBusy: false,
      mixerBuiltAtMs: nowMs,
      runStartAtMs: nowMs,
      runRestartsSeen: 0,
      outOkAtMs: nowMs,
      lastKickAtMs: 0,
      outBytes: 0,
      stallsSeen: 0,
      stallTimes: [],
      boxInputBenchedUntilMs: 0,
      deviceMicBenchedUntilMs: 0,
      benchCounts: new Map(),
      relayPath: null,
      relayCopy: false,
      relayInBytes: null,
      relayInputPaused: false,
      lowNotRunningSinceMs: null,
      relayRestartsBase: 0,
      benchActive: false,
      boxOffsetMs: null,
      camSamples: [],
      unitBytesLast: 0,
      unitGrowAtMs: 0,
      cameraKbps: null,
      camHigh: false,
      camSlow: false,
      camLevelKbps: null,
      camLevelAtMs: nowMs,
      relayLogged: 'off',
      unitReadyLogged: null,
      micReadyLogged: null,
      camInfo: null,
      outInfo: null,
    };
    // claim the box before any await: a second start now sees the session and is refused
    this.session = session;
    this.attempts.push({ at: nowMs, deviceId });
    if (mixing.video === 'external') this.d.onExternalCameraLive?.();
    // MediaMTX logs the SRT stream id: its log is scrubbed of these for good
    this.d.runtime?.secrets.add(session.pubPass, session.passphrase, session.mixPass);
    this.syncLogSecrets(session);
    // never a camera address, a device id or a user name
    this.ev('session_start', {
      session: id,
      source: session.source,
      video: session.video,
      videoPath: session.videoPath,
      combined: session.combined,
      youtube: session.outputs.youtube,
      kiosk: session.outputs.kiosk,
      ytRendition: session.ytRendition,
    });
    try {
      // an earlier session's clean-up must finish first: it clears the shared passphrase and its own user.
      // S8: but not for ever. A clean-up that hangs (a YouTube call with no answer, a process that never ends) must not
      // block every later live; `release` leaves alone what a newer session has taken over.
      await this.cleanupBounded();
      // S2/Q5: a microphone probe or test that is still running holds the box microphone: the combiner opens it only after
      this.audioWaiting = session;
      try {
        await (this.d.audioIdle?.() ?? Promise.resolve()).catch(() => undefined);
      } finally {
        if (this.audioWaiting === session) this.audioWaiting = null;
      }
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
            session.broadcastIds.push(kept.broadcastId);
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
      // the record of this live (S3): a row from the start, closed at the stop
      this.record((store) => {
        store.begin({
          id,
          surauId: LOCAL_SURAU_ID,
          boxId: this.d.boxId ?? '',
          ownerDeviceId: deviceId,
          startedBy: actor,
          kuliahId: session.kuliahId,
          source: session.source,
          video: session.video,
          videoPath: session.videoPath,
          outputs: session.outputs,
          youtubeVia: session.youtubeVia,
          youtubeChannelId: session.outputs.youtube ? (this.d.youtube?.status().channelId ?? null) : null,
          startedAt: session.startedAt,
        });
        for (const b of session.broadcastIds) store.addBroadcast(id, b);
      });
      this.audit('live', id, actor, null, {
        // who ran it: the recording pieces of this live are accepted from this device (live/recordings.ts)
        deviceId,
        kuliahId: session.kuliahId,
        source: session.source,
        outputs: session.outputs,
        youtubeVia: session.youtubeVia,
        broadcastId: session.broadcastId,
        video: session.video,
        videoPath: session.videoPath,
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
        this.record((store) => store.end(session.id, this.d.now().toISOString(), 'start_failed'));
        this.track(this.teardown(session));
        this.publishKiosk();
      }
      throw error;
    }
  }

  /**
   * B2: YouTube turned out not to deliver (no broadcast could be made, or the relay's key was refused for good). When Skrin
   * is off and Merakam is not on either, the live would have no real destination: Skrin goes back on by itself, the TVs get
   * the event, the change log and the live log say so and the warning `kiosk_restored` is raised. Does nothing otherwise.
   */
  private restoreKioskIfNoDestination(s: Session, why: string): void {
    // Merakam is a destination only where the starting device can record (not an Android phone whose camera the box pulls)
    const canRecord = !(s.source === 'android' && s.videoPath === 'box');
    if (this.session !== s || s.outputs.kiosk || (s.outputs.recording === true && canRecord)) return;
    const before = { ...s.outputs };
    s.outputs = { ...s.outputs, kiosk: true };
    s.kioskRestored = true;
    this.audit('live-outputs', s.id, 'system', before, { kiosk: true, youtube: s.outputs.youtube, ...(s.outputs.recording !== undefined ? { recording: s.outputs.recording } : {}), reason: 'youtube_not_delivering' });
    this.ev('outputs_auto_kiosk', { reason: why });
    this.ev('outputs', { kiosk: true, youtube: s.outputs.youtube, recording: s.outputs.recording ?? null });
    this.record((store) => store.setOutputs(s.id, s.outputs));
    this.publishKiosk();
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
          this.restoreKioskIfNoDestination(s, s.ytWarning);
        }
        return;
      }
      if (this.session !== s) {
        // the session ended while the broadcast was being made: never leave it open
        this.track(yt.complete(made.broadcastId).catch(() => undefined));
        return;
      }
      s.broadcastId = made.broadcastId;
      this.noteBroadcast(s, made.broadcastId);
      s.watchUrl = made.watchUrl;
      s.youtubeKey = made.key;
      s.ytPending = false;
      this.startRelay(s, settings);
    })();
  }

  private answer(s: Session, lanHost: string, warnings: string[]): StartResult {
    const hasKey = s.youtubeKey !== null;
    const result: StartResult = {
      // the start answer only ever goes to the starting device
      session: this.sessionView(s, s.deviceId),
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
    // build 5: the CPU average of this live stays in memory for the control card until the next live
    this.lastLiveCpu = this.cpuLiveId === s.id ? this.cpu.runningPercent() : undefined;
    if (this.cpuLiveId === s.id) {
      this.cpu.reset();
      this.cpuLiveId = null;
    }
    const stoppedMs = this.d.now().getTime();
    this.closeGap(s, stoppedMs);
    this.record((store) => store.end(s.id, new Date(stoppedMs).toISOString(), reason));
    this.audit('live', s.id, actor, null, {
      kuliahId: s.kuliahId,
      source: s.source,
      outputs: s.outputs,
      youtubeVia: s.youtubeVia,
      broadcastId: s.broadcastId,
      stoppedAt: new Date(stoppedMs).toISOString(),
      reason,
      ingestSeconds: Math.round(s.ingestMs / 1000),
      gapSeconds: s.gapSeconds,
    });
    this.ev('session_stop', { session: s.id, reason, seconds: Math.round((stoppedMs - s.startedAtMs) / 1000) });
    // the Pentadbir's override of a live another device started: both actors are on record (plan 4.1, 6)
    if (opts.emergency === true) this.audit('live', 'emergency-stop', actor, null, { sessionId: s.id, startedBy: s.startedBy, stoppedBy: actor });
    // the kiosk goes dark at once; the box clean-up follows
    this.publishKiosk();
    // the broadcast lingers only for a kuliah (a later start of the same kuliah carries on with it); never after an
    // ad-hoc live (two of those are not one recording) and never after an emergency stop (it must end at once)
    // Y4: a session the box ended itself (ingest or camera gone, controller lost, timeout) lingers like a person's stop,
    // so the phone whose app died carries on with the same broadcast when it starts the kuliah again inside the window.
    // Only a shutdown completes it at once: the box is going away and nothing would complete it later.
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
    // S8: a start that did not wait for a hanging clean-up may already hold the box: its publisher, camera pull and
    // passphrase are not this session's to take away (the per-session users below always are)
    const superseded = (): boolean => this.session !== null && this.session !== s;
    for (const path of new Set([s.publishPath, ...(s.pulled ? [MIC_PATH, IN_PATH] : []), ...(s.combined ? [PATH, YT_PATH] : [])])) {
      if (superseded()) break;
      try {
        const p = await api.pathGet(path);
        if (p.source !== null) await api.kickPublisher(p.source);
      } catch {
        /* MediaMTX may already be gone */
      }
    }
    if (s.pulled && !(superseded() && this.session?.pulled === true)) {
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
    if (s.passphrase !== null && !(superseded() && this.session?.publishPath === s.publishPath)) {
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
    // S8: the box closes even when a clean-up never finishes (a YouTube call with no answer): the wait is bounded
    const all = (async (): Promise<void> => {
      await this.stop(undefined, 'system', 'shutdown');
      this.track(this.endLingering());
      await this.cleanup;
    })().catch(() => undefined);
    await this.bounded(all, 'shutdown');
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
      this.noteCpu(s, nowMs);
      const ready = path?.ready === true;
      s.outInfo = { ready, readers: path?.readers ?? 0, bytes: path?.bytesReceived ?? 0 };
      if (ready) {
        if (!s.ready) {
          // D3: a picture back inside the waiting window is the same live to the TV (the same `since`)
          const sameRun = !s.pulled && s.heldSince !== null && nowMs - s.lastReadyAtMs < this.waitingMs;
          s.readySince = sameRun ? s.heldSince : new Date(nowMs).toISOString();
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
        // D3: the picture is back, the gap is closed and recorded
        this.closeGap(s, nowMs);
        // S6: only a live that reached the box with a picture counts against the hourly limit
        if (!s.counted) {
          s.counted = true;
          this.starts.push({ at: nowMs, deviceId: s.deviceId });
        }
      } else {
        // the picture was there and is gone: an ingest gap opens at the last moment it was seen
        if (s.everReadyAtMs !== null && s.gapFromMs === null) s.gapFromMs = s.lastReadyAtMs;
        if (s.readySince !== null) s.heldSince = s.readySince;
        s.readySince = null;
        s.bitrateKbps = 0;
        s.ingestSource = null;
        if (s.audioLeg?.status().state === 'failed') s.audioRetryArmed = true;
      }
      s.ready = ready;
      this.reviveRelay(s, ready, nowMs);
      // the watchdog: no picture for noVideoMs since the start (or since it vanished); cleared when it returns
      s.noVideo = !ready && nowMs - s.lastReadyAtMs >= this.noVideoMs();
      this.logRelayState(s);
      await this.driveLadder(s, nowMs);
      if (this.session !== s) return;
      if (s.combined) {
        this.noteStalls(s, nowMs);
        await this.pollInputs(s, nowMs);
        this.logMixState(s);
        if (this.session !== s) return;
        this.noteBoxMic(s, nowMs);
        this.watchOutput(s, ready, nowMs);
        if (s.pulled) s.noCamera = !s.ownCamera && !s.unitReady && nowMs - s.unitLastReadyAtMs >= this.noVideoMs();
      }
      // A3: the notice is all a forgotten box-pulled live gets: it never ends by itself
      const quiet = s.pulled && this.controllerQuietMsOf(s) >= this.quietMs;
      if (quiet !== s.quietLogged) {
        s.quietLogged = quiet;
        this.ev('controller_quiet', { on: quiet, seconds: Math.floor(this.controllerQuietMsOf(s) / 1000) });
      }
      // A1, A2, K2: a live that STARTED box-pulled runs until a person presses Stop, also after a switch to the iPad's own
      // camera: no `camera_lost`, `controller_lost` or `timeout` (the kiosk shows the waiting card and the status warnings
      // say what is missing). A live whose picture comes from a device from the start keeps the old rules.
      if (!s.pulled) {
        // S1: no picture AND no status poll of the starting device: the live is an orphan (the app died, the phone left)
        if (!ready && nowMs - s.lastReadyAtMs >= this.orphanMs && nowMs - s.lastPollAtMs >= this.orphanMs) {
          await this.stop(s.id, 'system', 'controller_lost');
          return;
        }
        if (!ready && nowMs - s.lastReadyAtMs >= this.idleMs) {
          await this.stop(s.id, 'system', 'timeout');
          return;
        }
      }
      this.publishKiosk();
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Build 5: one CPU sample per tick; `server_busy` needs CPU above 85% for 30 s, the box's own TV AND another TV playing
   * the live. Once on it stays until the 30 s average is under 75% or one of the two TV conditions ends.
   */
  private noteCpu(s: Session, nowMs: number): void {
    if (this.cpuLiveId !== s.id) {
      this.cpu.reset();
      this.cpuLiveId = s.id;
    }
    this.cpu.sample(nowMs);
    let busy = s.serverBusy;
    if (!busy) {
      if (this.cpu.allAbove(BUSY_ON_PERCENT, nowMs, BUSY_SPAN_MS) && this.twoTvsPlay()) busy = true;
    } else {
      const avg = this.cpu.percent(nowMs);
      if (avg === undefined || avg < BUSY_OFF_PERCENT || !this.twoTvsPlay()) busy = false;
    }
    if (busy !== s.serverBusy) {
      s.serverBusy = busy;
      this.ev('server_busy', { on: busy, cpu: this.cpu.percent(nowMs) ?? null });
    }
  }

  /** This box's own TV plays the live and at least one other TV does too. */
  private twoTvsPlay(): boolean {
    const v = this.viewers();
    return v.some((x) => x.tvId === 'self' && x.state === 'playing') && v.some((x) => x.tvId !== 'self' && x.state === 'playing');
  }

  /**
   * Build 5: the box microphone is in the mix with a volume above 0 and was at or under -70 dBFS for 60 s: `box_mic_silent`.
   * Cleared after 3 s at or above -60 dBFS. A stale meter (the combiner is restarting) changes nothing; any time the
   * microphone is not in the mix the flag and the count start again.
   */
  private noteBoxMic(s: Session, nowMs: number): void {
    if (!this.boxMicInMix(s)) {
      s.boxMicSinceMs = null;
      this.setBoxMicSilent(s, false, 0);
      return;
    }
    s.boxMicSinceMs ??= nowMs;
    const ch = s.meter?.channelOf('boxInput') ?? -1;
    if (ch < 0 || s.meter === null) return;
    // the silence counts from the moment the microphone was in the mix (a volume turned up again starts a new minute)
    const silentMs = this.boxMicSilentMs(s, nowMs);
    const soundMs = s.meter.takeSoundMs(ch);
    if (silentMs === undefined || soundMs === undefined) return;
    if (!s.boxMicSilent) {
      if (silentMs >= BOX_MIC_SILENT_MS) this.setBoxMicSilent(s, true, silentMs);
    } else if (soundMs >= BOX_MIC_SOUND_MS) {
      this.setBoxMicSilent(s, false, 0);
    }
  }

  /** The box microphone is in the running graph, enabled, above volume 0 and not benched. */
  private boxMicInMix(s: Session): boolean {
    const row = s.mix.boxInput;
    return s.combined && s.graphAdded.has('boxInput') && row.enabled && row.volume > 0 && !s.benchActive;
  }

  /** Ms the box microphone has been at or under -70 dBFS while in the mix; undefined when it is not in the mix or the meter is stale. */
  private boxMicSilentMs(s: Session, nowMs: number): number | undefined {
    if (!this.boxMicInMix(s) || s.meter === null) return undefined;
    const ch = s.meter.channelOf('boxInput');
    if (ch < 0) return undefined;
    const run = s.meter.silentMs(ch);
    if (run === undefined) return undefined;
    return s.boxMicSinceMs === null ? run : Math.min(run, Math.max(0, nowMs - s.boxMicSinceMs));
  }

  private setBoxMicSilent(s: Session, on: boolean, silentMs: number): void {
    if (s.boxMicSilent === on) return;
    s.boxMicSilent = on;
    this.ev('box_mic_silent', { on, seconds: Math.floor(silentMs / 1000), threshold: on ? BOX_MIC_SILENT_DB : BOX_MIC_SOUND_DB });
  }

  /** One line of the live log per change of the relay's state. */
  private logRelayState(s: Session): void {
    const st = s.relay?.status().state ?? 'off';
    if (st === s.relayLogged) return;
    s.relayLogged = st;
    this.ev('relay_state', { state: st });
  }

  /** A8: stalls the combiner counted since the last tick; two inside two minutes bench the box microphone. */
  private noteStalls(s: Session, nowMs: number): void {
    const mixer = s.mixer;
    if (mixer === null) return;
    const st = mixer.status();
    const n = typeof st.stalls === 'number' ? st.stalls : 0;
    let benchNow = false;
    if (n > s.stallsSeen) {
      // B3: only a silent monitor while the unit's picture path is still growing points at the capture device; a kick for no
      // output, or a stall while the camera is silent or not ready, never benches the box microphone
      // build 6: on the solo path a sound process that ended by itself (`sound_exit`: unplugged, a capture error) points there too,
      // and benches at once (gate fix B2); an ffmpeg that never started (`sound_spawn`) is not the microphone's fault
      const reason = st.lastStall?.reason;
      const pointsAtCapture = (reason === 'monitor_silent' || reason === 'sound_exit') && s.unitReady && nowMs - s.unitGrowAtMs <= UNIT_GROW_FRESH_MS;
      if (pointsAtCapture) s.stallTimes.push(nowMs);
      if (pointsAtCapture && reason === 'sound_exit') benchNow = true;
      s.stallsSeen = n;
      // the evidence of the stall as the sessions know it (the combiner writes its own block): no address, no login
      this.ev('combiner_stall', {
        stalls: n,
        reason: reason ?? null,
        sinceBuildSeconds: Math.round((nowMs - s.mixerBuiltAtMs) / 1000),
        camReady: s.camInfo?.ready ?? null,
        camReaders: s.camInfo?.readers ?? null,
        camBytes: s.camInfo?.bytes ?? null,
        outReady: s.outInfo?.ready ?? null,
        outReaders: s.outInfo?.readers ?? null,
        outBytes: s.outInfo?.bytes ?? null,
      });
    }
    s.stallTimes = s.stallTimes.filter((t) => nowMs - t <= STALL_WINDOW_MS);
    const id: AddedAudioId | undefined = s.graphAdded.has('boxInput') ? 'boxInput' : s.graphAdded.has('deviceMic') ? 'deviceMic' : undefined;
    if (id !== undefined && (benchNow || s.stallTimes.length >= 2)) {
      // the stall follows the capture device: leave it out for a while, the camera sound carries the live (K8); the time
      // grows on repeats within the live (60 s, 120 s, 240 s, then 300 s)
      const count = s.benchCounts.get(id) ?? 0;
      s.benchCounts.set(id, count + 1);
      const until = nowMs + benchMsFor(count);
      if (id === 'boxInput') s.boxInputBenchedUntilMs = until;
      else s.deviceMicBenchedUntilMs = until;
      s.stallTimes = [];
      // B7: the `combiner_bench` line is written once, where the bench turns on (`pollInputs`), not here as well
    }
  }

  /**
   * Gate fix B2: whether a source is benched now. A bench that ends re-checks the box microphone first: when the capture
   * device is gone (not in the box's audio inputs any more) the bench is kept and checked again a minute later.
   */
  private benchedNow(s: Session, id: 'boxInput' | 'deviceMic', nowMs: number): boolean {
    const until = id === 'boxInput' ? s.boxInputBenchedUntilMs : s.deviceMicBenchedUntilMs;
    if (until === 0) return false;
    if (nowMs < until) return true;
    if (id === 'boxInput' && this.d.boxInput !== undefined) {
      let dev: { deviceName: string } | null = null;
      try {
        dev = this.d.boxInput();
      } catch {
        dev = null;
      }
      if (dev === null || (s.boxDevice !== null && dev.deviceName !== s.boxDevice.deviceName)) {
        s.boxInputBenchedUntilMs = nowMs + BENCH_MS;
        return true;
      }
    }
    if (id === 'boxInput') s.boxInputBenchedUntilMs = 0;
    else s.deviceMicBenchedUntilMs = 0;
    return false;
  }

  /** A7: the box output has not moved for 15 s while the combiner and the camera are up and the run is 35 s old: the combiner is kicked (at most once per 35 s). */
  private watchOutput(s: Session, ready: boolean, nowMs: number): void {
    const mixer = s.mixer;
    if (mixer === null) return;
    const bytes = s.outInfo?.bytes ?? 0;
    if (ready && bytes !== s.outBytes) s.outOkAtMs = nowMs;
    s.outBytes = bytes;
    if (!s.unitReady) return;
    const mst = mixer.status();
    const state = mst.state;
    // a relaunch the combiner did by itself starts a new run with its own grace
    if (typeof mst.restarts === 'number' && mst.restarts !== s.runRestartsSeen) {
      s.runRestartsSeen = mst.restarts;
      s.runStartAtMs = nowMs;
      s.outOkAtMs = nowMs;
    }
    if (state !== 'running' && state !== 'starting') return; // a combiner that is retrying relaunches by itself
    if (nowMs - s.runStartAtMs < COMBINER_MIN_AGE_MS) return;
    if (nowMs - s.outOkAtMs < OUTPUT_STALL_MS) return;
    if (nowMs - s.lastKickAtMs < KICK_MIN_GAP_MS) return;
    s.lastKickAtMs = nowMs;
    s.outOkAtMs = nowMs; // the next run gets its own 15 s
    s.runStartAtMs = nowMs; // and its own 35 s grace
    this.ev('combiner_kick', { reason: 'no_output', outReady: ready, outBytes: bytes });
    try {
      mixer.kick('no_output');
    } catch {
      /* the combiner restarts by itself when it exits */
    }
  }

  /**
   * A16, A17, A19: the camera's own bitrate from the bytes of `surau-cam`, averaged over 30 s. No verdict before 20 s of
   * samples; the warning is set above maximum x 1.2 and cleared below maximum x 1.05; a counter that goes backwards (the
   * camera reconnected) clears the window. A bitrate far under the camera's own running level is `camera_slow`.
   */
  /** B5: the samples are gone (unit not ready, a reconnect, a unit switch): so are the verdicts built from them. */
  private resetCameraSamples(s: Session): void {
    s.camSamples = [];
    s.cameraKbps = null;
    if (s.camSlow) this.ev('camera_slow', { on: false, kbps: null, levelKbps: Math.round(s.camLevelKbps ?? 0) });
    if (s.camHigh) this.ev('camera_bitrate_high', { on: false, kbps: null, maxKbps: this.maxBitrateKbps() });
    s.camHigh = false;
    s.camSlow = false;
    s.camLevelKbps = null;
  }

  private sampleCamera(s: Session, unit: MediamtxPath, nowMs: number): void {
    if (!unit.ready) {
      this.resetCameraSamples(s);
      return;
    }
    const last = s.camSamples[s.camSamples.length - 1];
    if (last !== undefined && unit.bytesReceived < last.bytes) {
      // the camera reconnected: a new stream, a new level
      this.resetCameraSamples(s);
    }
    s.camSamples.push({ t: nowMs, bytes: unit.bytesReceived });
    while (s.camSamples.length > 1 && nowMs - s.camSamples[0]!.t > CAM_WINDOW_MS) s.camSamples.shift();
    const first = s.camSamples[0]!;
    const span = nowMs - first.t;
    if (span < CAM_MIN_SPAN_MS) {
      s.cameraKbps = null;
      return;
    }
    const avg = ((unit.bytesReceived - first.bytes) * 8) / span;
    s.cameraKbps = Math.round(avg);
    const max = this.maxBitrateKbps();
    const wasHigh = s.camHigh;
    if (avg > max * BITRATE_WARN_FACTOR) s.camHigh = true;
    else if (avg < max * CAM_CLEAR_FACTOR) s.camHigh = false;
    if (wasHigh !== s.camHigh) this.ev('camera_bitrate_high', { on: s.camHigh, kbps: s.cameraKbps, maxKbps: max });
    // the running level follows the average slowly all the time (also while slow), so a camera that settles lower stops warning
    const wasSlow = s.camSlow;
    if (s.camLevelKbps === null) {
      s.camLevelKbps = avg;
      s.camLevelAtMs = nowMs;
    } else {
      const alpha = 1 - Math.exp(-Math.max(0, nowMs - s.camLevelAtMs) / CAM_LEVEL_TAU_MS);
      s.camLevelKbps += (avg - s.camLevelKbps) * alpha;
      s.camLevelAtMs = nowMs;
    }
    const level = s.camLevelKbps;
    if (level < CAM_LEVEL_FLOOR_KBPS) s.camSlow = false;
    else if (!s.camSlow && avg < level * CAM_SLOW_RATIO) s.camSlow = true;
    else if (s.camSlow && avg >= level * CAM_SLOW_CLEAR_RATIO) s.camSlow = false;
    if (wasSlow !== s.camSlow) this.ev('camera_slow', { on: s.camSlow, kbps: s.cameraKbps, levelKbps: Math.round(level) });
  }

  /** Emits a `live` event when the kiosk-visible state changed (also called when the settings change). */
  publishKiosk(): void {
    this.syncAudioLeg();
    const k = this.kioskLive();
    // K2: each TV is told the surau's state with its own profile laid over it, so a change of one TV's live profile is
    // a change too (the listeners apply the profile per TV)
    const tvs = getSettings(this.d.db, LOCAL_SURAU_ID).tvProfiles.tvs;
    const text = JSON.stringify([k, Object.entries(tvs).map(([id, p]) => [id, p.live ?? null])]);
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
    videoPath: LiveVideoPath;
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
    // B11: the box pulls the camera for a browser always, and for an Android phone that asks for it (`videoPath: 'box'`)
    const videoPath = videoPathOf(req);
    const pulled = video === 'external' && videoPath === 'box';
    if (video === 'external') {
      if (cam.enabled !== true) throw new LiveError(409, 'camera_off', LIVE_MSG.cameraOff);
      if ((this.camera?.get() ?? null) === null) throw new LiveError(409, 'camera_not_set', LIVE_MSG.cameraNotSet);
      if (this.cameraBusy?.() === true) throw new LiveError(409, 'camera_test_busy', LIVE_MSG.cameraTestBusy);
      // the box can only pass on H.264 (plan 3.3); the phone path decodes H.265 itself. C11: a camera never tested is
      // caught by its tracks once the pull runs (warning `camera_h265`).
      if (pulled && test !== null && (test.code === 'codec' || (test.codecs.some(isH265) && !test.codecs.some(isH264)))) {
        throw new LiveError(409, 'camera_h265', req.source === 'web' ? LIVE_MSG.cameraH265 : LIVE_MSG.cameraH265Box);
      }
      cameraHasAudio = test?.hasAudio ?? true;
    }
    const boxDevice = this.d.boxInput?.() ?? null;
    // a pulled camera is mixed on the box whoever controls it: the plan is the browser's
    const caps = this.capsFor(pulled ? 'web' : req.source, cameraHasAudio, boxDevice, pulled);
    const mix = normaliseAudioMix(video, req.audio, caps);
    const plan = audioPlanOf(video, mix, caps);
    const combined = pulled || plan.added.includes('boxInput');
    return {
      video,
      mix,
      plan,
      pulled,
      videoPath,
      combined,
      boxDevice,
      unit: pulled ? 'camera' : combined ? 'ingest' : null,
      publishPath: pulled ? MIC_PATH : combined ? IN_PATH : PATH,
      cameraHasAudio,
      transport: cam.transport === 'udp' ? 'udp' : cam.transport === 'tcp' ? 'tcp' : (test?.transport ?? 'tcp'),
      auto: cam.transport === 'auto',
    };
  }

  private capsFor(runner: LiveSource, cameraHasAudio: boolean, boxDevice: Session['boxDevice'], boxPulled = false): AudioCaps {
    // A10: the box microphone is the main sound of a box-pulled live (the default of a request with no audio block)
    return { cameraHasAudio, deviceMic: true, boxInput: boxDevice !== null, runner, ...(boxPulled ? { boxPulled: true } : {}) };
  }

  /** The camera showed or lost its audio track: the mix and the plan follow. */
  private replan(s: Session): void {
    const caps = this.capsFor(s.pulled ? 'web' : s.source, s.cameraHasAudio, s.boxDevice);
    s.mix = normaliseAudioMix(s.video, s.mix, caps);
    s.plan = audioPlanOf(s.video, s.mix, caps);
  }

  /** How the unit enters the graph. An ingest unit (a device's own stream) always carries sound: the box mutes it for "Mic-in only". */
  /**
   * `added` is what the graph holds (default: the running graph). Build 6, one sound: when the chosen microphone is
   * planned but out of the graph (benched after two stalls, or the iPad microphone lost) the unit's own sound carries the
   * live meanwhile, at its volume or 100 when that is 0 or it is not the chosen sound; a unit without sound stays silent.
   */
  private unitCfg(s: Session, added: readonly AddedAudioId[] = [...s.graphAdded]): { unit: MixUnit; unitHasAudio: boolean; unitVolume: number } {
    const fallback = s.plan.added.length > 0 && added.length === 0;
    if (s.unit === 'camera') {
      if (s.plan.reference === 'camera') return { unit: 'camera', unitHasAudio: true, unitVolume: s.mix.camera.volume };
      if (fallback && s.cameraHasAudio) {
        const cam = s.mix.camera;
        return { unit: 'camera', unitHasAudio: true, unitVolume: cam.enabled && cam.volume > 0 ? cam.volume : 100 };
      }
      return { unit: 'camera', unitHasAudio: false, unitVolume: 0 };
    }
    // a track the stream carries is always consumed (volume 0 when nothing phone-side is audible); the silent source only when it has none
    const phoneSide = this.phoneSide(s);
    const audible = phoneSide.some((m) => m.enabled && m.volume > 0) || fallback;
    return { unit: 'ingest', unitHasAudio: !s.ingestNoAudio, unitVolume: !s.ingestNoAudio && audible ? 100 : 0 };
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
    // B3: when the unit's own bytes last grew
    if (unit.ready && unit.bytesReceived > s.unitBytesLast) s.unitGrowAtMs = nowMs;
    s.unitBytesLast = unit.bytesReceived;
    if (s.unitReadyLogged !== unit.ready) {
      s.unitReadyLogged = unit.ready;
      this.ev('unit_ready', { ready: unit.ready, unit: s.unit });
    }
    if (s.unit === 'camera') {
      s.camInfo = { ready: unit.ready, readers: unit.readers, bytes: unit.bytesReceived };
      // A16: the camera's own bitrate (the bytes of `surau-cam`), never the box output
      this.sampleCamera(s, unit, nowMs);
    }
    if (unit.ready) {
      s.unitEverReady = true;
      s.unitLastReadyAtMs = nowMs;
      s.unitReadySinceMs ??= nowMs;
    } else {
      s.unitReadySinceMs = null;
    }
    // the tracks of the pulled camera say whether it has sound (the last test only guesses)
    if (s.pulled && s.unit === 'camera' && unit.ready && unit.tracks.length > 0) {
      s.camH265 = unit.tracks.some(isH265) && !unit.tracks.some(isH264);
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
      if (s.micReadyLogged !== mic.ready) {
        s.micReadyLogged = mic.ready;
        this.ev('mic_ready', { ready: mic.ready });
      }
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
    // S2/Q5: no combiner while a microphone probe or test of the start screen may still hold the box microphone
    if (this.audioWaiting === s) return;
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
    // A8: a box microphone that stalled the combiner twice is left out for a minute (the camera sound is raised meanwhile)
    // gate fix B2: the phone microphone gets the same bench (a `sound_exit` of its solo path); the unit's sound carries the live meanwhile
    const benched = this.benchedNow(s, 'boxInput', nowMs);
    const micBenched = this.benchedNow(s, 'deviceMic', nowMs);
    const anyBench = (benched && s.plan.added.includes('boxInput')) || (micBenched && s.plan.added.includes('deviceMic'));
    if (anyBench !== s.benchActive) {
      s.benchActive = anyBench;
      const until = benched ? s.boxInputBenchedUntilMs : s.deviceMicBenchedUntilMs;
      this.ev('combiner_bench', anyBench ? { on: true, seconds: Math.max(0, Math.round((until - nowMs) / 1000)) } : { on: false });
    }
    const usable = s.plan.added.filter((id) => (id !== 'deviceMic' || (s.pulled && s.unit === 'camera' && micIn && !micBenched)) && (id !== 'boxInput' || (s.boxDevice !== null && !benched)));
    // build 6, one sound: the plan holds one added source at most; should it ever hold more, the first by the priority rule is kept
    const pick = SOLO_PRIORITY.find((id): id is AddedAudioId => id !== 'camera' && usable.includes(id));
    const added: AddedAudioId[] = pick === undefined ? [] : [pick];
    const cfg = this.unitCfg(s, added);
    // gate fix B11: a microphone on the solo path has no aligner, so the align mode is not part of its graph
    const sig = added.length > 0 ? `${cfg.unit}|${cfg.unitHasAudio ? 1 : 0}|${added.join(',')}` : `${cfg.unit}|${cfg.unitHasAudio ? 1 : 0}||${this.alignMode(s, added)}`;
    if (s.mixer !== null && sig === s.graphSig) return;
    await this.destroyCombiner(s);
    if (this.session !== s || !s.unitReady) return;
    this.buildCombiner(s, cfg, added, sig);
  }

  private buildCombiner(s: Session, cfg: { unit: MixUnit; unitHasAudio: boolean; unitVolume: number }, added: AddedAudioId[], sig: string): void {
    const rt = this.d.runtime;
    const ffmpegPath = this.d.mixOptions?.ffmpegPath ?? rt?.tools.ffmpeg ?? null;
    if (ffmpegPath === null) return;
    // build 6: a microphone is the one sound: its own process and a remux join, never the mixer
    const first = added[0];
    if (first !== undefined) {
      this.buildSolo(s, cfg.unit, first, sig, ffmpegPath);
      return;
    }
    // from here on `added` is empty in build 6 (the camera's own sound, or a silent picture); the aligner code below stays for that shape
    const mode = this.alignMode(s, added);
    const headroom = this.timing.headroomMs;
    const input = added.includes('boxInput') ? s.boxDevice : null;
    const boxMain = this.boxPulled(s);
    const mixer = (this.d.mixerFactory ?? ((o: MixerOptions) => new Mixer(o)))(this.combinerOptions(s, ffmpegPath, input));
    s.mixer = mixer;
    s.solo = null;
    s.mixerBuiltAtMs = this.d.now().getTime();
    s.runStartAtMs = s.mixerBuiltAtMs;
    s.runRestartsSeen = 0;
    s.outOkAtMs = s.mixerBuiltAtMs;
    s.stallsSeen = 0;
    this.ev('combiner_build', { unit: cfg.unit, added: added.join(',') || 'none', mode, ytRendition: s.ytRendition, benched: s.benchActive });
    s.graphAdded = new Set(added);
    s.graphSig = sig;
    s.applied = new Map();
    s.alignStates = new Map();
    s.appliedUnit = cfg.unitVolume;
    const audible = cfg.unitHasAudio && cfg.unitVolume > 0;
    // A12: a hand-set offset of the box microphone overrides the aligner for this source
    const handSet = (id: AddedAudioId): boolean => mode === 'manual' || (id === 'boxInput' && s.boxOffsetMs !== null);
    // A11: the box microphone of a box-pulled live starts at the last delay that locked on this box, else headroom + its offset
    const initial = (id: AddedAudioId): number => {
      if (handSet(id)) return headroom + this.settingsOffset(id, s);
      if (id === 'boxInput' && boxMain) return this.lastGoodDelay.get('boxInput') ?? headroom + this.settingsOffset('boxInput', s);
      return DEFAULT_INITIAL_DELAY_MS;
    };
    // an added source starts held out of the mix (volume 0 in the graph) while the reference is audible, until it locks
    // (A9: never the box microphone of a box-pulled live: it is the main sound, the aligner only corrects its delay)
    const heldOut = (id: AddedAudioId): boolean => audible && mode !== 'manual' && !(id === 'boxInput' && boxMain);
    for (const id of added) {
      s.applied.set(id, heldOut(id) ? 0 : s.mix[id].volume);
      s.alignStates.set(id, handSet(id) ? 'manual' : 'searching');
    }
    let aligner: AlignerLike | null = null;
    if (added.length > 0) {
      aligner = (this.d.alignerFactory ?? ((o: AlignerOptions) => new Aligner(o)))({
        monitor: mixer.monitor,
        added,
        sampleRate: MONITOR_RATE,
        maxLagMs: headroom + 2000,
        initialDelayMs: boxMain && added.includes('boxInput') ? initial('boxInput') : DEFAULT_INITIAL_DELAY_MS,
        initialDelaysMs: Object.fromEntries(added.map((id) => [id, initial(id)])),
        apply: (id, ms) => void mixer.setDelay(id, ms),
        onState: (id, st) => this.onAlignState(s, mixer, id, st),
      });
    }
    s.aligner = aligner;
    mixer.start({
      unit: cfg.unit,
      unitHasAudio: cfg.unitHasAudio,
      unitVolume: cfg.unitVolume,
      added: added.map((id) => ({ id, initialDelayMs: initial(id), volume: s.mix[id].volume, ...(id === 'boxInput' && boxMain ? { held: false } : {}) })),
      ...(s.ytRendition ? { ytOutputPath: YT_PATH } : {}),
    });
    aligner?.start();
    this.attachMeter(s, mixer, cfg.unit, added);
    for (const id of added) if (handSet(id)) aligner?.setManual(id);
  }

  /** The levels of the running combiner's sources, measured on its monitor (channel 0 the unit, then each added source). */
  private attachMeter(s: Session, mixer: MixerLike, unit: MixUnit, added: readonly AddedAudioId[]): void {
    const meter = new LevelMeter([unit === 'camera' ? 'camera' : 'deviceMic', ...added], MONITOR_RATE, () => this.d.now().getTime());
    const onData = (chunk: Buffer): void => meter.feed(chunk);
    const onRestart = (): void => meter.reset();
    mixer.monitor.on('data', onData);
    mixer.monitor.on('restart', onRestart);
    s.meter = meter;
    s.meterOff = (): void => {
      mixer.monitor.off('data', onData);
      mixer.monitor.off('restart', onRestart);
    };
  }

  /** The options every combiner of this box shares: platform, the session's MediaMTX login, the leveller, the retry rules, the log. */
  private combinerOptions(s: Session, ffmpegPath: string, input: Session['boxDevice']): MixerOptions {
    const win = process.platform === 'win32';
    const dataDir = this.d.dataDir;
    return {
      ffmpegPath,
      platform: win ? 'windows' : 'android',
      headroomMs: this.timing.headroomMs,
      rtspUser: s.mixUser,
      rtspPass: s.mixPass,
      ...(win ? { zmqPortFn: () => randomInt(20000, 40000) } : {}),
      appLevelled: s.source === 'android',
      levellerProbe: () => this.leveller.check(ffmpegPath, this.d.mixOptions?.argsPrefix ?? []),
      onLevellerMissing: () => this.leveller.markMissing(ffmpegPath),
      ...(input !== null ? { deviceName: input.deviceName, ...(input.device !== undefined ? { device: input.device } : {}) } : {}),
      // the camera can be gone for minutes: keep retrying with short pauses, never give up
      backoffMaxMs: 5000,
      maxFailures: 1_000_000,
      // C2: the combiner's own lines and events go to the live log; `<dataDir>/live/debug.flag` switches ffmpeg to `info`
      log: (kind: string, text: string): void => {
        try {
          if (kind === 'stderr') this.log.line('combiner', text);
          else this.log.event(`combiner_${kind}`, { text });
        } catch {
          /* the log is a convenience */
        }
      },
      ...(dataDir !== undefined ? { debugFlagPath: join(dataDir, 'live', 'debug.flag') } : {}),
      ...(this.d.mixOptions ?? {}),
    };
  }

  /**
   * Build 6: the chosen microphone on its own path (SoloCombiner: a sound process and a remux join with one fixed delay).
   * No aligner: the source is `manual` and its delay is the join delay. The volume is a run-time command, never a restart.
   */
  private buildSolo(s: Session, unit: MixUnit, id: AddedAudioId, sig: string, ffmpegPath: string): void {
    const api = this.d.runtime?.api;
    if (!api) return;
    const input = id === 'boxInput' ? s.boxDevice : null;
    // a test that fakes the mixer only gets its fake here too (never a real ffmpeg behind a faked combiner)
    const mixerFake = this.d.mixerFactory;
    const factory = this.d.soloFactory ?? (mixerFake !== undefined ? (o: SoloCombinerOptions): SoloLike => mixerFake(o) as SoloLike : (o: SoloCombinerOptions): SoloLike => new SoloCombiner(o));
    const solo = factory({ ...this.combinerOptions(s, ffmpegPath, input), api });
    s.mixer = solo;
    s.solo = solo;
    s.aligner = null;
    s.mixerBuiltAtMs = this.d.now().getTime();
    s.runStartAtMs = s.mixerBuiltAtMs;
    s.runRestartsSeen = 0;
    s.outOkAtMs = s.mixerBuiltAtMs;
    s.stallsSeen = 0;
    const delayMs = this.soloDelay(id, s);
    this.ev('combiner_build', { unit, added: id, mode: 'solo', delayMs, ytRendition: s.ytRendition, benched: s.benchActive });
    s.graphAdded = new Set([id]);
    s.graphSig = sig;
    s.applied = new Map([[id, s.mix[id].volume]]);
    s.alignStates = new Map([[id, 'manual']]);
    s.appliedUnit = this.unitCfg(s, [id]).unitVolume;
    solo.start({
      unit,
      unitHasAudio: false,
      unitVolume: 0,
      added: [{ id, initialDelayMs: delayMs, volume: s.mix[id].volume, held: false }],
      ...(s.ytRendition ? { ytOutputPath: YT_PATH } : {}),
    });
    this.attachMeter(s, solo, unit, [id]);
  }

  /**
   * Build 6: the join delay of a solo source (ms, 0..2000): this live's hand-set value when there is one, else the setting
   * `liveCamera.avOffsetMs[id]` when it is above 0, else SOLO_DEFAULT_DELAY_MS.
   */
  private soloDelay(id: AddedAudioId, s: Session): number {
    const hand = id === 'boxInput' ? s.boxOffsetMs : s.offsetMs;
    const clamp = (v: number): number => Math.min(SOLO_MAX_DELAY_MS, Math.max(0, Math.round(v)));
    if (hand !== null) return clamp(hand);
    const v = getSettings(this.d.db, LOCAL_SURAU_ID).liveCamera?.avOffsetMs?.[id];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? clamp(v) : SOLO_DEFAULT_DELAY_MS;
  }

  /** Build 6: a new hand-set delay (or its removal) reaches the running solo path as a join restart. */
  private applySoloDelay(s: Session, id: AddedAudioId): void {
    const solo = s.solo;
    if (solo === null || s.mixer !== solo || !s.graphAdded.has(id)) return;
    const delayMs = this.soloDelay(id, s);
    void solo.setDelay(id, delayMs).catch(() => undefined);
    this.ev('solo_delay', { source: id, delayMs });
  }

  /** The dropped-frame count of the solo path; a stand-in that throws counts as none. */
  private soloDrops(solo: SoloLike): number {
    try {
      const n = solo.drops();
      return typeof n === 'number' && Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  /** The fixed fallback offset of an added source (a unit with no audio track), 0 to 2000 ms. */
  private settingsOffset(id: AddedAudioId, s?: Session): number {
    if (id === 'deviceMic' && s?.offsetMs != null) return s.offsetMs;
    if (id === 'boxInput' && s?.boxOffsetMs != null) return s.boxOffsetMs;
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
    s.solo = null;
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
    const delay = s.aligner?.delayMs(id);
    // A11: a lock is the delay the next live of this box starts with
    if (st === 'locked' && typeof delay === 'number' && Number.isFinite(delay)) this.lastGoodDelay.set(id, delay);
    const residual = s.aligner?.residualMs(id);
    this.ev('aligner_state', { source: id, state: st, delayMs: delay ?? null, residualMs: residual ?? null });
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
      // A9: the box microphone of a box-pulled live is never held out
      const held = audible && st !== 'locked' && st !== 'holding' && st !== 'manual' && !(id === 'boxInput' && this.boxPulled(s));
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
    // which source the hand-set offset is for: `avOffsetId` (the new app always sends it), else the added device microphone
    const askedOffsetId = isRecord(body) ? body.avOffsetId : undefined;
    if (askedOffsetId !== undefined && askedOffsetId !== 'deviceMic' && askedOffsetId !== 'boxInput') throw new LiveError(400, 'bad_request', LIVE_MSG.badRequest);
    // `null`: back to automatic (the hand-set offset is cleared)
    if (askedOffset !== undefined && askedOffset !== null && (typeof askedOffset !== 'number' || !Number.isInteger(askedOffset) || askedOffset < 0 || askedOffset > 2000 || askedOffset % 50 !== 0)) {
      throw new LiveError(400, 'bad_request', LIVE_MSG.badRequest);
    }
    const switching = askedVideo !== undefined && askedVideo !== s.video;
    // only a live that the box pulls can switch between the camera and the iPad's own camera
    if (switching && !s.pulled) throw new LiveError(409, 'audio_unsupported', LIVE_MSG.audioUnsupported);
    const video: LiveVideoSource = switching ? askedVideo : s.video;
    const boxDevice = this.d.boxInput?.() ?? null;
    const caps = this.capsFor(s.pulled ? 'web' : s.source, s.cameraHasAudio, boxDevice);
    const mix = normaliseAudioMix(video, audio, caps);
    const plan = audioPlanOf(video, mix, caps);
    if (!s.combined) {
      // a phone mixes for itself; the box only needs Mic-in to stay as it was at the start
      if (plan.added.includes('boxInput') !== s.plan.added.includes('boxInput')) throw new LiveError(409, 'audio_unsupported', LIVE_MSG.audioUnsupported);
      s.mix = mix;
      s.plan = plan;
      s.reportAudio = true;
      return this.status(deviceId);
    }
    if (plan.added.includes('boxInput') && boxDevice !== null) s.boxDevice = boxDevice;
    if (switching) await this.switchVideo(s, video);
    // no `avOffsetId`: the old meaning (the added device microphone), so an older app never moves the box microphone
    const offsetFor: AddedAudioId = askedOffsetId ?? 'deviceMic';
    if (askedOffset !== undefined) {
      if (offsetFor === 'boxInput') s.boxOffsetMs = askedOffset;
      else s.offsetMs = askedOffset;
    }
    s.mix = mix;
    s.plan = plan;
    s.reportAudio = true;
    if (switching) await this.pollInputs(s, this.d.now().getTime());
    else await this.reconcile(s, this.d.now().getTime());
    if (askedOffset === null && !switching) this.clearOffset(s, offsetFor);
    else if (askedOffset !== undefined && !switching) {
      if (offsetFor === 'boxInput') this.applyBoxOffset(s);
      else this.applyOffset(s);
    }
    this.syncVolumes(s, false);
    return this.status(deviceId);
  }

  /** The unit moves between the pulled camera (`surau-cam`, iPad mic on `surau-mic`) and the iPad's own stream (`surau-in`). */
  private async switchVideo(s: Session, video: LiveVideoSource): Promise<void> {
    const api = this.d.runtime?.api;
    const old = s.publishPath;
    s.video = video;
    s.ownCamera = video === 'phone';
    // Q6: the "camera in use" flag follows the video source. The live's own camera: the external camera is not in the
    // live. Back to the pulled camera: held again, by the box (only a live the box pulls switches here).
    s.cameraUse = s.ownCamera ? null : { via: s.pulled ? 'box' : 'device', sinceMs: this.d.now().getTime() };
    s.unit = s.ownCamera ? 'ingest' : 'camera';
    s.publishPath = s.ownCamera ? IN_PATH : MIC_PATH;
    s.unitReady = false;
    this.resetCameraSamples(s); // B5
    s.unitBytesLast = 0;
    // the iPad's own camera has not shown yet: no camera waiting card, no camera warning for it
    if (s.ownCamera) s.unitEverReady = false;
    s.unitReadySinceMs = null;
    s.unitLastReadyAtMs = this.d.now().getTime();
    s.lastReadyAtMs = s.unitLastReadyAtMs;
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
    if (s.solo !== null) return this.applySoloDelay(s, 'deviceMic');
    const mixer = s.mixer;
    if (mixer === null || !s.graphAdded.has('deviceMic') || this.alignMode(s, [...s.graphAdded]) !== 'manual') return;
    void mixer.setDelay('deviceMic', this.timing.headroomMs + this.settingsOffset('deviceMic', s));
  }

  /**
   * `avOffsetMs: null`: back to automatic. The offset is already cleared; the source goes back on the aligner (searching,
   * starting at the last good delay of the box microphone, else headroom + the setting, as at the start). A graph that is
   * manual by its plan (a camera without sound) keeps its fixed offset, now the setting's. The box microphone of a
   * box-pulled live stays un-held (`syncVolumes`).
   */
  private clearOffset(s: Session, id: AddedAudioId): void {
    // build 6: back to the setting, else the default join delay
    if (s.solo !== null) return this.applySoloDelay(s, id);
    const mixer = s.mixer;
    if (mixer === null || !s.graphAdded.has(id)) return;
    const headroom = this.timing.headroomMs;
    if (this.alignMode(s, [...s.graphAdded]) === 'manual') {
      void mixer.setDelay(id, headroom + this.settingsOffset(id, s));
      return;
    }
    const start = id === 'boxInput' && this.boxPulled(s) ? (this.lastGoodDelay.get('boxInput') ?? headroom + this.settingsOffset('boxInput', s)) : DEFAULT_INITIAL_DELAY_MS;
    s.aligner?.setAuto(id, start);
    s.alignStates.set(id, 'searching');
    void mixer.setDelay(id, start);
    this.ev('aligner_state', { source: id, state: 'searching', delayMs: start, residualMs: null });
  }

  /** A12: a hand-set offset of the box microphone reaches the running combiner as headroom + offset and takes the source off the aligner. */
  private applyBoxOffset(s: Session): void {
    if (s.solo !== null) return this.applySoloDelay(s, 'boxInput');
    const mixer = s.mixer;
    if (mixer === null || s.boxOffsetMs === null || !s.graphAdded.has('boxInput')) return;
    s.aligner?.setManual('boxInput');
    s.alignStates.set('boxInput', 'manual');
    void mixer.setDelay('boxInput', this.timing.headroomMs + s.boxOffsetMs);
    this.ev('aligner_state', { source: 'boxInput', state: 'manual', delayMs: this.timing.headroomMs + s.boxOffsetMs, residualMs: null });
  }

  /**
   * S3: Skrin (and the informational Merakam flag) changed during the live. The caller rules are the route's (as for Stop).
   * The last destination on cannot be turned off (409 `last_output`). The kiosk event is published at once and the TV sound
   * leg follows; the combiner, the relay and the iPad's recording reader keep running.
   */
  setOutputs(req: { sessionId: string; kiosk: boolean; recording?: boolean }, actor: string, deviceId: string | null): LiveStatus {
    const s = this.session;
    if (s === null || s.id !== req.sessionId) throw new LiveError(409, 'no_session', LIVE_MSG.noSession);
    // the Merakam flag is the starting device's own (it is the one that records): any other caller leaves the stored value
    const recording = deviceId !== null && deviceId === s.deviceId ? (req.recording ?? s.outputs.recording) : s.outputs.recording;
    // YouTube counts only while a broadcast exists or is being made (`outputs.youtube` stays true when it never came up)
    const youtubeLive = s.outputs.youtube && (s.broadcastId !== null || s.ytPending);
    if (!req.kiosk && !youtubeLive && recording !== true) throw new LiveError(409, 'last_output', LIVE_MSG.lastOutput);
    const before = { ...s.outputs };
    s.kioskRestored = false; // a person has set the switch: the notice has done its work
    s.outputs = { ...s.outputs, kiosk: req.kiosk, ...(recording !== undefined ? { recording } : {}) };
    if (before.kiosk !== s.outputs.kiosk || before.recording !== s.outputs.recording) {
      this.audit('live-outputs', s.id, actor, before, { kiosk: s.outputs.kiosk, youtube: s.outputs.youtube, ...(s.outputs.recording !== undefined ? { recording: s.outputs.recording } : {}) });
      this.ev('outputs', { kiosk: s.outputs.kiosk, youtube: s.outputs.youtube, recording: s.outputs.recording ?? null });
      this.record((store) => store.setOutputs(s.id, s.outputs));
    }
    this.publishKiosk();
    return this.status(deviceId);
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
      // A8: benched after two stalls: the camera sound carries the live meanwhile (warning `audio_source_lost`)
      if (id === 'boxInput' && added && s.benchActive) state = 'lost';
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
      if (id === 'boxInput') {
        // build 5: seconds at or under -70 dBFS, reported from the tenth silent second (the state stays `ok`)
        const silentMs = this.boxMicSilentMs(s, this.d.now().getTime());
        if (silentMs !== undefined && silentMs >= 10_000) row.noSignalSeconds = Math.floor(silentMs / 1000);
      }
      // build 6: one sound, joined to the picture with a fixed delay (hand-set, the setting, or the default); never measured
      if (added && s.combined) row.align = { state: 'manual', delayMs: this.soloDelay(id, s) };
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
