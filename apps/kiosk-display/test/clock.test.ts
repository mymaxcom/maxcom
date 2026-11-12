import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/preact';
import { nowOverrideAllowed, parseNowOverride, useNow } from '../src/data/clock.ts';

describe('parseNowOverride', () => {
  it('parses an offset instant', () => {
    expect(parseNowOverride('?now=2026-11-03T15:52:00%2B08:00')).toEqual(new Date('2026-11-03T07:52:00Z'));
  });
  it('returns null for garbage or absent', () => {
    expect(parseNowOverride('?now=garbage')).toBeNull();
    expect(parseNowOverride('')).toBeNull();
    expect(parseNowOverride('?x=1')).toBeNull();
  });
});

describe('useNow', () => {
  beforeEach(() => { vi.useFakeTimers(); window.history.replaceState(null, '', '/'); });
  afterEach(() => { vi.useRealTimers(); window.history.replaceState(null, '', '/'); });

  it('advances 1 s per tick from the override', () => {
    window.history.replaceState(null, '', '/?now=2026-11-03T15:52:00%2B08:00');
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { result } = renderHook(() => useNow());
    const t0 = result.current.getTime();
    expect(t0).toBe(new Date('2026-11-03T07:52:00Z').getTime());
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.getTime() - t0).toBeGreaterThanOrEqual(1000);
    expect(result.current.getTime() - t0).toBeLessThan(2000);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.getTime() - t0).toBeGreaterThanOrEqual(2000);
  });

  it('ticks aligned to the second without override', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.400Z'));
    const { result } = renderHook(() => useNow());
    act(() => { vi.advanceTimersByTime(600); });
    expect(result.current.getTime() % 1000).toBe(0);
  });
});

describe('nowOverrideAllowed', () => {
  it('honoured in dev and test', () => {
    expect(nowOverrideAllowed('?now=x', { DEV: true, MODE: 'development' })).toBe(true);
    expect(nowOverrideAllowed('?now=x', { DEV: false, MODE: 'test' })).toBe(true);
  });
  it('ignored in production unless proof=1', () => {
    const prod = { DEV: false, MODE: 'production' };
    expect(nowOverrideAllowed('?now=2026-11-03T15:52:00%2B08:00', prod)).toBe(false);
    expect(nowOverrideAllowed('?now=2026-11-03T15:52:00%2B08:00&proof=1', prod)).toBe(true);
    expect(nowOverrideAllowed('?proof=0&now=x', prod)).toBe(false);
  });
});
