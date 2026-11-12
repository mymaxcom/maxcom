import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/preact';
import { fingerprintGroups } from '@surau/core';
import type { BoxStateView } from '@surau/core';
import { makeView } from './helpers.tsx';
import { boxView, KEY_FP, qrPayload } from './boxFixture.ts';
import type { KioskView } from '../src/data/kiosk.ts';
import { STRINGS } from '../src/i18n.ts';

const holder = vi.hoisted(() => ({
  view: null as unknown as KioskView,
  box: null as BoxStateView | null,
}));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));
vi.mock('../src/data/boxState.ts', async (orig) => ({
  ...(await orig<typeof import('../src/data/boxState.ts')>()),
  useBoxState: () => ({ view: holder.box, error: null }),
}));

import { App } from '../src/app.tsx';
import { qrPixelSize } from '../src/ui/QrCard.tsx';

function show(box: BoxStateView | null, view: KioskView = makeView('2026-11-03', '15:52')) {
  holder.box = box;
  holder.view = view;
  return render(<App />);
}
const stage = (r: ReturnType<typeof render>) => r.container.querySelector('.stage')!;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Setup screen', () => {
  const expiresAt = '2026-11-03T08:01:41Z';
  const setup = (over: Partial<BoxStateView> = {}) => boxView({ qr: { payload: qrPayload(), expiresAt }, ...over });

  // The code above is live at this instant; the test that wants it dead moves the clock on.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T07:52:00Z'));
  });

  it('a paired hall display, given the setup state without a QR, keeps its normal content', () => {
    const r = show(setup({ qr: undefined }));
    expect(stage(r).getAttribute('data-phase')).not.toBe('setup');
    expect(r.container.querySelector('[data-screen="setup"]')).toBeNull();
    expect(r.queryByTestId('qr')).toBeNull();
  });

  it('routes a setup box to the setup screen with the QR, title and steps', () => {
    const r = show(setup());
    expect(stage(r).getAttribute('data-phase')).toBe('setup');
    expect(r.getByTestId('qr')).toBeTruthy();
    expect(r.getByText('Persediaan pertama')).toBeTruthy();
    expect(r.container.querySelector('[data-role="maxcom-logo"]')).toBeTruthy();
    expect(r.getByText('Sediakan MAXCOM ini')).toBeTruthy();
    expect(r.getByText(/Buka aplikasi MAX Admin Client/)).toBeTruthy();
    expect(r.getByText('Kod persediaan, sekali guna')).toBeTruthy();
    expect(r.getByText('Persediaan perlukan telefon atau iPad dengan kamera')).toBeTruthy();
    expect(r.container.querySelector('[data-role="clock"]')).toBeTruthy();
    expect(r.container.querySelector('.bg')).toBeTruthy();
    // The normal kiosk is not underneath.
    expect(r.container.querySelector('.screen--main')).toBeNull();
  });

  it('prints the fingerprint in four groups', () => {
    const r = show(setup());
    const fp = fingerprintGroups(KEY_FP);
    expect(fp.split(' ')).toHaveLength(4);
    expect(r.getByText(fp)).toBeTruthy();
  });

  it('counts the code down from expiresAt and ticks each second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T07:52:00Z'));
    const r = show(setup());
    expect(r.getByText('Kod baharu dalam 09:41')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(r.getByText('Kod baharu dalam 09:40')).toBeTruthy();
  });

  it('never leaves a dead code on screen: once expired it says a new one is coming', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T08:05:00Z'));
    const r = show(setup());
    expect(r.queryByTestId('qr')).toBeNull();
    expect(r.getByText('Meminta kod baharu...')).toBeTruthy();
  });

  it('shows the address from the signed payload', () => {
    const r = show(setup());
    expect(r.getByText('https://10.168.1.20:8443')).toBeTruthy();
    expect(r.queryByText(/belum ada sijil HTTPS/)).toBeNull();
  });

  it('says the certificate is missing when the box has no address', () => {
    const r = show(boxView({ https: false, qr: { payload: qrPayload({ box: '', caSha256: null }), expiresAt } }));
    expect(r.getByText('MAXCOM ini belum ada sijil HTTPS: pemasang perlu melengkapkan pemasangan')).toBeTruthy();
    expect(r.queryByText('https://10.168.1.20:8443')).toBeNull();
  });

  it('has the one network check button, drawn focused', () => {
    const r = show(setup());
    const buttons = r.container.querySelectorAll('.tvbtn');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe('Semakan rangkaian');
    expect(buttons[0]!.classList.contains('is-focused')).toBe(true);
  });

  it('shows the app line only when there is a download address', () => {
    const none = show(setup());
    expect(none.queryByText(/Aplikasi MAXCOM:/)).toBeNull();
    cleanup();
    const some = show(setup({ appDownloadUrl: 'https://mymaxcom.my/app' }));
    expect(some.getByText('Aplikasi MAXCOM: https://mymaxcom.my/app')).toBeTruthy();
  });

  it('speaks English when the kiosk language is English', () => {
    const r = show(setup(), makeView('2026-11-03', '15:52', { settings: { language: { lang: 'en' } } }));
    expect(r.getByText('Set up this MAXCOM')).toBeTruthy();
    expect(r.getByText('Network check')).toBeTruthy();
  });
});

describe('state routing', () => {
  it('keeps the normal kiosk before the first answer and on an active box', () => {
    const before = show(null);
    expect(before.container.querySelector('.screen--main')).toBeTruthy();
    cleanup();
    const active = show(boxView({ state: 'active' }));
    expect(active.container.querySelector('.screen--main')).toBeTruthy();
  });

  it('a setup box never shows the pairing screen', () => {
    const v = makeView('2027-01-01', '09:00');
    const r = show(boxView({ qr: { payload: qrPayload(), expiresAt: new Date(Date.now() + 60_000).toISOString() } }), v);
    expect(stage(r).getAttribute('data-phase')).toBe('setup');
    expect(r.container.querySelector('.screen--pair')).toBeNull();
  });
});

describe('qrPixelSize', () => {
  it('gives every module a whole number of screen pixels', () => {
    expect(qrPixelSize(800, 113, 1)).toBe(791); // 7 px a module
    expect(qrPixelSize(791, 113, 1)).toBe(791);
    expect(qrPixelSize(790, 113, 1)).toBe(678); // 6 px a module
  });

  it('counts device pixels on a scaled screen', () => {
    // A 960x540 CSS viewport at 2x is still a 1080p panel: 13 device px a module, not 12 or 14 CSS halves.
    expect(qrPixelSize(400, 61, 2)).toBe((13 * 61) / 2);
  });

  it('never returns less than one device pixel a module, and nothing without a code', () => {
    expect(qrPixelSize(50, 113, 1)).toBe(113);
    expect(qrPixelSize(800, 0, 1)).toBe(0);
  });
});

describe('box screen strings', () => {
  const NEW = /^(setup|recovery|locked|net|cloud)/;

  it('never uses the old words for the box or the app', () => {
    for (const [lang, table] of Object.entries(STRINGS)) {
      const bad = Object.entries(table)
        .filter(([, v]) => /Kotak|Peranti MAXCOM|Surau app|aplikasi Surau/i.test(v))
        .map(([k]) => `${lang}.${k}`);
      expect(bad).toEqual([]);
    }
  });

  it('the new keys exist in both languages', () => {
    const newKeys = Object.keys(STRINGS.ms).filter((k) => NEW.test(k));
    expect(newKeys.length).toBeGreaterThan(40);
    for (const k of newKeys) expect(STRINGS.en[k], k).toBeTruthy();
  });
});
