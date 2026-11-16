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

describe('imsak beep and first Subuh azan', () => {
  const file = 'ab'.repeat(32);
  const imsakOn = resolveSettings({ imsakBeep: { enabled: true }, azanCountdown: { enabled: false } });

  it('beeps once at imsak, for three seconds only', () => {
    expect(st(D, '05:38', undefined, imsakOn)).toMatchObject({ phase: 'normal', beep: 'imsak' });
    expect(st(D, '05:38:02', undefined, imsakOn)).toMatchObject({ beep: 'imsak' });
    expect(st(D, '05:38:03', undefined, imsakOn)).toMatchObject({ beep: null });
    expect(st(D, '05:37:59', undefined, imsakOn)).toMatchObject({ beep: null });
    expect(st(D, '21:30', undefined, imsakOn)).toMatchObject({ beep: null });
  });
  it('does not beep at imsak when the feature is off (the default)', () => {
    expect(st(D, '05:38', undefined, resolveSettings({ azanCountdown: { enabled: false } }))).toMatchObject({ beep: null });
    expect(st(D, '05:38', undefined, resolveSettings({ imsakBeep: { enabled: false }, azanCountdown: { enabled: false } }))).toMatchObject({ beep: null });
  });
  it('keeps the azan countdown beep when it starts at the same minute as imsak', () => {
    const both = resolveSettings({ imsakBeep: { enabled: true } });
    expect(st(D, '05:38', undefined, both)).toMatchObject({ phase: 'azanCountdown', beep: 'azanCountdown' });
  });

  it('starts the first azan minutesBefore Subuh, for 30 seconds', () => {
    const on = resolveSettings({ firstAzanSubuh: { enabled: true, minutesBefore: 15, audioFile: file } });
    expect(st(D, '05:32', undefined, on).firstAzan).toBeNull();
    // Subuh 05:48, countdown 10 min: the first azan must be silent by the countdown start (05:38).
    expect(st(D, '05:33', undefined, on).firstAzan).toEqual({ audioFile: file, startsAt: klInstant(D, '05:33'), stopsAt: klInstant(D, '05:38') });
    expect(st(D, '05:33:29', undefined, on).firstAzan).not.toBeNull();
    expect(st(D, '05:33:30', undefined, on).firstAzan).toBeNull();
    expect(st(D, '16:12', undefined, on).firstAzan).toBeNull();
  });
  it('does nothing when off, with no file, or with an unusable file id', () => {
    const at = (o: Record<string, unknown>) => st(D, '05:38', undefined, resolveSettings({ firstAzanSubuh: o } as never)).firstAzan;
    expect(at({ enabled: true, minutesBefore: 10, audioFile: file })).not.toBeNull();
    expect(at({ enabled: false, minutesBefore: 10, audioFile: file })).toBeNull();
    expect(at({ enabled: true, minutesBefore: 10, audioFile: null })).toBeNull();
    expect(computeKioskState(klInstant(D, '05:38'), days, { ...s, firstAzanSubuh: { enabled: true, minutesBefore: 10, audioFile: '../x' } } as never).firstAzan).toBeNull();
  });
  it('stops the first azan at the countdown start, or at Subuh when the countdown starts no later than it', () => {
    const fa = (o: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      st(D, '05:38', undefined, resolveSettings({ firstAzanSubuh: { enabled: true, audioFile: file, ...o }, ...extra } as never)).firstAzan;
    // Same minute as the countdown (both 10): it may sound up to the real azan.
    expect(fa({ minutesBefore: 10 })).toMatchObject({ startsAt: klInstant(D, '05:38'), stopsAt: klInstant(D, '05:48') });
    // Countdown off: up to Subuh.
    expect(st(D, '05:33', undefined, resolveSettings({ firstAzanSubuh: { enabled: true, minutesBefore: 15, audioFile: file }, azanCountdown: { enabled: false } })).firstAzan)
      .toMatchObject({ stopsAt: klInstant(D, '05:48') });
    // A longer Subuh countdown (20) than the first azan (15): the countdown starts first, so up to Subuh.
    const long = resolveSettings({ firstAzanSubuh: { enabled: true, minutesBefore: 15, audioFile: file }, azanCountdown: { minutesBefore: { subuh: 20 } } } as never);
    expect(st(D, '05:33', undefined, long).firstAzan).toMatchObject({ stopsAt: klInstant(D, '05:48') });
  });
  it('has no first azan on a no-data day', () => {
    expect(computeKioskState(new Date('2027-01-01T01:00:00Z'), days, s).firstAzan).toBeNull();
  });
});

describe('syurukWarning.beep', () => {
  const sy = days.find((d) => d.date === D)!.times.syuruk;
  const [h, m] = sy.split(':').map(Number) as [number, number];
  const warn = `${String(h).padStart(2, '0')}:${String(m - 5).padStart(2, '0')}`;
  const beepOn = resolveSettings({ syurukWarning: { beep: true } } as never);

  it('one short beep when the warning stage starts, for three seconds only', () => {
    expect(st(D, warn, undefined, beepOn)).toMatchObject({ phase: 'syuruk', beep: 'syuruk' });
    expect(st(D, `${warn}:02`, undefined, beepOn)).toMatchObject({ beep: 'syuruk' });
    expect(st(D, `${warn}:03`, undefined, beepOn)).toMatchObject({ phase: 'syuruk', beep: null });
  });
  it('silent when off (the default) or when the warning itself is off', () => {
    expect(st(D, warn)).toMatchObject({ phase: 'syuruk', beep: null });
    expect(st(D, warn, undefined, resolveSettings({ syurukWarning: { enabled: false, beep: true } } as never))).toMatchObject({ beep: null });
  });
});
