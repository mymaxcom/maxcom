import type { DatabaseSync } from 'node:sqlite';
import type { RefKind } from '@surau/core';
import { numberTaken, raiseCounters, renumberRow } from '../auth/ids.ts';
import type { IdRow } from './deviceSeen.ts';

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
export const MAX_PEOPLE_IDS = 5_000;
const tableOf = (kind: RefKind): 'users' | 'devices' => (kind === 'user' ? 'users' : 'devices');

export interface PeopleIdsAnswer {
  stored: number;
  /** Records whose number another record of the surau already holds on the cloud: the box renumbers them. */
  taken: Array<{ kind: RefKind; id: string }>;
  /** Records the cloud already numbered: that number is final, the box takes it. */
  adopt: Array<{ kind: RefKind; id: string; no: number; src: 'b' | 'c' }>;
}

function parseRows(v: unknown): IdRow[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_PEOPLE_IDS) return null;
  const out: IdRow[] = [];
  for (const r of v) {
    if (typeof r !== 'object' || r === null) return null;
    const { id, no } = r as Record<string, unknown>;
    if (typeof id !== 'string' || !ID_RE.test(id) || typeof no !== 'number' || !Number.isInteger(no) || no < 1 || no >= 1_000_000_000) return null;
    out.push({ id, no });
  }
  return out;
}

/**
 * Cloud, from the surau's PRIMARY site only: store the box's plain-series numbers on the cloud's rows of that surau
 * that have none (a number another record holds is `taken`; a row the cloud already numbered answers `adopt`). A
 * row the cloud has not seen yet is only checked against the numbers it holds. Returns null for a malformed body.
 */
export function settlePeopleIds(db: DatabaseSync, surauId: string, body: unknown): PeopleIdsAnswer | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const users = parseRows(b.users);
  const devices = parseRows(b.devices);
  if (users === null || devices === null) return null;
  const out: PeopleIdsAnswer = { stored: 0, taken: [], adopt: [] };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [kind, rows] of [['user', users], ['device', devices]] as const) {
      const table = tableOf(kind);
      for (const r of rows) {
        const row = db.prepare(`SELECT surau_id, no, no_src FROM ${table} WHERE id = ?`).get(r.id);
        if (row !== undefined && String(row.surau_id) !== surauId) continue;
        if (row === undefined) {
          if (numberTaken(db, surauId, kind, 'b', r.no, r.id)) out.taken.push({ kind, id: r.id });
        } else if (row.no === null) {
          if (numberTaken(db, surauId, kind, 'b', r.no, r.id)) out.taken.push({ kind, id: r.id });
          else {
            db.prepare(`UPDATE ${table} SET no = ?, no_src = 'b' WHERE id = ? AND no IS NULL`).run(r.no, r.id);
            out.stored += 1;
          }
        } else if (!(row.no_src === 'b' && Number(row.no) === r.no)) {
          out.adopt.push({ kind, id: r.id, no: Number(row.no), src: row.no_src === 'c' ? 'c' : 'b' });
        }
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return out;
}

/** The box's plain-series numbers, for `ids_push` (at most 5,000 of each kind, oldest first). */
export function localBoxIds(db: DatabaseSync): { users: IdRow[]; devices: IdRow[] } {
  const rows = (table: 'users' | 'devices', order: string): IdRow[] =>
    db
      .prepare(`SELECT id, no FROM ${table} WHERE no_src = 'b' AND no IS NOT NULL AND surau_id <> '*' ORDER BY ${order} LIMIT ?`)
      .all(MAX_PEOPLE_IDS)
      .map((r) => ({ id: String(r.id), no: Number(r.no) }));
  return { users: rows('users', 'created_at, id'), devices: rows('devices', 'enrolled_at, id') };
}

/** True while some local record still waits for an ID (a secondary box, or one the cloud has not numbered yet). */
export function hasUnnumbered(db: DatabaseSync): boolean {
  return (
    db.prepare("SELECT 1 AS x FROM users WHERE no IS NULL AND surau_id <> '*' LIMIT 1").get() !== undefined ||
    db.prepare("SELECT 1 AS x FROM devices WHERE no IS NULL AND surau_id <> '*' LIMIT 1").get() !== undefined
  );
}

/**
 * Box: take the cloud-series numbers the cloud holds, for rows that have none here (never replacing a number a row
 * already has). Returns how many rows took one.
 */
export function mergeCloudIds(db: DatabaseSync, ids: unknown): number {
  if (typeof ids !== 'object' || ids === null || Array.isArray(ids)) return 0;
  let n = 0;
  for (const [kind, key] of [['user', 'users'], ['device', 'devices']] as const) {
    const rows = parseRows((ids as Record<string, unknown>)[key]);
    if (rows === null) continue;
    for (const r of rows) {
      try {
        n += Number(db.prepare(`UPDATE ${tableOf(kind)} SET no = ?, no_src = 'c' WHERE id = ? AND no IS NULL AND surau_id <> '*'`).run(r.no, r.id).changes);
      } catch {
        /* a number this box already uses for another record: the box keeps what it has */
      }
    }
  }
  return n;
}

/** Box: act on the cloud's answer to `people-ids`: adopt final numbers, raise the counters, renumber what was taken. */
export function applyPeopleIdsAnswer(db: DatabaseSync, surauId: string, answer: unknown, maxNo: { user: number; device: number } | null): void {
  if (typeof answer !== 'object' || answer === null) return;
  const a = answer as Record<string, unknown>;
  if (maxNo !== null) raiseCounters(db, surauId, maxNo);
  if (Array.isArray(a.adopt)) {
    for (const r of a.adopt.slice(0, MAX_PEOPLE_IDS * 2)) {
      if (typeof r !== 'object' || r === null) continue;
      const { kind, id, no, src } = r as Record<string, unknown>;
      if ((kind !== 'user' && kind !== 'device') || typeof id !== 'string' || !ID_RE.test(id) || typeof no !== 'number' || !Number.isInteger(no) || no < 1 || (src !== 'b' && src !== 'c')) continue;
      try {
        db.prepare(`UPDATE ${tableOf(kind)} SET no = ?, no_src = ? WHERE id = ? AND surau_id <> '*'`).run(no, src, id);
      } catch {
        /* held by another local record: left as it is */
      }
    }
  }
  if (Array.isArray(a.taken)) {
    for (const r of a.taken.slice(0, MAX_PEOPLE_IDS * 2)) {
      if (typeof r !== 'object' || r === null) continue;
      const { kind, id } = r as Record<string, unknown>;
      if ((kind === 'user' || kind === 'device') && typeof id === 'string' && ID_RE.test(id)) renumberRow(db, kind, id);
    }
  }
}
