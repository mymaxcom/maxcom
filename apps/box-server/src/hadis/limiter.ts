/** A small in-process fixed-window limiter: `max` hits per `windowMs` per key. Idle keys are forgotten. */

export interface Limiter {
  hit(key: string): { ok: true } | { ok: false; retryAfterSec: number };
  size(): number;
}

export function createLimiter(opts: { max: number; windowMs: number; now?: () => number }): Limiter {
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { start: number; n: number }>();
  let lastSweep = now();

  function sweep(t: number): void {
    if (t - lastSweep < opts.windowMs) return;
    lastSweep = t;
    for (const [k, w] of windows) if (t - w.start >= opts.windowMs) windows.delete(k);
  }

  return {
    hit(key) {
      const t = now();
      sweep(t);
      let w = windows.get(key);
      if (w === undefined || t - w.start >= opts.windowMs) {
        w = { start: t, n: 0 };
        windows.set(key, w);
      }
      if (w.n >= opts.max) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.start + opts.windowMs - t) / 1000)) };
      w.n += 1;
      return { ok: true };
    },
    size: () => windows.size,
  };
}
