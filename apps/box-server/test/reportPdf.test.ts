import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant } from '@surau/core';
import type { MonthReport } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { putFeature } from '../src/settingsStore.ts';
import { renderReportPdf, textWidth } from '../src/finance/pdf.ts';
import { fileSlug } from '../src/finance/reportRoutes.ts';
import { loginAs } from './authHelpers.ts';

const vectors = JSON.parse(readFileSync(fileURLToPath(new URL('../../../packages/core/test/fixtures/finance-vectors.json', import.meta.url)), 'utf8')) as {
  scenarios: { name: string; report?: { expected: MonthReport } }[];
};
const report: MonthReport = vectors.scenarios.find((s) => s.name.startsWith('10'))!.report!.expected;
const SURAU = { name: 'Surau D\'Waqaf', kind: 'surau', shortAddress: 'Taman Seri, Klang' };

/** A 40-line cross-reference walker: every xref offset must point at the object it names; returns what it found. */
function walk(pdf: Buffer): { objects: number; pages: number; text: string } {
  const text = pdf.toString('latin1');
  expect(text.startsWith('%PDF-1.4')).toBe(true);
  expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  const start = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
  expect(text.slice(start, start + 4)).toBe('xref');
  const m = /xref\n0 (\d+)\n/.exec(text.slice(start))!;
  const n = Number(m[1]);
  const entries = text.slice(start + m[0].length).split('\n').slice(0, n);
  expect(entries[0]).toBe('0000000000 65535 f ');
  for (let i = 1; i < n; i++) {
    const [off, gen, kind] = entries[i]!.split(' ');
    expect(kind).toBe('n');
    expect(gen).toBe('00000');
    expect(text.slice(Number(off), Number(off) + `${i} 0 obj`.length)).toBe(`${i} 0 obj`);
  }
  const trailer = /trailer\n<< \/Size (\d+) \/Root 1 0 R >>/.exec(text)!;
  expect(Number(trailer[1])).toBe(n);
  return { objects: n - 1, pages: (text.match(/\/Type \/Page /g) ?? []).length, text };
}

const footerPages = (text: string): number => Number(/muka \d+\/(\d+)/.exec(text)![1]);

describe('renderReportPdf', () => {
  it('is a well-formed PDF whose page count matches the footer, with the title and the figures as plain text', () => {
    const pdf = renderReportPdf(report, SURAU);
    const w = walk(pdf);
    expect(w.pages).toBe(footerPages(w.text));
    expect(w.objects).toBe(4 + 2 * w.pages);
    expect(w.text).toContain('(Penyata Kewangan Bulanan)');
    expect(w.text).toContain('(Surau D\'Waqaf)');
    expect(w.text).toContain('(Oktober 2026)');
    expect(w.text).toContain('(RM 1,500.00)');
    expect(w.text).toContain('(\\(RM 150.00\\))'); // a negative is in brackets
    expect(w.text).toContain('(02/10/2026)');
    expect(w.text).toContain('(K-0002)');
    expect(w.text).toContain('Salah taip jumlah: 450');
    expect(w.text).toContain('DRAF');
    expect(w.text).toContain('Diselaraskan sehingga 02/11/2026 08:59');
  });

  it('a closed month has no DRAF stamp and says who closed it and when', () => {
    const closed = { ...report, status: 'closed' as const };
    const w = walk(renderReportPdf(closed, SURAU, { at: '2026-11-02T01:00:00.000Z', by: 'Pn Rohani' }));
    expect(w.text).not.toContain('DRAF');
    expect(w.text).toContain('MUKTAMAD, ditutup 02/11/2026 oleh Pn Rohani');
  });

  it('writes no em dash, en dash, approximation sign or arrow, and no tilde', () => {
    const odd = { ...report, funds: report.funds.map((f, i) => (i === 0 ? { ...f, name: 'Tabung — Am – ≈ →' } : f)) };
    const pdf = renderReportPdf(odd, { ...SURAU, name: 'Surau — Baik' });
    expect(pdf.includes(0x97)).toBe(false); // WinAnsi em dash
    expect(pdf.includes(0x96)).toBe(false); // WinAnsi en dash
    expect(pdf.includes(0x7e)).toBe(false); // ~
    const t = pdf.toString('latin1');
    expect(t).not.toMatch(/[–—≈→]/);
    expect(t).toContain('(Tabung - Am - ? ?)');
    // and the source file itself stays clean (the strings the report prints are written by this module)
    const src = readFileSync(fileURLToPath(new URL('../src/finance/pdf.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/[–—≈→]/);
  });

  it('a 400-row month paginates and repeats the header on every page', () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({ date: '2026-10-02', refNo: `K-${String(i + 1).padStart(4, '0')}`, note: `Derma ${i}`, amountSen: 100 + i }));
    const big: MonthReport = {
      ...report, inByPerihal: [{ perihalId: 'p', label: 'Peti derma', fundId: 'f1', rows, totalSen: rows.reduce((a, r) => a + r.amountSen, 0) }],
    };
    const w = walk(renderReportPdf(big, SURAU));
    expect(w.pages).toBeGreaterThan(5);
    expect(w.pages).toBe(footerPages(w.text));
    expect((w.text.match(/Surau D'Waqaf, Penyata Kewangan Bulanan, Oktober 2026/g) ?? []).length).toBe(w.pages - 1);
    expect((w.text.match(/muka \d+\//g) ?? []).length).toBe(w.pages);
  });

  it('text in brackets and backslashes is escaped, and Latin letters pass through', () => {
    const odd = { ...report, funds: report.funds.map((f, i) => (i === 0 ? { ...f, name: 'A (b) \\ c é' } : f)) };
    const w = walk(renderReportPdf(odd, SURAU));
    expect(w.text).toContain('(A \\(b\\) \\\\ c \\351)');
  });

  it('measures Helvetica widths', () => {
    expect(textWidth('0', 10)).toBeCloseTo(5.56, 2);
    expect(textWidth('RM', 10, 'F2')).toBeGreaterThanOrEqual(textWidth('RM', 10, 'F1'));
    expect(textWidth('b', 10, 'F2')).toBeGreaterThan(textWidth('b', 10, 'F1'));
  });
});

describe('fileSlug', () => {
  it('keeps letters and digits only', () => {
    expect(fileSlug('Surau D\'Waqaf')).toBe('Surau-D-Waqaf');
    expect(fileSlug('  ../Masjid "Al-Hidayah" #2 ')).toBe('Masjid-Al-Hidayah-2');
    expect(fileSlug('***')).toBe('Surau');
  });
});

const NOW = klInstant('2026-11-10', '10:00');
const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('report routes', () => {
  async function rig() {
    const dir = mkdtempSync(join(tmpdir(), 'surau-rep-'));
    dirs.push(dir);
    const app = buildApp(join(dir, 'box.db'), { dataDir: dir, now: () => NOW });
    apps.push(app);
    const admin = await loginAs(app, 'admin');
    const treasurer = await loginAs(app, 'treasurer');
    const ajk = await loginAs(app, 'ajk');
    putFeature(app.surau.db, 'finance', { enabled: true }, 'test');
    putFeature(app.surau.db, 'surauInfo', { name: 'Surau D\'Waqaf' }, 'test');
    const funds = (await app.inject({ method: 'GET', url: '/api/finance/funds', headers: treasurer.headers })).json().funds as { id: string }[];
    const perIn = ((await app.inject({ method: 'GET', url: '/api/finance/perihal', headers: treasurer.headers })).json().perihal as { id: string; direction: string }[]).find((p) => p.direction === 'in')!.id;
    await app.inject({
      method: 'PUT', url: '/api/finance/entries/e1', headers: treasurer.headers,
      payload: { kind: 'in', entryDate: '2026-11-06', fundId: funds[0]!.id, perihalId: perIn, amountSen: 134680, method: 'bank', reference: 'FPX1' },
    });
    return { app, admin, treasurer, ajk };
  }

  it('the JSON is open to an AJK, the PDF is not; the PDF is an attachment with a clean name and leaves a history row', async () => {
    const r = await rig();
    const json = await r.app.inject({ method: 'GET', url: '/api/finance/report/2026-11', headers: r.ajk.headers });
    expect(json.statusCode).toBe(200);
    expect(json.json().totals.inSen).toBe(134680);
    expect((await r.app.inject({ method: 'GET', url: '/api/finance/report/2026-11.pdf', headers: r.ajk.headers })).statusCode).toBe(403);
    const pdf = await r.app.inject({ method: 'GET', url: '/api/finance/report/2026-11.pdf', headers: r.treasurer.headers });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toBe('attachment; filename="Penyata-Kewangan-Surau-D-Waqaf-2026-11.pdf"');
    expect(pdf.headers['cache-control']).toBe('no-store');
    expect(walk(pdf.rawPayload).text).toContain('(RM 1,346.80)');
    const row = r.app.surau.db.prepare("SELECT entity_id, after_json FROM change_log WHERE entity = 'finance:report'").get()!;
    expect(row.entity_id).toBe('2026-11');
    expect(JSON.parse(String(row.after_json))).toEqual({ ym: '2026-11', action: 'download' });
  });

  it('a share note is recorded with the channel; a bad channel or month is 400; the audit-only rows do not travel', async () => {
    const r = await rig();
    const ok = await r.app.inject({ method: 'POST', url: '/api/finance/report/2026-11/shared', headers: r.treasurer.headers, payload: { via: 'whatsapp' } });
    expect(ok.statusCode).toBe(200);
    const row = r.app.surau.db.prepare("SELECT after_json FROM change_log WHERE entity = 'finance:report'").get()!;
    expect(JSON.parse(String(row.after_json))).toEqual({ ym: '2026-11', action: 'share', via: 'whatsapp' });
    expect((await r.app.inject({ method: 'POST', url: '/api/finance/report/2026-11/shared', headers: r.treasurer.headers, payload: { via: 'telegram' } })).statusCode).toBe(400);
    expect((await r.app.inject({ method: 'POST', url: '/api/finance/report/2026-11/shared', headers: r.ajk.headers, payload: { via: 'other' } })).statusCode).toBe(403);
    expect((await r.app.inject({ method: 'GET', url: '/api/finance/report/2027-01', headers: r.treasurer.headers })).statusCode).toBe(400);
    expect((await r.app.inject({ method: 'GET', url: '/api/finance/report/abcd', headers: r.treasurer.headers })).statusCode).toBe(400);
  });

  it('closing a month through the route freezes its report; the Pentadbir reopens it', async () => {
    const r = await rig();
    await r.app.inject({ method: 'PUT', url: '/api/finance/entries/old', headers: r.treasurer.headers, payload: {
      kind: 'in', entryDate: '2026-10-28', fundId: (await r.app.inject({ method: 'GET', url: '/api/finance/funds', headers: r.treasurer.headers })).json().funds[0].id,
      perihalId: ((await r.app.inject({ method: 'GET', url: '/api/finance/perihal', headers: r.treasurer.headers })).json().perihal as { id: string; direction: string }[]).find((p) => p.direction === 'in')!.id,
      amountSen: 1000, method: 'bank', reference: 'FPX9' } });
    const close = await r.app.inject({ method: 'PUT', url: '/api/finance/months/2026-10', headers: r.admin.headers, payload: { status: 'closed' } });
    expect(close.statusCode).toBe(200);
    expect(close.json().month.report.status).toBe('closed');
    expect((await r.app.inject({ method: 'GET', url: '/api/finance/report/2026-10', headers: r.ajk.headers })).json().status).toBe('closed');
    const reopen = await r.app.inject({ method: 'PUT', url: '/api/finance/months/2026-10', headers: r.admin.headers, payload: { status: 'open' } });
    expect(reopen.json().month).toMatchObject({ status: 'open', report: null });
    const trail = r.app.surau.db.prepare("SELECT before_json, after_json FROM change_log WHERE entity = 'finance:month' ORDER BY id").all();
    expect(trail).toHaveLength(2);
    expect(JSON.parse(String(trail[1]!.before_json)).status).toBe('closed');
  });
});
