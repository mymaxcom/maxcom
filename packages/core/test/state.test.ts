import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeKioskState, klInstant, parseJakimCsv, resolveSettings } from '../src/index.ts';

const csv = readFileSync(fileURLToPath(new URL('./fixtures/SGR01-2026.csv', import.meta.url)), 'utf8');
const days = parseJakimCsv(csv);
const s = resolveSettings({});
const st = (date: string, hhmm: string, hijriMonth?: number, settings = s) =>
  computeKioskState(klInstant(date, hhmm), days, settings, hijriMonth);
const D = '2026-11-03';

describe('computeKioskState', () => {
  it('normal before asar with next', () => {
    expect(st(D, '15:52')).toMatchObject({ phase: 'normal', next: { name: 'asar', at: klInstant(D, '16:20') } });
  });
  it('asar sequence', () => {
    expect(st(D, '16:12')).toMatchObject({ phase: 'azanCountdown', prayer: 'asar', phaseEndsAt: klInstant(D, '16:20') });
    expect(st(D, '16:20')).toMatchObject({ phase: 'masukWaktu', beep: 'masukWaktu' });
    expect(st(D, '16:21:30')).toMatchObject({ phase: 'iqamah', phaseEndsAt: klInstant(D, '16:30') });
    expect(st(D, '16:35')).toMatchObject({ phase: 'solat', phaseEndsAt: klInstant(D, '16:45') });
    expect(st(D, '16:46')).toMatchObject({ phase: 'normal' });
  });
  it('subuh iqamah, syuruk, isyraq', () => {
    expect(st(D, '05:50')).toMatchObject({ phase: 'iqamah', phaseEndsAt: klInstant(D, '06:00') });
    expect(st(D, '06:52')).toMatchObject({ phase: 'syuruk' });
    expect(st(D, '07:12')).toMatchObject({ phase: 'isyraq' });
  });
  it('next rolls to tomorrow imsak', () => {
    expect(st(D, '21:30')).toMatchObject({ next: { name: 'imsak', at: klInstant('2026-11-04', '05:38') } });
    expect(st(D, '23:59:59')).toMatchObject({ next: { name: 'imsak', at: klInstant('2026-11-04', '05:38') } });
  });
  it('jumaat', () => {
    expect(st('2026-11-06', '13:05')).toMatchObject({ isJumaat: true, phase: 'khutbah', prayer: 'jumaat' });
    expect(st('2026-11-06', '13:25')).toMatchObject({ phase: 'iqamah', phaseEndsAt: klInstant('2026-11-06', '13:28') });
    expect(st('2026-11-06', '13:30')).toMatchObject({ phase: 'solat', phaseEndsAt: klInstant('2026-11-06', '13:43') });
    expect(computeKioskState(new Date('2026-11-05T23:30:00Z'), days, s)).toMatchObject({ isJumaat: true });
    expect(st('2026-11-06', '12:00')).toMatchObject({ next: { name: 'jumaat' } });
  });
  it('jumaat disabled behaves as zohor', () => {
    const off = resolveSettings({ jumaat: { enabled: false } });
    expect(st('2026-11-06', '13:05', undefined, off)).toMatchObject({ prayer: 'zohor', phase: 'iqamah' });
  });
  it('noData and no 2027 next', () => {
    expect(computeKioskState(new Date('2027-01-01T01:00:00Z'), days, s)).toMatchObject({ phase: 'noData', today: null });
    expect(st('2026-12-31', '21:00').next).toBeNull();
  });
  it('iqamah disabled goes straight to solat', () => {
    const off = resolveSettings({ iqamahCountdown: { enabled: false } });
    expect(st(D, '16:21:30', undefined, off)).toMatchObject({ phase: 'solat', phaseEndsAt: klInstant(D, '16:36') });
  });
  it('is pure', () => {
    const a = st(D, '16:35');
    st(D, '03:00');
    expect(st(D, '16:35')).toEqual(a);
  });
  it('tarawih', () => {
    expect(st(D, '20:50', 9)).toMatchObject({ phase: 'tarawih', phaseEndsAt: klInstant(D, '21:29') });
    expect(st(D, '20:50', 5)).toMatchObject({ phase: 'normal' });
    const long = resolveSettings({ tarawih: { gapMinutes: 120, minutes: 120 } });
    expect(st('2026-11-04', '00:30', 9, long)).toMatchObject({ phase: 'tarawih' });
  });
  it('beep windows', () => {
    expect(st(D, '16:29:30')).toMatchObject({ beep: 'iqamahEnd' });
    expect(st(D, '16:29:31')).toMatchObject({ phase: 'iqamah', beep: 'iqamahEnd' });
    expect(st(D, '16:29:32')).toMatchObject({ beep: 'iqamahEnd' });
    expect(st(D, '16:29:33')).toMatchObject({ beep: null });
    expect(st(D, '16:10')).toMatchObject({ beep: 'azanCountdown' });
    expect(st(D, '16:10:02')).toMatchObject({ beep: 'azanCountdown' });
    expect(st(D, '16:10:03')).toMatchObject({ beep: null });
  });
  it('day boundary', () => {
    const r = st('2026-11-04', '00:00:00');
    expect(r.phase).toBe('normal');
    expect(r.today?.date).toBe('2026-11-04');
  });
  it('azan minutesBefore 0 skips stage', () => {
    const base = resolveSettings({});
    const mb = { ...(base.azanCountdown.minutesBefore), asar: 0 };
    const o = resolveSettings({ azanCountdown: { minutesBefore: mb } });
    expect(st(D, '16:12', undefined, o)).toMatchObject({ phase: 'normal' });
  });
  it('tolerates a malformed yesterday row', () => {
    const bad = days.map((d) =>
      d.date === '2026-11-02' ? { ...d, times: { ...d.times, isyak: '25:00' } } : d);
    const r = computeKioskState(klInstant(D, '16:12'), bad, s);
    expect(r).toMatchObject({ phase: 'azanCountdown', prayer: 'asar' });
  });
  it('tolerates a malformed tomorrow row for next lookup', () => {
    const bad = days.map((d) =>
      d.date === '2026-11-04' ? { ...d, times: { ...d.times, imsak: 'zz' } } : d);
    expect(computeKioskState(klInstant(D, '21:30'), bad, s)).toMatchObject({ phase: 'normal', next: null });
  });
  it('malformed or out-of-order today row gives noData, never throws', () => {
    const badTime = days.map((d) =>
      d.date === D ? { ...d, times: { ...d.times, asar: '99:99' } } : d);
    expect(computeKioskState(klInstant(D, '16:12'), badTime, s)).toMatchObject({ phase: 'noData', today: null });
    const order = days.map((d) =>
      d.date === D ? { ...d, times: { ...d.times, asar: '12:00' } } : d);
    expect(computeKioskState(klInstant(D, '16:12'), order, s)).toMatchObject({ phase: 'noData' });
  });
});
