/* B6: the two-step quality ladder of the YouTube leg. The relay reports how far it is behind real time and how fast
   ffmpeg runs; this class turns those readings into a request for `low` (480p) or `full`. It holds no timers: the
   caller ticks it (the session poll) with the clock and the latest readings. */

export type LadderQuality = 'full' | 'low';

export interface LadderInput {
  behindSeconds: number | null;
  speed: number | null;
}

export interface LadderOptions {
  /** Behind more than this many seconds ... (default 6) */
  downBehindS?: number;
  /** ... for this long without a break lowers the quality (default 10000 ms). */
  downForMs?: number;
  /** In low, behind under this many seconds ... (default 1) */
  upBehindS?: number;
  /** ... for this long without a break returns to full (default 180000 ms). */
  upAfterMs?: number;
  /** In low, a speed under this value ... (default 1.0) */
  slowSpeed?: number;
  /** ... for this long without a break gives the ladder up: back to full for good (default 10000 ms). */
  slowForMs?: number;
  /** The speed is not read for this long after the ladder went low: the new run settles first (default 30000 ms). */
  slowGraceMs?: number;
  /** After this many steps down in one live the ladder stays low for good (default 3; `locked`). */
  maxDowns?: number;
}

export class QualityLadder {
  private readonly downBehindS: number;
  private readonly downForMs: number;
  private readonly upBehindS: number;
  private readonly upAfterMs: number;
  private readonly slowSpeed: number;
  private readonly slowForMs: number;
  private readonly slowGraceMs: number;
  private readonly maxDowns: number;
  private current: LadderQuality = 'full';
  private gave = false;
  private downs = 0;
  private lowAt: number | null = null;
  private downSince: number | null = null;
  private upSince: number | null = null;
  private slowSince: number | null = null;

  constructor(o: LadderOptions = {}) {
    this.downBehindS = o.downBehindS ?? 6;
    this.downForMs = o.downForMs ?? 10_000;
    this.upBehindS = o.upBehindS ?? 1;
    this.upAfterMs = o.upAfterMs ?? 180_000;
    this.slowSpeed = o.slowSpeed ?? 1.0;
    this.slowForMs = o.slowForMs ?? 10_000;
    this.slowGraceMs = o.slowGraceMs ?? 30_000;
    this.maxDowns = o.maxDowns ?? 3;
  }

  /** True after `maxDowns` steps down in one live: the ladder stays low, no further changes until reset(). */
  get locked(): boolean {
    return this.downs >= this.maxDowns;
  }

  /** The low step failed (the caller saw the relay not run): back to full and given up, no further changes until reset(). */
  abandon(): void {
    this.current = 'full';
    this.gave = true;
    this.clearRuns();
  }

  get quality(): LadderQuality {
    return this.current;
  }

  /** True once low did not help (the output still ran slower than real time): no further changes until reset(). */
  get gaveUp(): boolean {
    return this.gave;
  }

  /** The new quality when this reading changes it, else null. A null reading breaks the run it was part of. */
  tick(nowMs: number, i: LadderInput): LadderQuality | null {
    if (this.gave || (this.locked && this.current === 'low')) return null;
    if (this.current === 'full') {
      if (i.behindSeconds !== null && i.behindSeconds > this.downBehindS) {
        this.downSince ??= nowMs;
        if (nowMs - this.downSince >= this.downForMs) {
          this.current = 'low';
          this.downs++;
          this.lowAt = nowMs;
          this.clearRuns();
          return 'low';
        }
      } else {
        this.downSince = null;
      }
      return null;
    }
    // the first seconds of a low run say nothing about its speed
    const inGrace = this.lowAt !== null && nowMs - this.lowAt < this.slowGraceMs;
    if (!inGrace && i.speed !== null && i.speed < this.slowSpeed) {
      this.slowSince ??= nowMs;
      if (nowMs - this.slowSince >= this.slowForMs) {
        this.current = 'full';
        this.gave = true;
        this.clearRuns();
        return 'full';
      }
    } else {
      this.slowSince = null;
    }
    if (i.behindSeconds !== null && i.behindSeconds < this.upBehindS) {
      this.upSince ??= nowMs;
      if (nowMs - this.upSince >= this.upAfterMs) {
        this.current = 'full';
        this.clearRuns();
        return 'full';
      }
    } else {
      this.upSince = null;
    }
    return null;
  }

  /** Back to full with every run and the give-up cleared (a new live). */
  reset(): void {
    this.current = 'full';
    this.gave = false;
    this.downs = 0;
    this.lowAt = null;
    this.clearRuns();
  }

  private clearRuns(): void {
    this.downSince = null;
    this.upSince = null;
    this.slowSince = null;
  }
}
