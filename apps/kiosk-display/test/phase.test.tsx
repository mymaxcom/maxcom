import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { klInstant } from '@surau/core';
import { makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';

const holder = vi.hoisted(() => ({ view: null as unknown as KioskView }));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));

import { App } from '../src/app.tsx';

function show(view: KioskView) {
  holder.view = view;
  return render(<App />);
}

let play: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
});
afterEach(() => {
  cleanup();
  play.mockRestore();
});

const NO_CONTENT = '[data-layer="content"]';

describe('Phase screens', () => {
  it('azanCountdown 16:12', () => {
    const r = show(makeView('2026-11-03', '16:12'));
    expect(r.getByText('Azan Asar dalam')).toBeTruthy();
    expect(r.container.querySelector('.phase__big')!.textContent).toBe('00:08:00');
    expect(r.container.querySelector(NO_CONTENT)).toBeNull();
    expect(r.container.querySelectorAll('[data-prayer]').length).toBe(7);
  });

  it('masukWaktu 16:20:10', () => {
    const r = show(makeView('2026-11-03', '16:20:10'));
    expect(r.getByText('Telah masuk waktu Asar')).toBeTruthy();
    expect(r.container.querySelector(NO_CONTENT)).toBeNull();
  });

  it('iqamah 16:25 counts down; last endWarningSeconds pulse in accent', () => {
    const r = show(makeView('2026-11-03', '16:25'));
    expect(r.getByText('Iqamah dalam')).toBeTruthy();
    const big = r.container.querySelector('.phase__big')!;
    expect(big.textContent).toBe('00:05:00');
    expect(big.classList.contains('is-warning')).toBe(false);
    expect(r.container.querySelector(NO_CONTENT)).toBeNull();
    cleanup();
    const r2 = show(makeView('2026-11-03', '16:29:45'));
    const big2 = r2.container.querySelector('.phase__big')!;
    expect(big2.textContent).toBe('00:00:15');
    expect(big2.classList.contains('is-warning')).toBe(true);
  });

  it('solat 16:35 dims and shows the message, bar at 30 %', () => {
    const r = show(makeView('2026-11-03', '16:35'));
    expect(r.getByText('Solat sedang didirikan')).toBeTruthy();
    expect(r.getByText('Sila senyapkan telefon bimbit')).toBeTruthy();
    expect(r.container.querySelector('.stage')!.getAttribute('data-dim')).toBe('true');
    expect(r.container.querySelector('.pbar')!.classList.contains('is-dimmed')).toBe(true);
    expect(r.container.querySelector(NO_CONTENT)).toBeNull();
  });

  it('khutbah 2026-11-06 13:05', () => {
    const r = show(makeView('2026-11-06', '13:05'));
    expect(r.getByText('Khutbah Jumaat sedang disampaikan')).toBeTruthy();
    expect(r.getByText('Sila dengar dengan tenang')).toBeTruthy();
    expect(r.getByText('Jumaat')).toBeTruthy();
    expect(r.container.querySelector(NO_CONTENT)).toBeNull();
  });

  it('syuruk 06:52', () => {
    const r = show(makeView('2026-11-03', '06:52'));
    expect(r.getByText('Syuruk dalam')).toBeTruthy();
    expect(r.getByText('Waktu Subuh hampir tamat')).toBeTruthy();
    expect(r.container.querySelector('.phase__big')!.textContent).toBe('00:03:00');
    expect(r.container.querySelector(NO_CONTENT)).toBeNull();
  });

  it('isyraq 07:12', () => {
    const r = show(makeView('2026-11-03', '07:12'));
    expect(r.getByText('Waktu Isyraq')).toBeTruthy();
    expect(r.container.querySelector(NO_CONTENT)).toBeNull();
  });

  it('tarawih 20:50 in hijri month 9', () => {
    const r = show(makeView('2026-11-03', '20:50', { hijriMonth: 9 }));
    expect(r.getByText('Solat Tarawih')).toBeTruthy();
    expect(r.container.querySelector(NO_CONTENT)).toBeNull();
  });

  it('noData 2027-01-01 shows the message, the clock and the date; no prayer times', () => {
    const r = show(makeView('2027-01-01', '09:00'));
    expect(r.getByText('Tiada data waktu solat. Tetapkan lokasi surau dalam aplikasi MAX Admin Client.')).toBeTruthy();
    expect(r.getByText('Jumaat, 1 Januari 2027')).toBeTruthy();
    expect(r.getByText('Surau')).toBeTruthy();
    // The clock is the only h:mm on screen, and it lives inside the element marked as the clock.
    const clocks = r.container.querySelectorAll('[data-role="clock"]');
    expect(clocks.length).toBe(1);
    expect(clocks[0]!.textContent).toBe('9:00PG');
    const rest = r.container.cloneNode(true) as HTMLElement;
    rest.querySelector('[data-role="clock"]')!.remove();
    expect(rest.textContent).not.toMatch(/\d:\d\d/);
    // No prayer times anywhere: no bar, no cells, no phase time.
    expect(r.container.querySelector('.pbar')).toBeNull();
    expect(r.container.querySelectorAll('[data-prayer]').length).toBe(0);
    expect(r.container.querySelector('.pcell__time')).toBeNull();
    expect(r.container.querySelector('.phase__time')).toBeNull();
    expect(r.container.querySelector(NO_CONTENT)).toBeNull();
    expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).toBe('noData');
  });

  it('english copy', () => {
    const r = show(makeView('2026-11-03', '16:12', { settings: { language: { lang: 'en' } } }));
    expect(r.getByText('Azan Asar in')).toBeTruthy();
  });
});

/** The highlighted bar cell (aria-current) and the text of its pill. */
function current(r: ReturnType<typeof show>) {
  const cells = [...r.container.querySelectorAll('[data-prayer]')];
  const hot = cells.filter((c) => c.getAttribute('aria-current') === 'true');
  expect(hot.length).toBe(1);
  const cell = hot[0]!;
  expect(cell.classList.contains('is-current')).toBe(true);
  return { prayer: cell.getAttribute('data-prayer'), pill: cell.querySelector('.pcell__cd')?.textContent ?? null };
}

describe('Prayer bar highlight during a phase', () => {
  it('azanCountdown 16:12 highlights Asar and counts down to its time', () => {
    const r = show(makeView('2026-11-03', '16:12'));
    expect(current(r)).toEqual({ prayer: 'asar', pill: '00:08:00' });
  });

  it('masukWaktu 16:20:10 keeps Asar with the Azan word', () => {
    const r = show(makeView('2026-11-03', '16:20:10'));
    expect(current(r)).toEqual({ prayer: 'asar', pill: 'Azan' });
    expect(r.container.querySelector('[data-prayer="maghrib"]')!.getAttribute('aria-current')).toBeNull();
  });

  it('iqamah 16:25 keeps Asar, not Maghrib, and the pill shows the iqamah remaining', () => {
    const r = show(makeView('2026-11-03', '16:25'));
    expect(current(r)).toEqual({ prayer: 'asar', pill: 'Iqamah00:05:00' });
    expect(r.container.querySelector('[data-prayer="maghrib"]')!.getAttribute('aria-current')).toBeNull();
    expect(r.container.querySelector('[data-prayer="asar"] .pcell__tag')!.textContent).toBe('Iqamah');
    expect(r.container.querySelector('[data-prayer="asar"] [role="timer"]')!.textContent).toBe('00:05:00');
    cleanup();
    const r2 = show(makeView('2026-11-03', '16:29:45'));
    expect(current(r2)).toEqual({ prayer: 'asar', pill: 'Iqamah00:00:15' });
  });

  it('solat 16:35 keeps Asar, not Maghrib, with a calm Solat word', () => {
    const r = show(makeView('2026-11-03', '16:35'));
    expect(current(r)).toEqual({ prayer: 'asar', pill: 'Solat' });
    expect(r.container.querySelector('[data-prayer="maghrib"]')!.getAttribute('aria-current')).toBeNull();
    expect(r.container.querySelector('[data-prayer="asar"] [role="timer"]')).toBeNull();
  });

  it('khutbah 2026-11-06 13:05 highlights the Jumaat (Zohor) cell', () => {
    const r = show(makeView('2026-11-06', '13:05'));
    expect(current(r)).toEqual({ prayer: 'zohor', pill: 'Khutbah' });
    expect(r.container.querySelector('[data-prayer="zohor"] .pcell__label')!.textContent).toBe('Jumaat');
    expect(r.container.querySelector('[data-prayer="asar"]')!.getAttribute('aria-current')).toBeNull();
  });

  it('tarawih 20:50 highlights Isyak', () => {
    const r = show(makeView('2026-11-03', '20:50', { hijriMonth: 9 }));
    expect(current(r)).toEqual({ prayer: 'isyak', pill: 'Tarawih' });
    expect(r.container.querySelector('[data-prayer="imsak"]')!.getAttribute('aria-current')).toBeNull();
  });

  it('syuruk 06:52 and isyraq 07:12 still highlight state.next (Syuruk, then Zohor)', () => {
    const r = show(makeView('2026-11-03', '06:52'));
    expect(current(r)).toEqual({ prayer: 'syuruk', pill: '00:03:00' });
    cleanup();
    const r2 = show(makeView('2026-11-03', '07:12'));
    expect(current(r2).prayer).toBe('zohor');
  });

  it('english pill words', () => {
    const r = show(makeView('2026-11-03', '16:35', { settings: { language: { lang: 'en' } } }));
    expect(current(r).pill).toBe('Prayer');
  });

  it('syuruk 06:52 with Syuruk hidden highlights Zohor and counts down to 1:00', () => {
    const r = show(makeView('2026-11-03', '06:52', { settings: { prayerBar: { showSyuruk: false } } }));
    expect(r.container.querySelectorAll('[data-prayer]').length).toBe(6);
    expect(r.container.querySelector('[data-prayer="syuruk"]')).toBeNull();
    // Zohor is 13:00 on the fixture day: 06:52 -> 13:00 is 6 h 08 min.
    expect(current(r)).toEqual({ prayer: 'zohor', pill: '06:08:00' });
    // The big centre countdown still counts to Syuruk itself.
    expect(r.container.querySelector('.phase__big')!.textContent).toBe('00:03:00');
  });
});

describe('Beep', () => {
  it('plays once across three ticks inside the beep second', () => {
    const base = klInstant('2026-11-03', '16:20');
    const v = makeView('2026-11-03', '16:20');
    expect(v.state.beep).toBe('masukWaktu');
    const r = show(v);
    for (const ms of [300, 700]) {
      holder.view = { ...v, now: new Date(base.getTime() + ms) };
      r.rerender(<App />);
    }
    expect(play).toHaveBeenCalledTimes(1);
    const el = play.mock.instances[0] as HTMLAudioElement;
    expect(el.volume).toBeCloseTo(0.7, 5);
    expect(el.src).toMatch(/beep-long/);
  });

  it('short tone for the azan countdown and the iqamah end warning', () => {
    show(makeView('2026-11-03', '16:10'));
    expect(play).toHaveBeenCalledTimes(1);
    expect((play.mock.instances[0] as HTMLAudioElement).src).toMatch(/beep-short/);
    cleanup();
    show(makeView('2026-11-03', '16:29:30'));
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('stays silent when beeps are off or the state has no beep', () => {
    show(makeView('2026-11-03', '16:20', { settings: { beeps: { enabled: false } } }));
    expect(play).not.toHaveBeenCalled();
    cleanup();
    show(makeView('2026-11-03', '16:25'));
    expect(play).not.toHaveBeenCalled();
  });
});

describe('surau name comes from settings.surauInfo', () => {
  const custom = { surauInfo: { name: 'Masjid Al-Falah' } };
  it('shows the configured name on the main and phase screens', () => {
    expect(show(makeView('2026-11-03', '12:00', { settings: custom })).getByText('Masjid Al-Falah')).toBeTruthy();
    cleanup();
    const r = show(makeView('2026-11-03', '16:12', { settings: custom }));
    expect(r.getByText('Masjid Al-Falah')).toBeTruthy();
    expect(r.queryByText('Surau D\'Waqaf')).toBeNull();
  });
  it('leaves the text name out of the phase head when showName is false and a logo is shown', () => {
    const LOGO = '/surau-logo?v=0123456789abcdef';
    const r = show(makeView('2026-11-03', '16:12', { logo: LOGO, settings: { surauInfo: { name: 'Masjid Al-Falah', showName: false } } }));
    const head = r.container.querySelector('.phase__head .ident__head')!;
    expect(head.querySelector('img[data-role="logo"]')).toBeTruthy();
    expect(head.querySelector('.ident__name')).toBeNull();
    expect(r.queryByText('Masjid Al-Falah')).toBeNull();
    cleanup();
    const r2 = show(makeView('2026-11-03', '16:12', { logo: LOGO, settings: { surauInfo: { name: 'Masjid Al-Falah' } } }));
    expect(r2.container.querySelector('.phase__head .ident__name')!.textContent).toBe('Masjid Al-Falah');
  });
  it('falls back to the built-in name when the setting is blank or missing', async () => {
    const { surauNameOf } = await import('../src/i18n.ts');
    // Neutral: never another surau's name on a box that has not been named yet.
    expect(surauNameOf({ surauInfo: { name: '  ' } }, 'ms')).toBe('Surau');
    expect(surauNameOf(undefined, 'en')).toBe('Surau');
    expect(surauNameOf({ surauInfo: { name: 'Masjid X' } }, 'ms')).toBe('Masjid X');
  });
});

describe('surau logo on the phase screens', () => {
  const LOGO = '/surau-logo?v=0123456789abcdef';
  it('sits beside the name in the head when the bundle has one, and is absent otherwise', () => {
    const r = show(makeView('2026-11-03', '16:12', { logo: LOGO }));
    const head = r.container.querySelector('.phase__head .ident__head')!;
    expect(head.classList.contains('has-logo')).toBe(true);
    const img = head.querySelector('img[data-role="logo"]')!;
    expect(img.getAttribute('src')).toBe(LOGO);
    expect(img.getAttribute('alt')).toBe('');
    cleanup();
    const r2 = show(makeView('2026-11-03', '16:25'));
    expect(r2.container.querySelector('img[data-role="logo"]')).toBeNull();
    expect(r2.container.querySelector('.phase__head .ident__head')!.classList.contains('has-logo')).toBe(false);
  });

  it('is shown on the no-data screen too and hides itself when the picture fails', async () => {
    const r = show(makeView('2027-01-01', '09:00', { logo: LOGO }));
    expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).toBe('noData');
    const img = r.container.querySelector('img[data-role="logo"]')!;
    expect(img).toBeTruthy();
    img.dispatchEvent(new Event('error'));
    await new Promise((res) => setTimeout(res, 0));
    expect(r.container.querySelector('img[data-role="logo"]')).toBeNull();
    expect(r.getByText('Surau')).toBeTruthy();
  });
});
