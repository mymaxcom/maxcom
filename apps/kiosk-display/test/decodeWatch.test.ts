import { describe, expect, it } from 'vitest';
import { DECODE_STUCK_MS, MIN_VIDEO_BYTES, createDecodeWatch } from '../src/data/decodeWatch.ts';

describe('decodeWatch', () => {
  it('exports the thresholds', () => {
    expect(DECODE_STUCK_MS).toBe(20_000);
    expect(MIN_VIDEO_BYTES).toBe(200_000);
  });

  it('reports stuck once when video bytes grow and no frame decodes for 20 s', () => {
    const w = createDecodeWatch();
    expect(w.feed({ atMs: 0, videoBytes: 10_000, framesDecoded: 0 })).toBe(false);
    expect(w.feed({ atMs: 10_000, videoBytes: 150_000, framesDecoded: 0 })).toBe(false);
    expect(w.feed({ atMs: 20_000, videoBytes: 400_000, framesDecoded: 0 })).toBe(true);
    expect(w.feed({ atMs: 25_000, videoBytes: 800_000, framesDecoded: 0 })).toBe(false);
    expect(w.feed({ atMs: 60_000, videoBytes: 9_000_000, framesDecoded: 0 })).toBe(false);
  });

  it('does not fire before DECODE_STUCK_MS', () => {
    const w = createDecodeWatch();
    w.feed({ atMs: 1000, videoBytes: 0, framesDecoded: 0 });
    w.feed({ atMs: 1000, videoBytes: 1000, framesDecoded: 0 });
    expect(w.feed({ atMs: 20_999, videoBytes: 5_000_000, framesDecoded: 0 })).toBe(false);
    expect(w.feed({ atMs: 21_000, videoBytes: 5_000_000, framesDecoded: 0 })).toBe(true);
  });

  it('never fires once a frame has decoded', () => {
    const w = createDecodeWatch();
    w.feed({ atMs: 0, videoBytes: 1000, framesDecoded: 0 });
    expect(w.feed({ atMs: 5000, videoBytes: 100_000, framesDecoded: 3 })).toBe(false);
    expect(w.feed({ atMs: 40_000, videoBytes: 9_000_000, framesDecoded: 0 })).toBe(false);
  });

  it('never fires on null video stats', () => {
    const w = createDecodeWatch();
    expect(w.feed({ atMs: 0, videoBytes: null, framesDecoded: null })).toBe(false);
    expect(w.feed({ atMs: 30_000, videoBytes: null, framesDecoded: null })).toBe(false);
    expect(w.feed({ atMs: 60_000, videoBytes: 5_000_000, framesDecoded: null })).toBe(false);
    expect(w.feed({ atMs: 90_000, videoBytes: 9_000_000, framesDecoded: null })).toBe(false);
  });

  it('never fires on a trickle below MIN_VIDEO_BYTES', () => {
    const w = createDecodeWatch();
    w.feed({ atMs: 0, videoBytes: 1000, framesDecoded: 0 });
    expect(w.feed({ atMs: 30_000, videoBytes: 1000 + MIN_VIDEO_BYTES - 1, framesDecoded: 0 })).toBe(false);
  });
});
