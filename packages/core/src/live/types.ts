/** Shapes of the live feature shared by the box, the kiosk and the app. */

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
}

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
   * Standing warnings the app shows on the live screen: `media_ports_blocked` (the box's firewall rules for
   * the media ports are missing or wrong) and `no_video_from_device` (no picture 12 s after the start).
   */
  warnings: string[];
  ingest: { ready: boolean; protocol: 'whip' | 'srt' | null; bitrateKbps: number; since: string | null };
  relay: { state: 'off' | 'starting' | 'running' | 'retrying' | 'failed'; restarts: number; lastError: string | null };
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
  /** The MediaMTX path the kiosk's WHEP reads: `surau-kiosk` only while the audio leg runs, else `surau`. A change means: reconnect. */
  path?: 'surau' | 'surau-kiosk';
}
