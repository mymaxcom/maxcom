export type Lang = 'ms' | 'en';

export const STRINGS: Record<Lang, Record<string, string>> = {
  ms: {
    nextIn: '{prayer} dalam',
    azanIn: 'Azan {prayer} dalam',
    masukWaktu: 'Telah masuk waktu {prayer}',
    iqamahIn: 'Iqamah dalam',
    solatNow: 'Solat sedang didirikan',
    khutbahNow: 'Khutbah Jumaat sedang disampaikan',
    khutbahCalm: 'Sila dengar dengan tenang',
    syurukIn: 'Syuruk dalam',
    subuhEnding: 'Waktu Subuh hampir tamat',
    isyraq: 'Waktu Isyraq',
    tarawih: 'Solat Tarawih',
    noData: 'Tiada data waktu solat. Tetapkan lokasi surau dalam aplikasi MAX Admin Client.',
    'kiosk.emergency': 'Waktu kiraan sementara; data rasmi JAKIM tiada untuk hari ini',
    surauName: 'Surau',
    // The prayer bar's accessible name (also the printed caption of the Klasik Lama jadual).
    barCaption: 'Waktu solat',
    // Prayer-bar pill words while a prayer is in progress.
    barAzan: 'Azan',
    barIqamah: 'Iqamah',
    barSolat: 'Solat',
    barKhutbah: 'Khutbah',
    barTarawih: 'Tarawih',
    // Content cards (Plan 2).
    kuliahToday: 'Kuliah hari ini',
    kuliahNext: 'Kuliah seterusnya',
    pengumuman: 'Pengumuman',
    programKhas: 'Program khas',
    takwim: 'Takwim',
    tabungTag: 'TABUNG SURAU',
    tabungUpdated: 'Dikemas kini {date}',
    tabungTarget: '{pct}% daripada sasaran {target}',
    tabungQr: 'Derma melalui DuitNow QR',
    tabungNew: 'BARU',
    batal: 'DIBATALKAN',
    today: 'Hari ini',
    daysLeftWord: 'hari lagi',
    // Plan 2 Task 10: hadis, world times, tugasan, ayat, zikir, ticker.
    hadis: 'Hadis',
    bahagian: 'Bahagian',
    daripada: 'daripada',
    sumber: 'Sumber',
    worldTimes: 'Waktu dunia',
    tugasan: 'Tugasan',
    ayatToday: 'Ayat hari ini',
    surahLine: 'Surah {name} ({n}): {range}',
    translation: 'Terjemahan',
    zikirAfter: 'Zikir selepas solat {prayer}',
    roleImam: 'Imam',
    roleBilal: 'Bilal',
    roleKhatib: 'Khatib',
    roleAjk: 'AJK bertugas',
    hourShort: 'j',
    tomorrowWord: 'esok',
    yesterdayWord: 'semalam',
    tickerCap: 'Makluman',
    timesWord: 'kali',
    // Plan 3 Task 6: kiosk pairing screen and the not-paired badge.
    pairTitle: 'Padankan skrin TV ini',
    // No-break spaces inside the menu path: it must never split across two lines on the TV.
    pairInstruction: 'Buka aplikasi MAX Admin Client, pilih Lagi > Pengguna & peranti > Skrin TV, dan masukkan kod ini',
    pairExpiresIn: 'Kod tamat dalam {mmss}',
    pairRenewing: 'Meminta kod baharu...',
    pairUnreachable: 'Tidak dapat menghubungi MAXCOM',
    pairRetrying: 'Mencuba semula secara automatik',
    pairDone: 'Skrin dipadankan',
    pairBadge: 'Belum dipadankan',
    // Plan 5 Task 6: the live layer.
    liveNow: 'SIARAN LANGSUNG',
    liveRunning: 'Siaran langsung sedang berjalan',
    // Plan 14 Tasks 8 and 9: the box states and the network check.
    setupSub: 'Persediaan pertama',
    boxLangLabel: 'Bahasa',
    setupTitle: 'Sediakan MAXCOM ini',
    setupLead: 'Imbas dengan aplikasi MAX Admin Client untuk menjadi Pentadbir pertama.',
    setupLead2: 'Tidak perlukan internet. Telefon dan MAXCOM ini mesti di rangkaian yang sama.',
    setupStep1: 'Pastikan telefon di Wi-Fi utama surau (bukan Wi-Fi tetamu).',
    setupStep2: 'Buka aplikasi MAX Admin Client dan pilih Imbas kod QR.',
    setupStep3: 'Imbas kod di sebelah, kemudian isi nama surau dan nama anda.',
    setupCodeOnce: 'Kod persediaan, sekali guna',
    setupNewCodeIn: 'Kod baharu dalam {mmss}',
    setupFingerprint: 'Cap jari',
    setupAddress: 'Alamat',
    setupBoxName: 'Nama',
    setupBoxId: 'ID',
    setupNoHttps: 'MAXCOM ini belum ada sijil HTTPS: pemasang perlu melengkapkan pemasangan',
    setupNeedsCamera: 'Persediaan perlukan telefon atau iPad dengan kamera',
    setupNetCheck: 'Semakan rangkaian',
    setupNetHint: 'Tekan OK',
    setupApp: 'Aplikasi MAXCOM: {url}',
    setupHttpsOn: 'HTTPS aktif',
    recoveryTitleNoAdmin: 'Surau ini perlukan Pentadbir baharu',
    recoveryTitleDamaged: 'Data surau perlu dipulihkan',
    recoveryWhyNoAdmin: 'Tiada Pentadbir aktif lagi untuk {surau}.',
    recoveryWhyDamaged: 'Pangkalan data di MAXCOM ini rosak dan tidak dapat dibaca.',
    recoveryHowLinked: 'MAXCOM ini dipautkan ke awan MAXCOM',
    recoveryHowUnlinked: 'MAXCOM ini tidak dipautkan ke awan',
    recoveryLinked1: 'Bakal Pentadbir imbas kod ini dengan aplikasi MAX Admin Client.',
    recoveryLinked2: 'Masukkan kod pemulihan di telefon, atau minta Pentadbir MAXCOM meluluskan Pentadbir baharu.',
    recoveryLinked3: 'Skrin kembali seperti biasa selepas selesai.',
    recoveryUnlinked1: 'Imbas kod ini dengan aplikasi MAX Admin Client.',
    recoveryUnlinked2: 'Masukkan kod pemulihan yang ditulis di atas kertas semasa persediaan.',
    recoveryUnlinked3: 'Telefon itu menjadi Pentadbir baharu surau ini.',
    recoveryNoCode: 'Tiada kod pemulihan? MAXCOM ini perlu dipasang semula dan data dipulihkan daripada sandaran setempat.',
    recoveryNoCodeMade: 'Tiada kod pemulihan dibuat untuk MAXCOM ini.',
    recoveryNoCodeContact: 'Sila hubungi pemasang MAXCOM anda.',
    recoveryDamagedLinked1: 'Hubungi Pentadbir MAXCOM anda.',
    recoveryDamagedLinked2: 'Pentadbir MAXCOM memulihkan data daripada sandaran awan.',
    recoveryDamagedLinked3: 'Skrin kembali seperti biasa selepas data dipulihkan.',
    recoveryDamagedUnlinked1: 'Hubungi pemasang MAXCOM anda.',
    recoveryDamagedUnlinked2: 'Sediakan pemacu USB sandaran jika ada.',
    recoveryDamagedUnlinked3: 'Skrin kembali seperti biasa selepas data dipulihkan.',
    recoveryPill: 'Mod pemulihan',
    recoveryNoPrayer: 'Waktu solat tidak dapat dibaca',
    recoveryCodeOnce: 'Kod pemulihan, sekali guna',
    lockedTitle: 'Perkhidmatan dihentikan',
    lockedBody: 'Hubungi Pentadbir MAXCOM.',
    lockedId: 'ID: {id}',
    netTitle: 'Semakan rangkaian',
    netEthernet: 'Ethernet',
    netWifi: 'Wi-Fi',
    netConnected: 'Disambung, {address}',
    netNotUsed: 'Tidak digunakan',
    netInternet: 'Internet',
    netInternetNotNeeded: 'Tidak perlu untuk persediaan',
    netServer: 'Pelayan MAXCOM',
    netServerOn: 'Berjalan di {url}',
    netServerOff: 'HTTPS tidak aktif',
    netPhone: 'Telefon',
    netPhoneSeen: 'Telefon sampai ke MAXCOM ini pada {time}',
    netPhoneNone: 'Tiada telefon sampai dalam 10 minit terakhir',
    netCloud: 'Awan MAXCOM',
    netLinked: 'Dipautkan, Diselaraskan {time}',
    netLinkedNever: 'Dipautkan, belum diselaraskan',
    netLinkedShort: 'Dipautkan',
    netUnlinked: 'Tidak dipautkan',
    netOk: 'Telefon boleh sampai ke MAXCOM ini',
    netOkHint: 'Cuba imbas kod pendaftaran sekali lagi dalam aplikasi MAX Admin Client.',
    netIsolation: 'Kemungkinan punca: Wi-Fi tetamu atau pengasingan pelanggan',
    netIsolation1: 'Pastikan telefon dan MAXCOM ini di Wi-Fi yang sama (bukan tetamu).',
    netIsolation2: 'Matikan "client isolation" atau "AP isolation" pada penghala Wi-Fi surau.',
    netUnlinkedHint: 'MAXCOM ini tidak dipautkan ke awan, jadi tiada jalan lain selain rangkaian yang sama.',
    netProbeTitle: 'Uji sambungan dari telefon',
    netProbeHint: 'Imbas dengan aplikasi MAX Admin Client. Jika telefon sampai, baris Telefon bertukar hijau.',
    netBack: 'Kembali',
    netRetry: 'Uji semula',
    netLoading: 'Menyemak...',
    netUnavailable: 'Semakan rangkaian tidak tersedia pada skrin ini',
    cloudOffline: 'Luar talian',
    cloudSyncedAt: 'Diselaraskan {time}',
    pairConnectedTo: 'Disambung ke {name}',
  },
  en: {
    nextIn: '{prayer} in',
    azanIn: 'Azan {prayer} in',
    masukWaktu: 'It is now time for {prayer}',
    iqamahIn: 'Iqamah in',
    solatNow: 'Prayer in progress',
    khutbahNow: 'Friday sermon in progress',
    khutbahCalm: 'Please listen quietly',
    syurukIn: 'Sunrise in',
    subuhEnding: 'Subuh time is ending soon',
    isyraq: 'Isyraq time',
    tarawih: 'Tarawih prayer',
    noData: 'No prayer time data. Set the surau location in the MAX Admin Client app.',
    'kiosk.emergency': 'Temporary calculated times; no official JAKIM data for today',
    surauName: 'Surau',
    barCaption: 'Prayer times',
    barAzan: 'Azan',
    barIqamah: 'Iqamah',
    barSolat: 'Prayer',
    barKhutbah: 'Sermon',
    barTarawih: 'Tarawih',
    kuliahToday: 'Lecture today',
    kuliahNext: 'Next lecture',
    pengumuman: 'Announcement',
    programKhas: 'Special programme',
    takwim: 'Calendar',
    tabungTag: 'DONATION FUNDS',
    tabungUpdated: 'Updated {date}',
    tabungTarget: '{pct}% of the {target} target',
    tabungQr: 'Donate with DuitNow QR',
    tabungNew: 'NEW',
    batal: 'CANCELLED',
    today: 'Today',
    daysLeftWord: 'days to go',
    hadis: 'Hadith',
    bahagian: 'Part',
    daripada: 'of',
    sumber: 'Source',
    worldTimes: 'World times',
    tugasan: 'Duty roster',
    ayatToday: 'Verse of the day',
    surahLine: 'Surah {name} ({n}): {range}',
    translation: 'Translation',
    zikirAfter: 'Zikir after {prayer} prayer',
    roleImam: 'Imam',
    roleBilal: 'Bilal',
    roleKhatib: 'Khatib',
    roleAjk: 'Committee on duty',
    hourShort: 'h',
    tomorrowWord: 'tomorrow',
    yesterdayWord: 'yesterday',
    tickerCap: 'Notice',
    timesWord: 'times',
    pairTitle: 'Pair this TV screen',
    pairInstruction: 'Open the MAX Admin Client app, choose More > Users & devices > TV screens, and enter this code',
    pairExpiresIn: 'Code expires in {mmss}',
    pairRenewing: 'Requesting a new code...',
    pairUnreachable: 'Cannot reach MAXCOM',
    pairRetrying: 'Retrying automatically',
    pairDone: 'Screen paired',
    pairBadge: 'Not paired yet',
    liveNow: 'LIVE',
    liveRunning: 'Live broadcast in progress',
    setupSub: 'First setup',
    boxLangLabel: 'Language',
    setupTitle: 'Set up this MAXCOM',
    setupLead: 'Scan with the MAX Admin Client app to become the first Administrator.',
    setupLead2: 'No internet needed. The phone and this MAXCOM must be on the same network.',
    setupStep1: 'Make sure the phone is on the main surau Wi-Fi (not the guest Wi-Fi).',
    setupStep2: 'Open MAX Admin Client and choose Scan QR code.',
    setupStep3: 'Scan the code on the right, then enter the surau name and your name.',
    setupCodeOnce: 'One-time setup code',
    setupNewCodeIn: 'New code in {mmss}',
    setupFingerprint: 'Fingerprint',
    setupAddress: 'Address',
    setupBoxName: 'Name',
    setupBoxId: 'ID',
    setupNoHttps: 'This MAXCOM has no HTTPS certificate yet: the installer needs to finish setting it up',
    setupNeedsCamera: 'Setup needs a phone or iPad with a camera',
    setupNetCheck: 'Network check',
    setupNetHint: 'Press OK',
    setupApp: 'MAX Admin Client: {url}',
    setupHttpsOn: 'HTTPS active',
    recoveryTitleNoAdmin: 'This surau needs a new Administrator',
    recoveryTitleDamaged: 'The surau data needs to be restored',
    recoveryWhyNoAdmin: '{surau} no longer has an active Administrator.',
    recoveryWhyDamaged: 'The database on this MAXCOM is damaged and cannot be read.',
    recoveryHowLinked: 'This MAXCOM is linked to the MAXCOM cloud',
    recoveryHowUnlinked: 'This MAXCOM is not linked to the cloud',
    recoveryLinked1: 'The new Administrator scans this code with the MAX Admin Client app.',
    recoveryLinked2: 'Enter the recovery code on the phone, or ask the MAXCOM Administrator to approve them.',
    recoveryLinked3: 'The screen goes back to normal once this is done.',
    recoveryUnlinked1: 'Scan this code with the MAX Admin Client app.',
    recoveryUnlinked2: 'Enter the recovery code that was written down on paper at setup.',
    recoveryUnlinked3: 'That phone becomes the new Administrator of this surau.',
    recoveryNoCode: 'No recovery code? This MAXCOM must be reinstalled and its data restored from a local backup.',
    recoveryNoCodeMade: 'No recovery code was made for this MAXCOM.',
    recoveryNoCodeContact: 'Please contact your MAXCOM installer.',
    recoveryDamagedLinked1: 'Contact your MAXCOM Administrator.',
    recoveryDamagedLinked2: 'The MAXCOM Administrator restores the data from the cloud backup.',
    recoveryDamagedLinked3: 'The screen goes back to normal once the data is restored.',
    recoveryDamagedUnlinked1: 'Contact your MAXCOM installer.',
    recoveryDamagedUnlinked2: 'Have the backup USB drive ready, if there is one.',
    recoveryDamagedUnlinked3: 'The screen goes back to normal once the data is restored.',
    recoveryPill: 'Recovery mode',
    recoveryNoPrayer: 'Prayer times cannot be read',
    recoveryCodeOnce: 'One-time recovery code',
    lockedTitle: 'Service stopped',
    lockedBody: 'Contact the MAXCOM Administrator.',
    lockedId: 'ID: {id}',
    netTitle: 'Network check',
    netEthernet: 'Ethernet',
    netWifi: 'Wi-Fi',
    netConnected: 'Connected, {address}',
    netNotUsed: 'Not in use',
    netInternet: 'Internet',
    netInternetNotNeeded: 'Not needed for setup',
    netServer: 'MAXCOM server',
    netServerOn: 'Running at {url}',
    netServerOff: 'HTTPS is not active',
    netPhone: 'Phone',
    netPhoneSeen: 'A phone reached this MAXCOM at {time}',
    netPhoneNone: 'No phone has reached this MAXCOM in the last 10 minutes',
    netCloud: 'MAXCOM cloud',
    netLinked: 'Linked, last synced {time}',
    netLinkedNever: 'Linked, not synced yet',
    netLinkedShort: 'Linked',
    netUnlinked: 'Not linked',
    netOk: 'The phone can reach this MAXCOM',
    netOkHint: 'Scan the enrolment code again in the MAX Admin Client app.',
    netIsolation: 'Possible cause: guest Wi-Fi or client isolation',
    netIsolation1: 'Make sure the phone is on the same Wi-Fi as this MAXCOM (not the guest Wi-Fi).',
    netIsolation2: 'Turn off "client isolation" or "AP isolation" on the surau Wi-Fi router.',
    netUnlinkedHint: 'This MAXCOM is not linked to the cloud, so the phone can only reach it over the same network.',
    netProbeTitle: 'Test the connection from a phone',
    netProbeHint: 'Scan with the MAX Admin Client app. If the phone gets through, the Phone row turns green.',
    netBack: 'Back',
    netRetry: 'Test again',
    netLoading: 'Checking...',
    netUnavailable: 'The network check is not available on this screen',
    cloudOffline: 'Offline',
    cloudSyncedAt: 'Synced {time}',
    pairConnectedTo: 'Connected to {name}',
  },
};

/**
 * The surau name shown on screen: `settings.surauInfo.name`, falling back to the built-in
 * `surauName` string. CSS keeps the uppercase, letter-spaced look. Never throws.
 */
export function surauNameOf(settings: { surauInfo?: { name?: unknown } } | null | undefined, lang: Lang): string {
  try {
    const n = settings?.surauInfo?.name;
    if (typeof n === 'string' && n.trim() !== '') return n.trim();
  } catch {
    /* fall through */
  }
  return t('surauName', lang);
}

export function t(key: string, lang: Lang, vars?: Record<string, string | number>): string {
  const s = STRINGS[lang]?.[key];
  if (s === undefined) return key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

// ---- Date and time words for the content cards (appended by Plan 2) ----------------------------
// Pure string helpers: a 'YYYY-MM-DD' KL date and an 'HH:mm' KL time in, Malay (or English) words out.

const DAYS_SHORT: Record<Lang, string[]> = {
  ms: ['Ahd', 'Isn', 'Sel', 'Rab', 'Kha', 'Jum', 'Sab'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
};
const DAYS_LONG: Record<Lang, string[]> = {
  ms: ['Ahad', 'Isnin', 'Selasa', 'Rabu', 'Khamis', 'Jumaat', 'Sabtu'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};
const MONTHS_SHORT: Record<Lang, string[]> = {
  ms: ['Jan', 'Feb', 'Mac', 'Apr', 'Mei', 'Jun', 'Jul', 'Ogo', 'Sep', 'Okt', 'Nov', 'Dis'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};
const MONTHS_LONG: Record<Lang, string[]> = {
  ms: ['Januari', 'Februari', 'Mac', 'April', 'Mei', 'Jun', 'Julai', 'Ogos', 'September', 'Oktober', 'November', 'Disember'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};

/** Parts of a 'YYYY-MM-DD' date, or null when malformed. `utc` is the day's UTC midnight (calendar math only). */
export function ymdParts(date: string): { y: number; m: number; d: number; wd: number; utc: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = Date.UTC(y, mo - 1, d);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return { y, m: mo, d, wd: back.getUTCDay(), utc };
}

/** 'Rab 5 Nov'. A malformed date is returned as given. */
export function fmtDateShort(date: string, lang: Lang): string {
  const p = ymdParts(date);
  if (!p) return date;
  return `${DAYS_SHORT[lang][p.wd]} ${p.d} ${MONTHS_SHORT[lang][p.m - 1]}`;
}

/** 'Sabtu, 7 November 2026'. A malformed date is returned as given. */
export function fmtDateLong(date: string, lang: Lang): string {
  const p = ymdParts(date);
  if (!p) return date;
  return `${DAYS_LONG[lang][p.wd]}, ${p.d} ${MONTHS_LONG[lang][p.m - 1]} ${p.y}`;
}

/** Whole calendar days from `from` to `to` ('YYYY-MM-DD' each), or null when either is malformed. */
export function daysBetween(from: string, to: string): number | null {
  const a = ymdParts(from);
  const b = ymdParts(to);
  if (!a || !b) return null;
  return Math.round((b.utc - a.utc) / 86_400_000);
}

/**
 * '7:15 malam' (ms, 12h), '7:15 PM' (en, 12h) or '19:15' (24h). Malay time-of-day words follow Malaysian
 * usage: pagi before noon, tengah hari 12-13, petang 14-18, malam from 19. A malformed time is returned as given.
 */
export function fmtTimeOfDay(hhmm: string, lang: Lang, timeFormat: '12h' | '24h' = '12h'): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  if (h > 23 || Number(m[2]) > 59) return hhmm;
  if (timeFormat === '24h') return `${String(h).padStart(2, '0')}:${m[2]}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  let word: string;
  if (lang === 'en') word = h < 12 ? 'AM' : 'PM';
  else word = h < 12 ? 'pagi' : h < 14 ? 'tengah hari' : h < 19 ? 'petang' : 'malam';
  return `${h12}:${m[2]} ${word}`;
}
