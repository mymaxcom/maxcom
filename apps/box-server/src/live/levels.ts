/**
 * Per-source level meter on the combiner monitor (s16le, interleaved, channel 0 = unit, then the added sources).
 * RMS in dBFS over a window of about 400 ms of monitor time; a source that has not been measured for `staleMs` of
 * wall time reads as unknown (the combiner is restarting or stalled).
 */

import { demuxMonitor } from './mixer.ts';

export const LEVEL_WINDOW_MS = 400;
export const LEVEL_FLOOR_DB = -90;
/** A window at or under this level counts as silence for the box microphone warning (build 5). */
export const BOX_MIC_SILENT_DB = -70;
/** A window at or above this level counts as sound again (build 5). */
export const BOX_MIC_SOUND_DB = -60;

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
  private silentRun: number[];
  private soundRun: number[];
  private soundPeak: number[];
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
    this.silentRun = new Array<number>(this.n).fill(0);
    this.soundRun = new Array<number>(this.n).fill(0);
    this.soundPeak = new Array<number>(this.n).fill(0);
  }

  /** Feed one monitor chunk (the 'data' event). */
  feed(chunk: Buffer): void {
    // Q9: the first chunk after a stale gap (the combiner restarted or stalled) starts the runs again: the silence before
    // the gap says nothing about the sound after it
    if (this.lastAt !== 0 && this.now() - this.lastAt > this.staleMs) {
      this.silentRun.fill(0);
      this.soundRun.fill(0);
      this.soundPeak.fill(0);
      this.sum.fill(0);
      this.count = 0;
    }
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
      const db = this.last[c]!;
      this.silentRun[c] = db <= BOX_MIC_SILENT_DB ? this.silentRun[c]! + LEVEL_WINDOW_MS : 0;
      this.soundRun[c] = db >= BOX_MIC_SOUND_DB ? this.soundRun[c]! + LEVEL_WINDOW_MS : 0;
      this.soundPeak[c] = Math.max(this.soundPeak[c]!, this.soundRun[c]!);
    }
    this.count = 0;
    this.lastAt = this.now();
  }

  /** dBFS of the channel (0 = unit), or undefined before the first window or when the meter went stale. */
  level(channel: number): number | undefined {
    if (this.lastAt === 0 || this.now() - this.lastAt > this.staleMs) return undefined;
    return this.last[channel] ?? undefined;
  }

  private fresh(): boolean {
    return this.lastAt !== 0 && this.now() - this.lastAt <= this.staleMs;
  }

  /**
   * Monitor time (ms) the channel has stayed at or under `BOX_MIC_SILENT_DB`; 0 when the last window was above it;
   * undefined before the first window or when the meter went stale.
   */
  silentMs(channel: number): number | undefined {
    if (!this.fresh() || channel < 0 || channel >= this.n) return undefined;
    return this.silentRun[channel]!;
  }

  /** Length (ms) of the current run of windows at or above `BOX_MIC_SOUND_DB`; undefined as for `silentMs`. */
  soundMs(channel: number): number | undefined {
    if (!this.fresh() || channel < 0 || channel >= this.n) return undefined;
    return this.soundRun[channel]!;
  }

  /**
   * Longest run (ms) of windows at or above `BOX_MIC_SOUND_DB` since the last call, the run in progress included; the
   * count then starts again from the run in progress. A run that began and ended between two reads still counts.
   * Undefined as for `silentMs` (nothing is cleared in that case).
   */
  takeSoundMs(channel: number): number | undefined {
    if (!this.fresh() || channel < 0 || channel >= this.n) return undefined;
    const peak = Math.max(this.soundPeak[channel]!, this.soundRun[channel]!);
    this.soundPeak[channel] = this.soundRun[channel]!;
    return peak;
  }

  channelOf(id: string): number {
    return this.ids.indexOf(id);
  }
}
