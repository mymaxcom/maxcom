import type { PrayerDay } from './types.ts';

export type OfficialSourceId = 'jakim';

/** A national authority's published timetable. Only JAKIM is implemented. */
export interface OfficialSource {
  id: OfficialSourceId;
  country: string;
  regionLabelMs: string;
  fetchYear(region: string, year: number, fetchImpl: typeof fetch, baseUrl: string): Promise<PrayerDay[]>;
  isRegion(code: string): boolean;
}

/** Country (ISO 3166-1 alpha-2) to the official source it has. */
export const OFFICIAL_SOURCES: Readonly<Record<string, OfficialSourceId>> = { MY: 'jakim' };

export function hasOfficialSource(country: string): boolean {
  return Object.prototype.hasOwnProperty.call(OFFICIAL_SOURCES, country);
}
