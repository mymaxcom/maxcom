import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../src/auth/ratelimit.ts';

describe('rate limiter', () => {
  it('allows max hits, refuses the next, and recovers after the window', () => {
    let t = 1000;
    const rl = createRateLimiter({ windowMs: 300_000, max: 20, now: () => t });
    for (let i = 0; i < 20; i++) expect(rl.hit('ip').ok).toBe(true);
    const blocked = rl.hit('ip');
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    t += 300_001;
    expect(rl.hit('ip').ok).toBe(true);
  });

  it('keys are independent and reset clears one key', () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => 5 });
    expect(rl.hit('a').ok).toBe(true);
    expect(rl.hit('a').ok).toBe(false);
    expect(rl.hit('b').ok).toBe(true);
    rl.reset('a');
    expect(rl.hit('a').ok).toBe(true);
  });

  it('a refused hit does not extend the block', () => {
    let t = 0;
    const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => t });
    expect(rl.hit('k').ok).toBe(true);
    t = 900;
    expect(rl.hit('k').ok).toBe(false);
    t = 1001;
    expect(rl.hit('k').ok).toBe(true);
  });

  it('is a sliding window, not a fixed bucket', () => {
    let t = 0;
    const rl = createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
    expect(rl.hit('k').ok).toBe(true); // t=0
    t = 600;
    expect(rl.hit('k').ok).toBe(true);
    t = 1001; // first aged out, second still inside
    expect(rl.hit('k').ok).toBe(true);
    expect(rl.hit('k').ok).toBe(false);
  });

  it('bounds the number of tracked keys (LRU eviction)', () => {
    const rl = createRateLimiter({ windowMs: 1_000_000, max: 1, now: () => 1 });
    expect(rl.hit('first').ok).toBe(true);
    expect(rl.hit('first').ok).toBe(false);
    for (let i = 0; i < 10_001; i++) rl.hit(`k${i}`);
    // 'first' was the least recently used and has been evicted, so it is allowed again.
    expect(rl.hit('first').ok).toBe(true);
    // A recently used key is still tracked.
    expect(rl.hit('k10000').ok).toBe(false);
  });

  it('rejects nonsense options', () => {
    expect(() => createRateLimiter({ windowMs: 0, max: 1 })).toThrow();
    expect(() => createRateLimiter({ windowMs: 10, max: 0 })).toThrow();
  });
});
