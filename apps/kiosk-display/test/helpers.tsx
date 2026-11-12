import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeKioskState, dateOf, hijriForDisplay, instantOf, parseJakimCsv, resolveSettings, tzOf } from '@surau/core';
import type { FeatureSettings, PrayerDay, Settings } from '@surau/core';
import { tarawihMonthFor } from '../src/data/tarawih.ts';
import { todaySourceOf } from '../src/data/todaySource.ts';
import type { KioskView } from '../src/data/kiosk.ts';
import type { PrayerInfo } from '../src/data/bundle.ts';

const FIXTURE = 'packages/core/test/fixtures/SGR01-2026.csv';
const fixturePath = [FIXTURE, `../../${FIXTURE}`].map((p) => resolve(process.cwd(), p)).find(existsSync);
if (!fixturePath) throw new Error(`fixture not found from ${process.cwd()}`);
export const days = parseJakimCsv(readFileSync(fixturePath, 'utf8'));

export interface ViewOpts {
  settings?: Partial<Record<string, Partial<FeatureSettings>>>;
  hijriMonth?: number;
  stale?: boolean;
  /** The bundle's logo URL; none by default. */
  logo?: string | null;
  /** The bundle's days (the SGR01 fixture by default). */
  days?: PrayerDay[];
  /** The bundle's `prayer` block; none by default (an old bundle). */
  prayer?: PrayerInfo;
  /** The instant, when the test names it directly (UTC) instead of a wall-clock date and time. */
  at?: Date;
}

/** A KioskView exactly as the data layer would compute it at an instant on the fixture year. */
export function makeView(date: string, hhmm: string, opts: ViewOpts = {}): KioskView {
  const settings: Settings = resolveSettings(opts.settings ?? {});
  const tz = opts.prayer?.timezone ?? tzOf(settings);
  const bundleDays = opts.days ?? days;
  const now = opts.at ?? instantOf(date, hhmm, tz);
  const hijriMonth = opts.hijriMonth ?? tarawihMonthFor(now, bundleDays, settings);
  const state = computeKioskState(now, bundleDays, settings, hijriMonth);
  const hijri = hijriForDisplay(now, bundleDays, settings.hijriDate.adjustDays, settings.hijriDate.switchAt, tz);
  const today = dateOf(now, tz);
  return {
    state,
    settings,
    hijri,
    stale: opts.stale ?? false,
    now,
    tz,
    todaySource: todaySourceOf(bundleDays, today, opts.prayer),
    daysAhead: bundleDays.filter((d) => d.date >= today).length,
    ready: true,
    error: null,
    logo: opts.logo ?? null,
  };
}
