import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';

const holder = vi.hoisted(() => ({ view: null as unknown as KioskView }));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));

import { App } from '../src/app.tsx';

function show(settings: Record<string, Record<string, unknown>>) {
  holder.view = makeView('2026-11-03', '15:52', { settings });
  return render(<App />);
}

afterEach(() => cleanup());

describe('TV language by location', () => {
  it('auto in another country shows English', () => {
    const r = show({ language: { lang: 'auto' }, location: { country: 'JO' } });
    expect(r.getByText('Asar in')).toBeTruthy();
  });

  it('auto in Malaysia shows BM', () => {
    const r = show({ language: { lang: 'auto' }, location: { country: 'MY' } });
    expect(r.getByText('Asar dalam')).toBeTruthy();
  });

  it('an explicit BM wins abroad', () => {
    const r = show({ language: { lang: 'ms' }, location: { country: 'JO' } });
    expect(r.getByText('Asar dalam')).toBeTruthy();
  });
});
