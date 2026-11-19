/** Shapes of the live feature shared by the box, the kiosk and the app. */

import type { AlignState, AudioSourceId, LiveAudioMix, LiveVideoSource } from './sources.ts';

export type LiveSource = 'android' | 'web';

export interface LiveOutputs {
  kiosk: true;
  youtube: boolean;
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
   */
  avOffsetMs?: number;
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
  /** The picture source of the running live; optional while an older box or session does not report it. */
  video?: LiveVideoSource;
  /** Per-source health of the audio mix, as the box knows it (a phone live fills its own screen from its engine). */
  audio?: { sources: LiveAudioSourceStatus[] };
  ingest: { ready: boolean; protocol: 'whip' | 'srt' | null; bitrateKbps: number; since: string | null };
  relay: { state: 'off' | 'starting' | 'running' | 'retrying' | 'failed'; restarts: number; lastError: string | null; stderrTail?: string[] };
  youtube: {
    signedIn: boolean;
    channelTitle: string | null;
    broadcastId: string | null;
    state: 'none' | 'created' | 'testing' | 'live' | 'complete' | 'error';
    health: 'noData' | 'bad' | 'ok' | 'good' | null;
    watchUrl: string | null;
    lastError: string | null;
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
