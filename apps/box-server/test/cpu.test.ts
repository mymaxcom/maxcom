import { describe, expect, it } from 'vitest';
import { CpuSampler, osCpuReader } from '../src/live/cpu.ts';
import type { CpuTotals } from '../src/live/cpu.ts';

/** A reader whose totals the test moves: `busy` and `idle` are added per call. */
function fakeReader(): { read: () => CpuTotals | null; add: (busy: number, idle: number) => void; set: (v: CpuTotals | null) => void } {
  let cur: CpuTotals | null = { idle: 0, total: 0 };
  return {
    read: () => (cur === null ? null : { ...cur }),
    add: (busy, idle) => {
      cur = { idle: (cur?.idle ?? 0) + idle, total: (cur?.total ?? 0) + busy + idle };
    },
    set: (v) => {
      cur = v;
    },
  };
}

describe('CpuSampler', () => {
  it('gives the percent of busy time between two samples', () => {
    const r = fakeReader();
    const c = new CpuSampler(r.read);
    c.sample(0);
    expect(c.percent(0)).toBeUndefined();
    r.add(30, 70);
    c.sample(2000);
    expect(c.percent(2000)).toBe(30);
    r.add(50, 50);
    c.sample(4000);
    expect(c.percent(4000)).toBe(40);
  });

  it('answers undefined when the reader gives no cores', () => {
    const c = new CpuSampler(() => null);
    c.sample(0);
    c.sample(2000);
    expect(c.percent(2000)).toBeUndefined();
    expect(c.runningPercent()).toBeUndefined();
    expect(c.allAbove(85, 2000, 0)).toBe(false);
  });

  it('answers undefined when a reader throws, and when no time moved', () => {
    const t = new CpuSampler(() => {
      throw new Error('no cpu');
    });
    t.sample(0);
    t.sample(2000);
    expect(t.percent(2000)).toBeUndefined();
    const r = fakeReader();
    const c = new CpuSampler(r.read);
    c.sample(0);
    c.sample(2000); // totals did not move
    expect(c.percent(2000)).toBeUndefined();
  });

  it('drops samples older than 30 s', () => {
    const r = fakeReader();
    const c = new CpuSampler(r.read);
    c.sample(0);
    r.add(100, 0);
    c.sample(2000); // 100 percent
    r.add(0, 100);
    c.sample(34_000); // 0 percent, the first sample is 32 s old
    expect(c.percent(34_000)).toBe(0);
    // with nothing newer the window empties
    expect(c.percent(70_000)).toBeUndefined();
  });

  it('allAbove needs the whole span and every sample over the threshold', () => {
    const r = fakeReader();
    const c = new CpuSampler(r.read);
    c.sample(0);
    let t = 0;
    for (let i = 0; i < 12; i++) {
      t += 2000;
      r.add(90, 10);
      c.sample(t);
    }
    expect(c.allAbove(85, t, 28_000)).toBe(false); // 24 s only
    for (let i = 0; i < 3; i++) {
      t += 2000;
      r.add(90, 10);
      c.sample(t);
    }
    expect(c.allAbove(85, t, 28_000)).toBe(true);
    // one sample at 85 or under breaks it
    t += 2000;
    r.add(85, 15);
    c.sample(t);
    expect(c.allAbove(85, t, 28_000)).toBe(false);
  });

  it('keeps a running average of the live and forgets it on reset', () => {
    const r = fakeReader();
    const c = new CpuSampler(r.read);
    c.sample(0);
    r.add(20, 80);
    c.sample(2000);
    r.add(60, 40);
    c.sample(4000);
    expect(c.runningPercent()).toBe(40);
    c.reset();
    expect(c.runningPercent()).toBeUndefined();
    expect(c.percent(4000)).toBeUndefined();
  });

  it('the default reader reads this machine without throwing', () => {
    const c = new CpuSampler(osCpuReader);
    c.sample(0);
    c.sample(1000);
    const p = c.percent(1000);
    if (p !== undefined) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(100);
    }
  });
});
