import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/preact';
import { klInstant, resolveSettings } from '@surau/core';
import { makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';

const holder = vi.hoisted(() => ({ view: null as unknown as KioskView }));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));

import { App } from '../src/app.tsx';
import { urlFor } from '../src/ui/Background.tsx';
import { SafeBoundary } from '../src/ui/SafeBoundary.tsx';

function show(view: KioskView) {
  holder.view = view;
  return render(<App />);
}

afterEach(() => cleanup());

describe('Main screen (layout C)', () => {
  it('does not fade the header on mount (only on an idle <-> card switch after it)', () => {
    const r = show(makeView('2026-11-03', '15:52'));
    expect(r.container.querySelector('.screen--main')!.classList.contains('is-settling')).toBe(false);
  });

  it('shows clock, dates, next prayer and the seven cells at 15:52', () => {
    const r = show(makeView('2026-11-03', '15:52'));
    expect(r.getByText('3:52')).toBeTruthy();
    expect(r.getByText('Selasa, 3 November 2026')).toBeTruthy();
    expect(r.getByText('23 Jamadilawal 1448H')).toBeTruthy();
    expect(r.getByText('Asar dalam')).toBeTruthy();
    // The countdown appears in the top-right box and inside the Asar cell.
    expect(r.getAllByText('00:28:00').length).toBe(2);

    const cells = r.container.querySelectorAll('[data-prayer]');
    expect(cells.length).toBe(7);
    const times = [...cells].map((c) => c.querySelector('.pcell__time')!.textContent);
    expect(times).toEqual(['5:38', '5:48', '6:55', '1:00', '4:20', '6:58', '8:09']);
    expect(times[0]).toBe('5:38');
    expect(times[6]).toBe('8:09');

    // Normal phase: the NEXT prayer (Asar) is highlighted and carries the countdown pill.
    const asar = r.container.querySelector('[data-prayer="asar"]')!;
    expect(asar.getAttribute('aria-current')).toBe('true');
    expect(asar.classList.contains('is-current')).toBe(true);
    expect(asar.querySelector('.pcell__cd')!.textContent).toBe('00:28:00');
    expect(r.container.querySelector('[data-prayer="maghrib"]')!.getAttribute('aria-current')).toBeNull();
    expect([...cells].filter((c) => c.getAttribute('aria-current') === 'true').length).toBe(1);
    expect(r.container.querySelector('[data-layer="content"]')).toBeTruthy();
    expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).toBe('normal');
  });

  it('shows the surau logo beside the name top-left when the bundle has one, else nothing changes', async () => {
    const LOGO = '/surau-logo?v=0123456789abcdef';
    const r = show(makeView('2026-11-03', '15:52', { logo: LOGO, settings: { surauInfo: { name: 'Surau Al-Hidayah' } } }));
    const head = r.container.querySelector('.ident > .ident__head')!;
    expect(head.classList.contains('has-logo')).toBe(true);
    const img = head.querySelector('img[data-role="logo"]')!;
    expect(img.getAttribute('src')).toBe(LOGO);
    expect(img.getAttribute('alt')).toBe('');
    expect(img.classList.contains('ident__logo')).toBe(true);
    expect(head.querySelector('.ident__name')!.textContent).toBe('Surau Al-Hidayah');
    // A logo that cannot be fetched disappears without a trace.
    img.dispatchEvent(new Event('error'));
    await new Promise((res) => setTimeout(res, 0));
    expect(r.container.querySelector('img[data-role="logo"]')).toBeNull();
    cleanup();
    const r2 = show(makeView('2026-11-03', '15:52'));
    expect(r2.container.querySelector('img[data-role="logo"]')).toBeNull();
    expect(r2.container.querySelector('.ident > .ident__head')!.classList.contains('has-logo')).toBe(false);
    expect(r2.getByText('Surau')).toBeTruthy();
  });

  it('leaves the text name out when surauInfo.showName is false and a logo is shown; without a logo the name always shows', () => {
    const LOGO = '/surau-logo?v=0123456789abcdef';
    const r = show(makeView('2026-11-03', '15:52', { logo: LOGO, settings: { surauInfo: { name: 'Surau Al-Hidayah', showName: false } } }));
    const head = r.container.querySelector('.ident > .ident__head')!;
    expect(head.classList.contains('has-logo')).toBe(true);
    expect(head.querySelector('img[data-role="logo"]')).toBeTruthy();
    expect(head.querySelector('.ident__name')).toBeNull();
    expect(r.queryByText('Surau Al-Hidayah')).toBeNull();
    cleanup();
    const r2 = show(makeView('2026-11-03', '15:52', { settings: { surauInfo: { name: 'Surau Al-Hidayah', showName: false } } }));
    expect(r2.container.querySelector('.ident__name')!.textContent).toBe('Surau Al-Hidayah');
  });

  it('labels Friday Zohor as Jumaat', () => {
    const r = show(makeView('2026-11-06', '09:00'));
    expect(r.getByText('Jumaat')).toBeTruthy();
    expect(r.queryByText('Zohor')).toBeNull();
    expect(r.getByText('Jumaat dalam')).toBeTruthy();
  });

  it('hides Imsak when prayerBar.showImsak is false', () => {
    const r = show(makeView('2026-11-03', '15:52', { settings: { prayerBar: { showImsak: false } } }));
    expect(r.container.querySelectorAll('[data-prayer]').length).toBe(6);
    expect(r.container.querySelector('[data-prayer="imsak"]')).toBeNull();
  });

  it('switches the date language with language.lang', () => {
    const r = show(makeView('2026-11-03', '15:52', { settings: { language: { lang: 'en' } } }));
    expect(r.getByText('Tuesday, 3 November 2026')).toBeTruthy();
    expect(r.getByText('Asar in')).toBeTruthy();
  });

  it('honours 24h format and seconds', () => {
    const r = show(makeView('2026-11-03', '15:52:07', {
      settings: { prayerBar: { timeFormat: '24h' }, clock: { showSeconds: true } },
    }));
    expect(r.getByText('15:52')).toBeTruthy();
    expect(r.getByText('07')).toBeTruthy();
    expect(r.container.querySelector('[data-prayer="asar"] .pcell__time')!.textContent).toBe('16:20');
  });

  it('shows only a grey dot when the data is stale', () => {
    const r = show(makeView('2026-11-03', '15:52', { stale: true }));
    expect(r.getByTestId('status-dot')).toBeTruthy();
    expect(r.getByTestId('status-dot').textContent).toBe('');
    cleanup();
    const r2 = show(makeView('2026-11-03', '15:52'));
    expect(r2.queryByTestId('status-dot')).toBeNull();
  });

  it('keeps the countdown on tomorrow Imsak after Isyak', () => {
    const r = show(makeView('2026-11-03', '21:30'));
    expect(r.getByText('Imsak dalam')).toBeTruthy();
    expect(r.container.querySelector('[data-prayer="imsak"]')!.getAttribute('aria-current')).toBe('true');
  });

  it('highlights the next visible cell (Subuh) when the next prayer is a hidden Imsak', () => {
    const r = show(makeView('2026-11-03', '21:30', { settings: { prayerBar: { showImsak: false } } }));
    const cells = [...r.container.querySelectorAll('[data-prayer]')];
    expect(cells.length).toBe(6);
    const hot = cells.filter((c) => c.getAttribute('aria-current') === 'true');
    expect(hot.length).toBe(1);
    expect(hot[0]!.getAttribute('data-prayer')).toBe('subuh');
    expect(hot[0]!.classList.contains('is-current')).toBe(true);
    // Its own countdown: today's Subuh (05:48) a day later, 21:30 -> 05:48 = 8 h 18 min.
    expect(hot[0]!.querySelector('.pcell__cd')!.textContent).toBe('08:18:00');
    // The top-right box still names the real next prayer.
    expect(r.getByText('Imsak dalam')).toBeTruthy();
  });

  it('highlights Zohor when the next prayer is a hidden Syuruk (06:30)', () => {
    const r = show(makeView('2026-11-03', '06:30', { settings: { prayerBar: { showSyuruk: false } } }));
    const hot = [...r.container.querySelectorAll('[data-prayer][aria-current="true"]')];
    expect(hot.length).toBe(1);
    expect(hot[0]!.getAttribute('data-prayer')).toBe('zohor');
    expect(hot[0]!.querySelector('.pcell__cd')!.textContent).toBe('06:30:00');
  });
});

describe('Background urlFor', () => {
  const builtIn1 = urlFor('default-1');
  const builtIn2 = urlFor('default-2');

  it('returns the built-in assets by their own keys', () => {
    expect(builtIn1).toMatch(/default-1/);
    expect(builtIn2).toMatch(/default-2/);
    expect(builtIn1).not.toBe(builtIn2);
  });

  it('accepts one plain file name under /uploads/', () => {
    expect(urlFor('/uploads/masjid.jpg')).toBe('/uploads/masjid.jpg');
    expect(urlFor('/uploads/bg_2026-11.PNG')).toBe('/uploads/bg_2026-11.PNG');
    expect(urlFor(`/uploads/${'a'.repeat(100)}`)).toBe(`/uploads/${'a'.repeat(100)}`);
  });

  it('resolves a box asset id (64 lower-case hex) to /assets/<id>', () => {
    const id = 'a1b2c3d4'.repeat(8);
    expect(urlFor(id)).toBe(`/assets/${id}`);
    expect(urlFor(`${id}0`)).toBe(builtIn1);
    expect(urlFor(id.toUpperCase())).toBe(builtIn1);
    expect(urlFor(id.slice(1))).toBe(builtIn1);
  });

  it('falls back to default-1 for anything else', () => {
    const bad = [
      '//evil.example/x.png',
      '/\\evil.example/x.png',
      'http://evil.example/x.png',
      'https://evil.example/x.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      '/uploads/../x.png',
      '/uploads/..',
      '/uploads/.',
      '/uploads/',
      '/uploads',
      '/uploads/a/b.png',
      '/uploads/a b.png',
      '/uploads/a%20b.png',
      `/uploads/${'a'.repeat(101)}`,
      '/other/x.png',
      '/x.png',
      'default-3',
      '',
    ];
    for (const name of bad) expect(urlFor(name), name).toBe(builtIn1);
  });

  it('does not treat Object.prototype keys as built-ins', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(urlFor(name), name).toBe(builtIn1);
    }
  });
});

describe('Error boundary (SafeBoundary)', () => {
  function Boom(): never {
    throw new Error('render exploded');
  }

  // The boundary re-announces the crash on window for the page-level recovery handler;
  // in Vitest a window 'error' event with no app listener is reported as unhandled, so
  // the tests stand in for that handler.
  const swallow = (e: Event) => e.preventDefault();
  beforeEach(() => window.addEventListener('error', swallow));
  afterEach(() => window.removeEventListener('error', swallow));

  it('a child that throws renders the safe screen with the clock, the date and the times', () => {
    vi.useFakeTimers();
    vi.setSystemTime(klInstant('2026-11-03', '15:52'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const view = makeView('2026-11-03', '15:52');
      const r = render(
        <SafeBoundary today={view.state.today} settings={view.settings} lang="ms">
          <Boom />
        </SafeBoundary>,
      );
      expect(r.getByTestId('safe-screen')).toBeTruthy();
      expect(r.getByText('Surau')).toBeTruthy();
      const clock = r.container.querySelector('[data-role="clock"]')!;
      expect(clock.textContent).toBe('3:52PTG');
      expect(r.getByText('Selasa, 3 November 2026')).toBeTruthy();
      const times = [...r.container.querySelectorAll('[data-prayer] .pcell__time')].map((c) => c.textContent);
      expect(times).toEqual(['5:38', '5:48', '6:55', '1:00', '4:20', '6:58', '8:09']);
      expect(err).toHaveBeenCalled();
      // The clock ticks on its own, from Date, not from the crashed tree.
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(r.container.querySelector('[data-role="clock"]')!.textContent).toBe('3:53PTG');
    } finally {
      err.mockRestore();
      vi.useRealTimers();
    }
  });

  it('omits the times when today is missing or malformed, never blank', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const settings = resolveSettings({});
      const r = render(
        <SafeBoundary today={null} settings={settings} lang="en">
          <Boom />
        </SafeBoundary>,
      );
      expect(r.container.querySelector('[data-role="clock"]')!.textContent).toMatch(/^\d{1,2}:\d\d(AM|PM)$/);
      expect(r.container.querySelectorAll('[data-prayer]').length).toBe(0);
      cleanup();
      const broken = { date: '2026-11-03', hijri: { y: 1448, m: 5, d: 23 }, times: { subuh: '25:00' } };
      const r2 = render(
        <SafeBoundary today={broken as never} settings={settings} lang="ms">
          <Boom />
        </SafeBoundary>,
      );
      expect(r2.getByTestId('safe-screen')).toBeTruthy();
      expect(r2.container.querySelectorAll('[data-prayer]').length).toBe(0);
    } finally {
      err.mockRestore();
    }
  });

  it('renders the children untouched when nothing throws', () => {
    const settings = resolveSettings({});
    const r = render(
      <SafeBoundary today={null} settings={settings} lang="ms">
        <p>fine</p>
      </SafeBoundary>,
    );
    expect(r.getByText('fine')).toBeTruthy();
    expect(r.queryByTestId('safe-screen')).toBeNull();
  });

  it('re-announces the error on window and retries the tree after 30 s', () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    const onError = (e: Event) => seen.push((e as ErrorEvent).message);
    window.addEventListener('error', onError);
    try {
      let throws = true;
      function Flaky() {
        if (throws) throw new Error('once');
        return <p>recovered</p>;
      }
      const settings = resolveSettings({});
      const r = render(
        <SafeBoundary today={null} settings={settings} lang="ms">
          <Flaky />
        </SafeBoundary>,
      );
      expect(r.getByTestId('safe-screen')).toBeTruthy();
      expect(seen).toEqual(['once']);
      throws = false;
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(r.getByText('recovered')).toBeTruthy();
      expect(r.queryByTestId('safe-screen')).toBeNull();
    } finally {
      window.removeEventListener('error', onError);
      err.mockRestore();
      vi.useRealTimers();
    }
  });
});
