import type { FastifyInstance } from 'fastify';
import { dateOf, hasOfficialSource, tzOf } from '@surau/core';
import { actorOf, deviceOf } from '../actor.ts';
import { openXlsx, XlsxError } from '../files/xlsxRead.ts';
import { getSettings, getVersion } from '../settingsStore.ts';
import type { PrayerDeps } from './index.ts';
import {
  applyImport, detectFormat, dryRun, getImport, IMPORT_ID_RE, ImportError, listImports, MAX_CSV_BYTES, MAX_XLSX_BYTES,
  OVERLAPS, parseCsvRows, parseTemplateRows, sha256Of, undoImport,
} from './importFile.ts';
import type { Overlap, ParsedFile } from './importFile.ts';
import { csvTemplate, xlsxTemplate } from './templates.ts';
import type { TemplateInfo } from './templates.ts';

const FILE_BODY_LIMIT = 4 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9 ._()-]{1,120}$/;
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function registerImportRoutes(app: FastifyInstance, deps: PrayerDeps): void {
  const { db, now, bus } = deps;

  const templateInfo = (): TemplateInfo => {
    const s = getSettings(db);
    const official = hasOfficialSource(s.location.country);
    return {
      name: s.surauInfo.name, kind: s.surauInfo.kind, country: s.location.country,
      place: official ? String(s.zone.zone) : s.location.city,
    };
  };

  app.post('/api/prayer/import/file', { bodyLimit: FILE_BODY_LIMIT }, async (request, reply) => {
    const b = request.body;
    if (!isPlain(b)) return reply.code(400).send({ errors: ['body must be a JSON object'] });
    if (b.kind !== 'csv' && b.kind !== 'xlsx') return reply.code(400).send({ errors: ['kind must be csv or xlsx'] });
    if (typeof b.name !== 'string' || !NAME_RE.test(b.name)) return reply.code(400).send({ errors: ['name must be 1 to 120 letters, digits, spaces, dots, dashes or underscores'] });
    if (typeof b.dryRun !== 'boolean') return reply.code(400).send({ errors: ['dryRun must be true or false'] });
    if (typeof b.overlap !== 'string' || !OVERLAPS.includes(b.overlap as Overlap)) return reply.code(400).send({ errors: ['overlap must be replace, keep or fillEmpty'] });
    if ((typeof b.text === 'string') === (typeof b.base64 === 'string')) return reply.code(400).send({ errors: ['send exactly one of text or base64'] });
    if (b.sheet !== undefined && (typeof b.sheet !== 'string' || b.sheet.length > 31)) return reply.code(400).send({ errors: ['sheet must be text of at most 31 characters'] });
    if (b.expectSha256 !== undefined && (typeof b.expectSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.expectSha256))) return reply.code(400).send({ errors: ['expectSha256 must be 64 hex characters'] });

    let data: Buffer;
    if (typeof b.base64 === 'string') {
      if (b.base64.length > Math.ceil((b.kind === 'xlsx' ? MAX_XLSX_BYTES : MAX_CSV_BYTES) * 4 / 3) + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.base64)) {
        return reply.code(413).send({ errors: ['Fail terlalu besar atau rosak'] });
      }
      data = Buffer.from(b.base64, 'base64');
    } else {
      data = Buffer.from(b.text as string, 'utf8');
    }
    if (data.length > (b.kind === 'xlsx' ? MAX_XLSX_BYTES : MAX_CSV_BYTES)) {
      return reply.code(413).send({ errors: [`Fail terlalu besar (paling banyak ${b.kind === 'xlsx' ? '2 MB' : '1 MB'})`] });
    }
    const sha = sha256Of(data);
    const settings = getSettings(db);
    const format = detectFormat(data);
    if (b.kind === 'csv' && format === 'xlsx') return reply.code(400).send({ errors: ['Fail ini ialah Excel; pilih jenis Excel'] });
    if (b.kind === 'xlsx' && format !== 'xlsx') return reply.code(400).send({ errors: ['Fail ini bukan buku kerja Excel (.xlsx)'] });
    if (format === 'esolat-csv') {
      // The yearly e-Solat file is an official source for a zone and goes through the existing official import.
      return { format, hint: 'official', sha256: sha, zone: String(settings.zone.zone) };
    }

    let parsed: ParsedFile;
    let sheets: string[] | undefined;
    let sheetName: string | undefined;
    try {
      const info = { kind: settings.surauInfo.kind, imsakMinutes: settings.prayerCalc.imsakMinutes };
      if (format === 'xlsx') {
        const book = openXlsx(data);
        sheets = book.sheets.map((s) => s.name);
        const chosen = b.sheet === undefined ? book.sheets[0]! : book.sheets.find((s) => s.name === b.sheet);
        if (!chosen) return reply.code(400).send({ errors: ['sheet not found in the workbook'], sheets });
        sheetName = chosen.name;
        parsed = parseTemplateRows(book.readSheet(chosen.part), info);
      } else if (format === 'template-csv') {
        const csv = parseCsvRows(data.toString('utf8'));
        parsed = parseTemplateRows(csv.rows, info, csv.numbers);
      } else {
        return reply.code(400).send({ errors: ['Format fail tidak dikenali; gunakan templat MAXCOM atau fail e-Solat'] });
      }
    } catch (error) {
      if (error instanceof XlsxError || error instanceof ImportError) {
        return reply.code(400).send({ errors: [error.message] });
      }
      throw error;
    }

    const overlap = b.overlap as Overlap;
    if (b.dryRun) {
      return {
        format, sha256: sha, ...(sheets ? { sheets, sheet: sheetName } : {}), columns: parsed.columns, errors: parsed.errors,
        preview: parsed.errors.length === 0 ? dryRun(db, settings, parsed.days, overlap) : null,
      };
    }
    if (b.expectSha256 !== sha) return reply.code(400).send({ errors: ['Fail berubah sejak semakan; semak semula'], reason: 'sha_mismatch' });
    if (parsed.errors.length > 0) return reply.code(400).send({ errors: parsed.errors.map((e) => `baris ${e.row}: ${e.message}`), rows: parsed.errors });
    try {
      const result = applyImport(db, settings, { kind: b.kind, fileName: b.name, sha256: sha, days: parsed.days, overlap }, actorOf(request), deviceOf(request), now());
      bus.emit(getVersion(db));
      return result;
    } catch (error) {
      if (error instanceof ImportError) return reply.code(error.status).send({ errors: [error.message] });
      throw error;
    }
  });

  app.get('/api/prayer/imports', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { imports: listImports(db) };
  });

  app.get('/api/prayer/imports/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const found = IMPORT_ID_RE.test(id) ? getImport(db, id) : null;
    if (!found) return reply.code(404).send({ errors: ['Import tidak dijumpai'] });
    reply.header('Cache-Control', 'no-store');
    return found;
  });

  app.post('/api/prayer/imports/:id/undo', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!IMPORT_ID_RE.test(id)) return reply.code(404).send({ errors: ['Import tidak dijumpai'] });
    const r = undoImport(db, id, actorOf(request), deviceOf(request), now());
    if (!r.ok) return reply.code(r.reason === 'Import tidak dijumpai' ? 404 : 409).send({ ok: false, reason: r.reason, errors: [r.reason] });
    bus.emit(getVersion(db));
    return r;
  });

  const yearOf = (q: unknown): number | null => {
    const raw = isPlain(q) && typeof q.year === 'string' ? q.year : String(dateOf(now(), tzOf(getSettings(db))).slice(0, 4));
    const y = Number(raw);
    return /^\d{4}$/.test(raw) && y >= 2020 && y <= 2100 ? y : null;
  };
  app.get('/api/prayer/template.csv', async (request, reply) => {
    const year = yearOf(request.query);
    if (year === null) return reply.code(400).send({ errors: ['year must be 2020..2100'] });
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="waktu-solat-${year}.csv"`).send(csvTemplate(year, templateInfo()));
  });
  app.get('/api/prayer/template.xlsx', async (request, reply) => {
    const year = yearOf(request.query);
    if (year === null) return reply.code(400).send({ errors: ['year must be 2020..2100'] });
    return reply.header('Content-Type', XLSX_MIME).header('Content-Disposition', `attachment; filename="waktu-solat-${year}.xlsx"`).send(xlsxTemplate(year, templateInfo(), now()));
  });
}
