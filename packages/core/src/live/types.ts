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
  };
}

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
}
