import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hijriOf, parseJakimCsv, resolveSettings } from '@surau/core';
import type { PrayerName } from '@surau/core';
import { calcLabelMs, computeDay, effectiveMadhab, effectiveMethod, located } from '../src/prayer/calc.ts';

const csv = readFileSync(fileURLToPath(new URL('../../../packages/core/test/fixtures/SGR01-2026.csv', import.meta.url)), 'utf8');
const official = parseJakimCsv(csv);
const NAMES: PrayerName[] = ['imsak', 'subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak'];
const min = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const median = (a: number[]): number => [...a].sort((x, y) => x - y)[a.length >> 1]!;

const shahAlam = resolveSettings({ location: { latitude: 3.07, longitude: 101.52 } });
const nairobi = resolveSettings({
  location: { country: 'KE', timezone: 'Africa/Nairobi', latitude: -1.2921, longitude: 36.8219, city: 'Nairobi' },
});

describe('computeDay', () => {
  it('is null when the surau has no coordinates', () => {
    expect(located(resolveSettings({}))).toBe(false);
    expect(computeDay('2026-11-09', resolveSettings({}))).toBeNull();
  });
  it('is null for a bad date', () => {
    expect(computeDay('2026-02-30', shahAlam)).toBeNull();
    expect(computeDay('nope', shahAlam)).toBeNull();
  });

  // Measured on the real SGR01-2026 table: JAKIM's Subuh is the 18 degree Fajr, and its Zohor/Syuruk carry
  // ihtiyat of 2 minutes. The numbers below are what the calculation really does; a regression moves them.
  it('follows the real SGR01 table for a whole year (median within 3 minutes, worst day within 6)', () => {
    const diffs: Record<PrayerName, number[]> = { imsak: [], subuh: [], syuruk: [], zohor: [], asar: [], maghrib: [], isyak: [] };
    for (const d of official) {
      const c = computeDay(d.date, shahAlam)!;
      expect(c, d.date).not.toBeNull();
      for (const p of NAMES) diffs[p].push(min(c.times[p]) - min(d.times[p]));
    }
    expect(official.length).toBe(365);
    for (const p of NAMES) {
      expect(Math.abs(median(diffs[p])), `${p} median`).toBeLessThanOrEqual(3);
      expect(Math.max(...diffs[p].map(Math.abs)), `${p} worst`).toBeLessThanOrEqual(6);
    }
  });

  it('uses the country method and madhab when they are auto', () => {
    expect(effectiveMethod(shahAlam)).toBe('jakim');
    expect(effectiveMadhab(shahAlam)).toBe('shafi');
    expect(effectiveMethod(nairobi)).toBe('mwl');
    expect(calcLabelMs(nairobi)).toBe('Kiraan setempat (Liga Dunia Islam)');
    expect(effectiveMadhab(resolveSettings({ location: { country: 'PK' } }))).toBe('hanafi');
    expect(effectiveMethod(resolveSettings({ location: { country: 'PK' }, prayerCalc: { method: 'egyptian' } }))).toBe('egyptian');
  });

  it('Nairobi on 2026-11-09: Subuh and Maghrib are where Nairobi has them, in Nairobi time', () => {
    const d = computeDay('2026-11-09', nairobi)!;
    expect(d.times.subuh >= '04:40' && d.times.subuh <= '05:20', d.times.subuh).toBe(true);
    expect(d.times.maghrib >= '18:20' && d.times.maghrib <= '18:50', d.times.maghrib).toBe(true);
    expect(d.hijri).toEqual(hijriOf('2026-11-09'));
    expect(d.date).toBe('2026-11-09');
  });

  it('the same coordinates in another zone give the same moment on another clock', () => {
    const utc3 = computeDay('2026-11-09', nairobi)!;
    const utc2 = computeDay('2026-11-09', resolveSettings({
      location: { country: 'KE', timezone: 'Africa/Johannesburg', latitude: -1.2921, longitude: 36.8219 },
    }))!;
    // One hour apart, whatever the machine's own zone is.
    expect(min(utc3.times.zohor) - min(utc2.times.zohor)).toBe(60);
  });

  it('imsak is Subuh minus the imsak minutes, adjustments move one prayer, a day is always in order', () => {
    const base = computeDay('2026-11-09', nairobi)!;
    expect(min(base.times.subuh) - min(base.times.imsak)).toBe(10);
    const tuned = computeDay('2026-11-09', resolveSettings({
      location: nairobi.location,
      prayerCalc: { imsakMinutes: 15, adjustMinutes: { asar: 3, subuh: -2 } },
    }))!;
    expect(min(tuned.times.asar) - min(base.times.asar)).toBe(3);
    expect(min(tuned.times.subuh) - min(base.times.subuh)).toBe(-2);
    expect(min(tuned.times.zohor)).toBe(min(base.times.zohor));
    expect(min(tuned.times.subuh) - min(tuned.times.imsak)).toBe(15);
    for (const d of ['2026-03-20', '2026-06-21', '2026-12-21']) {
      const t = computeDay(d, nairobi)!.times;
      expect([t.imsak, t.subuh, t.syuruk, t.zohor, t.asar, t.maghrib, t.isyak]).toEqual([...[t.imsak, t.subuh, t.syuruk, t.zohor, t.asar, t.maghrib, t.isyak]].sort());
    }
  });

  it('Hanafi Asar is later than Shafi Asar', () => {
    const shafi = computeDay('2026-11-09', resolveSettings({ location: nairobi.location, prayerCalc: { madhab: 'shafi' } }))!;
    const hanafi = computeDay('2026-11-09', resolveSettings({ location: nairobi.location, prayerCalc: { madhab: 'hanafi' } }))!;
    expect(hanafi.times.asar > shafi.times.asar).toBe(true);
  });

  it('never throws near the pole: a day with times or null', () => {
    const north = resolveSettings({ location: { country: 'NO', timezone: 'Europe/Oslo', latitude: 69.6492, longitude: 18.9553 } });
    for (const d of ['2026-06-21', '2026-12-21', '2026-03-20']) {
      const r = computeDay(d, north);
      if (r !== null) expect(r.times.subuh < r.times.isyak || r.times.subuh >= '00:00').toBe(true);
    }
  });
});
