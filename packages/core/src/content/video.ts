/**
 * The Video content kind (2026.11.13): limits, coded errors and the YouTube link reader. One constant each, so a
 * change of mind after the device review is one line here (the box, the TV and the app all read these).
 */

/** The limits of a video. Every number the operator may change after the device review lives here. */
export const VIDEO_LIMITS = {
  /** Highest output picture height (720p); the app shrinks a larger video on the phone. */
  maxHeight: 720,
  /** Longest a video is shown, in seconds (10 minutes); a longer one is refused (upload) or cut short on the TV. */
  maxSeconds: 600,
  /** Largest single uploaded file. */
  maxFileBytes: 300 * 1024 * 1024,
  /** Total room all uploaded videos may take on the box. */
  totalBytes: 1024 * 1024 * 1024,
  /** An upload is refused when the box would keep less than this free afterwards. */
  minFreeBytes: 500 * 1024 * 1024,
} as const;

/** Sound switch default (decision 1): a video is silent unless its own switch says otherwise. */
export const VIDEO_SOUND_DEFAULT = false;

/** The MIME type the box stores and serves an uploaded video as (MP4, H.264 only). */
export const VIDEO_MIME = 'video/mp4';

/**
 * The coded errors of the upload route (`code` in the answer); the app maps each to its own text. `busy` (409): another
 * video is being received; the box takes one upload at a time.
 */
export const VIDEO_ERROR_CODES = ['too_big', 'too_long', 'not_h264', 'no_space', 'upload_failed', 'busy'] as const;
export type VideoErrorCode = (typeof VIDEO_ERROR_CODES)[number];

export type VideoSource = 'upload' | 'youtube' | 'rakaman';
export const VIDEO_SOURCES: readonly VideoSource[] = ['upload', 'youtube', 'rakaman'];

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
export const isYoutubeId = (v: unknown): v is string => typeof v === 'string' && YT_ID.test(v);

/**
 * The 11-character video id of what the person pasted: the bare id, a youtu.be/<id> link, a watch?v=<id> link, or a
 * /shorts/, /embed/, /live/ or /v/ path (also on m., music. and www.youtube-nocookie.com). Null when it is none of
 * these (a playlist or channel link has no single video).
 */
export function parseYoutubeId(input: string): string | null {
  const text = input.trim();
  if (isYoutubeId(text)) return text;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/')[1] ?? '';
    return isYoutubeId(id) ? id : null;
  }
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
  const v = url.searchParams.get('v');
  if (v !== null && isYoutubeId(v)) return v;
  const m = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/.exec(url.pathname);
  return m ? m[1]! : null;
}

/** The effective length of a video's slot in the rotation, in whole seconds: its known length, capped at the limit. */
export function videoSlotSeconds(v: { durationSec?: number; startSec?: number; endSec?: number }): number {
  const start = v.startSec ?? 0;
  const raw = v.endSec !== undefined ? v.endSec - start : v.durationSec !== undefined ? v.durationSec - start : VIDEO_LIMITS.maxSeconds;
  return Math.max(1, Math.min(VIDEO_LIMITS.maxSeconds, Math.floor(raw)));
}

/**
 * What this server release supports that an older one does not, as `features` in `GET /api/health` (anonymous and
 * signed in). The app shows the Video kind and the poster "Regangkan gambar" switch only when its server lists them, and
 * Arabic (العربية) in "Bahasa skrin TV" only when it lists `tvLangAr` (the settings validation accepts lang 'ar').
 */
export const SERVER_FEATURES = ['video', 'posterStretch', 'tvLangAr'] as const;
export type ServerFeature = (typeof SERVER_FEATURES)[number];
