import type { Readable } from 'node:stream';
import { ALIGN_TARGET_MS } from '@surau/core';
import type { AddedAudioId, AlignState } from '@surau/core';

/* Automatic audio alignment, box side (plan rev 4, 4.3a and section 8 task AL1).

   THE ALGORITHM (one description for both implementations: this file and the phone twin AudioAligner.kt copy it word
   for word; the constants below are part of it).

   Signals. The reference is the unit's own audio (camera sound). An added source (phone or iPad microphone, Mic-in) is
   mixed in through a delay. The combiner's monitor stream carries the reference and every added source AFTER its delay,
   so every measurement is the REMAINING gap (closed loop). The aligner never touches ffmpeg: it reads the monitor and
   calls apply(id, delayMs).

   Sign of a lag. lag > 0 means the added source is EARLY: src[n] is similar to ref[n + lag], so the source's delay must
   grow by lag. lag < 0 means the source is late: its delay must shrink. new delay = current delay + lag.

   estimateLag(ref, src, rate, maxLagMs): searches lag in [-maxLagMs, +maxLagMs], returns { lagMs, confidence } or null.
   1. Sound check: if the RMS of either signal is under 0.002 of full scale (about 65 of 32768) return null. Silence
      never gives a result, not a wrong one.
   2. Coarse search on envelopes, 100 Hz grid (CPU: no work at the full rate). Envelope = mean absolute value of each
      10 ms bin, the mean removed. Pearson correlation between the two envelopes at every lag of the 10 ms grid inside
      +-maxLagMs, using only lags whose overlap is at least a third of the window. The envelope is polarity-free and
      survives room filtering, a muffled microphone, noise and a different gain.
   3. Confidence = peak correlation minus half of the best correlation outside +-150 ms of the peak (negative values
      count as 0). A peak at the edge of the search range gives null. Confidence under 0.45 is "not confident".
   4. Fine search, only near the coarse peak: both signals box-averaged down to about 4 kHz and differenced (pre-emphasis),
      then the plain cross-correlation at every decimated lag within +-12 ms of the coarse peak (the coarse peak is first
      refined by a parabola), over the loudest 3 s of the added source that every tested lag covers. The strongest ABSOLUTE value wins (polarity-free: an inverted microphone still locks).
      The peak is refined by a parabola. If the normalised fine peak is under 0.05 the coarse lag is returned instead.

   Aligner (one per added source, ticking once every 2 s of monitor sound, on the last 8 s window):
   a. Only confident estimates count. Estimates are kept in a list of the last 3 since the last correction.
   b. Act on the MEDIAN of 3 estimates that agree (max - min <= 15 ms). Before the first lock the median is applied in
      full when it is over 5 ms. After a lock a correction happens only when the median passes 10 ms, and then in a small
      step of at most 5 ms (drift between the audio clocks is slow; a step this size is not heard).
   c. After a correction wait for a full 8 s window of new sound before measuring again (the window must not contain
      sound from before the correction), and clear the list.
   d. The delay never goes below 10 ms (adelay must never be 0, T0) nor above the maximum (default 10 s). Start the
      delay at a non-zero value (default 1000 ms, T0).
   e. A confident estimate inside the target (20 ms, ALIGN_TARGET_MS) that follows a correction (closed-loop proof), or 3
      agreeing in-target estimates, gives `locked`.
   f. `locked` becomes `holding` after 3 ticks (6 s) without a confident estimate (silence in the room); the last delay
      is kept; the next confident in-target estimate gives `locked` again.
   g. `searching` becomes `failed` after 60 s of counted time without a lock. Counted time is the monitor time in which
      the reference carries sound (silence in the room does not count). The search keeps running after `failed` and a
      lock gives `locked` by itself. reset(id) starts `searching` again (source or camera returned).
   h. Time is the monitor's own clock (samples received / sample rate), so a stalled stream stands still. */

/** Monitor format fixed by the combiner (B4): s16le interleaved, channel 0 = reference, channel n = added source n. */
export const WINDOW_MS = 8000;
export const STEP_MS = 2000;
export const ENV_HZ = 100;
export const CONFIDENCE_MIN = 0.45;
export const AGREE_MS = 15;
export const ACT_FIRST_MS = 5;
export const ACT_DRIFT_MS = 10;
export const DRIFT_STEP_MS = 5;
export const HOLD_TICKS = 3;
export const FAIL_MS = 60_000;
export const MIN_DELAY_MS = 10;
export const MAX_DELAY_MS = 10_000;
export const DEFAULT_INITIAL_DELAY_MS = 1000;
const SOUND_RMS = 0.002;
const FINE_RATE = 4000;
const FINE_HALF_MS = 12;
const FINE_SEG_MS = 3000;
const EXCLUDE_MS = 150;
const FINE_MIN_NORM = 0.05;

export interface LagEstimate {
  /** Positive: the added source is early (its delay must grow by this much). */
  lagMs: number;
  /** 0 to 1; trust it from CONFIDENCE_MIN. */
  confidence: number;
}

function rmsOf(x: ArrayLike<number>, n: number): number {
  let e = 0;
  for (let i = 0; i < n; i++) e += x[i]! * x[i]!;
  return Math.sqrt(e / Math.max(1, n)) / 32768;
}

/** Mean absolute value per bin, mean removed. */
function envelope(x: ArrayLike<number>, bin: number, nb: number): Float64Array {
  const e = new Float64Array(nb);
  let mean = 0;
  for (let b = 0; b < nb; b++) {
    let s = 0;
    const o = b * bin;
    for (let k = 0; k < bin; k++) s += Math.abs(x[o + k]!);
    e[b] = s / bin;
    mean += s / bin;
  }
  mean /= nb;
  for (let b = 0; b < nb; b++) e[b] = e[b]! - mean;
  return e;
}

/** Box-average decimation by `dec`, then a first difference. */
function decimateDiff(x: ArrayLike<number>, n: number, dec: number): Float64Array {
  const m = Math.floor(n / dec);
  const y = new Float64Array(m);
  let prev = 0;
  for (let i = 0; i < m; i++) {
    let s = 0;
    const o = i * dec;
    for (let k = 0; k < dec; k++) s += x[o + k]!;
    const v = s / dec;
    y[i] = v - prev;
    prev = v;
  }
  return y;
}

/** Pure. Sign convention and algorithm: see the header. Returns null on silence, no clear peak or a peak at the range edge. */
export function estimateLag(ref: Int16Array, src: Int16Array, sampleRate: number, maxLagMs: number): LagEstimate | null {
  const len = Math.min(ref.length, src.length);
  const bin = Math.max(1, Math.round(sampleRate / ENV_HZ));
  const nb = Math.floor(len / bin);
  if (nb < 40 || !(sampleRate > 0) || !(maxLagMs > 0)) return null;
  if (rmsOf(ref, len) < SOUND_RMS || rmsOf(src, len) < SOUND_RMS) return null;

  const ce = envelope(ref, bin, nb);
  const me = envelope(src, bin, nb);
  const pc = new Float64Array(nb + 1);
  const pm = new Float64Array(nb + 1);
  for (let i = 0; i < nb; i++) {
    pc[i + 1] = pc[i]! + ce[i]! * ce[i]!;
    pm[i + 1] = pm[i]! + me[i]! * me[i]!;
  }
  const binMs = (bin / sampleRate) * 1000;
  const maxBins = Math.min(Math.ceil(maxLagMs / binMs), Math.floor((nb * 2) / 3));
  const minOverlap = Math.max(30, Math.floor(nb / 3));
  const width = 2 * maxBins + 1;
  const r = new Float64Array(width).fill(-1);
  let best = -2;
  let bi = -1;
  for (let d = -maxBins; d <= maxBins; d++) {
    const lo = Math.max(0, -d);
    const hi = Math.min(nb, nb - d);
    if (hi - lo < minOverlap) continue;
    let s = 0;
    for (let n = lo; n < hi; n++) s += ce[n + d]! * me[n]!;
    const e1 = pc[hi + d]! - pc[lo + d]!;
    const e2 = pm[hi]! - pm[lo]!;
    const v = s / Math.sqrt(e1 * e2 + 1e-12);
    r[d + maxBins] = v;
    if (v > best) {
      best = v;
      bi = d + maxBins;
    }
  }
  if (bi <= 0 || bi >= width - 1 || best <= 0) return null;
  const excl = Math.ceil(EXCLUDE_MS / binMs);
  let second = 0;
  for (let i = 0; i < width; i++) if (Math.abs(i - bi) > excl && r[i]! > second) second = r[i]!;
  const confidence = Math.max(0, Math.min(1, best - 0.5 * second));

  const a = r[bi - 1]!;
  const c = r[bi + 1]!;
  const den = a - 2 * best + c;
  const frac = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  const coarseSamples = (bi - maxBins + frac) * bin;
  const coarseMs = (coarseSamples / sampleRate) * 1000;

  // Fine search, on a segment of at most FINE_SEG_MS (the loudest part of the source that every tested lag covers).
  const dec = Math.max(1, Math.floor(sampleRate / FINE_RATE));
  const fr = sampleRate / dec;
  const fc = decimateDiff(ref, len, dec);
  const fm = decimateDiff(src, len, dec);
  const center = Math.round(coarseSamples / dec);
  const half = Math.max(2, Math.ceil((FINE_HALF_MS / 1000) * fr));
  const L = fc.length;
  const lo = Math.max(0, half - center);
  const hi = Math.min(L, L - center - half);
  if (hi - lo < 100) return { lagMs: coarseMs, confidence };
  const segLen = Math.min(hi - lo, Math.round((FINE_SEG_MS / 1000) * fr));
  const pe = new Float64Array(L + 1);
  for (let i = 0; i < L; i++) pe[i + 1] = pe[i]! + fm[i]! * fm[i]!;
  let a0 = lo;
  let bestE = -1;
  const stride = Math.max(1, Math.round(fr / 20));
  for (let st = lo; st + segLen <= hi; st += stride) {
    const e = pe[st + segLen]! - pe[st]!;
    if (e > bestE) {
      bestE = e;
      a0 = st;
    }
  }
  let e1 = 0;
  let e2 = 0;
  for (let n = a0; n < a0 + segLen; n++) {
    e1 += fm[n]! * fm[n]!;
    e2 += fc[n + center]! * fc[n + center]!;
  }
  const norm = Math.sqrt(e1 * e2 + 1e-12);
  const sv = new Float64Array(2 * half + 1);
  let bestAbs = -1;
  let bj = half;
  for (let j = -half; j <= half; j++) {
    const d = center + j;
    let s = 0;
    for (let n = a0; n < a0 + segLen; n++) s += fc[n + d]! * fm[n]!;
    sv[j + half] = s;
    if (Math.abs(s) > bestAbs) {
      bestAbs = Math.abs(s);
      bj = j + half;
    }
  }
  if (bestAbs / norm < FINE_MIN_NORM || bj === 0 || bj === 2 * half) return { lagMs: coarseMs, confidence };
  const sign = sv[bj]! < 0 ? -1 : 1;
  const fa = sign * sv[bj - 1]!;
  const fb = sign * sv[bj]!;
  const fcv = sign * sv[bj + 1]!;
  const fden = fa - 2 * fb + fcv;
  const ffrac = fden < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (fa - fcv)) / fden)) : 0;
  const lagSamples = (center + (bj - half) + ffrac) * dec;
  return { lagMs: (lagSamples / sampleRate) * 1000, confidence };
}

export interface AlignerOptions {
  /** The combiner's monitor: s16le, interleaved, channel 0 = reference, channel n = added[n - 1] after its delay. */
  monitor: Readable;
  added: AddedAudioId[];
  /** Monitor sample rate (16000 from the combiner). */
  sampleRate: number;
  /** Search range, +-ms (the headroom plus a margin). */
  maxLagMs: number;
  /** Set the added source's delay in the combiner (an integer, never under MIN_DELAY_MS). */
  apply: (id: AddedAudioId, delayMs: number) => void;
  onState: (id: AddedAudioId, state: AlignState) => void;
  /** The delay the combiner started with (default 1000 ms; never 0). */
  initialDelayMs?: number;
  maxDelayMs?: number;
  windowMs?: number;
  stepMs?: number;
  failAfterMs?: number;
}

export interface AlignStats {
  ticks: number;
  /** Total and worst CPU time of one analysis tick (all added sources), in ms. */
  cpuMs: number;
  maxCpuMs: number;
}

interface PerSource {
  channel: number;
  state: AlignState;
  delayMs: number;
  recent: number[];
  /** Total sample count before which no measurement is taken (a full new window after a correction). */
  settleUntil: number;
  corrected: boolean;
  lockedOnce: boolean;
  quietTicks: number;
  searchSoundMs: number;
  manual: boolean;
  lastResidualMs: number | undefined;
}

export class Aligner {
  private readonly o: AlignerOptions;
  private readonly channels: number;
  private readonly winSamples: number;
  private readonly stepSamples: number;
  private readonly rings: Int16Array[];
  private readonly snap: Int16Array[];
  private readonly src = new Map<AddedAudioId, PerSource>();
  private readonly minDelay = MIN_DELAY_MS;
  private readonly maxDelay: number;
  private total = 0;
  private sinceTick = 0;
  private leftover: Buffer = Buffer.alloc(0);
  private running = false;
  private readonly onData = (chunk: Buffer): void => this.feed(chunk);
  private readonly onRestart = (): void => {
    this.leftover = Buffer.alloc(0);
  };
  private ticks = 0;
  private cpuMs = 0;
  private maxCpuMs = 0;

  constructor(opts: AlignerOptions) {
    this.o = opts;
    this.channels = 1 + opts.added.length;
    this.winSamples = Math.round(((opts.windowMs ?? WINDOW_MS) / 1000) * opts.sampleRate);
    this.stepSamples = Math.round(((opts.stepMs ?? STEP_MS) / 1000) * opts.sampleRate);
    this.maxDelay = opts.maxDelayMs ?? MAX_DELAY_MS;
    this.rings = Array.from({ length: this.channels }, () => new Int16Array(this.winSamples));
    this.snap = Array.from({ length: this.channels }, () => new Int16Array(this.winSamples));
    const d0 = Math.max(this.minDelay, Math.round(opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS));
    opts.added.forEach((id, i) => {
      this.src.set(id, {
        channel: i + 1,
        state: 'searching',
        delayMs: d0,
        recent: [],
        settleUntil: 0,
        corrected: false,
        lockedOnce: false,
        quietTicks: 0,
        searchSoundMs: 0,
        manual: false,
        lastResidualMs: undefined,
      });
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const id of this.o.added) this.o.onState(id, 'searching');
    this.o.monitor.on('data', this.onData);
    this.o.monitor.on('restart', this.onRestart);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.o.monitor.off('data', this.onData);
    this.o.monitor.off('restart', this.onRestart);
  }

  state(id: AddedAudioId): AlignState {
    return this.src.get(id)?.state ?? 'searching';
  }

  /** The delay this aligner last asked for (or the initial one). */
  delayMs(id: AddedAudioId): number {
    return this.src.get(id)?.delayMs ?? 0;
  }

  /** The last measured remaining gap (ms) for the source, if any. */
  residualMs(id: AddedAudioId): number | undefined {
    return this.src.get(id)?.lastResidualMs;
  }

  stats(): AlignStats {
    return { ticks: this.ticks, cpuMs: this.cpuMs, maxCpuMs: this.maxCpuMs };
  }

  /** The source or the camera returned: search again from `searching` (the delay is kept). */
  reset(id: AddedAudioId): void {
    const s = this.src.get(id);
    if (!s || s.manual) return;
    s.recent = [];
    s.settleUntil = this.total + this.winSamples;
    s.corrected = false;
    s.lockedOnce = false;
    s.quietTicks = 0;
    s.searchSoundMs = 0;
    this.setState(id, s, 'searching');
  }

  /** The unit has no audio track: nothing to match against; the fixed offset applies. Stops analysis for the source. */
  setManual(id: AddedAudioId): void {
    const s = this.src.get(id);
    if (!s) return;
    s.manual = true;
    this.setState(id, s, 'manual');
  }

  private setState(id: AddedAudioId, s: PerSource, st: AlignState): void {
    if (s.state === st) return;
    s.state = st;
    this.o.onState(id, st);
  }

  private feed(chunk: Buffer): void {
    const buf = this.leftover.length ? Buffer.concat([this.leftover, chunk]) : chunk;
    const frameBytes = 2 * this.channels;
    const frames = Math.floor(buf.length / frameBytes);
    this.leftover = buf.subarray(frames * frameBytes);
    let f = 0;
    while (f < frames) {
      const room = this.stepSamples - this.sinceTick;
      const n = Math.min(room, frames - f);
      for (let i = 0; i < n; i++) {
        const pos = (this.total + i) % this.winSamples;
        const o = (f + i) * frameBytes;
        for (let c = 0; c < this.channels; c++) this.rings[c]![pos] = buf.readInt16LE(o + 2 * c);
      }
      f += n;
      this.total += n;
      this.sinceTick += n;
      if (this.sinceTick >= this.stepSamples) {
        this.sinceTick = 0;
        this.tick();
      }
    }
  }

  private tick(): void {
    const t0 = performance.now();
    const stepMs = (this.stepSamples / this.o.sampleRate) * 1000;
    // Counted time: the reference carries sound over the last step (ring positions of that step).
    const stepView = new Int16Array(this.stepSamples);
    for (let i = 0; i < this.stepSamples; i++) stepView[i] = this.rings[0]![(this.total - this.stepSamples + i + this.winSamples * 2) % this.winSamples]!;
    const refSound = rmsOf(stepView, stepView.length) >= SOUND_RMS;
    const full = this.total >= this.winSamples;
    if (full) {
      const cut = this.total % this.winSamples;
      for (let c = 0; c < this.channels; c++) {
        this.snap[c]!.set(this.rings[c]!.subarray(cut), 0);
        this.snap[c]!.set(this.rings[c]!.subarray(0, cut), this.winSamples - cut);
      }
    }
    for (const id of this.o.added) {
      const s = this.src.get(id)!;
      if (s.manual) continue;
      if (s.state === 'searching' && refSound) {
        s.searchSoundMs += stepMs;
        if (s.searchSoundMs >= (this.o.failAfterMs ?? FAIL_MS)) this.setState(id, s, 'failed');
      }
      if (!full || this.total < s.settleUntil) continue;
      this.measure(id, s);
    }
    const dt = performance.now() - t0;
    this.ticks++;
    this.cpuMs += dt;
    this.maxCpuMs = Math.max(this.maxCpuMs, dt);
  }

  private measure(id: AddedAudioId, s: PerSource): void {
    const est = estimateLag(this.snap[0]!, this.snap[s.channel]!, this.o.sampleRate, this.o.maxLagMs);
    const confident = est !== null && est.confidence >= CONFIDENCE_MIN;
    if (!confident || est === null) {
      s.quietTicks++;
      if (s.state === 'locked' && s.quietTicks >= HOLD_TICKS) this.setState(id, s, 'holding');
      return;
    }
    s.quietTicks = 0;
    s.lastResidualMs = est.lagMs;
    s.recent.push(est.lagMs);
    if (s.recent.length > 3) s.recent.shift();
    const inTarget = Math.abs(est.lagMs) <= ALIGN_TARGET_MS;
    const agree = s.recent.length === 3 && Math.max(...s.recent) - Math.min(...s.recent) <= AGREE_MS;
    const median = agree ? [...s.recent].sort((a, b) => a - b)[1]! : 0;

    if (inTarget && (s.corrected || (agree && Math.abs(median) <= ALIGN_TARGET_MS))) {
      s.lockedOnce = true;
      this.setState(id, s, 'locked');
    }
    if (!agree) return;
    const trigger = s.lockedOnce ? ACT_DRIFT_MS : ACT_FIRST_MS;
    if (Math.abs(median) <= trigger) return;
    const step = s.lockedOnce ? Math.max(-DRIFT_STEP_MS, Math.min(DRIFT_STEP_MS, median)) : median;
    const want = Math.max(this.minDelay, Math.min(this.maxDelay, Math.round(s.delayMs + step)));
    s.recent = [];
    s.corrected = true;
    s.settleUntil = this.total + this.winSamples;
    if (want === s.delayMs) return;
    s.delayMs = want;
    this.o.apply(id, want);
  }
}
