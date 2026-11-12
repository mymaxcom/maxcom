export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  /** Clock in ms; injectable for tests. Defaults to a monotonic clock so wall-clock jumps cannot reset a window. */
  now?: () => number;
}

export interface RateLimiter {
  hit(key: string): { ok: boolean; retryAfterSec: number };
  reset(key: string): void;
}

const MAX_KEYS = 10_000;

/**
 * Sliding-window limiter in memory. Each key keeps at most `max` timestamps. A refused hit is
 * not recorded, so hammering a blocked key does not extend its block. At most 10 000 keys are
 * tracked; the least recently used one is dropped first, so a flood of fresh keys cannot grow
 * memory without bound.
 */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  if (!(opts.windowMs > 0) || !(opts.max >= 1)) throw new Error('ratelimit: bad options');
  const now = opts.now ?? ((): number => performance.now());
  const buckets = new Map<string, number[]>(); // Map order = recency (oldest first)

  return {
    hit(key: string): { ok: boolean; retryAfterSec: number } {
      const t = now();
      const cutoff = t - opts.windowMs;
      let stamps = buckets.get(key);
      if (stamps !== undefined) {
        buckets.delete(key); // re-inserted below to mark as most recently used
        // Drop expired entries; also drop entries from the future (clock stepped back).
        stamps = stamps.filter((s) => s > cutoff && s <= t);
      } else {
        stamps = [];
      }
      let result: { ok: boolean; retryAfterSec: number };
      if (stamps.length >= opts.max) {
        const wait = (stamps[0]! + opts.windowMs - t) / 1000;
        result = { ok: false, retryAfterSec: Math.max(1, Math.ceil(wait)) };
      } else {
        stamps.push(t);
        result = { ok: true, retryAfterSec: 0 };
      }
      buckets.set(key, stamps);
      while (buckets.size > MAX_KEYS) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
      return result;
    },
    reset(key: string): void {
      buckets.delete(key);
    },
  };
}
