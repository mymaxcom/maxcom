import { describe, expect, it } from 'vitest';
import {
  FEATURES, resolveSettings, validateFeatureSettings, parseJakimApi, parseJakimCsv,
  countryDefaults, hasOfficialSource, COUNTRIES, METHODS, METHOD_KEYS,
} from '../src/index.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ok = (k: any, p: unknown) => validateFeatureSettings(k, p).ok;

describe('Plan 13 features', () => {
  it('registers location, prayerCalc and prayerSources in the solat group', () => {
    const solat = FEATURES.filter((f) => f.group === 'solat').map((f) => f.key);
    expect(solat).toEqual(expect.arrayContaining(['location', 'prayerCalc', 'prayerSources']));
    expect(FEATURES.find((f) => f.key === 'location')?.locked).toBe(true);
    expect(FEATURES.find((f) => f.key === 'prayerSources')?.locked).toBe(true);
  });
  it('location rules', () => {
    expect(ok('location', { latitude: 3.24861 })).toBe(false);
    expect(ok('location', { latitude: 3.2486, longitude: 101.6556 })).toBe(true);
    expect(ok('location', { latitude: null })).toBe(true);
    expect(ok('location', { latitude: 91 })).toBe(false);
    expect(ok('location', { longitude: -181 })).toBe(false);
    expect(ok('location', { latitude: '3.2' })).toBe(false);
    expect(ok('location', { country: 'XX' })).toBe(false);
    expect(ok('location', { country: 'KE' })).toBe(true);
    expect(ok('location', { timezone: 'Mars Olympus' })).toBe(false);
    expect(ok('location', { timezone: 'Africa/Nairobi' })).toBe(true);
    expect(ok('location', { city: 'x'.repeat(81) })).toBe(false);
    expect(ok('location', { city: 'Nairobi' })).toBe(true);
  });
  it('prayerCalc rules', () => {
    expect(ok('prayerCalc', { adjustMinutes: { subuh: -3 } })).toBe(true);
    expect(ok('prayerCalc', { adjustMinutes: { subuh: 31 } })).toBe(false);
    expect(ok('prayerCalc', { adjustMinutes: { subuh: -31 } })).toBe(false);
    expect(ok('prayerCalc', { imsakMinutes: 4 })).toBe(false);
    expect(ok('prayerCalc', { imsakMinutes: 21 })).toBe(false);
    expect(ok('prayerCalc', { imsakMinutes: 15 })).toBe(true);
    expect(ok('prayerCalc', { method: 'jakim' })).toBe(true);
    expect(ok('prayerCalc', { method: 'x' })).toBe(false);
    expect(ok('prayerCalc', { madhab: 'hanafi' })).toBe(true);
    expect(ok('prayerCalc', { madhab: 'maliki' })).toBe(false);
    expect(ok('prayerCalc', { highLatitude: 'seventhOfNight' })).toBe(true);
    expect(ok('prayerCalc', { highLatitude: 'nope' })).toBe(false);
  });
  it('prayerSources order must be a permutation', () => {
    expect(ok('prayerSources', { sourceOrder: ['calc', 'file'] })).toBe(false);
    expect(ok('prayerSources', { sourceOrder: ['file', 'calc', 'official'] })).toBe(true);
    expect(ok('prayerSources', { sourceOrder: ['official', 'official', 'calc'] })).toBe(false);
    expect(ok('prayerSources', { sourceOrder: ['official', 'calc', 'file', 'file'] })).toBe(false);
  });
  it('resolveSettings gives the frozen defaults', () => {
    const s = resolveSettings({}) as any;
    expect(s.location).toMatchObject({ country: 'MY', timezone: 'Asia/Kuala_Lumpur', latitude: null, longitude: null, city: '' });
    expect(s.prayerSources.sourceOrder).toEqual(['official', 'calc', 'file']);
    expect(s.prayerCalc.imsakMinutes).toBe(10);
    expect(s.zone).toMatchObject({ zone: 'SGR01', autoFetch: true });
  });
  it('a stored bad order falls back to the default', () => {
    const s = resolveSettings({ prayerSources: { sourceOrder: ['calc'] } } as any) as any;
    expect(s.prayerSources.sourceOrder).toEqual(['official', 'calc', 'file']);
  });
  it('dataSources has five sources and the new ones are checked as addresses', () => {
    const s = resolveSettings({}) as any;
    expect(Object.keys(s.dataSources).filter((k) => k !== 'enabled').sort())
      .toEqual(['esolat', 'esolatZones', 'hadeethenc', 'nominatim', 'quranAudio', 'quranText']);
    expect(ok('dataSources', { nominatim: { url: 'http://x' } })).toBe(false);
    expect(ok('dataSources', { nominatim: { url: 'https://nominatim.openstreetmap.org/search' } })).toBe(true);
    expect(ok('dataSources', { esolatZones: { url: 'https://localhost/x' } })).toBe(false);
  });
});

describe('dhuha in the e-Solat JSON', () => {
  const row = (extra: object) => ({
    hijri: '1448-05-23', date: '03-Nov-2026', imsak: '05:38:00', fajr: '05:48:00', syuruk: '06:55:00',
    dhuhr: '13:00:00', asr: '16:20:00', maghrib: '18:58:00', isha: '20:09:00', ...extra,
  });
  it('keeps a valid dhuha', () => {
    expect(parseJakimApi({ prayerTime: [row({ dhuha: '07:21:00' })] })[0]!.dhuha).toBe('07:21');
  });
  it('leaves it out when absent or bad, without failing the fetch', () => {
    expect(parseJakimApi({ prayerTime: [row({})] })[0]!.dhuha).toBeUndefined();
    expect(parseJakimApi({ prayerTime: [row({ dhuha: 'xx' })] })[0]!.dhuha).toBeUndefined();
  });
  it('still parses the SGR01-2026 CSV fixture', () => {
    const text = readFileSync(fileURLToPath(new URL('./fixtures/SGR01-2026.csv', import.meta.url)), 'utf8');
    expect(parseJakimCsv(text).length).toBeGreaterThan(300);
  });
});

describe('countries and methods', () => {
  it('country defaults', () => {
    expect(countryDefaults('MY')).toEqual({ method: 'jakim', madhab: 'shafi' });
    expect(countryDefaults('KE')).toEqual({ method: 'mwl', madhab: 'shafi' });
    expect(countryDefaults('PK').madhab).toBe('hanafi');
    expect(countryDefaults('TR')).toEqual({ method: 'turkey', madhab: 'hanafi' });
  });
  it('official source', () => {
    expect(hasOfficialSource('MY')).toBe(true);
    expect(hasOfficialSource('KE')).toBe(false);
    expect(hasOfficialSource('toString')).toBe(false);
  });
  it('every method key has a table row with angles for the custom ones', () => {
    for (const k of METHOD_KEYS) {
      expect(METHODS[k].labelMs.length, k).toBeGreaterThan(2);
      if (METHODS[k].adhan === 'Other') expect(METHODS[k].fajrAngle, k).toBeTypeOf('number');
    }
    expect(Object.keys(METHODS).sort()).toEqual([...METHOD_KEYS].sort());
    expect(METHODS.jakim).toMatchObject({ fajrAngle: 18, ishaAngle: 18 });
  });
  it('country table has Malaysia and Indonesia zones', () => {
    expect(COUNTRIES.find((c) => c.code === 'MY')!.timezones).toEqual(['Asia/Kuala_Lumpur', 'Asia/Kuching']);
    expect(COUNTRIES.find((c) => c.code === 'ID')!.timezones).toHaveLength(4);
  });
});
