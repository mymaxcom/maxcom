import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMaxtheme } from '../../../scripts/build-maxtheme.mjs';
import { escapeHtml, guideTables } from '../../../scripts/build-theme-guide.mjs';
import { validatePack } from '../src/themes/validate.ts';

const SAMPLE_DIR = resolve(import.meta.dirname, '../../../docs/guide/tema/sample/hijau-siti');
const buf = buildMaxtheme(SAMPLE_DIR);

describe('the sample theme Hijau Siti', () => {
  it('the box accepts the sample with no error and no warning', () => {
    const { report } = validatePack(buf, { installed: {}, contract: 1, enforceVersion: true });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report).toMatchObject({ ok: true, name: 'hijau-siti', title: 'Hijau Siti', version: 1, base: 'creative', contract: 1, screens: ['poster', 'kuliah'], images: { kuliah: 'png' } });
  });

  it('it is small and uses only published hooks', () => {
    expect(buf.length).toBeLessThan(1024 * 1024);
    const css = ['theme.css', 'screens/kuliah.css', 'screens/poster.css'].map((f) => readFileSync(join(SAMPLE_DIR, f), 'utf8')).join('\n');
    const classes = new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]!));
    for (const c of classes) {
      expect(['stage', 'region-main', 'region-prayers', 'region-clock', 'region-brand', 'region-ticker', 'region-live-strip', 'region-next', 'arab', 'arab-tarjamah', 'png'], c).toContain(c);
    }
  });

  it('the same source gives the same bytes', () => {
    expect(buildMaxtheme(SAMPLE_DIR).equals(buf)).toBe(true);
  });

  it('the guide prints exactly this source', () => {
    const norm = (s: string): string => s.replace(/\r\n/g, '\n').trim();
    const html = guideTables('ms').sample;
    for (const f of ['theme.json', 'theme.css', 'screens/kuliah.css', 'screens/poster.css']) {
      expect(html).toContain(escapeHtml(norm(readFileSync(join(SAMPLE_DIR, f), 'utf8'))));
    }
  });

  it('the build refuses a stray file, naming it', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'maxtheme-'));
    cpSync(SAMPLE_DIR, tmp, { recursive: true });
    writeFileSync(join(tmp, 'notes.txt'), 'x');
    expect(() => buildMaxtheme(tmp)).toThrow(/notes\.txt/);
  });
});
