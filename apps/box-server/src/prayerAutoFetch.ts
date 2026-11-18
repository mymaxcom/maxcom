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
  surauId: string,
): Promise<PrayerDay[]> {
  return fetchJakimYear(zone, year, fetchImpl, sourceUrlsFrom(getSettings(db, surauId)).esolat);
}

export interface AutoFetchStatus {
  /** The `autoFetch` setting of the prayer zone. */
  enabled: boolean;
  lastAttemptAt: string | null;
  lastOk: boolean | null;
  /** Short reason of the last failure, with addresses removed. */
  lastError?: string;
  /** The zone the state above is for (absent before any attempt). */
  zone?: string;
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
  onChanged?: (version: number, surauId: string) => void;
  /** The suraus to top up each round: a box has its own, the cloud one per surau (read at every round). */
  surauIds: () => string[];
  /** True for a surau this server must not fetch for (the cloud leaves a surau with an unrevoked linked box to that box). */
  skipSurau?: (surauId: string) => boolean;
  /** Test seam: where the settings come from (default: the database). */
  readSettings?: (surauId: string) => Settings;
  firstDelayMs?: number;
  intervalMs?: number;
}

export interface PrayerAutoFetch {
  runOnce: (surauId: string) => Promise<AutoFetchOutcome>;
  /** One round over every surau of `surauIds()`, one after the other. */
  runAll: () => Promise<void>;
  start: () => void;
  stop: () => void;
  status: (surauId: string) => AutoFetchStatus;
  /** Drop what is kept in memory for a surau that was deleted (its status entry); a later round no longer visits it. */
  forget: (surauId: string) => void;
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
  const readSettings = o.readSettings ?? ((surauId: string) => getSettings(db, surauId));
  interface PerSurau { lastAttemptAt: string | null; lastOk: boolean | null; lastError: string | undefined; running: boolean; zone: string | undefined }
  const states = new Map<string, PerSurau>();
  const stateOf = (surauId: string): PerSurau => {
    let st = states.get(surauId);
    if (st === undefined) {
      st = { lastAttemptAt: null, lastOk: null, lastError: undefined, running: false, zone: undefined };
      states.set(surauId, st);
    }
    return st;
  };
  let first: NodeJS.Timeout | null = null;
  let every: NodeJS.Timeout | null = null;
  let stopped = false;

  const enabledNow = (surauId: string): boolean => {
    try {
      return readSettings(surauId).zone.autoFetch !== false;
    } catch {
      return false;
    }
  };

  /** First year, current then next, that lacks days from today on; null when both are complete. */
  function targetYear(zone: string, today: string, surauId: string): number | null {
    const thisYear = Number(today.slice(0, 4));
    for (const year of [thisYear, thisYear + 1]) {
      const from = year === thisYear ? today : `${year}-01-01`;
      const expected = (isLeap(year) ? 366 : 365) - dayOfYear(from) + 1;
      const have = (db
        .prepare('SELECT COUNT(*) AS n FROM prayer_days WHERE surau_id = ? AND zone = ? AND date >= ? AND date <= ?')
        .get(surauId, zone, from, `${year}-12-31`)?.n ?? 0) as number;
      if (Number(have) < expected) return year;
    }
    return null;
  }

  async function runOnce(surauId: string): Promise<AutoFetchOutcome> {
    const st = stateOf(surauId);
    if (st.running) return { ran: false };
    st.running = true;
    try {
      const settings = readSettings(surauId);
      if (settings.zone.autoFetch === false) return { ran: false };
      // Only a country with an official source has anything to fetch (Malaysia: JAKIM).
      if (!hasOfficialSource(settings.location.country)) return { ran: false };
      const zone = settings.zone.zone;
      if (typeof zone !== 'string' || !ZONE.test(zone)) return { ran: false };
      if (o.skipSurau?.(surauId) === true) return { ran: false };
      // The state is the zone's: a new zone starts clean.
      if (st.zone !== undefined && st.zone !== zone) { st.lastAttemptAt = null; st.lastOk = null; st.lastError = undefined; }
      st.zone = zone;
      const today = dateOf(now(), tzOf(settings));
      if (countDaysFrom(db, zone, today, surauId) >= AUTO_FETCH_BELOW_DAYS) return { ran: false };
      const year = targetYear(zone, today, surauId);
      if (year === null) return { ran: false };

      st.lastAttemptAt = now().toISOString();
      try {
        const days = (await fetchEsolatYear(db, zone, year, fetchImpl, surauId)).filter((d) => d.date >= today);
        const source = String(sourceName(db, surauId));
        const result = importDays(db, zone, days, AUTO_FETCH_ACTOR, undefined, {
          insertOnly: true,
          summary: (n) => `Data waktu solat dimuat turun secara automatik dari ${source}: ${n} hari ditambah`,
        }, surauId);
        st.lastOk = true;
        st.lastError = undefined;
        if (result.inserted > 0) {
          try {
            o.onChanged?.(getVersion(db, surauId), surauId);
          } catch {
            // A listener must not turn a good fetch into a failure.
          }
        }
        return { ran: true, ok: true, added: result.inserted, year };
      } catch (error) {
        st.lastOk = false;
        st.lastError = safeReason(error);
        console.warn(`Auto prayer fetch for ${zone} ${year} failed: ${st.lastError}`);
        return { ran: true, ok: false, year };
      }
    } catch (error) {
      // Reading the settings or the database failed (for example while closing).
      st.lastAttemptAt = now().toISOString();
      st.lastOk = false;
      st.lastError = safeReason(error);
      console.warn(`Auto prayer fetch failed: ${st.lastError}`);
      return { ran: true, ok: false, year: 0 };
    } finally {
      st.running = false;
    }
  }

  async function runAll(): Promise<void> {
    let ids: string[] = [];
    try {
      ids = o.surauIds();
    } catch {
      return;
    }
    for (const id of ids) {
      if (stopped) return;
      await runOnce(id).catch(() => undefined);
    }
  }

  const tick = (): void => {
    if (stopped) return;
    void runAll();
  };

  return {
    runOnce,
    runAll,
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
    forget(surauId: string) {
      states.delete(surauId);
    },
    status(surauId: string) {
      const st = stateOf(surauId);
      let zoneNow: string | undefined;
      try {
        const z = readSettings(surauId).zone.zone;
        zoneNow = typeof z === 'string' ? z : undefined;
      } catch {
        zoneNow = undefined;
      }
      if (st.zone !== undefined && zoneNow !== undefined && st.zone !== zoneNow) {
        return { enabled: enabledNow(surauId), lastAttemptAt: null, lastOk: null, zone: zoneNow };
      }
      return {
        enabled: enabledNow(surauId),
        ...(st.zone !== undefined ? { zone: st.zone } : {}),
        lastAttemptAt: st.lastAttemptAt,
        lastOk: st.lastOk,
        ...(st.lastError !== undefined ? { lastError: st.lastError } : {}),
      };
    },
  };
}

function sourceName(db: DatabaseSync, surauId: string): string {
  const name = getSettings(db, surauId).dataSources.esolat.name;
  return typeof name === 'string' && name.trim() !== '' ? name : 'e-Solat';
}
