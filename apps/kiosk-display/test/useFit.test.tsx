import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/preact';
import { useFit } from '../src/content/paging.ts';

/**
 * useFit's ResizeObserver path (jsdom has neither ResizeObserver nor layout): a fake observer the test fires by
 * hand, a fake requestAnimationFrame queue the test flushes, and a box whose size the test sets. The text
 * "overflows" while the fit is above `threshold`, so the fit settles exactly at the threshold; a refit (reset to
 * 1, then shrink again) is visible when the threshold moved since the last settle, and its absence when not.
 */

class FakeRO {
  static all: FakeRO[] = [];
  readonly targets: Element[] = [];
  disconnected = false;
  constructor(readonly cb: ResizeObserverCallback) {
    FakeRO.all.push(this);
  }
  observe(el: Element): void {
    this.targets.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  fire(): void {
    this.cb([], this as unknown as ResizeObserver);
  }
}

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const cancelled: number[] = [];
const box = { w: 400, h: 100, threshold: 0.8 };

function flushFrames(): void {
  act(() => {
    const due = [...frames.entries()];
    frames.clear();
    for (const [, cb] of due) cb(0);
  });
}

function Probe({ k }: { k: string }) {
  const { ref, fit } = useFit<HTMLDivElement>(k);
  return <div ref={ref} data-testid="probe" data-fit={String(fit)} />;
}

const fitOf = (r: ReturnType<typeof render>): number => Number(r.getByTestId('probe').getAttribute('data-fit'));

const descriptors = new Map<string, PropertyDescriptor | undefined>();
function stub(prop: 'clientWidth' | 'clientHeight' | 'scrollHeight', get: (el: HTMLElement) => number): void {
  descriptors.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get(this: HTMLElement) {
      return get(this);
    },
  });
}

beforeEach(() => {
  FakeRO.all = [];
  frames.clear();
  cancelled.length = 0;
  nextFrame = 0;
  Object.assign(box, { w: 400, h: 100, threshold: 0.8 });
  vi.stubGlobal('ResizeObserver', FakeRO);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    nextFrame += 1;
    frames.set(nextFrame, cb);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    cancelled.push(id);
    frames.delete(id);
  });
  const isProbe = (el: HTMLElement): boolean => el.dataset.testid === 'probe';
  stub('clientWidth', (el) => (isProbe(el) ? box.w : 0));
  stub('clientHeight', (el) => (isProbe(el) ? box.h : 0));
  // Overflows by 50px while the fit is above the threshold.
  stub('scrollHeight', (el) => (isProbe(el) ? box.h + (Number(el.dataset.fit) > box.threshold + 1e-9 ? 50 : 0) : 0));
});

afterEach(() => {
  cleanup();
  for (const [prop, d] of descriptors) {
    if (d) Object.defineProperty(HTMLElement.prototype, prop, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
  }
  descriptors.clear();
  vi.unstubAllGlobals();
});

describe('useFit: ResizeObserver path', () => {
  it('shrinks to fit at mount and observes its box', () => {
    const r = render(<Probe k="a" />);
    expect(fitOf(r)).toBe(0.8);
    expect(FakeRO.all).toHaveLength(1);
    expect(FakeRO.all[0]!.targets[0]).toBe(r.getByTestId('probe'));
  });

  it('a box that opens from zero starts the fit again, on the next frame', () => {
    // A closed band: the width is already there, the height is 0 (so the refit is the "opened" rule alone,
    // not a width change).
    Object.assign(box, { w: 400, h: 0 });
    const r = render(<Probe k="a" />);
    const settled = fitOf(r);
    box.threshold = 0.6;
    box.h = 100;
    act(() => FakeRO.all[0]!.fire());
    // nothing changes inside the observer callback itself
    expect(fitOf(r)).toBe(settled);
    expect(frames.size).toBe(1);
    flushFrames();
    expect(fitOf(r)).toBe(0.6);
  });

  it('a width change starts the fit again', () => {
    const r = render(<Probe k="a" />);
    expect(fitOf(r)).toBe(0.8);
    box.threshold = 0.6;
    box.w = 300;
    act(() => FakeRO.all[0]!.fire());
    flushFrames();
    expect(fitOf(r)).toBe(0.6);
  });

  it('a height-only change does not (the height follows the fit itself)', () => {
    const r = render(<Probe k="a" />);
    expect(fitOf(r)).toBe(0.8);
    box.threshold = 0.6;
    box.h = 140;
    act(() => FakeRO.all[0]!.fire());
    expect(frames.size).toBe(0);
    flushFrames();
    expect(fitOf(r)).toBe(0.8);
  });

  it('cleans up on unmount: the pending frame is cancelled and the observer disconnected', () => {
    const r = render(<Probe k="a" />);
    box.w = 300;
    act(() => FakeRO.all[0]!.fire());
    expect(frames.size).toBe(1);
    const pending = [...frames.keys()][0]!;
    r.unmount();
    expect(cancelled).toContain(pending);
    expect(frames.size).toBe(0);
    expect(FakeRO.all[0]!.disconnected).toBe(true);
  });

  it('a key change drops the old observer and its pending frame: no stale reset after the new page settled', () => {
    const r = render(<Probe k="a" />);
    box.w = 300;
    act(() => FakeRO.all[0]!.fire());
    const pending = [...frames.keys()][0]!;
    box.threshold = 0.7;
    r.rerender(<Probe k="b" />);
    // the new page fitted itself from 1
    expect(fitOf(r)).toBe(0.7);
    expect(cancelled).toContain(pending);
    expect(FakeRO.all[0]!.disconnected).toBe(true);
    expect(FakeRO.all).toHaveLength(2);
    expect(FakeRO.all[1]!.disconnected).toBe(false);
    // the old frame is gone, so flushing changes nothing even though the threshold moved again
    box.threshold = 0.6;
    expect(frames.size).toBe(0);
    flushFrames();
    expect(fitOf(r)).toBe(0.7);
  });
});
