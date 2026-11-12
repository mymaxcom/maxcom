import { describe, expect, it } from 'vitest';
import {
  dateOf, hourOf, instantOf, isValidTimeZone, klDateOf, klInstant, offsetMinutes, tzOf,
  computeKioskState, resolveSettings, hijriOf, hijriForDisplay,
} from '../src/index.ts';
import type { PrayerDay } from '../src/index.ts';

const KL = 'Asia/Kuala_Lumpur';

describe('wall clock by zone', () => {
  it('equals the fixed UTC+8 functions for Kuala Lumpur, hour by hour over 20 years', () => {
    let n = 0;
    for (let ms = Date.UTC(2020, 0, 1); ms < Date.UTC(2040, 0, 1); ms += 3600000) {
      const at = new Date(ms);
      if (dateOf(at, KL) !== klDateOf(at)) throw new Error(`dateOf differs at ${at.toISOString()}`);
      n++;
    }
    expect(n).toBeGreaterThan(175000);
  });
  it('instantOf equals klInstant for Kuala Lumpur', () => {
    for (const [d, t] of [['2026-11-03', '16:20'], ['2020-02-29', '00:00'], ['2039-12-31', '23:59:59'], ['2026-01-01', '12:00:30']] as const) {
      expect(instantOf(d, t, KL).getTime()).toBe(klInstant(d, t).getTime());
    }
  });
  it('follows the zone: Nairobi is UTC+3', () => {
    expect(dateOf(new Date('2026-11-09T21:30:00Z'), 'Africa/Nairobi')).toBe('2026-11-10');
    expect(dateOf(new Date('2026-11-09T21:30:00Z'), KL)).toBe('2026-11-10');
    expect(dateOf(new Date('2026-11-09T15:30:00Z'), 'Africa/Nairobi')).toBe('2026-11-09');
    expect(dateOf(new Date('2026-11-09T17:30:00Z'), KL)).toBe('2026-11-10');
    expect(hourOf(new Date('2026-11-09T09:30:00Z'), 'Africa/Nairobi')).toBe(12);
    expect(offsetMinutes(new Date('2026-11-09T09:30:00Z'), 'Africa/Nairobi')).toBe(180);
    expect(offsetMinutes(new Date('2026-11-09T09:30:00Z'), KL)).toBe(480);
    expect(instantOf('2026-11-09', '12:30', 'Africa/Nairobi').toISOString()).toBe('2026-11-09T09:30:00.000Z');
  });
  it('London: offset flips 0 to 60 and the skipped half hour maps to the change', () => {
    expect(offsetMinutes(new Date('2026-03-29T00:59:00Z'), 'Europe/London')).toBe(0);
    expect(offsetMinutes(new Date('2026-03-29T01:00:00Z'), 'Europe/London')).toBe(60);
    expect(instantOf('2026-03-29', '01:30', 'Europe/London').toISOString()).toBe('2026-03-29T01:00:00.000Z');
    expect(instantOf('2026-03-29', '02:30', 'Europe/London').toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });
  it('London: an ambiguous local time takes the first', () => {
    expect(instantOf('2026-10-25', '01:30', 'Europe/London').toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });
  it('rejects bad input', () => {
    expect(() => instantOf('2026-13-01', '10:00', KL)).toThrow();
    expect(() => instantOf('2026-01-01', '25:00', KL)).toThrow();
    expect(() => instantOf('2026-01-01', '9:00', KL)).toThrow();
  });
  it('validates zone names', () => {
    expect(isValidTimeZone('Asia/Kuala_Lumpur')).toBe(true);
    expect(isValidTimeZone('Asia/Kuala Lumpur')).toBe(false);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('zzz-wrong')).toBe(false);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isValidTimeZone('+08:00')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(5)).toBe(false);
    expect(isValidTimeZone('Asia/' + 'x'.repeat(70))).toBe(false);
  });
  it('tzOf reads the location, with a Kuala Lumpur fallback', () => {
    expect(tzOf(resolveSettings({}))).toBe(KL);
    expect(tzOf({ location: { timezone: 'Africa/Nairobi' } })).toBe('Africa/Nairobi');
    expect(tzOf({ location: { timezone: 'Mars/Olympus' } })).toBe(KL);
    expect(tzOf(undefined)).toBe(KL);
    expect(tzOf(null)).toBe(KL);
  });
});

describe('Hijri by Umm al-Qura', () => {
  it('matches e-Solat for 2026-11-09 and rolls the day', () => {
    expect(hijriOf('2026-11-09')).toEqual({ y: 1448, m: 5, d: 29 });
    const next = hijriOf('2026-11-10');
    expect(next.y === 1448 && ((next.m === 5 && next.d === 30) || (next.m === 6 && next.d === 1))).toBe(true);
  });
  it('rejects a bad date', () => {
    expect(() => hijriOf('xxxx-xx-xx')).toThrow();
  });
  it('hijriForDisplay still takes a zone and defaults to Kuala Lumpur', () => {
    const mk = (date: string, d: number): PrayerDay => ({
      date, hijri: { y: 1448, m: 5, d },
      times: { imsak: '05:00', subuh: '05:10', syuruk: '06:20', zohor: '12:10', asar: '15:30', maghrib: '18:20', isyak: '19:30' },
    });
    const days = [mk('2026-11-09', 29), mk('2026-11-10', 30)];
    expect(hijriForDisplay(klInstant('2026-11-09', '10:00'), days, 0, 'maghrib')).toMatchObject({ d: 29 });
    expect(hijriForDisplay(klInstant('2026-11-09', '19:00'), days, 0, 'maghrib')).toMatchObject({ d: 30 });
    expect(hijriForDisplay(instantOf('2026-11-09', '19:00', 'Africa/Nairobi'), days, 0, 'maghrib', 'Africa/Nairobi')).toMatchObject({ d: 30 });
  });
});

describe('the kiosk state reads the surau zone', () => {
  const nairobiDay: PrayerDay = {
    date: '2026-11-09', hijri: { y: 1448, m: 5, d: 29 },
    times: { imsak: '04:40', subuh: '04:50', syuruk: '06:00', zohor: '12:12', asar: '15:30', maghrib: '18:20', isyak: '19:30' },
  };
  const at = new Date('2026-11-09T09:30:00Z'); // 12:30 in Nairobi, 17:30 in Kuala Lumpur
  const nairobi = () => resolveSettings({ location: { country: 'KE', timezone: 'Africa/Nairobi' } });
  it('Nairobi: 18 minutes after Zohor is the prayer screen', () => {
    expect(computeKioskState(at, [nairobiDay], nairobi())).toMatchObject({ phase: 'solat', prayer: 'zohor' });
  });
  it('the same inputs with the Kuala Lumpur default give another phase', () => {
    const r = computeKioskState(at, [nairobiDay], resolveSettings({}));
    expect(r.phase).not.toBe('solat');
  });
  it('a per-day iqamah override beats the weekly table', () => {
    const d: PrayerDay = { ...nairobiDay, overrides: { iqamahMinutes: { zohor: 3 } } };
    const t0 = instantOf('2026-11-09', '12:12', 'Africa/Nairobi').getTime();
    const r = computeKioskState(new Date(t0 + 2 * 60000), [d], nairobi());
    expect(r.phase).toBe('iqamah');
    expect(r.phaseEndsAt!.getTime()).toBe(t0 + 3 * 60000);
    const plain = computeKioskState(new Date(t0 + 2 * 60000), [nairobiDay], nairobi());
    expect(plain.phaseEndsAt!.getTime()).toBe(t0 + 10 * 60000);
  });
  it('a per-day khutbah override lengthens the Friday khutbah', () => {
    const friday: PrayerDay = { ...nairobiDay, date: '2026-11-13', overrides: { khutbahMinutes: 35 } };
    const t0 = instantOf('2026-11-13', '12:12', 'Africa/Nairobi').getTime();
    const r = computeKioskState(new Date(t0 + 30 * 60000), [friday], nairobi());
    expect(r.phase).toBe('khutbah');
    const normal = computeKioskState(new Date(t0 + 30 * 60000), [{ ...friday, overrides: undefined }], nairobi());
    expect(normal.phase).not.toBe('khutbah');
  });
});
