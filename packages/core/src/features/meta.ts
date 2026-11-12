/**
 * Presentation metadata for the settings pages: which widget each field uses, its steps and choices, which
 * fields only the Pentadbir MAXCOM may change (`scope: 'system'`), and one sentence per feature with search
 * keywords. The rules themselves stay in settings.ts; this file never decides what is valid.
 */

import { KIOSK_TEMPLATE_IDS } from './registry.ts';
import type { FeatureKey } from './registry.ts';

export type FieldUi =
  | 'switch' | 'stepper' | 'slider' | 'chips' | 'segment' | 'dropdown' | 'hijriMonth' | 'surah'
  | 'ayatRange' | 'reciter' | 'colour' | 'audioAsset' | 'template' | 'presetText' | 'phone' | 'email'
  | 'url' | 'zone' | 'text';

export interface FieldMeta {
  ui?: FieldUi;
  step?: number;
  min?: number;
  max?: number;
  choices?: readonly (number | string)[];
  disabledChoices?: readonly string[];
  presets?: readonly string[];
  unit?: 'saat' | 'minit' | 'hari' | '%' | 'kbps' | 'MB';
  /** Only a holder of `system:write` may change this field. */
  scope?: 'system';
  testable?: boolean;
  readOnly?: boolean;
  maxLen?: number;
}

type FM = Record<string, FieldMeta>;

const CARD_DURATION: FM = { durationSeconds: { ui: 'slider', min: 0, max: 600, step: 5, unit: 'saat' } };

/** Keyed by feature, then by the leaf path (dot-joined for nested values). Week tables and `minutesBefore` rows keep their grid widgets. */
export const FIELD_META: Partial<Record<FeatureKey, FM>> = {
  liveYoutube: {
    relayFrom: { ui: 'segment', choices: ['box', 'phone'], disabledChoices: ['phone'] },
    relayVideo: { ui: 'segment', choices: ['copy', 'reencode'], scope: 'system' },
    maxBitrateKbps: { ui: 'slider', min: 500, max: 6000, step: 500, unit: 'kbps', scope: 'system' },
    titleTemplate: { ui: 'template', maxLen: 100 },
    descriptionTemplate: { ui: 'template', maxLen: 500 },
  },
  tilawah: {
    reciter: { ui: 'reciter', testable: true },
    volume: { ui: 'slider', min: 0, max: 100, step: 5, unit: '%' },
    cacheMaxMb: { ui: 'chips', choices: [100, 300, 500, 1000], unit: 'MB', scope: 'system' },
  },
  firstAzanSubuh: {
    minutesBefore: { ui: 'chips', choices: [5, 10, 15, 20, 30], unit: 'minit' },
    audioFile: { ui: 'audioAsset' },
  },
  autoTone: { override: { ui: 'colour' } },
  kioskTemplate: { templateId: { ui: 'dropdown', choices: KIOSK_TEMPLATE_IDS } },
  solatScreen: {
    message: {
      ui: 'presetText',
      maxLen: 100,
      presets: [
        'Sila senyapkan telefon bimbit',
        'Solat sedang berlangsung',
        'Sila luruskan dan rapatkan saf',
        'Sila tutup telefon bimbit anda',
      ],
    },
  },
  tarawih: {
    hijriMonth: { ui: 'hijriMonth' },
    gapMinutes: { ui: 'chips', choices: [5, 10, 15, 20], unit: 'minit' },
    minutes: { ui: 'slider', min: 0, max: 120, step: 5, unit: 'minit' },
  },
  ayatCard: {
    ...CARD_DURATION,
    pick: { ui: 'segment', choices: ['daily', 'random', 'manual'] },
    surah: { ui: 'surah' },
    ayatFrom: { ui: 'ayatRange' },
    ayatTo: { ui: 'ayatRange' },
    textSize: { ui: 'segment', choices: ['s', 'm', 'l'] },
  },
  kuliahCard: CARD_DURATION,
  tabungCard: {
    ...CARD_DURATION,
    figure: { ui: 'segment', choices: ['balance', 'month', 'lastEntry'] },
    highlightSeconds: { ui: 'slider', min: 0, max: 120, step: 5, unit: 'saat' },
    qrAssetId: { ui: 'text' },
  },
  pengumuman: CARD_DURATION,
  posters: CARD_DURATION,
  programKhas: CARD_DURATION,
  takwim: CARD_DURATION,
  hadis: CARD_DURATION,
  worldTimes: CARD_DURATION,
  tugasan: CARD_DURATION,
  zikirSelepasSolat: CARD_DURATION,
  zone: { zone: { ui: 'zone' } },
  recording: { segmentMinutes: { ui: 'chips', choices: [5, 10, 15, 30, 60], unit: 'minit' } },
  surauInfo: { helpPhone: { ui: 'phone' }, helpEmail: { ui: 'email' } },
  dataSources: {
    'esolat.url': { ui: 'url', testable: true, scope: 'system' },
    'esolatZones.url': { ui: 'url', scope: 'system' },
    'nominatim.url': { ui: 'url', scope: 'system' },
    'quranText.url': { ui: 'url', testable: true, scope: 'system' },
    'quranAudio.url': { ui: 'url', testable: true, scope: 'system' },
  },
  cloudSync: {
    dirtyCheckSeconds: { ui: 'chips', choices: [60, 120, 300, 600, 900], unit: 'saat', scope: 'system' },
    cloudUrl: { ui: 'url', readOnly: true, scope: 'system' },
  },
  system: {
    noVideoSeconds: { ui: 'slider', min: 5, max: 60, step: 1, unit: 'saat' },
    cloudWakeSeconds: { ui: 'slider', min: 10, max: 60, step: 5, unit: 'saat' },
    syncHistoryDays: { ui: 'chips', choices: [180, 365], unit: 'hari' },
  },
  recordingCleanup: { keepDays: { ui: 'chips', choices: [0, 1, 3, 7, 30], unit: 'hari' } },
  youtubeCatchUp: { replaceGappyLive: { ui: 'segment', choices: ['ask', 'never', 'always'] } },
  beeps: { volume: { ui: 'slider', min: 0, max: 100, step: 5, unit: '%' } },
  liveOnKiosk: { volume: { ui: 'slider', min: 0, max: 100, step: 5, unit: '%' } },
};

export function fieldMeta(feature: FeatureKey, path: string): FieldMeta | undefined {
  return FIELD_META[feature]?.[path];
}

/** Features whose every value is a MAXCOM system value. */
export const SYSTEM_FEATURES: readonly FeatureKey[] = ['dataSources', 'cloudSync', 'system'];

export function isSystemField(feature: FeatureKey, path: string): boolean {
  if (SYSTEM_FEATURES.includes(feature)) return true;
  return FIELD_META[feature]?.[path]?.scope === 'system';
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Dot paths of every leaf in a patch (a nested object descends; arrays and scalars are leaves). */
function patchPaths(patch: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const p = prefix === '' ? k : `${prefix}.${k}`;
    if (isObj(v)) out.push(...patchPaths(v, p));
    else out.push(p);
  }
  return out;
}

/** True when the patch touches a system feature or any field marked `scope: 'system'`: it then needs `system:write`. */
export function patchNeedsSystemWrite(feature: FeatureKey, patch: unknown): boolean {
  if (SYSTEM_FEATURES.includes(feature)) return true;
  if (!isObj(patch)) return false;
  const table = FIELD_META[feature];
  if (!table) return false;
  return patchPaths(patch).some((p) => table[p]?.scope === 'system');
}

/** The Lanjutan rows that open a surau feature's page at its system card. */
export const LANJUTAN_ROWS: readonly { feature: FeatureKey; fields: readonly string[]; labelMs: string; labelEn: string }[] = [
  { feature: 'liveYoutube', fields: ['relayVideo', 'maxBitrateKbps'], labelMs: 'Penyiaran YouTube', labelEn: 'YouTube relay' },
  { feature: 'tilawah', fields: ['cacheMaxMb'], labelMs: 'Ruang simpanan tilawah', labelEn: 'Recitation storage' },
];

/** The features that take part in the TV card rotation (they have an `order` setting). */
export const ORDERED_FEATURES: readonly FeatureKey[] = [
  'kuliahCard', 'pengumuman', 'posters', 'programKhas', 'takwim', 'hadis', 'worldTimes', 'tugasan', 'ayatCard', 'tabungCard',
];

export interface FeatureDesc {
  ms: string;
  en: string;
  keywords: readonly string[];
}

const d = (ms: string, en: string, ...keywords: string[]): FeatureDesc => ({ ms, en, keywords });

export const FEATURE_DESC: Record<FeatureKey, FeatureDesc> = {
  prayerBar: d('Waktu solat sehari di bahagian bawah skrin TV.', 'The day\'s prayer times along the bottom of the TV screen.'),
  clock: d('Jam besar di penjuru skrin TV.', 'A large clock in the corner of the TV screen.'),
  prayerSequenceSafety: d('Skrin azan, iqamah dan solat sentiasa ikut urutan yang betul.', 'The azan, iqamah and prayer screens always follow the right order.'),
  zone: d('Zon JAKIM untuk waktu solat: SGR01 Gombak, Petaling dan sekitarnya.', 'The JAKIM zone for prayer times, for example SGR01 Gombak and Petaling.', 'jakim', 'e-solat', 'lokasi'),
  location: d('Negara, zon waktu dan koordinat surau; waktu solat di luar Malaysia dikira daripadanya.', 'The country, time zone and coordinates of the surau; prayer times outside Malaysia are calculated from them.', 'lokasi', 'negara', 'koordinat', 'latitud'),
  prayerCalc: d('Kaedah kiraan waktu solat dari koordinat surau, dan laras minit bagi setiap waktu.', 'The method that calculates prayer times from the surau coordinates, and a minute adjustment for each prayer.', 'kiraan', 'kaedah', 'mazhab', 'imsak'),
  prayerSources: d('Susunan sumber waktu solat: rasmi, kiraan setempat dan fail surau.', 'The order of the prayer time sources: official, local calculation and the surau file.', 'sumber', 'jadual', 'fail'),
  azanCountdown: d('Kiraan detik di skrin sebelum masuk waktu.', 'A countdown on screen before the prayer time enters.', 'azan'),
  masukWaktu: d('Skrin "Telah masuk waktu" ketika azan berkumandang.', 'The "Prayer time has entered" screen while the azan is called.', 'azan'),
  iqamahCountdown: d('Kiraan detik dari azan hingga iqamah, ikut hari dan waktu.', 'A countdown from azan to iqamah, by day and prayer.', 'iqamah'),
  solatScreen: d('Skrin tenang dengan mesej semasa solat berjemaah.', 'A calm screen with a message during congregational prayer.', 'telefon bimbit'),
  jumaat: d('Tempoh khutbah, iqamah dan solat Jumaat.', 'Timings for the Friday sermon, iqamah and prayer.', 'khutbah'),
  tarawih: d('Jadual tarawih pada bulan yang dipilih.', 'The tarawih schedule in the chosen month.', 'ramadan'),
  syurukWarning: d('Amaran sebelum syuruk, tanda waktu Subuh hampir tamat.', 'A warning before sunrise, when Subuh time is about to end.', 'syuruk'),
  imsakBeep: d('Bunyi pendek pada waktu imsak.', 'A short beep at imsak time.', 'puasa'),
  isyraq: d('Peringatan solat sunat isyraq selepas syuruk.', 'A reminder of the isyraq prayer after sunrise.', 'syuruk'),
  dataSources: d('Alamat e-Solat, QuranEnc dan EveryAyah.', 'The addresses of e-Solat, QuranEnc and EveryAyah.', 'jakim', 'url'),
  firstAzanSubuh: d('Azan awal sebelum Subuh, dimainkan dari fail audio.', 'An early azan before Subuh, played from an audio file.', 'azan'),
  surauInfo: d('Nama, logo dan orang untuk dihubungi.', 'The name, logo and contact person.', 'logo', 'nama'),
  hijriDate: d('Tarikh Hijrah dan bila ia bertukar.', 'The Hijri date and when it changes.', 'hijrah'),
  backgrounds: d('Gambar latar skrin TV dan kekerapan bertukar.', 'The TV background pictures and how often they change.', 'gambar'),
  autoTone: d('Warna teks ikut gambar latar, atau pilih sendiri.', 'Text colour follows the background, or choose your own.', 'warna'),
  language: d('Bahasa paparan skrin TV.', 'The display language of the TV screen.', 'bahasa'),
  orientation: d('Skrin TV mendatar atau menegak.', 'The TV screen landscape or portrait.', 'mendatar', 'menegak'),
  kioskTemplate: d(
    'Templat menukar seluruh rupa skrin TV. Gambar latar dan warna teks automatik hanya digunakan oleh templat Satu Warna (Lalai).',
    'The template changes the whole look of the TV screen. Background pictures and the automatic text colour apply to Single Colour - Default only.',
    'templat', 'tema', 'rupa', 'warna',
  ),
  kuliahCard: d('Kuliah akan datang di skrin TV.', 'Upcoming lectures on the TV screen.', 'kuliah'),
  penceramahPhoto: d('Bentuk gambar penceramah pada kad kuliah.', 'The shape of the speaker photo on the lecture card.', 'penceramah'),
  kitabCover: d('Papar kulit kitab pada kad kuliah.', 'Show the book cover on the lecture card.', 'kitab'),
  pengumuman: d('Pengumuman surau di skrin TV.', 'Surau announcements on the TV screen.'),
  ticker: d('Teks bergerak di bahagian bawah skrin.', 'Scrolling text along the bottom of the screen.'),
  posters: d('Poster bergilir di skrin TV.', 'Posters shown in turn on the TV screen.'),
  programKhas: d('Program khas yang akan datang.', 'Upcoming special programmes.'),
  takwim: d('Tarikh penting Islam yang akan datang.', 'Upcoming important Islamic dates.', 'kalendar'),
  hadis: d('Satu hadis setiap hari, rawak atau pilih sendiri.', 'One hadith a day, random or chosen by you.'),
  worldTimes: d('Waktu di Makkah, Madinah dan bandar lain.', 'The time in Makkah, Madinah and other cities.', 'makkah'),
  tugasan: d('Jadual bertugas imam, bilal dan AJK.', 'The duty roster for imam, bilal and committee.', 'imam', 'bilal'),
  ayatCard: d('Ayat Al-Quran pilihan dengan terjemahan.', 'A chosen Quran verse with translation.', 'quran'),
  zikirSelepasSolat: d('Zikir di skrin selepas setiap solat.', 'Zikir on screen after each prayer.'),
  quranReader: d('Baca mushaf penuh di aplikasi dan skrin TV.', 'Read the full mushaf in the app and on the TV screen.', 'mushaf'),
  tilawah: d('Bacaan Al-Quran oleh qari pilihan.', 'Quran recitation by a chosen reciter.', 'qari'),
  beeps: d('Kuat bunyi amaran sebelum azan dan iqamah.', 'The volume of the warning beeps before azan and iqamah.', 'azan', 'iqamah'),
  liveOnKiosk: d('Kuliah yang sedang disiarkan, terus di skrin TV.', 'The lecture being broadcast, shown directly on the TV screen.', 'siaran'),
  liveYoutube: d('Siarkan kuliah ke saluran YouTube D\'Waqaf.', 'Broadcast the lecture to the D\'Waqaf YouTube channel.', 'youtube'),
  recording: d('Rakam kuliah ke fail di peranti.', 'Record the lecture to files on the device.', 'rakaman'),
  finance: d('Rekod kutipan dan perbelanjaan surau.', 'Record the surau\'s collections and spending.', 'derma'),
  tabungCard: d('Baki tabung surau di skrin TV.', 'The surau fund balance on the TV screen.', 'derma'),
  calendarFeed: d('Jadual kuliah dalam kalendar telefon jemaah.', 'The lecture schedule in the congregation\'s phone calendars.', 'kalendar'),
  jemaahPage: d('Laman web ringkas untuk jemaah.', 'A simple web page for the congregation.'),
  cloudSync: d('Alamat awan MAXCOM dan selang semak perubahan.', 'The MAXCOM cloud address and how often changes are checked.', 'awan'),
  youtubeCatchUp: d('Muat naik rakaman bila siaran langsung terputus.', 'Upload the recording when a live broadcast was cut.', 'youtube'),
  recordingCleanup: d('Padam rakaman di peranti selepas YouTube mengesahkannya.', 'Delete recordings on the device once YouTube has confirmed them.', 'rakaman'),
  appLock: d('PIN atau cap jari setiap kali MAXCOM dibuka.', 'A PIN or fingerprint every time MAXCOM is opened.', 'pin', 'cap jari'),
  system: d('Amaran tiada video, tunggu awan bangun, sejarah penyelarasan.', 'The no-video warning, how long to wait for the cloud, and sync history.'),
};
