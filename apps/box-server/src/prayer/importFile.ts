import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hasOfficialSource, hijriOf } from '@surau/core';
import type { PrayerDay, PrayerName, Settings } from '@surau/core';
import { bumpVersion } from '../settingsStore.ts';
import { revOf } from '../sync/meta.ts';
import { computeDay, located } from './calc.ts';
import { addDays, daysBetween, PRAYER_NAMES } from './resolve.ts';
import type { CrossCheck } from './resolve.ts';
import { isRealDate } from './corrections.ts';

export type Overlap = 'replace' | 'keep' | 'fillEmpty';
export const OVERLAPS: readonly Overlap[] = ['replace', 'keep', 'fillEmpty'];
export type FileFormat = 'esolat-csv' | 'template-csv' | 'xlsx' | 'unknown';

export const MAX_CSV_BYTES = 1024 * 1024;
export const MAX_XLSX_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 20_000;
const MAX_ERRORS = 100;
const MIN_YEAR = 2020;
const MAX_YEAR = 2100;

/** A refusal with a status the route passes on. */
export class ImportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ImportError';
    this.status = status;
  }
}

export const sha256Of = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const IMPORT_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export function newImportId(now: Date): string {
  let t = now.getTime();
  let head = '';
  for (let i = 0; i < 10; i++) { head = CROCKFORD[t % 32]! + head; t = Math.floor(t / 32); }
  const rnd = randomBytes(16);
  let tail = '';
  for (let i = 0; i < 16; i++) tail += CROCKFORD[rnd[i]! % 32];
  return head + tail;
}

// ---- reading a CSV into rows ----

export interface CsvRows { rows: string[][]; numbers: number[] }

/** RFC 4180 style CSV with a detected delimiter. Comment lines (#) and blank lines are skipped but still counted for row numbers. */
export function parseCsvRows(text: string): CsvRows {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r\n|\n|\r/).find((l) => l.trim() !== '' && !l.trimStart().startsWith('#')) ?? '';
  const count = (ch: string): number => firstLine.split(ch).length - 1;
  const delim = count(';') > count(',') && count(';') >= count('\t') ? ';' : count('\t') > count(',') ? '\t' : ',';
  const rows: string[][] = [];
  const numbers: number[] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  let atLineStart = true;
  let skipLine = false;
  const endRow = (): void => {
    row.push(field);
    field = '';
    const blank = row.every((c) => c.trim() === '');
    if (!skipLine && !blank) {
      if (rows.length >= MAX_ROWS + 5) throw new ImportError(400, 'Fail terlalu besar: paling banyak 20,000 baris');
      rows.push(row);
      numbers.push(start);
    }
    row = [];
    atLineStart = true;
    skipLine = false;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (atLineStart) {
      start = line;
      atLineStart = false;
      if (src[i] === '#') skipLine = true;
    }
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      if (field.length > 2000) throw new ImportError(400, 'Sel terlalu panjang');
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRow();
      line++;
    } else {
      field += ch;
      if (!skipLine && field.length > 2000) throw new ImportError(400, 'Sel terlalu panjang');
    }
  }
  if (quoted) throw new ImportError(400, 'Fail CSV rosak: tanda petik tidak ditutup');
  if (field !== '' || row.length > 0) endRow();
  return { rows, numbers };
}

/** What kind of file this is: the e-Solat yearly CSV, the MAXCOM template CSV, an Excel workbook, or neither. */
export function detectFormat(content: string | Buffer): FileFormat {
  if (Buffer.isBuffer(content)) {
    return content.length >= 4 && content[0] === 0x50 && content[1] === 0x4b && content[2] === 3 && content[3] === 4 ? 'xlsx' : detectFormat(content.toString('utf8'));
  }
  const lines = content.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const first = lines.find((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
  if (first === undefined) return 'unknown';
  if (first.trim().toLowerCase().startsWith('tarikh miladi')) return 'esolat-csv';
  const head = first.split(/[,;\t]/)[0]!.replace(/^"|"$/g, '').trim().toLowerCase();
  return head === 'tarikh' || head === 'date' ? 'template-csv' : 'unknown';
}

// ---- reading the template rows ----

const ALIASES: Record<string, string> = {
  date: 'date', tarikh: 'date', imsak: 'imsak', subuh: 'subuh', fajr: 'subuh', syuruk: 'syuruk', sunrise: 'syuruk',
  dhuha: 'dhuha', zohor: 'zohor', dhuhr: 'zohor', asar: 'asar', asr: 'asar', maghrib: 'maghrib', isyak: 'isyak', isha: 'isyak',
  note: 'note', nota: 'note', jumaat_khutbah: 'jumaat_khutbah', iqamah_subuh: 'iqamah_subuh', iqamah_zohor: 'iqamah_zohor',
  iqamah_asar: 'iqamah_asar', iqamah_maghrib: 'iqamah_maghrib', iqamah_isyak: 'iqamah_isyak',
};
const REQUIRED = ['date', 'subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak'] as const;
const MASJID_ONLY = new Set(['jumaat_khutbah', 'iqamah_subuh', 'iqamah_zohor', 'iqamah_asar', 'iqamah_maghrib', 'iqamah_isyak']);
const pad = (n: number): string => String(n).padStart(2, '0');

function parseDateCell(s: string): string | null {
  const t = s.trim();
  let y: number; let m: number; let d: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t);
  if (r) { y = Number(r[1]); m = Number(r[2]); d = Number(r[3]); } else {
    r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
    if (!r) return null;
    d = Number(r[1]); m = Number(r[2]); y = Number(r[3]);
  }
  const out = `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
  return isRealDate(out) && y >= MIN_YEAR && y <= MAX_YEAR ? out : null;
}

function parseTimeCell(s: string): string | null {
  let t = s.trim();
  // A date-time in a date-styled cell, sitting in a time column, is read as its time of day.
  const dt = /^\d{4}-\d{2}-\d{2}[ T](\d{1,2}:\d{2}(?::\d{2})?)$/.exec(t);
  if (dt) t = dt[1]!;
  let m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (m) {
    const h = Number(m[1]); const mi = Number(m[2]);
    return h <= 23 && mi <= 59 && (m[3] === undefined || Number(m[3]) <= 59) ? `${pad(h)}:${pad(mi)}` : null;
  }
  m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(t);
  if (!m) return null;
  let h = Number(m[1]); const mi = Number(m[2]);
  if (h < 1 || h > 12 || mi > 59) return null;
  const pm = m[3]!.toLowerCase() === 'pm';
  if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
  return `${pad(h)}:${pad(mi)}`;
}

const toMin = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMin = (m: number): string => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

export interface ParseInfo { kind: 'surau' | 'masjid'; imsakMinutes: number }
export interface ParsedFile { days: PrayerDay[]; errors: { row: number; message: string }[]; columns: string[] }

/**
 * Turns rows of text into prayer days, or lists every problem with its row number (one error blocks the whole
 * file). Headers are accepted in Malay or English. `numbers` gives each row's number in the original file.
 */
export function parseTemplateRows(rows: string[][], info: ParseInfo, numbers?: number[]): ParsedFile {
  const errors: { row: number; message: string }[] = [];
  let rowBad = false;
  const err = (row: number, message: string): void => { rowBad = true; if (errors.length < MAX_ERRORS) errors.push({ row, message }); };
  const num = (i: number): number => numbers?.[i] ?? i + 1;
  const h = rows.findIndex((r) => ALIASES[(r[0] ?? '').trim().toLowerCase()] === 'date');
  if (h < 0) {
    return { days: [], errors: [{ row: rows.length > 0 ? num(0) : 1, message: 'lajur tarikh tiada (baris pertama mesti tajuk lajur)' }], columns: [] };
  }
  const header = rows[h]!.map((c) => ALIASES[c.trim().toLowerCase()]);
  const at = new Map<string, number>();
  header.forEach((k, i) => { if (k !== undefined && !at.has(k)) at.set(k, i); });
  const columns = [...at.keys()];
  for (const need of REQUIRED) if (!at.has(need)) err(num(h), `lajur ${need} tiada`);
  const masjidCols = columns.filter((c) => MASJID_ONLY.has(c));
  if (info.kind !== 'masjid' && masjidCols.length > 0) err(num(h), `lajur masjid sahaja: ${masjidCols.join(', ')}`);
  if (errors.length > 0) return { days: [], errors, columns };

  const cell = (r: string[], key: string): string => (at.has(key) ? (r[at.get(key)!] ?? '').trim() : '');
  const days: PrayerDay[] = [];
  const rowOf = new Map<string, number>();
  const seenDates = new Set<string>();
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.every((c) => c.trim() === '')) continue;
    const rn = num(i);
    rowBad = false;
    const date = parseDateCell(cell(r, 'date'));
    if (date === null) { err(rn, cell(r, 'date') === '' ? 'tarikh kosong' : `tarikh tidak sah "${cell(r, 'date').slice(0, 20)}"`); continue; }
    if (rowOf.has(date) || seenDates.has(date)) { err(rn, `tarikh berulang (${date})`); continue; }
    seenDates.add(date);
    rowOf.set(date, rn);
    const times: Partial<Record<PrayerName, string>> = {};
    for (const k of ['subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak'] as const) {
      const raw = cell(r, k);
      if (raw === '') { err(rn, `waktu ${k} kosong`); continue; }
      const t = parseTimeCell(raw);
      if (t === null) err(rn, `waktu ${k} tidak sah "${raw.slice(0, 12)}"`); else times[k] = t;
    }
    if (rowBad) continue;
    let imsakDerived = false;
    const rawImsak = cell(r, 'imsak');
    if (rawImsak === '') {
      const m = toMin(times.subuh!) - info.imsakMinutes;
      if (m < 0) { err(rn, 'imsak terbitan jatuh sebelum tengah malam'); continue; }
      times.imsak = fromMin(m);
      imsakDerived = true;
    } else {
      const t = parseTimeCell(rawImsak);
      if (t === null) { err(rn, `waktu imsak tidak sah "${rawImsak.slice(0, 12)}"`); continue; }
      times.imsak = t;
    }
    const all = times as Record<PrayerName, string>;
    const bad = orderError(all);
    if (bad !== null) { err(rn, bad); continue; }
    const day: PrayerDay = { date, hijri: hijriOf(date), times: all };
    if (imsakDerived) day.imsakDerived = true;
    const rawDhuha = cell(r, 'dhuha');
    if (rawDhuha !== '') {
      const t = parseTimeCell(rawDhuha);
      if (t === null) { err(rn, `waktu dhuha tidak sah "${rawDhuha.slice(0, 12)}"`); continue; }
      if (!(all.syuruk < t && t < all.zohor)) { err(rn, 'dhuha mesti antara syuruk dan zohor'); continue; }
      day.dhuha = t;
    }
    if (info.kind === 'masjid') {
      const ov: NonNullable<PrayerDay['overrides']> = {};
      const minutes = (key: string): number | null | undefined => {
        const raw = cell(r, key);
        if (raw === '') return undefined;
        const n = Number(raw);
        if (!/^\d{1,3}$/.test(raw) || !Number.isInteger(n) || n > 120) { err(rn, `${key} mesti nombor bulat 0 hingga 120`); return null; }
        return n;
      };
      const kh = minutes('jumaat_khutbah');
      if (typeof kh === 'number') ov.khutbahMinutes = kh;
      for (const p of ['subuh', 'zohor', 'asar', 'maghrib', 'isyak'] as const) {
        const v = minutes(`iqamah_${p}`);
        if (typeof v === 'number') (ov.iqamahMinutes ??= {})[p] = v;
      }
      if (rowBad) continue;
      if (ov.khutbahMinutes !== undefined || ov.iqamahMinutes !== undefined) day.overrides = ov;
    }
    days.push(day);
  }
  if (days.length === 0 && errors.length === 0) err(num(h), 'tiada baris waktu solat dalam fail');
  if (days.length > MAX_ROWS) err(num(h), 'terlalu banyak baris (paling banyak 20,000)');

  // no gaps inside the range
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : 1));
  // a row with its own error still counts as present, so one bad row does not also look like a gap
  const present = [...seenDates].sort();
  for (let i = 1; i < present.length; i++) {
    const gap = daysBetween(present[i - 1]!, present[i]!);
    if (gap > 1) err(rowOf.get(present[i]!)!, `jurang tarikh (${addDays(present[i - 1]!, 1)} tiada)`);
  }
  return { days: sorted, errors, columns };
}

function orderError(t: Record<PrayerName, string>): string | null {
  for (let i = 1; i < PRAYER_NAMES.length; i++) {
    const a = PRAYER_NAMES[i - 1]!; const b = PRAYER_NAMES[i]!;
    if (!(t[a] < t[b])) return `waktu tidak mengikut urutan (${a} ${t[a]} bukan sebelum ${b} ${t[b]})`;
  }
  return null;
}

// ---- dry run, apply, undo ----

interface Existing { official: Set<string>; file: Map<string, { importId: string; json: string }> }

function existingFor(db: DatabaseSync, settings: Settings, from: string, to: string): Existing {
  const official = new Set<string>();
  if (hasOfficialSource(settings.location.country) && /^[A-Z]{3}\d{2}$/.test(String(settings.zone.zone))) {
    for (const r of db.prepare('SELECT date FROM prayer_days WHERE zone = ? AND date >= ? AND date <= ?').all(String(settings.zone.zone), from, to)) official.add(String(r.date));
  }
  const file = new Map<string, { importId: string; json: string }>();
  for (const r of db.prepare(
    `SELECT f.date, f.import_id, f.json FROM prayer_file_days f JOIN prayer_imports i ON i.id = f.import_id
     WHERE i.undone_at IS NULL AND f.date >= ? AND f.date <= ?`).all(from, to)) {
    file.set(String(r.date), { importId: String(r.import_id), json: String(r.json) });
  }
  return { official, file };
}

/** The dates a choice writes: [date, replaces an existing file row]. */
function plan(days: PrayerDay[], ex: Existing, overlap: Overlap): { write: Array<{ day: PrayerDay; prev: { importId: string; json: string } | null }>; skipped: number } {
  const write: Array<{ day: PrayerDay; prev: { importId: string; json: string } | null }> = [];
  let skipped = 0;
  for (const day of days) {
    const prev = ex.file.get(day.date) ?? null;
    if (overlap === 'replace') write.push({ day, prev });
    else if (overlap === 'keep') { if (prev) skipped++; else write.push({ day, prev: null }); }
    else if (prev || ex.official.has(day.date)) skipped++;
    else write.push({ day, prev: null });
  }
  return { write, skipped };
}

const zeroes = (): Record<PrayerName, number> => ({ imsak: 0, subuh: 0, syuruk: 0, zohor: 0, asar: 0, maghrib: 0, isyak: 0 });

export interface DryRun {
  range: { from: string; to: string };
  rows: number;
  perMonth: Record<string, number>;
  firstWeek: PrayerDay[];
  lastWeek: PrayerDay[];
  overlaps: { official: number; file: number; calc: number };
  wouldWrite: { inserted: number; replaced: number; skipped: number };
  byChoice: Record<Overlap, { inserted: number; replaced: number; skipped: number }>;
  crossCheck: CrossCheck;
  /** The surau's source order puts the local calculation above the file, so this timetable would never be used. */
  fileShadowed: boolean;
}

/** True when a located surau lists `calc` above `file`: a calculated day always exists, so a file day is never reached. */
function fileShadowedBy(settings: Settings): boolean {
  const order = settings.prayerSources.sourceOrder as string[];
  const file = order.indexOf('file');
  const calc = order.indexOf('calc');
  return located(settings) && file >= 0 && calc >= 0 && calc < file;
}

/** What importing would do, written nowhere. Counts for all three overlap choices; `wouldWrite` is the chosen one. */
export function dryRun(db: DatabaseSync, settings: Settings, days: PrayerDay[], overlap: Overlap): DryRun {
  const from = days[0]!.date;
  const to = days[days.length - 1]!.date;
  const ex = existingFor(db, settings, from, to);
  const perMonth: Record<string, number> = {};
  let official = 0; let file = 0; let calc = 0;
  for (const d of days) {
    perMonth[d.date.slice(0, 7)] = (perMonth[d.date.slice(0, 7)] ?? 0) + 1;
    if (ex.official.has(d.date)) official++;
    if (ex.file.has(d.date)) file++;
    if (!ex.official.has(d.date) && !ex.file.has(d.date) && located(settings)) calc++;
  }
  const count = (o: Overlap): { inserted: number; replaced: number; skipped: number } => {
    const p = plan(days, ex, o);
    return { inserted: p.write.filter((w) => w.prev === null).length, replaced: p.write.filter((w) => w.prev !== null).length, skipped: p.skipped };
  };
  const byChoice = { replace: count('replace'), keep: count('keep'), fillEmpty: count('fillEmpty') };
  const cc: CrossCheck = { flagged: [], maxDiff: zeroes(), medianDiff: zeroes(), compared: 0 };
  if (located(settings)) {
    const per: Record<PrayerName, number[]> = { imsak: [], subuh: [], syuruk: [], zohor: [], asar: [], maghrib: [], isyak: [] };
    for (const d of days) {
      const c = computeDay(d.date, settings);
      if (!c) continue;
      cc.compared++;
      const diffs = zeroes();
      let over = false;
      for (const p of PRAYER_NAMES) {
        diffs[p] = toMin(d.times[p]) - toMin(c.times[p]);
        per[p].push(diffs[p]);
        cc.maxDiff[p] = Math.max(cc.maxDiff[p], Math.abs(diffs[p]));
        if (Math.abs(diffs[p]) > 2) over = true;
      }
      if (over) cc.flagged.push({ date: d.date, source: 'file', diffs });
    }
    for (const p of PRAYER_NAMES) {
      const s = [...per[p]].sort((a, b) => a - b);
      cc.medianDiff[p] = s.length === 0 ? 0 : Math.round(s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2);
    }
  }
  return {
    range: { from, to }, rows: days.length, perMonth, firstWeek: days.slice(0, 7), lastWeek: days.slice(-7),
    overlaps: { official, file, calc }, wouldWrite: byChoice[overlap], byChoice, crossCheck: cc,
    fileShadowed: fileShadowedBy(settings),
  };
}

export interface ImportInput { kind: 'csv' | 'xlsx'; fileName: string; sha256: string; days: PrayerDay[]; overlap: Overlap }
export interface ImportResult { id: string; inserted: number; replaced: number; skipped: number }

const recordOf = (r: Record<string, unknown>): ImportRecord => ({
  id: String(r.id), kind: String(r.kind) as 'csv' | 'xlsx', fileName: String(r.file_name), sha256: String(r.sha256), rows: Number(r.rows),
  dateFrom: String(r.date_from), dateTo: String(r.date_to), overlap: String(r.overlap) as Overlap, inserted: Number(r.inserted),
  replaced: Number(r.replaced), skipped: Number(r.skipped), actor: String(r.actor), createdAt: String(r.created_at),
  undoneAt: typeof r.undone_at === 'string' ? r.undone_at : null, undoneBy: typeof r.undone_by === 'string' ? r.undone_by : null,
});

export interface ImportRecord {
  id: string; kind: 'csv' | 'xlsx'; fileName: string; sha256: string; rows: number; dateFrom: string; dateTo: string; overlap: Overlap;
  inserted: number; replaced: number; skipped: number; actor: string; createdAt: string; undoneAt: string | null; undoneBy: string | null;
}

function logImport(db: DatabaseSync, at: string, actor: string, deviceId: string | undefined, record: ImportRecord, days: unknown[]): void {
  db.prepare(
    `INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json, device_id, edited_at, rev)
     VALUES (?, ?, 'prayer:import', ?, NULL, ?, ?, ?, ?)`,
  ).run(at, actor, record.id, JSON.stringify({ record, days }), deviceId ?? null, at, revOf(at, deviceId !== undefined ? { deviceId } : undefined));
}

/**
 * Writes one import for THIS surau: the record and its rows in one transaction, with what each row replaced kept
 * for undo. The caller has already shown the dry run and checked the file's checksum.
 */
export function applyImport(
  db: DatabaseSync, settings: Settings, input: ImportInput, actor: string, deviceId: string | undefined, now: Date,
): ImportResult {
  if (input.days.length === 0) throw new ImportError(400, 'Fail tiada hari');
  const from = input.days[0]!.date;
  const to = input.days[input.days.length - 1]!.date;
  const at = now.toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const ex = existingFor(db, settings, from, to);
    const p = plan(input.days, ex, input.overlap);
    if (p.write.length === 0) throw new ImportError(400, 'Tiada hari baharu untuk disimpan');
    const id = newImportId(now);
    const inserted = p.write.filter((w) => w.prev === null).length;
    const replaced = p.write.length - inserted;
    db.prepare(
      `INSERT INTO prayer_imports (id, kind, file_name, sha256, rows, date_from, date_to, overlap, inserted, replaced, skipped, actor, device_id, created_at, rev, edited_at, arrived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.kind, input.fileName, input.sha256, input.days.length, from, to, input.overlap, inserted, replaced, p.skipped, actor,
      deviceId ?? null, at, revOf(at, deviceId !== undefined ? { deviceId } : undefined), at, at);
    const up = db.prepare(
      `INSERT INTO prayer_file_days (date, import_id, json, prev_import_id, prev_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET import_id = excluded.import_id, json = excluded.json,
         prev_import_id = excluded.prev_import_id, prev_json = excluded.prev_json`,
    );
    const logged: unknown[] = [];
    for (const w of p.write) {
      const json = JSON.stringify(w.day);
      up.run(w.day.date, id, json, w.prev?.importId ?? null, w.prev?.json ?? null);
      logged.push({ date: w.day.date, json: w.day, prevImportId: w.prev?.importId ?? null, prevJson: w.prev ? JSON.parse(w.prev.json) : null });
    }
    const record = recordOf(db.prepare('SELECT * FROM prayer_imports WHERE id = ?').get(id)!);
    logImport(db, at, actor, deviceId, record, logged);
    bumpVersion(db);
    db.exec('COMMIT');
    return { id, inserted, replaced, skipped: p.skipped };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Gives back what an import's rows replaced (or removes them); returns one note per day. Inside the caller's transaction. */
export function restoreRows(db: DatabaseSync, id: string): Array<{ date: string; restoredFrom?: string; removed?: true }> {
  const rows = db.prepare('SELECT date, prev_import_id, prev_json FROM prayer_file_days WHERE import_id = ?').all(id);
  const touched: Array<{ date: string; restoredFrom?: string; removed?: true }> = [];
  for (const r of rows) {
    if (typeof r.prev_import_id === 'string' && typeof r.prev_json === 'string') {
      db.prepare('UPDATE prayer_file_days SET import_id = ?, json = ?, prev_import_id = NULL, prev_json = NULL WHERE date = ?')
        .run(r.prev_import_id, r.prev_json, String(r.date));
      touched.push({ date: String(r.date), restoredFrom: r.prev_import_id });
    } else {
      db.prepare('DELETE FROM prayer_file_days WHERE date = ?').run(String(r.date));
      touched.push({ date: String(r.date), removed: true });
    }
  }
  return touched;
}

export type UndoResult = { ok: true; restored: number } | { ok: false; reason: string };

/**
 * Takes an import back: its rows go, and any day it replaced returns to the earlier import's version. Refused,
 * with a reason, when a later import now owns days of its range or a correction was made after it.
 */
export function undoImport(db: DatabaseSync, id: string, actor: string, deviceId: string | undefined, now: Date): UndoResult {
  const at = now.toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const rec = db.prepare('SELECT * FROM prayer_imports WHERE id = ?').get(id);
    if (!rec) { db.exec('ROLLBACK'); return { ok: false, reason: 'Import tidak dijumpai' }; }
    if (typeof rec.undone_at === 'string') { db.exec('ROLLBACK'); return { ok: false, reason: 'Import ini sudah dibatalkan' }; }
    const from = String(rec.date_from);
    const to = String(rec.date_to);
    const later = db.prepare(
      `SELECT MIN(f.date) AS a, MAX(f.date) AS b, MIN(i.created_at) AS c FROM prayer_file_days f JOIN prayer_imports i ON i.id = f.import_id
       WHERE f.date >= ? AND f.date <= ? AND f.import_id <> ? AND (i.created_at > ? OR (i.created_at = ? AND i.id > ?)) AND i.undone_at IS NULL`,
    ).get(from, to, id, String(rec.created_at), String(rec.created_at), id);
    if (later && typeof later.a === 'string') {
      db.exec('ROLLBACK');
      return { ok: false, reason: `Hari ${later.a} hingga ${later.b} telah diganti oleh import ${String(later.c).slice(0, 10)}` };
    }
    // "After this import" is judged by when each reached THIS side, never by the stamp a replicated row carries
    // (a correction made elsewhere long before, arriving now, still counts as made after the import was here).
    const importHere = String(rec.arrived_at ?? rec.created_at);
    const corr = db.prepare(
      'SELECT MIN(date) AS a, MAX(date) AS b, MAX(COALESCE(arrived_at, created_at)) AS c FROM prayer_corrections WHERE date >= ? AND date <= ? AND COALESCE(arrived_at, created_at) > ?',
    ).get(from, to, importHere);
    if (corr && typeof corr.a === 'string') {
      db.exec('ROLLBACK');
      return { ok: false, reason: `Pembetulan dibuat pada ${String(corr.c).slice(0, 10)} untuk hari ${corr.a} hingga ${corr.b} selepas import ini` };
    }
    const touched = restoreRows(db, id);
    const rows = touched;
    db.prepare('UPDATE prayer_imports SET undone_at = ?, undone_by = ?, rev = ?, edited_at = ? WHERE id = ?')
      .run(at, actor, revOf(at, deviceId !== undefined ? { deviceId } : undefined), at, id);
    const record = recordOf(db.prepare('SELECT * FROM prayer_imports WHERE id = ?').get(id)!);
    logImport(db, at, actor, deviceId, record, touched);
    bumpVersion(db);
    db.exec('COMMIT');
    return { ok: true, restored: rows.length };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function listImports(db: DatabaseSync): ImportRecord[] {
  return db.prepare('SELECT * FROM prayer_imports ORDER BY created_at DESC, id DESC LIMIT 200').all().map(recordOf);
}

export function getImport(db: DatabaseSync, id: string): (ImportRecord & { days: PrayerDay[] }) | null {
  const r = db.prepare('SELECT * FROM prayer_imports WHERE id = ?').get(id);
  if (!r) return null;
  const days = db.prepare('SELECT json FROM prayer_file_days WHERE import_id = ? ORDER BY date').all(id).map((x) => JSON.parse(String(x.json)) as PrayerDay);
  return { ...recordOf(r), days };
}

/**
 * Every import in the shape of its feed entry (`record` plus the rows it now owns, with what each replaced) and
 * its edit stamp, for a snapshot. An undone import carries no rows.
 */
export function snapshotImports(db: DatabaseSync): Array<{ record: ImportRecord; days: unknown[]; editedAt: string; rev: string }> {
  // the newest 200 imports (older ones are the least likely to matter), applied oldest first
  return db.prepare('SELECT * FROM (SELECT * FROM prayer_imports ORDER BY created_at DESC, id DESC LIMIT 200) ORDER BY created_at, id').all().map((r) => {
    const record = recordOf(r);
    const editedAt = typeof r.edited_at === 'string' ? r.edited_at : (record.undoneAt ?? record.createdAt);
    const days = record.undoneAt !== null ? [] : db.prepare('SELECT date, json, prev_import_id, prev_json FROM prayer_file_days WHERE import_id = ? ORDER BY date').all(record.id).map((x) => ({
      date: String(x.date), json: JSON.parse(String(x.json)) as unknown, prevImportId: typeof x.prev_import_id === 'string' ? x.prev_import_id : null,
      prevJson: typeof x.prev_json === 'string' ? (JSON.parse(x.prev_json) as unknown) : null,
    }));
    return { record, days, editedAt, rev: typeof r.rev === 'string' ? r.rev : `${editedAt}|local` };
  });
}
