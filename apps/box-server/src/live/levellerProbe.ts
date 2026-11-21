import { spawn } from 'node:child_process';

/* Does this box's ffmpeg have the two filters of the live leveller (`compand` and `alimiter`)? The Windows box ships a
   full build; the Android box's bundled ffmpeg is a trimmed build (scripts/android/ffmpeg-features.json lists what it
   must keep). A box without them must still go live, only without the leveller, so the mixer asks once before its first
   start. A definite answer (yes or no) is cached per ffmpeg path for the process lifetime; "could not tell" is not
   cached (the next start asks again) and counts as "try with the leveller" because the mixer also relaunches once
   without it when ffmpeg says "No such filter". */

/** true: both filters exist; false: ffmpeg said one is unknown; null: could not tell. */
export type LevellerProbe = (ffmpegPath: string, argsPrefix?: string[]) => Promise<boolean | null>;

export const LEVELLER_FILTERS = ['compand', 'alimiter'] as const;

const PROBE_TIMEOUT_MS = 5_000;
const OUTPUT_CAP = 16 * 1024;

function probeOne(ffmpegPath: string, filter: string, argsPrefix: string[], timeoutMs: number): Promise<boolean | null> {
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
      const child = spawn(ffmpegPath, [...argsPrefix, '-hide_banner', '-h', `filter=${filter}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
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
        if (/unknown filter|no such filter/i.test(out)) finish(false);
        else if (code === 0 && new RegExp(`filter ${filter}\\b`, 'i').test(out)) finish(true);
        else finish(null);
      });
    } catch {
      finish(null);
    }
  });
}

/** true only when every filter is there; false as soon as one is unknown; null when nothing definite. Never throws. */
export async function probeLevellerFilters(ffmpegPath: string, argsPrefix: string[] = [], timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean | null> {
  // in parallel: the worst case is one timeout, not one per filter
  const results = await Promise.all(LEVELLER_FILTERS.map((f) => probeOne(ffmpegPath, f, argsPrefix, timeoutMs)));
  if (results.includes(false)) return false;
  return results.includes(null) ? null : true;
}

/** Caches a definite probe answer per ffmpeg path (concurrent callers share the run). */
export class LevellerCapability {
  private readonly known = new Map<string, boolean>();
  private readonly pending = new Map<string, Promise<boolean | null>>();
  private readonly probe: LevellerProbe;

  constructor(probe: LevellerProbe = (p, a) => probeLevellerFilters(p, a)) {
    this.probe = probe;
  }

  /** A run proved a filter missing ("No such filter"): remember it so the next Mixer starts without the leveller and without probing. */
  markMissing(ffmpegPath: string): void {
    this.known.set(ffmpegPath, false);
  }

  check(ffmpegPath: string, argsPrefix: string[] = []): Promise<boolean | null> {
    const k = this.known.get(ffmpegPath);
    if (k !== undefined) return Promise.resolve(k);
    const p = this.pending.get(ffmpegPath);
    if (p !== undefined) return p;
    const run = Promise.resolve()
      .then(() => this.probe(ffmpegPath, argsPrefix))
      .catch(() => null)
      .then((answer) => {
        this.pending.delete(ffmpegPath);
        if (answer !== null && !this.known.has(ffmpegPath)) this.known.set(ffmpegPath, answer);
        return answer;
      });
    this.pending.set(ffmpegPath, run);
    return run;
  }
}
