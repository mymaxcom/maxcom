export type PrayerName = 'imsak' | 'subuh' | 'syuruk' | 'zohor' | 'asar' | 'maghrib' | 'isyak';

export interface HijriDate {
  y: number;
  m: number; // 1-12
  d: number;
}

/** Per-date overrides a masjid's own timetable file may carry (Plan 13 #23). */
export interface PrayerOverrides {
  iqamahMinutes?: Partial<Record<'subuh' | 'zohor' | 'asar' | 'maghrib' | 'isyak', number>>;
  khutbahMinutes?: number;
}

export interface PrayerDay {
  date: string; // YYYY-MM-DD
  hijri: HijriDate;
  times: Record<PrayerName, string>; // HH:mm 24h
  /** Optional Dhuha time (HH:mm): stored and shown on the admin side, never on the kiosk bar. */
  dhuha?: string;
  overrides?: PrayerOverrides;
  /** True when the file had no imsak column and imsak was derived as subuh minus the imsak minutes. */
  imsakDerived?: boolean;
}

/** Where a day's times come from. */
export type PrayerSource = 'official' | 'calc' | 'file';

export interface ResolvedDay extends PrayerDay {
  source: PrayerSource;
  /** Prayers whose time a manual correction replaced. */
  corrected: PrayerName[];
  /** Prayers whose manual correction was not used because it would put the day out of order (a later source change). */
  correctionIgnored?: PrayerName[];
  /** Kiosk bundle only: the source line for THIS day in each language, so the footer stays right across midnight. */
  footerMs?: string;
  footerEn?: string;
  /** A calculated day shown in a country that has an official source. */
  emergency: boolean;
  hijriSource: 'official' | 'calc' | 'file';
}
