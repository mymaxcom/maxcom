import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FEATURES, HADIS_CARD_POOL_MAX, HADIS_GRADES, HADIS_MAX_SAVED, UNSTATED_SOURCE, attributionOf, buildCycle, currentSlot, gradeAllowed, gradeOf,
  hadisCategoryMs, hadisDisplayText, hadisLength, hadisParts, hadisPlan, hadisPool, hadisTier, klInstant,
  providerItemId, resolveSettings, sourceUrlError, validateContent, validateFeatureSettings,
} from '../src/index.ts';
import type { Hadis, HadisSettings, KioskContent, KioskHadis } from '../src/index.ts';

const samples = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/hadeethenc-samples-ms.json', import.meta.url)), 'utf8'),
) as { samples: { id: string; hadeeth: string; hadeeth_ar: string }[] };
const sample = (id: string) => samples.samples.find((x) => x.id === id)!;

const meta = { updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: 'local' };
const ext = {
  provider: 'hadeethenc' as const, id: '66512', attributionAr: 'رواه البخاري ومسلم', gradeAr: 'صحيح',
  categories: ['1', '8'], fetchedAt: '2026-11-09T01:00:00.000Z', digest: 'a'.repeat(64),
};
const own = (id: string, extra: Partial<Hadis> = {}): Hadis => ({ ...meta, id, textMs: `Teks ${id}.`, source: 'Riwayat Muslim', ...extra });
const prov = (id: string, extra: Partial<Hadis> = {}): Hadis => ({
  ...meta, id: `hadeethenc-${id}`, textMs: `Teks ${id}.`, source: 'Muttafaq alaih', grade: 'sahih', ext: { ...ext, id }, ...extra,
});
const ALL_GRADES = { sahih: true, hasan: true, sahih_lighairihi: false, hasan_lighairihi: false };

describe('hadis schema', () => {
  it('accepts a full provider item and a bare own item', () => {
    const full = {
      textMs: 'Islam itu dibina atas lima perkara.', textAr: 'بني الإسلام', source: 'Muttafaq alaih', title: 'Islam itu',
      intro: 'Daripada Ibnu Umar:', grade: 'sahih', shown: true, order: 1000, ext,
    };
    const r = validateContent('hadis', full);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ grade: 'sahih', ext });
    expect(validateContent('hadis', { textMs: 'A', source: 'B' }).ok).toBe(true);
  });
  it('refuses a bad id, grade, order, digest or category count', () => {
    const base = { textMs: 'A', source: 'B' };
    expect(validateContent('hadis', { ...base, ext: { ...ext, id: '../x' } }).ok).toBe(false);
    expect(validateContent('hadis', { ...base, ext: { ...ext, provider: 'myhadith' } }).ok).toBe(false);
    expect(validateContent('hadis', { ...base, ext: { ...ext, digest: 'xyz' } }).ok).toBe(false);
    expect(validateContent('hadis', { ...base, ext: { ...ext, categories: Array.from({ length: 21 }, (_, i) => String(i)) } }).ok).toBe(false);
    expect(validateContent('hadis', { ...base, ext: { ...ext, categories: ['a'] } }).ok).toBe(false);
    expect(validateContent('hadis', { ...base, ext: { ...ext, extra: 1 } }).ok).toBe(false);
    expect(validateContent('hadis', { ...base, grade: 'x' }).ok).toBe(false);
    expect(validateContent('hadis', { ...base, order: -1 }).ok).toBe(false);
    expect(validateContent('hadis', { ...base, order: 1.5 }).ok).toBe(false);
    expect(validateContent('hadis', { ...base, shown: 'yes' }).ok).toBe(false);
    expect(validateContent('hadis', { ...base, intro: 'x'.repeat(401) }).ok).toBe(false);
    expect(validateContent('hadis', { ...base, title: 'x'.repeat(301) }).ok).toBe(false);
    expect(validateContent('hadis', { ...base, zzz: 1 }).ok).toBe(false);
  });
});

describe('grades and attribution', () => {
  it('maps the Arabic grade text', () => {
    expect(gradeOf('صحيح')).toBe('sahih');
    expect(gradeOf(' صَحِيح ')).toBe('sahih');
    expect(gradeOf('حسن لغيره')).toBe('hasan_lighairihi');
    expect(gradeOf('ضعيف')).toBe('dhaif');
    expect(gradeOf('موضوع')).toBe('maudhu');
    expect(gradeOf('ضعيف جدا')).toBeNull();
    expect(HADIS_GRADES).toHaveLength(6);
  });
  it('never allows null or the two locked grades, even when switched on', () => {
    expect(gradeAllowed('sahih', ALL_GRADES)).toBe(true);
    expect(gradeAllowed('sahih_lighairihi', ALL_GRADES)).toBe(false);
    expect(gradeAllowed('sahih_lighairihi', { ...ALL_GRADES, sahih_lighairihi: true })).toBe(true);
    expect(gradeAllowed('dhaif', { ...ALL_GRADES, dhaif: true })).toBe(false);
    expect(gradeAllowed('maudhu', { maudhu: true })).toBe(false);
    expect(gradeAllowed(null, { sahih: true })).toBe(false);
  });
  it.each([
    ['رواه البخاري ومسلم', 'Muttafaq alaih', 'Riwayat al-Bukhari dan Muslim'],
    ['متفق عليه', 'Muttafaq alaih', 'Riwayat al-Bukhari dan Muslim'],
    ['رواه مسلم', 'Riwayat Muslim', null],
    ['رواه البخاري', 'Riwayat al-Bukhari', null],
    ['رواه أبو داود والترمذي', 'Riwayat Abu Daud dan al-Tirmizi', null],
    ['رواه أحمد وأبو داود والنسائي', 'Riwayat Ahmad, Abu Daud dan al-Nasai', null],
    ['رواه ابن ماجه', 'Riwayat Ibnu Majah', null],
    ['رواه مالك', 'Riwayat Malik', null],
  ])('attributionOf(%s)', (ar, short, long) => {
    expect(attributionOf(ar)).toEqual({ short, long });
  });
  it('returns null for an unknown narrator or a text that is not an attribution', () => {
    expect(attributionOf('رواه فلان')).toBeNull();
    expect(attributionOf('رواه مسلم وفلان')).toBeNull();
    expect(attributionOf('كتاب')).toBeNull();
    expect(attributionOf('')).toBeNull();
  });
  it('classifies length and builds ids and category names', () => {
    expect(hadisLength('a'.repeat(220))).toBe('short');
    expect(hadisLength('a'.repeat(221))).toBe('medium');
    expect(hadisLength('a'.repeat(520))).toBe('medium');
    expect(hadisLength('a'.repeat(521))).toBe('long');
    expect(providerItemId('hadeethenc', '66512')).toBe('hadeethenc-66512');
    expect(hadisCategoryMs('1')).toBe('Al-Quran dan Ulum Al-Quran');
    expect(hadisCategoryMs('99999')).toBeNull();
    expect(HADIS_MAX_SAVED).toBe(500);
    expect(UNSTATED_SOURCE).toBe('Tidak dinyatakan');
  });
});

describe('hadis display', () => {
  it('hadisTier returns null for the 1000+ character sample and a tier for a short one', () => {
    const long = sample('66513');
    expect(long.hadeeth.length).toBeGreaterThan(1000);
    expect(hadisTier(long.hadeeth, long.hadeeth_ar)).toBeNull();
    expect(hadisTier('Sesungguhnya amalan itu dengan niat.', 'إنما الأعمال بالنيات')).toBe('l');
  });
  it('hadisParts splits at sentence ends, each part within the limit, nothing lost', () => {
    const full = sample('66513').hadeeth;
    const intro = full.slice(0, full.indexOf('nya:') + 4);
    const body = hadisDisplayText({ textMs: full, intro }).body;
    const parts = hadisParts(body);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts.length).toBeLessThanOrEqual(4);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(400);
      expect(p.length).toBeGreaterThan(0);
    }
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(body.replace(/\s+/g, ' ').trim());
    for (const p of parts.slice(0, -1)) expect(/[.?!]$/.test(p)).toBe(true);
  });
  it('hadisParts splits one over-long sentence at a space and never returns an empty part', () => {
    const words = Array.from({ length: 200 }, () => 'perkataan').join(' ');
    const parts = hadisParts(words, 100);
    expect(parts.every((p) => p.length > 0 && p.length <= 100)).toBe(true);
    expect(parts.join(' ')).toBe(words);
    expect(hadisParts('   ')).toEqual([]);
    expect(hadisParts('x'.repeat(250), 100).every((p) => p.length <= 100)).toBe(true);
  });
  it('hadisDisplayText splits the intro only when the text starts with it', () => {
    expect(hadisDisplayText({ textMs: 'Daripada A, beliau berkata: Islam itu.', intro: 'Daripada A, beliau berkata:' }))
      .toEqual({ body: 'Islam itu.', intro: 'Daripada A, beliau berkata:' });
    expect(hadisDisplayText({ textMs: 'Islam itu.', intro: 'Lain' })).toEqual({ body: 'Islam itu.', intro: null });
    expect(hadisDisplayText({ textMs: 'Islam itu.' })).toEqual({ body: 'Islam itu.', intro: null });
  });
  it('hadisPlan: single with Arabic when it fits, parts without Arabic or intro when it does not', () => {
    const short = hadisPlan({ textMs: 'Sesungguhnya amalan itu dengan niat.', textAr: 'إنما الأعمال بالنيات' }, { showArabic: true });
    expect(short).toMatchObject({ mode: 'single', tier: 'l', showAr: true });
    expect(hadisPlan({ textMs: 'Sesungguhnya amalan itu dengan niat.', textAr: 'إنما' }, { showArabic: false })).toMatchObject({ showAr: false });
    const long = sample('66513');
    const plan = hadisPlan({ textMs: long.hadeeth, textAr: long.hadeeth_ar }, { showArabic: true });
    expect(plan.mode).toBe('parts');
    if (plan.mode === 'parts') expect(plan.parts.length).toBeGreaterThanOrEqual(3);
  });
  it('hadisPlan honours a chosen size only when the text fits at it', () => {
    const fitsM = 'x'.repeat(200);
    const auto = hadisPlan({ textMs: fitsM }, { fontSize: 'auto' });
    expect(auto.mode === 'single' && auto.tier).toBeTruthy();
    const bigAsked = hadisPlan({ textMs: fitsM }, { fontSize: 'l' });
    const small = hadisPlan({ textMs: 'Pendek.' }, { fontSize: 's' });
    expect(small).toMatchObject({ mode: 'single', tier: 's' });
    // asking for a larger size than fits falls back to the largest one that fits
    expect(bigAsked.mode === 'single' && bigAsked.tier).toBe(auto.mode === 'single' && auto.tier);
  });
});

describe('ext.blocked in the schema', () => {
  it('accepts true and false, refuses anything else', () => {
    const base = { textMs: 'x', source: 'y', grade: 'sahih', ext };
    expect(validateContent('hadis', { ...base, id: 'hadeethenc-66512', ext: { ...ext, blocked: true } }).ok).toBe(true);
    expect(validateContent('hadis', { ...base, id: 'hadeethenc-66512', ext: { ...ext, blocked: false } }).ok).toBe(true);
    expect(validateContent('hadis', { ...base, id: 'hadeethenc-66512', ext: { ...ext, blocked: 'yes' } }).ok).toBe(false);
  });
});

describe('hadisPool', () => {
  const ten = [
    ...Array.from({ length: 4 }, (_, i) => own(`o${i}`, { order: i * 1000 })),
    ...Array.from({ length: 4 }, (_, i) => prov(String(100 + i), { order: 10000 + i * 1000 })),
  ];
  const settings: Pick<HadisSettings, 'source' | 'mix' | 'changeEvery' | 'perDay' | 'allowedGrades'> = {
    source: 'both', mix: 'list', changeEvery: 'card', perDay: 3, allowedGrades: ALL_GRADES,
  };

  it('filters hidden, blocked-grade, unknown-grade and by source', () => {
    const items = [
      own('a'), own('b', { shown: false }), prov('1'), prov('2', { grade: 'dhaif' }), prov('3', { grade: undefined }),
      prov('4', { grade: 'sahih_lighairihi' }),
    ];
    const ids = (s: Partial<typeof settings>) => hadisPool(items, { ...settings, ...s }, '2026-11-09').map((h) => h.id);
    expect(ids({})).toEqual(['a', 'hadeethenc-1']);
    expect(ids({ source: 'own' })).toEqual(['a']);
    expect(ids({ source: 'hadeethenc' })).toEqual(['hadeethenc-1']);
    expect(ids({ allowedGrades: { ...ALL_GRADES, sahih_lighairihi: true } })).toEqual(['a', 'hadeethenc-1', 'hadeethenc-4']);
  });
  it('a provider item flagged ext.blocked is out of the pool whatever shown says; unflagged it is back', () => {
    const flagged = prov('7', { shown: true, ext: { ...ext, id: '7', blocked: true } });
    const items = [own('a'), flagged, prov('8')];
    expect(hadisPool(items, settings, '2026-11-09').map((h) => h.id)).toEqual(['a', 'hadeethenc-8']);
    const cleared = prov('7', { shown: true, ext: { ...ext, id: '7', blocked: false } });
    expect(hadisPool([own('a'), cleared, prov('8')], settings, '2026-11-09').map((h) => h.id)).toEqual(['a', 'hadeethenc-7', 'hadeethenc-8']);
  });
  it('changeEvery card ships at most 50; the window moves 50 a day so every hadis is reached; 50 or fewer ship whole', () => {
    const many = Array.from({ length: 120 }, (_, i) => own(`m${String(i).padStart(3, '0')}`, { order: i * 1000 }));
    const day = (d: string) => hadisPool(many, settings, d).map((h) => h.id);
    expect(day('2026-11-09')).toHaveLength(50);
    expect(day('2026-11-09')).toEqual(day('2026-11-09'));
    expect(day('2026-11-09')).not.toEqual(day('2026-11-10'));
    const seen = new Set([...day('2026-11-09'), ...day('2026-11-10'), ...day('2026-11-11')]);
    expect(seen.size).toBe(120);
    expect(hadisPool(many.slice(0, 50), settings, '2026-11-09')).toHaveLength(50);
    expect(hadisPool(many.slice(0, 7), settings, '2026-11-09')).toHaveLength(7);
    expect(HADIS_CARD_POOL_MAX).toBe(50);
    // perDay still decides a "day" pool
    expect(hadisPool(many, { ...settings, changeEvery: 'day', perDay: 3 }, '2026-11-09')).toHaveLength(3);
  });
  it('list order: order field, then items without order by updatedAt', () => {
    const items = [
      own('late', { updatedAt: '2026-11-03T00:00:00.000Z' }), own('early', { updatedAt: '2026-11-02T00:00:00.000Z' }),
      own('second', { order: 2000 }), own('first', { order: 1000 }),
    ];
    expect(hadisPool(items, settings, '2026-11-09').map((h) => h.id)).toEqual(['first', 'second', 'early', 'late']);
  });
  it('alternate interleaves own and provider, and falls back to list when one side is empty', () => {
    const ids = hadisPool(ten, { ...settings, mix: 'alternate' }, '2026-11-09').map((h) => h.id);
    expect(ids).toEqual(['o0', 'hadeethenc-100', 'o1', 'hadeethenc-101', 'o2', 'hadeethenc-102', 'o3', 'hadeethenc-103']);
    const onlyOwn = ten.filter((h) => !h.ext);
    expect(hadisPool(onlyOwn, { ...settings, mix: 'alternate' }, '2026-11-09').map((h) => h.id)).toEqual(['o0', 'o1', 'o2', 'o3']);
    expect(hadisPool(ten, { ...settings, mix: 'alternate', source: 'own' }, '2026-11-09').map((h) => h.id)).toEqual(['o0', 'o1', 'o2', 'o3']);
  });
  it('random is the same for a date, differs the next day, and works with one source', () => {
    const r = (d: string, s: Partial<typeof settings> = {}) => hadisPool(ten, { ...settings, mix: 'random', ...s }, d).map((h) => h.id);
    expect(r('2026-11-09')).toEqual(r('2026-11-09'));
    expect(r('2026-11-09')).not.toEqual(r('2026-11-10'));
    expect([...r('2026-11-09')].sort()).toEqual([...ten.map((h) => h.id)].sort());
    const ownOnly = r('2026-11-09', { source: 'own' });
    expect(ownOnly).toHaveLength(4);
    expect([...ownOnly].sort()).toEqual(['o0', 'o1', 'o2', 'o3']);
    const dates = ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'].map((d) => r(d, { source: 'own' }).join());
    expect(new Set([ownOnly.join(), ...dates]).size).toBeGreaterThan(1);
  });
  it('a daily window of perDay rotates so every item shows once over ceil(n/perDay) days', () => {
    const n = 8;
    const days = Array.from({ length: Math.ceil(n / 3) }, (_, i) => `2026-11-${String(9 + i).padStart(2, '0')}`);
    const seen: string[] = [];
    for (const d of days) {
      const day = hadisPool(ten, { ...settings, changeEvery: 'day', perDay: 3 }, d);
      expect(day).toHaveLength(3);
      seen.push(...day.map((h) => h.id));
    }
    expect(new Set(seen).size).toBe(n);
    const d1 = hadisPool(ten, { ...settings, changeEvery: 'day', perDay: 3 }, '2026-11-09').map((h) => h.id);
    const d2 = hadisPool(ten, { ...settings, changeEvery: 'day', perDay: 3 }, '2026-11-10').map((h) => h.id);
    expect(d1).not.toEqual(d2);
  });
  it('perDay larger than the pool shows everything; an empty pool is empty', () => {
    expect(hadisPool(ten, { ...settings, changeEvery: 'day', perDay: 10 }, '2026-11-09')).toHaveLength(8);
    expect(hadisPool([], settings, '2026-11-09')).toEqual([]);
  });
});

describe('buildCycle', () => {
  const sNow = resolveSettings({});
  const only = (over: Partial<KioskContent>): KioskContent => ({
    date: '2026-11-03', kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [],
    hadisToday: [], worldTimes: [], tugasan: [], ayat: { today: null, tomorrow: null }, zikir: [],
    tilawah: { slots: [], available: {} }, credits: { translation: '', font: '', audio: '' }, ...over,
  });
  const kh = (id: string, textMs = 'Hadis pendek.'): KioskHadis => ({ id, textMs, attribution: 'Riwayat Muslim' });
  const d = 20; // hadis durationSeconds default
  // KL midnight + secs
  const at = (secs: number): Date => new Date(klInstant('2026-11-03', '00:00').getTime() + secs * 1000);
  const posterBase = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'x', title: 'P', assetId: 'a', days: ['umum' as const] };
  const c = (pool: KioskHadis[]) => only({
    posters: [{ ...posterBase, id: 'p1', order: 1 }, { ...posterBase, id: 'p2', order: 2 }],
    hadisToday: pool,
  });
  const others = 30; // two posters of 15 s

  it('gives one hadis slot per cycle that advances 0,1,2,0 with today\'s cycle length', () => {
    const pool = [kh('h0'), kh('h1'), kh('h2')];
    const cycleLen = others + d;
    const got = [0, 1, 2, 3].map((j) => buildCycle(c(pool), sNow, at(j * cycleLen + 5)));
    expect(got.map((g) => g.slots.find((s) => s.feature === 'hadis')!.itemId)).toEqual(['h0', 'h1', 'h2', 'h0']);
    for (const g of got) {
      expect(g.slots.reduce((a, s) => a + s.durationSeconds, 0)).toBe(cycleLen);
      expect(g.slots.every((s) => s.page === undefined)).toBe(true);
    }
    expect(got.map((g) => g.cycleStartSec)).toEqual([0, cycleLen, 2 * cycleLen, 3 * cycleLen]);
  });
  it('a long hadis takes one slot per part and the schedule stays contiguous across the period boundary', () => {
    const long = kh('long', sample('66513').hadeeth);
    const parts = hadisPlan(long, { showArabic: true });
    expect(parts.mode).toBe('parts');
    const p = parts.mode === 'parts' ? parts.parts.length : 0;
    const pool = [kh('a'), long];
    const lenA = others + d;
    const lenLong = others + d * p;
    const period = lenA + lenLong;
    // inside the long cycle
    const g = buildCycle(c(pool), sNow, at(lenA + 1));
    const hs = g.slots.filter((s) => s.feature === 'hadis');
    expect(hs.map((s) => s.page)).toEqual(Array.from({ length: p }, (_, i) => i));
    expect(hs.every((s) => s.itemId === 'long' && s.durationSeconds === d)).toBe(true);
    expect(g.cycleStartSec).toBe(lenA);
    // every second of two periods resolves to a slot, and the part index follows the slot
    for (let sec = 0; sec < 2 * period; sec++) {
      const cyc = buildCycle(c(pool), sNow, at(sec));
      const cur = currentSlot(cyc.slots, at(sec), cyc.cycleStartSec);
      expect(cur).not.toBeNull();
    }
    const startLong = buildCycle(c(pool), sNow, at(period + lenA + others));
    const cur = currentSlot(startLong.slots, at(period + lenA + others), startLong.cycleStartSec)!;
    expect(cur.slot).toMatchObject({ feature: 'hadis', itemId: 'long', page: 0 });
    const cur2 = currentSlot(startLong.slots, at(period + lenA + others + d), startLong.cycleStartSec)!;
    // one second later in the second part's window the same cycle is still used
    const next = buildCycle(c(pool), sNow, at(period + lenA + others + d));
    expect(currentSlot(next.slots, at(period + lenA + others + d), next.cycleStartSec)!.slot).toMatchObject({ itemId: 'long', page: 1 });
    expect(cur2.slot).toMatchObject({ itemId: 'long', page: 1 });
  });
  it('no hadis: cycleStartSec 0 and the other slots as before; a snapshot without hadisToday has no hadis card', () => {
    const g = buildCycle(only({ posters: [{ ...posterBase, id: 'p1', order: 1 }] }), sNow, at(100));
    expect(g).toMatchObject({ cycleStartSec: 0 });
    expect(g.slots.map((s) => s.feature)).toEqual(['posters']);
    const old = { ...only({ posters: [{ ...posterBase, id: 'p1', order: 1 }] }) } as Partial<KioskContent>;
    delete old.hadisToday;
    expect(buildCycle(old as KioskContent, sNow, at(3)).slots.map((s) => s.feature)).toEqual(['posters']);
  });
  it('a switched-off hadis feature and an empty pool leave no slot', () => {
    const off = resolveSettings({ hadis: { enabled: false } });
    expect(buildCycle(c([kh('h0')]), off, at(1)).slots.some((s) => s.feature === 'hadis')).toBe(false);
    expect(buildCycle(c([]), sNow, at(1)).slots.some((s) => s.feature === 'hadis')).toBe(false);
  });
  it('is a pure function of now', () => {
    const pool = [kh('h0'), kh('h1', sample('66513').hadeeth)];
    expect(buildCycle(c(pool), sNow, at(777))).toEqual(buildCycle(c(pool), sNow, at(777)));
  });
});

describe('hadis settings', () => {
  it('has the specified defaults', () => {
    expect(resolveSettings({}).hadis).toMatchObject({
      enabled: true, durationSeconds: 20, order: 6, source: 'both', mix: 'list', changeEvery: 'day', perDay: 3,
      showArabic: true, showMalay: true, showAttribution: true, showGrade: true, fontSize: 'auto',
      allowedGrades: { sahih: true, hasan: true, sahih_lighairihi: false, hasan_lighairihi: false },
    });
    expect(resolveSettings({}).hadis).not.toHaveProperty('pick');
  });
  it('refuses the old pick, out-of-range and unknown settings, accepts valid ones', () => {
    expect(validateFeatureSettings('hadis', { pick: 'daily' }).ok).toBe(false);
    expect(validateFeatureSettings('hadis', { perDay: 11 }).ok).toBe(false);
    expect(validateFeatureSettings('hadis', { perDay: 0 }).ok).toBe(false);
    expect(validateFeatureSettings('hadis', { allowedGrades: { dhaif: true } }).ok).toBe(false);
    expect(validateFeatureSettings('hadis', { source: 'myhadith' }).ok).toBe(false);
    expect(validateFeatureSettings('hadis', { fontSize: 'xl' }).ok).toBe(false);
    expect(validateFeatureSettings('hadis', { changeEvery: 'hour' }).ok).toBe(false);
    expect(validateFeatureSettings('hadis', { showGrade: 'yes' }).ok).toBe(false);
    expect(validateFeatureSettings('hadis', { mix: 'random' }).ok).toBe(true);
    expect(validateFeatureSettings('hadis', { source: 'own', perDay: 10, fontSize: 'l', allowedGrades: { sahih_lighairihi: true } }).ok).toBe(true);
  });
  it('a stored pick is ignored when resolving', () => {
    expect(resolveSettings({ hadis: { pick: 'random' } } as never).hadis).not.toHaveProperty('pick');
  });
  it('dataSources has the HadeethEnc address, accepted by sourceUrlError', () => {
    const ds = resolveSettings({}).dataSources;
    expect(ds.hadeethenc).toEqual({ name: 'HadeethEnc', url: 'https://hadeethenc.com/api/v1' });
    expect(sourceUrlError(ds.hadeethenc.url)).toBeNull();
    expect(validateFeatureSettings('dataSources', { hadeethenc: { url: 'http://hadeethenc.com/api' } }).ok).toBe(false);
    expect(validateFeatureSettings('dataSources', { hadeethenc: { url: 'https://hadeethenc.com/api/v2' } }).ok).toBe(true);
    expect(FEATURES.find((f) => f.key === 'hadis')!.group).toBe('kandungan');
  });
});

describe('pool vectors for Dart', () => {
  const tv = (JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/hadis-cases.json', import.meta.url)), 'utf8')) as {
    tv: { poolBigItems: Hadis[]; poolBigCases: { settings: Partial<HadisSettings>; today: string; expect: string[] }[]; poolItems: Hadis[]; poolCases: { settings: Partial<HadisSettings>; today: string; expect: string[] }[] };
  }).tv;
  it('the recorded pools are still what core gives, including a list over the card cap', () => {
    expect(tv.poolBigCases.length).toBeGreaterThan(10);
    for (const c of tv.poolBigCases) expect(hadisPool(tv.poolBigItems, c.settings, c.today).map((h) => h.id)).toEqual(c.expect);
    for (const c of tv.poolCases) expect(hadisPool(tv.poolItems, c.settings, c.today).map((h) => h.id)).toEqual(c.expect);
    const card = tv.poolBigCases.find((c) => c.settings.changeEvery === 'card')!;
    expect(card.expect).toHaveLength(50);
  });
});

describe('parity vectors', () => {
  const file = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/hadis-cases.json', import.meta.url)), 'utf8')) as {
    cases: { fn: string; input: string; max?: number; expect: unknown }[];
  };
  it('has the 12 or more vectors and core still gives the recorded answers', () => {
    expect(file.cases.length).toBeGreaterThanOrEqual(12);
    for (const c of file.cases) {
      const got =
        c.fn === 'hadisLength' ? hadisLength(c.input)
        : c.fn === 'gradeOf' ? gradeOf(c.input)
        : c.fn === 'attributionOf' ? attributionOf(c.input)
        : c.fn === 'providerItemId' ? providerItemId('hadeethenc', c.input)
        : hadisParts(c.input, c.max);
      expect(got).toEqual(c.expect);
    }
  });
  it('records literal expectations that do not come from the code under test', () => {
    const by = (fn: string, input: string) => file.cases.find((c) => c.fn === fn && c.input === input)!.expect;
    expect(by('gradeOf', 'صحيح')).toBe('sahih');
    expect(by('gradeOf', 'ضعيف جدا')).toBeNull();
    expect(by('attributionOf', 'رواه أبو داود والترمذي')).toEqual({ short: 'Riwayat Abu Daud dan al-Tirmizi', long: null });
    expect(by('attributionOf', 'رواه فلان')).toBeNull();
    expect(by('providerItemId', '66512')).toBe('hadeethenc-66512');
    expect(by('hadisLength', 'a'.repeat(521))).toBe('long');
  });
});
