import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hijriForDisplay, HIJRI_MONTHS_MS, HIJRI_MONTHS_EN } from '../src/hijri.ts';
import { parseJakimCsv } from '../src/prayer/jakim.ts';
import { klInstant } from '../src/time.ts';

const readFixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const days = parseJakimCsv(readFixture('SGR01-2026.csv'));

describe('hijriForDisplay', () => {
  it('shows today\'s Hijri before Maghrib', () => {
    expect(hijriForDisplay(klInstant('2026-11-03', '15:00'), days, 0, 'maghrib')).toEqual({
      y: 1448,
      m: 5,
      d: 23,
    });
  });

  it('switches to tomorrow\'s Hijri after Maghrib', () => {
    expect(hijriForDisplay(klInstant('2026-11-03', '19:00'), days, 0, 'maghrib')).toEqual({
      y: 1448,
      m: 5,
      d: 24,
    });
  });

  it('does not switch at Maghrib when switchAt is midnight', () => {
    expect(hijriForDisplay(klInstant('2026-11-03', '19:00'), days, 0, 'midnight')).toEqual({
      y: 1448,
      m: 5,
      d: 23,
    });
  });

  it('adds adjustDays to the selected day', () => {
    expect(hijriForDisplay(klInstant('2026-11-03', '15:00'), days, 1, 'maghrib')).toEqual({
      y: 1448,
      m: 5,
      d: 24,
    });
  });

  it('subtracts adjustDays', () => {
    expect(hijriForDisplay(klInstant('2026-11-03', '15:00'), days, -1, 'maghrib')).toEqual({
      y: 1448,
      m: 5,
      d: 22,
    });
  });

  it('switches exactly at Maghrib time', () => {
    expect(hijriForDisplay(klInstant('2026-11-03', '18:58'), days, 0, 'maghrib')).toEqual({
      y: 1448,
      m: 5,
      d: 24,
    });
  });

  it('crosses Hijri month end after Maghrib', () => {
    // 10 Nov 2026 is 30 Jamadilawal; after Maghrib it becomes 1 Jamadilakhir.
    expect(hijriForDisplay(klInstant('2026-11-10', '19:00'), days, 0, 'maghrib')).toEqual({
      y: 1448,
      m: 6,
      d: 1,
    });
    expect(hijriForDisplay(klInstant('2026-11-10', '15:00'), days, 0, 'maghrib')).toEqual({
      y: 1448,
      m: 5,
      d: 30,
    });
  });

  it('returns null when today has no data', () => {
    expect(hijriForDisplay(klInstant('2027-01-02', '09:00'), days, 0, 'maghrib')).toBeNull();
  });

  it('returns null when the adjusted target day has no data', () => {
    expect(hijriForDisplay(klInstant('2026-12-31', '15:00'), days, 1, 'maghrib')).toBeNull();
  });
});

describe('month name tables', () => {
  it('has 12 Malay month names', () => {
    expect(HIJRI_MONTHS_MS).toHaveLength(12);
    expect(HIJRI_MONTHS_MS[4]).toBe('Jamadilawal');
  });

  it('has 12 English month names', () => {
    expect(HIJRI_MONTHS_EN).toHaveLength(12);
    expect(HIJRI_MONTHS_EN[4]).toBe('Jumada al-Ula');
  });
});
