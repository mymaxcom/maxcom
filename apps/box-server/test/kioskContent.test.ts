import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant } from '@surau/core';
import type { KioskContent } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { putItem, putProviderItem } from '../src/content/store.ts';
import { buildKioskContent } from '../src/kioskContent.ts';
import { saveQuran } from '../src/islamic/quranStore.ts';
import type { QuranText } from '../src/islamic/quranStore.ts';
import { getSettings, getVersion } from '../src/settingsStore.ts';

const AT = klInstant('2026-11-03', '12:00');
const ASSET = 'c'.repeat(64);

const apps: FastifyInstance[] = [];
const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-kc-'));
  dirs.push(d);
  return d;
}

interface Made {
  app: FastifyInstance;
  dataDir: string;
}

function make(): Made {
  const dataDir = tempDir();
  const app = buildApp(join(dataDir, 'test.db'), { now: () => AT, dataDir });
  apps.push(app);
  app.surau.db
    .prepare('INSERT INTO assets (id, mime, bytes, width, height, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ASSET, 'image/png', 10, 2, 2, new Date().toISOString(), 'local');
  return { app, dataDir };
}

afterEach(async () => {
  for (const a of apps.splice(0)) {
    try {
      await a.close();
    } catch {
      /* closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seed(app: FastifyInstance): void {
  const { db } = app.surau;
  const pen = putItem(db, 'penceramah', { name: 'Ustaz Ali', title: 'Ustaz', photoAssetId: ASSET }, 'secret-actor');
  const kit = putItem(db, 'kitab', { title: 'Riyadhus Salihin', coverAssetId: ASSET }, 'secret-actor');
  putItem(db, 'kuliah', {
    date: '2026-11-03', slot: 'maghrib', time: '19:15', label: 'Selepas Maghrib',
    penceramahId: pen.item.id, kitabId: kit.item.id, status: 'aktif',
  }, 'secret-actor');
  putItem(db, 'kuliah', {
    date: '2026-11-13', slot: 'maghrib', time: '19:15', label: 'Selepas Maghrib',
    penceramahId: pen.item.id, status: 'aktif',
  }, 'secret-actor');
  putItem(db, 'pengumuman', { title: 'Aktif', body: 'Isi', from: '2026-11-01', to: '2026-11-10', priority: 1 }, 'secret-actor');
  putItem(db, 'pengumuman', { title: 'Tamat', body: 'Isi', from: '2026-10-01', to: '2026-10-10', priority: 1 }, 'secret-actor');
  putItem(db, 'poster', { title: 'Poster 1', assetId: ASSET, days: ['jumaat'], order: 1 }, 'secret-actor');
  putItem(db, 'zikir', { order: 3, textAr: 'ج', textMs: 'tiga' }, 'secret-actor');
  putItem(db, 'zikir', { order: 1, textAr: 'أ', textMs: 'satu' }, 'secret-actor');
  putItem(db, 'zikir', { order: 2, textAr: 'ب', textMs: 'dua' }, 'secret-actor');
}

const quran: QuranText = {
  key: 'malay_basumayyah',
  title: 'Test',
  version: '1.0.9',
  fetchedAt: '2026-11-01T00:00:00Z',
  surahs: {},
};

function fullQuran(): QuranText {
  const surahs: QuranText['surahs'] = {};
  // every surah with enough ayat for any daily range
  for (let s = 1; s <= 114; s += 1) {
    surahs[s] = {
      nameAr: 'س',
      nameMs: `Surah ${s}`,
      ayat: Array.from({ length: 300 }, (_v, i) => ({ aya: i + 1, arabic: `ar ${s}:${i + 1}`, translation: `ms ${s}:${i + 1}` })),
    };
  }
  return { ...quran, surahs };
}

describe('buildKioskContent', () => {
  it('builds the day view from the stores', () => {
    const { app, dataDir } = make();
    seed(app);
    const c = buildKioskContent(app.surau.db, dataDir, AT, getSettings(app.surau.db));
    expect(c.date).toBe('2026-11-03');
    expect(c.kuliah).toHaveLength(1);
    expect(c.kuliah[0]?.penceramah.name).toBe('Ustaz Ali');
    expect(c.kuliah[0]?.penceramah.photoAssetId).toBe(ASSET);
    expect(c.kuliah[0]?.kitab?.title).toBe('Riyadhus Salihin');
    expect(c.pengumuman).toHaveLength(1);
    expect(c.pengumuman[0]?.title).toBe('Aktif');
    expect(c.posters).toHaveLength(1);
    expect(c.zikir.map((z) => z.textMs)).toEqual(['satu', 'dua', 'tiga']);
    expect(c.hadisToday).toEqual([]);
  });

  it('carries no actor or audit fields anywhere and drops deleted items', () => {
    const { app, dataDir } = make();
    seed(app);
    const gone = putItem(app.surau.db, 'zikir', { order: 9, textAr: 'x', textMs: 'dibuang' }, 'secret-actor');
    app.surau.db.prepare("UPDATE content_items SET deleted_at = '2026-11-02T00:00:00Z' WHERE id = ?").run(gone.item.id);
    const c = buildKioskContent(app.surau.db, dataDir, AT, getSettings(app.surau.db));
    const text = JSON.stringify(c);
    expect(text).not.toContain('updatedBy');
    expect(text).not.toContain('updatedAt');
    expect(text).not.toContain('secret-actor');
    expect(text).not.toContain('dibuang');
  });

  it('has null ayat and a string translation credit without the Quran file', () => {
    const { app, dataDir } = make();
    const c = buildKioskContent(app.surau.db, dataDir, AT, getSettings(app.surau.db));
    expect(c.ayat).toEqual({ today: null, tomorrow: null });
    expect(typeof c.credits.translation).toBe('string');
    expect(c.credits.translation).toContain('Abdullah Basmeih');
    expect(c.credits.font).toBe('Tulisan Al-Quran: KFGQPC Uthmanic Hafs');
    expect(c.tilawah.available).toEqual({});
  });

  it('fills ayat today and tomorrow from the Quran file, with the version in the credit', () => {
    const { app, dataDir } = make();
    saveQuran(dataDir, fullQuran());
    const c = buildKioskContent(app.surau.db, dataDir, AT, getSettings(app.surau.db));
    expect(typeof c.ayat.today?.surah).toBe('number');
    expect(typeof c.ayat.tomorrow?.surah).toBe('number');
    expect(c.credits.translation).toBe('Terjemahan: Abdullah Basmeih (QuranEnc.com), versi 1.0.9');
  });

  it('omits the version when QuranEnc does not publish one (stored as "unlisted")', () => {
    const { app, dataDir } = make();
    saveQuran(dataDir, { ...fullQuran(), version: 'unlisted' });
    const c = buildKioskContent(app.surau.db, dataDir, AT, getSettings(app.surau.db));
    expect(c.credits.translation).toBe('Terjemahan: Abdullah Basmeih (QuranEnc.com)');
  });

  it('lists tilawah audio that is fully cached and names the reciter', () => {
    const { app, dataDir } = make();
    putItem(app.surau.db, 'tilawahSlot', { days: ['daily'], before: 'subuh', minutesBefore: 30, surah: 18, enabled: true }, 'a');
    putItem(app.surau.db, 'tilawahSlot', { days: ['daily'], before: 'isyak', minutesBefore: 30, surah: 36, enabled: true }, 'a');
    const dir = join(dataDir, 'islamic', 'audio', 'Husary_64kbps', '18');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.json'), JSON.stringify({
      reciter: 'Husary_64kbps', reciterName: 'Husary', surah: 18, ayatCount: 110, bytes: 1, fetchedAt: '2026-11-01T00:00:00Z',
    }));
    const c = buildKioskContent(app.surau.db, dataDir, AT, getSettings(app.surau.db));
    expect(c.tilawah.slots).toHaveLength(2);
    expect(c.tilawah.available[18]).toEqual({ reciter: 'Husary_64kbps', reciterName: 'Husary', ayatCount: 110 });
    expect(c.tilawah.available[36]).toBeUndefined();
    expect(c.credits.audio).toBe('Bacaan: Husary (EveryAyah.com)');
  });

  describe('hadis of the day', () => {
    const EXT = {
      provider: 'hadeethenc' as const, id: '66512', attributionAr: 'رواه البخاري ومسلم', gradeAr: 'صحيح', categories: ['59'],
      fetchedAt: '2026-11-09T01:00:00.000Z', digest: 'a'.repeat(64),
    };
    const provider = (id: string, over: Record<string, unknown> = {}) => ({
      id: `hadeethenc-${id}`, textMs: `Daripada A: Teks ${id}.`, intro: 'Daripada A:', textAr: 'نص', source: 'Muttafaq alaih', title: `Tajuk ${id}`,
      grade: 'sahih', shown: true, order: 50_000 + Number(id), ext: { ...EXT, id }, ...over,
    });
    const ids = (c: KioskContent): string[] => (c.hadisToday ?? []).map((h) => h.id);
    const at = (d: string) => klInstant(d, '12:00');

    it('20 hadis with perDay 3 give 3 today and others tomorrow, all 20 within 7 days', () => {
      const { app, dataDir } = make();
      for (let i = 0; i < 20; i += 1) putItem(app.surau.db, 'hadis', { id: `h${String(i).padStart(2, '0')}`, textMs: `hadis ${i}`, source: 'Sumber', order: i * 1000 }, 'a');
      const s = getSettings(app.surau.db);
      const seen = new Set<string>();
      let prev: string[] = [];
      for (let d = 3; d < 10; d += 1) {
        const day = ids(buildKioskContent(app.surau.db, dataDir, at(`2026-11-${String(d).padStart(2, '0')}`), s));
        expect(day).toHaveLength(3);
        expect(day).not.toEqual(prev);
        prev = day;
        day.forEach((x) => seen.add(x));
      }
      expect(seen.size).toBe(20);
    });

    it('a hidden item, a dhaif or unknown-grade provider item and a disallowed grade never appear', () => {
      const { app, dataDir } = make();
      const { db } = app.surau;
      putItem(db, 'hadis', { id: 'own-shown', textMs: 'Terbuka', source: 'Sumber', order: 1 }, 'a');
      putItem(db, 'hadis', { id: 'own-hidden', textMs: 'Tersembunyi', source: 'Sumber', shown: false, order: 2 }, 'a');
      putProviderItem(db, provider('1'), 'a');
      putProviderItem(db, provider('2', { grade: 'dhaif' }), 'a');
      putProviderItem(db, provider('3', { grade: undefined, shown: false }), 'a');
      putProviderItem(db, provider('4', { grade: 'sahih_lighairihi' }), 'a');
      const s = { ...getSettings(db), hadis: { ...getSettings(db).hadis, changeEvery: 'card' as const } };
      expect(ids(buildKioskContent(db, dataDir, AT, s))).toEqual(['own-shown', 'hadeethenc-1']);
      const on = { ...s, hadis: { ...s.hadis, allowedGrades: { ...s.hadis.allowedGrades, sahih_lighairihi: true } } };
      expect(ids(buildKioskContent(db, dataDir, AT, on))).toEqual(['own-shown', 'hadeethenc-1', 'hadeethenc-4']);
    });

    it('source own leaves out HadeethEnc items, source hadeethenc leaves out the own list', () => {
      const { app, dataDir } = make();
      const { db } = app.surau;
      putItem(db, 'hadis', { id: 'own-a', textMs: 'Sendiri', source: 'Sumber', order: 1 }, 'a');
      putProviderItem(db, provider('1'), 'a');
      const base = getSettings(db);
      const withSource = (source: 'own' | 'hadeethenc' | 'both') => ({ ...base, hadis: { ...base.hadis, source, changeEvery: 'card' as const } });
      expect(ids(buildKioskContent(db, dataDir, AT, withSource('own')))).toEqual(['own-a']);
      expect(ids(buildKioskContent(db, dataDir, AT, withSource('hadeethenc')))).toEqual(['hadeethenc-1']);
      expect(ids(buildKioskContent(db, dataDir, AT, withSource('both')))).toEqual(['own-a', 'hadeethenc-1']);
    });

    it('a provider item carries the BM attribution, the long form for Muttafaq alaih, the grade and the credit', () => {
      const { app, dataDir } = make();
      const { db } = app.surau;
      putProviderItem(db, provider('1'), 'a');
      putProviderItem(db, provider('2', { source: 'Riwayat Muslim', ext: { ...EXT, id: '2', attributionAr: 'رواه مسلم' } }), 'a');
      putProviderItem(db, provider('3', { source: 'رواه فلان', ext: { ...EXT, id: '3', attributionAr: 'رواه فلان' } }), 'a');
      const s = { ...getSettings(db), hadis: { ...getSettings(db).hadis, changeEvery: 'card' as const } };
      const [one, two, three] = buildKioskContent(db, dataDir, AT, s).hadisToday ?? [];
      expect(one).toEqual({
        id: 'hadeethenc-1', textMs: 'Daripada A: Teks 1.', textAr: 'نص', intro: 'Daripada A:', title: 'Tajuk 1', grade: 'sahih',
        attribution: 'Muttafaq alaih', attributionLong: 'Riwayat al-Bukhari dan Muslim', credit: 'HadeethEnc.com',
      });
      expect(two).toMatchObject({ attribution: 'Riwayat Muslim', credit: 'HadeethEnc.com' });
      expect(two).not.toHaveProperty('attributionLong');
      expect(three?.attribution).toBeNull(); // unmapped: omitted, never raw Arabic on the Malay card
      expect(JSON.stringify(one)).not.toMatch(/updatedAt|updatedBy|digest|fetchedAt|"ext"/);
    });

    it('an own item shows its own source, no grade, no credit; the importer placeholder shows no attribution', () => {
      const { app, dataDir } = make();
      const { db } = app.surau;
      putItem(db, 'hadis', { id: 'own-a', textMs: 'Sendiri', source: 'Riwayat Muslim', textAr: 'نص', order: 1 }, 'a');
      putItem(db, 'hadis', { id: 'own-b', textMs: 'Tanpa sumber', source: 'Tidak dinyatakan', order: 2 }, 'a');
      const s = { ...getSettings(db), hadis: { ...getSettings(db).hadis, changeEvery: 'card' as const } };
      const [a, b] = buildKioskContent(db, dataDir, AT, s).hadisToday ?? [];
      expect(a).toEqual({ id: 'own-a', textMs: 'Sendiri', textAr: 'نص', attribution: 'Riwayat Muslim' });
      expect(b).toEqual({ id: 'own-b', textMs: 'Tanpa sumber', attribution: null });
    });

    it('changeEvery card ships at most 50 so a snapshot stays small; the rest rotate in on the next days', () => {
      const { app, dataDir } = make();
      const { db } = app.surau;
      for (let i = 0; i < 120; i += 1) putItem(db, 'hadis', { id: `c${String(i).padStart(3, '0')}`, textMs: `hadis ${i}`, source: 'Sumber', order: i * 1000 }, 'a');
      const s = { ...getSettings(db), hadis: { ...getSettings(db).hadis, changeEvery: 'card' as const } };
      const seen = new Set<string>();
      const days: string[][] = [];
      for (let d = 3; d < 6; d += 1) {
        const day = ids(buildKioskContent(db, dataDir, at(`2026-11-${String(d).padStart(2, '0')}`), s));
        expect(day).toHaveLength(50);
        days.push(day);
        day.forEach((x) => seen.add(x));
      }
      expect(days[0]).not.toEqual(days[1]);
      expect(seen.size).toBe(120);
      // the same day always gives the same pool
      expect(ids(buildKioskContent(db, dataDir, at('2026-11-03'), s))).toEqual(days[0]);
    });

    it('changeEvery card with 50 or fewer ships them all (nothing is cut below the cap)', () => {
      const { app, dataDir } = make();
      const { db } = app.surau;
      for (let i = 0; i < 50; i += 1) putItem(db, 'hadis', { id: `c${String(i).padStart(3, '0')}`, textMs: `hadis ${i}`, source: 'Sumber', order: i * 1000 }, 'a');
      const s = { ...getSettings(db), hadis: { ...getSettings(db).hadis, changeEvery: 'card' as const } };
      expect(ids(buildKioskContent(db, dataDir, AT, s))).toHaveLength(50);
    });

    it('a provider hadis with an attribution MAXCOM has no BM for shows none, not the raw Arabic; a mapped one keeps its BM name', () => {
      const { app, dataDir } = make();
      const { db } = app.surau;
      putProviderItem(db, provider('1'), 'a');
      putProviderItem(db, provider('2', { ext: { ...EXT, id: '2', attributionAr: 'رواه فلان' }, source: 'رواه فلان' }), 'a');
      const s = { ...getSettings(db), hadis: { ...getSettings(db).hadis, changeEvery: 'card' as const } };
      const [one, two] = buildKioskContent(db, dataDir, AT, s).hadisToday ?? [];
      expect(one!.attribution).toBe('Muttafaq alaih');
      expect(two!.attribution).toBeNull();
      expect(two!.credit).toBe('HadeethEnc.com');
      expect(JSON.stringify(two)).not.toContain('رواه فلان');
    });

    it('the snapshot keeps sending hadis: null so a TV on a cached older bundle still loads its content', () => {
      const { app, dataDir } = make();
      const { db } = app.surau;
      putItem(db, 'hadis', { id: 'o', textMs: 't', source: 's' }, 'a');
      const c = buildKioskContent(db, dataDir, AT, getSettings(db));
      expect(c.hadisToday).toHaveLength(1);
      const wire = JSON.parse(JSON.stringify(c)) as Record<string, unknown>;
      expect('hadis' in wire).toBe(true);
      expect(wire.hadis).toBeNull();
    });

    it('changeEvery card gives the whole eligible pool in list order, random keeps one date stable', () => {
      const { app, dataDir } = make();
      const { db } = app.surau;
      for (const [n, o] of [['c', 3000], ['a', 1000], ['b', 2000], ['d', 4000]] as const) {
        putItem(db, 'hadis', { id: `x-${n}`, textMs: n, source: 'S', order: o }, 'a');
      }
      const base = getSettings(db);
      const card = { ...base, hadis: { ...base.hadis, changeEvery: 'card' as const } };
      expect(ids(buildKioskContent(db, dataDir, AT, card))).toEqual(['x-a', 'x-b', 'x-c', 'x-d']);
      const rnd = { ...card, hadis: { ...card.hadis, mix: 'random' as const } };
      expect(ids(buildKioskContent(db, dataDir, AT, rnd))).toEqual(ids(buildKioskContent(db, dataDir, at('2026-11-03'), rnd)));
      expect([...ids(buildKioskContent(db, dataDir, AT, rnd))].sort()).toEqual(['x-a', 'x-b', 'x-c', 'x-d']);
    });

    it('an empty pool is an empty list; the old stored pick setting is ignored', () => {
      const { app, dataDir } = make();
      const { db } = app.surau;
      const c = buildKioskContent(db, dataDir, AT, getSettings(db));
      expect(c.hadisToday).toEqual([]);
      putItem(db, 'hadis', { id: 'o', textMs: 't', source: 's' }, 'a');
      const legacy = { ...getSettings(db), hadis: { ...getSettings(db).hadis, pick: 'random' } };
      expect(() => buildKioskContent(db, dataDir, AT, legacy)).not.toThrow();
      expect(ids(buildKioskContent(db, dataDir, AT, legacy))).toEqual(['o']);
    });
  });

  it('windows takwim, programKhas and tugasan', () => {
    const { app, dataDir } = make();
    const { db } = app.surau;
    putItem(db, 'takwim', { date: '2026-11-01', title: 'Lalu' }, 'a');
    for (const [n, d] of [['A', '2026-11-05'], ['B', '2026-11-06'], ['C', '2026-11-07'], ['D', '2026-11-08'], ['E', '2026-11-09']] as const) {
      putItem(db, 'takwim', { date: d, title: n }, 'a');
    }
    putItem(db, 'programKhas', { title: 'Lama', at: '2026-11-02T20:00', showFrom: '2026-10-30', showTo: '2026-11-02', status: 'aktif' }, 'a');
    putItem(db, 'programKhas', { title: 'Baru', at: '2026-11-08T20:00', showFrom: '2026-11-01', showTo: '2026-11-08', status: 'aktif' }, 'a');
    const p = putItem(db, 'petugas', { name: 'Encik Imam', photoAssetId: ASSET }, 'a');
    putItem(db, 'tugasan', { date: '2026-11-04', role: 'imam', petugasId: p.item.id }, 'a');
    putItem(db, 'tugasan', { date: '2026-12-25', role: 'imam', petugasId: p.item.id }, 'a');
    const c = buildKioskContent(db, dataDir, AT, getSettings(db));
    expect(c.takwim.map((t) => t.title)).toEqual(['A', 'B', 'C']);
    expect(c.programKhas.map((x) => x.title)).toEqual(['Baru']);
    expect(c.tugasan).toHaveLength(1);
    expect(c.tugasan[0]?.petugas).toEqual({ name: 'Encik Imam', photoAssetId: ASSET });
  });
});

describe('GET /api/kiosk/content', () => {
  it('serves version, serverTime and the content to the loopback kiosk, uncached', async () => {
    const { app } = make();
    seed(app);
    const res = await app.inject({ method: 'GET', url: '/api/kiosk/content' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as { version: number; serverTime: string; content: KioskContent };
    expect(body.version).toBe(getVersion(app.surau.db));
    expect(body.serverTime).toBe(AT.toISOString());
    expect(body.content.date).toBe('2026-11-03');
    expect(body.content.kuliah).toHaveLength(1);
    expect(res.body).not.toContain('secret-actor');
  });

  it('refuses an anonymous LAN caller', async () => {
    const { app } = make();
    const res = await app.inject({ method: 'GET', url: '/api/kiosk/content', remoteAddress: '10.168.1.60' });
    expect(res.statusCode).toBe(401);
  });
});

