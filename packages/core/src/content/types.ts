import type { DayKey } from '../features/registry.ts';
import type { ImageRef } from '../image.ts';
import type { TabungCardView } from '../finance/types.ts';

export type ContentKind =
  | 'penceramah'
  | 'kitab'
  | 'kuliah'
  | 'pengumuman'
  | 'ticker'
  | 'poster'
  | 'programKhas'
  | 'takwim'
  | 'hadis'
  | 'worldTime'
  | 'petugas'
  | 'tugasan'
  | 'zikir'
  | 'tilawahSlot';

export type SolatSlot = 'subuh' | 'zohor' | 'asar' | 'maghrib' | 'isyak' | 'lain';
export type ContentStatus = 'aktif' | 'batal';
export type TugasanRole = 'imam' | 'bilal' | 'khatib' | 'ajk';

export interface ContentBase {
  id: string;
  updatedAt: string;
  updatedBy: string;
}

export interface Penceramah extends ContentBase {
  name: string;
  title?: string;
  phone?: string;
  /** Legacy asset id or an adjusted image (see image.ts). The kiosk gets the derived asset id instead. */
  photoAssetId?: ImageRef;
}

export interface Kitab extends ContentBase {
  title: string;
  author?: string;
  coverAssetId?: ImageRef;
}

export interface Kuliah extends ContentBase {
  date: string;
  slot: SolatSlot;
  time: string;
  label: string;
  penceramahId: string;
  kitabId?: string;
  topic?: string;
  status: ContentStatus;
  seriesId?: string;
}

export interface Pengumuman extends ContentBase {
  title: string;
  body: string;
  from: string;
  to: string;
  priority: 1 | 2 | 3;
}

export interface TickerItem extends ContentBase {
  text: string;
  from: string;
  to: string;
}

export interface Poster extends ContentBase {
  /** The poster's name in lists and search (1..80 characters). */
  title: string;
  assetId: ImageRef;
  days: ('umum' | DayKey)[];
  from?: string;
  to?: string;
  order: number;
}

export interface ProgramKhas extends ContentBase {
  title: string;
  at: string;
  showFrom: string;
  showTo: string;
  assetId?: ImageRef;
  note?: string;
  status: ContentStatus;
}

export interface Takwim extends ContentBase {
  date: string;
  hijriLabel?: string;
  title: string;
  assetId?: ImageRef;
}

export type HadisGrade = 'sahih' | 'hasan' | 'sahih_lighairihi' | 'hasan_lighairihi' | 'dhaif' | 'maudhu';

/** Provider facts of a hadis saved from HadeethEnc; write-locked on the box (only /api/hadis/add and accept-update write it). */
export interface HadisExt {
  provider: 'hadeethenc';
  /** Provider id, /^\d{1,8}$/. */
  id: string;
  /** Verbatim `attribution` (Arabic), <= 200. */
  attributionAr: string;
  /** Verbatim `grade` (Arabic), <= 60. */
  gradeAr: string;
  /** Provider category ids, <= 20. */
  categories: string[];
  /** ISO time the text was taken from the provider. */
  fetchedAt: string;
  /** Hex sha256 of `hadeeth
 hadeeth_ar
 attribution
 grade`; the update check compares it. */
  digest: string;
  /**
   * Set by the box when the provider's newer grade is blocked or unknown: the TV stops showing the item at once
   * while `shown` stays the person's own choice. Cleared when the update is accepted or the grade recovers.
   */
  blocked?: boolean;
}

export interface Hadis extends ContentBase {
  textMs: string;
  textAr?: string;
  /** Own list: the typed attribution. Provider: the BM short attribution (e.g. `Muttafaq alaih`). */
  source: string;
  /** Provider title (BM), <= 300. */
  title?: string;
  /** Provider `hadeeth_intro` (BM), <= 400; `textMs` starts with it. */
  intro?: string;
  /** Provider items only. */
  grade?: HadisGrade;
  /** `Papar di TV`; absent means true. */
  shown?: boolean;
  /** List position 0..1_000_000; absent sorts after every ordered item, by updatedAt. */
  order?: number;
  /** Absent means own list. */
  ext?: HadisExt;
}

export interface WorldTime extends ContentBase {
  city: string;
  tz: string;
  order: number;
}

export interface Petugas extends ContentBase {
  name: string;
  photoAssetId?: ImageRef;
}

export interface Tugasan extends ContentBase {
  date: string;
  role: TugasanRole;
  petugasId: string;
  note?: string;
}

export interface Zikir extends ContentBase {
  order: number;
  textAr: string;
  textMs: string;
  repeat?: number;
}

export interface TilawahSlot extends ContentBase {
  days: ('daily' | DayKey)[];
  before: 'subuh' | 'zohor' | 'asar' | 'maghrib' | 'isyak';
  minutesBefore: number;
  surah: number;
  enabled: boolean;
}

export interface ContentItemMap {
  penceramah: Penceramah;
  kitab: Kitab;
  kuliah: Kuliah;
  pengumuman: Pengumuman;
  ticker: TickerItem;
  poster: Poster;
  programKhas: ProgramKhas;
  takwim: Takwim;
  hadis: Hadis;
  worldTime: WorldTime;
  petugas: Petugas;
  tugasan: Tugasan;
  zikir: Zikir;
  tilawahSlot: TilawahSlot;
}

export type ContentItemOf<K extends ContentKind> = ContentItemMap[K];

/** View of a kuliah joined with its penceramah and optional kitab. */
export type KuliahView = Kuliah & {
  penceramah: { name: string; title?: string; photoAssetId?: string };
  kitab?: { title: string; coverAssetId?: string };
};

/** View of a tugasan joined with its petugas. */
export type TugasanView = Tugasan & {
  petugas: { name: string; photoAssetId?: string };
};

/** Ayat card rendered by the kiosk. */
export interface AyatCard {
  surah: number;
  surahNameAr: string;
  surahNameMs: string;
  ayatFrom: number;
  ayatTo: number;
  arabic: string[];
  malay: string[];
  translationVersion: string;
}

/** Kiosk copies of the items above: every picture is already the derived asset id (a plain string). */
export type KioskPoster = Omit<Poster, 'assetId'> & { assetId: string };
export type KioskProgramKhas = Omit<ProgramKhas, 'assetId'> & { assetId?: string };
export type KioskTakwim = Omit<Takwim, 'assetId'> & { assetId?: string };

/** One hadis of today's pool, with the BM attribution and the credit already resolved. */
export interface KioskHadis {
  id: string;
  textMs: string;
  textAr?: string;
  intro?: string;
  title?: string;
  /** Provider items only. */
  grade?: HadisGrade;
  /** BM short (`Muttafaq alaih`, `Riwayat Muslim`) or the own `source`; null for UNSTATED_SOURCE. */
  attribution: string | null;
  /** `Riwayat al-Bukhari dan Muslim` when the short form is Muttafaq alaih. */
  attributionLong?: string;
  /** Provider items only. */
  credit?: 'HadeethEnc.com';
}

/** Complete content snapshot served to the kiosk. */
export interface KioskContent {
  date: string;
  kuliah: KuliahView[];
  pengumuman: Pengumuman[];
  ticker: TickerItem[];
  posters: KioskPoster[];
  programKhas: KioskProgramKhas[];
  takwim: KioskTakwim[];
  /** Today's ordered hadis pool (Plan 14); the rotation shows one per cycle. */
  hadisToday: KioskHadis[];
  /** Always null. Sent only so a TV still running an older cached bundle (which requires the key) loads its content. */
  hadis?: null;
  worldTimes: WorldTime[];
  tugasan: TugasanView[];
  ayat: { today: AyatCard | null; tomorrow: AyatCard | null };
  zikir: Zikir[];
  tilawah: {
    slots: TilawahSlot[];
    available: Record<number, { reciter: string; reciterName: string; ayatCount: number }>;
  };
  credits: { translation: string; font: string; audio: string };
  /** Donation fund card (Plan 7). Absent or null: no card. A box older than Plan 7 sends none. */
  tabung?: TabungCardView | null;
}
