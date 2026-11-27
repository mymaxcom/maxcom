import { cpus } from 'node:os';

/**
 * The CPU figure of this box (build 5): whole-machine use, read from the cumulative CPU times the operating system
 * reports. The figure is the average of the samples of the last 30 s; a running average of the whole live is kept too.
 * Where the platform reports no CPU times (some Android builds) the sampler has no figure and every answer is undefined.
 */

/** Cumulative CPU time of the machine, summed over every core, in any one unit: `idle` is the part spent doing nothing. */
export interface CpuTotals {
  idle: number;
  total: number;
}

/** Reads the totals now; null when the platform reports none. May throw: the sampler treats that as none. */
export type CpuReader = () => CpuTotals | null;

/** `os.cpus()` costs a few milliseconds on Windows: a reading younger than this is reused. */
const OS_READ_MIN_MS = 500;
let osRead: { at: number; value: CpuTotals | null } | null = null;

/** The default reader: `os.cpus()` summed over the cores. */
export const osCpuReader: CpuReader = () => {
  const at = Date.now();
  if (osRead !== null && at >= osRead.at && at - osRead.at < OS_READ_MIN_MS) return osRead.value;
  const list = cpus();
  let value: CpuTotals | null = null;
  if (Array.isArray(list) && list.length > 0) {
    let idle = 0;
    let total = 0;
    for (const c of list) {
      const t = c.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    if (total > 0) value = { idle, total };
  }
  osRead = { at, value };
  return value;
};

/** The window the figure is averaged over. */
export const CPU_WINDOW_MS = 30_000;

interface Sample {
  /** When the sample was taken, and when the interval it covers began. */
  t: number;
  from: number;
  percent: number;
}

export class CpuSampler {
  private readonly read: CpuReader;
  private last: { t: number; totals: CpuTotals } | null = null;
  private samples: Sample[] = [];
  private sum = 0;
  private count = 0;

  constructor(read: CpuReader = osCpuReader) {
    this.read = read;
  }

  /** Reads the CPU times and adds one sample for the time since the previous call; the first call only sets the baseline. */
  sample(nowMs: number): void {
    let totals: CpuTotals | null;
    try {
      totals = this.read();
    } catch {
      totals = null;
    }
    if (totals === null || !Number.isFinite(totals.total) || !Number.isFinite(totals.idle)) {
      this.last = null;
      return;
    }
    const prev = this.last;
    this.last = { t: nowMs, totals };
    if (prev === null) return;
    const dTotal = totals.total - prev.totals.total;
    const dIdle = totals.idle - prev.totals.idle;
    // no time moved (or the counters went back): no sample
    if (!(dTotal > 0) || dIdle < 0) return;
    const percent = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
    this.samples.push({ t: nowMs, from: prev.t, percent });
    this.sum += percent;
    this.count++;
    this.trim(nowMs);
  }

  private trim(nowMs: number): void {
    while (this.samples.length > 0 && nowMs - this.samples[0]!.t > CPU_WINDOW_MS) this.samples.shift();
  }

  /** The average of the last 30 s as a whole number 0..100; undefined when there is no sample in the window. */
  percent(nowMs: number): number | undefined {
    this.trim(nowMs);
    if (this.samples.length === 0) return undefined;
    let sum = 0;
    for (const x of this.samples) sum += x.percent;
    return Math.round(sum / this.samples.length);
  }

  /**
   * True when the window covers at least `minSpanMs` and every sample in it is above `threshold` (percent). A window
   * that is shorter than that is never "above for 30 s".
   */
  allAbove(threshold: number, nowMs: number, minSpanMs: number): boolean {
    this.trim(nowMs);
    const first = this.samples[0];
    const lastSample = this.samples[this.samples.length - 1];
    if (first === undefined || lastSample === undefined) return false;
    if (lastSample.t - first.from < minSpanMs) return false;
    return this.samples.every((x) => x.percent > threshold);
  }

  /** The average over everything sampled since the last `reset`, as a whole number 0..100; undefined when nothing was. */
  runningPercent(): number | undefined {
    return this.count === 0 ? undefined : Math.round(this.sum / this.count);
  }

  /** A new live: forget the window, the baseline and the running average. */
  reset(): void {
    this.last = null;
    this.samples = [];
    this.sum = 0;
    this.count = 0;
  }
}
