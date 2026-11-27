/** Shapes of the live feature shared by the box, the kiosk and the app. */

import type { AddedAudioId, AlignState, AudioSourceId, LiveAudioMix, LiveVideoSource } from './sources.ts';

export type LiveSource = 'android' | 'web';

export interface LiveOutputs {
  /**
   * The Skrin (TVs and linked boxes). Older apps always send true. 2026.11.15 build 4: may be false at start when YouTube
   * is on or `recording` is true (else 400 `no_destination`), and is changed during the live by `POST /api/live/outputs`.
   */
  kiosk: boolean;
  youtube: boolean;
  /** Informational (2026.11.15 build 4): the sending device records the live (Merakam). The box never records by itself. */
  recording?: boolean;
}

/** Who sends the YouTube leg: the publishing device itself, or the box (ffmpeg relay). */
export type YoutubeVia = 'device' | 'box';

export interface LiveStartRequest {
  kuliahId: string | null;
  source: LiveSource;
  outputs: LiveOutputs;
  youtubeVia: YoutubeVia;
  /**
   * The picture source and the audio mix (plan 4.2). Optional so an older app, which sends neither, still starts a
   * live: the box then reads `phone` with the phone's own microphone, exactly today's flow.
   */
  video?: LiveVideoSource;
  audio?: LiveAudioMix;
  /**
   * Re-attach (2026.11.15): the device that already owns the running session asks for it back with fresh targets,
   * after the app was restarted. The box answers with that session; a resume whose kuliah, source or outputs differ
   * from the running session is refused with 409 `resume_mismatch`. Absent or false = an ordinary start. Additive.
   */
  resume?: boolean;
  /**
   * Who pulls the external camera (2026.11.15), see `videoPathOf`: `device` (the default: the starting phone pulls it
   * and pushes the picture to the box) or `box` (the box pulls it; the phone only controls, and records nothing).
   * Read only when `video` is `external`. Additive: an older app sends nothing and gets `device`.
   */
  videoPath?: LiveVideoPath;
}

/** Who pulls the external camera of a live: the starting device, or the box itself. */
export const LIVE_VIDEO_PATHS = ['device', 'box'] as const;
export type LiveVideoPath = (typeof LIVE_VIDEO_PATHS)[number];
/** Operator decision of 22 Nov 2026: the starting phone pulls by default; the box pull is an admin choice. */
export const LIVE_VIDEO_PATH_DEFAULT: LiveVideoPath = 'device';

export function isLiveVideoPath(v: unknown): v is LiveVideoPath {
  return v === 'device' || v === 'box';
}

/**
 * The `resume` and `videoPath` fields of a start body, checked for shape only. Null = refuse the body (400). An
 * absent field stays absent, so an older app's body gives `{}`.
 */
export function parseLiveStartOptions(body: unknown): { resume?: boolean; videoPath?: LiveVideoPath } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { resume, videoPath } = body as { resume?: unknown; videoPath?: unknown };
  if (resume !== undefined && typeof resume !== 'boolean') return null;
  if (videoPath !== undefined && !isLiveVideoPath(videoPath)) return null;
  return { ...(resume !== undefined ? { resume } : {}), ...(videoPath !== undefined ? { videoPath } : {}) };
}

/**
 * Who pulls the camera in a live with this request. A live on the device's own camera is always `device`. A browser
 * cannot pull a camera, so its external live is always `box` whatever it sent. An Android phone pulls the external
 * camera itself unless it asked for `box`.
 */
export function videoPathOf(req: Pick<LiveStartRequest, 'source' | 'video' | 'videoPath'>): LiveVideoPath {
  if (req.video !== 'external') return 'device';
  if (req.source === 'web') return 'box';
  return req.videoPath ?? LIVE_VIDEO_PATH_DEFAULT;
}

/**
 * Refusal codes added in 2026.11.15 (the `error` field of a refused live, YouTube or WHEP call), each with its HTTP
 * status in `LIVE_REFUSAL_STATUS`:
 * - `resume_mismatch`: a `resume` start whose kuliah, source or outputs differ from the running session.
 * - `camera_in_use`: the camera's full address is asked for by a device that does not hold the camera (see `LiveCameraUse`).
 * - `youtube_live_not_enabled`: live streaming is not switched on for the YouTube channel.
 * - `box_clock_wrong`: Google refused the box because its clock is wrong.
 * - `youtube_busy_other_box`: a linked box on the SAME YouTube channel id has a broadcast open.
 * - `too_many_viewers`: every viewer slot of the box is taken (a further TV).
 * - `preview_off` (2026.11.15 build 4): the live shows no picture on this device (a box-pulled live: the picture is seen on
 *   the TVs and on YouTube; only the iPad's browser owner keeps its one reader, to record).
 * - `last_output`: `POST /api/live/outputs` would leave Skrin, YouTube and Merakam all off.
 * - `no_destination` (400): the start refusal for the same case (YouTube counts only when it is enabled and signed in).
 */
export const LIVE_REFUSALS = [
  'resume_mismatch',
  'camera_in_use',
  'youtube_live_not_enabled',
  'box_clock_wrong',
  'youtube_busy_other_box',
  'too_many_viewers',
  'preview_off',
  'last_output',
  'no_destination',
] as const;
export type LiveRefusal = (typeof LIVE_REFUSALS)[number];
export const LIVE_REFUSAL_STATUS: Readonly<Record<LiveRefusal, number>> = {
  resume_mismatch: 409,
  camera_in_use: 409,
  youtube_live_not_enabled: 409,
  box_clock_wrong: 409,
  youtube_busy_other_box: 409,
  too_many_viewers: 429,
  preview_off: 409,
  last_output: 409,
  no_destination: 400,
};

export function isLiveRefusal(v: unknown): v is LiveRefusal {
  return typeof v === 'string' && (LIVE_REFUSALS as readonly string[]).includes(v);
}

/**
 * The "camera in use" flag of one camera (operator decision of 22 Nov 2026), set by the box on the first pull of a
 * live and cleared when that live ends. Every other admin app reads it in `LiveStatus.cameraUse` and JOINS the shared
 * picture through the box (the preview the box already serves) instead of pulling the same camera again.
 */
export interface LiveCameraUse {
  /** Which camera. A box holds one camera record today, named `external`; the id leaves room for more. */
  cameraId: string;
  /** The live that holds the camera. */
  sessionId: string;
  /** Who pulls it: `device` (the phone named in `by`) or `box` (the box itself, for the device named in `by`). */
  via: LiveVideoPath;
  /** Which device: its display name, and whether it is the caller's own device. Never the raw device id. */
  by: { name: string; mine: boolean };
  /** Since when (ISO time of the first pull). */
  since: string;
}

/**
 * May this device open its own RTSP pull of `cameraId`? False = free, or this device already holds the flag with a
 * device pull. True = another device pulls it, or the box does: join the shared picture through the box instead.
 */
export function cameraUseBlocksPull(use: readonly LiveCameraUse[] | undefined, cameraId: string): boolean {
  const u = use?.find((c) => c.cameraId === cameraId);
  if (u === undefined) return false;
  return u.via === 'box' || !u.by.mine;
}

/* ---------------------------------------------------------------- camera control (Lane X) */

/** The network control protocol of a camera: the camera's own HTTP interface (default), OSC over TCP, or VISCA over IP (UDP). */
export const CAMERA_CONTROL_PROTOCOLS = ['http', 'osc', 'visca'] as const;
export type CameraControlProtocol = (typeof CAMERA_CONTROL_PROTOCOLS)[number];

/** Focus mode of the one-tap profile: continuous autofocus, single autofocus, manual. */
export const CAMERA_FOCUS_MODES = ['continuous', 'single', 'manual'] as const;
export type CameraFocusMode = (typeof CAMERA_FOCUS_MODES)[number];

/** Automatic tracking of the profile: off, or follow a person. */
export const CAMERA_TRACKING_MODES = ['off', 'human'] as const;
export type CameraTrackingMode = (typeof CAMERA_TRACKING_MODES)[number];

/** The per-camera profile "Terapkan tetapan kamera" sends in one tap: position, focus, tracking, brightness (EV, steps of 0.5). */
export interface CameraProfile {
  preset: 1 | 2 | 3;
  focus: CameraFocusMode;
  tracking: CameraTrackingMode;
  exposureEv: number;
}

export const CAMERA_PROFILE_DEFAULT: CameraProfile = { preset: 1, focus: 'continuous', tracking: 'off', exposureEv: 0 };

/** A profile from untrusted input (a request body or a stored record): every field checked; null when anything is off. Missing fields take the default only when `fill` is true. */
export function parseCameraProfile(v: unknown, fill = false): CameraProfile | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const d = CAMERA_PROFILE_DEFAULT;
  const preset = o.preset === undefined && fill ? d.preset : o.preset;
  const focus = o.focus === undefined && fill ? d.focus : o.focus;
  const tracking = o.tracking === undefined && fill ? d.tracking : o.tracking;
  const ev = o.exposureEv === undefined && fill ? d.exposureEv : o.exposureEv;
  if (preset !== 1 && preset !== 2 && preset !== 3) return null;
  if (!(CAMERA_FOCUS_MODES as readonly unknown[]).includes(focus)) return null;
  if (!(CAMERA_TRACKING_MODES as readonly unknown[]).includes(tracking)) return null;
  if (typeof ev !== 'number' || !Number.isFinite(ev) || ev < -3 || ev > 3 || Math.round(ev * 2) !== ev * 2) return null;
  return { preset, focus: focus as CameraFocusMode, tracking: tracking as CameraTrackingMode, exposureEv: ev };
}

/** The per-camera opt-in kept with the saved camera: off by default; off = the control route answers 404. */
export interface CameraControlSetting {
  enabled: boolean;
  protocol: CameraControlProtocol;
  /** What the one-tap action sends. */
  profile: CameraProfile;
  /** Send the profile once when a live that uses this camera starts (best effort, off by default). */
  applyOnLive: boolean;
}

export const CAMERA_CONTROL_DEFAULT: CameraControlSetting = { enabled: false, protocol: 'http', profile: CAMERA_PROFILE_DEFAULT, applyOnLive: false };

/**
 * The exposure compensation steps the camera accepts, in tenths of an EV (-3.0 to +3.0). A requested value is moved to
 * the nearest one of these.
 */
export const CAMERA_EXPOSURE_STEPS: readonly number[] = [-30, -27, -23, -20, -17, -13, -10, -7, -3, 0, 3, 7, 10, 13, 17, 20, 23, 27, 30];

/** The fixed list of camera actions; nothing free-form. `ev` is in EV (-3 to 3), `preset` is 1 to 3. `applyProfile` sends the SAVED profile. */
export type CameraControlRequest =
  | { action: 'exposure'; ev: number }
  | { action: 'preset'; preset: 1 | 2 | 3 }
  | { action: 'resetPosition' }
  | { action: 'aiTracking'; on: boolean }
  | { action: 'applyProfile' };

/** One step of the profile: what was sent and whether the camera confirmed it. */
export type CameraProfileStepName = 'preset' | 'focus' | 'tracking' | 'exposure';
export interface CameraProfileStepResult {
  step: CameraProfileStepName;
  sent: boolean;
  confirmed: boolean;
}

/** The answer of the control route: `sent` = the message left the box; `confirmed` = the camera answered within a second. */
export interface CameraControlResult {
  sent: boolean;
  confirmed: boolean;
  /** Only for `applyProfile`: each step in the order sent. `sent` = any step left the box; `confirmed` = every step was confirmed. */
  steps?: CameraProfileStepResult[];
}

/** A stretch of a live with no picture reaching the box (`ingest`) or no data reaching YouTube (`youtube`). ISO times. */
export interface LiveGap {
  from: string;
  to: string;
  kind: 'ingest' | 'youtube';
  /** The YouTube broadcast the gap belongs to; only on `youtube` gaps. */
  broadcastId?: string;
}

export function isLiveGap(v: unknown): v is LiveGap {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const g = v as Record<string, unknown>;
  if (typeof g.from !== 'string' || typeof g.to !== 'string') return false;
  if (g.kind !== 'ingest' && g.kind !== 'youtube') return false;
  return g.broadcastId === undefined || typeof g.broadcastId === 'string';
}

/**
 * One row of the box's `live_sessions` table (migration 031): written at start and stop, gaps appended while the live
 * runs. Held PER BOX: each box records its own lives and streams to its own YouTube channel (`youtubeChannelId`).
 * `GET /api/live/sessions/recent` answers `LiveSessionSummary`, which leaves `ownerDeviceId` out.
 */
export interface LiveSessionRecord {
  id: string;
  surauId: string;
  /** The box that ran the live. */
  boxId: string;
  /** The device that started it. Box-internal: never sent to an app (the routes answer `mine` instead). */
  ownerDeviceId: string;
  /** Display name of the person who started it. */
  startedBy: string;
  kuliahId: string | null;
  source: LiveSource;
  video: LiveVideoSource;
  videoPath: LiveVideoPath;
  outputs: LiveOutputs;
  youtubeVia: YoutubeVia;
  /** The YouTube channel this box was signed in to at the start; null when YouTube was off or not signed in. */
  youtubeChannelId: string | null;
  startedAt: string;
  /** Null while the live runs. */
  stoppedAt: string | null;
  /** Why it ended (`stopped`, `timeout`, `controller_lost`, `camera_lost`, `shutdown`, `system`); null while it runs. */
  reason: string | null;
  /** Every YouTube broadcast of this live, oldest first (a restart inside the linger window reuses the last one). */
  broadcastIds: string[];
  gaps: LiveGap[];
  /** Sum of the gaps in whole seconds. */
  gapSeconds: number;
}

/** A `LiveSessionRecord` as `GET /api/live/sessions/recent` sends it: no device id, `mine` for the caller instead. */
export type LiveSessionSummary = Omit<LiveSessionRecord, 'ownerDeviceId'> & { mine: boolean };

/** How many rows `GET /api/live/sessions/recent` answers at most. */
export const LIVE_SESSIONS_RECENT_MAX = 10;

/** One open YouTube broadcast as a linked box reports it to a peer that is about to create its own. */
export interface YoutubeOpenBroadcast {
  boxId: string;
  /** The YouTube channel id of that box's sign-in; null when it cannot tell. */
  channelId: string | null;
  broadcastId: string;
}

/**
 * The one-live-per-channel rule between linked boxes. YouTube is PER BOX: each box links and streams to its own
 * channel, so a peer's open broadcast blocks only when it is on the SAME channel id. Boxes on different channels, and
 * a box whose channel id is unknown on either side, never block each other.
 */
export function youtubeBusyOnPeer(ownChannelId: string | null, peersOpen: readonly YoutubeOpenBroadcast[]): boolean {
  if (ownChannelId === null || ownChannelId === '') return false;
  return peersOpen.some((p) => p.channelId === ownChannelId);
}

/** `POST /api/live/audio`: the starting device changes the mix during a box-combined live. */
export interface LiveAudioChangeRequest {
  audio: LiveAudioMix;
  /**
   * Mid-live switch of the picture, the starting device only, for a live that started with the box pulling the external
   * camera: `phone` = the iPad's own camera (its stream becomes the unit), `external` = back to the camera. Additive.
   */
  video?: LiveVideoSource;
  /**
   * The audio offset of the added microphone (`deviceMic`) while the box mixes it by hand (a camera without audio),
   * 0..2000 ms in steps of 50. The box delays that source by headroom + this value. Additive.
   * 2026.11.15 build 4: also the box microphone (`avOffsetId: 'boxInput'`, default for a box-pulled live with the box
   * microphone). `null` means "back to automatic": the hand-set offset is cleared and the source goes back on the aligner.
   */
  avOffsetMs?: number | null;
  /** Which added source `avOffsetMs` is for (additive). Default: the box microphone of a box-pulled live, else `deviceMic`. */
  avOffsetId?: AddedAudioId;
}

/** Health of one audio source in a running live (plan 4.7). `align` only on added sources. */
export interface LiveAudioSourceStatus {
  id: AudioSourceId;
  enabled: boolean;
  volume: number;
  state: 'ok' | 'silent' | 'lost';
  align?: { state: AlignState; delayMs: number; residualMs?: number };
  /** Level of the source in dBFS (RMS over about 400 ms, -90..0) while the box combiner runs; absent otherwise. Additive. */
  level?: number;
  /**
   * Box microphone row only (2026.11.15 build 5): seconds the microphone has been at or under -70 dBFS, present from the
   * first silent second (also before the warning `box_mic_silent`). The row state stays `ok`. Additive.
   */
  noSignalSeconds?: number;
}

/** Standing warnings of the live screen (`LiveStatus.warnings` holds these as text). */
export const LIVE_WARNINGS = [
  'media_ports_blocked',
  'no_video_from_device',
  'no_video_from_camera',
  'audio_source_lost',
  'audio_align_searching',
  'audio_align_failed',
  'audio_mix_failed',
  'audio_all_muted',
  'camera_no_audio',
  'reencode_unsupported',
  // C3, C4 (2026.11.15): the pulled camera sends well above the configured maximum; the camera sends H.265
  'camera_bitrate_high',
  'camera_h265',
  // 2026.11.15 build 4: a box-pulled live runs until a person stops it; no device polled the status for 10 minutes;
  // the camera's own bitrate fell far under its usual level (another reader of the camera, or a weak link)
  'controller_quiet',
  'camera_slow',
  // build 4 gate: YouTube did not deliver and the box turned Skrin back on so the live still has a destination
  'kiosk_restored',
  // 2026.11.15 build 5: the box microphone is in the mix above volume 0 and stayed at or under -70 dBFS for 60 s (cleared
  // at or above -60 dBFS for 3 s); this box is busy: CPU above 85% for 30 s while its own TV and another TV play the live
  'box_mic_silent',
  'server_busy',
  // 2026.11.15 build 6: the box microphone drops frames; the YouTube leg is 4 s or more behind; the picture was lowered to 480p
  'box_mic_drops',
  'upload_behind',
  'quality_lowered',
] as const;
export type LiveWarning = (typeof LIVE_WARNINGS)[number];

export interface LiveStatus {
  session: {
    id: string;
    kuliahId: string | null;
    source: LiveSource;
    outputs: LiveOutputs;
    youtubeVia: YoutubeVia;
    startedAt: string;
    startedBy: string;
    /**
     * The caller's own device started this session (2026.11.15; computed per caller, never the raw device id): the
     * app adopts it after a restart and shows the normal stop. Additive: absent on an older box, read as false.
     */
    mine?: boolean;
    /** Who pulls the camera of this live (see `videoPathOf`). Additive: absent on an older box. */
    videoPath?: LiveVideoPath;
    /**
     * The box pulls the camera now and the unit is that camera: false after a switch to the iPad's own camera, and for a live a
     * device runs itself. The box's own truth for the control card and the Stop rights. Additive: absent on an older box.
     */
    boxPulled?: boolean;
    /**
     * The live STARTED box-pulled (the box pulled the camera when it began): it never ends by itself and any `live:control`
     * holder may stop it, also after a switch to the iPad's own camera. Additive: absent on an older box.
     */
    startedBoxPulled?: boolean;
  } | null;
  mediamtx: { running: boolean; tools: { mediamtx: boolean; ffmpeg: boolean } };
  /**
   * Standing warnings the app shows on the live screen (see `LIVE_WARNINGS`): `media_ports_blocked` (the box's
   * firewall rules for the media ports are missing or wrong), `no_video_from_device` (no picture 12 s after the
   * start), and the external-camera and audio-mix warnings of plan 4.7.
   */
  warnings: string[];
  /** The box's ffmpeg can encode H.264 ("Kod semula" works); additive, absent on an older box. */
  relayReencode?: boolean;
  /** The live notice text was edited in this live (same value as `KioskLive.noticeRev`); absent until then. */
  noticeRev?: number;
  /**
   * The TVs of the surau while a live runs, one entry per TV (additive; absent on an older box): `playing` (watching),
   * `connecting` (joining), `off` (its profile switches the live picture off). `tvId` is `self` for the box's own TV.
   */
  viewers?: { tvId: string; name: string; state: 'playing' | 'connecting' | 'off' }[];
  /**
   * THIS BOX's stored YouTube choice for its next live (2026.11.15). Per box: each box keeps its own destination
   * memory and its own YouTube channel, so linked boxes may differ. The box is the single truth; the app shows this
   * value and keeps a tapped choice only until the status agrees. Additive: absent on an older box.
   */
  nextLiveOn?: boolean;
  /**
   * Seconds since the STARTING device last polled the status of a running box-pulled live (2026.11.15 build 4; a poll of
   * any other device does not clear it); 0 for every other live. The warning `controller_quiet` shows from 10 minutes.
   * Additive: absent on an older box.
   */
  controllerQuietSeconds?: number;
  /** The box accepts `POST /api/live/outputs` (Skrin on and off during a live). Absent on an older box. Additive. */
  canToggleKiosk?: boolean;
  /**
   * The camera's own bitrate (kbps) averaged over the last 30 s of a box-pulled live, read from the camera's path, not the
   * box output (2026.11.15 build 4). Absent until 20 s of samples exist and for lives that do not pull the camera. Additive.
   */
  cameraKbps?: number;
  /**
   * Whole-machine CPU of this box (the live server), integer 0..100, averaged over the last 30 s (2026.11.15 build 5).
   * Present only while a live runs and the platform reports CPU times. Additive.
   */
  cpuPercent?: number;
  /** CPU average (integer 0..100) over the last ended live; kept in memory only, gone after a restart. Additive. */
  lastLiveCpuPercent?: number;
  /** Gap seconds of the running live so far, as the box recorded them (`LiveSessionRecord.gapSeconds`); 0 with no session. Additive. */
  gapSeconds?: number;
  /** Every YouTube broadcast of the running live, oldest first; empty with no session. Additive. */
  broadcastIds?: string[];
  /**
   * The cameras a live holds right now, one entry per camera in use; empty when none is. An app must not open its own
   * RTSP pull of a camera listed here unless `cameraUseBlocksPull` says it may. Additive: absent on an older box.
   */
  cameraUse?: LiveCameraUse[];
  /** The picture source of the running live; optional while an older box or session does not report it. */
  video?: LiveVideoSource;
  /** Per-source health of the audio mix, as the box knows it (a phone live fills its own screen from its engine). */
  audio?: { sources: LiveAudioSourceStatus[] };
  ingest: { ready: boolean; protocol: 'whip' | 'srt' | null; bitrateKbps: number; since: string | null };
  relay: {
    state: 'off' | 'starting' | 'running' | 'retrying' | 'failed';
    restarts: number;
    lastError: string | null;
    stderrTail?: string[];
    /** Seconds the YouTube leg is behind real time; absent until measured. */
    behindSeconds?: number;
    /** `low` while the picture is lowered to 480p. */
    quality?: 'full' | 'low';
  };
  youtube: {
    signedIn: boolean;
    channelTitle: string | null;
    broadcastId: string | null;
    state: 'none' | 'created' | 'testing' | 'live' | 'complete' | 'error';
    health: 'noData' | 'bad' | 'ok' | 'good' | null;
    watchUrl: string | null;
    lastError: string | null;
    /**
     * The YouTube channel id of THIS BOX's sign-in (2026.11.15; public, not a secret): the key of the linked-boxes
     * busy check (`youtubeBusyOnPeer`). Null when signed out or not known. Additive: absent on an older box.
     */
    channelId?: string | null;
    /**
     * The device-code sign-in the server itself is carrying (release 2026.11.13): `pending` with the code to show,
     * or the `denied` / `expired` outcome for a couple of minutes after it ended; null when nothing is pending.
     * Absent on an older box. Never holds a token or the device code.
     */
    signIn?: YoutubeSignInState | null;
    /**
     * Release 2026.11.13: false when this server cannot sign in or out (the cloud: the grant is held by the surau's
     * box, sign-in is at the surau). Absent means it can (a box, or an older server).
     */
    signInHere?: boolean;
    /**
     * The sign-in in three states, not two (additive; absent on an older box). Here the broadcast already owns `state`,
     * so the account view is one object; `GET /api/live/youtube/status` carries the same four fields flat.
     */
    account?: YoutubeAccountView;
  };
}

/** `signedIn`, `signedOut` (a real sign-out, or Google withdrew the grant) or `unknown` (the box cannot tell right now: never shown as signed out). */
export interface YoutubeAccountView {
  state: YoutubeAccountState;
  /** `reauthorise` (Google withdrew the grant), `signed_out`, or for `unknown` `token_unreadable`, `handover_pending`, `cloud_unreachable`. */
  reason: YoutubeAccountReason | null;
  /** The last time the sign-in was seen working; kept across restarts so `unknown` can still name the channel. */
  lastGood: YoutubeLastGood | null;
  /** When Google withdrew the grant (ISO time), persisted across restarts; null otherwise. */
  revokedAt: string | null;
}

export type YoutubeAccountState = 'signedIn' | 'signedOut' | 'unknown';
export type YoutubeAccountReason = 'reauthorise' | 'signed_out' | 'token_unreadable' | 'handover_pending' | 'cloud_unreachable';
export interface YoutubeLastGood {
  signedIn: true;
  channelTitle: string | null;
  /** ISO time the sign-in was last seen working. */
  at: string;
}

/** Where the sign-in code is typed: always Google's own page (a box and an app never use any other address). */
export const GOOGLE_DEVICE_URL = 'https://www.google.com/device';

/** The server-held YouTube sign-in as every app sees it. */
export type YoutubeSignInState =
  | { state: 'pending'; userCode: string; verificationUrl: string; expiresAt: string }
  | { state: 'denied' | 'expired' };

/** What the kiosk needs to know about the live. */
export interface KioskLive {
  live: boolean;
  since: string | null;
  kuliah: { label: string; penceramah: string; topic: string | null } | null;
  audio: boolean;
  volume: number;
  /**
   * The camera is lost: the TV and YouTube hold the last picture with the card "Siaran akan bersambung sebentar
   * lagi" while the sound may keep going. Absent or false = normal.
   */
  waiting?: boolean;
  /** The MediaMTX path the kiosk's WHEP reads: `surau-kiosk` only while the audio leg runs, else `surau`. A change means: reconnect. */
  path?: 'surau' | 'surau-kiosk';
  /** The surau's live notice text was edited (changes with every edit); the apps re-read `GET /api/live/notice`. Absent: never edited in this live. */
  noticeRev?: number;
}
