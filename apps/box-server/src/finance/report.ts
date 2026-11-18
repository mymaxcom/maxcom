/** The monthly report as data: a pure function of the ledger rows plus names, frozen when a month is closed. */
import type { DatabaseSync } from 'node:sqlite';
import { isMonthReport, monthReport } from '@surau/core';
import type { MonthReport } from '@surau/core';
import { getItem } from '../content/store.ts';
import { allEntries, lateEntryIds, listFunds, listPerihal, monthReportJson, monthStatus } from './store.ts';

export function syncedUntilOf(db: DatabaseSync, role: 'box' | 'cloud'): string | null {
  if (role !== 'box') return null;
  const r = db.prepare("SELECT value FROM sync_state WHERE key = 'last_push'").get();
  return r !== undefined && typeof r.value === 'string' && r.value !== '' ? r.value : null;
}

function compute(db: DatabaseSync, ym: string, now: Date, role: 'box' | 'cloud', status: 'open' | 'closed', surauId: string): MonthReport {
  const entries = allEntries(db, surauId);
  const kuliahTitles: Record<string, string> = {};
  const kuliahDates: Record<string, string> = {};
  for (const e of entries) {
    if (e.kuliahId !== null && kuliahTitles[e.kuliahId] === undefined) {
      const k = getItem(db, 'kuliah', e.kuliahId, surauId);
      if (k !== null) {
        kuliahTitles[e.kuliahId] = (k.topic ?? '').trim() !== '' ? (k.topic as string) : k.label;
        kuliahDates[e.kuliahId] = k.date;
      }
    }
  }
  return monthReport({
    ym, entries, funds: listFunds(db, { includeArchived: true }, surauId), perihal: listPerihal(db, { includeArchived: true }, surauId),
    kuliahTitles, kuliahDates, now: now.toISOString(), syncedUntil: syncedUntilOf(db, role), status,
  });
}

/**
 * A closed month answers with the report as it was when it was closed (names and figures frozen, byte for byte);
 * an open month is computed now from the current rows and names.
 */
export function reportFor(db: DatabaseSync, ym: string, now: Date, role: 'box' | 'cloud', surauId: string): MonthReport {
  const report = reportForBase(db, ym, now, role, surauId);
  if (report.status !== 'closed') return report;
  // entries that arrived after the close are named beside the frozen figures, never inside them
  const late = lateEntryIds(db, ym, surauId);
  return late.length === 0 ? report : { ...report, lateEntries: late };
}

function reportForBase(db: DatabaseSync, ym: string, now: Date, role: 'box' | 'cloud', surauId: string): MonthReport {
  if (monthStatus(db, ym, surauId) === 'closed') {
    const frozen = monthReportJson(db, ym, surauId);
    if (frozen !== null) {
      try {
        const parsed: unknown = JSON.parse(frozen);
        if (isMonthReport(parsed)) return parsed;
      } catch {
        /* a damaged or wrong-shaped copy falls through to a fresh computation */
      }
    }
    return compute(db, ym, now, role, 'closed', surauId);
  }
  return compute(db, ym, now, role, 'open', surauId);
}

/** The JSON stored when a month is closed. */
export function freezeReport(db: DatabaseSync, ym: string, now: Date, role: 'box' | 'cloud', surauId: string): string {
  return JSON.stringify(compute(db, ym, now, role, 'closed', surauId));
}
