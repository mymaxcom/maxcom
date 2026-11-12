import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkPrayerDay, klDateOf, klInstant, klWeekday, parseJakimApi, parseJakimCsv } from '../src/index.ts';

const readFixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const header = 'Tarikh Miladi,Tarikh Hijri,Hari,Imsak,Subuh,Syuruk,Zohor,Asar,Maghrib,Isyak';
const row = '03-Nov-2026,23-Jaw-1448,Selasa,5:38 am,5:48 am,6:55 am,1:00 pm,4:20 pm,6:58 pm,8:09 pm';

describe('parseJakimCsv', () => {
  const days = parseJakimCsv(readFixture('SGR01-2026.csv'));
  const d = days.find((x) => x.date === '2026-11-03')!;

  it('parses the fixture', () => {
    expect(days).toHaveLength(365);
    expect(days[0]!.date).toBe('2026-01-01');
    expect(d.hijri).toEqual({ y: 1448, m: 5, d: 23 });
    expect(d.times).toEqual({ imsak: '05:38', subuh: '05:48', syuruk: '06:55', zohor: '13:00', asar: '16:20', maghrib: '18:58', isyak: '20:09' });
  });

  it('header only gives empty list', () => {
    expect(parseJakimCsv(header + '\n')).toEqual([]);
  });

  it('rejects bad header', () => {
    expect(() => parseJakimCsv('nonsense')).toThrow(/header/i);
    expect(() => parseJakimCsv('')).toThrow(/header/i);
  });

  it('rejects bad rows with row number', () => {
    expect(() => parseJakimCsv(header + '\n03-Nov-2026,23-Jaw-1448,Selasa,5:38 am,bad,6:55 am,1:00 pm,4:20 pm,6:58 pm,8:09 pm')).toThrow(/row 1/i);
    expect(() => parseJakimCsv(header + '\n' + row + '\n31-Feb-2026,23-Jaw-1448,Selasa,5:38 am,5:48 am,6:55 am,1:00 pm,4:20 pm,6:58 pm,8:09 pm')).toThrow(/row 2/i);
    expect(() => parseJakimCsv(header + '\n03-Nov-2026,31-Jaw-1448,Selasa,5:38 am,5:48 am,6:55 am,1:00 pm,4:20 pm,6:58 pm,8:09 pm')).toThrow(/row 1/i);
    expect(() => parseJakimCsv(header + '\n03-Nov-2026,23-Xxx-1448,Selasa,5:38 am,5:48 am,6:55 am,1:00 pm,4:20 pm,6:58 pm,8:09 pm')).toThrow(/row 1/i);
    expect(() => parseJakimCsv(header + '\n03-Nov-2026,23-Jaw-1448,Selasa,5:38 am')).toThrow(/row 1/i);
  });

  it('handles CRLF, blank lines and trailing newline', () => {
    const lf = parseJakimCsv(header + '\n' + row);
    expect(parseJakimCsv(header + '\r\n' + row + '\r\n')).toEqual(lf);
    expect(parseJakimCsv(header + '\n\n' + row + '\n\n')).toEqual(lf);
  });

  it('converts 12h times', () => {
    const r = '03-Nov-2026,23-Jaw-1448,Selasa,12:05 am,5:48 am,6:55 am,12:30 pm,4:20 pm,6:58 pm,8:09 pm';
    const t = parseJakimCsv(header + '\n' + r)[0]!.times;
    expect(t.imsak).toBe('00:05');
    expect(t.zohor).toBe('12:30');
  });

  it('api matches csv', () => {
    const api = parseJakimApi({ prayerTime: [{ hijri: '1448-05-23', date: '03-Nov-2026', day: 'Tuesday', imsak: '05:38:00', fajr: '05:48:00', syuruk: '06:55:00', dhuhr: '13:00:00', asr: '16:20:00', maghrib: '18:58:00', isha: '20:09:00' }] });
    expect(api[0]).toEqual(d);
  });

  it('api rejects bad input', () => {
    expect(() => parseJakimApi(null)).toThrow();
    expect(() => parseJakimApi({})).toThrow();
    expect(() => parseJakimApi({ prayerTime: 'x' })).toThrow();
    expect(() => parseJakimApi({ prayerTime: [{ date: 'bad' }] })).toThrow(/0/);
  });
});

describe('time helpers', () => {
  it('klDateOf', () => {
    expect(klDateOf(new Date('2026-11-05T23:30:00Z'))).toBe('2026-11-06');
    expect(klDateOf(new Date('2026-11-05T15:59:59Z'))).toBe('2026-11-05');
    expect(klDateOf(new Date('2026-11-05T16:00:00Z'))).toBe('2026-11-06');
  });
  it('klWeekday', () => {
    expect(klWeekday('2026-11-06')).toBe(5);
    expect(klWeekday('2026-11-08')).toBe(0);
  });
  it('klInstant', () => {
    expect(klInstant('2026-11-03', '16:20').toISOString()).toBe('2026-11-03T08:20:00.000Z');
    expect(klInstant('2026-11-03', '16:20:30').toISOString()).toBe('2026-11-03T08:20:30.000Z');
    expect(klInstant('2026-11-03', '00:05').toISOString()).toBe('2026-11-02T16:05:00.000Z');
  });
});

describe('prayer sequence safety', () => {
  const apiRow = (o: Record<string, string> = {}) => ({ hijri: '1448-05-23', date: '03-Nov-2026', imsak: '05:38:00', fajr: '05:48:00', syuruk: '06:55:00', dhuhr: '13:00:00', asr: '16:20:00', maghrib: '18:58:00', isha: '20:09:00', ...o });

  it('csv rejects out-of-order times naming the row and pair', () => {
    const bad = '03-Nov-2026,23-Jaw-1448,Selasa,5:38 am,5:48 am,6:55 am,1:00 pm,12:20 pm,6:58 pm,8:09 pm';
    expect(() => parseJakimCsv(header + '\n' + row + '\n' + bad.replace('03-Nov', '04-Nov'))).toThrow(/row 2.*zohor.*asar/);
  });
  it('csv rejects equal (non-strict) times and duplicate dates', () => {
    const eq = '03-Nov-2026,23-Jaw-1448,Selasa,5:48 am,5:48 am,6:55 am,1:00 pm,4:20 pm,6:58 pm,8:09 pm';
    expect(() => parseJakimCsv(header + '\n' + eq)).toThrow(/row 1.*imsak.*subuh/);
    expect(() => parseJakimCsv(header + '\n' + row + '\n' + row)).toThrow(/row 2: duplicate date/);
  });
  it('api rejects out-of-order times and duplicate dates', () => {
    expect(() => parseJakimApi({ prayerTime: [apiRow(), apiRow({ date: '04-Nov-2026', isha: '03:00:00' })] })).toThrow(/prayerTime\[1\].*maghrib.*isyak/);
    expect(() => parseJakimApi({ prayerTime: [apiRow(), apiRow()] })).toThrow(/prayerTime\[1\]: duplicate date/);
  });
  it('checkPrayerDay returns null for good days', () => {
    expect(parseJakimCsv(readFixture('SGR01-2026.csv')).every((x) => checkPrayerDay(x) === null)).toBe(true);
  });
});

describe('e-Solat Malay month names (measured from the live API 2026-11-03)', () => {
  const row = (date: string) => ({ hijri: '1447-08-01', date, day: 'x', imsak: '05:38:00', fajr: '05:48:00', syuruk: '06:55:00', dhuhr: '13:00:00', asr: '16:20:00', maghrib: '18:58:00', isha: '20:09:00' });
  it('parses Mac, Mei, Ogos, Okt and Dis', () => {
    const days = parseJakimApi({ prayerTime: ['01-Mac-2026', '01-Mei-2026', '01-Ogos-2026', '01-Okt-2026', '31-Dis-2026'].map(row) });
    expect(days.map((d) => d.date)).toEqual(['2026-03-01', '2026-05-01', '2026-08-01', '2026-10-01', '2026-12-31']);
  });
  it('still rejects an unknown month', () => {
    expect(() => parseJakimApi({ prayerTime: [row('01-Xyz-2026')] })).toThrow(/month/);
  });
});
