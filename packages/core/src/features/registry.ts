/** Feature registry: every switchable feature, its group, lock state, defaults and labels. */

import type { ImageRef } from '../image.ts';

export type FeatureGroup = 'solat' | 'skrin' | 'kandungan' | 'quran' | 'audio' | 'live' | 'kewangan' | 'jemaah' | 'awan' | 'keselamatan' | 'lanjutan';

export type DayKey = 'ahad' | 'isnin' | 'selasa' | 'rabu' | 'khamis' | 'jumaat' | 'sabtu';
export type SolatKey = 'subuh' | 'zohor' | 'asar' | 'maghrib' | 'isyak';
/** Per-day, per-prayer minutes. A missing cell means "use the fallback". */
export type WeekTable = Record<DayKey, Partial<Record<SolatKey, number>>>;

/** Index = klWeekday (0 = ahad). */
export const DAY_KEYS: readonly DayKey[] = ['ahad', 'isnin', 'selasa', 'rabu', 'khamis', 'jumaat', 'sabtu'];
export const SOLAT_KEYS: readonly SolatKey[] = ['subuh', 'zohor', 'asar', 'maghrib', 'isyak'];

export type FeatureKey =
  | 'prayerBar' | 'clock' | 'prayerSequenceSafety' | 'zone' | 'azanCountdown' | 'masukWaktu'
  | 'iqamahCountdown' | 'solatScreen' | 'jumaat' | 'tarawih' | 'syurukWarning' | 'imsakBeep'
  | 'isyraq' | 'firstAzanSubuh' | 'dataSources' | 'location' | 'prayerCalc' | 'prayerSources'
  | 'surauInfo' | 'hijriDate' | 'backgrounds' | 'autoTone' | 'language' | 'orientation' | 'kioskTemplate'
  | 'kuliahCard' | 'penceramahPhoto' | 'kitabCover' | 'pengumuman' | 'ticker' | 'posters'
  | 'programKhas' | 'takwim' | 'hadis' | 'worldTimes' | 'tugasan'
  | 'ayatCard' | 'zikirSelepasSolat' | 'quranReader' | 'tilawah'
  | 'beeps'
  | 'liveOnKiosk' | 'liveYoutube' | 'recording'
  | 'finance' | 'tabungCard'
  | 'calendarFeed' | 'jemaahPage'
  | 'cloudSync' | 'youtubeCatchUp' | 'recordingCleanup'
  | 'appLock' | 'system';

export interface FeatureDef {
  key: FeatureKey;
  group: FeatureGroup;
  locked: boolean;
  defaultEnabled: boolean;
  defaults: Record<string, unknown>;
  labelMs: string;
  labelEn: string;
}

export interface FeatureSettings {
  enabled: boolean;
  [k: string]: unknown;
}
/** Typed views for the solat/skrin features Plan 1 consumes. */
export interface IqamahSettings extends FeatureSettings { minutes: WeekTable; endWarningSeconds: number; beep: boolean }
export interface SolatScreenSettings extends FeatureSettings { minutes: WeekTable; message: string }
export interface AzanCountdownSettings extends FeatureSettings { minutesBefore: Record<SolatKey, number>; fullScreen: boolean; beep: boolean }
export interface MasukWaktuSettings extends FeatureSettings { screenSeconds: number; beep: boolean }
export interface JumaatSettings extends FeatureSettings { khutbahMinutes: number; iqamahMinutes: number; solatMinutes: number }
export interface TarawihSettings extends FeatureSettings { hijriMonth: number; gapMinutes: number; minutes: number }
export interface SyurukWarningSettings extends FeatureSettings { minutesBefore: number; beep: boolean }
export interface IsyraqSettings extends FeatureSettings { minutesAfterSyuruk: number; durationMinutes: number }
export interface HijriDateSettings extends FeatureSettings { adjustDays: number; switchAt: 'maghrib' | 'midnight' }
export interface AutoToneSettings extends FeatureSettings { override: string | null }
/** The TV presentation templates; 'default' is the original single-colour look (backgrounds and autoTone apply to it only). */
export const KIOSK_TEMPLATE_IDS = ['default', 'colourful', 'creative', 'oldschool', 'minimal'] as const;
export type KioskTemplateId = (typeof KIOSK_TEMPLATE_IDS)[number];
export interface KioskTemplateSettings extends FeatureSettings { templateId: KioskTemplateId }

/** Typed views keyed by feature; features not listed use the plain FeatureSettings shape. */
export interface TypedSettings {
  iqamahCountdown: IqamahSettings;
  solatScreen: SolatScreenSettings;
  azanCountdown: AzanCountdownSettings;
  masukWaktu: MasukWaktuSettings;
  jumaat: JumaatSettings;
  tarawih: TarawihSettings;
  syurukWarning: SyurukWarningSettings;
  isyraq: IsyraqSettings;
  hijriDate: HijriDateSettings;
  autoTone: AutoToneSettings;
  kioskTemplate: KioskTemplateSettings;
  surauInfo: SurauInfoSettings;
  dataSources: DataSourcesSettings;
  location: LocationSettings;
  prayerCalc: PrayerCalcSettings;
  prayerSources: PrayerSourcesSettings;
  liveOnKiosk: LiveOnKioskSettings;
  liveYoutube: LiveYoutubeSettings;
  system: SystemSettings;
  recording: RecordingSettings;
  hadis: HadisSettings;
}
export interface HadisSettings extends FeatureSettings {
  durationSeconds: number;
  order: number;
  source: 'own' | 'hadeethenc' | 'both';
  mix: 'list' | 'alternate' | 'random';
  changeEvery: 'day' | 'card';
  perDay: number;
  showArabic: boolean;
  showMalay: boolean;
  showAttribution: boolean;
  showGrade: boolean;
  fontSize: 'auto' | 's' | 'm' | 'l';
  allowedGrades: { sahih: boolean; hasan: boolean; sahih_lighairihi: boolean; hasan_lighairihi: boolean };
}
export interface LiveOnKioskSettings extends FeatureSettings { audio: boolean; volume: number; showStrip: boolean; fit: 'cover' | 'contain' }
export interface LiveYoutubeSettings extends FeatureSettings {
  privacy: 'public' | 'unlisted' | 'private';
  relayFrom: 'box' | 'phone';
  relayVideo: 'copy' | 'reencode';
  titleTemplate: string;
  descriptionTemplate: string;
  maxBitrateKbps: number;
}
/** MAXCOM system values (Lanjutan; Pentadbir MAXCOM only). suspendedAt is the reversible stop flag. */
export interface SystemSettings extends FeatureSettings {
  noVideoSeconds: number;
  cloudWakeSeconds: number;
  syncHistoryDays: 180 | 365;
  suspendedAt: string | null;
}
export interface RecordingSettings extends FeatureSettings { segmentMinutes: number; keepOnDevice: boolean }
export interface DataSource { name: string; url: string }
export interface DataSourcesSettings extends FeatureSettings {
  esolat: DataSource;
  esolatZones: DataSource;
  nominatim: DataSource;
  quranText: DataSource;
  quranAudio: DataSource;
  hadeethenc: DataSource;
}
/** Where the surau is: country, IANA time zone and coordinates (decimal degrees, 4 places). */
export interface LocationSettings extends FeatureSettings {
  country: string;
  timezone: string;
  latitude: number | null;
  longitude: number | null;
  city: string;
}
export interface PrayerCalcSettings extends FeatureSettings {
  method: string;
  madhab: 'auto' | 'shafi' | 'hanafi';
  highLatitude: 'auto' | 'middleOfNight' | 'seventhOfNight' | 'twilightAngle';
  adjustMinutes: Record<'imsak' | 'subuh' | 'syuruk' | 'zohor' | 'asar' | 'maghrib' | 'isyak', number>;
  imsakMinutes: number;
}
export interface PrayerSourcesSettings extends FeatureSettings {
  sourceOrder: Array<'official' | 'calc' | 'file'>;
  crossCheck: boolean;
}
export interface SurauInfoSettings extends FeatureSettings {
  name: string;
  kind: 'surau' | 'masjid';
  shortAddress: string;
  helpName: string;
  helpPhone: string;
  helpEmail: string;
  /** The surau/masjid logo (PNG or JPEG): '' for none, a plain asset id, or an adjusted image (see image.ts). */
  logo: ImageRef;
  /** Show the surau name as text beside the logo (false when the logo already is the name). */
  showName: boolean;
}

export type Settings = { [K in FeatureKey]: K extends keyof TypedSettings ? TypedSettings[K] : FeatureSettings };

/** Minutes for a prayer on a day from a WeekTable, or `fallback` when the cell is missing. */
export function minutesFor(table: WeekTable, day: DayKey, p: SolatKey, fallback: number): number {
  const v = table[day]?.[p];
  return typeof v === 'number' ? v : fallback;
}

function week(d: Record<SolatKey, number>): WeekTable {
  const t = {} as WeekTable;
  for (const day of DAY_KEYS) t[day] = { ...d };
  return t;
}

function def(
  key: FeatureKey, group: FeatureGroup, locked: boolean, defaultEnabled: boolean,
  defaults: Record<string, unknown>, labelMs: string, labelEn: string,
): FeatureDef {
  return { key, group, locked, defaultEnabled, defaults, labelMs, labelEn };
}

export const FEATURES: readonly FeatureDef[] = [
  def('prayerBar', 'solat', true, true, { showImsak: true, showSyuruk: true, timeFormat: '12h' }, 'Bar waktu solat', 'Prayer times bar'),
  def('clock', 'solat', true, true, { showSeconds: false }, 'Jam', 'Clock'),
  def('prayerSequenceSafety', 'solat', true, true, {}, 'Perlindungan urutan solat', 'Prayer sequence safety'),
  def('zone', 'solat', true, true, { zone: 'SGR01', autoFetch: true }, 'Zon waktu solat', 'Prayer time zone'),
  def('location', 'solat', true, true,
    { country: 'MY', timezone: 'Asia/Kuala_Lumpur', latitude: null, longitude: null, city: '' },
    'Lokasi surau', 'Surau location'),
  def('prayerCalc', 'solat', false, true,
    {
      method: 'auto',
      madhab: 'auto',
      highLatitude: 'auto',
      adjustMinutes: { imsak: 0, subuh: 0, syuruk: 0, zohor: 0, asar: 0, maghrib: 0, isyak: 0 },
      imsakMinutes: 10,
    },
    'Kiraan setempat', 'Local calculation'),
  def('prayerSources', 'solat', true, true,
    { sourceOrder: ['official', 'calc', 'file'], crossCheck: true },
    'Sumber waktu solat', 'Prayer time sources'),
  def('azanCountdown', 'solat', false, true,
    { minutesBefore: { subuh: 10, zohor: 10, asar: 10, maghrib: 10, isyak: 10 }, fullScreen: true, beep: true },
    'Kiraan detik azan', 'Azan countdown'),
  def('masukWaktu', 'solat', false, true, { screenSeconds: 60, beep: true }, 'Skrin masuk waktu', 'Prayer time entered screen'),
  def('iqamahCountdown', 'solat', false, true,
    { minutes: week({ subuh: 12, zohor: 10, asar: 10, maghrib: 10, isyak: 10 }), endWarningSeconds: 30, beep: true },
    'Kiraan detik iqamah', 'Iqamah countdown'),
  def('solatScreen', 'solat', false, true,
    { minutes: week({ subuh: 15, zohor: 15, asar: 15, maghrib: 15, isyak: 15 }), message: 'Sila senyapkan telefon bimbit' },
    'Skrin sedang solat', 'Prayer in progress screen'),
  def('jumaat', 'solat', false, true, { khutbahMinutes: 20, iqamahMinutes: 7, solatMinutes: 15 }, 'Solat Jumaat', 'Friday prayer'),
  def('tarawih', 'solat', false, true, { hijriMonth: 9, gapMinutes: 10, minutes: 45 }, 'Solat tarawih', 'Tarawih prayer'),
  def('syurukWarning', 'solat', false, true, { minutesBefore: 5, beep: false }, 'Amaran syuruk', 'Sunrise warning'),
  def('imsakBeep', 'solat', false, false, {}, 'Bunyi imsak', 'Imsak beep'),
  def('isyraq', 'solat', false, true, { minutesAfterSyuruk: 15, durationMinutes: 5 }, 'Waktu isyraq', 'Isyraq time'),
  def('dataSources', 'lanjutan', true, true,
    {
      esolat: { name: 'e-Solat JAKIM', url: 'https://www.e-solat.gov.my/index.php?r=esolatApi/takwimsolat' },
      esolatZones: { name: 'e-Solat JAKIM (senarai zon)', url: 'https://www.e-solat.gov.my/index.php?siteId=24&pageId=24' },
      nominatim: { name: 'OpenStreetMap Nominatim', url: 'https://nominatim.openstreetmap.org/search' },
      quranText: { name: 'QuranEnc', url: 'https://quranenc.com/api/v1' },
      quranAudio: { name: 'EveryAyah', url: 'https://everyayah.com/data' },
      hadeethenc: { name: 'HadeethEnc', url: 'https://hadeethenc.com/api/v1' },
    },
    'Sumber data internet', 'Internet data sources'),
  def('firstAzanSubuh', 'solat', false, false, { minutesBefore: 10, audioFile: null }, 'Azan pertama Subuh', 'First Subuh azan'),

  def('surauInfo', 'skrin', true, true,
    { name: 'Surau', kind: 'surau', shortAddress: '', helpName: '', helpPhone: '', helpEmail: '', logo: '', showName: true },
    'Maklumat surau', 'Surau details'),
  def('hijriDate', 'skrin', false, true, { adjustDays: 0, switchAt: 'maghrib' }, 'Tarikh Hijrah', 'Hijri date'),
  def('backgrounds', 'skrin', false, true, { images: ['default-1', 'default-2'], rotate: 'daily' }, 'Latar belakang', 'Backgrounds'),
  def('autoTone', 'skrin', false, true, { override: null }, 'Warna teks automatik', 'Automatic text tone'),
  def('language', 'skrin', false, true, { lang: 'ms' }, 'Bahasa', 'Language'),
  def('orientation', 'skrin', false, true, { mode: 'landscape' }, 'Orientasi skrin', 'Screen orientation'),
  def('kioskTemplate', 'skrin', false, true, { templateId: 'default' }, 'Templat paparan', 'Display template'),

  def('kuliahCard', 'kandungan', false, true, { durationSeconds: 15, order: 1, daysAhead: 7 }, 'Kad kuliah', 'Lecture card'),
  def('penceramahPhoto', 'kandungan', false, true, { shape: 'round' }, 'Gambar penceramah', 'Speaker photo'),
  def('kitabCover', 'kandungan', false, true, {}, 'Kulit kitab', 'Book cover'),
  def('pengumuman', 'kandungan', false, true, { durationSeconds: 15, order: 2, daysAhead: 7, maxItems: 5 }, 'Pengumuman', 'Announcements'),
  def('ticker', 'kandungan', false, true, { speed: 'normal' }, 'Teks bergerak', 'Ticker'),
  def('posters', 'kandungan', false, true, { durationSeconds: 15, order: 3 }, 'Poster', 'Posters'),
  def('programKhas', 'kandungan', false, true, { durationSeconds: 15, order: 4, daysAhead: 7, hideAfterMinutes: 5 }, 'Program khas', 'Special programmes'),
  def('takwim', 'kandungan', false, true, { durationSeconds: 15, order: 5, count: 3 }, 'Takwim', 'Calendar'),
  def('hadis', 'kandungan', false, true,
    {
      durationSeconds: 20, order: 6,
      source: 'both',
      mix: 'list',
      changeEvery: 'day',
      perDay: 3,
      showArabic: true, showMalay: true, showAttribution: true, showGrade: true,
      fontSize: 'auto',
      allowedGrades: { sahih: true, hasan: true, sahih_lighairihi: false, hasan_lighairihi: false },
    },
    'Hadis', 'Hadith'),
  def('worldTimes', 'kandungan', false, true, { durationSeconds: 15, order: 7 }, 'Waktu dunia', 'World times'),
  def('tugasan', 'kandungan', false, true, { durationSeconds: 15, order: 8, daysAhead: 14 }, 'Tugasan', 'Duty roster'),

  def('ayatCard', 'quran', false, true,
    { durationSeconds: 20, order: 9, pick: 'daily', surah: 2, ayatFrom: 255, ayatTo: 255, showTranslation: true, textSize: 'm' },
    'Kad ayat', 'Verse card'),
  def('zikirSelepasSolat', 'quran', false, true, { durationSeconds: 20, minutesAfterSolat: 10 }, 'Zikir selepas solat', 'Post-prayer zikir'),
  def('quranReader', 'quran', false, true, {}, 'Pembaca Al-Quran', 'Quran reader'),
  def('tilawah', 'quran', false, false, { reciter: 'Husary_64kbps', volume: 60, cacheMaxMb: 300 }, 'Tilawah', 'Recitation'),

  def('beeps', 'audio', false, true, { volume: 70 }, 'Bunyi amaran', 'Beeps'),

  def('liveOnKiosk', 'live', false, true,
    { audio: false, volume: 50, showStrip: true, fit: 'cover' },
    'Siaran langsung di skrin', 'Live on kiosk'),
  def('liveYoutube', 'live', false, true,
    {
      privacy: 'unlisted',
      relayFrom: 'box',
      relayVideo: 'copy',
      titleTemplate: '{label}: {penceramah}',
      descriptionTemplate: '{topic}\nKitab: {kitab}\n{surau}, {date}',
      maxBitrateKbps: 2500,
    },
    'Siaran langsung YouTube', 'Live on YouTube'),
  def('recording', 'live', false, true, { segmentMinutes: 15, keepOnDevice: true }, 'Rakaman', 'Recording'),

  def('finance', 'kewangan', false, false,
    { penceramahFundId: '', bigAmountSen: 2000000, startedOn: '' },
    'Kewangan', 'Finance'),
  def('tabungCard', 'kewangan', false, false,
    {
      durationSeconds: 15, order: 10, figure: 'balance', highlightSeconds: 20, showTarget: true, qrAssetId: '',
      manualTitle: 'Tabung Surau',
      row1Label: '', row1Sen: 0, row2Label: '', row2Sen: 0, row3Label: '', row3Sen: 0,
    },
    'Kad tabung', 'Donation fund card'),

  def('calendarFeed', 'jemaah', false, false, {}, 'Suapan kalendar', 'Calendar feed'),
  def('jemaahPage', 'jemaah', false, false, {}, 'Laman jemaah', 'Congregation page'),

  def('cloudSync', 'lanjutan', false, true, { dirtyCheckSeconds: 120, cloudUrl: '' }, 'Penyelarasan awan', 'Cloud sync'),
  def('youtubeCatchUp', 'awan', false, true,
    { wifiOnly: true, joinSegments: true, replaceGappyLive: 'ask' },
    'Muat naik susulan YouTube', 'YouTube catch-up upload'),
  def('recordingCleanup', 'awan', false, true, { keepDays: 1 }, 'Pembersihan rakaman', 'Recording clean-up'),

  def('appLock', 'keselamatan', false, false, {}, 'Kunci aplikasi', 'App lock'),

  def('system', 'lanjutan', true, true,
    { noVideoSeconds: 12, cloudWakeSeconds: 20, syncHistoryDays: 180, suspendedAt: null },
    'Sistem', 'System'),
];
