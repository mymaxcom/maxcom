import type { DatabaseSync } from 'node:sqlite';
import type { PrayerName } from '@surau/core';
import { bumpVersion } from '../settingsStore.ts';
import { revOf } from '../sync/meta.ts';
import type { ChangeMeta } from '../sync/meta.ts';
import type { CorrectionRow } from './resolve.ts';
import { PRAYER_NAMES } from './resolve.ts';

export class CorrectionError extends Error {
  readonly status: number;
  readonly errors: string[];
  constructor(status: number, errors: string[]) {
    super(errors.join('; '));
    this.name = 'CorrectionError';
    this.status = status;
    this.errors = errors;
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const REASON_RE = /^[^<>\x00-\x1f\x7f]+$/;

export function isRealDate(date: unknown): date is string {
  if (typeof date !== 'string') return false;
  const m = DATE_RE.exec(date);
  if (!m) return false;
  const y = Number(m[1]);
  const t = new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[3])));
  return t.getUTCFullYear() === y && t.getUTCMonth() === Number(m[2]) - 1 && t.getUTCDate() === Number(m[3]);
}

export function isPrayerName(p: unknown): p is PrayerName {
  return typeof p === 'string' && (PRAYER_NAMES as readonly string[]).includes(p);
}

export interface CorrectionInput {
  date: string;
  prayer: PrayerName;
  time: string;
  reason: string;
}

export function validateCorrection(input: { date: unknown; prayer: unknown; time: unknown; reason: unknown }): string[] {
  const errors: string[] = [];
  if (!isRealDate(input.date)) errors.push('date must be a real date like 2026-11-26');
  if (!isPrayerName(input.prayer)) errors.push('prayer must be one of imsak, subuh, syuruk, zohor, asar, maghrib, isyak');
  if (typeof input.time !== 'string' || !TIME_RE.test(input.time)) errors.push('time must look like 16:25 (24 hour)');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 3 || reason.length > 200 || !REASON_RE.test(reason)) {
    errors.push('reason must be 3 to 200 characters of plain text');
  }
  return errors;
}

function logRow(
  db: DatabaseSync, at: string, actor: string, deviceId: string | undefined, id: string,
  before: unknown, after: unknown, meta?: ChangeMeta,
): void {
  db.prepare(
    `INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json, device_id, edited_at, rev, origin, synced_at)
     VALUES (?, ?, 'prayer:correction', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    at, actor, id,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    deviceId ?? null, at, meta?.rev ?? revOf(at, deviceId !== undefined ? { deviceId } : undefined),
    meta?.origin ?? 'local', meta?.syncedAt ?? null,
  );
}

function rowOf(db: DatabaseSync, date: string, prayer: string): Record<string, unknown> | null {
  const r = db.prepare('SELECT * FROM prayer_corrections WHERE date = ? AND prayer = ?').get(date, prayer);
  if (!r) return null;
  return {
    date: r.date, prayer: r.prayer, time: r.time, reason: r.reason,
    officialAtCorrection: r.official_at_correction ?? null, actor: r.actor, createdAt: r.created_at,
  };
}

/** The official time of one prayer on one date from any stored zone of the box's setting, for the later "official changed" flag. */
function officialTime(db: DatabaseSync, zone: string | null, date: string, prayer: PrayerName): string | null {
  if (zone === null) return null;
  const r = db.prepare('SELECT json FROM prayer_days WHERE zone = ? AND date = ?').get(zone, date);
  if (!r) return null;
  try {
    const t = (JSON.parse(String(r.json)) as { times?: Record<string, string> }).times?.[prayer];
    return typeof t === 'string' ? t : null;
  } catch {
    return null;
  }
}

/** The most corrections a box holds from replication (a snapshot lists no more than this either). */
export const MAX_CORRECTION_ROWS = 20_000;

export interface CorrectionOptions {
  /** Replication: the sync facts of the entry being applied. */
  meta?: ChangeMeta;
  /** Replication: the official time recorded when the correction was made on the other side. */
  officialAtCorrection?: string | null;
}

/** Set or replace the correction of one prayer on one date. `zone` is the official zone to remember the original from. */
export function putCorrection(
  db: DatabaseSync, input: CorrectionInput, actor: string, deviceId: string | undefined, now: Date, zone: string | null = null,
  options: CorrectionOptions = {},
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    putCorrectionIn(db, input, actor, deviceId, now, zone, options);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** `putCorrection` inside a transaction the caller already holds. */
export function putCorrectionIn(
  db: DatabaseSync, input: CorrectionInput, actor: string, deviceId: string | undefined, now: Date, zone: string | null = null,
  options: CorrectionOptions = {},
): void {
  const errors = validateCorrection(input);
  if (errors.length > 0) throw new CorrectionError(400, errors);
  if (options.meta !== undefined) {
    // A replicated correction gets the same year window as a replicated day, and the table a ceiling.
    const y = Number(input.date.slice(0, 4));
    if (y < 2020 || y > 2100) throw new CorrectionError(400, ['date is outside 2020 to 2100']);
    if (rowOf(db, input.date, input.prayer) === null && Number(db.prepare('SELECT COUNT(*) AS n FROM prayer_corrections').get()!.n) >= MAX_CORRECTION_ROWS) {
      throw new CorrectionError(400, ['too many corrections']);
    }
  }
  const at = options.meta?.editedAt ?? now.toISOString();
  const before = rowOf(db, input.date, input.prayer);
  const original = options.officialAtCorrection !== undefined
    ? options.officialAtCorrection
    : before !== null ? (before.officialAtCorrection as string | null) : officialTime(db, zone, input.date, input.prayer);
  const rev = options.meta?.rev ?? revOf(at, deviceId !== undefined ? { deviceId } : undefined);
  db.prepare(
    `INSERT INTO prayer_corrections (date, prayer, time, reason, official_at_correction, actor, device_id, created_at, rev, edited_at, origin, arrived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date, prayer) DO UPDATE SET time = excluded.time, reason = excluded.reason,
       official_at_correction = excluded.official_at_correction, actor = excluded.actor, device_id = excluded.device_id,
       created_at = excluded.created_at, rev = excluded.rev, edited_at = excluded.edited_at, origin = excluded.origin,
       arrived_at = excluded.arrived_at`,
  ).run(input.date, input.prayer, input.time, input.reason.trim(), original, actor, deviceId ?? null, at, rev, at, options.meta?.origin ?? 'local', now.toISOString());
  logRow(db, at, actor, deviceId, `${input.date}|${input.prayer}`, before, rowOf(db, input.date, input.prayer), options.meta);
  bumpVersion(db);
}

/** Remove a correction; false when there was none. */
export function removeCorrection(
  db: DatabaseSync, date: string, prayer: PrayerName, actor: string, deviceId: string | undefined, now: Date,
  options: CorrectionOptions = {},
): boolean {
  db.exec('BEGIN IMMEDIATE');
  try {
    const removed = removeCorrectionIn(db, date, prayer, actor, deviceId, now, options);
    db.exec('COMMIT');
    return removed;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function removeCorrectionIn(
  db: DatabaseSync, date: string, prayer: PrayerName, actor: string, deviceId: string | undefined, now: Date,
  options: CorrectionOptions = {},
): boolean {
  if (!isRealDate(date) || !isPrayerName(prayer)) throw new CorrectionError(400, ['date or prayer is not valid']);
  const at = options.meta?.editedAt ?? now.toISOString();
  const before = rowOf(db, date, prayer);
  if (before === null) return false;
  db.prepare('DELETE FROM prayer_corrections WHERE date = ? AND prayer = ?').run(date, prayer);
  logRow(db, at, actor, deviceId, `${date}|${prayer}`, before, null, options.meta);
  bumpVersion(db);
  return true;
}

export function listCorrections(db: DatabaseSync, from: string, to: string): CorrectionRow[] {
  return db
    .prepare('SELECT date, prayer, time, reason, official_at_correction FROM prayer_corrections WHERE date >= ? AND date <= ? ORDER BY date, prayer')
    .all(from, to)
    .map((r) => ({
      date: String(r.date), prayer: String(r.prayer) as PrayerName, time: String(r.time), reason: String(r.reason),
      officialAtCorrection: typeof r.official_at_correction === 'string' ? r.official_at_correction : null,
    }));
}

/** Every correction with its edit stamp and writer, for a snapshot (the stamp is what a receiving box merges by). */
export function snapshotCorrections(db: DatabaseSync): Array<CorrectionRow & { editedAt: string; rev: string; actor: string }> {
  return db
    .prepare('SELECT date, prayer, time, reason, official_at_correction, actor, created_at, rev, edited_at FROM prayer_corrections ORDER BY date, prayer')
    .all()
    .map((r) => {
      const editedAt = typeof r.edited_at === 'string' ? r.edited_at : String(r.created_at);
      return {
        date: String(r.date), prayer: String(r.prayer) as PrayerName, time: String(r.time), reason: String(r.reason),
        officialAtCorrection: typeof r.official_at_correction === 'string' ? r.official_at_correction : null,
        editedAt, rev: typeof r.rev === 'string' ? r.rev : `${editedAt}|local`, actor: String(r.actor),
      };
    });
}
