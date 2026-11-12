import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { computeKioskState, resolveSettings } from '@surau/core';
import type { PrayerDay, ResolvedDay } from '@surau/core';
import { days as klDays, makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';
import type { PrayerInfo } from '../src/data/bundle.ts';
import { STRINGS } from '../src/i18n.ts';

const holder = vi.hoisted(() => ({ view: null as unknown as KioskView }));
vi.mock('../src/data/kiosk.ts', async (orig) => {
  const real = await orig<typeof import('../src/data/kiosk.ts')>();
  return { ...real, useKiosk: () => holder.view };
});

import { App } from '../src/app.tsx';

function show(view: KioskView) {
  holder.view = view;
  return render(<App />);
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NAIROBI: PrayerInfo = {
  country: 'KE',
  hasOfficial: false,
  timezone: 'Africa/Nairobi',
  utcOffsetMinutes: 180,
  footerMs: 'Kiraan setempat (Liga Dunia Islam), Nairobi',
  footerEn: 'Calculated locally (Muslim World League), Nairobi',
};
const SGR01: PrayerInfo = {
  country: 'MY',
  hasOfficial: true,
  timezone: 'Asia/Kuala_Lumpur',
  utcOffsetMinutes: 480,
  footerMs: 'Sumber: JAKIM e-Solat SGR01',
  footerEn: 'Source: JAKIM e-Solat SGR01',
};

function resolved(list: PrayerDay[], over: Partial<ResolvedDay>): ResolvedDay[] {
  return list.map((d) => ({ ...d, source: 'official', corrected: [], emergency: false, hijriSource: 'official', ...over }) as ResolvedDay);
}

const nairobiDay = {
  date: '2026-11-09',
  hijri: { y: 1448, m: 5, d: 20 },
  times: { imsak: '04:40', subuh: '04:50', syuruk: '06:00', zohor: '12:20', asar: '15:30', maghrib: '18:20', isyak: '19:30' },
  source: 'calc',
  corrected: [],
  emergency: false,
  hijriSource: 'calc',
} as ResolvedDay;

const BAND = '[data-testid="emergency-band"]';
const FOOTER = '[data-testid="source-footer"]';
const NAIROBI_SETTINGS = { location: { timezone: 'Africa/Nairobi' } };
const EMERGENCY = { source: 'calc', emergency: true, hijriSource: 'calc' } as const;

describe('surau time zone', () => {
  it('Nairobi bundle at 09:30Z shows 12:30 on the wall clock and the Nairobi phase', () => {
    const at = new Date('2026-11-09T09:30:00Z');
    const view = makeView('', '', { at, days: [nairobiDay], prayer: NAIROBI, settings: NAIROBI_SETTINGS });
    expect(view.tz).toBe('Africa/Nairobi');
    // 12:20 is Zohor in Nairobi; read by KL wall time (17:30) the same instant would be after Asar.
    expect(view.state.today?.date).toBe('2026-11-09');
    expect(view.state.phase).not.toBe('noData');
    expect(view.state.phase).toBe(computeKioskState(at, [nairobiDay], resolveSettings(NAIROBI_SETTINGS), undefined).phase);
    const r = show(view);
    expect(r.container.querySelector('[data-role="clock"]')!.textContent).toBe('12:30PTG');
    expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).toBe(view.state.phase);
    expect(r.container.querySelectorAll('[data-prayer]').length).toBe(7);
    expect(r.container.querySelector('.pcell__time')!.textContent).toBe('4:40');
  });

  it('the Gregorian date follows the zone across midnight', () => {
    // 22:00Z on the 8th is 01:00 of the 9th in Nairobi; 17:00Z is still 20:00 of the 8th there.
    const late = makeView('', '', { at: new Date('2026-11-08T22:00:00Z'), days: [nairobiDay], prayer: NAIROBI, settings: NAIROBI_SETTINGS });
    expect(show(late).getByText('Isnin, 9 November 2026')).toBeTruthy();
    cleanup();
    const early = makeView('', '', { at: new Date('2026-11-08T17:00:00Z'), days: [nairobiDay], prayer: NAIROBI, settings: NAIROBI_SETTINGS });
    expect(show(early).getByText('Ahad, 8 November 2026')).toBeTruthy();
  });

  it('the KL fixture renders as before: KL clock, no footer, no band', () => {
    const r = show(makeView('2026-11-03', '15:52'));
    expect(r.container.querySelector('[data-role="clock"]')!.textContent).toBe('3:52PTG');
    expect(r.getByText('Selasa, 3 November 2026')).toBeTruthy();
    expect(r.container.querySelector(FOOTER)).toBeNull();
    expect(r.container.querySelector(BAND)).toBeNull();
  });
});

describe('source footer and emergency band', () => {
  it('official day: footer "Sumber: JAKIM e-Solat SGR01", no band', () => {
    const view = makeView('2026-11-03', '15:52', { days: resolved(klDays, {}), prayer: SGR01 });
    expect(view.todaySource).toEqual({ source: 'official', emergency: false, footer: { ms: SGR01.footerMs, en: SGR01.footerEn } });
    const r = show(view);
    expect(r.container.querySelector(FOOTER)!.textContent).toBe('Sumber: JAKIM e-Solat SGR01');
    expect(r.container.querySelector(BAND)).toBeNull();
  });

  it('shows the finished line the box sent, including " dan pembetulan"', () => {
    const prayer = { ...SGR01, footerMs: 'Sumber: JAKIM e-Solat SGR01 dan pembetulan', footerEn: 'Source: JAKIM e-Solat SGR01 and corrections' };
    const r = show(makeView('2026-11-03', '15:52', { days: resolved(klDays, { corrected: ['asar'] }), prayer }));
    expect(r.container.querySelector(FOOTER)!.textContent).toBe('Sumber: JAKIM e-Solat SGR01 dan pembetulan');
  });

  it('English uses footerEn', () => {
    const r = show(makeView('2026-11-03', '15:52', { days: resolved(klDays, {}), prayer: SGR01, settings: { language: { lang: 'en' } } }));
    expect(r.container.querySelector(FOOTER)!.textContent).toBe('Source: JAKIM e-Solat SGR01');
  });

  it('calc + emergency: the gold band and the footer render', () => {
    const prayer = { ...SGR01, footerMs: 'Kiraan setempat (JAKIM 20/18), Shah Alam' };
    const r = show(makeView('2026-11-03', '15:52', { days: resolved(klDays, EMERGENCY), prayer }));
    expect(r.container.querySelector(BAND)!.textContent).toBe('Waktu kiraan sementara; data rasmi JAKIM tiada untuk hari ini');
    expect(r.container.querySelector(FOOTER)!.textContent).toBe('Kiraan setempat (JAKIM 20/18), Shah Alam');
  });

  it('English band text', () => {
    const r = show(makeView('2026-11-03', '15:52', {
      days: resolved(klDays, EMERGENCY),
      prayer: SGR01,
      settings: { language: { lang: 'en' } },
    }));
    expect(r.container.querySelector(BAND)!.textContent).toBe('Temporary calculated times; no official JAKIM data for today');
  });

  it('calc without emergency (Nairobi): footer only, no band', () => {
    const view = makeView('', '', { at: new Date('2026-11-09T09:30:00Z'), days: [nairobiDay], prayer: NAIROBI, settings: NAIROBI_SETTINGS });
    const r = show(view);
    expect(r.container.querySelector(FOOTER)!.textContent).toBe('Kiraan setempat (Liga Dunia Islam), Nairobi');
    expect(r.container.querySelector(BAND)).toBeNull();
  });

  it('the band is absent in the prayer layer (iqamah) and present in the normal phase', () => {
    const emergency = resolved(klDays, EMERGENCY);
    const iq = show(makeView('2026-11-03', '16:25', { days: emergency, prayer: SGR01 }));
    expect(iq.container.querySelector('.stage')!.getAttribute('data-phase')).toBe('iqamah');
    expect(iq.container.querySelector(BAND)).toBeNull();
    expect(iq.container.querySelector(FOOTER)).not.toBeNull();
    cleanup();
    const normal = show(makeView('2026-11-03', '15:52', { days: emergency, prayer: SGR01 }));
    expect(normal.container.querySelector('.stage')!.getAttribute('data-phase')).toBe('normal');
    expect(normal.container.querySelector(BAND)).not.toBeNull();
  });

  for (const [hhmm, phase] of [['16:12', 'azanCountdown'], ['16:20:10', 'masukWaktu'], ['16:35', 'solat']] as const) {
    it(`no band during ${phase}`, () => {
      const r = show(makeView('2026-11-03', hhmm, { days: resolved(klDays, EMERGENCY), prayer: SGR01 }));
      expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).toBe(phase);
      expect(r.container.querySelector(BAND)).toBeNull();
    });
  }

  it('noData: the new text, no band, no footer', () => {
    const r = show(makeView('2027-01-01', '09:00', { days: resolved(klDays, EMERGENCY), prayer: SGR01 }));
    expect(r.getByText('Tiada data waktu solat. Tetapkan lokasi surau dalam aplikasi MAX Admin Client.')).toBeTruthy();
    expect(r.container.querySelector(BAND)).toBeNull();
    expect(r.container.querySelector(FOOTER)).toBeNull();
  });

  it('i18n carries the band and noData strings in both languages', () => {
    expect(STRINGS.ms['kiosk.emergency']).toBe('Waktu kiraan sementara; data rasmi JAKIM tiada untuk hari ini');
    expect(STRINGS.en['kiosk.emergency']).toBe('Temporary calculated times; no official JAKIM data for today');
    expect(STRINGS.ms.noData).toBe('Tiada data waktu solat. Tetapkan lokasi surau dalam aplikasi MAX Admin Client.');
    expect(STRINGS.en.noData).toMatch(/MAX Admin Client/);
  });
});

describe('bundle without a prayer block (an old cached bundle)', () => {
  it('renders with the KL default and no footer', () => {
    const view = makeView('2026-11-03', '15:52');
    expect(view.tz).toBe('Asia/Kuala_Lumpur');
    expect(view.todaySource).toEqual({ source: 'official', emergency: false, footer: null });
    const r = show(view);
    expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).toBe('normal');
    expect(r.container.querySelector(FOOTER)).toBeNull();
  });
});
