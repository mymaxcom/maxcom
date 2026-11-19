/** Fixed lists the settings pages pick from: Hijri months (surahs live in ../islamic/surahs.ts), reciters, YouTube placeholders. */

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
