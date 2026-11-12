import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { klInstant, parseJakimCsv, resolveSettings } from '../src/index.ts';
import type { KioskContent, KioskPoster, KioskProgramKhas, TilawahSlot } from '../src/index.ts';
import { buildRotation, currentSlot, tilawahWindow, zikirWindow } from '../src/content/rotation.ts';
import type { Slot } from '../src/content/rotation.ts';

const csv = readFileSync(fileURLToPath(new URL('./fixtures/SGR01-2026.csv', import.meta.url)), 'utf8');
const days = parseJakimCsv(csv);
const s = resolveSettings({});
const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'local' };

const poster = (id: string, order: number, extra: Partial<KioskPoster> = {}): KioskPoster => ({
  ...base, id, title: `Poster ${id}`, assetId: `a-${id}`, days: ['umum'], order, ...extra,
});

function content(over: Partial<KioskContent> = {}): KioskContent {
  return {
    date: '2026-11-03', kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [],
    hadisToday: [], worldTimes: [], tugasan: [],
    ayat: { today: null, tomorrow: null }, zikir: [],
    tilawah: { slots: [], available: {} },
    credits: { translation: '', font: '', audio: '' },
    ...over,
  };
}

const kuliah = {
  ...base, id: 'k1', date: '2026-11-03', slot: 'maghrib' as const, time: '19:30', label: 'Maghrib',
  penceramahId: 'p1', status: 'aktif' as const, penceramah: { name: 'Ustaz Ali' },
};
const hadis = { id: 'h1', textMs: 'Sesungguhnya amalan itu dengan niat.', attribution: 'Bukhari' };
const ayatCard = {
  surah: 2, surahNameAr: 'x', surahNameMs: 'Al-Baqarah', ayatFrom: 255, ayatTo: 255,
  arabic: ['a'], malay: ['b'], translationVersion: 'v1',
};
const content3posters = content({
  kuliah: [kuliah],
  posters: [poster('p1', 1), poster('p2', 2), poster('p3', 3)],
  hadisToday: [hadis],
  ayat: { today: ayatCard, tomorrow: null },
});
const now = klInstant('2026-11-03', '15:00');

describe('buildRotation', () => {
  it('orders features, skips empty ones', () => {
    const rot = buildRotation(content3posters, s, now);
    expect(rot.map((x) => x.feature)).toEqual(['kuliahCard', 'posters', 'posters', 'posters', 'hadis', 'ayatCard']);
    expect(rot[1]).toMatchObject({ itemId: 'p1', durationSeconds: 15 });
    expect(rot.find((x) => x.feature === 'hadis')!.durationSeconds).toBe(20);
  });
  it('switched-off feature leaves no gap', () => {
    const off = resolveSettings({ posters: { enabled: false } });
    expect(buildRotation(content3posters, off, now).some((x) => x.feature === 'posters')).toBe(false);
  });
  it('respects order setting', () => {
    const o = resolveSettings({ hadis: { order: 0 } });
    expect(buildRotation(content3posters, o, now)[0]!.feature).toBe('hadis');
  });
  it('friday-only poster', () => {
    const c = content({ posters: [poster('f', 1, { days: ['jumaat'] })] });
    expect(buildRotation(c, s, klInstant('2026-11-03', '15:00')).filter((x) => x.feature === 'posters')).toHaveLength(0);
    expect(buildRotation(c, s, klInstant('2026-11-06', '15:00')).filter((x) => x.feature === 'posters')).toHaveLength(1);
  });
  it('poster date range by KL date', () => {
    const c = content({ posters: [poster('r', 1, { from: '2026-11-04', to: '2026-11-05' })] });
    expect(buildRotation(c, s, klInstant('2026-11-03', '23:59')).some((x) => x.feature === 'posters')).toBe(false);
    expect(buildRotation(c, s, klInstant('2026-11-04', '00:00')).some((x) => x.feature === 'posters')).toBe(true);
    expect(buildRotation(c, s, klInstant('2026-11-05', '23:59')).some((x) => x.feature === 'posters')).toBe(true);
    expect(buildRotation(c, s, klInstant('2026-11-06', '00:00')).some((x) => x.feature === 'posters')).toBe(false);
  });
  it('programKhas hides hideAfterMinutes after start', () => {
    const pk: KioskProgramKhas = {
      ...base, id: 'pk', title: 'Maulidur Rasul', at: '2026-11-03T20:30', showFrom: '2026-11-01', showTo: '2026-11-03', status: 'aktif',
    };
    const c = content({ programKhas: [pk] });
    expect(buildRotation(c, s, klInstant('2026-11-03', '20:34')).some((x) => x.feature === 'programKhas')).toBe(true);
    expect(buildRotation(c, s, klInstant('2026-11-03', '20:36')).some((x) => x.feature === 'programKhas')).toBe(false);
    expect(buildRotation(c, s, klInstant('2026-11-04', '00:00')).some((x) => x.feature === 'programKhas')).toBe(false);
  });
  it('batal programKhas keeps its slot (DIBATALKAN ribbon) until it would have ended', () => {
    const pk: KioskProgramKhas = {
      ...base, id: 'pk', title: 'Maulidur Rasul', at: '2026-11-03T20:30', showFrom: '2026-11-01', showTo: '2026-11-03', status: 'batal',
    };
    const c = content({ programKhas: [pk] });
    expect(buildRotation(c, s, klInstant('2026-11-03', '20:00')).filter((x) => x.feature === 'programKhas').map((x) => x.itemId)).toEqual(['pk']);
    expect(buildRotation(c, s, klInstant('2026-11-03', '20:36')).some((x) => x.feature === 'programKhas')).toBe(false);
  });
  it('multi-day programKhas (at on the last day) shows every day of showFrom..showTo', () => {
    const pk: KioskProgramKhas = {
      ...base, id: 'pk', title: 'Slide kuliah', at: '2026-11-05T20:30', showFrom: '2026-11-03', showTo: '2026-11-05', status: 'aktif',
    };
    const c = content({ programKhas: [pk] });
    const shown = (d: string, t: string) => buildRotation(c, s, klInstant(d, t)).some((x) => x.feature === 'programKhas');
    expect(shown('2026-11-02', '23:59')).toBe(false);
    expect(shown('2026-11-03', '00:00')).toBe(true);
    expect(shown('2026-11-04', '22:00')).toBe(true);
    expect(shown('2026-11-05', '20:34')).toBe(true);
    expect(shown('2026-11-05', '20:36')).toBe(false);
  });
  it('pengumuman by window, priority then from, capped at maxItems', () => {
    const mk = (id: string, priority: 1 | 2 | 3, from: string, to = '2026-11-30') => ({ ...base, id, title: id, body: 'b', from, to, priority });
    const c = content({
      pengumuman: [mk('c', 2, '2026-11-02'), mk('a', 1, '2026-11-03'), mk('b', 2, '2026-11-01'), mk('old', 1, '2026-10-01', '2026-10-31'), mk('future', 1, '2026-11-04')],
    });
    expect(buildRotation(c, s, now).filter((x) => x.feature === 'pengumuman').map((x) => x.itemId)).toEqual(['a', 'b', 'c']);
    const cap = resolveSettings({ pengumuman: { maxItems: 2 } });
    expect(buildRotation(c, cap, now).filter((x) => x.feature === 'pengumuman').map((x) => x.itemId)).toEqual(['a', 'b']);
  });
  it('kuliah within daysAhead; past and far excluded; a window with only a batal kuliah still gets the slot', () => {
    const k = (id: string, date: string, status: 'aktif' | 'batal' = 'aktif') => ({ ...kuliah, id, date, status });
    const none = content({ kuliah: [k('past', '2026-11-02'), k('far', '2026-11-20')] });
    expect(buildRotation(none, s, now).some((x) => x.feature === 'kuliahCard')).toBe(false);
    const onlyBatal = content({ kuliah: [k('x', '2026-11-04', 'batal')] });
    expect(buildRotation(onlyBatal, s, now).some((x) => x.feature === 'kuliahCard')).toBe(true);
    const some = content({ kuliah: [k('far', '2026-11-20'), k('soon', '2026-11-10')] });
    expect(buildRotation(some, s, now).some((x) => x.feature === 'kuliahCard')).toBe(true);
  });
  it('takwim needs a date today or later', () => {
    const t = (id: string, date: string) => ({ ...base, id, date, title: id });
    expect(buildRotation(content({ takwim: [t('a', '2026-11-02')] }), s, now).some((x) => x.feature === 'takwim')).toBe(false);
    expect(buildRotation(content({ takwim: [t('a', '2026-11-03')] }), s, now).some((x) => x.feature === 'takwim')).toBe(true);
  });
  it('single-slot features need content', () => {
    const c = content({
      worldTimes: [{ ...base, id: 'w', city: 'Makkah', tz: 'Asia/Riyadh', order: 1 }],
      tugasan: [{ ...base, id: 't', date: '2026-11-05', role: 'imam', petugasId: 'x', petugas: { name: 'Haji Ahmad' } }],
    });
    expect(buildRotation(c, s, now).map((x) => x.feature)).toEqual(['worldTimes', 'tugasan']);
  });
  it('is pure for the same instant', () => {
    const a = buildRotation(content3posters, s, now);
    buildRotation(content3posters, s, klInstant('2026-11-06', '01:00'));
    expect(buildRotation(content3posters, s, now)).toEqual(a);
  });
});

const slot = (feature: Slot['feature'], durationSeconds: number): Slot => ({ feature, itemId: null, durationSeconds });
const rot3: Slot[] = [slot('hadis', 15), slot('takwim', 15), slot('ayatCard', 20)];

describe('currentSlot', () => {
  it('is a pure function of KL time', () => {
    expect(currentSlot(rot3, klInstant('2026-11-03', '00:00:30'))!.index).toBe(2);
    expect(currentSlot(rot3, klInstant('2026-11-03', '00:00:50'))!.index).toBe(0);
    expect(currentSlot(rot3, klInstant('2026-11-03', '00:00:00'))!.index).toBe(0);
    expect(currentSlot(rot3, klInstant('2026-11-03', '00:00:14'))!.index).toBe(0);
    expect(currentSlot(rot3, klInstant('2026-11-03', '00:00:15'))!.index).toBe(1);
  });
  it('startedAt', () => {
    const r = currentSlot(rot3, klInstant('2026-11-03', '00:00:40'))!;
    expect(r.startedAt).toEqual(klInstant('2026-11-03', '00:00:30'));
    expect(r.slot.feature).toBe('ayatCard');
  });
  it('empty or zero cycle is null', () => {
    expect(currentSlot([], now)).toBeNull();
    expect(currentSlot([slot('hadis', 0)], now)).toBeNull();
  });
  it('same instant, same slot regardless of earlier calls', () => {
    const t1 = klInstant('2026-11-03', '10:11:12');
    const t2 = klInstant('2026-11-03', '10:15:00');
    const a = currentSlot(rot3, t1);
    currentSlot(rot3, t2);
    expect(currentSlot(rot3, t1)).toEqual(a);
  });
  it('shrinking rotation never freezes on one item', () => {
    const three: Slot[] = [slot('hadis', 10), slot('takwim', 10), slot('worldTimes', 10)];
    const seen = new Set<number>();
    for (let sec = 0; sec < 60; sec++) {
      seen.add(currentSlot(three, klInstant('2026-11-03', '00:00:' + String(sec).padStart(2, '0')))!.index);
    }
    expect(seen.size).toBe(3);
  });
});

describe('zikirWindow', () => {
  it('asar solat ends 16:45, window 10 minutes', () => {
    expect(zikirWindow(klInstant('2026-11-03', '16:50'), days, s)).toMatchObject({ prayer: 'asar', endsAt: klInstant('2026-11-03', '16:55') });
    expect(zikirWindow(klInstant('2026-11-03', '16:45'), days, s)).toMatchObject({ prayer: 'asar' });
    expect(zikirWindow(klInstant('2026-11-03', '16:56'), days, s)).toBeNull();
    expect(zikirWindow(klInstant('2026-11-03', '16:44'), days, s)).toBeNull();
  });
  it('friday names jumaat', () => {
    expect(zikirWindow(klInstant('2026-11-06', '13:50'), days, s)).toMatchObject({ prayer: 'jumaat' });
  });
  it('disabled or no day', () => {
    expect(zikirWindow(klInstant('2026-11-03', '16:50'), days, resolveSettings({ zikirSelepasSolat: { enabled: false } }))).toBeNull();
    expect(zikirWindow(klInstant('2027-06-01', '16:50'), days, s)).toBeNull();
  });
  it('minutesAfterSolat honoured', () => {
    const m = resolveSettings({ zikirSelepasSolat: { minutesAfterSolat: 3 } });
    expect(zikirWindow(klInstant('2026-11-03', '16:47'), days, m)).not.toBeNull();
    expect(zikirWindow(klInstant('2026-11-03', '16:49'), days, m)).toBeNull();
  });
});

describe('tilawahWindow', () => {
  const timesOf = (date: string) => days.find((d) => d.date === date)!.times;
  const subuhFri = timesOf('2026-11-06').subuh;
  const sl: TilawahSlot = { ...base, id: 'ts', days: ['jumaat'], before: 'subuh', minutesBefore: 15, surah: 18, enabled: true };
  const sOn = resolveSettings({ tilawah: { enabled: true } });
  const at = (d: string, hhmm: string) => klInstant(d, hhmm);
  function minus(hhmm: string, m: number): string {
    const [h, mm] = hhmm.split(':').map(Number) as [number, number];
    const t = h * 60 + mm - m;
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  }
  it('window ends at azanCountdown start, not prayer time', () => {
    const start = minus(subuhFri, 15);
    const end = minus(subuhFri, 10);
    expect(tilawahWindow(at('2026-11-06', minus(subuhFri, 12)), days, sOn, [sl])).toMatchObject({
      slot: { id: 'ts' }, startsAt: at('2026-11-06', start), endsAt: at('2026-11-06', end),
    });
    expect(tilawahWindow(at('2026-11-06', start), days, sOn, [sl])).not.toBeNull();
    expect(tilawahWindow(at('2026-11-06', end), days, sOn, [sl])).toBeNull();
    expect(tilawahWindow(at('2026-11-06', minus(subuhFri, 16)), days, sOn, [sl])).toBeNull();
  });
  it('wrong day, tilawah off, slot off', () => {
    const mid = minus(subuhFri, 12);
    const thu = minus(timesOf('2026-11-05').subuh, 12);
    expect(tilawahWindow(at('2026-11-05', thu), days, sOn, [sl])).toBeNull();
    expect(tilawahWindow(at('2026-11-06', mid), days, s, [sl])).toBeNull();
    expect(tilawahWindow(at('2026-11-06', mid), days, sOn, [{ ...sl, enabled: false }])).toBeNull();
  });
  it('daily slot and friday zohor uses the zohor time', () => {
    const zoh = timesOf('2026-11-06').zohor;
    const z: TilawahSlot = { ...sl, days: ['daily'], before: 'zohor', minutesBefore: 30 };
    expect(tilawahWindow(at('2026-11-06', minus(zoh, 20)), days, sOn, [z])).toMatchObject({
      startsAt: at('2026-11-06', minus(zoh, 30)), endsAt: at('2026-11-06', minus(zoh, 10)),
    });
  });
  it('azanCountdown disabled: ends at prayer time', () => {
    const off = resolveSettings({ tilawah: { enabled: true }, azanCountdown: { enabled: false } });
    expect(tilawahWindow(at('2026-11-06', minus(subuhFri, 5)), days, off, [sl])).toMatchObject({ endsAt: at('2026-11-06', subuhFri) });
  });
  it('window fully inside azanCountdown yields nothing', () => {
    const tight: TilawahSlot = { ...sl, minutesBefore: 8 };
    expect(tilawahWindow(at('2026-11-06', minus(subuhFri, 9)), days, sOn, [tight])).toBeNull();
    expect(tilawahWindow(at('2026-11-06', minus(subuhFri, 8)), days, sOn, [tight])).toBeNull();
  });
});
