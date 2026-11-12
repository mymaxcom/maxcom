import { readZipEntries, ZipError } from './zipRead.ts';
import type { ZipCaps } from './zipRead.ts';

/**
 * A constrained reader for the cells of an .xlsx sheet. It is a tokenizer for four known part kinds, not an XML
 * parser: no DOCTYPE, no entity definitions, no CDATA, no external references; only the five predefined
 * entities and numeric character references are decoded. Everything is capped (rows, columns, cells, part
 * sizes) and every refusal has a fixed message.
 */

export class XlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxError';
  }
}

export interface XlsxCaps { maxRows: number; maxCols: number; maxCells: number }
export const DEFAULT_XLSX_CAPS: XlsxCaps = { maxRows: 20_005, maxCols: 100, maxCells: 400_000 };

const ZIP_CAPS: ZipCaps = { maxEntries: 2000, maxEntryBytes: 16 * 1024 * 1024, maxTotalBytes: 40 * 1024 * 1024 };
const MAX_SHARED_BYTES = 4 * 1024 * 1024;
const MAX_SHEET_BYTES = 4 * 1024 * 1024;
const MAX_SMALL_PART = 256 * 1024;
const MAX_SHARED_STRINGS = 400_000;
const MAX_CELL_TEXT = 1000;
const SHEET_PART = /^xl\/worksheets\/sheet\d{1,3}\.xml$/;

const WANTED = (name: string): boolean =>
  name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels' || name === 'xl/sharedStrings.xml'
  || name === 'xl/styles.xml' || SHEET_PART.test(name);

export interface XlsxSheet { name: string; part: string }
export interface XlsxBook {
  sheets: XlsxSheet[];
  /** Rows of display strings, index 0 = sheet row 1; dates as YYYY-MM-DD, times as HH:mm. */
  readSheet(part: string, caps?: XlsxCaps): string[][];
}

function refuseMarkup(xml: string): void {
  if (/<!\s*(?:DOCTYPE|ENTITY|ELEMENT|ATTLIST|\[CDATA\[)/i.test(xml)) throw new XlsxError('xlsx: DOCTYPE, ENTITY and CDATA are not allowed');
  if (/<!\s*\[/.test(xml)) throw new XlsxError('xlsx: unsupported markup');
}

function decode(text: string): string {
  // One pass: a valid reference is decoded, any other ampersand is refused (so "&amp;lt;" stays "&lt;" text).
  return text.replace(/&(?:(#x[0-9A-Fa-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);)?/g, (_m, e: string | undefined) => {
    switch (e) {
      case undefined: throw new XlsxError('xlsx: entity not allowed');
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        if (!Number.isInteger(cp) || cp < 0x20 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return ' ';
        return String.fromCodePoint(cp);
      }
    }
  });
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m ? decode(m[1]!) : undefined;
}

const isWordChar = (code: number): boolean =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || code === 95 || (code >= 97 && code <= 122);

interface Elem { attrs: string; inner: string | undefined; start: number; end: number }

/**
 * Linear scan for `<tag ...>inner</tag>` and `<tag .../>`. Every step advances with indexOf, so a part of any size
 * with openers that never close costs one pass, not one pass per opener (the lazy-regex form was quadratic).
 */
function* elements(xml: string, tag: string): Generator<Elem> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let pos = 0;
  let closeAt = -2;
  for (;;) {
    const i = xml.indexOf(open, pos);
    if (i < 0) return;
    const after = i + open.length;
    if (after < xml.length && isWordChar(xml.charCodeAt(after))) { pos = after; continue; }
    const gt = xml.indexOf('>', after);
    if (gt < 0) return;
    if (gt > after && xml.charCodeAt(gt - 1) === 47) {
      yield { attrs: xml.slice(after, gt - 1), inner: undefined, start: i, end: gt + 1 };
      pos = gt + 1;
      continue;
    }
    if (closeAt !== -1 && closeAt < gt + 1) closeAt = xml.indexOf(close, gt + 1);
    if (closeAt < 0) { pos = gt + 1; continue; }
    yield { attrs: xml.slice(after, gt), inner: xml.slice(gt + 1, closeAt), start: i, end: closeAt + close.length };
    pos = closeAt + close.length;
  }
}

function firstInner(xml: string, tag: string): string | undefined {
  for (const e of elements(xml, tag)) if (e.inner !== undefined) return e.inner;
  return undefined;
}

function withoutPhonetic(inner: string): string {
  let out = '';
  let last = 0;
  for (const e of elements(inner, 'rPh')) {
    out += inner.slice(last, e.start);
    last = e.end;
  }
  return last === 0 ? inner : out + inner.slice(last);
}

function textOf(inner: string): string {
  let out = '';
  for (const e of elements(withoutPhonetic(inner), 't')) if (e.inner !== undefined) out += decode(e.inner);
  return out;
}

function sharedStrings(xml: string): string[] {
  refuseMarkup(xml);
  const out: string[] = [];
  for (const e of elements(xml, 'si')) {
    if (out.length >= MAX_SHARED_STRINGS) throw new XlsxError('xlsx: too many shared strings');
    out.push(textOf(e.inner ?? '').slice(0, MAX_CELL_TEXT));
  }
  return out;
}

const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** For each cell style index: 'date' (has a date part), 'time' (time only) or null. */
function dateStyles(xml: string | undefined): Array<'date' | 'time' | null> {
  if (xml === undefined) return [];
  refuseMarkup(xml);
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b([^>]*?)\/?>/g)) {
    const id = Number(attr(m[1]!, 'numFmtId'));
    const code = attr(m[1]!, 'formatCode');
    if (Number.isInteger(id) && code !== undefined) custom.set(id, code);
  }
  const kind = (id: number): 'date' | 'time' | null => {
    if (BUILTIN_DATE_IDS.has(id)) return id >= 18 && id <= 21 || id === 45 || id === 46 ? 'time' : 'date';
    const code = custom.get(id);
    if (code === undefined) return null;
    const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
    const hasDate = /[dyg]/i.test(bare) || /m{1,2}(?![a-z]*:)/i.test(bare.replace(/h[^dmy]*m/gi, 'h'));
    const hasTime = /[hs]/i.test(bare) || /h.*m|m.*s/i.test(bare);
    if (hasDate && /[dy]/i.test(bare)) return 'date';
    return hasTime ? 'time' : null;
  };
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  const out: Array<'date' | 'time' | null> = [];
  if (cellXfs) {
    for (const m of cellXfs[1]!.matchAll(/<xf\b([^>]*?)\/?>/g)) {
      const id = Number(attr(m[1]!, 'numFmtId') ?? '0');
      out.push(Number.isInteger(id) ? kind(id) : null);
    }
  }
  return out;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Excel serial -> 'YYYY-MM-DD', 'HH:mm' or both, by the cell's style kind. 1900 system with its leap year bug, or 1904. */
function serialText(serial: number, kind: 'date' | 'time', date1904: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  const whole = Math.floor(serial);
  const frac = serial - whole;
  // Whole seconds first (to absorb floating point noise), then the minute is truncated: 05:59:59 is 05:59, never 06:00.
  let minutes = Math.floor(Math.round(frac * 86_400) / 60);
  let day = whole;
  if (minutes === 1440) { minutes = 0; day += 1; }
  const hhmm = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  if (kind === 'time' && whole === 0) return hhmm;
  let epochMs: number;
  if (date1904) epochMs = Date.UTC(1904, 0, 1) + day * 86_400_000;
  else epochMs = day < 60 ? Date.UTC(1899, 11, 31) + day * 86_400_000 : Date.UTC(1899, 11, 30) + day * 86_400_000;
  const d = new Date(epochMs);
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (kind === 'time') return hhmm;
  return minutes === 0 && frac === 0 ? ymd : `${ymd} ${hhmm}`;
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function openXlsx(buf: Buffer): XlsxBook {
  let parts: Map<string, Buffer>;
  try {
    parts = readZipEntries(buf, WANTED, ZIP_CAPS);
  } catch (error) {
    throw new XlsxError(error instanceof ZipError ? `xlsx: ${error.message}` : 'xlsx: not a workbook');
  }
  const wb = parts.get('xl/workbook.xml');
  const rels = parts.get('xl/_rels/workbook.xml.rels');
  if (!wb || !rels) throw new XlsxError('xlsx: not a workbook');
  if (wb.length > MAX_SMALL_PART || rels.length > MAX_SMALL_PART) throw new XlsxError('xlsx: part too large');
  const shared = parts.get('xl/sharedStrings.xml');
  if (shared && shared.length > MAX_SHARED_BYTES) throw new XlsxError('xlsx: part too large');
  const styles = parts.get('xl/styles.xml');
  if (styles && styles.length > MAX_SMALL_PART * 4) throw new XlsxError('xlsx: part too large');

  const wbXml = wb.toString('utf8');
  const relXml = rels.toString('utf8');
  refuseMarkup(wbXml);
  refuseMarkup(relXml);
  const targets = new Map<string, string>();
  for (const m of relXml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(m[1]!, 'Id');
    const target = attr(m[1]!, 'Target');
    if (id !== undefined && target !== undefined) targets.set(id, target);
  }
  const sheets: XlsxSheet[] = [];
  for (const m of wbXml.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const name = attr(m[1]!, 'name');
    const rid = attr(m[1]!, 'r:id') ?? attr(m[1]!, 'id');
    const target = rid === undefined ? undefined : targets.get(rid);
    if (name === undefined || target === undefined) continue;
    const part = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    if (!SHEET_PART.test(part)) continue;
    sheets.push({ name: name.slice(0, 31), part });
  }
  if (sheets.length === 0) throw new XlsxError('xlsx: no sheet found');
  const date1904 = /<workbookPr\b[^>]*\bdate1904\s*=\s*"(?:1|true)"/i.test(wbXml);

  let strings: string[] | null = null;
  let kinds: Array<'date' | 'time' | null> | null = null;

  return {
    sheets,
    readSheet(part: string, caps: XlsxCaps = DEFAULT_XLSX_CAPS): string[][] {
      const data = parts.get(part);
      if (!data || !sheets.some((s) => s.part === part)) throw new XlsxError('xlsx: sheet not found');
      strings ??= shared ? sharedStrings(shared.toString('utf8')) : [];
      kinds ??= dateStyles(styles?.toString('utf8'));
      if (data.length > MAX_SHEET_BYTES) throw new XlsxError('xlsx: part too large');
      const xml = data.toString('utf8');
      refuseMarkup(xml);
      const grid: string[][] = [];
      let cells = 0;
      for (const cell of elements(xml, 'c')) {
        const attrs = cell.attrs;
        const inner = cell.inner ?? '';
        const ref = /^([A-Z]{1,3})(\d{1,7})$/.exec(attr(attrs, 'r') ?? '');
        if (!ref) throw new XlsxError('xlsx: bad cell reference');
        const col = colIndex(ref[1]!);
        const row = Number(ref[2]) - 1;
        if (row < 0 || row >= caps.maxRows) throw new XlsxError('xlsx: too many rows');
        if (col >= caps.maxCols) throw new XlsxError('xlsx: too many columns');
        if (++cells > caps.maxCells) throw new XlsxError('xlsx: too many cells');
        const t = attr(attrs, 't') ?? 'n';
        const v = firstInner(inner, 'v');
        let value = '';
        if (t === 'inlineStr') {
          const is = firstInner(inner, 'is');
          value = is === undefined ? '' : textOf(is);
        } else if (v !== undefined) {
          const raw = decode(v).trim();
          if (t === 's') {
            const i = Number(raw);
            if (!Number.isInteger(i) || i < 0 || i >= strings.length) throw new XlsxError('xlsx: bad shared string index');
            value = strings[i]!;
          } else if (t === 'b') {
            value = raw === '1' ? 'TRUE' : 'FALSE';
          } else if (t === 'str' || t === 'e') {
            value = raw;
          } else {
            const kind = kinds[Number(attr(attrs, 's') ?? '0')] ?? null;
            const num = Number(raw);
            value = kind !== null && raw !== '' && Number.isFinite(num) ? (serialText(num, kind, date1904) ?? raw) : raw;
          }
        }
        value = value.slice(0, MAX_CELL_TEXT);
        while (grid.length <= row) grid.push([]);
        const line = grid[row]!;
        while (line.length <= col) line.push('');
        line[col] = value;
      }
      while (grid.length > 0 && grid[grid.length - 1]!.every((c) => c === '')) grid.pop();
      return grid;
    },
  };
}
