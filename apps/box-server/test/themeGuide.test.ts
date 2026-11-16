import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { SCREEN_IDS } from '@surau/core';
import { BOX_SCREEN_IDS } from '../src/themes/cssCheck.ts';
import { EN_SRC, MS_SRC, buildGuide, fillSlots, guideTables } from '../../../scripts/build-theme-guide.mjs';

const ms = guideTables('ms');
const en = guideTables('en');

/** A folder with a small PNG of every picture name the guide may ask for. */
function fixtureShots(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guide-shots-'));
  const png = PNG.sync.write(Object.assign(new PNG({ width: 16, height: 9 }), { data: Buffer.alloc(16 * 9 * 4, 200) }));
  const states = ['biasa', 'azan', 'masuk-waktu', 'iqamah', 'solat', 'jumaat', 'tiada-data', 'poster', 'normal', 'program', 'hadis', 'pengumuman', 'takwim', 'tabung', 'ayat'];
  for (const s of states) writeFileSync(join(dir, `creative-${s}.png`), png);
  writeFileSync(join(dir, 'creative-normal-regions.png'), png);
  for (const t of ['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic']) writeFileSync(join(dir, `${t}-biasa.png`), png);
  return dir;
}

describe('the theme guide, generated from the contract', () => {
  it('the screens table holds every catalog id exactly once, in order', () => {
    const ids = [...ms.screens.matchAll(/<code class="sid">([a-z-]+)<\/code>/g)].map((m) => m[1]);
    expect(ids).toEqual([...SCREEN_IDS]);
  });

  it('regions, attributes and variables are all there', () => {
    for (const c of ['.region-main', '.region-prayers', '.region-clock', '.region-brand', '.region-ticker', '.region-live-strip', '.region-next', '.arab', '.arab-tarjamah']) {
      expect(ms.regions + ms.arabic, c).toContain(c);
    }
    for (const a of ['data-screen', 'data-phase', 'data-card', 'data-live', 'data-align', 'data-lang']) expect(en.attributes, a).toContain(a);
    for (const v of ['--bg-image', '--bg-fit', '--bg-size', '--bg-pos', '--shade', '--accent', '--text', '--font', '--scale', 'data-align']) expect(en.variables, v).toContain(v);
  });

  it('limits and refusals come from the code', () => {
    expect(ms.files).toContain('15 MB');
    expect(ms.files).toContain('60');
    expect(ms.files).toContain('images/semua');
    expect(ms.refused).toContain('Tema ini memerlukan MAXCOM yang lebih baharu');
    expect(en.refused).toContain('This theme needs a newer MAXCOM');
    for (const id of BOX_SCREEN_IDS) expect(en.refused, id).toContain(id);
  });

  it('the Chrome 91 list is the validator\'s own', () => {
    for (const w of ['@container', '@layer', 'color-mix()', 'CSS nesting']) expect(en.warnings, w).toContain(escape(w));
    // backdrop-filter is now an error (it can hide the clock), so it is no longer a warning
    expect(en.warnings).not.toContain('backdrop-filter');
  });

  it('theme names are the six English names in both languages', () => {
    for (const n of ['Default', 'Colourful', 'Creative', 'Old School', 'Minimal', 'Arabic Art']) {
      expect(ms.themes).toContain(n);
      expect(en.themes).toContain(n);
    }
  });

  it('both sources fill completely and have the same 14 sections', () => {
    const a = fillSlots(readFileSync(MS_SRC, 'utf8'), ms);
    const b = fillSlots(readFileSync(EN_SRC, 'utf8'), en);
    expect(a).not.toContain('<!--slot:');
    expect(a).not.toContain('{{contract}}');
    expect((a.match(/<h2/g) ?? []).length).toBe(14);
    expect((b.match(/<h2/g) ?? []).length).toBe(14);
  });

  it('the v1 pack rules are in the guide: no fonts, PNG or JPEG only, the refused properties, the scoping, the new refusal codes', () => {
    for (const t of [en, ms]) {
      expect(t.files).not.toContain('woff2');
      expect(t.files).not.toContain('webp');
      expect(t.files).toContain('1 MB');
      for (const code of ['css_font', 'css_property', 'css_scope', 'css_string', 'too_many_installs', 'bad_font', 'reserved_name']) expect(t.refused, code).toContain(code);
      expect(t.refused).not.toContain('woff2');
    }
    const enHtml = fillSlots(readFileSync(EN_SRC, 'utf8'), en);
    const msHtml = fillSlots(readFileSync(MS_SRC, 'utf8'), ms);
    for (const html of [enHtml, msHtml]) {
      for (const w of ['mix-blend-mode', 'transform', 'z-index', 'pointer-events', '!important', '.screen--shell', '.shell-top', 'data-live-layout', 'data-harakat', 'data-kind', 'arab-ayat', 'text-indent', 'data-theme']) {
        expect(html, w).toContain(w);
      }
      expect(html).not.toMatch(/fonts\/&lt;/);
      expect(html).not.toContain('mxf-');
      expect(html).not.toContain('.webp');
    }
    expect(en.attributes).toContain('data-kind');
    expect(en.attributes).toContain('data-live-layout');
    expect(en.attributes).toContain('data-harakat');
    expect(en.protected).toContain('z-index: 35');
    expect(en.protected).toContain('every 60 seconds');
    expect(ms.protected).toContain('setiap 60 saat');
  });

  it('a slot without a table, or a table without a slot, throws', () => {
    expect(() => fillSlots('<!--slot:nope-->', ms)).toThrow();
    expect(() => fillSlots(readFileSync(EN_SRC, 'utf8').replace('<!--slot:sample-->', ''), en)).toThrow(/no slot/);
  });

  it('BM wording and symbols', () => {
    const text = fillSlots(readFileSync(MS_SRC, 'utf8'), ms).replace(/<[^>]+>/g, ' ');
    for (const w of ['unduh', 'unggah', 'bisa', 'butuh', 'kamu', 'gimana', 'silakan', 'berkas']) expect(text.toLowerCase(), w).not.toMatch(new RegExp(`\\b${w}\\b`));
    for (const s of ['—', '–', '→', '←', '≈', '✓']) expect(text).not.toContain(s);
    expect(text).toContain('muat turun');
    expect(text).toContain('muat naik');
  });

  it('no dashes or arrows in the English guide either', () => {
    const text = fillSlots(readFileSync(EN_SRC, 'utf8'), en).replace(/<[^>]+>/g, ' ');
    for (const s of ['—', '–', '→', '←', '≈', '✓']) expect(text).not.toContain(s);
  });

  it('the contract promise is stated in both', () => {
    expect(readFileSync(MS_SRC, 'utf8')).toContain('Nombor kontrak hanya naik apabila ada perubahan yang memecahkan tema lama. Tema lama terus berfungsi pada versi kontraknya sekurang-kurangnya setahun.');
    expect(readFileSync(EN_SRC, 'utf8')).toContain('The contract number goes up only on a breaking change. Older themes keep working on their contract version for at least a year.');
  });

  it('the built page loads nothing from outside', async () => {
    const out = mkdtempSync(join(tmpdir(), 'guide-out-'));
    await buildGuide({ shots: fixtureShots(), outDir: out });
    for (const f of ['panduan-tema.html', 'theme-guide.html']) {
      const html = readFileSync(join(out, f), 'utf8');
      expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
      expect(html).not.toMatch(/<link\b/i);
      expect(html).not.toMatch(/<script\b/i);
      expect(html).not.toMatch(/src="shots\//);
      expect(html).toContain('data:image/jpeg;base64,');
      expect(html).toContain('<style>');
    }
  }, 60_000);
});

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
