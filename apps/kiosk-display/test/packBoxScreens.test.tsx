import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import type { BoxStateView } from '@surau/core';
import { makeView } from './helpers.tsx';
import { boxView } from './boxFixture.ts';
import type { KioskView } from '../src/data/kiosk.ts';
import { NotPairedError } from '../src/data/bundle.ts';

// A pack stylesheet is never in the page on the box's own screens (setup, recovery, stopped, pairing): they are drawn by
// the box and a theme cannot reach them, not even by loading its stylesheet there.
const holder = vi.hoisted(() => ({ view: null as unknown as KioskView, box: null as BoxStateView | null }));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));
vi.mock('../src/data/boxState.ts', async (orig) => ({
  ...(await orig<typeof import('../src/data/boxState.ts')>()),
  useBoxState: () => ({ view: holder.box, error: null }),
}));

import { App } from '../src/app.tsx';
import { PACK_LINK_ID, PROTECTED_STYLE_ID } from '../src/themes/packLoader.ts';

const packs = { 'hijau-siti': { assetId: 'a'.repeat(64), version: 3, title: 'Hijau Siti', base: 'creative', contract: 1, bytes: 1, fonts: [], screens: [], images: {}, defaults: {} } };
const withPack = (over: Record<string, unknown> = {}, date = '2026-11-03', at = '15:52') =>
  makeView(date, at, { settings: { kioskTemplate: { enabled: true, templateId: 'hijau-siti' }, themeStyle: { styles: {}, packs }, ...over } as never });
const link = (): HTMLElement | null => document.getElementById(PACK_LINK_ID);

beforeEach(() => {
  holder.box = null;
});
afterEach(() => {
  cleanup();
  document.getElementById(PACK_LINK_ID)?.remove();
  document.getElementById(PROTECTED_STYLE_ID)?.remove();
});

describe('no pack stylesheet on the box screens', () => {
  it('the normal screen loads the pack link and the protected rules (the control case)', () => {
    holder.view = withPack();
    const r = render(<App />);
    expect(r.container.querySelector('.stage')!.getAttribute('data-theme')).toBe('hijau-siti');
    expect(link()).not.toBeNull();
    expect(document.getElementById(PROTECTED_STYLE_ID)).not.toBeNull();
  });

  it('the stopped screen has no pack link, no protected rules, and no theme on its stage', () => {
    holder.box = boxView({ state: 'locked', surauName: 'Surau D\'Waqaf' });
    holder.view = withPack();
    const r = render(<App />);
    expect(r.getByText('Perkhidmatan dihentikan')).toBeTruthy();
    expect(link()).toBeNull();
    expect(document.getElementById(PROTECTED_STYLE_ID)).toBeNull();
    const stage = r.container.querySelector('.stage')!;
    expect(stage.getAttribute('data-theme')).toBeNull();
    expect(stage.getAttribute('data-pack')).toBeNull();
  });

  it('the setup screen has none either', () => {
    holder.box = boxView({ state: 'setup', qr: 'data:image/png;base64,AAAA' } as never);
    holder.view = withPack();
    const r = render(<App />);
    expect(link()).toBeNull();
    expect(document.getElementById(PROTECTED_STYLE_ID)).toBeNull();
    expect(r.container.querySelector('.stage')!.getAttribute('data-theme')).toBeNull();
  });

  it('the pairing screen has none either', () => {
    holder.box = null;
    const v = withPack({}, '2027-01-01', '09:00');
    holder.view = { ...v, error: new NotPairedError().message, daysAhead: 0 };
    const r = render(<App />);
    expect(link()).toBeNull();
    expect(document.getElementById(PROTECTED_STYLE_ID)).toBeNull();
    expect(r.container.querySelector('.stage')!.getAttribute('data-theme')).toBeNull();
  });

  it('the pack comes back when the box screen goes away, and goes when it returns', () => {
    holder.view = withPack();
    const r = render(<App />);
    expect(link()).not.toBeNull();
    holder.box = boxView({ state: 'locked', surauName: 'x' });
    r.rerender(<App />);
    expect(link()).toBeNull();
    holder.box = null;
    r.rerender(<App />);
    expect(link()).not.toBeNull();
  });
});
