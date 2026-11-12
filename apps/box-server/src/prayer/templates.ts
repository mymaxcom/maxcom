import { writeStoredZip } from '../files/zipWrite.ts';

export interface TemplateInfo {
  name: string;
  kind: 'surau' | 'masjid';
  country: string;
  /** The JAKIM zone in Malaysia, else the city. */
  place: string;
}

const BASE = ['tarikh', 'imsak', 'subuh', 'syuruk', 'dhuha', 'zohor', 'asar', 'maghrib', 'isyak', 'nota'];
const MASJID = ['jumaat_khutbah', 'iqamah_subuh', 'iqamah_zohor', 'iqamah_asar', 'iqamah_maghrib', 'iqamah_isyak'];

export const templateColumns = (kind: 'surau' | 'masjid'): string[] => (kind === 'masjid' ? [...BASE, ...MASJID] : [...BASE]);

export function datesOfYear(year: number): string[] {
  const out: string[] = [];
  for (let t = Date.UTC(year, 0, 1); new Date(t).getUTCFullYear() === year; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

const plain = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();

function commentLine(info: TemplateInfo): string {
  return `# ${plain(info.name)}, ${info.kind}, ${info.country}, ${plain(info.place)}`;
}

/** The empty yearly timetable as CSV: a comment line naming the surau, the header, then every date of the year. */
export function csvTemplate(year: number, info: TemplateInfo): string {
  const cols = templateColumns(info.kind);
  const lines = [commentLine(info), cols.join(',')];
  for (const d of datesOfYear(year)) lines.push([d, ...cols.slice(1).map(() => '')].join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');

function colName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** The same template as a one-sheet workbook (all cells text, so Excel never turns a time into a date). */
export function xlsxTemplate(year: number, info: TemplateInfo, now: Date = new Date()): Buffer {
  const cols = templateColumns(info.kind);
  const rows: string[][] = [[commentLine(info)], cols];
  for (const d of datesOfYear(year)) rows.push([d]);
  const sheetRows = rows.map((cells, r) => {
    const cs = cells.map((v, c) => (v === '' ? '' : `<c r="${colName(c)}${r + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`)).join('');
    return `<row r="${r + 1}">${cs}</row>`;
  }).join('');
  const xml = (body: string): Buffer => Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`, 'utf8');
  return writeStoredZip([
    { name: '[Content_Types].xml', data: xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>') },
    { name: '_rels/.rels', data: xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
    { name: 'xl/workbook.xml', data: xml('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Jadual" sheetId="1" r:id="rId1"/></sheets></workbook>') },
    { name: 'xl/_rels/workbook.xml.rels', data: xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>') },
    { name: 'xl/worksheets/sheet1.xml', data: xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`) },
  ], now);
}
