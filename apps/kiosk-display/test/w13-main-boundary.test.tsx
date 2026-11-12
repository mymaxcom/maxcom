import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';

const holder = vi.hoisted(() => ({ view: null as unknown as KioskView }));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));
vi.mock('../src/content/ContentLayer.tsx', () => ({
  ContentLayer: () => {
    throw new Error('card exploded');
  },
}));

import { App } from '../src/app.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('inner content boundary (Q2)', () => {
  it('a card that throws leaves the clock, dates and prayer bar on screen, with no SafeScreen and no reload event', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    window.addEventListener('error', onError);
    holder.view = makeView('2026-11-03', '15:52');
    const r = render(<App />);
    window.removeEventListener('error', onError);
    expect(r.queryByTestId('safe-screen')).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(r.getByText('3:52')).toBeTruthy();
    expect(r.getByText('Selasa, 3 November 2026')).toBeTruthy();
    expect(r.container.querySelectorAll('[data-prayer]').length).toBe(7);
    expect(r.container.querySelector('[data-layer="content"]')).toBeNull();
  });

  it('an azan phase starting right after still shows the phase screen', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    holder.view = makeView('2026-11-03', '16:09');
    const r = render(<App />);
    expect(r.queryByTestId('safe-screen')).toBeNull();
    holder.view = makeView('2026-11-03', '16:12');
    r.rerender(<App />);
    expect(r.getByText('Azan Asar dalam')).toBeTruthy();
    expect(r.queryByTestId('safe-screen')).toBeNull();
  });
});
