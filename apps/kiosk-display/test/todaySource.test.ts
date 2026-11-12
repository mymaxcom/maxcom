import { describe, expect, it } from 'vitest';
import type { PrayerDay } from '@surau/core';
import { todaySourceOf } from '../src/data/todaySource.ts';

const row = (date: string, extra: object): PrayerDay =>
  ({ date, hijri: { y: 1448, m: 1, d: 1 }, times: { imsak: '05:00', subuh: '05:10', syuruk: '06:20', zohor: '13:10', asar: '16:20', maghrib: '19:15', isyak: '20:25' }, ...extra }) as PrayerDay;
const prayer = { country: 'MY', hasOfficial: true, timezone: 'Asia/Kuala_Lumpur', utcOffsetMinutes: 480, footerMs: 'Sumber: JAKIM e-Solat SGR01', footerEn: 'Source: JAKIM e-Solat SGR01' };

describe('todaySourceOf footer across midnight', () => {
  const days = [
    row('2026-12-01', { source: 'official', footerMs: 'Sumber: JAKIM e-Solat SGR01', footerEn: 'Source: JAKIM e-Solat SGR01' }),
    row('2026-12-02', { source: 'calc', emergency: true, footerMs: 'Kiraan setempat (JAKIM), Shah Alam', footerEn: 'Local calculation (JAKIM), Shah Alam' }),
  ];

  it('reads the footer of the day the kiosk is on, so it changes at midnight with no new bundle', () => {
    expect(todaySourceOf(days, '2026-12-01', prayer).footer).toEqual({ ms: 'Sumber: JAKIM e-Solat SGR01', en: 'Source: JAKIM e-Solat SGR01' });
    const next = todaySourceOf(days, '2026-12-02', prayer);
    expect(next.footer).toEqual({ ms: 'Kiraan setempat (JAKIM), Shah Alam', en: 'Local calculation (JAKIM), Shah Alam' });
    expect(next.source).toBe('calc');
    expect(next.emergency).toBe(true);
  });

  it('an older bundle (rows without footers) still uses the prayer block, and none gives no footer', () => {
    const old = [row('2026-12-01', { source: 'official' })];
    expect(todaySourceOf(old, '2026-12-01', prayer).footer).toEqual({ ms: prayer.footerMs, en: prayer.footerEn });
    expect(todaySourceOf(old, '2026-12-01', undefined).footer).toBeNull();
  });
});
