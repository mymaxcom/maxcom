import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/preact';
import type { LoadedBundle } from '../src/data/bundle.ts';

const mocks = vi.hoisted(() => ({
  loadBundle: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock('../src/data/bundle.ts', () => mocks);

import { shouldReplace, useKiosk } from '../src/data/kiosk.ts';

function lb(version: number, source: 'network' | 'cache' = 'network'): LoadedBundle {
  return {
    bundle: { version, zone: 'SGR01', days: [], settings: {} as never, serverTime: '', logo: null },
    source,
    fetchedAt: Date.now(),
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

let onChange: (v: number) => void = () => {};
function Probe() {
  const k = useKiosk();
  return <div data-testid="p" data-ready={String(k.ready)} />;
}

describe('useKiosk reload serialisation', () => {
  beforeEach(() => {
    mocks.loadBundle.mockReset();
    mocks.subscribe.mockReset();
    mocks.subscribe.mockImplementation((cb: (v: number) => void) => {
      onChange = cb;
      return () => {};
    });
  });
  afterEach(() => cleanup());

  it('one in flight; many requests meanwhile schedule exactly one follow-up', async () => {
    const d1 = deferred<LoadedBundle>();
    mocks.loadBundle.mockReturnValueOnce(d1.promise).mockResolvedValue(lb(2));
    render(<Probe />);
    expect(mocks.loadBundle).toHaveBeenCalledTimes(1);
    onChange(2);
    onChange(3);
    onChange(4);
    expect(mocks.loadBundle).toHaveBeenCalledTimes(1);
    d1.resolve(lb(1));
    await flush();
    expect(mocks.loadBundle).toHaveBeenCalledTimes(2);
    await flush();
    expect(mocks.loadBundle).toHaveBeenCalledTimes(2);
  });

  it('SSE event with the loaded version does not refetch', async () => {
    mocks.loadBundle.mockResolvedValue(lb(5));
    render(<Probe />);
    await flush();
    expect(mocks.loadBundle).toHaveBeenCalledTimes(1);
    onChange(5);
    expect(mocks.loadBundle).toHaveBeenCalledTimes(1);
    onChange(6);
    await flush();
    expect(mocks.loadBundle).toHaveBeenCalledTimes(2);
  });
});

describe('shouldReplace (out-of-order results)', () => {
  it('a fresh network bundle always wins, even with a lower version (box DB reset)', () => {
    expect(shouldReplace(lb(5), lb(3))).toBe(true);
  });
  it('a cache result never replaces a network bundle', () => {
    expect(shouldReplace(lb(5), lb(3, 'cache'))).toBe(false);
    expect(shouldReplace(lb(5), lb(9, 'cache'))).toBe(false);
  });
  it('a newer cache result may replace an older cache result', () => {
    expect(shouldReplace(lb(3, 'cache'), lb(4, 'cache'))).toBe(true);
    expect(shouldReplace(lb(4, 'cache'), lb(3, 'cache'))).toBe(false);
  });
  it('a cache result never replaces a network bundle of the same or lower version', () => {
    expect(shouldReplace(lb(5, 'network'), lb(5, 'cache'))).toBe(false);
    expect(shouldReplace(lb(5, 'network'), lb(4, 'cache'))).toBe(false);
  });
  it('accepts newer, equal network, and the first result', () => {
    expect(shouldReplace(lb(5), lb(6))).toBe(true);
    expect(shouldReplace(lb(5), lb(5))).toBe(true);
    expect(shouldReplace(null, lb(1, 'cache'))).toBe(true);
  });
});
