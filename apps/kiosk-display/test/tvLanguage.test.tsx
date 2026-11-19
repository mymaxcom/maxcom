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

// W14: Arabic as a third TV language.
import { fmtClock, fmtGregorian, fmtHijri, prayerLabel } from '../src/format.ts';
import { fmtDateLong, fmtDateShort, fmtTimeOfDay, surahNameFor } from '../src/i18n.ts';

describe('TV language Arabic', () => {
  it('an explicit Arabic wins in Malaysia and abroad: the stage is right to left', () => {
    for (const country of ['MY', 'JO']) {
      const r = show({ language: { lang: 'ar' }, location: { country } });
      expect(r.getByText('العصر بعد')).toBeTruthy();
      const stage = r.container.querySelector('.stage')!;
      expect(stage.getAttribute('dir')).toBe('rtl');
      expect(stage.getAttribute('lang')).toBe('ar');
      expect(stage.getAttribute('data-lang')).toBe('ar');
      // The Arabic face goes in front of the theme font.
      expect((stage as HTMLElement).style.getPropertyValue('--font')).toMatch(/^'MX Arabic', /);
      cleanup();
    }
  });

  it('Malay and English stay left to right with the theme font as it was', () => {
    const r = show({ language: { lang: 'ms' } });
    const stage = r.container.querySelector('.stage') as HTMLElement;
    expect(stage.getAttribute('dir')).toBe('ltr');
    expect(stage.getAttribute('lang')).toBe('ms');
    expect(stage.style.getPropertyValue('--font')).not.toMatch(/MX Arabic/);
  });

  it('prayer names, dates and times in Arabic with Western digits', () => {
    expect(prayerLabel('asar', 'ar')).toBe('العصر');
    expect(prayerLabel('jumaat', 'ar')).toBe('الجمعة');
    expect(prayerLabel('subuh', 'ms')).toBe('Subuh');
    const now = new Date('2026-11-03T15:52:00+08:00');
    expect(fmtGregorian(now, 'ar')).toBe('الثلاثاء، 3 نوفمبر 2026');
    expect(fmtHijri({ d: 23, m: 5, y: 1448 }, 'ar')).toBe('23 جمادى الأولى 1448 هـ');
    expect(fmtClock(now, '12h', false, 'ar')).toEqual({ hm: '3:52', s: '00', ampm: 'م' });
    expect(fmtClock(new Date('2026-11-03T09:05:00+08:00'), '12h', false, 'ar').ampm).toBe('ص');
    expect(fmtTimeOfDay('19:15', 'ar')).toBe('7:15 م');
    expect(fmtDateLong('2026-11-07', 'ar')).toBe('السبت، 7 نوفمبر 2026');
    expect(fmtDateShort('2026-11-05', 'ar')).toBe('الخميس 5 نوفمبر');
    // The surah's own Arabic name on an Arabic screen; the content's Malay name otherwise.
    expect(surahNameFor(2, 'Al-Baqarah', 'ar')).toBe('البقرة');
    expect(surahNameFor(2, 'Al-Baqarah', 'ms')).toBe('Al-Baqarah');
    expect(surahNameFor(999, 'X', 'ar')).toBe('X');
  });
});
