import { describe, expect, it } from 'vitest';
import { openXlsx, XlsxError } from '../src/files/xlsxRead.ts';
import { buildXlsx, buildZip } from './support/zipBuild.ts';

const STYLES = '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd hh:mm"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="20"/><xf numFmtId="164"/></cellXfs></styleSheet>';
const SST = '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>tarikh</t></si><si><r><t>Sub</t></r><r><t>uh</t></r><rPh><t>x</t></rPh></si></sst>';
const FIRST = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" s="1"><v>46357</v></c><c r="B2" s="2"><v>0.2417</v></c><c r="C2"><v>12.5</v></c><c r="D2" t="inlineStr"><is><t>a &amp; b &lt;c&gt; &#65;</t></is></c><c r="E2" s="3"><v>46357.5</v></c></row><row r="4"><c r="A4" t="b"><v>1</v></c></row>';

describe('openXlsx', () => {
  it('reads shared strings, dates, times, numbers, inline strings and entities', () => {
    const book = openXlsx(buildXlsx({ sheets: [{ name: 'Jadual', xml: FIRST }], sharedStrings: SST, styles: STYLES }));
    expect(book.sheets).toEqual([{ name: 'Jadual', part: 'xl/worksheets/sheet1.xml' }]);
    const rows = book.readSheet('xl/worksheets/sheet1.xml');
    expect(rows[0]).toEqual(['tarikh', 'Subuh']);
    expect(rows[1]).toEqual(['2026-12-01', '05:48', '12.5', 'a & b <c> A', '2026-12-01 12:00']);
    expect(rows[2]).toEqual([]);
    expect(rows[3]).toEqual(['TRUE']);
  });

  it('knows the 1904 date system and the 1900 leap year bug', () => {
    const cells = '<row r="1"><c r="A1" s="1"><v>59</v></c><c r="B1" s="1"><v>61</v></c></row>';
    const a = openXlsx(buildXlsx({ sheets: [{ name: 'S', xml: cells }], styles: STYLES })).readSheet('xl/worksheets/sheet1.xml');
    expect(a[0]).toEqual(['1900-02-28', '1900-03-01']);
    const b = openXlsx(buildXlsx({ sheets: [{ name: 'S', xml: '<row r="1"><c r="A1" s="1"><v>44895</v></c></row>' }], styles: STYLES, workbookPr: '<workbookPr date1904="1"/>' })).readSheet('xl/worksheets/sheet1.xml');
    expect(b[0]![0]).toBe('2026-12-01');
  });

  it('lists several sheets and reads the one asked for', () => {
    const book = openXlsx(buildXlsx({ sheets: [
      { name: 'Satu', xml: '<row r="1"><c r="A1" t="inlineStr"><is><t>one</t></is></c></row>' },
      { name: 'Jadual', xml: '<row r="1"><c r="A1" t="inlineStr"><is><t>two</t></is></c></row>' },
    ] }));
    expect(book.sheets.map((s) => s.name)).toEqual(['Satu', 'Jadual']);
    expect(book.readSheet(book.sheets[1]!.part)[0]).toEqual(['two']);
    expect(() => book.readSheet('xl/worksheets/sheet9.xml')).toThrow(XlsxError);
  });

  it('refuses DOCTYPE, ENTITY and CDATA in a sheet, in shared strings and in the workbook', () => {
    const doctype = '<!DOCTYPE x [<!ENTITY a "b">]>';
    const sheet = buildXlsx({ sheets: [{ name: 'S', xml: `${doctype}<row r="1"/>` }] });
    expect(() => openXlsx(sheet).readSheet('xl/worksheets/sheet1.xml')).toThrow(/DOCTYPE/);
    const sst = buildXlsx({ sheets: [{ name: 'S', xml: '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' }], sharedStrings: `${doctype}<sst/>` });
    expect(() => openXlsx(sst).readSheet('xl/worksheets/sheet1.xml')).toThrow(/DOCTYPE/);
    const cdata = buildXlsx({ sheets: [{ name: 'S', xml: '<row r="1"><c r="A1" t="inlineStr"><is><t><![CDATA[x]]></t></is></c></row>' }] });
    expect(() => openXlsx(cdata).readSheet('xl/worksheets/sheet1.xml')).toThrow(XlsxError);
  });

  it('refuses an entity it does not know and leaves a double-escaped one as text', () => {
    const bad = buildXlsx({ sheets: [{ name: 'S', xml: '<row r="1"><c r="A1" t="inlineStr"><is><t>&xxe;</t></is></c></row>' }] });
    expect(() => openXlsx(bad).readSheet('xl/worksheets/sheet1.xml')).toThrow(/entity/);
    const ok = buildXlsx({ sheets: [{ name: 'S', xml: '<row r="1"><c r="A1" t="inlineStr"><is><t>&amp;lt;</t></is></c></row>' }] });
    expect(openXlsx(ok).readSheet('xl/worksheets/sheet1.xml')[0]).toEqual(['&lt;']);
  });

  it('refuses a 5 MB shared strings part, a bad cell reference, a bad string index and too many columns or rows', () => {
    const big = buildXlsx({ sheets: [{ name: 'S', xml: '<row r="1"/>' }], sharedStrings: `<sst>${'<si><t>aaaaaaaaaa</t></si>'.repeat(200_000)}</sst>` });
    expect(() => openXlsx(big)).toThrow(/too large/);
    const mk = (cells: string) => openXlsx(buildXlsx({ sheets: [{ name: 'S', xml: cells }], sharedStrings: SST }));
    expect(() => mk('<row r="1"><c r="ZZ99999999" t="n"><v>1</v></c></row>').readSheet('xl/worksheets/sheet1.xml')).toThrow(/cell reference/);
    expect(() => mk('<row r="1"><c r="A1" t="s"><v>9</v></c></row>').readSheet('xl/worksheets/sheet1.xml')).toThrow(/shared string/);
    expect(() => mk('<row r="1"><c r="DZ1"><v>1</v></c></row>').readSheet('xl/worksheets/sheet1.xml')).toThrow(/columns/);
    expect(() => mk('<row r="30000"><c r="A30000"><v>1</v></c></row>').readSheet('xl/worksheets/sheet1.xml')).toThrow(/rows/);
    expect(() => mk('<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>1</v></c></row>').readSheet('xl/worksheets/sheet1.xml', { maxRows: 10, maxCols: 10, maxCells: 1 })).toThrow(/cells/);
  });

  it('ignores a sheet entry named to climb out, and refuses a zip that is not a workbook', () => {
    const evil = buildXlsx({ sheets: [{ name: 'S', xml: '<row r="1"/>' }], extra: [{ name: 'xl/worksheets/../../x', data: Buffer.from('x') }] });
    expect(() => openXlsx(evil)).toThrow(XlsxError);
    expect(() => openXlsx(buildZip([{ name: 'readme.txt', data: Buffer.from('x') }]))).toThrow(/not a workbook/);
    expect(() => openXlsx(Buffer.from('plain text'))).toThrow(XlsxError);
  });
});

describe('openXlsx scanning is linear', () => {
  const limit = 3000;
  const timed = (fn: () => void): number => { const t0 = Date.now(); fn(); return Date.now() - t0; };

  it('a sheet of cell openers that never close is read in a tight time', () => {
    const xml = '<row r="1">' + '<c r="A1">'.repeat(350_000);
    const ms = timed(() => {
      const book = openXlsx(buildXlsx({ sheets: [{ name: 'S', xml }] }));
      try { book.readSheet('xl/worksheets/sheet1.xml'); } catch (e) { expect(e).toBeInstanceOf(XlsxError); }
    });
    expect(ms).toBeLessThan(limit);
  });

  it('a sheet part at the 16 MB entry cap is refused as too large, and fast', () => {
    const xml = '<row r="1">' + '<c r="A1">'.repeat(1_600_000);
    const ms = timed(() => {
      const book = openXlsx(buildXlsx({ sheets: [{ name: 'S', xml }] }));
      expect(() => book.readSheet('xl/worksheets/sheet1.xml')).toThrow(/too large/);
    });
    expect(ms).toBeLessThan(limit);
  });

  it('shared strings of <si> and <t> openers that never close are read in a tight time', () => {
    const sheet = '<row r="1"><c r="A1" t="s"><v>0</v></c></row>';
    for (const sst of [`<sst>${'<si>'.repeat(900_000)}</sst>`, `<sst><si>${'<t>'.repeat(1_300_000)}</si></sst>`, `<sst><si>${'<rPh>'.repeat(700_000)}</si></sst>`]) {
      const ms = timed(() => {
        const book = openXlsx(buildXlsx({ sheets: [{ name: 'S', xml: sheet }], sharedStrings: sst }));
        try { book.readSheet('xl/worksheets/sheet1.xml'); } catch (e) { expect(e).toBeInstanceOf(XlsxError); }
      });
      expect(ms).toBeLessThan(limit);
    }
  });

  it('self-closing cells, an unclosed cell between good ones and v/is openers inside a cell still parse', () => {
    const xml = '<row r="1"><c r="A1"/><c r="B1" t="inlineStr"><is><t>x</t></is></c><c r="C1"><v>7</v></c></row>';
    const rows = openXlsx(buildXlsx({ sheets: [{ name: 'S', xml }] })).readSheet('xl/worksheets/sheet1.xml');
    expect(rows[0]).toEqual(['', 'x', '7']);
    const odd = '<row r="1"><c r="A1"><v>' + '<v>'.repeat(100_000) + '</c></row>';
    expect(() => openXlsx(buildXlsx({ sheets: [{ name: 'S', xml: odd }] })).readSheet('xl/worksheets/sheet1.xml')).not.toThrow();
  });
});
