import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import type { BoxStateView, KioskState } from '@surau/core';
import { makeView } from './helpers.tsx';
import { boxView } from './boxFixture.ts';
import type { KioskView } from '../src/data/kiosk.ts';
import { NotPairedError } from '../src/data/bundle.ts';

const holder = vi.hoisted(() => ({
  view: null as unknown as KioskView,
  box: null as BoxStateView | null,
  beeps: [] as (string | undefined | null)[],
}));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));
vi.mock('../src/data/boxState.ts', async (orig) => ({
  ...(await orig<typeof import('../src/data/boxState.ts')>()),
  useBoxState: () => ({ view: holder.box, error: null }),
}));
vi.mock('../src/ui/Beep.ts', () => ({
  useBeep: (s: KioskState) => {
    holder.beeps.push(s.beep);
  },
}));

import { App } from '../src/app.tsx';

const named = { settings: { surauInfo: { name: 'Surau D\'Waqaf' } } };
function show(view: KioskView) {
  holder.box = boxView({ state: 'locked', surauName: 'Surau D\'Waqaf' });
  holder.view = view;
  return render(<App />);
}

afterEach(() => {
  cleanup();
  holder.beeps = [];
});

describe('Locked screen', () => {
  it('says the service is stopped and prints the box id in groups', () => {
    const r = show(makeView('2026-11-03', '15:52', named));
    expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).toBe('locked');
    expect(r.getByText('Perkhidmatan dihentikan')).toBeTruthy();
    expect(r.getByText('Hubungi Pentadbir MAXCOM.')).toBeTruthy();
    expect(r.getByText('ID: 4F2A 9C1E 77B0 D3A1')).toBeTruthy();
  });

  it('shows nothing of the surau: no background, clock, prayer bar or name', () => {
    const r = show(makeView('2026-11-03', '15:52', named));
    expect(r.container.querySelector('.bg')).toBeNull();
    expect(r.container.querySelector('[data-role="clock"]')).toBeNull();
    expect(r.container.querySelector('.pbar')).toBeNull();
    expect(r.container.querySelector('.screen--main')).toBeNull();
    expect(r.container.textContent).not.toContain('Surau D\'Waqaf');
  });

  it('wins over the pairing screen', () => {
    const v = makeView('2027-01-01', '09:00');
    const r = show({ ...v, error: new NotPairedError().message, daysAhead: 0 });
    expect(r.getByText('Perkhidmatan dihentikan')).toBeTruthy();
    expect(r.container.querySelector('.screen--pair')).toBeNull();
  });

  it('stays silent: a prayer beep never plays on a stopped box', () => {
    const v = makeView('2026-11-03', '15:52');
    show({ ...v, state: { ...v.state, beep: 'masukWaktu' } });
    expect(holder.beeps.length).toBeGreaterThan(0);
    expect(holder.beeps.every((b) => b === null || b === undefined)).toBe(true);
  });
});
