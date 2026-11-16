import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { buildGuide, pdfInfo } from '../../../scripts/build-theme-guide.mjs';

/** A folder with a small PNG of every picture name the guide may ask for. */
function fixtureShots(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guide-pdf-shots-'));
  const png = PNG.sync.write(Object.assign(new PNG({ width: 96, height: 54 }), { data: Buffer.alloc(96 * 54 * 4, 180) }));
  const states = ['biasa', 'azan', 'masuk-waktu', 'iqamah', 'solat', 'jumaat', 'tiada-data', 'poster', 'normal', 'program', 'hadis', 'pengumuman', 'takwim', 'tabung', 'ayat'];
  for (const s of states) writeFileSync(join(dir, `creative-${s}.png`), png);
  writeFileSync(join(dir, 'creative-normal-regions.png'), png);
  for (const t of ['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic']) writeFileSync(join(dir, `${t}-biasa.png`), png);
  return dir;
}

it('both PDFs are real, A4, between 12 and 60 pages, under 10 MB', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'guide-pdf-'));
  await buildGuide({ shots: fixtureShots(), pdf: true, outDir: tmp });
  for (const f of ['panduan-tema.pdf', 'theme-guide.pdf']) {
    const b = readFileSync(join(tmp, f));
    expect(b.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(b.length).toBeLessThan(10 * 1024 * 1024);
    const { pages } = pdfInfo(b);
    expect(pages).toBeGreaterThanOrEqual(12);
    expect(pages).toBeLessThanOrEqual(60);
    // A4 is about 595 by 842 points
    expect(b.toString('latin1')).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+59[56](?:\.\d+)?\s+84[23](?:\.\d+)?\s*\]/);
  }
}, 120_000);
