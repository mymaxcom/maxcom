/**
 * Detects a video decoder that never produces a frame while real video keeps arriving (a WebView that lost its
 * graphics context cannot create a decoder: the connection looks fine, bytes flow, `framesDecoded` stays 0).
 * Pure: the caller feeds periodic samples from `RTCPeerConnection.getStats()`; there are no timers in here.
 */

/** Time from the first video bytes with no decoded frame before the watch reports stuck. */
export const DECODE_STUCK_MS = 20_000;
/** Video bytes that must have arrived in that time: real video, not a trickle. */
export const MIN_VIDEO_BYTES = 200_000;

export interface DecodeSample {
  atMs: number;
  /** Inbound video `bytesReceived`, or null when the report has no inbound video. */
  videoBytes: number | null;
  /** Inbound video `framesDecoded`, or null when missing. */
  framesDecoded: number | null;
}

export interface DecodeWatch {
  /** Feed one sample; true exactly once, when the decoder counts as stuck. */
  feed(s: DecodeSample): boolean;
}

export function createDecodeWatch(): DecodeWatch {
  let done = false;
  let baseAt: number | null = null;
  let baseBytes = 0;
  return {
    feed(s: DecodeSample): boolean {
      if (done) return false;
      if (typeof s.framesDecoded === 'number' && s.framesDecoded > 0) {
        done = true;
        return false;
      }
      if (typeof s.videoBytes !== 'number' || !(s.videoBytes > 0)) return false;
      if (baseAt === null) {
        baseAt = s.atMs;
        baseBytes = s.videoBytes;
        return false;
      }
      if (s.framesDecoded !== 0) return false;
      if (s.atMs - baseAt >= DECODE_STUCK_MS && s.videoBytes - baseBytes >= MIN_VIDEO_BYTES) {
        done = true;
        return true;
      }
      return false;
    },
  };
}
