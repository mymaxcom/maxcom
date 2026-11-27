import { describe, expect, it } from 'vitest';
import { BOX_MIC_SILENT_DB, BOX_MIC_SOUND_DB, LevelMeter } from '../src/live/levels.ts';

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

describe('LevelMeter silence and sound runs (build 5)', () => {
  const RATE = 16000;
  const WINDOW = 6400; // 400 ms
  /** One 400 ms window, two channels: channel 0 constant at `a0`, channel 1 at `a1` (int16 amplitude). */
  const windowOf = (a0: number, a1: number): Buffer => {
    const buf = Buffer.alloc(WINDOW * 4);
    for (let f = 0; f < WINDOW; f++) {
      buf.writeInt16LE(a0, f * 4);
      buf.writeInt16LE(a1, f * 4 + 2);
    }
    return buf;
  };
  const SILENT = 0; // -90
  const BETWEEN = 20; // about -64 dBFS
  const LOUD = 3277; // about -20 dBFS

  it('exports the two thresholds', () => {
    expect(BOX_MIC_SILENT_DB).toBe(-70);
    expect(BOX_MIC_SOUND_DB).toBe(-60);
  });

  it('silence for N windows grows silentMs and one loud window resets it', () => {
    const m = new LevelMeter(['camera', 'boxInput'], RATE);
    for (let i = 0; i < 5; i++) m.feed(windowOf(LOUD, SILENT));
    expect(m.silentMs(1)).toBe(2000);
    expect(m.silentMs(0)).toBe(0);
    m.feed(windowOf(LOUD, LOUD));
    expect(m.silentMs(1)).toBe(0);
    expect(m.soundMs(1)).toBe(400);
  });

  it('a run at or above -60 grows soundMs', () => {
    const m = new LevelMeter(['camera', 'boxInput'], RATE);
    for (let i = 0; i < 8; i++) m.feed(windowOf(LOUD, LOUD));
    expect(m.soundMs(1)).toBe(3200);
  });

  it('a window between -70 and -60 resets both runs', () => {
    const m = new LevelMeter(['camera', 'boxInput'], RATE);
    for (let i = 0; i < 4; i++) m.feed(windowOf(LOUD, SILENT));
    expect(m.silentMs(1)).toBe(1600);
    m.feed(windowOf(LOUD, BETWEEN));
    expect(m.level(1)).toBeGreaterThan(-70);
    expect(m.level(1)).toBeLessThan(-60);
    expect(m.silentMs(1)).toBe(0);
    expect(m.soundMs(1)).toBe(0);
  });

  it('takeSoundMs keeps the longest run since the last read, so a phrase between two reads still counts', () => {
    const m = new LevelMeter(['camera', 'boxInput'], RATE);
    for (let i = 0; i < 8; i++) m.feed(windowOf(LOUD, LOUD)); // 3.2 s of sound
    m.feed(windowOf(LOUD, SILENT)); // then a dip: the current run is 0
    expect(m.soundMs(1)).toBe(0);
    expect(m.takeSoundMs(1)).toBe(3200);
    // read once: the count starts again
    expect(m.takeSoundMs(1)).toBe(0);
    // a single loud window is only 400 ms
    m.feed(windowOf(LOUD, LOUD));
    expect(m.takeSoundMs(1)).toBe(400);
    // a run in progress carries over to the next read and keeps growing
    for (let i = 0; i < 3; i++) m.feed(windowOf(LOUD, LOUD));
    expect(m.takeSoundMs(1)).toBe(1600);
    expect(m.takeSoundMs(1)).toBe(1600);
    m.feed(windowOf(LOUD, LOUD));
    expect(m.takeSoundMs(1)).toBe(2000);
    expect(m.takeSoundMs(7)).toBeUndefined();
  });

  it('Q9: the first feed after a stale gap starts the runs again', () => {
    let t = 1000;
    const m = new LevelMeter(['camera', 'boxInput'], RATE, () => t, 3000);
    for (let i = 0; i < 5; i++) m.feed(windowOf(LOUD, SILENT));
    expect(m.silentMs(1)).toBe(2000);
    t += 5000; // the combiner restarted
    m.feed(windowOf(LOUD, SILENT));
    expect(m.silentMs(1)).toBe(400);
    // the sound run is also fresh
    m.feed(windowOf(LOUD, LOUD));
    expect(m.soundMs(1)).toBe(400);
    t += 5000;
    m.feed(windowOf(LOUD, LOUD));
    expect(m.soundMs(1)).toBe(400);
    expect(m.takeSoundMs(1)).toBe(400);
  });

  it('a stale meter and an unknown channel answer undefined', () => {
    let t = 1000;
    const m = new LevelMeter(['camera', 'boxInput'], RATE, () => t, 3000);
    expect(m.silentMs(1)).toBeUndefined();
    m.feed(windowOf(LOUD, SILENT));
    expect(m.silentMs(1)).toBe(400);
    expect(m.silentMs(5)).toBeUndefined();
    expect(m.silentMs(-1)).toBeUndefined();
    t += 3001;
    expect(m.silentMs(1)).toBeUndefined();
    expect(m.soundMs(1)).toBeUndefined();
  });
});
