import { describe, expect, it } from 'vitest';
import { LevelMeter } from '../src/live/levels.ts';

describe('LevelMeter reset (round 2 review fixes)', () => {
  it('reset drops a partial frame so the next run starts on a frame boundary', () => {
    const m = new LevelMeter(['camera', 'deviceMic'], 16000);
    m.feed(Buffer.alloc(3)); // 3 bytes of a 4-byte frame
    m.reset();
    // a full window of loud frames now reads exactly as loud, not shifted by the stale byte
    const frames = 6400;
    const buf = Buffer.alloc(frames * 4);
    for (let f = 0; f < frames; f++) {
      buf.writeInt16LE(16384, f * 4);
      buf.writeInt16LE(0, f * 4 + 2);
    }
    m.feed(buf);
    expect(m.level(0)).toBeCloseTo(-6, 0);
    expect(m.level(1)).toBe(-90);
  });
});
