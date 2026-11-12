/** Fixed lists the settings pages pick from: surahs, Hijri months, reciters, YouTube placeholders. */

export interface Surah {
  n: number;
  nameMs: string;
  ayat: number;
}

const S: readonly (readonly [string, number])[] = [
  ['Al-Fatihah', 7], ['Al-Baqarah', 286], ['Ali \'Imran', 200], ['An-Nisa\'', 176], ['Al-Ma\'idah', 120],
  ['Al-An\'am', 165], ['Al-A\'raf', 206], ['Al-Anfal', 75], ['At-Taubah', 129], ['Yunus', 109],
  ['Hud', 123], ['Yusuf', 111], ['Ar-Ra\'d', 43], ['Ibrahim', 52], ['Al-Hijr', 99],
  ['An-Nahl', 128], ['Al-Isra\'', 111], ['Al-Kahf', 110], ['Maryam', 98], ['Ta Ha', 135],
  ['Al-Anbiya\'', 112], ['Al-Hajj', 78], ['Al-Mu\'minun', 118], ['An-Nur', 64], ['Al-Furqan', 77],
  ['Asy-Syu\'ara\'', 227], ['An-Naml', 93], ['Al-Qasas', 88], ['Al-\'Ankabut', 69], ['Ar-Rum', 60],
  ['Luqman', 34], ['As-Sajdah', 30], ['Al-Ahzab', 73], ['Saba\'', 54], ['Fatir', 45],
  ['Ya Sin', 83], ['As-Saffat', 182], ['Sad', 88], ['Az-Zumar', 75], ['Ghafir', 85],
  ['Fussilat', 54], ['Asy-Syura', 53], ['Az-Zukhruf', 89], ['Ad-Dukhan', 59], ['Al-Jasiyah', 37],
  ['Al-Ahqaf', 35], ['Muhammad', 38], ['Al-Fath', 29], ['Al-Hujurat', 18], ['Qaf', 45],
  ['Az-Zariyat', 60], ['At-Tur', 49], ['An-Najm', 62], ['Al-Qamar', 55], ['Ar-Rahman', 78],
  ['Al-Waqi\'ah', 96], ['Al-Hadid', 29], ['Al-Mujadalah', 22], ['Al-Hasyr', 24], ['Al-Mumtahanah', 13],
  ['As-Saff', 14], ['Al-Jumu\'ah', 11], ['Al-Munafiqun', 11], ['At-Taghabun', 18], ['At-Talaq', 12],
  ['At-Tahrim', 12], ['Al-Mulk', 30], ['Al-Qalam', 52], ['Al-Haqqah', 52], ['Al-Ma\'arij', 44],
  ['Nuh', 28], ['Al-Jinn', 28], ['Al-Muzzammil', 20], ['Al-Muddassir', 56], ['Al-Qiyamah', 40],
  ['Al-Insan', 31], ['Al-Mursalat', 50], ['An-Naba\'', 40], ['An-Nazi\'at', 46], ['\'Abasa', 42],
  ['At-Takwir', 29], ['Al-Infitar', 19], ['Al-Mutaffifin', 36], ['Al-Insyiqaq', 25], ['Al-Buruj', 22],
  ['At-Tariq', 17], ['Al-A\'la', 19], ['Al-Ghasyiyah', 26], ['Al-Fajr', 30], ['Al-Balad', 20],
  ['Asy-Syams', 15], ['Al-Lail', 21], ['Ad-Duha', 11], ['Asy-Syarh', 8], ['At-Tin', 8],
  ['Al-\'Alaq', 19], ['Al-Qadr', 5], ['Al-Bayyinah', 8], ['Az-Zalzalah', 8], ['Al-\'Adiyat', 11],
  ['Al-Qari\'ah', 11], ['At-Takasur', 8], ['Al-\'Asr', 3], ['Al-Humazah', 9], ['Al-Fil', 5],
  ['Quraisy', 4], ['Al-Ma\'un', 7], ['Al-Kausar', 3], ['Al-Kafirun', 6], ['An-Nasr', 3],
  ['Al-Masad', 5], ['Al-Ikhlas', 4], ['Al-Falaq', 5], ['An-Nas', 6],
];

/** The 114 surahs; index = surah number - 1. */
export const SURAHS: readonly Surah[] = S.map(([nameMs, ayat], i) => ({ n: i + 1, nameMs, ayat }));

export const HIJRI_MONTHS: { readonly ms: readonly string[]; readonly en: readonly string[] } = {
  ms: ['Muharram', 'Safar', 'Rabiulawal', 'Rabiulakhir', 'Jamadilawal', 'Jamadilakhir', 'Rejab', 'Syaaban', 'Ramadan', 'Syawal', 'Zulkaedah', 'Zulhijjah'],
  en: ['Muharram', 'Safar', 'Rabi al-Awwal', 'Rabi al-Thani', 'Jumada al-Awwal', 'Jumada al-Thani', 'Rajab', 'Shaban', 'Ramadan', 'Shawwal', 'Dhu al-Qadah', 'Dhu al-Hijjah'],
};

export interface Reciter {
  /** EveryAyah folder name, or 'other' for a typed folder. */
  folder: string;
  name: string;
  styleMs: string;
}

export const RECITERS: readonly Reciter[] = [
  { folder: 'Husary_64kbps', name: 'Mahmoud Khalil Al-Husary', styleMs: 'Murattal, lalai' },
  { folder: 'Alafasy_64kbps', name: 'Mishary Rashid Alafasy', styleMs: 'Murattal' },
  { folder: 'Abdul_Basit_Murattal_64kbps', name: 'Abdul Basit Abdus Samad', styleMs: 'Murattal' },
  { folder: 'Ghamadi_40kbps', name: 'Saad Al-Ghamdi', styleMs: 'Murattal' },
  { folder: 'Minshawy_Murattal_128kbps', name: 'Mohamed Siddiq Al-Minshawi', styleMs: 'Murattal' },
  { folder: 'other', name: 'Lain-lain', styleMs: 'Taip nama folder EveryAyah' },
];

/** The placeholders a YouTube title or description template may use (see youtubeMeta.ts). */
export const YOUTUBE_PLACEHOLDERS: readonly { key: string; labelMs: string; labelEn: string }[] = [
  { key: 'label', labelMs: 'Label kuliah', labelEn: 'Lecture label' },
  { key: 'penceramah', labelMs: 'Penceramah', labelEn: 'Speaker' },
  { key: 'topic', labelMs: 'Topik', labelEn: 'Topic' },
  { key: 'kitab', labelMs: 'Kitab', labelEn: 'Book' },
  { key: 'surau', labelMs: 'Nama surau', labelEn: 'Surau name' },
  { key: 'date', labelMs: 'Tarikh', labelEn: 'Date' },
  { key: 'time', labelMs: 'Masa', labelEn: 'Time' },
];
