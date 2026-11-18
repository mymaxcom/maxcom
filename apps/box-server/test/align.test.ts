import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { AddedAudioId, AlignState } from '@surau/core';
import { Aligner, estimateLag, MIN_DELAY_MS } from '../src/live/align.ts';
// @ts-expect-error plain .mjs script without a declaration file
import { addNoise, addRoom, invert, makeMaster, RATE } from '../../../scripts/test/make-align-vectors.mjs';

const dir = new URL('./fixtures/align/', import.meta.url);
function load(name: string): Int16Array {
  const b = readFileSync(new URL(`${name}.s16`, dir));
  return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')) as {
  vectors: Array<{ file: string; expectedLagMs: number | null }>;
};

describe('estimateLag on the shared fixtures', () => {
  const ref = load('ref');
  for (const v of manifest.vectors.filter((x) => x.expectedLagMs !== null)) {
    it(`${v.file} is found within 20 ms of ${v.expectedLagMs} ms`, () => {
      const est = estimateLag(ref, load(v.file.replace('.s16', '')), RATE, 4000);
      expect(est).not.toBeNull();
      expect(Math.abs(est!.lagMs - v.expectedLagMs!)).toBeLessThanOrEqual(20);
      expect(est!.confidence).toBeGreaterThanOrEqual(0.45);
    });
  }

  it('gives no result on silence', () => {
    expect(estimateLag(ref, load('silence'), RATE, 4000)).toBeNull();
    expect(estimateLag(load('silence'), ref, RATE, 4000)).toBeNull();
  });

  it('gives no confident result for unrelated sound', () => {
    const other = new Int16Array(makeMaster(9, 99).map((x: number) => Math.round(x * 32767)));
    const est = estimateLag(ref, other, RATE, 4000);
    expect(est === null || est.confidence < 0.45).toBe(true);
  });

  it('is accurate to a few ms on a clean copy and negative when the source is late', () => {
    const m = makeMaster(14, 5);
    const toS16 = (x: Float32Array) => Int16Array.from(x, (v) => Math.round(v * 32767));
    const refc = toS16(m.slice(0, 9 * RATE));
    const early = toS16(m.slice(Math.round(0.9 * RATE), Math.round(0.9 * RATE) + 9 * RATE));
    expect(Math.abs(estimateLag(refc, early, RATE, 4000)!.lagMs - 900)).toBeLessThan(3);
    const late = toS16(m.slice(0, 9 * RATE));
    const refLate = toS16(m.slice(Math.round(0.6 * RATE), Math.round(0.6 * RATE) + 9 * RATE));
    expect(Math.abs(estimateLag(refLate, late, RATE, 4000)!.lagMs + 600)).toBeLessThan(3);
  });

  it('CPU: one analysis of an 8 s window (bench note)', () => {
    const r8 = ref.subarray(0, 8 * RATE);
    const s8 = load('lag-1250').subarray(0, 8 * RATE);
    estimateLag(r8, s8, RATE, 4000);
    const t0 = performance.now();
    const n = 10;
    for (let i = 0; i < n; i++) estimateLag(r8, s8, RATE, 4000);
    const ms = (performance.now() - t0) / n;
    console.log(`bench: estimateLag 8 s window, +-4 s, 16 kHz: ${ms.toFixed(1)} ms CPU per call (this laptop)`);
    expect(ms).toBeLessThan(250);
  });
});

/* Closed-loop simulator: plays the combiner. The added source is `earlyMs` ahead of the reference (plus drift), the
   monitor carries it after the delay the aligner asked for. Residual (what the aligner must drive to 0) = early - delay. */
interface SimOpts {
  source: Float32Array; // what the added mic hears (already with noise, room, polarity)
  ref: Float32Array;
  earlyMs: number;
  ppm?: number;
  initialDelayMs?: number;
}
function simulate(opts: SimOpts, channels = 1) {
  const em = new EventEmitter();
  const states: AlignState[] = [];
  const applied: number[] = [];
  let delay = opts.initialDelayMs ?? 1000;
  let n = 0; // sample position
  let lockedAt: number | null = null;
  const al = new Aligner({
    monitor: em as unknown as Readable,
    added: ['boxInput'] as AddedAudioId[],
    sampleRate: RATE,
    maxLagMs: 4000,
    initialDelayMs: delay,
    apply: (_id, d) => {
      applied.push(d);
      delay = d;
    },
    onState: (_id, s) => {
      states.push(s);
      if (s === 'locked' && lockedAt === null) lockedAt = n / RATE;
    },
  });
  al.start();
  const k = 1 + (opts.ppm ?? 0) * 1e-6;
  const at = (p: number) => {
    if (p < 0) return 0;
    const j = Math.floor(p);
    const f = p - j;
    return (opts.source[j] ?? 0) * (1 - f) + (opts.source[j + 1] ?? 0) * f;
  };
  const residual = () => opts.earlyMs + (opts.ppm ?? 0) * 1e-6 * (n / RATE) * 1000 - delay;
  /** Feed `seconds` of monitor sound in 0.5 s chunks; `mute` zeroes both channels (silence in the room). */
  const run = (seconds: number, mute = false, src2?: Float32Array) => {
    const chunk = RATE / 2;
    for (let done = 0; done < seconds * RATE; done += chunk) {
      const buf = Buffer.alloc(chunk * 2 * (1 + channels));
      for (let i = 0; i < chunk; i++) {
        const nn = n + i;
        const r = mute ? 0 : (opts.ref[nn] ?? 0);
        const s = mute ? 0 : src2 ? (src2[nn] ?? 0) : at(nn * k + ((opts.earlyMs - delay) / 1000) * RATE);
        buf.writeInt16LE(Math.round(r * 32767), i * 4);
        buf.writeInt16LE(Math.round(s * 32767), i * 4 + 2);
      }
      n += chunk;
      em.emit('data', buf);
    }
  };
  return { al, states, applied, run, residual, secs: () => n / RATE, delay: () => delay, lockedAt: () => lockedAt };
}

const SECS = 200;
const master = makeMaster(SECS + 6, 31);

describe('Aligner closed loop', () => {
  it('searching -> locked -> holding, within the target, with the median rule', () => {
    const sim = simulate({ ref: master, source: master, earlyMs: 1730 });
    sim.run(45);
    expect(sim.states).toEqual(['searching', 'locked']);
    expect(Math.abs(sim.residual())).toBeLessThanOrEqual(20);
    expect(sim.secs()).toBeLessThan(60);
    console.log(`bench: first lock after ${sim.lockedAt()} s of sound, ${sim.applied.length} correction(s)`);
    expect(sim.lockedAt()!).toBeLessThan(40);
    sim.run(20, true);
    expect(sim.states).toEqual(['searching', 'locked', 'holding']);
    expect(sim.al.state('boxInput')).toBe('holding');
    sim.run(20);
    expect(sim.al.state('boxInput')).toBe('locked');
    const first = sim.applied[0];
    expect(first).toBeGreaterThan(1000);
    // first lock was found with a few corrections only (no hunting)
    expect(sim.applied.length).toBeLessThanOrEqual(3);
    const st = sim.al.stats();
    console.log(`bench: Aligner ${st.ticks} ticks, ${(st.cpuMs / st.ticks).toFixed(1)} ms CPU per tick (worst ${st.maxCpuMs.toFixed(1)} ms), 1 added source`);
  });

  it('locks through noise, room echo and inverted polarity', () => {
    const cases: Array<[string, Float32Array]> = [
      ['noise', addNoise(master.subarray(0, 60 * RATE), 6)],
      ['echo', addRoom(master.subarray(0, 60 * RATE))],
      ['inverted', invert(master.subarray(0, 60 * RATE))],
    ];
    for (const [name, source] of cases) {
      const sim = simulate({ ref: master, source, earlyMs: 2500 });
      sim.run(55);
      expect(sim.al.state('boxInput'), name).toBe('locked');
      expect(Math.abs(sim.residual()), name).toBeLessThanOrEqual(20);
    }
  });

  it('never applies a delay below the minimum (a late source clamps)', () => {
    const sim = simulate({ ref: master, source: master, earlyMs: -800, initialDelayMs: 100 });
    sim.run(50);
    expect(sim.applied.length).toBeGreaterThan(0);
    for (const d of sim.applied) expect(d).toBeGreaterThanOrEqual(MIN_DELAY_MS);
    expect(Math.min(...sim.applied)).toBe(MIN_DELAY_MS);
    expect(sim.al.state('boxInput')).not.toBe('locked');
  });

  it('is never started at a delay of 0', () => {
    const sim = simulate({ ref: master, source: master, earlyMs: 300, initialDelayMs: 0 });
    expect(sim.delay()).toBe(0); // the harness records what it passed; the aligner clamps its own view
    expect(sim.al.delayMs('boxInput')).toBeGreaterThanOrEqual(MIN_DELAY_MS);
  });

  it('is failed after 60 s without a lock, keeps searching, and locks when the sound matches', () => {
    const unrelated = makeMaster(SECS + 6, 1234);
    const sim = simulate({ ref: master, source: master, earlyMs: 500 });
    sim.run(57, false, unrelated);
    expect(sim.states).toEqual(['searching']);
    sim.run(6, false, unrelated);
    expect(sim.states).toEqual(['searching', 'failed']);
    expect(sim.applied.length).toBe(0);
    sim.run(50);
    expect(sim.states).toEqual(['searching', 'failed', 'locked']);
    expect(Math.abs(sim.residual())).toBeLessThanOrEqual(20);
  });

  it('silence alone never fails or locks', () => {
    const sim = simulate({ ref: master, source: master, earlyMs: 500 });
    sim.run(90, true);
    expect(sim.states).toEqual(['searching']);
    expect(sim.applied).toEqual([]);
  });

  it('corrects slow drift in small steps and stays within the target', () => {
    const ppm = 300; // far worse than a real clock pair, so the test is short
    const sim = simulate({ ref: master, source: master, earlyMs: 1200, ppm });
    sim.run(40);
    expect(sim.states).toEqual(['searching', 'locked']);
    const before = sim.applied.length;
    const firstDrift = sim.applied.slice();
    let worst = 0;
    for (let i = 0; i < 24; i++) {
      sim.run(5);
      worst = Math.max(worst, Math.abs(sim.residual()));
    }
    const drift = sim.applied.slice(before);
    expect(drift.length).toBeGreaterThan(2);
    let prev = firstDrift[firstDrift.length - 1]!;
    for (const d of drift) {
      expect(Math.abs(d - prev)).toBeLessThanOrEqual(5);
      prev = d;
    }
    expect(worst).toBeLessThanOrEqual(20);
    expect(sim.al.state('boxInput')).toBe('locked');
  });

  it('reset() starts searching again and manual stops analysis', () => {
    const sim = simulate({ ref: master, source: master, earlyMs: 900 });
    sim.run(40);
    expect(sim.al.state('boxInput')).toBe('locked');
    sim.al.reset('boxInput');
    expect(sim.al.state('boxInput')).toBe('searching');
    sim.al.setManual('boxInput');
    expect(sim.al.state('boxInput')).toBe('manual');
    const n = sim.applied.length;
    sim.run(30);
    expect(sim.applied.length).toBe(n);
  });

  it('stop() detaches from the monitor', () => {
    const sim = simulate({ ref: master, source: master, earlyMs: 900 });
    sim.al.stop();
    sim.run(30);
    expect(sim.applied).toEqual([]);
  });
});

describe('monitor restart (round 2 review fixes)', () => {
  it('drops a partial frame left over from the old combiner run', () => {
    const em = new EventEmitter();
    const al = new Aligner({ monitor: em as unknown as Readable, added: ['boxInput'] as AddedAudioId[], sampleRate: RATE, maxLagMs: 4000, initialDelayMs: 1000, apply: () => {}, onState: () => {} });
    al.start();
    em.emit('data', Buffer.alloc(3)); // one byte too many for a mono s16 frame pair... leaves a partial frame
    expect((al as unknown as { leftover: Buffer }).leftover.length).toBeGreaterThan(0);
    em.emit('restart');
    expect((al as unknown as { leftover: Buffer }).leftover.length).toBe(0);
    al.stop();
  });
});
