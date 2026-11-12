import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installRecovery, msUntilNextDailyReload } from '../src/data/recovery.ts';

describe('msUntilNextDailyReload', () => {
  it('before 03:00 KL -> same day', () => {
    // 2026-11-03 01:00 KL = 2026-11-02T17:00Z
    expect(msUntilNextDailyReload(new Date('2026-11-02T17:00:00Z'))).toBe(2 * 3600_000);
  });
  it('after 03:00 KL -> next day', () => {
    expect(msUntilNextDailyReload(new Date('2026-11-02T20:00:00Z'))).toBe(23 * 3600_000);
  });
  it('exactly 03:00 KL -> 24 h', () => {
    expect(msUntilNextDailyReload(new Date('2026-11-02T19:00:00Z'))).toBe(24 * 3600_000);
  });
  it('uses KL, not machine time: 23:00 UTC is already 07:00 KL', () => {
    expect(msUntilNextDailyReload(new Date('2026-11-02T23:00:00Z'))).toBe(20 * 3600_000);
  });
});

class Target {
  l = new Map<string, ((e: Event) => void)[]>();
  controller: unknown = null;
  addEventListener(t: string, f: (e: Event) => void) {
    this.l.set(t, [...(this.l.get(t) ?? []), f]);
  }
  removeEventListener() {}
  fire(t: string, e: unknown = {}) {
    for (const f of this.l.get(t) ?? []) f(e as Event);
  }
}

describe('installRecovery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const mk = (over: { controller?: unknown } = {}) => {
    const win = new Target();
    const sw = new Target();
    sw.controller = 'controller' in over ? over.controller : {};
    const reload = vi.fn();
    const log = vi.fn();
    installRecovery({
      reload,
      log,
      win: win as unknown as Window,
      sw: sw as unknown as ServiceWorkerContainer,
      now: () => new Date('2026-11-02T17:00:00Z'),
      getPhase: () => 'normal',
    });
    return { win, sw, reload, log };
  };

  it('error -> logs and reloads once after 30 s', () => {
    const { win, reload, log } = mk();
    win.fire('error', { error: new Error('boom') });
    win.fire('unhandledrejection', { reason: 'x' });
    expect(log).toHaveBeenCalled();
    vi.advanceTimersByTime(29_999);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('daily reload fires at 03:00 KL in the normal phase', () => {
    const { reload } = mk();
    vi.advanceTimersByTime(2 * 3600_000 - 1);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('daily reload waits while the phase is not normal', () => {
    let phase = 'adzan';
    const win = new Target();
    const reload = vi.fn();
    installRecovery({
      reload,
      log: () => {},
      win: win as unknown as Window,
      sw: null,
      now: () => new Date('2026-11-02T17:00:00Z'),
      getPhase: () => phase,
    });
    vi.advanceTimersByTime(2 * 3600_000);
    expect(reload).not.toHaveBeenCalled();
    phase = 'normal';
    vi.advanceTimersByTime(5 * 60_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('controllerchange reloads once when a controller already existed', () => {
    const { sw, reload } = mk();
    sw.fire('controllerchange');
    sw.fire('controllerchange');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('controllerchange on first install (no prior controller) does not reload', () => {
    const { sw, reload } = mk({ controller: null });
    sw.fire('controllerchange');
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('msUntilNextDailyReload in the surau zone (Plan 13)', () => {
  it('03:00 of Nairobi (UTC+3) is 00:00Z', () => {
    // 2026-11-09T21:00Z is 00:00 on the 10th in Nairobi: 3 h to 03:00 there.
    expect(msUntilNextDailyReload(new Date('2026-11-09T21:00:00Z'), 'Africa/Nairobi')).toBe(3 * 3600_000);
  });
  it('the default is still KL', () => {
    expect(msUntilNextDailyReload(new Date('2026-11-02T17:00:00Z'))).toBe(2 * 3600_000);
  });
});
