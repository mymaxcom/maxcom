// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCursorIdle } from '../src/ui/cursorIdle.ts';

const visible = () => document.documentElement.classList.contains('cursor-visible');

function pointer(type: string, pointerType: string): void {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  window.dispatchEvent(event);
}

describe('cursorIdle', () => {
  let stop: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    stop = installCursorIdle();
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it('shows the pointer on mouse movement and hides it after 3 s idle', () => {
    expect(visible()).toBe(false);
    pointer('pointermove', 'mouse');
    expect(visible()).toBe(true);
    vi.advanceTimersByTime(2900);
    expect(visible()).toBe(true);
    vi.advanceTimersByTime(200);
    expect(visible()).toBe(false);
  });

  it('keeps it visible while the mouse keeps moving', () => {
    pointer('pointermove', 'mouse');
    vi.advanceTimersByTime(2000);
    pointer('pointermove', 'mouse');
    vi.advanceTimersByTime(2000);
    expect(visible()).toBe(true);
    vi.advanceTimersByTime(1100);
    expect(visible()).toBe(false);
  });

  it('shows it for a plain mousemove event', () => {
    window.dispatchEvent(new MouseEvent('mousemove'));
    expect(visible()).toBe(true);
  });

  it('ignores touch and pen input', () => {
    pointer('pointermove', 'touch');
    pointer('pointermove', 'pen');
    expect(visible()).toBe(false);
  });

  it('ignores the pointer-less mouse events a touch causes, for 1 s', () => {
    pointer('pointerdown', 'touch');
    window.dispatchEvent(new MouseEvent('mousemove'));
    window.dispatchEvent(new MouseEvent('mousedown'));
    expect(visible()).toBe(false);
    pointer('pointermove', 'pen');
    vi.advanceTimersByTime(900);
    window.dispatchEvent(new MouseEvent('mousemove'));
    expect(visible()).toBe(false);
    vi.advanceTimersByTime(200);
    window.dispatchEvent(new MouseEvent('mousemove'));
    expect(visible()).toBe(true);
  });

  it('a real mouse pointer event still shows it right after a touch', () => {
    pointer('pointerdown', 'touch');
    pointer('pointermove', 'mouse');
    expect(visible()).toBe(true);
  });
});
