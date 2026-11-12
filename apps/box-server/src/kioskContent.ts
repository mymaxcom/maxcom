import type { DatabaseSync } from 'node:sqlite';
import { UNSTATED_SOURCE, attributionOf, dateOf, hadisPool, klDateOf, klInstant, tzOf } from '@surau/core';
import type { AyatCard, ContentKind, Hadis, HadisSettings, ImageRef, ImageSlotKey, KioskContent, KioskHadis, KuliahView, Settings, TugasanView } from '@surau/core';
import { resolveImageId } from './imageAdjust.ts';
import { buildTabung } from './finance/tabung.ts';
import { getItem, listItems } from './content/store.ts';
import { readAudioIndex } from './islamic/fetch.ts';
import { AYAT_COUNTS, ayatForDay, loadQuran, quranFileStat } from './islamic/quranStore.ts';
import type { AyatSettings, QuranText } from './islamic/quranStore.ts';

const DAY_MS = 24 * 60 * 60_000;

type Raw = Record<string, unknown> | undefined;
const feat = (s: Settings, k: string): Raw => (s as unknown as Record<string, Raw>)[k];
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Drops the audit fields (who changed it, when): the kiosk never needs them. */
function pub<T extends { updatedAt?: string; updatedBy?: string }>(item: T): T {
  const { updatedAt: _a, updatedBy: _b, ...rest } = item;
  return rest as unknown as T;
}

const list = <K extends ContentKind>(db: DatabaseSync, kind: K) => listItems(db, kind).map(pub);

function addDays(date: string, n: number): string {
  return klDateOf(new Date(klInstant(date, '12:00').getTime() + n * DAY_MS));
}

/**
 * A hadis as the TV gets it: the BM attribution and the credit already resolved, no audit fields. Only an item
 * that carries the box-written `ext` is a HadeethEnc hadis (grade chip, credit); an own item never shows either.
 */
function kioskHadis(h: Hadis): KioskHadis {
  const provider = h.ext?.provider === 'hadeethenc' ? h.ext : null;
  const attr = provider ? attributionOf(provider.attributionAr) : null;
  // A HadeethEnc attribution MAXCOM has no Malay name for is left out: raw Arabic does not belong on the Malay card.
  const attribution = provider
    ? attr?.short ?? null
    : h.source === UNSTATED_SOURCE ? null : h.source;
  return {
    id: h.id,
    textMs: h.textMs,
    ...(h.textAr !== undefined ? { textAr: h.textAr } : {}),
    ...(h.intro !== undefined ? { intro: h.intro } : {}),
    ...(h.title !== undefined ? { title: h.title } : {}),
    ...(provider && h.grade !== undefined ? { grade: h.grade } : {}),
    attribution,
    ...(attr?.short === 'Muttafaq alaih' && attr.long !== null ? { attributionLong: attr.long } : {}),
    ...(provider ? { credit: 'HadeethEnc.com' as const } : {}),
  };
}

let quranCache: { dataDir: string; mtimeMs: number; size: number; quran: QuranText } | null = null;

function quranOf(dataDir: string): QuranText | null {
  const st = quranFileStat(dataDir);
  if (!st) return null;
  if (quranCache && quranCache.dataDir === dataDir && quranCache.mtimeMs === st.mtimeMs && quranCache.size === st.size) {
    return quranCache.quran;
  }
  const quran = loadQuran(dataDir);
  quranCache = quran ? { dataDir, ...st, quran } : null;
  return quran;
}

function ayatSettingsOf(settings: Settings): AyatSettings {
  const a = feat(settings, 'ayatCard') ?? {};
  const pick = a.pick === 'manual' || a.pick === 'random' ? a.pick : 'daily';
  return { pick, surah: num(a.surah, 2), ayatFrom: num(a.ayatFrom, 255), ayatTo: num(a.ayatTo, 255) };
}

export function buildKioskContent(db: DatabaseSync, dataDir: string, now: Date, settings: Settings): KioskContent {
  const tz = tzOf(settings);
  const today = dateOf(now, tz);
  /** The kiosk loads plain `/assets/<id>`: an adjusted picture is swapped for its derived asset id. */
  const img = (slot: ImageSlotKey, ref: ImageRef | undefined): string | undefined =>
    ref === undefined ? undefined : resolveImageId(db, dataDir, slot, ref);
  const withImg = <K extends string>(key: K, id: string | undefined): { [P in K]?: string } =>
    (id === undefined ? {} : { [key]: id }) as { [P in K]?: string };

  const kuliahLast = addDays(today, Math.max(0, num(feat(settings, 'kuliahCard')?.daysAhead, 7)));
  const kuliah: KuliahView[] = [];
  for (const k of listItems(db, 'kuliah')) {
    if (k.date < today || k.date > kuliahLast) continue;
    const p = getItem(db, 'penceramah', k.penceramahId);
    if (!p) continue;
    const kit = k.kitabId === undefined ? null : getItem(db, 'kitab', k.kitabId);
    const view: KuliahView = {
      ...pub(k),
      penceramah: { name: p.name, ...(p.title !== undefined ? { title: p.title } : {}), ...withImg('photoAssetId', img('penceramah', p.photoAssetId)) },
      ...(kit ? { kitab: { title: kit.title, ...withImg('coverAssetId', img('kitab', kit.coverAssetId)) } } : {}),
    };
    kuliah.push(view);
  }
  kuliah.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time) || a.id.localeCompare(b.id));

  const pengumuman = list(db, 'pengumuman').filter((p) => p.from <= today && today <= p.to);
  const ticker = list(db, 'ticker').filter((t) => t.from <= today && today <= t.to);
  const posters = list(db, 'poster').map((p) => ({ ...p, assetId: img('poster', p.assetId) ?? '' })).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const programKhas = list(db, 'programKhas')
    .filter((p) => p.showTo >= today)
    .map(({ assetId, ...rest }) => ({ ...rest, ...withImg('assetId', img('programKhas', assetId)) }));

  const takwimCount = Math.max(0, Math.floor(num(feat(settings, 'takwim')?.count, 3)));
  const takwim = list(db, 'takwim')
    .filter((t) => t.date >= today)
    .map(({ assetId, ...rest }) => ({ ...rest, ...withImg('assetId', img('takwim', assetId)) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    .slice(0, takwimCount);

  const tugasanLast = addDays(today, Math.max(0, num(feat(settings, 'tugasan')?.daysAhead, 14)));
  const tugasan: TugasanView[] = [];
  for (const t of listItems(db, 'tugasan')) {
    if (t.date < today || t.date > tugasanLast) continue;
    const p = getItem(db, 'petugas', t.petugasId);
    if (!p) continue;
    tugasan.push({
      ...pub(t),
      petugas: { name: p.name, ...withImg('photoAssetId', img('petugas', p.photoAssetId)) },
    });
  }
  tugasan.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  // Hadis: today's pool by source, grade, order and the day's window (the rotation shows one per cycle).
  const hadisPicked = hadisPool(listItems(db, 'hadis'), (feat(settings, 'hadis') ?? {}) as Partial<HadisSettings>, today);
  const hadisToday = hadisPicked.map(kioskHadis);

  const worldTimes = list(db, 'worldTime').sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const zikir = list(db, 'zikir').sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  const slots = list(db, 'tilawahSlot').filter((s) => s.enabled);
  const reciter = String(feat(settings, 'tilawah')?.reciter ?? 'Husary_64kbps');
  const available: KioskContent['tilawah']['available'] = {};
  let reciterName: string | null = null;
  for (const surah of new Set(slots.map((s) => s.surah))) {
    const idx = readAudioIndex(dataDir, reciter, surah);
    if (idx && idx.ayatCount === AYAT_COUNTS[surah - 1]) {
      available[surah] = { reciter, reciterName: idx.reciterName, ayatCount: idx.ayatCount };
      reciterName ??= idx.reciterName;
    }
  }

  const quran = quranOf(dataDir);
  const ayatSettings = ayatSettingsOf(settings);
  const ayatOn = (date: string): AyatCard | null => (quran ? ayatForDay(quran, ayatSettings, date) : null);

  return {
    date: today,
    kuliah,
    pengumuman,
    ticker,
    posters,
    programKhas,
    takwim,
    hadisToday,
    // Kept for a TV on a cached older bundle, whose content check wants this key (it ignores the value).
    hadis: null,
    worldTimes,
    tugasan,
    ayat: { today: ayatOn(today), tomorrow: ayatOn(addDays(today, 1)) },
    zikir,
    tilawah: { slots, available },
    credits: {
      translation: `Terjemahan: Abdullah Basmeih (QuranEnc.com)${quran && quran.version && quran.version !== 'unlisted' ? `, versi ${quran.version}` : ''}`,
      font: 'Tulisan Al-Quran: KFGQPC Uthmanic Hafs',
      audio: `Bacaan: ${reciterName ?? reciter} (EveryAyah.com)`,
    },
    tabung: buildTabung(db, now, settings),
  };
}
