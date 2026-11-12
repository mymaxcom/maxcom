import { describe, expect, it } from 'vitest';
import { klInstant } from '@surau/core';
import { fmtClock, fmtCountdown, fmtGregorian, fmtHijri, fmtPrayerTime, prayerLabel } from '../src/format.ts';
import { STRINGS, t } from '../src/i18n.ts';

describe('fmtClock', () => {
  const at = (hhmm: string) => klInstant('2026-11-03', hhmm);
  it('12h', () => {
    expect(fmtClock(at('15:52'), '12h', false, 'ms')).toEqual({ hm: '3:52', s: '00', ampm: 'PTG' });
    expect(fmtClock(at('15:52'), '12h', false, 'en').ampm).toBe('PM');
    expect(fmtClock(at('00:05'), '12h', false, 'ms')).toMatchObject({ hm: '12:05', ampm: 'PG' });
    expect(fmtClock(at('12:00'), '12h', false, 'ms')).toMatchObject({ hm: '12:00', ampm: 'PTG' });
  });
  it('24h', () => {
    expect(fmtClock(at('15:52'), '24h', false, 'ms').hm).toBe('15:52');
    expect(fmtClock(at('00:05'), '24h', false, 'ms').hm).toBe('00:05');
  });
});

describe('fmt helpers', () => {
  it('prayer time', () => {
    expect(fmtPrayerTime('16:20', '12h')).toBe('4:20');
    expect(fmtPrayerTime('16:20', '24h')).toBe('16:20');
    expect(fmtPrayerTime('00:10', '12h')).toBe('12:10');
  });
  it('countdown', () => {
    expect(fmtCountdown(28 * 60000)).toBe('00:28:00');
    expect(fmtCountdown(-5)).toBe('00:00:00');
    expect(fmtCountdown(26 * 3600000)).toBe('26:00:00');
    expect(fmtCountdown(1999)).toBe('00:00:01');
  });
  it('gregorian', () => {
    const now = klInstant('2026-11-03', '15:52');
    expect(fmtGregorian(now, 'ms')).toBe('Selasa, 3 November 2026');
    expect(fmtGregorian(now, 'en')).toBe('Tuesday, 3 November 2026');
    expect(fmtGregorian(new Date('2026-11-05T23:30:00Z'), 'ms')).toBe('Jumaat, 6 November 2026');
  });
  it('hijri', () => {
    expect(fmtHijri({ y: 1448, m: 5, d: 23 }, 'ms')).toBe('23 Jamadilawal 1448H');
    expect(fmtHijri({ y: 1448, m: 5, d: 23 }, 'en')).toBe('23 Jumada al-Ula 1448 AH');
  });
  it('prayer labels', () => {
    expect(prayerLabel('jumaat', 'en')).toBe('Jumaat');
    expect(prayerLabel('isyak', 'ms')).toBe('Isyak');
    expect(prayerLabel('zzz', 'ms')).toBe('zzz');
  });
});

describe('i18n', () => {
  it('interpolates and falls back', () => {
    expect(t('azanIn', 'ms', { prayer: 'Asar' })).toBe('Azan Asar dalam');
    expect(t('nope', 'ms')).toBe('nope');
    for (const k of Object.keys(STRINGS.ms)) expect(STRINGS.en[k]).toBeDefined();
  });
});
