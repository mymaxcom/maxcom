import type { DatabaseSync } from 'node:sqlite';
import { checkPrayerDay } from '@surau/core';
import type { FeedEntry, PrayerDay, PrayerName } from '@surau/core';
import { CorrectionError, isPrayerName, isRealDate, putCorrectionIn, removeCorrectionIn } from '../prayer/corrections.ts';
import { IMPORT_ID_RE, restoreRows } from '../prayer/importFile.ts';
import { importDaysIn } from '../prayerStore.ts';
import { bumpVersion } from '../settingsStore.ts';
import type { ChangeMeta } from './meta.ts';
import { logSyncRefusal } from './verify.ts';

/**
 * Applying the three prayer feed entities replicated between a box and its cloud (Plan 13 Task 11):
 * `prayer:official` (a zone's year of official days), `prayer:import` (a surau's timetable file import, or its
 * undo) and `prayer:correction`. Every payload is validated like a fresh import (real dates, ordered times,
 * bounded counts); a bad one is refused and logged, never half-applied. Latest edit wins per entity; an entry
 * whose revision is already held changes nothing. A calculated day never travels, so none is handled here.
 * The caller holds the transaction.
 */

export interface PrayerApplyResult { status: 'applied' | 'duplicate' | 'superseded' | 'refused'; reason: 'invalid' | null }

const ZONE = /^[A-Z]{3}\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const SOLAT = ['subuh', 'zohor', 'asar', 'maghrib', 'isyak'] as const;
const PRAYERS: readonly PrayerName[] = ['imsak', 'subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak'];
const MAX_IMPORT_DAYS = 20_000;
const FILE_NAME = /^[A-Za-z0-9 ._()-]{1,120}$/;
const ACTOR = /^[A-Za-z0-9:_@.|-]{1,120}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

type Plain = Record<string, unknown>;
const plain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);
const int = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

class Bad extends Error {}

/** A stored day rebuilt from only the fields we know, or a throw. */
function validDay(raw: unknown): PrayerDay {
  if (!plain(raw)) throw new Bad('day');
  if (typeof raw.date !== 'string' || !isRealDate(raw.date)) throw new Bad('date');
  const y = Number(raw.date.slice(0, 4));
  if (y < 2020 || y > 2100) throw new Bad('year');
  const h = raw.hijri;
  if (!plain(h) || !int(h.y, 1, 9999) || !int(h.m, 1, 12) || !int(h.d, 1, 30)) throw new Bad('hijri');
  if (!plain(raw.times)) throw new Bad('times');
  const times = {} as Record<PrayerName, string>;
  for (const p of PRAYERS) {
    const t = raw.times[p];
    if (typeof t !== 'string' || !TIME.test(t)) throw new Bad('time');
    times[p] = t;
  }
  const day: PrayerDay = { date: raw.date, hijri: { y: h.y, m: h.m, d: h.d }, times };
  if (checkPrayerDay(day) !== null) throw new Bad('order');
  if (raw.dhuha !== undefined) {
    if (typeof raw.dhuha !== 'string' || !TIME.test(raw.dhuha)) throw new Bad('dhuha');
    day.dhuha = raw.dhuha;
  }
  if (raw.imsakDerived !== undefined) {
    if (typeof raw.imsakDerived !== 'boolean') throw new Bad('imsakDerived');
    day.imsakDerived = raw.imsakDerived;
  }
  if (raw.overrides !== undefined) {
    if (!plain(raw.overrides)) throw new Bad('overrides');
    const ov: NonNullable<PrayerDay['overrides']> = {};
    if (raw.overrides.khutbahMinutes !== undefined) {
      if (!int(raw.overrides.khutbahMinutes, 0, 120)) throw new Bad('khutbah');
      ov.khutbahMinutes = raw.overrides.khutbahMinutes;
    }
    if (raw.overrides.iqamahMinutes !== undefined) {
      const im = raw.overrides.iqamahMinutes;
      if (!plain(im)) throw new Bad('iqamah');
      const out: Partial<Record<(typeof SOLAT)[number], number>> = {};
      for (const k of Object.keys(im)) {
        if (!(SOLAT as readonly string[]).includes(k) || !int(im[k], 0, 120)) throw new Bad('iqamah');
        out[k as (typeof SOLAT)[number]] = im[k] as number;
      }
      ov.iqamahMinutes = out;
    }
    day.overrides = ov;
  }
  return day;
}

/** Whether the entry is new, a repeat of what this side holds, or older than it. */
function verdict(db: DatabaseSync, entity: string, id: string, rev: string, editedAt: string): 'new' | 'duplicate' | 'superseded' {
  const row = db
    .prepare('SELECT rev, edited_at FROM change_log WHERE entity = ? AND entity_id = ? AND rev IS NOT NULL ORDER BY id DESC LIMIT 1')
    .get(entity, id);
  if (!row) return 'new';
  if (row.rev === rev) return 'duplicate';
  const at = typeof row.edited_at === 'string' ? row.edited_at : '';
  if (at > editedAt) return 'superseded';
  if (at === editedAt && String(row.rev) > rev) return 'superseded';
  return 'new';
}

interface Stamp { id: string; createdAt: string }
const newer = (a: Stamp, b: Stamp): boolean => a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);

/** The (created_at, id) stamp of a held import; an import this side does not hold sorts before every other. */
function stampOf(db: DatabaseSync, id: string): Stamp {
  const r = db.prepare('SELECT created_at FROM prayer_imports WHERE id = ?').get(id);
  return { id, createdAt: r && typeof r.created_at === 'string' ? r.created_at : '' };
}

/**
 * Puts one replicated import row on its date so that a box and a cloud that apply the same imports in either
 * order end identical. A date owned by a later import (created_at, id) keeps its owner; the skipped row becomes the
 * owner's previous when it is newer than the one recorded, so undoing the owner restores the same thing on both
 * sides. A date owned by an earlier import is replaced, and its previous is the newer of the entry's own previous
 * and the owner it replaced.
 */
function placeFileDay(
  db: DatabaseSync, imp: Stamp, row: { day: PrayerDay; prevImportId: string | null; prevJson: string | null },
): void {
  const date = row.day.date;
  const json = JSON.stringify(row.day);
  const owner = db.prepare('SELECT import_id, json, prev_import_id, prev_json FROM prayer_file_days WHERE date = ?').get(date);
  if (owner && String(owner.import_id) !== imp.id) {
    const ownerId = String(owner.import_id);
    if (newer(stampOf(db, ownerId), imp)) {
      const prev = typeof owner.prev_import_id === 'string' && typeof owner.prev_json === 'string' ? stampOf(db, owner.prev_import_id) : null;
      if (prev === null || newer(imp, prev)) {
        db.prepare('UPDATE prayer_file_days SET prev_import_id = ?, prev_json = ? WHERE date = ?').run(imp.id, json, date);
      }
      return;
    }
    const own = stampOf(db, ownerId);
    const ownPrev = row.prevImportId !== null && row.prevJson !== null ? stampOf(db, row.prevImportId) : null;
    if (ownPrev === null || newer(own, ownPrev)) {
      row = { day: row.day, prevImportId: ownerId, prevJson: String(owner.json) };
    }
  }
  db.prepare(
    `INSERT INTO prayer_file_days (date, import_id, json, prev_import_id, prev_json) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET import_id = excluded.import_id, json = excluded.json,
       prev_import_id = excluded.prev_import_id, prev_json = excluded.prev_json`,
  ).run(date, imp.id, json, row.prevImportId, row.prevJson);
}

export function applyPrayerEntry(db: DatabaseSync, e: FeedEntry, meta: ChangeMeta, now: Date): PrayerApplyResult {
  const refuse = (): PrayerApplyResult => {
    logSyncRefusal(db, now, { deviceId: e.deviceId }, `prayer_bad_payload:${e.entity}`);
    return { status: 'refused', reason: 'invalid' };
  };
  const editedAt = meta.editedAt as string;
  const rev = meta.rev as string;
  try {
    if (e.entity === 'prayer:official') {
      const a = e.after;
      if (!plain(a) || typeof a.zone !== 'string' || !ZONE.test(a.zone) || !int(a.year, 2020, 2100)) return refuse();
      if (e.entityId !== `${a.zone}:${a.year}` || typeof a.fetchedAt !== 'string' || !ISO.test(a.fetchedAt)) return refuse();
      if (!Array.isArray(a.days) || a.days.length < 1 || a.days.length > 366) return refuse();
      const days = a.days.map(validDay);
      const seen = new Set<string>();
      for (const d of days) {
        if (!d.date.startsWith(`${a.year}-`) || seen.has(d.date)) return refuse();
        seen.add(d.date);
      }
      const v = verdict(db, 'prayer:official', e.entityId, rev, editedAt);
      if (v !== 'new') return { status: v, reason: null };
      importDaysIn(db, a.zone, days, e.actor, e.deviceId ?? undefined, { meta });
      return { status: 'applied', reason: null };
    }

    if (e.entity === 'prayer:correction') {
      const m = /^(\d{4}-\d{2}-\d{2})\|([a-z]+)$/.exec(e.entityId);
      if (!m || !isRealDate(m[1]) || !isPrayerName(m[2])) return refuse();
      const date = m[1]!;
      const prayer = m[2]!;
      const v = verdict(db, 'prayer:correction', e.entityId, rev, editedAt);
      if (v !== 'new') return { status: v, reason: null };
      if (e.after === null) {
        removeCorrectionIn(db, date, prayer, e.actor, e.deviceId ?? undefined, now, { meta });
        return { status: 'applied', reason: null };
      }
      const a = e.after;
      if (!plain(a) || a.date !== date || a.prayer !== prayer) return refuse();
      if (a.officialAtCorrection !== undefined && a.officialAtCorrection !== null && !(typeof a.officialAtCorrection === 'string' && TIME.test(a.officialAtCorrection))) return refuse();
      putCorrectionIn(db, { date, prayer, time: a.time as string, reason: a.reason as string }, e.actor, e.deviceId ?? undefined, now, null,
        { meta, officialAtCorrection: (a.officialAtCorrection as string | null | undefined) ?? null });
      return { status: 'applied', reason: null };
    }

    if (e.entity === 'prayer:import') {
      if (!IMPORT_ID_RE.test(e.entityId) || !plain(e.after) || !plain(e.after.record) || !Array.isArray(e.after.days)) return refuse();
      const r = e.after.record;
      const okRecord = r.id === e.entityId && (r.kind === 'csv' || r.kind === 'xlsx') && typeof r.fileName === 'string' && FILE_NAME.test(r.fileName)
        && typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.sha256) && int(r.rows, 0, MAX_IMPORT_DAYS)
        && typeof r.dateFrom === 'string' && isRealDate(r.dateFrom) && typeof r.dateTo === 'string' && isRealDate(r.dateTo)
        && (r.overlap === 'replace' || r.overlap === 'keep' || r.overlap === 'fillEmpty')
        && int(r.inserted, 0, MAX_IMPORT_DAYS) && int(r.replaced, 0, MAX_IMPORT_DAYS) && int(r.skipped, 0, MAX_IMPORT_DAYS)
        && typeof r.actor === 'string' && ACTOR.test(r.actor) && typeof r.createdAt === 'string' && ISO.test(r.createdAt)
        && (r.undoneAt === null || (typeof r.undoneAt === 'string' && ISO.test(r.undoneAt)))
        && (r.undoneBy === null || (typeof r.undoneBy === 'string' && ACTOR.test(r.undoneBy)));
      if (!okRecord || (r.dateFrom as string) > (r.dateTo as string)) return refuse();
      const undone = r.undoneAt !== null;
      if (e.after.days.length > MAX_IMPORT_DAYS) return refuse();
      const rows: Array<{ day: PrayerDay; prevImportId: string | null; prevJson: string | null }> = [];
      if (!undone) {
        for (const d of e.after.days) {
          if (!plain(d)) return refuse();
          const day = validDay(d.json);
          if (d.date !== day.date) return refuse();
          if (day.date < (r.dateFrom as string) || day.date > (r.dateTo as string)) return refuse();
          const prevId = d.prevImportId;
          if (prevId !== null && !(typeof prevId === 'string' && IMPORT_ID_RE.test(prevId))) return refuse();
          const prev = d.prevJson === null || d.prevJson === undefined ? null : validDay(d.prevJson);
          rows.push({ day, prevImportId: prev === null ? null : (prevId as string | null), prevJson: prev === null ? null : JSON.stringify(prev) });
        }
        if (new Set(rows.map((x) => x.day.date)).size !== rows.length) return refuse();
      }
      const v = verdict(db, 'prayer:import', e.entityId, rev, editedAt);
      if (v !== 'new') return { status: v, reason: null };
      db.prepare(
        `INSERT INTO prayer_imports (id, kind, file_name, sha256, rows, date_from, date_to, overlap, inserted, replaced, skipped, actor, device_id, created_at, undone_at, undone_by, rev, edited_at, origin, arrived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET undone_at = excluded.undone_at, undone_by = excluded.undone_by, rev = excluded.rev,
           edited_at = excluded.edited_at, origin = excluded.origin`,
      ).run(...([r.id, r.kind, r.fileName, r.sha256, r.rows, r.dateFrom, r.dateTo, r.overlap, r.inserted, r.replaced, r.skipped, r.actor,
        e.deviceId ?? null, r.createdAt, r.undoneAt, r.undoneBy, rev, editedAt, meta.origin ?? 'cloud', now.toISOString()] as Array<string | number | null>));
      if (undone) {
        restoreRows(db, e.entityId);
      } else {
        for (const row of rows) placeFileDay(db, { id: e.entityId, createdAt: r.createdAt as string }, row);
      }
      db.prepare(
        `INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json, device_id, edited_at, rev, origin, synced_at)
         VALUES (?, ?, 'prayer:import', ?, NULL, ?, ?, ?, ?, ?, ?)`,
      ).run(editedAt, e.actor, e.entityId, JSON.stringify(e.after), e.deviceId ?? null, editedAt, rev, meta.origin ?? 'cloud', meta.syncedAt ?? null);
      bumpVersion(db);
      return { status: 'applied', reason: null };
    }
  } catch (error) {
    if (error instanceof Bad || error instanceof CorrectionError) return refuse();
    throw error;
  }
  return refuse();
}
