import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { srcDir } from './themeCss.ts';
import { checkScreenHealth, minSizeOf, requiredRoles } from '../src/themes/health.ts';
import type { ElMetrics } from '../src/themes/health.ts';
import minSizes from '../src/themes/minSizes.json';

const dir = resolve(srcDir(), 'themes/arabic');
const css = readFileSync(resolve(dir, 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const arabicCss = readFileSync(resolve(dir, 'arabic.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every selector of a stylesheet (top-level rules; the theme has no at-rules with rules inside). */
function allSelectors(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    let depth = 0;
    let cur = '';
    for (const ch of m[1]!) {
      if (ch === '(' || ch === '[') depth += 1;
      if (ch === ')' || ch === ']') depth -= 1;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    out.push(cur.trim());
  }
  return out.filter((s) => s !== '' && !s.startsWith('@'));
}
/** The body of the first rule whose selector list contains `selector`. */
function bodyFor(text: string, selector: string): string {
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.split(',').some((s) => s.trim() === selector)) return m[2]!;
  }
  throw new Error(`rule not found: ${selector}`);
}
const alphaOf = (v: string): number => {
  const m = v.match(/rgb\(\s*\d+\s+\d+\s+\d+\s*\/\s*([\d.]+)\s*\)/) ?? v.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/);
  if (!m) throw new Error(`no alpha in ${v}`);
  return Number(m[1]);
};

describe('the Arabic Art theme stylesheet', () => {
  it('every selector is scoped to the arabic template', () => {
    for (const sel of [...allSelectors(css), ...allSelectors(arabicCss)]) expect(sel, sel).toMatch(/^\.stage\[data-template='arabic'\]/);
  });

  it('has a dress for every kind and for the Arabic and poster screens', () => {
    for (const k of ['hero', 'content', 'live']) expect(css, k).toContain(`[data-kind='${k}']`);
    // the main (full) screen is dressed through the main layout's own classes (.pbar arches, .ident, .next)
    expect(css).toContain('.pbar .pcell');
    for (const s of ['arab-ayat', 'arab-hadis', 'arab-zikir', 'poster']) expect(css, s).toContain(`[data-screen='${s}']`);
    expect(css).toContain('.live-screen__frame');
  });

  it('Arabic names and the Arabic date are shown; the stage is not mirrored', () => {
    expect(css).toMatch(/\.pcell-ar[^{]*\{[^}]*display:\s*block/);
    expect(css).toMatch(/\.date-ar[^{]*\{[^}]*display:\s*block/);
    expect(css).not.toMatch(/\.stage\[data-template='arabic'\]\s*\{[^}]*direction:\s*rtl/);
    expect(css + arabicCss).not.toContain('data-mirror');
    expect(css + arabicCss).not.toMatch(/direction:\s*rtl/);
  });

  it('the translation backing on the Arabic ayat screen is dark enough', () => {
    const body = bodyFor(css, ".stage[data-template='arabic'][data-screen='arab-ayat'] .aa-tr");
    expect(alphaOf(/background:\s*([^;]+);/.exec(body)![1]!)).toBeGreaterThanOrEqual(0.82);
  });

  it('ornaments are local files; nothing loads from outside; Chrome 91 only', () => {
    expect(css + arabicCss).not.toMatch(/url\(\s*['"]?(https?:|\/\/)/);
    expect(css + arabicCss).not.toMatch(/backdrop-filter|:has\(|@container|color-mix\(|@import/);
    for (const m of (css + arabicCss).matchAll(/url\(\s*['"]?([^'")]+)/g)) {
      expect(m[1], m[1]).toMatch(/^\.\/img\/khat-(star|rosette|arch|cartouche)\.svg$/);
    }
  });

  it('the four SVG files hold no script, no external reference and no embedded raster', () => {
    const files = readdirSync(resolve(dir, 'img'));
    expect(files.sort()).toEqual(['khat-arch.svg', 'khat-cartouche.svg', 'khat-rosette.svg', 'khat-star.svg']);
    for (const f of files) {
      const text = readFileSync(resolve(dir, 'img', f), 'utf8');
      expect(text, f).not.toMatch(/<script|href=["']https?:|xlink:href|<image|onload|<foreignObject|data:/i);
      expect(text, f).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    }
  });

  it('the typography file starts the Arabic from Amiri and the Quran from QPC Hafs, below the surau\'s own face', () => {
    expect(arabicCss).toContain("--font-arab: 'Amiri'");
    expect(arabicCss).toContain("--font-quran: 'QPC Hafs'");
    expect(arabicCss).toContain('--ar-lh: 1.95');
    // :where keeps these defaults at the lowest specificity so the data-arfont rules of the contract win
    expect(arabicCss).toMatch(/:where\(\.arab, \.arabic\)/);
  });

  it('the theme ships its files and its defaults', () => {
    expect(existsSync(resolve(dir, 'theme.json'))).toBe(true);
    const json = JSON.parse(readFileSync(resolve(dir, 'theme.json'), 'utf8'));
    expect(json).toMatchObject({ name: 'arabic', title: 'Arabic Art', base: 'arabic', defaults: { semua: { arFont: 'hafs' } } });
  });
});

describe('the health check with the measured table', () => {
  const MIN = minSizes as unknown as Record<string, Record<string, Partial<Record<string, number>>>>;
  const good: ElMetrics = { displayed: true, visible: true, opacity: 1, rect: { left: 10, top: 10, right: 300, bottom: 100 }, fontRem: 10, heightRem: 4 };
  const vp = { width: 1920, height: 1080 };
  const SCREENS = ['biasa', 'azan', 'masuk-waktu', 'iqamah', 'solat', 'jumaat', 'tiada-data', 'kuliah', 'poster', 'hadis', 'ayat', 'pengumuman', 'takwim', 'program', 'zikir', 'arab-ayat', 'arab-hadis', 'arab-zikir', 'live'];

  it('the table has Arabic Art', () => {
    expect(Object.keys(MIN)).toContain('arabic');
  });

  it('every screen of every built-in theme (Arabic Art and the live screens included) passes at the measured size', () => {
    for (const [theme, screen] of Object.keys(MIN).flatMap((t) => SCREENS.map((sc) => [t, sc] as const))) {
      const table = MIN[theme]![screen];
      if (!table) continue; // a screen the shots do not reach (tabung has no fixture)
      const stage = document.createElement('div');
      const metrics = new Map<Element, ElMetrics>();
      for (const role of requiredRoles(screen as never, false)) {
        const el = document.createElement('div');
        el.setAttribute('data-role', role);
        stage.appendChild(el);
        metrics.set(el, { ...good, fontRem: Math.max(good.fontRem, minSizeOf(theme as never, screen as never, role) ?? 0) });
      }
      const r = checkScreenHealth(stage, screen as never, { logoSet: false, base: theme as never, viewport: vp, measure: (el) => metrics.get(el)! });
      expect(r, `${theme} ${screen}`).toEqual({ ok: true, failed: [] });
    }
  });
});
