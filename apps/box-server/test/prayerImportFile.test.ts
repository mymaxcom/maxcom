import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant, parseJakimCsv, resolveSettings } from '@surau/core';
import type { Settings } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { openXlsx } from '../src/files/xlsxRead.ts';
import { importDays } from '../src/prayerStore.ts';
import { putCorrection } from '../src/prayer/corrections.ts';
import {
  applyImport, detectFormat, dryRun, listImports, parseCsvRows, parseTemplateRows, sha256Of, undoImport,
} from '../src/prayer/importFile.ts';
import type { ParseInfo } from '../src/prayer/importFile.ts';
import { resolveDay } from '../src/prayer/resolve.ts';
import { csvTemplate, xlsxTemplate } from '../src/prayer/templates.ts';
import { loginAs } from './authHelpers.ts';
import { buildXlsx } from './support/zipBuild.ts';

const esolatCsv = readFileSync(fileURLToPath(new URL('../../../packages/core/test/fixtures/SGR01-2026.csv', import.meta.url)), 'utf8');
const official = parseJakimCsv(esolatCsv);
const HEAD = 'tarikh,imsak,subuh,syuruk,dhuha,zohor,asar,maghrib,isyak,nota';
const INFO: ParseInfo = { kind: 'surau', imsakMinutes: 10 };

function line(date: string, over: Partial<Record<string, string>> = {}): string {
  const v = { imsak: '04:40', subuh: '04:50', syuruk: '06:00', dhuha: '', zohor: '12:12', asar: '15:30', maghrib: '18:20', isyak: '19:30', nota: '', ...over };
  return [date, v.imsak, v.subuh, v.syuruk, v.dhuha, v.zohor, v.asar, v.maghrib, v.isyak, v.nota].join(',');
}
function csvOf(dates: string[], over: Record<string, Partial<Record<string, string>>> = {}): string {
  return [HEAD, ...dates.map((d) => line(d, over[d]))].join('\n');
}
const range = (from: string, n: number): string[] => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
const parse = (csv: string, info = INFO) => { const c = parseCsvRows(csv); return parseTemplateRows(c.rows, info, c.numbers); };

const dbs: DatabaseSync[] = [];
const newDb = (): DatabaseSync => { const d = openDb(':memory:'); dbs.push(d); return d; };
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });
const ke = (over: object = {}): Settings => resolveSettings({ location: { country: 'KE', timezone: 'Africa/Nairobi', latitude: -1.2921, longitude: 36.8219 }, prayerSources: { sourceOrder: ['file', 'calc', 'official'] }, ...over } as never);
const T0 = new Date('2026-11-10T01:00:00Z');
const T1 = new Date('2026-11-20T01:00:00Z');
const T2 = new Date('2026-11-25T01:00:00Z');

describe('parsing the template', () => {
  it('accepts Malay and English headers and day first dates', () => {
    const en = 'date,fajr,sunrise,dhuhr,asr,maghrib,isha\n2026-12-01,04:50,06:00,12:12,15:30,18:20,19:30\n02/12/2026,4:51 am,6:01 am,12:12 pm,3:30 pm,6:20 pm,7:30 pm';
    const r = parse(en);
    expect(r.errors).toEqual([]);
    expect(r.days.map((d) => d.date)).toEqual(['2026-12-01', '2026-12-02']);
    expect(r.days[1]!.times).toMatchObject({ subuh: '04:51', zohor: '12:12', isyak: '19:30' });
    expect(r.columns).toEqual(['date', 'subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak']);
  });
  it('derives a missing imsak and marks it', () => {
    const r = parse(csvOf(['2026-12-01'], { '2026-12-01': { imsak: '' } }));
    expect(r.days[0]!.times.imsak).toBe('04:40');
    expect(r.days[0]!.imsakDerived).toBe(true);
    const r2 = parse(csvOf(['2026-12-01']));
    expect(r2.days[0]!.imsakDerived).toBeUndefined();
  });
  it('keeps dhuha and checks it lies between syuruk and zohor', () => {
    expect(parse(csvOf(['2026-12-01'], { '2026-12-01': { dhuha: '06:25' } })).days[0]!.dhuha).toBe('06:25');
    expect(parse(csvOf(['2026-12-01'], { '2026-12-01': { dhuha: '13:00' } })).errors[0]!.message).toMatch(/dhuha/);
  });
  it('lists every problem with its file row number and blocks the file', () => {
    const rows = [HEAD, line('2026-12-01'), line('2026-12-02'), line('2026-12-02'), line('2026-12-05'), line('2026-12-06', { asar: '12:00' }), line('2026-12-07', { subuh: '' }), line('nope'), line('2026-12-08', { isyak: '25:61' })];
    const r = parse(rows.join('\n'));
    const msgs = r.errors.map((e) => `${e.row}: ${e.message}`);
    expect(msgs).toContain('4: tarikh berulang (2026-12-02)');
    expect(msgs).toContain('5: jurang tarikh (2026-12-03 tiada)');
    expect(msgs.some((m) => m.startsWith('6: waktu tidak mengikut urutan (zohor 12:12 bukan sebelum asar 12:00)') || m.startsWith('6: waktu tidak mengikut urutan (zohor'))).toBe(true);
    expect(msgs).toContain('7: waktu subuh kosong');
    expect(msgs).toContain('8: tarikh tidak sah "nope"');
    expect(msgs.some((m) => m.startsWith('9: waktu isyak tidak sah'))).toBe(true);
  });
  it('counts file rows through comment lines and quoted newlines', () => {
    const r = parse(`# comment\n${HEAD}\n${line('2026-12-01', { nota: '"two\nlines"' })}\n${line('2026-12-02', { asar: '10:00' })}`);
    expect(r.errors.map((e) => e.row)).toEqual([5]);
  });
  it('needs the date column and every required prayer column', () => {
    expect(parse('foo,bar\n1,2').errors[0]!.message).toMatch(/tarikh/);
    expect(parse('tarikh,subuh\n2026-12-01,04:50').errors.map((e) => e.message)).toEqual(expect.arrayContaining(['lajur syuruk tiada', 'lajur isyak tiada']));
  });
  it('masjid columns: stored in overrides for a masjid, refused for a surau', () => {
    const csv = `${HEAD},jumaat_khutbah,iqamah_zohor\n${line('2026-12-04')},25,5\n${line('2026-12-05')},,`;
    const m = parse(csv, { kind: 'masjid', imsakMinutes: 10 });
    expect(m.errors).toEqual([]);
    expect(m.days[0]!.overrides).toEqual({ khutbahMinutes: 25, iqamahMinutes: { zohor: 5 } });
    expect(m.days[1]!.overrides).toBeUndefined();
    const s = parse(csv, INFO);
    expect(s.errors[0]!.message).toBe('lajur masjid sahaja: jumaat_khutbah, iqamah_zohor');
    expect(parse(`${HEAD},iqamah_zohor\n${line('2026-12-04')},500`, { kind: 'masjid', imsakMinutes: 10 }).errors[0]!.message).toMatch(/0 hingga 120/);
  });
  it('refuses a CSV of 100,000 rows with a fixed message', () => {
    const big = `${HEAD}\n${'2026-12-01,,,,,,,,,\n'.repeat(100_000)}`;
    expect(() => parseCsvRows(big)).toThrow(/20,000/);
  });
  it('detects the format', () => {
    expect(detectFormat(esolatCsv)).toBe('esolat-csv');
    expect(detectFormat(csvOf(['2026-12-01']))).toBe('template-csv');
    expect(detectFormat(`# x\n﻿date,fajr\n`)).toBe('template-csv');
    expect(detectFormat('hello')).toBe('unknown');
    expect(detectFormat(Buffer.from([0x50, 0x4b, 3, 4, 0]))).toBe('xlsx');
  });
});

describe('dry run, apply, overlap and undo', () => {
  const dec = range('2026-12-01', 31);
  const nov = range('2026-11-01', 30);
  const days = (dates: string[]) => parse(csvOf(dates)).days;
  const fileRows = (db: DatabaseSync) => Number(db.prepare('SELECT COUNT(*) AS n FROM prayer_file_days').get()!.n);
  const checksum = (db: DatabaseSync): string => sha256Of(JSON.stringify([
    db.prepare('SELECT * FROM prayer_file_days ORDER BY date').all(), db.prepare('SELECT * FROM prayer_imports').all(),
    db.prepare('SELECT COUNT(*) AS n FROM change_log').get(), db.prepare("SELECT value FROM meta WHERE key = 'settings_version'").get() ?? null,
  ]));
  const imp = (db: DatabaseSync, s: Settings, d: ReturnType<typeof days>, overlap: 'replace' | 'keep' | 'fillEmpty', at: Date, name = 'f.csv') =>
    applyImport(db, s, { kind: 'csv', fileName: name, sha256: 'a'.repeat(64), days: d, overlap }, 'user:t', undefined, at);

  it('a dry run writes nothing', () => {
    const db = newDb();
    const before = checksum(db);
    const r = dryRun(db, ke(), days(dec), 'replace');
    expect(checksum(db)).toBe(before);
    expect(r.range).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(r.perMonth).toEqual({ '2026-12': 31 });
    expect(r.firstWeek).toHaveLength(7);
    expect(r.wouldWrite).toEqual({ inserted: 31, replaced: 0, skipped: 0 });
  });

  it('writes the rows for this surau only, with the import record and a feed entry', () => {
    const db = newDb();
    const r = imp(db, ke(), days(dec), 'replace', T0);
    expect(r).toMatchObject({ inserted: 31, replaced: 0, skipped: 0 });
    expect(fileRows(db)).toBe(31);
    expect(db.prepare('SELECT DISTINCT surau_id FROM prayer_file_days').all()).toEqual([{ surau_id: 'sdm' }]);
    expect(db.prepare('SELECT DISTINCT surau_id FROM prayer_imports').all()).toEqual([{ surau_id: 'sdm' }]);
    expect(listImports(db)[0]).toMatchObject({ id: r.id, rows: 31, dateFrom: '2026-12-01', dateTo: '2026-12-31', overlap: 'replace', actor: 'user:t', undoneAt: null });
    const log = db.prepare("SELECT entity_id, after_json FROM change_log WHERE entity = 'prayer:import'").get()!;
    expect(log.entity_id).toBe(r.id);
    expect((JSON.parse(String(log.after_json)) as { days: unknown[] }).days).toHaveLength(31);
    expect(resolveDay(db, ke(), '2026-12-10')!.source).toBe('file');
  });

  it('the three overlap choices count and write as previewed', () => {
    const db = newDb();
    const s = ke();
    imp(db, s, days(dec), 'replace', T0);
    const second = days(range('2026-12-20', 20)); // 20 Dec .. 8 Jan, 12 overlap
    const p = dryRun(db, s, second, 'replace');
    expect(p.byChoice.replace).toEqual({ inserted: 8, replaced: 12, skipped: 0 });
    expect(p.byChoice.keep).toEqual({ inserted: 8, replaced: 0, skipped: 12 });
    expect(p.byChoice.fillEmpty).toEqual({ inserted: 8, replaced: 0, skipped: 12 });
    expect(p.overlaps).toEqual({ official: 0, file: 12, calc: 8 });
    const r = imp(db, s, second, 'keep', T1);
    expect(r).toMatchObject({ inserted: 8, replaced: 0, skipped: 12 });
    expect(fileRows(db)).toBe(39);
    const again = imp(db, s, second, 'replace', T2);
    expect(again).toMatchObject({ inserted: 0, replaced: 20, skipped: 0 });
  });

  it('fill empty adds only days with no official and no file row (December only when November is official)', () => {
    const db = newDb();
    importDays(db, 'SGR01', official.filter((d) => d.date >= '2026-11-01' && d.date <= '2026-11-30'), 'tester');
    const my = resolveSettings({ location: { latitude: 3.07, longitude: 101.52 } });
    const both = days([...nov, ...dec]);
    const p = dryRun(db, my, both, 'fillEmpty');
    expect(p.overlaps.official).toBe(30);
    expect(p.wouldWrite).toEqual({ inserted: 31, replaced: 0, skipped: 30 });
    imp(db, my, both, 'fillEmpty', T0);
    expect(fileRows(db)).toBe(31);
    expect(db.prepare('SELECT MIN(date) AS a FROM prayer_file_days').get()).toEqual({ a: '2026-12-01' });
  });

  it('writes nothing and says so when the choice leaves no day to add', () => {
    const db = newDb();
    imp(db, ke(), days(dec), 'replace', T0);
    expect(() => imp(db, ke(), days(dec), 'keep', T1)).toThrow(/Tiada hari baharu/);
    expect(listImports(db)).toHaveLength(1);
  });

  it('undo takes the days back; restores what a later import replaced; blocks when a later import owns days', () => {
    const db = newDb();
    const s = ke();
    const a = imp(db, s, days(dec), 'replace', T0);
    const aDay = resolveDay(db, s, '2026-12-25')!.times;
    const changed = parse(csvOf(range('2026-12-10', 22), Object.fromEntries(range('2026-12-10', 22).map((d) => [d, { zohor: '12:30', asar: '15:45' }])))).days;
    const b = imp(db, s, changed, 'replace', T1);
    expect(resolveDay(db, s, '2026-12-25')!.times.zohor).toBe('12:30');
    const blocked = undoImport(db, a.id, 'user:t', undefined, T2);
    expect(blocked).toEqual({ ok: false, reason: 'Hari 2026-12-10 hingga 2026-12-31 telah diganti oleh import 2026-11-20' });
    expect(fileRows(db)).toBe(31);
    expect(undoImport(db, b.id, 'user:t', undefined, T2)).toEqual({ ok: true, restored: 22 });
    expect(resolveDay(db, s, '2026-12-25')!.times).toEqual(aDay);
    expect(fileRows(db)).toBe(31);
    expect(undoImport(db, a.id, 'user:t', undefined, T2)).toEqual({ ok: true, restored: 31 });
    expect(fileRows(db)).toBe(0);
    expect(resolveDay(db, s, '2026-12-25')!.source).toBe('calc');
    expect(listImports(db).every((r) => r.undoneAt !== null)).toBe(true);
    expect(undoImport(db, a.id, 'user:t', undefined, T2)).toMatchObject({ ok: false });
    expect(undoImport(db, 'X'.repeat(26), 'user:t', undefined, T2)).toMatchObject({ ok: false, reason: 'Import tidak dijumpai' });
  });

  it('a correction made after the import blocks the undo', () => {
    const db = newDb();
    const a = imp(db, ke(), days(dec), 'replace', T0);
    putCorrection(db, { date: '2026-12-05', prayer: 'asar', time: '15:40', reason: 'Ikut masjid' }, 'user:t', undefined, T1);
    const r = undoImport(db, a.id, 'user:t', undefined, T2);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/^Pembetulan dibuat pada 2026-11-20 untuk hari 2026-12-05/);
  });
});

describe('templates', () => {
  const info = { name: 'Surau D\'Waqaf', kind: 'surau' as const, country: 'MY', place: 'SGR01' };
  it('csv: the comment, the header and a row for every day, and it parses back once filled', () => {
    const t = csvTemplate(2027, info);
    const lines = t.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('# Surau D\'Waqaf, surau, MY, SGR01');
    expect(lines[1]).toBe('tarikh,imsak,subuh,syuruk,dhuha,zohor,asar,maghrib,isyak,nota');
    expect(lines).toHaveLength(2 + 365);
    expect(csvTemplate(2028, info).trim().split('\r\n')).toHaveLength(2 + 366);
    expect(parse(t).errors[0]!.message).toBe('waktu subuh kosong');
    expect(csvTemplate(2027, { ...info, kind: 'masjid' })).toContain('jumaat_khutbah,iqamah_subuh');
  });
  it('xlsx: a workbook that reads back the same rows', () => {
    const book = openXlsx(xlsxTemplate(2027, info, new Date('2026-11-10T00:00:00Z')));
    expect(book.sheets.map((s) => s.name)).toEqual(['Jadual']);
    const rows = book.readSheet(book.sheets[0]!.part);
    expect(rows[0]).toEqual(['# Surau D\'Waqaf, surau, MY, SGR01']);
    expect(rows[1]).toEqual(['tarikh', 'imsak', 'subuh', 'syuruk', 'dhuha', 'zohor', 'asar', 'maghrib', 'isyak', 'nota']);
    expect(rows).toHaveLength(2 + 365);
    expect(rows[2]![0]).toBe('2027-01-01');
  });
  it('an xlsx the user filled in (dates and times as real Excel cells) imports', () => {
    const styles = '<styleSheet><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="20"/></cellXfs></styleSheet>';
    const cell = (c: string, v: number, s: number): string => `<c r="${c}" s="${s}"><v>${v}</v></c>`;
    const head = ['tarikh', 'subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak'].map((h, i) => `<c r="${'ABCDEFG'[i]}1" t="inlineStr"><is><t>${h}</t></is></c>`).join('');
    const data = (r: number, serial: number): string => `<row r="${r}">${cell(`A${r}`, serial, 1)}${[0.2014, 0.25, 0.5083, 0.6458, 0.7639, 0.8125].map((f, i) => cell(`${'BCDEFG'[i]}${r}`, f, 2)).join('')}</row>`;
    const book = openXlsx(buildXlsx({ sheets: [{ name: 'Jadual', xml: `<row r="1">${head}</row>${data(2, 46357)}${data(3, 46358)}` }], styles }));
    const r = parseTemplateRows(book.readSheet(book.sheets[0]!.part), INFO);
    expect(r.errors).toEqual([]);
    expect(r.days.map((d) => d.date)).toEqual(['2026-12-01', '2026-12-02']);
    expect(r.days[0]!.times.subuh).toBe('04:50');
  });
});

describe('POST /api/prayer/import/file', () => {
  const apps: FastifyInstance[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close().catch(() => undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function make(): FastifyInstance {
    const d = mkdtempSync(join(tmpdir(), 'surau-imp-'));
    dirs.push(d);
    const app = buildApp(join(d, 'test.db'), { now: () => klInstant('2026-11-03', '12:00') });
    apps.push(app);
    return app;
  }
  const body = (over: object) => ({ kind: 'csv', name: 'jadual.csv', dryRun: true, overlap: 'replace', ...over });

  it('e-Solat CSV goes to the official path, a template dry run previews, apply needs the matching checksum', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/prayer/import/file', headers: admin.headers, payload });
    const es = await post(body({ text: esolatCsv }));
    expect(es.json()).toMatchObject({ format: 'esolat-csv', hint: 'official', zone: 'SGR01' });
    expect(Number(app.surau.db.prepare('SELECT COUNT(*) AS n FROM prayer_file_days').get()!.n)).toBe(0);

    const text = csvOf(range('2026-12-01', 31));
    const sha = sha256Of(Buffer.from(text, 'utf8'));
    const dry = (await post(body({ text }))).json();
    expect(dry).toMatchObject({ format: 'template-csv', sha256: sha, errors: [] });
    expect(dry.preview.wouldWrite).toEqual({ inserted: 31, replaced: 0, skipped: 0 });
    expect(Number(app.surau.db.prepare('SELECT COUNT(*) AS n FROM prayer_file_days').get()!.n)).toBe(0);

    const wrong = await post(body({ text, dryRun: false, expectSha256: 'f'.repeat(64) }));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().reason).toBe('sha_mismatch');
    const noSha = await post(body({ text, dryRun: false }));
    expect(noSha.statusCode).toBe(400);
    const done = await post(body({ text, dryRun: false, expectSha256: sha }));
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ inserted: 31, replaced: 0, skipped: 0 });
    const list = (await app.inject({ method: 'GET', url: '/api/prayer/imports', headers: admin.headers })).json().imports;
    expect(list).toHaveLength(1);
    const one = (await app.inject({ method: 'GET', url: `/api/prayer/imports/${list[0].id}`, headers: admin.headers })).json();
    expect(one.days).toHaveLength(31);
    const undo = await app.inject({ method: 'POST', url: `/api/prayer/imports/${list[0].id}/undo`, headers: admin.headers });
    expect(undo.json()).toEqual({ ok: true, restored: 31 });
  });

  it('undo of an import a later one now owns is a 409 whose reason is in errors[0]', async () => {
    const d = mkdtempSync(join(tmpdir(), 'surau-imp-'));
    dirs.push(d);
    let tick = 0;
    const app = buildApp(join(d, 'test.db'), { now: () => new Date(klInstant('2026-11-03', '12:00').getTime() + tick * 60_000) });
    apps.push(app);
    const admin = await loginAs(app, 'admin');
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/prayer/import/file', headers: admin.headers, payload });
    const apply = async (text: string): Promise<void> => {
      const dry = (await post(body({ text }))).json();
      tick += 1; // the clock moves on, so the second import is the later one
      expect((await post(body({ text, dryRun: false, expectSha256: dry.sha256 }))).statusCode).toBe(200);
    };
    await apply(csvOf(range('2026-12-01', 10)));
    await apply(csvOf(range('2026-12-05', 10), { '2026-12-06': { zohor: '12:40' } }));
    const list = (await app.inject({ method: 'GET', url: '/api/prayer/imports', headers: admin.headers })).json().imports as Array<{ id: string; dateFrom: string }>;
    const first = list.find((x) => x.dateFrom === '2026-12-01')!;
    const undo = await app.inject({ method: 'POST', url: `/api/prayer/imports/${first.id}/undo`, headers: admin.headers });
    expect(undo.statusCode).toBe(409);
    expect(undo.json().ok).toBe(false);
    expect(undo.json().errors[0]).toMatch(/^Hari 2026-12-05 hingga 2026-12-10 telah diganti oleh import /);
    expect(undo.json().reason).toBe(undo.json().errors[0]);
  });

  it('one error blocks the apply with its row number', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const text = csvOf(range('2026-12-01', 3), { '2026-12-02': { asar: '10:00' } });
    const dry = (await app.inject({ method: 'POST', url: '/api/prayer/import/file', headers: admin.headers, payload: body({ text }) })).json();
    expect(dry.errors).toHaveLength(1);
    expect(dry.errors[0].row).toBe(3);
    expect(dry.preview).toBeNull();
    const apply = await app.inject({ method: 'POST', url: '/api/prayer/import/file', headers: admin.headers, payload: body({ text, dryRun: false, expectSha256: dry.sha256 }) });
    expect(apply.statusCode).toBe(400);
    expect(apply.json().errors[0]).toMatch(/^baris 3:/);
  });

  it('an Excel template round trips, two sheets are listed and one picked, and bad input is refused', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/prayer/import/file', headers: admin.headers, payload });
    const tpl = xlsxTemplate(2027, { name: 'Surau', kind: 'surau', country: 'MY', place: 'SGR01' });
    const r = (await post(body({ kind: 'xlsx', name: 'jadual.xlsx', base64: tpl.toString('base64') }))).json();
    expect(r.format).toBe('xlsx');
    expect(r.sheets).toEqual(['Jadual']);
    expect(r.errors[0].message).toBe('waktu subuh kosong');
    const two = buildXlsx({ sheets: [
      { name: 'Satu', xml: '<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>' },
      { name: 'Jadual', xml: `<row r="1">${['tarikh', 'subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak'].map((h, i) => `<c r="${'ABCDEFG'[i]}1" t="inlineStr"><is><t>${h}</t></is></c>`).join('')}</row><row r="2">${['2026-12-01', '04:50', '06:00', '12:12', '15:30', '18:20', '19:30'].map((h, i) => `<c r="${'ABCDEFG'[i]}2" t="inlineStr"><is><t>${h}</t></is></c>`).join('')}</row>` },
    ] });
    const pick = (await post(body({ kind: 'xlsx', name: 'a.xlsx', base64: two.toString('base64'), sheet: 'Jadual' }))).json();
    expect(pick).toMatchObject({ sheets: ['Satu', 'Jadual'], sheet: 'Jadual', errors: [] });
    expect(pick.preview.rows).toBe(1);
    expect((await post(body({ kind: 'xlsx', name: 'a.xlsx', base64: two.toString('base64'), sheet: 'Tiada' }))).statusCode).toBe(400);
    expect((await post(body({ kind: 'xlsx', name: 'a.xlsx', base64: Buffer.from('not a zip').toString('base64') }))).statusCode).toBe(400);
    expect((await post(body({ kind: 'csv', name: 'a.csv', base64: two.toString('base64') }))).statusCode).toBe(400);
    expect((await post(body({ name: '../x.csv', text: 'a' }))).statusCode).toBe(400);
    expect((await post(body({ text: 'a', base64: 'YQ==' }))).statusCode).toBe(400);
    expect((await post(body({ text: 'a', overlap: 'merge' }))).statusCode).toBe(400);
    expect((await post(body({ text: 'a'.repeat(1024 * 1024 + 1) }))).statusCode).toBe(413);
    expect((await post(body({ text: 'hello there' }))).statusCode).toBe(400);
  });

  it('a 5 MB body is refused, media may not import, and the templates download', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const media = await loginAs(app, 'media');
    const big = await app.inject({ method: 'POST', url: '/api/prayer/import/file', headers: admin.headers, payload: body({ text: 'a'.repeat(5 * 1024 * 1024) }) });
    expect(big.statusCode).toBe(413);
    expect((await app.inject({ method: 'POST', url: '/api/prayer/import/file', headers: media.headers, payload: body({ text: csvOf(['2026-12-01']) }) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/prayer/imports/X/undo', headers: media.headers })).statusCode).toBe(403);
    const csv = await app.inject({ method: 'GET', url: '/api/prayer/template.csv?year=2027', headers: media.headers });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-disposition']).toBe('attachment; filename="waktu-solat-2027.csv"');
    expect(csv.body.split('\r\n').filter((l) => l.startsWith('2027-'))).toHaveLength(365);
    const x = await app.inject({ method: 'GET', url: '/api/prayer/template.xlsx?year=2027', headers: media.headers });
    expect(x.statusCode).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(openXlsx(x.rawPayload).sheets).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/prayer/template.csv?year=1999', headers: media.headers })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/prayer/imports/not-an-id', headers: media.headers })).statusCode).toBe(404);
  });
});
