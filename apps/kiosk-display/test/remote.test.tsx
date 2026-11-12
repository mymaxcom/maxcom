import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/preact';
import { classifyKey, useRemoteKeys } from '../src/data/remote.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('classifyKey', () => {
  it.each([
    [{ key: 'Enter' }, 'ok'],
    [{ key: 'Select' }, 'ok'],
    [{ key: 'x', code: 'NumpadEnter' }, 'ok'],
    [{ key: 'Backspace' }, 'back'],
    [{ key: 'Escape' }, 'back'],
    [{ key: 'GoBack' }, 'back'],
    [{ key: 'ArrowLeft' }, null],
    [{ key: ' ' }, null],
    [{}, null],
  ])('%j is %s', (ev, want) => {
    expect(classifyKey(ev)).toBe(want);
  });
});

function press(key: string, type: 'keydown' | 'keyup', repeat = false): void {
  window.dispatchEvent(new KeyboardEvent(type, { key, repeat }));
}

describe('useRemoteKeys', () => {
  function setup() {
    const h = { onOk: vi.fn(), onBack: vi.fn(), onHoldOk: vi.fn() };
    function Probe() {
      useRemoteKeys(h);
      return <div />;
    }
    render(<Probe />);
    return h;
  }

  it('a short press is OK once, on release', () => {
    vi.useFakeTimers();
    const h = setup();
    press('Enter', 'keydown');
    expect(h.onOk).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    press('Enter', 'keyup');
    expect(h.onOk).toHaveBeenCalledTimes(1);
    expect(h.onHoldOk).not.toHaveBeenCalled();
  });

  it('holding OK fires hold once after 3 s, not before, and the release is not an OK press', () => {
    vi.useFakeTimers();
    const h = setup();
    press('Enter', 'keydown');
    vi.advanceTimersByTime(2900);
    expect(h.onHoldOk).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(h.onHoldOk).toHaveBeenCalledTimes(1);
    press('Enter', 'keyup');
    vi.advanceTimersByTime(5000);
    expect(h.onHoldOk).toHaveBeenCalledTimes(1);
    expect(h.onOk).not.toHaveBeenCalled();
  });

  it('a 2.9 s press is an OK, not a hold', () => {
    vi.useFakeTimers();
    const h = setup();
    press('Enter', 'keydown');
    vi.advanceTimersByTime(2900);
    press('Enter', 'keyup');
    expect(h.onHoldOk).not.toHaveBeenCalled();
    expect(h.onOk).toHaveBeenCalledTimes(1);
  });

  it('auto-repeat keydowns do not restart or double the hold', () => {
    vi.useFakeTimers();
    const h = setup();
    press('Enter', 'keydown');
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(200);
      press('Enter', 'keydown', true);
    }
    expect(h.onHoldOk).toHaveBeenCalledTimes(1);
  });

  it('Back fires on press, and other keys do nothing', () => {
    vi.useFakeTimers();
    const h = setup();
    press('Backspace', 'keydown');
    expect(h.onBack).toHaveBeenCalledTimes(1);
    press('ArrowDown', 'keydown');
    press('ArrowDown', 'keyup');
    expect(h.onOk).not.toHaveBeenCalled();
  });

  it('removes its listeners when unmounted', () => {
    vi.useFakeTimers();
    const h = { onOk: vi.fn() };
    function Probe() {
      useRemoteKeys(h);
      return <div />;
    }
    const r = render(<Probe />);
    act(() => r.unmount());
    press('Enter', 'keydown');
    press('Enter', 'keyup');
    expect(h.onOk).not.toHaveBeenCalled();
  });
});
