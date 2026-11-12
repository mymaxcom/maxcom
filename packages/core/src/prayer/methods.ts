/** Calculation methods. `adhan` names the adhan-js preset the box maps to (null = custom angles). */
export type AdhanPreset =
  | 'MuslimWorldLeague' | 'Egyptian' | 'Karachi' | 'UmmAlQura' | 'Dubai' | 'Qatar' | 'Kuwait'
  | 'MoonsightingCommittee' | 'Singapore' | 'Tehran' | 'Turkey' | 'NorthAmerica' | 'Other';

export type MethodKey =
  | 'mwl' | 'egyptian' | 'karachi' | 'ummAlQura' | 'dubai' | 'qatar' | 'kuwait' | 'moonsighting'
  | 'singapore' | 'tehran' | 'turkey' | 'northAmerica' | 'jakim' | 'kemenag' | 'uoif' | 'morocco'
  | 'algeria' | 'russia';

export interface MethodDef {
  labelMs: string;
  labelEn: string;
  adhan: AdhanPreset | null;
  fajrAngle?: number;
  ishaAngle?: number;
  ishaInterval?: number;
  maghribAngle?: number;
}

export const METHOD_KEYS: readonly MethodKey[] = [
  'mwl', 'egyptian', 'karachi', 'ummAlQura', 'dubai', 'qatar', 'kuwait', 'moonsighting', 'singapore',
  'tehran', 'turkey', 'northAmerica', 'jakim', 'kemenag', 'uoif', 'morocco', 'algeria', 'russia',
];

export const METHODS: Readonly<Record<MethodKey, MethodDef>> = {
  mwl: { labelMs: 'Liga Dunia Islam', labelEn: 'Muslim World League', adhan: 'MuslimWorldLeague' },
  egyptian: { labelMs: 'Mesir', labelEn: 'Egyptian General Authority', adhan: 'Egyptian' },
  karachi: { labelMs: 'Karachi', labelEn: 'University of Islamic Sciences, Karachi', adhan: 'Karachi' },
  ummAlQura: { labelMs: 'Umm al-Qura', labelEn: 'Umm al-Qura, Makkah', adhan: 'UmmAlQura' },
  dubai: { labelMs: 'Dubai', labelEn: 'Dubai', adhan: 'Dubai' },
  qatar: { labelMs: 'Qatar', labelEn: 'Qatar', adhan: 'Qatar' },
  kuwait: { labelMs: 'Kuwait', labelEn: 'Kuwait', adhan: 'Kuwait' },
  moonsighting: { labelMs: 'Jawatankuasa Moonsighting', labelEn: 'Moonsighting Committee', adhan: 'MoonsightingCommittee' },
  singapore: { labelMs: 'Singapura', labelEn: 'Singapore', adhan: 'Singapore' },
  tehran: { labelMs: 'Tehran', labelEn: 'Tehran', adhan: 'Tehran' },
  turkey: { labelMs: 'Turki (Diyanet)', labelEn: 'Turkey (Diyanet)', adhan: 'Turkey' },
  northAmerica: { labelMs: 'Amerika Utara (ISNA)', labelEn: 'North America (ISNA)', adhan: 'NorthAmerica' },
  // Measured against the real SGR01-2026 table: JAKIM's Subuh is the 18 degree Fajr (20 degrees is 10 minutes early).
  jakim: { labelMs: 'JAKIM 18/18', labelEn: 'JAKIM 18/18', adhan: 'Other', fajrAngle: 18, ishaAngle: 18 },
  kemenag: { labelMs: 'Kemenag Indonesia 20/18', labelEn: 'Kemenag Indonesia 20/18', adhan: 'Other', fajrAngle: 20, ishaAngle: 18 },
  uoif: { labelMs: 'UOIF Perancis 12/12', labelEn: 'UOIF France 12/12', adhan: 'Other', fajrAngle: 12, ishaAngle: 12 },
  morocco: { labelMs: 'Maghribi 19/17', labelEn: 'Morocco 19/17', adhan: 'Other', fajrAngle: 19, ishaAngle: 17 },
  algeria: { labelMs: 'Algeria 18/17', labelEn: 'Algeria 18/17', adhan: 'Other', fajrAngle: 18, ishaAngle: 17 },
  russia: { labelMs: 'Rusia 16/15', labelEn: 'Russia 16/15', adhan: 'Other', fajrAngle: 16, ishaAngle: 15 },
};

export function isMethodKey(v: unknown): v is MethodKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(METHODS, v);
}
