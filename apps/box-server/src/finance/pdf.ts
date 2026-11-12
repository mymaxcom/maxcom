/**
 * A small PDF writer for the monthly report: PDF 1.4, A4 portrait, base-14 Helvetica and Helvetica-Bold with
 * WinAnsi text (Malay is Latin script, so no font is embedded), rules and text only, uncompressed streams.
 * No library. The text it draws uses plain hyphens and commas only: no em or en dash, no approximation sign.
 */
import { formatRm } from '@surau/core';
import type { CorrectionKind, MonthReport } from '@surau/core';

const PT_PER_MM = 72 / 25.4;
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 18 * PT_PER_MM;
const LEFT = MARGIN;
const RIGHT = PAGE_W - MARGIN;
const TOP = PAGE_H - MARGIN;
const BOTTOM = MARGIN + 18; // room for the footer

type Face = 'F1' | 'F2';

// Helvetica and Helvetica-Bold advance widths (per 1000 em) for ASCII 32..126, from the Adobe core-14 metrics.
const W1 = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W2 = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

function charWidth(c: string, face: Face): number {
  const code = c.charCodeAt(0);
  const table = face === 'F1' ? W1 : W2;
  if (code >= 32 && code <= 126) return table[code - 32]!;
  return face === 'F1' ? 556 : 611;
}

export function textWidth(s: string, size: number, face: Face = 'F1'): number {
  let w = 0;
  for (const c of s) w += charWidth(c, face);
  return (w * size) / 1000;
}

/** Text as WinAnsi bytes inside a PDF literal string. Anything WinAnsi cannot show becomes a plain hyphen or `?`. */
function pdfString(s: string): string {
  let out = '';
  for (const raw of s) {
    let c = raw;
    const u = raw.codePointAt(0)!;
    // dashes and minus signs become a plain hyphen; curly quotes become straight ones (written as code points on purpose)
    if (u === 0x2013 || u === 0x2014 || u === 0x2212) c = '-';
    else if (u === 0x2018 || u === 0x2019) c = "'";
    else if (u === 0x201c || u === 0x201d) c = '"';
    const code = c.charCodeAt(0);
    if (c === '(' || c === ')' || c === '\\') out += `\\${c}`;
    else if (code >= 32 && code <= 126) out += c;
    else if (code >= 160 && code <= 255) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += '?';
  }
  return `(${out})`;
}

const f2 = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

class PageBuf {
  readonly ops: string[] = [];
  text(x: number, y: number, s: string, size: number, face: Face = 'F1', align: 'left' | 'right' | 'center' = 'left', gray = 0): void {
    if (s === '') return;
    const w = textWidth(s, size, face);
    const px = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
    this.ops.push(`BT ${gray} g /${face} ${size} Tf ${f2(px)} ${f2(y)} Td ${pdfString(s)} Tj ET`);
  }
  line(x1: number, y1: number, x2: number, y2: number, width = 0.5, gray = 0): void {
    this.ops.push(`${gray} G ${width} w ${f2(x1)} ${f2(y1)} m ${f2(x2)} ${f2(y2)} l S`);
  }
  /** Large grey text turned 20 degrees across the page, drawn first so the figures stay readable. */
  stamp(s: string): void {
    const a = (20 * Math.PI) / 180;
    const c = Math.cos(a); const sn = Math.sin(a);
    this.ops.unshift(`q ${f2(c)} ${f2(sn)} ${f2(-sn)} ${f2(c)} 130 330 cm BT 0.88 g /F2 110 Tf 0 0 Td ${pdfString(s)} Tj ET Q`);
  }
}

const MONTHS_MS = ['Januari', 'Februari', 'Mac', 'April', 'Mei', 'Jun', 'Julai', 'Ogos', 'September', 'Oktober', 'November', 'Disember'];
export const monthNameMs = (ym: string): string => `${MONTHS_MS[Number(ym.slice(5, 7)) - 1] ?? ym} ${ym.slice(0, 4)}`;

/** `2026-10-02` -> `02/10/2026`. */
export const dmy = (d: string): string => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/** An ISO instant as `dd/mm/yyyy HH:mm` on the Kuala Lumpur clock. */
export function klStamp(iso: string): string {
  const t = new Date(Date.parse(iso) + 8 * 3_600_000);
  if (Number.isNaN(t.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(t.getUTCDate())}/${p(t.getUTCMonth() + 1)}/${t.getUTCFullYear()} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

const KIND_MS: Record<CorrectionKind, string> = { amount: 'Laras jumlah', void: 'Batalkan catatan', fund: 'Tukar tabung' };
const money = (sen: number): string => formatRm(sen, { parens: true });

function wrap(s: string, width: number, size: number, face: Face = 'F1'): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of s.split(/\s+/).filter((x) => x !== '')) {
    const test = cur === '' ? word : `${cur} ${word}`;
    if (textWidth(test, size, face) <= width || cur === '') {
      // a single word wider than the column is cut by characters
      if (cur === '' && textWidth(word, size, face) > width) {
        let piece = '';
        for (const ch of word) {
          if (textWidth(piece + ch, size, face) > width && piece !== '') { out.push(piece); piece = ch; } else piece += ch;
        }
        cur = piece;
      } else cur = test;
    } else { out.push(cur); cur = word; }
  }
  if (cur !== '') out.push(cur);
  return out.length > 0 ? out : [''];
}

export interface PdfSurau { name: string; kind: string; shortAddress?: string }
export interface PdfClosed { at: string; by: string }

/** The report as an A4 PDF, ready to send. */
export function renderReportPdf(report: MonthReport, surau: PdfSurau, closed?: PdfClosed): Buffer {
  const pages: PageBuf[] = [];
  let page = new PageBuf();
  let y = TOP;
  const isDraft = report.status !== 'closed';
  const month = monthNameMs(report.ym);
  const fundName = new Map(report.funds.map((f) => [f.fundId, f.name]));

  const header = (first: boolean): void => {
    if (first) {
      page.text(LEFT, y - 14, surau.name, 15, 'F2');
      y -= 20;
      if (surau.shortAddress) { page.text(LEFT, y - 9, surau.shortAddress, 9); y -= 13; }
      page.text(LEFT, y - 13, 'Penyata Kewangan Bulanan', 13, 'F2');
      page.text(RIGHT, y - 13, month, 13, 'F2', 'right');
      y -= 20;
      const status = isDraft
        ? 'DRAF: belum dimuktamadkan'
        : `MUKTAMAD${closed ? `, ditutup ${dmy(closed.at.slice(0, 10))} oleh ${closed.by}` : ''}`;
      page.text(LEFT, y - 9, status, 9, 'F2', 'left', isDraft ? 0.35 : 0);
      y -= 14;
    } else {
      page.text(LEFT, y - 9, `${surau.name}, Penyata Kewangan Bulanan, ${month}`, 9, 'F2');
      y -= 14;
    }
    page.line(LEFT, y, RIGHT, y, 1);
    y -= 12;
  };

  const newPage = (): void => {
    pages.push(page);
    page = new PageBuf();
    y = TOP;
    header(false);
  };
  const need = (h: number): void => { if (y - h < BOTTOM) newPage(); };

  header(true);

  const section = (title: string): void => {
    need(40);
    page.text(LEFT, y - 11, title, 11, 'F2');
    y -= 16;
  };

  // 1. Ringkasan tabung
  section('1. Ringkasan tabung');
  const cols = [RIGHT - 4 * 88 - 0, RIGHT - 3 * 88, RIGHT - 2 * 88, RIGHT - 88, RIGHT]; // right edges of the five money columns
  const headRow = (labels: string[], first: string): void => {
    page.text(LEFT, y - 9, first, 8.5, 'F2');
    labels.forEach((l, i) => page.text(cols[i]!, y - 9, l, 8.5, 'F2', 'right'));
    y -= 12;
    page.line(LEFT, y, RIGHT, y, 0.5);
    y -= 3;
  };
  headRow(['Baki awal', 'Kutipan', 'Bayaran', 'Pembetulan', 'Baki akhir'], 'Tabung');
  for (const f of report.funds) {
    need(14);
    page.text(LEFT, y - 9, f.name, 9);
    [f.openingSen, f.inSen, f.outSen, f.correctionsSen, f.closingSen].forEach((v, i) => page.text(cols[i]!, y - 9, money(v), 9, 'F1', 'right'));
    y -= 13;
  }
  need(16);
  page.line(LEFT, y + 1, RIGHT, y + 1, 0.5);
  y -= 2;
  page.text(LEFT, y - 9, 'Jumlah', 9, 'F2');
  const t = report.totals;
  [t.openingSen, t.inSen, t.outSen, t.correctionsSen, t.closingSen].forEach((v, i) => page.text(cols[i]!, y - 9, money(v), 9, 'F2', 'right'));
  y -= 20;

  // 2 and 3. money in and out by perihal
  const detail = (title: string, groups: { label: string; fundId: string; totalSen: number; rows: { date: string; refNo: string | null; note: string | null; amountSen: number; extra: string }[] }[]): void => {
    section(title);
    if (groups.length === 0) { page.text(LEFT, y - 9, 'Tiada catatan.', 9, 'F1', 'left', 0.4); y -= 18; return; }
    for (const g of groups) {
      need(34);
      page.text(LEFT, y - 9, `${g.label}, ${fundName.get(g.fundId) ?? ''}`, 9.5, 'F2');
      y -= 13;
      for (const r of g.rows) {
        const desc = [r.extra, r.note ?? ''].filter((x) => x !== '').join(', ');
        const lines = wrap(desc, RIGHT - LEFT - 130 - 90, 8.5);
        need(lines.length * 11 + 2);
        page.text(LEFT + 4, y - 8.5, dmy(r.date), 8.5);
        page.text(LEFT + 62, y - 8.5, r.refNo ?? '', 8.5);
        lines.forEach((ln, i) => page.text(LEFT + 112, y - 8.5 - i * 11, ln, 8.5));
        page.text(RIGHT, y - 8.5, money(r.amountSen), 8.5, 'F1', 'right');
        y -= lines.length * 11 + 1;
      }
      need(14);
      page.line(RIGHT - 110, y, RIGHT, y, 0.4);
      page.text(RIGHT, y - 9.5, money(g.totalSen), 9, 'F2', 'right');
      page.text(RIGHT - 118, y - 9.5, 'Jumlah', 9, 'F2', 'right');
      y -= 18;
    }
  };
  detail('2. Kutipan mengikut tabung dan perihal', report.inByPerihal.map((g) => ({
    label: g.label, fundId: g.fundId, totalSen: g.totalSen, rows: g.rows.map((r) => ({ ...r, extra: '' })),
  })));
  detail('3. Bayaran mengikut perihal', report.outByPerihal.map((g) => ({
    label: g.label, fundId: g.fundId, totalSen: g.totalSen,
    rows: g.rows.map((r) => ({
      date: r.date, refNo: r.refNo, note: r.note, amountSen: r.amountSen,
      extra: r.penceramahName !== null
        ? [r.penceramahName, r.kuliahTitle !== null ? `kuliah ${r.kuliahDate ? dmy(r.kuliahDate) : ''} ${r.kuliahTitle}`.trim() : ''].filter((x) => x !== '').join(', ')
        : (r.payee ?? ''),
    })),
  })));

  // 4. Pembetulan
  section('4. Pembetulan');
  if (report.corrections.length === 0) { page.text(LEFT, y - 9, 'Tiada pembetulan bulan ini.', 9, 'F1', 'left', 0.4); y -= 18; }
  else {
    page.text(LEFT + 4, y - 8.5, 'Tarikh', 8.5, 'F2');
    page.text(LEFT + 62, y - 8.5, 'No.', 8.5, 'F2');
    page.text(LEFT + 112, y - 8.5, 'Catatan asal, jenis, sebab', 8.5, 'F2');
    page.text(RIGHT, y - 8.5, 'Kesan', 8.5, 'F2', 'right');
    y -= 12;
    page.line(LEFT, y, RIGHT, y, 0.5);
    y -= 3;
    for (const c of report.corrections) {
      const text = `${c.originalRefNo ?? ''} ${KIND_MS[c.kind]}${c.lastMonth ? ' (bulan lepas)' : ''}: ${c.reason}`.trim();
      const lines = wrap(text, RIGHT - LEFT - 130 - 90, 8.5);
      need(lines.length * 11 + 2);
      page.text(LEFT + 4, y - 8.5, dmy(c.date), 8.5);
      page.text(LEFT + 62, y - 8.5, c.refNo ?? '', 8.5);
      lines.forEach((ln, i) => page.text(LEFT + 112, y - 8.5 - i * 11, ln, 8.5));
      page.text(RIGHT, y - 8.5, money(c.deltaSen), 8.5, 'F1', 'right');
      y -= lines.length * 11 + 1;
    }
    y -= 8;
  }

  // 5. Tandatangan
  need(110);
  section('5. Tandatangan');
  y -= 26;
  const w = (RIGHT - LEFT - 40) / 3;
  ['Bendahari', 'Pengerusi', 'Tarikh'].forEach((label, i) => {
    const x = LEFT + i * (w + 20);
    page.line(x, y, x + w, y, 0.5);
    page.text(x, y - 11, label, 9);
  });
  y -= 24;
  pages.push(page);

  // footers and the draft stamp on every page, then the file
  const total = pages.length;
  const made = klStamp(report.generatedAt);
  const synced = report.syncedUntil !== null ? klStamp(report.syncedUntil) : '';
  pages.forEach((p, i) => {
    p.line(LEFT, BOTTOM - 4, RIGHT, BOTTOM - 4, 0.4);
    const foot = `Dijana oleh MAXCOM ${made}${synced !== '' ? `, Diselaraskan sehingga ${synced}` : ''}`;
    p.text(LEFT, BOTTOM - 14, foot, 7.5, 'F1', 'left', 0.3);
    p.text(RIGHT, BOTTOM - 14, `muka ${i + 1}/${total}`, 7.5, 'F1', 'right', 0.3);
    if (isDraft) p.stamp('DRAF');
  });
  return assemble(pages);
}

/** Objects: 1 catalog, 2 page tree, 3 and 4 the fonts, then a page and a content stream per page. */
function assemble(pages: PageBuf[]): Buffer {
  const objs: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((p, i) => {
    const content = p.ops.join('\n');
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f2(PAGE_W)} ${f2(PAGE_H)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
    objs[6 + i * 2] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  });
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let pos = chunks[0]!.length;
  for (let i = 1; i < objs.length; i++) {
    const b = Buffer.from(`${i} 0 obj\n${objs[i]}\nendobj\n`, 'latin1');
    offsets[i] = pos;
    chunks.push(b);
    pos += b.length;
  }
  const n = objs.length;
  let xref = `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (let i = 1; i < n; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
