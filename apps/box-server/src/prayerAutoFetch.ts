import type { DatabaseSync } from 'node:sqlite';
import { dateOf, hasOfficialSource, tzOf } from '@surau/core';
import type { PrayerDay, Settings } from '@surau/core';
import { fetchJakimYear } from './jakimFetch.ts';
import { sourceUrlsFrom } from './net/safeFetch.ts';
import { countDaysFrom, importDays } from './prayerStore.ts';
import { getSettings, getVersion } from './settingsStore.ts';

/** Audit actor for days the box fetched by itself. */
export const AUTO_FETCH_ACTOR = 'system:auto-prayer-fetch';

/** The box tops up when fewer days than this are left ahead. */
export const AUTO_FETCH_BELOW_DAYS = 60;
const FIRST_DELAY_MS = 60_000;
const INTERVAL_MS = 24 * 3_600_000;
const ZONE = /^[A-Z]{3}\d{2}$/;

/**
 * One year of e-Solat times for a zone, from the address in the settings. Shared by the manual
 * import route and the automatic fetch so both use the same configured source and guarded fetch.
 */
export function fetchEsolatYear(
  db: DatabaseSync,
  zone: string,
  year: number,
  fetchImpl: typeof fetch,
): Promise<PrayerDay[]> {
  return fetchJakimYear(zone, year, fetchImpl, sourceUrlsFrom(getSettings(db)).esolat);
}

export interface AutoFetchStatus {
  /** The `autoFetch` setting of the prayer zone. */
  enabled: boolean;
  lastAttemptAt: string | null;
  lastOk: boolean | null;
  /** Short reason of the last failure, with addresses removed. */
  lastError?: string;
}

export type AutoFetchOutcome =
  | { ran: false }
  | { ran: true; ok: true; added: number; year: number }
  | { ran: true; ok: false; year: number };

export interface AutoFetchOptions {
  db: DatabaseSync;
  now: () => Date;
  fetchImpl: typeof fetch;
  /** Called with the new settings version after days were added (so screens refresh). */
  onChanged?: (version: number) => void;
  /** Test seam: where the settings come from (default: the database). */
  readSettings?: () => Settings;
  firstDelayMs?: number;
  intervalMs?: number;
}

export interface PrayerAutoFetch {
  runOnce: () => Promise<AutoFetchOutcome>;
  start: () => void;
  stop: () => void;
  status: () => AutoFetchStatus;
}

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function dayOfYear(date: string): number {
  const y = Number(date.slice(0, 4));
  return Math.round((Date.UTC(y, Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
}

/** Text safe to show: no addresses, no query strings, short. */
function safeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\bhttps?:\/\/\S*/gi, '[alamat]').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function createPrayerAutoFetch(o: AutoFetchOptions): PrayerAutoFetch {
  const { db, now, fetchImpl } = o;
  const readSettings = o.readSettings ?? (() => getSettings(db));
  let lastAttemptAt: string | null = null;
  let lastOk: boolean | null = null;
  let lastError: string | undefined;
  let running = false;
  let first: NodeJS.Timeout | null = null;
  let every: NodeJS.Timeout | null = null;
  let stopped = false;

  const enabledNow = (): boolean => {
    try {
      return readSettings().zone.autoFetch !== false;
    } catch {
      return false;
    }
  };

  /** First year, current then next, that lacks days from today on; null when both are complete. */
  function targetYear(zone: string, today: string): number | null {
    const thisYear = Number(today.slice(0, 4));
    for (const year of [thisYear, thisYear + 1]) {
      const from = year === thisYear ? today : `${year}-01-01`;
      const expected = (isLeap(year) ? 366 : 365) - dayOfYear(from) + 1;
      const have = (db
        .prepare('SELECT COUNT(*) AS n FROM prayer_days WHERE zone = ? AND date >= ? AND date <= ?')
        .get(zone, from, `${year}-12-31`)?.n ?? 0) as number;
      if (Number(have) < expected) return year;
    }
    return null;
  }

  async function runOnce(): Promise<AutoFetchOutcome> {
    if (running) return { ran: false };
    running = true;
    try {
      const settings = readSettings();
      if (settings.zone.autoFetch === false) return { ran: false };
      // Only a country with an official source has anything to fetch (Malaysia: JAKIM).
      if (!hasOfficialSource(settings.location.country)) return { ran: false };
      const zone = settings.zone.zone;
      if (typeof zone !== 'string' || !ZONE.test(zone)) return { ran: false };
      const today = dateOf(now(), tzOf(settings));
      if (countDaysFrom(db, zone, today) >= AUTO_FETCH_BELOW_DAYS) return { ran: false };
      const year = targetYear(zone, today);
      if (year === null) return { ran: false };

      lastAttemptAt = now().toISOString();
      try {
        const days = (await fetchEsolatYear(db, zone, year, fetchImpl)).filter((d) => d.date >= today);
        const source = String(sourceName(db));
        const result = importDays(db, zone, days, AUTO_FETCH_ACTOR, undefined, {
          insertOnly: true,
          summary: (n) => `Data waktu solat dimuat turun secara automatik dari ${source}: ${n} hari ditambah`,
        });
        lastOk = true;
        lastError = undefined;
        if (result.inserted > 0) {
          try {
            o.onChanged?.(getVersion(db));
          } catch {
            // A listener must not turn a good fetch into a failure.
          }
        }
        return { ran: true, ok: true, added: result.inserted, year };
      } catch (error) {
        lastOk = false;
        lastError = safeReason(error);
        console.warn(`Auto prayer fetch for ${zone} ${year} failed: ${lastError}`);
        return { ran: true, ok: false, year };
      }
    } catch (error) {
      // Reading the settings or the database failed (for example while closing).
      lastAttemptAt = now().toISOString();
      lastOk = false;
      lastError = safeReason(error);
      console.warn(`Auto prayer fetch failed: ${lastError}`);
      return { ran: true, ok: false, year: 0 };
    } finally {
      running = false;
    }
  }

  const tick = (): void => {
    if (stopped) return;
    void runOnce().catch(() => undefined);
  };

  return {
    runOnce,
    start() {
      if (first !== null || every !== null || stopped) return;
      first = setTimeout(tick, o.firstDelayMs ?? FIRST_DELAY_MS);
      first.unref();
      every = setInterval(tick, o.intervalMs ?? INTERVAL_MS);
      every.unref();
    },
    stop() {
      stopped = true;
      if (first !== null) clearTimeout(first);
      if (every !== null) clearInterval(every);
      first = null;
      every = null;
    },
    status() {
      return {
        enabled: enabledNow(),
        lastAttemptAt,
        lastOk,
        ...(lastError !== undefined ? { lastError } : {}),
      };
    },
  };
}

function sourceName(db: DatabaseSync): string {
  const name = getSettings(db).dataSources.esolat.name;
  return typeof name === 'string' && name.trim() !== '' ? name : 'e-Solat';
}
