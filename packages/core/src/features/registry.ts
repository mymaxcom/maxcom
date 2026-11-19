/** Feature registry: every switchable feature, its group, lock state, defaults and labels. */

import type { ImageRef } from '../image.ts';
import type { ThemeStyles } from '../theme/style.ts';
import type { InstalledPacks } from '../theme/packs.ts';
import type { AddedAudioId } from '../live/sources.ts';

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
  | 'surauInfo' | 'hijriDate' | 'backgrounds' | 'autoTone' | 'language' | 'orientation' | 'kioskTemplate' | 'themeStyle'
  | 'kuliahCard' | 'penceramahPhoto' | 'kitabCover' | 'pengumuman' | 'ticker' | 'posters' | 'videos'
  | 'programKhas' | 'takwim' | 'hadis' | 'worldTimes' | 'tugasan'
  | 'ayatCard' | 'zikirSelepasSolat' | 'quranReader' | 'tilawah'
  | 'beeps'
  | 'liveOnKiosk' | 'liveYoutube' | 'recording' | 'liveCamera'
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
  labelAr: string;
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
/** The TV presentation templates; 'default' is the original single-colour look (autoTone applies to it only; backgrounds apply to every theme). */
export const KIOSK_TEMPLATE_IDS = ['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic'] as const;
export type KioskTemplateId = (typeof KIOSK_TEMPLATE_IDS)[number];
/** `templateId` is a built-in id or the name of an uploaded theme. */
export interface KioskTemplateSettings extends FeatureSettings { templateId: string }
/** Per-theme menu values and installed pack records; each map is one whole value. */
export interface ThemeStyleSettings extends FeatureSettings { styles: ThemeStyles; packs: InstalledPacks }

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
  themeStyle: ThemeStyleSettings;
  surauInfo: SurauInfoSettings;
  dataSources: DataSourcesSettings;
  location: LocationSettings;
  prayerCalc: PrayerCalcSettings;
  prayerSources: PrayerSourcesSettings;
  liveOnKiosk: LiveOnKioskSettings;
  liveYoutube: LiveYoutubeSettings;
  system: SystemSettings;
  recording: RecordingSettings;
  liveCamera: LiveCameraSettings;
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
  /**
   * The surau's choice for the NEXT live: broadcast to YouTube or not. One setting for the whole surau (every admin with
   * live:control, every device), synced like any other field; a block (signed out, no internet) never changes it.
   */
  nextLiveOn: boolean;
}
/** MAXCOM system values (Lanjutan; Pentadbir MAXCOM only). suspendedAt is the reversible stop flag. */
export interface SystemSettings extends FeatureSettings {
  noVideoSeconds: number;
  cloudWakeSeconds: number;
  syncHistoryDays: 180 | 365;
  suspendedAt: string | null;
}
export interface RecordingSettings extends FeatureSettings { segmentMinutes: number; keepOnDevice: boolean }
/**
 * The external camera (plan 4.2). The address and login are NOT here: they are one sealed record on the box. `avOffsetMs`
 * is the fallback for a camera with no audio track only (0..2000 ms, step 50, one value per added source).
 */
export interface LiveCameraSettings extends FeatureSettings {
  name: string;
  transport: 'auto' | 'tcp' | 'udp';
  avOffsetMs: Record<AddedAudioId, number>;
}
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
  /** The home-screen icon title (iPad/Android), at most 12 characters: '' for the automatic short name of `name`. */
  shortName: string;
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
  defaults: Record<string, unknown>, labelMs: string, labelEn: string, labelAr: string,
): FeatureDef {
  return { key, group, locked, defaultEnabled, defaults, labelMs, labelEn, labelAr };
}

export const FEATURES: readonly FeatureDef[] = [
  def('prayerBar', 'solat', true, true, { showImsak: true, showSyuruk: true, timeFormat: '12h' }, 'Bar waktu solat', 'Prayer times bar', 'شريط مواقيت الصلاة'),
  def('clock', 'solat', true, true, { showSeconds: false }, 'Jam', 'Clock', 'الساعة'),
  def('prayerSequenceSafety', 'solat', true, true, {}, 'Perlindungan urutan solat', 'Prayer sequence safety', 'حماية ترتيب الصلوات'),
  def('zone', 'solat', true, true, { zone: 'SGR01', autoFetch: true }, 'Zon waktu solat', 'Prayer time zone', 'منطقة مواقيت الصلاة'),
  def('location', 'solat', true, true,
    { country: 'MY', timezone: 'Asia/Kuala_Lumpur', latitude: null, longitude: null, city: '' },
    'Lokasi surau', 'Surau location', 'موقع المصلى'),
  def('prayerCalc', 'solat', true, true,
    {
      method: 'auto',
      madhab: 'auto',
      highLatitude: 'auto',
      adjustMinutes: { imsak: 0, subuh: 0, syuruk: 0, zohor: 0, asar: 0, maghrib: 0, isyak: 0 },
      imsakMinutes: 10,
    },
    'Kiraan setempat', 'Local calculation', 'الحساب المحلي'),
  def('prayerSources', 'solat', true, true,
    { sourceOrder: ['official', 'calc', 'file'], crossCheck: true },
    'Sumber waktu solat', 'Prayer time sources', 'مصادر مواقيت الصلاة'),
  def('azanCountdown', 'solat', false, true,
    { minutesBefore: { subuh: 10, zohor: 10, asar: 10, maghrib: 10, isyak: 10 }, fullScreen: true, beep: true },
    'Kiraan detik azan', 'Azan countdown', 'العد التنازلي للأذان'),
  def('masukWaktu', 'solat', false, true, { screenSeconds: 60, beep: true }, 'Skrin masuk waktu', 'Prayer time entered screen', 'شاشة دخول الوقت'),
  def('iqamahCountdown', 'solat', false, true,
    { minutes: week({ subuh: 12, zohor: 10, asar: 10, maghrib: 10, isyak: 10 }), endWarningSeconds: 30, beep: true },
    'Kiraan detik iqamah', 'Iqamah countdown', 'العد التنازلي للإقامة'),
  def('solatScreen', 'solat', false, true,
    { minutes: week({ subuh: 15, zohor: 15, asar: 15, maghrib: 15, isyak: 15 }), message: '' },
    'Skrin sedang solat', 'Prayer in progress screen', 'شاشة الصلاة الجارية'),
  def('jumaat', 'solat', false, true, { khutbahMinutes: 20, iqamahMinutes: 7, solatMinutes: 15 }, 'Solat Jumaat', 'Friday prayer', 'صلاة الجمعة'),
  def('tarawih', 'solat', false, true, { hijriMonth: 9, gapMinutes: 10, minutes: 45 }, 'Solat tarawih', 'Tarawih prayer', 'صلاة التراويح'),
  def('syurukWarning', 'solat', false, true, { minutesBefore: 5, beep: false }, 'Amaran syuruk', 'Sunrise warning', 'تنبيه الشروق'),
  def('imsakBeep', 'solat', false, false, {}, 'Bunyi imsak', 'Imsak beep', 'صوت الإمساك'),
  def('isyraq', 'solat', false, true, { minutesAfterSyuruk: 15, durationMinutes: 5 }, 'Waktu isyraq', 'Isyraq time', 'وقت الإشراق'),
  def('dataSources', 'lanjutan', true, true,
    {
      esolat: { name: 'e-Solat JAKIM', url: 'https://www.e-solat.gov.my/index.php?r=esolatApi/takwimsolat' },
      esolatZones: { name: 'e-Solat JAKIM (senarai zon)', url: 'https://www.e-solat.gov.my/index.php?siteId=24&pageId=24' },
      nominatim: { name: 'OpenStreetMap Nominatim', url: 'https://nominatim.openstreetmap.org/search' },
      quranText: { name: 'QuranEnc', url: 'https://quranenc.com/api/v1' },
      quranAudio: { name: 'EveryAyah', url: 'https://everyayah.com/data' },
      hadeethenc: { name: 'HadeethEnc', url: 'https://hadeethenc.com/api/v1' },
    },
    'Sumber data internet', 'Internet data sources', 'مصادر بيانات الإنترنت'),
  def('firstAzanSubuh', 'solat', false, false, { minutesBefore: 10, audioFile: null }, 'Azan pertama Subuh', 'First Subuh azan', 'الأذان الأول للفجر'),

  // First in Skrin: the first TV setting in the app's Konfigurasi list (operator 2026-11-20).
  def('language', 'skrin', true, true, { lang: 'auto' }, 'Bahasa skrin TV', 'TV screen language', 'لغة شاشة التلفاز'),
  def('surauInfo', 'skrin', true, true,
    { name: 'Surau', shortName: '', kind: 'surau', shortAddress: '', helpName: '', helpPhone: '', helpEmail: '', logo: '', showName: true },
    'Maklumat surau', 'Surau details', 'بيانات المصلى'),
  def('hijriDate', 'skrin', false, true, { adjustDays: 0, switchAt: 'maghrib' }, 'Tarikh Hijrah', 'Hijri date', 'التاريخ الهجري'),
  def('backgrounds', 'skrin', false, true, { images: ['default-1', 'default-2'], rotate: 'daily' }, 'Latar belakang', 'Backgrounds', 'الخلفيات'),
  def('autoTone', 'skrin', false, true, { override: null }, 'Warna teks automatik', 'Automatic text tone', 'لون النص التلقائي'),
  def('orientation', 'skrin', false, true, { mode: 'landscape' }, 'Orientasi skrin', 'Screen orientation', 'اتجاه الشاشة'),
  def('kioskTemplate', 'skrin', false, true, { templateId: 'default' }, 'Templat paparan', 'Display template', 'قالب العرض'),
  def('themeStyle', 'skrin', false, true, { styles: {}, packs: {} }, 'Gaya tema', 'Theme style', 'نمط القالب'),

  def('kuliahCard', 'kandungan', false, true, { durationSeconds: 15, order: 1, daysAhead: 7 }, 'Kad kuliah', 'Lecture card', 'بطاقة الدروس'),
  def('penceramahPhoto', 'kandungan', false, true, { shape: 'round' }, 'Gambar penceramah', 'Speaker photo', 'صورة المحاضر'),
  def('kitabCover', 'kandungan', false, true, {}, 'Kulit kitab', 'Book cover', 'غلاف الكتاب'),
  def('pengumuman', 'kandungan', false, true, { durationSeconds: 15, order: 2, daysAhead: 7, maxItems: 5 }, 'Pengumuman', 'Announcements', 'الإعلانات'),
  def('ticker', 'kandungan', false, true, { speed: 'normal' }, 'Teks bergerak', 'Ticker', 'النص المتحرك'),
  def('posters', 'kandungan', false, true, { durationSeconds: 15, order: 3 }, 'Poster', 'Posters', 'الملصقات'),
  // Video: each video plays to its own end (slot = video length, at most 10 min); `durationSeconds` is not used.
  def('videos', 'kandungan', false, true, { order: 11 }, 'Video', 'Video', 'الفيديو'),
  def('programKhas', 'kandungan', false, true, { durationSeconds: 15, order: 4, daysAhead: 7, hideAfterMinutes: 5 }, 'Program khas', 'Special programmes', 'البرامج الخاصة'),
  def('takwim', 'kandungan', false, true, { durationSeconds: 15, order: 5, count: 3 }, 'Takwim', 'Calendar', 'التقويم'),
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
    'Hadis', 'Hadith', 'الحديث'),
  def('worldTimes', 'kandungan', false, true, { durationSeconds: 15, order: 7 }, 'Waktu dunia', 'World times', 'توقيت العالم'),
  def('tugasan', 'kandungan', false, true, { durationSeconds: 15, order: 8, daysAhead: 14 }, 'Tugasan', 'Duty roster', 'جدول المناوبات'),

  def('ayatCard', 'quran', false, true,
    { durationSeconds: 20, order: 9, pick: 'daily', surah: 2, ayatFrom: 255, ayatTo: 255, showTranslation: true, textSize: 'm' },
    'Kad ayat', 'Verse card', 'بطاقة الآية'),
  def('zikirSelepasSolat', 'quran', false, true, { durationSeconds: 20, minutesAfterSolat: 10 }, 'Zikir selepas solat', 'Post-prayer zikir', 'أذكار بعد الصلاة'),
  def('quranReader', 'quran', false, true, {}, 'Pembaca Al-Quran', 'Quran reader', 'قارئ القرآن'),
  def('tilawah', 'quran', false, false, { reciter: 'Husary_64kbps', volume: 60, cacheMaxMb: 300 }, 'Tilawah', 'Recitation', 'التلاوة'),

  def('beeps', 'audio', false, true, { volume: 70 }, 'Bunyi amaran', 'Beeps', 'أصوات التنبيه'),

  def('liveOnKiosk', 'live', false, true,
    { audio: false, volume: 50, showStrip: true, fit: 'cover' },
    'Siaran langsung di skrin', 'Live on kiosk', 'البث المباشر على الشاشة'),
  def('liveYoutube', 'live', false, true,
    {
      privacy: 'unlisted',
      relayFrom: 'box',
      relayVideo: 'copy',
      titleTemplate: '{label}: {penceramah}',
      descriptionTemplate: '{topic}\nKitab: {kitab}\n{surau}, {date}',
      maxBitrateKbps: 2500,
      nextLiveOn: true,
    },
    'Siaran langsung YouTube', 'Live on YouTube', 'البث المباشر على YouTube'),
  def('recording', 'live', false, true, { segmentMinutes: 15, keepOnDevice: true }, 'Rakaman', 'Recording', 'التسجيل'),
  def('liveCamera', 'live', false, false,
    { name: 'Kamera luaran', transport: 'auto', avOffsetMs: { deviceMic: 0, boxInput: 0 } },
    'Kamera luaran', 'External camera', 'الكاميرا الخارجية'),

  def('finance', 'kewangan', false, false,
    { penceramahFundId: '', bigAmountSen: 2000000, startedOn: '' },
    'Kewangan', 'Finance', 'المالية'),
  def('tabungCard', 'kewangan', false, false,
    {
      durationSeconds: 15, order: 10, figure: 'balance', highlightSeconds: 20, showTarget: true, qrAssetId: '',
      featured: false,
      manualTitle: '',
      row1Label: '', row1Sen: 0, row2Label: '', row2Sen: 0, row3Label: '', row3Sen: 0,
    },
    'Kad tabung', 'Donation fund card', 'بطاقة صندوق التبرعات'),

  def('calendarFeed', 'jemaah', false, false, {}, 'Suapan kalendar', 'Calendar feed', 'خلاصة التقويم'),
  def('jemaahPage', 'jemaah', false, false, {}, 'Laman jemaah', 'Congregation page', 'صفحة المصلّين'),

  def('cloudSync', 'lanjutan', false, true, { dirtyCheckSeconds: 120, cloudUrl: '' }, 'Penyelarasan awan', 'Cloud sync', 'المزامنة مع السحابة'),
  def('youtubeCatchUp', 'awan', false, true,
    { wifiOnly: true, joinSegments: true, replaceGappyLive: 'ask' },
    'Muat naik susulan YouTube', 'YouTube catch-up upload', 'الرفع اللاحق إلى YouTube'),
  def('recordingCleanup', 'awan', false, true, { keepDays: 1 }, 'Pembersihan rakaman', 'Recording clean-up', 'تنظيف التسجيلات'),

  def('appLock', 'keselamatan', false, false, {}, 'Kunci aplikasi', 'App lock', 'قفل التطبيق'),

  def('system', 'lanjutan', true, true,
    { noVideoSeconds: 12, cloudWakeSeconds: 20, syncHistoryDays: 180, suspendedAt: null },
    'Sistem', 'System', 'النظام'),
];
