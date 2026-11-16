/**
 * Presentation metadata for the settings pages: which widget each field uses, its steps and choices, which
 * fields only the Pentadbir MAXCOM may change (`scope: 'system'`), and one sentence per feature with search
 * keywords. The rules themselves stay in settings.ts; this file never decides what is valid.
 */

import type { FeatureKey } from './registry.ts';

export type FieldUi =
  | 'switch' | 'stepper' | 'slider' | 'chips' | 'segment' | 'dropdown' | 'hijriMonth' | 'surah'
  | 'ayatRange' | 'reciter' | 'colour' | 'audioAsset' | 'template' | 'presetText' | 'phone' | 'email'
  | 'url' | 'zone' | 'text' | 'theme';

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
  /**
   * Not offered in Tetapan (the settings pages and search skip it). The value stays in the registry, so stored data is
   * still valid; nothing on the TV reads it. Used when another control owns the job (one setting, one place).
   */
  hidden?: boolean;
  /**
   * Shown dimmed and not editable, with a short note, while another setting has the given value (one setting, one
   * meaning: the other control makes this one irrelevant). Stored values are untouched.
   */
  disabledWhen?: {
    feature: FeatureKey;
    field: string;
    equals: boolean | number | string | null;
    noteMs: string;
    noteEn: string;
  };
}

type FM = Record<string, FieldMeta>;

/** The slider starts at 5 s: a stored 0 meant 15 s on the TV without saying so. */
const CARD_DURATION: FM = { durationSeconds: { ui: 'slider', min: 5, max: 600, step: 5, unit: 'saat' } };

/** Keyed by feature, then by the leaf path (dot-joined for nested values). Week tables and `minutesBefore` rows keep their grid widgets. */
export const FIELD_META: Partial<Record<FeatureKey, FM>> = {
  liveYoutube: {
    relayFrom: { ui: 'segment', choices: ['box', 'phone'], disabledChoices: ['phone'], hidden: true },
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
  // The accent colour has one control, Ubah suai "Warna aksen"; the old override is kept only so stored values stay valid.
  autoTone: { override: { ui: 'colour', hidden: true } },
  kioskTemplate: { templateId: { ui: 'theme' } },
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
  // `daysAhead` is not offered: a notice shows by its own from and to dates, nothing reads the window.
  pengumuman: { ...CARD_DURATION, daysAhead: { hidden: true } },
  posters: CARD_DURATION,
  // Same: a special programme shows by its own show-from and show-to dates.
  programKhas: { ...CARD_DURATION, daysAhead: { hidden: true } },
  // The card holds three rows at most (the TV caps it), so the choices stop at 3.
  takwim: { ...CARD_DURATION, count: { ui: 'chips', choices: [1, 2, 3] } },
  hadis: CARD_DURATION,
  worldTimes: CARD_DURATION,
  tugasan: CARD_DURATION,
  zikirSelepasSolat: CARD_DURATION,
  zone: { zone: { ui: 'zone' } },
  recording: {
    segmentMinutes: { ui: 'chips', choices: [5, 10, 15, 30, 60], unit: 'minit' },
    keepOnDevice: {
      disabledWhen: {
        feature: 'recordingCleanup', field: 'enabled', equals: false,
        noteMs: 'Tiada rakaman dipadam selagi Pembersihan rakaman dimatikan.',
        noteEn: 'No recording is deleted while Recording clean-up is off.',
      },
    },
  },
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
  recordingCleanup: {
    keepDays: {
      ui: 'chips', choices: [0, 1, 3, 7, 30], unit: 'hari',
      disabledWhen: {
        feature: 'recording', field: 'keepOnDevice', equals: false,
        noteMs: 'Tidak digunakan: rakaman di peranti dipadam sebaik YouTube mengesahkannya.',
        noteEn: 'Not used: the recording on the device is deleted as soon as YouTube confirms it.',
      },
    },
  },
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

/**
 * Features the Tetapan lists (phone app, web app, search) do not show: `themeStyle` has no generic page (the app edits
 * it in its own screen); `orientation`, `quranReader`, `calendarFeed` and `jemaahPage` are planned (Dirancang, major
 * changes later).
 * Their registry entries and stored values stay untouched, so they can come back by removing the key here.
 */
export const HIDDEN_FEATURES: readonly FeatureKey[] = ['themeStyle', 'orientation', 'quranReader', 'calendarFeed', 'jemaahPage'];

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
  prayerCalc: d(
    'Kaedah kiraan waktu solat dari koordinat surau, dan laras minit bagi setiap waktu. Kiraan setempat sentiasa menjadi sandaran bila jadual rasmi atau fail surau tiada.',
    'The method that calculates prayer times from the surau coordinates, and a minute adjustment for each prayer. Local calculation is always the fallback when the official table or the surau file has no time.',
    'kiraan', 'kaedah', 'mazhab', 'imsak',
  ),
  prayerSources: d('Susunan sumber waktu solat: rasmi, kiraan setempat dan fail surau.', 'The order of the prayer time sources: official, local calculation and the surau file.', 'sumber', 'jadual', 'fail'),
  azanCountdown: d('Kiraan detik di skrin sebelum masuk waktu.', 'A countdown on screen before the prayer time enters.', 'azan'),
  masukWaktu: d('Skrin "Telah masuk waktu" ketika azan berkumandang.', 'The "Prayer time has entered" screen while the azan is called.', 'azan'),
  iqamahCountdown: d('Kiraan detik dari azan hingga iqamah, ikut hari dan waktu.', 'A countdown from azan to iqamah, by day and prayer.', 'iqamah'),
  solatScreen: d(
    'Skrin tenang dengan mesej semasa solat berjemaah. Mesej yang sama juga dipaparkan di skrin tarawih.',
    'A calm screen with a message during congregational prayer. The same message also shows on the tarawih screen.',
    'telefon bimbit',
  ),
  jumaat: d('Tempoh khutbah, iqamah dan solat Jumaat.', 'Timings for the Friday sermon, iqamah and prayer.', 'khutbah'),
  tarawih: d('Jadual tarawih pada bulan yang dipilih.', 'The tarawih schedule in the chosen month.', 'ramadan'),
  syurukWarning: d('Amaran sebelum syuruk, tanda waktu Subuh hampir tamat.', 'A warning before sunrise, when Subuh time is about to end.', 'syuruk'),
  imsakBeep: d(
    'Bunyi pendek pada waktu imsak. Bunyi ini ikut suis dan kuat Bunyi amaran; jika bunyi kiraan detik azan jatuh pada minit yang sama, hanya satu bunyi berbunyi.',
    'A short beep at imsak time. It follows the Warning beeps switch and volume; when the azan countdown beep falls on the same minute, only one beep plays.',
    'puasa',
  ),
  isyraq: d('Peringatan solat sunat isyraq selepas syuruk.', 'A reminder of the isyraq prayer after sunrise.', 'syuruk'),
  dataSources: d('Alamat e-Solat, QuranEnc, EveryAyah, Nominatim dan HadeethEnc.', 'The addresses of e-Solat, QuranEnc, EveryAyah, Nominatim and HadeethEnc.', 'jakim', 'url'),
  firstAzanSubuh: d(
    'Azan awal sebelum Subuh, dimainkan dari fail audio. Dimainkan sekali sehari dan tidak diulang selepas skrin dimuat semula. Tilawah sebelum Subuh tamat apabila azan awal bermula.',
    'An early azan before Subuh, played from an audio file. It plays once a day and does not replay after a reload. A recitation before Subuh ends when it starts.',
    'azan',
  ),
  surauInfo: d('Nama, logo dan orang untuk dihubungi.', 'The name, logo and contact person.', 'logo', 'nama'),
  hijriDate: d('Tarikh Hijrah dan bila ia bertukar.', 'The Hijri date and when it changes.', 'hijrah'),
  backgrounds: d(
    'Gambar latar skrin TV dan kekerapan bertukar, untuk semua tema. Gambar asal MAXCOM hanya untuk tema Default. Di Ubah suai, Ikut tema bermaksud gambar di sini (atau gambar tema yang dimuat naik) digunakan; gambar sendiri bagi sesuatu skrin menggantikannya.',
    'The TV background pictures and how often they change, for every theme. The MAXCOM built-in pictures are for the Default theme only. In Ubah suai, Follow the theme means the pictures here (or the picture of an uploaded theme) are used; an own picture for a screen replaces them.',
    'gambar',
  ),
  autoTone: d(
    'Warna teks dan aksen ikut gambar latar, untuk tema Default. Warna teks atau aksen yang dipilih di Ubah suai mengatasinya.',
    'Text and accent colours follow the background picture, for the Default theme. A text or accent colour chosen in Ubah suai overrides it.',
    'warna',
  ),
  language: d('Bahasa paparan skrin TV.', 'The display language of the TV screen.', 'bahasa'),
  orientation: d('Skrin TV mendatar atau menegak.', 'The TV screen landscape or portrait.', 'mendatar', 'menegak'),
  kioskTemplate: d(
    'Tema menukar seluruh rupa skrin TV. Setiap skrin boleh diubah suai.',
    'The theme changes the whole look of the TV screen. Every screen can be customised.',
    'templat', 'tema', 'rupa', 'warna',
  ),
  themeStyle: d('Ubah suai rupa setiap skrin bagi tema.', 'Customise the look of each screen of a theme.', 'tema', 'ubah suai'),
  kuliahCard: d('Kuliah akan datang di skrin TV.', 'Upcoming lectures on the TV screen.', 'kuliah'),
  penceramahPhoto: d('Bentuk gambar penceramah pada kad kuliah.', 'The shape of the speaker photo on the lecture card.', 'penceramah'),
  kitabCover: d('Papar kulit kitab pada kad kuliah.', 'Show the book cover on the lecture card.', 'kitab'),
  pengumuman: d('Pengumuman surau di skrin TV.', 'Surau announcements on the TV screen.'),
  ticker: d('Teks bergerak di bahagian bawah skrin.', 'Scrolling text along the bottom of the screen.'),
  posters: d('Poster bergilir di skrin TV.', 'Posters shown in turn on the TV screen.'),
  programKhas: d('Program khas yang akan datang.', 'Upcoming special programmes.'),
  takwim: d('Tarikh penting Islam yang akan datang.', 'Upcoming important Islamic dates.', 'kalendar'),
  hadis: d(
    'Hadis bergilir di skrin TV, rawak atau pilih sendiri. Bilangan hadis sehari menentukan set harian.',
    'Hadith shown in turn on the TV screen, random or chosen by you. The number per day sets the daily set.',
  ),
  worldTimes: d('Waktu di Makkah, Madinah dan bandar lain.', 'The time in Makkah, Madinah and other cities.', 'makkah'),
  tugasan: d('Jadual bertugas imam, bilal dan AJK.', 'The duty roster for imam, bilal and committee.', 'imam', 'bilal'),
  ayatCard: d('Ayat Al-Quran pilihan dengan terjemahan.', 'A chosen Quran verse with translation.', 'quran'),
  zikirSelepasSolat: d('Zikir di skrin selepas setiap solat.', 'Zikir on screen after each prayer.'),
  quranReader: d('Baca mushaf penuh di aplikasi dan skrin TV.', 'Read the full mushaf in the app and on the TV screen.', 'mushaf'),
  tilawah: d('Bacaan Al-Quran oleh qari pilihan.', 'Quran recitation by a chosen reciter.', 'qari'),
  beeps: d(
    'Suis dan kuat bunyi amaran sebelum azan dan iqamah, bunyi imsak dan bunyi syuruk. Jika suis dimatikan atau kuat ialah 0, bunyi imsak, bunyi syuruk dan azan pertama Subuh turut senyap. Azan pertama berhenti apabila kiraan detik azan Subuh bermula, atau pada waktu Subuh.',
    'The switch and volume of the warning beeps before azan and iqamah, the imsak beep and the syuruk beep. With the switch off or the volume at 0, the imsak beep, the syuruk beep and the first Subuh azan are silent too. The first azan stops when the Subuh azan countdown starts, or at Subuh.',
    'azan', 'iqamah',
  ),
  liveOnKiosk: d(
    'Kuliah yang sedang disiarkan, terus di skrin TV. Jika dimatikan, siaran langsung tidak dapat dimulakan langsung, termasuk siaran ke YouTube sahaja.',
    'The lecture being broadcast, shown directly on the TV screen. When off, no live broadcast can start, including one to YouTube only.',
    'siaran',
  ),
  liveYoutube: d('Siarkan kuliah ke saluran YouTube surau sendiri.', 'Broadcast the lecture to the surau\'s own YouTube channel.', 'youtube'),
  recording: d('Rakam kuliah ke fail di peranti. Jika Simpan rakaman di peranti dimatikan, salinan di peranti dipadam sebaik YouTube mengesahkannya.', 'Record the lecture to files on the device. When Keep the recording on the device is off, the copy on the device is deleted as soon as YouTube confirms it.', 'rakaman'),
  finance: d('Rekod kutipan dan perbelanjaan surau.', 'Record the surau\'s collections and spending.', 'derma'),
  tabungCard: d('Baki tabung surau di skrin TV.', 'The surau fund balance on the TV screen.', 'derma'),
  calendarFeed: d('Jadual kuliah dalam kalendar telefon jemaah.', 'The lecture schedule in the congregation\'s phone calendars.', 'kalendar'),
  jemaahPage: d('Laman web ringkas untuk jemaah. Dirancang, belum tersedia.', 'A simple web page for the congregation. Planned, not available yet.'),
  cloudSync: d('Alamat awan MAXCOM dan selang semak perubahan.', 'The MAXCOM cloud address and how often changes are checked.', 'awan'),
  youtubeCatchUp: d('Muat naik rakaman bila siaran langsung terputus.', 'Upload the recording when a live broadcast was cut.', 'youtube'),
  recordingCleanup: d('Padam rakaman di peranti selepas YouTube mengesahkannya.', 'Delete recordings on the device once YouTube has confirmed them.', 'rakaman'),
  appLock: d('PIN atau cap jari setiap kali MAXCOM dibuka.', 'A PIN or fingerprint every time MAXCOM is opened.', 'pin', 'cap jari'),
  system: d('Amaran tiada video, tunggu awan bangun, sejarah penyelarasan.', 'The no-video warning, how long to wait for the cloud, and sync history.'),
};
