import { spawn } from 'node:child_process';

/* Can this box's ffmpeg encode H.264 (libx264)? The Windows box ships a full build; the Android box's bundled
   ffmpeg is a --disable-everything build whose only video encoder is mjpeg, so a "Kod semula" relay would fail there.
   A "yes" is cached for the process lifetime per ffmpeg path, and so is a "no" when ffmpeg ran and said the encoder is
   not recognized. A probe that could not tell (timeout, spawn error, a failing exit) counts as "no" for now and is run
   again after a minute. The box starts the probe at boot, so the live status never waits for it. */

/** true: can; false: ffmpeg said libx264 is not recognized; null: could not tell (tried again later). */
export type EncoderProbe = (ffmpegPath: string) => Promise<boolean | null>;

/** How long an inconclusive probe answer stands before the next caller probes again. */
export const PROBE_RETRY_MS = 60_000;

const PROBE_TIMEOUT_MS = 5_000;
const OUTPUT_CAP = 16 * 1024;

/**
 * true = exit 0 and the output does not say the encoder is unknown; false = the output says it is not recognized;
 * null = no answer (timeout, spawn error, another failure). Never throws.
 */
export function probeLibx264(ffmpegPath: string, timeoutMs = PROBE_TIMEOUT_MS, argsPrefix: string[] = []): Promise<boolean | null> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (ok: boolean | null): void => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      resolve(ok);
    };
    try {
      const child = spawn(ffmpegPath, [...argsPrefix, '-hide_banner', '-h', 'encoder=libx264'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        finish(null);
      }, timeoutMs);
      const take = (b: Buffer): void => {
        if (out.length < OUTPUT_CAP) out += b.toString('utf8').slice(0, OUTPUT_CAP - out.length);
      };
      child.stdout?.on('data', take);
      child.stderr?.on('data', take);
      child.on('error', () => finish(null));
      child.on('close', (code) => {
        if (/is not recognized/i.test(out)) finish(false);
        else finish(code === 0 ? true : null);
      });
    } catch {
      finish(null);
    }
  });
}

/**
 * Caches the probe answer per ffmpeg path; a changed path is probed again. A definite answer is kept; an inconclusive
 * one (or a throwing probe) reads as false and is probed again once PROBE_RETRY_MS has passed.
 */
export class EncoderCapability {
  private path: string | null = null;
  private known: boolean | null = null;
  private pending: Promise<boolean> | null = null;
  /** After an inconclusive probe: false until this time, then a new probe. */
  private retryAt = 0;

  private readonly probe: EncoderProbe;
  private readonly nowMs: () => number;

  constructor(probe: EncoderProbe = (p) => probeLibx264(p), nowMs: () => number = Date.now) {
    this.probe = probe;
    this.nowMs = nowMs;
  }

  /** The cached answer for this path: false inside the retry wait, null while it has not been probed (or has changed). */
  peek(ffmpegPath: string): boolean | null {
    if (this.path !== ffmpegPath) return null;
    if (this.known !== null) return this.known;
    if (this.pending === null && this.nowMs() < this.retryAt) return false;
    return null;
  }

  /** Probes at most once per path (concurrent callers share the run); an inconclusive answer is retried after the wait. */
  check(ffmpegPath: string): Promise<boolean> {
    if (this.path === ffmpegPath) {
      if (this.known !== null) return Promise.resolve(this.known);
      if (this.pending !== null) return this.pending;
      if (this.nowMs() < this.retryAt) return Promise.resolve(false);
    }
    this.path = ffmpegPath;
    this.known = null;
    this.retryAt = 0;
    const run = Promise.resolve()
      .then(() => this.probe(ffmpegPath))
      .catch(() => null)
      .then((answer) => {
        if (this.path === ffmpegPath) {
          this.pending = null;
          if (answer === null) this.retryAt = this.nowMs() + PROBE_RETRY_MS;
          else this.known = answer;
        }
        return answer === true;
      });
    this.pending = run;
    return run;
  }
}
