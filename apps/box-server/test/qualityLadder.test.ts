import { describe, expect, it } from 'vitest';
import { QualityLadder } from '../src/live/qualityLadder.ts';

const behind = (b: number | null, speed: number | null = 1.0): { behindSeconds: number | null; speed: number | null } => ({ behindSeconds: b, speed });

describe('QualityLadder', () => {
  it('starts full and ignores a small lag', () => {
    const l = new QualityLadder();
    expect(l.quality).toBe('full');
    expect(l.gaveUp).toBe(false);
    for (let t = 0; t <= 60_000; t += 1000) expect(l.tick(t, behind(5.9))).toBeNull();
    expect(l.quality).toBe('full');
  });

  it('goes down after 10 s above 6 s behind, not after 9', () => {
    const a = new QualityLadder();
    expect(a.tick(0, behind(7))).toBeNull();
    expect(a.tick(9000, behind(7))).toBeNull();
    expect(a.quality).toBe('full');
    const b = new QualityLadder();
    b.tick(0, behind(7));
    expect(b.tick(10_000, behind(7))).toBe('low');
    expect(b.quality).toBe('low');
    expect(b.tick(11_000, behind(7))).toBeNull();
  });

  it('exactly 6 s behind is not above the limit', () => {
    const l = new QualityLadder();
    l.tick(0, behind(6));
    expect(l.tick(20_000, behind(6))).toBeNull();
  });

  it('a dip, or a null sample, breaks the run', () => {
    const l = new QualityLadder();
    l.tick(0, behind(8));
    l.tick(8000, behind(8));
    expect(l.tick(9000, behind(null))).toBeNull();
    expect(l.tick(10_000, behind(8))).toBeNull();
    expect(l.tick(19_000, behind(8))).toBeNull();
    expect(l.tick(20_000, behind(8))).toBe('low');
    const m = new QualityLadder();
    m.tick(0, behind(8));
    m.tick(9000, behind(2));
    expect(m.tick(10_000, behind(8))).toBeNull();
  });

  const toLow = (l: QualityLadder): number => {
    l.tick(0, behind(9));
    l.tick(10_000, behind(9));
    expect(l.quality).toBe('low');
    return 10_000;
  };

  it('goes up after 180 s under 1 s behind, not before', () => {
    const l = new QualityLadder();
    const t0 = toLow(l);
    expect(l.tick(t0, behind(0.5))).toBeNull();
    expect(l.tick(t0 + 179_000, behind(0.5))).toBeNull();
    expect(l.tick(t0 + 180_000, behind(0.5))).toBe('full');
    expect(l.quality).toBe('full');
    expect(l.gaveUp).toBe(false);
  });

  it('a null or a lagging sample restarts the 180 s count', () => {
    const l = new QualityLadder();
    const t0 = toLow(l);
    l.tick(t0, behind(0.5));
    l.tick(t0 + 100_000, behind(null));
    l.tick(t0 + 101_000, behind(0.5));
    expect(l.tick(t0 + 250_000, behind(0.5))).toBeNull();
    expect(l.tick(t0 + 281_000, behind(0.5))).toBe('full');
    const m = new QualityLadder();
    const t1 = toLow(m);
    m.tick(t1, behind(0.5));
    m.tick(t1 + 170_000, behind(1.5));
    expect(m.tick(t1 + 185_000, behind(0.5))).toBeNull();
  });

  it('gives up when low still runs slower than real time for 10 s: full once, then no more changes', () => {
    const l = new QualityLadder({ slowGraceMs: 0 });
    const t0 = toLow(l);
    expect(l.tick(t0, behind(9, 0.8))).toBeNull();
    expect(l.tick(t0 + 9000, behind(9, 0.8))).toBeNull();
    expect(l.tick(t0 + 10_000, behind(9, 0.8))).toBe('full');
    expect(l.quality).toBe('full');
    expect(l.gaveUp).toBe(true);
    for (let t = t0 + 11_000; t < t0 + 400_000; t += 1000) expect(l.tick(t, behind(20, 0.5))).toBeNull();
    expect(l.quality).toBe('full');
    l.reset();
    expect(l.gaveUp).toBe(false);
    expect(l.quality).toBe('full');
    l.tick(0, behind(9));
    expect(l.tick(10_000, behind(9))).toBe('low');
  });

  it('a null speed breaks the slow run', () => {
    const l = new QualityLadder({ slowGraceMs: 0 });
    const t0 = toLow(l);
    l.tick(t0, behind(9, 0.8));
    l.tick(t0 + 8000, behind(9, null));
    expect(l.tick(t0 + 12_000, behind(9, 0.8))).toBeNull();
    expect(l.tick(t0 + 22_000, behind(9, 0.8))).toBe('full');
    expect(l.gaveUp).toBe(true);
  });

  it('B7b: the speed is ignored for 30 s after the ladder went low (the new run settles first)', () => {
    const l = new QualityLadder();
    const t0 = toLow(l);
    for (let t = t0; t < t0 + 30_000; t += 1000) expect(l.tick(t, behind(9, 0.5))).toBeNull();
    expect(l.quality).toBe('low');
    expect(l.gaveUp).toBe(false);
    // after the grace a slow run of 10 s still gives up
    expect(l.tick(t0 + 30_000, behind(9, 0.5))).toBeNull();
    expect(l.tick(t0 + 40_000, behind(9, 0.5))).toBe('full');
    expect(l.gaveUp).toBe(true);
  });

  it('B7c: after the third step down in one live the ladder stays low and is locked', () => {
    const l = new QualityLadder({ downForMs: 1000, upAfterMs: 1000 });
    let t = 0;
    for (let n = 1; n <= 3; n++) {
      l.tick(t, behind(9));
      expect(l.tick((t += 1000), behind(9))).toBe('low');
      expect(l.locked).toBe(n === 3);
      if (n < 3) {
        l.tick((t += 1000), behind(0.5));
        expect(l.tick((t += 1000), behind(0.5))).toBe('full');
      }
    }
    for (let k = 0; k < 400; k++) expect(l.tick((t += 1000), behind(k % 2 === 0 ? 0.2 : 9, 0.3))).toBeNull();
    expect(l.quality).toBe('low');
    l.reset();
    expect(l.locked).toBe(false);
    expect(l.quality).toBe('full');
  });

  it('B5: abandon() returns to full and gives up (no further changes until reset)', () => {
    const l = new QualityLadder();
    toLow(l);
    l.abandon();
    expect(l.quality).toBe('full');
    expect(l.gaveUp).toBe(true);
    l.tick(100_000, behind(20));
    expect(l.tick(200_000, behind(20))).toBeNull();
    l.reset();
    expect(l.gaveUp).toBe(false);
  });

  it('honours custom limits', () => {
    const l = new QualityLadder({ downBehindS: 2, downForMs: 1000 });
    l.tick(0, behind(3));
    expect(l.tick(1000, behind(3))).toBe('low');
  });
});
