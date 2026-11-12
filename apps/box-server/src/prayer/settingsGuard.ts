import type { DatabaseSync } from 'node:sqlite';
import { dateOf, hasOfficialSource, isValidTimeZone, tzOf } from '@surau/core';
import type { Settings } from '@surau/core';
import { getSettings, getVersion, putFeature } from '../settingsStore.ts';
import { countDaysFrom } from '../prayerStore.ts';
import type { PrayerDeps } from './index.ts';
import { zoneKnown } from './zones.ts';

const ZONE = /^[A-Z]{3}\d{2}$/;
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface GuardResult { errors?: string[]; warnings?: string[] }

/** The order a country starts with: its official source first where it has one. */
export function defaultSourceOrder(country: string): Array<'official' | 'calc' | 'file'> {
  return hasOfficialSource(country) ? ['official', 'calc', 'file'] : ['file', 'calc', 'official'];
}

/**
 * Checks a prayer-related settings patch before it is saved (features zone, location, prayerSources, prayerCalc).
 * A zone must be on the JAKIM list; one with no stored data is accepted with a warning and fetched after saving.
 */
export function prayerSettingsGuard(db: DatabaseSync, feature: string, patch: unknown, now: Date): GuardResult {
  if (!isPlain(patch)) return {};
  if (feature === 'zone' && typeof patch.zone === 'string' && ZONE.test(patch.zone)) {
    if (!zoneKnown(db, patch.zone)) return { errors: ['Zon tidak dikenali; kemas kini senarai zon'] };
    if (countDaysFrom(db, patch.zone, dateOf(now, tzOf(getSettings(db)))) === 0) {
      return { warnings: ['Tiada data untuk zon ini; MAXCOM akan memuat turun'] };
    }
  }
  if (feature === 'location' && typeof patch.timezone === 'string' && !isValidTimeZone(patch.timezone)) {
    return { errors: ['Zon waktu tidak sah'] };
  }
  return {};
}

type Plain = Record<string, unknown>;

/** Runs after a prayer-related settings patch was saved. */
export function afterPrayerSettings(db: DatabaseSync, feature: string, before: unknown, after: unknown, deps: PrayerDeps): void {
  if (feature === 'zone' && isPlain(after) && typeof after.zone === 'string' && isPlain(before) && before.zone !== after.zone) {
    // A zone with no days yet is fetched now (only where the box fetches by itself: tests and the cloud do not).
    if (deps.autoFetchOn && countDaysFrom(db, after.zone, dateOf(deps.now(), tzOf(getSettings(db)))) === 0) {
      void deps.autoFetch.runOnce().catch(() => undefined);
    }
    return;
  }
  if (feature === 'location' && isPlain(before) && isPlain(after) && before.country !== after.country
    && typeof before.country === 'string' && typeof after.country === 'string') {
    const current = (getSettings(db) as Settings).prayerSources.sourceOrder;
    // Only an order that is still the old country's own default follows the country; a chosen order stays.
    if (JSON.stringify(current) === JSON.stringify(defaultSourceOrder(before.country))) {
      const next = defaultSourceOrder(after.country);
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        putFeature(db, 'prayerSources', { sourceOrder: next } as Plain, 'system:prayer-sources');
        deps.bus.emit(getVersion(db));
      }
    }
  }
}
