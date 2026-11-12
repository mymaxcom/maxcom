import { crc32, deflateRawSync } from 'node:zlib';

export interface RawEntry {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  /** Declared uncompressed size when it should lie. */
  declaredSize?: number;
  flags?: number;
  crc?: number;
  /** Name written in the local header when it should differ from the directory. */
  localName?: string;
}

/** A zip built by hand so tests can make hostile ones (lying sizes, odd names, thousands of entries). */
export function buildZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name, 'utf8');
    const lname = Buffer.from(e.localName ?? e.name, 'utf8');
    const size = e.declaredSize ?? e.data.length;
    const crc = e.crc ?? (crc32(e.data) >>> 0);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800 | (e.flags ?? 0), 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(lname.length, 26);
    locals.push(lh, lname, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800 | (e.flags ?? 0), 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + lname.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length & 0xffff, 8); end.writeUInt16LE(entries.length & 0xffff, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A workbook with the given sheet XML(s), shared strings and styles, built the way Excel lays it out. */
export function buildXlsx(opts: {
  sheets: Array<{ name: string; xml: string }>;
  sharedStrings?: string;
  styles?: string;
  workbookPr?: string;
  extra?: RawEntry[];
}): Buffer {
  const wrap = (body: string): Buffer => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, 'utf8');
  const entries: RawEntry[] = [
    { name: '[Content_Types].xml', data: wrap('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
    { name: 'xl/workbook.xml', data: wrap(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${opts.workbookPr ?? ''}<sheets>${opts.sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: wrap(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${opts.sheets.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`) },
    ...opts.sheets.map((s, i): RawEntry => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: wrap(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${s.xml}</sheetData></worksheet>`) })),
  ];
  if (opts.sharedStrings !== undefined) entries.push({ name: 'xl/sharedStrings.xml', data: wrap(opts.sharedStrings) });
  if (opts.styles !== undefined) entries.push({ name: 'xl/styles.xml', data: wrap(opts.styles) });
  entries.push(...(opts.extra ?? []));
  return buildZip(entries);
}
