/**
 * Per-source level meter on the combiner monitor (s16le, interleaved, channel 0 = unit, then the added sources).
 * RMS in dBFS over a window of about 400 ms of monitor time; a source that has not been measured for `staleMs` of
 * wall time reads as unknown (the combiner is restarting or stalled).
 */

import { demuxMonitor } from './mixer.ts';

export const LEVEL_WINDOW_MS = 400;
export const LEVEL_FLOOR_DB = -90;

export class LevelMeter {
  private readonly ids: readonly string[];
  private readonly rate: number;
  private readonly now: () => number;
  private readonly staleMs: number;
  private readonly n: number;
  private readonly win: number;
  private rest: Buffer = Buffer.alloc(0);
  private sum: number[];
  private count = 0;
  private last: Array<number | null>;
  private lastAt = 0;

  constructor(ids: readonly string[], rate: number, now: () => number = Date.now, staleMs = 3000) {
    this.ids = ids;
    this.rate = rate;
    this.now = now;
    this.staleMs = staleMs;
    this.n = ids.length;
    this.win = Math.max(1, Math.round((rate * LEVEL_WINDOW_MS) / 1000));
    this.sum = new Array<number>(this.n).fill(0);
    this.last = new Array<number | null>(this.n).fill(null);
  }

  /** Feed one monitor chunk (the 'data' event). */
  feed(chunk: Buffer): void {
    const joined = this.rest.length > 0 ? Buffer.concat([this.rest, chunk]) : chunk;
    const { channels, rest } = demuxMonitor(joined, this.n);
    this.rest = Buffer.from(rest);
    const frames = channels[0]?.length ?? 0;
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < this.n; c++) {
        const v = channels[c]![f]!;
        this.sum[c]! += v * v;
      }
      if (++this.count >= this.win) this.close();
    }
  }

  /** A new combiner run: drop the partial frame of the old one. */
  reset(): void {
    this.rest = Buffer.alloc(0);
  }

  private close(): void {
    for (let c = 0; c < this.n; c++) {
      const rms = Math.sqrt(this.sum[c]! / this.count) / 32768;
      this.last[c] = rms <= 0 ? LEVEL_FLOOR_DB : Math.max(LEVEL_FLOOR_DB, Math.min(0, Math.round(20 * Math.log10(rms) * 10) / 10));
      this.sum[c] = 0;
    }
    this.count = 0;
    this.lastAt = this.now();
  }

  /** dBFS of the channel (0 = unit), or undefined before the first window or when the meter went stale. */
  level(channel: number): number | undefined {
    if (this.lastAt === 0 || this.now() - this.lastAt > this.staleMs) return undefined;
    return this.last[channel] ?? undefined;
  }

  channelOf(id: string): number {
    return this.ids.indexOf(id);
  }
}
