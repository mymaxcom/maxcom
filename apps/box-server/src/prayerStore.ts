import type { DatabaseSync } from 'node:sqlite';
import type { PrayerDay } from '@surau/core';
import { bumpVersion } from './settingsStore.ts';
import { revOf } from './sync/meta.ts';
import type { ChangeMeta } from './sync/meta.ts';

const ZONE = /^[A-Z]{3}\d{2}$/;

export interface ImportOptions {
  /** Add only dates that have no times yet; existing dates are never touched. */
  insertOnly?: boolean;
  /** BM summary stored with the audit entry; given the number of days added. */
  summary?: (inserted: number) => string;
  /**
   * Replication: the sync facts of the entry being applied (origin, edit time, rev). The change_log rows then carry
   * them, so the entry is not sent back to where it came from.
   */
  meta?: ChangeMeta;
}

export function importDays(
  db: DatabaseSync,
  zone: string,
  days: PrayerDay[],
  actor: string,
  deviceId: string | undefined,
  options: ImportOptions = {},
  surauId: string,
): { inserted: number; replaced: number } {
  if (!ZONE.test(zone)) throw new Error(`invalid zone "${zone}"`);
  if (days.length === 0) return { inserted: 0, replaced: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = importDaysIn(db, zone, days, actor, deviceId, options, surauId);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** `importDays` inside a transaction the caller already holds (replication applies an entry among other writes). */
export function importDaysIn(
  db: DatabaseSync,
  zone: string,
  days: PrayerDay[],
  actor: string,
  deviceId: string | undefined,
  options: ImportOptions = {},
  surauId: string,
): { inserted: number; replaced: number } {
  if (!ZONE.test(zone)) throw new Error(`invalid zone "${zone}"`);
  if (days.length === 0) return { inserted: 0, replaced: 0 };
  const now = options.meta?.editedAt ?? new Date().toISOString();
  const origin = options.meta?.origin ?? 'local';
  const syncedAt = options.meta?.syncedAt ?? null;
  {
    const existing = new Set(
      db.prepare('SELECT date FROM prayer_days WHERE surau_id = ? AND zone = ?').all(surauId, zone).map((row) => String(row.date)),
    );
    let inserted = 0;
    let replaced = 0;
    const upsert = db.prepare(
      `INSERT INTO prayer_days (surau_id, zone, date, json, fetched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(surau_id, zone, date) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`,
    );

    const writtenDates: string[] = [];
    const written: PrayerDay[] = [];
    for (const day of days) {
      if (existing.has(day.date)) {
        if (options.insertOnly) continue;
        replaced++;
      } else {
        inserted++;
        existing.add(day.date);
      }
      writtenDates.push(day.date);
      written.push(day);
      upsert.run(surauId, zone, day.date, JSON.stringify(day), now);
    }

    if (options.insertOnly && writtenDates.length === 0) {
      // Nothing new: no audit entry, no version bump.
      return { inserted: 0, replaced: 0 };
    }

    const dates = (options.insertOnly ? writtenDates : days.map((day) => day.date)).sort();
    const from = dates[0]!;
    const to = dates[dates.length - 1]!;
    db.prepare(
      `INSERT INTO change_log (surau_id, at, actor, entity, entity_id, before_json, after_json, device_id, origin, synced_at)
       VALUES (?, ?, ?, 'prayer_days', ?, NULL, ?, ?, ?, ?)`,
    ).run(surauId, now, actor, zone, JSON.stringify({
        count: dates.length,
        from,
        to,
        ...(options.summary ? { summary: options.summary(inserted) } : {}),
      }), deviceId ?? null, origin, syncedAt);

    // The feed twin of the summary row above: the days themselves, per year, for replication to the cloud. A local
    // write carries the FULL stored list of each year it touched (an insert-only fetch of a few days still sends
    // the whole year, so the other side never ends with a partial one); an applied entry keeps what it received.
    const byYear = new Map<number, PrayerDay[]>();
    for (const day of written) {
      const y = Number(day.date.slice(0, 4));
      const list = byYear.get(y);
      if (list) list.push(day); else byYear.set(y, [day]);
    }
    for (const [year, list] of [...byYear].sort((a, b) => a[0] - b[0])) {
      const full = options.meta === undefined ? storedYear(db, zone, year, surauId) : list;
      writeOfficialTwin(db, { zone, year, days: full, actor, deviceId, now, rev: options.meta?.rev, origin, syncedAt, surauId });
    }

    bumpVersion(db, surauId);
    return { inserted, replaced };
  }
}

/**
 * Undo of an official CSV load, inside the caller's transaction: the dates it added are removed and the days it
 * replaced are put back. A year that still holds days is sent again in full (the cloud only ever adds or replaces
 * days, so a day removed here is not removed there; a later fetch or load corrects it).
 */
export function restoreOfficialDaysIn(
  db: DatabaseSync, zone: string, removeDates: string[], restore: PrayerDay[], actor: string, deviceId: string | undefined,
  now: string, surauId: string,
): void {
  const del = db.prepare('DELETE FROM prayer_days WHERE surau_id = ? AND zone = ? AND date = ?');
  for (const date of removeDates) del.run(surauId, zone, date);
  const upsert = db.prepare(
    `INSERT INTO prayer_days (surau_id, zone, date, json, fetched_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(surau_id, zone, date) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`,
  );
  for (const day of restore) upsert.run(surauId, zone, day.date, JSON.stringify(day), now);
  const dates = [...removeDates, ...restore.map((d) => d.date)].sort();
  if (dates.length === 0) return;
  db.prepare(
    `INSERT INTO change_log (surau_id, at, actor, entity, entity_id, before_json, after_json, device_id, origin, synced_at)
     VALUES (?, ?, ?, 'prayer_days', ?, NULL, ?, ?, 'local', NULL)`,
  ).run(surauId, now, actor, zone, JSON.stringify({ count: dates.length, from: dates[0], to: dates[dates.length - 1], summary: 'Import e-Solat dibatalkan' }), deviceId ?? null);
  const years = new Set(dates.map((d) => Number(d.slice(0, 4))));
  for (const year of [...years].sort()) {
    const full = storedYear(db, zone, year, surauId);
    if (full.length > 0) writeOfficialTwin(db, { zone, year, days: full, actor, deviceId, now, rev: undefined, origin: 'local', syncedAt: null, surauId });
  }
}

/** Every stored day of one zone and year, in date order. */
function storedYear(db: DatabaseSync, zone: string, year: number, surauId: string): PrayerDay[] {
  return db.prepare('SELECT json FROM prayer_days WHERE surau_id = ? AND zone = ? AND date >= ? AND date <= ? ORDER BY date')
    .all(surauId, zone, `${year}-01-01`, `${year}-12-31`).map((r) => JSON.parse(String(r.json)) as PrayerDay);
}

function writeOfficialTwin(
  db: DatabaseSync,
  e: { zone: string; year: number; days: PrayerDay[]; actor: string; deviceId: string | undefined; now: string; rev: string | undefined; origin: string; syncedAt: string | null; surauId: string },
): void {
  db.prepare(
    `INSERT INTO change_log (surau_id, at, actor, entity, entity_id, before_json, after_json, device_id, edited_at, rev, origin, synced_at)
     VALUES (?, ?, ?, 'prayer:official', ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.surauId, e.now, e.actor, `${e.zone}:${e.year}`,
    JSON.stringify({ zone: e.zone, year: e.year, days: e.days, fetchedAt: e.now }),
    e.deviceId ?? null, e.now,
    e.rev ?? revOf(e.now, e.deviceId !== undefined ? { deviceId: e.deviceId } : undefined), e.origin, e.syncedAt,
  );
}

const BACKFILL_KEY = 'prayer_official_feed_backfill';

/**
 * A box that held official days before the replicated prayer data existed never sent them. Once, one `prayer:official`
 * entry per stored zone and year goes into the feed with the full stored list. Boxes only: the caller does not
 * run this on a cloud, which receives these days and must never generate them. A marker in `meta` makes a second
 * start write nothing. Returns the number of entries written.
 */
export function backfillOfficialFeed(db: DatabaseSync, now: Date, surauId: string): number {
  if (db.prepare('SELECT 1 FROM meta WHERE surau_id = ? AND key = ?').get(surauId, BACKFILL_KEY) !== undefined) return 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    let n = 0;
    const at = now.toISOString();
    for (const zone of officialZones(db, surauId)) {
      for (const y of officialYears(db, zone, surauId)) {
        writeOfficialTwin(db, { zone, year: y.year, days: y.days, actor: 'system:backfill', deviceId: undefined, now: y.fetchedAt ?? at, rev: undefined, origin: 'local', syncedAt: null, surauId });
        n++;
      }
    }
    db.prepare('INSERT OR REPLACE INTO meta (surau_id, key, value) VALUES (?, ?, ?)').run(surauId, BACKFILL_KEY, at);
    if (n > 0) bumpVersion(db, surauId);
    db.exec('COMMIT');
    return n;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getDays(db: DatabaseSync, zone: string, from: string, to: string, surauId: string): PrayerDay[] {
  const rows = db
    .prepare('SELECT json FROM prayer_days WHERE surau_id = ? AND zone = ? AND date >= ? AND date <= ? ORDER BY date')
    .all(surauId, zone, from, to);
  return rows.map((row) => JSON.parse(String(row.json)) as PrayerDay);
}

export function countDaysFrom(db: DatabaseSync, zone: string, from: string, surauId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM prayer_days WHERE surau_id = ? AND zone = ? AND date >= ?')
    .get(surauId, zone, from);
  return row === undefined ? 0 : Number(row.n);
}

export interface OfficialYear { year: number; days: PrayerDay[]; fetchedAt: string | null }

/** Every stored year of one zone, with the day list and the latest fetch time (what the feed twin carries). */
export function officialYears(db: DatabaseSync, zone: string, surauId: string): OfficialYear[] {
  const rows = db
    .prepare('SELECT json, fetched_at FROM prayer_days WHERE surau_id = ? AND zone = ? ORDER BY date')
    .all(surauId, zone);
  const byYear = new Map<number, OfficialYear>();
  for (const row of rows) {
    const day = JSON.parse(String(row.json)) as PrayerDay;
    const year = Number(day.date.slice(0, 4));
    let entry = byYear.get(year);
    if (!entry) { entry = { year, days: [], fetchedAt: null }; byYear.set(year, entry); }
    entry.days.push(day);
    const at = typeof row.fetched_at === 'string' ? row.fetched_at : null;
    if (at !== null && (entry.fetchedAt === null || at > entry.fetchedAt)) entry.fetchedAt = at;
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

/** Zones that hold any official days. */
export function officialZones(db: DatabaseSync, surauId: string): string[] {
  return db.prepare('SELECT DISTINCT zone FROM prayer_days WHERE surau_id = ? ORDER BY zone').all(surauId).map((r) => String(r.zone));
}
