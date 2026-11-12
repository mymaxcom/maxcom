import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom lays nothing out, so the layout contract is checked on the stylesheet itself: the main screen is a grid
// whose content band is derived from the header block (never a fixed bottom + height pair that can collide
// with a taller header), the prayer bar is thin and low, the logo is sized by height with its own aspect.
// The measured proof (card top vs date bottom at every size) is test/layout-measure.mjs (Playwright).
function src(file: string): string {
  const hit = [file, `apps/kiosk-display/${file}`].map((p) => resolve(process.cwd(), p)).find(existsSync);
  if (!hit) throw new Error(`${file} not found from ${process.cwd()}`);
  return readFileSync(hit, 'utf8');
}
const styles = src('src/styles.css');
const content = src('src/content/content.css');

/** The body of the first top-level rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const re = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`);
  const m = css.match(re);
  if (!m) throw new Error(`rule not found: ${selector}`);
  return m[2]!;
}
function rem(body: string, prop: string): number {
  const m = body.match(new RegExp(`(^|[\\s;])${prop}:\\s*([\\d.]+)rem`));
  if (!m) throw new Error(`${prop} (rem) not found in: ${body.trim()}`);
  return Number(m[2]);
}

describe('kiosk layout contract', () => {
  it('main screen is a grid: header, flexible content band, ticker, bar (top to bottom)', () => {
    const main = rule(styles, '.screen--main');
    expect(main).toMatch(/display:\s*grid/);
    const areas = main.match(/grid-template-areas:([^;]+);/)?.[1] ?? '';
    const rows = [...areas.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!.trim().split(/\s+/));
    expect(rows).toEqual([['head', 'next'], ['band', 'band'], ['ticker', 'ticker'], ['bar', 'bar']]);
    // Only the band row flexes; the header row is as tall as its content (bigger logo, seconds, long name).
    expect(main).toMatch(/grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto\s+auto/);
    // The band keeps a gap from the date line in every case.
    expect(rem(main, 'row-gap')).toBeGreaterThanOrEqual(0.6);
    expect(rule(styles, '.ident')).toMatch(/grid-area:\s*head/);
    expect(rule(styles, '.next')).toMatch(/grid-area:\s*next/);
    expect(rule(styles, '.content')).toMatch(/grid-area:\s*band/);
    expect(rule(content, '.zikir')).toMatch(/grid-area:\s*band/);
    expect(rule(content, '.ticker')).toMatch(/grid-area:\s*ticker/);
    expect(rule(styles, '.screen--main .pbar')).toMatch(/grid-area:\s*bar/);
  });

  it('content band, zikir and ticker are in flow: no bottom/top offsets, no fixed band height', () => {
    for (const [css, sel] of [[styles, '.content'], [content, '.zikir'], [content, '.ticker']] as const) {
      const body = rule(css, sel);
      expect(body, sel).not.toMatch(/(^|[\s;])(top|bottom):/);
      expect(body, sel).not.toMatch(/position:\s*absolute/);
    }
    expect(rule(content, ".content[data-layer='content']")).not.toMatch(/(^|[\s;])height:/);
    // The old lift-above-the-ticker overrides are gone: the grid places the ticker.
    expect(styles + content).not.toMatch(/\.has-ticker \.(content|zikir)/);
    // The main screen keeps the overscan margin at the bottom (2-4 % of the height, i.e. about 1.2-2.2rem).
    const pad = rule(styles, '.screen--main').match(/padding:\s*([\d.]+)rem\s+var\(--gutter\)\s+([\d.]+)rem/);
    expect(pad).not.toBeNull();
    expect(Number(pad![2])).toBeGreaterThanOrEqual(1.2);
    expect(Number(pad![2])).toBeLessThanOrEqual(2.2);
  });

  it('prayer bar is about 70 % of the old 7.6rem, digits 15-20 % smaller, label smaller, low on the screen', () => {
    const h = rem(rule(styles, '.pbar'), 'height');
    expect(h).toBeGreaterThanOrEqual(5.1);
    expect(h).toBeLessThanOrEqual(5.5);
    const time = rem(rule(styles, '.pcell__time'), 'font-size');
    expect(time).toBeGreaterThanOrEqual(3.1 * 0.8);
    expect(time).toBeLessThanOrEqual(3.1 * 0.85);
    expect(rem(rule(styles, '.pcell.is-minor .pcell__time'), 'font-size')).toBeLessThan(time);
    expect(rem(rule(styles, '.pcell__label'), 'font-size')).toBeLessThan(1);
    // Label, time and countdown pill stack in flow (a column), each line box sized by its own font, so the pill
    // can never be drawn over the digits whatever the face's metrics (the T95 drew it over them with fixed rows).
    const cell = rule(styles, '.pcell');
    expect(cell).toMatch(/display:\s*flex/);
    expect(cell).toMatch(/flex-direction:\s*column/);
    expect(cell).not.toMatch(/grid-template-rows/);
    const label = rule(styles, '.pcell__label');
    const timeRule = rule(styles, '.pcell__time');
    const pill = rule(styles, '.pcell__cd');
    expect(label).toMatch(/line-height:\s*1;/);
    expect(timeRule).toMatch(/line-height:\s*1;/);
    expect(rem(pill, 'margin-top')).toBeGreaterThan(0);
    // Everything plus the gaps fits inside the bar: top padding, label, gap, time, gap, pill (font + padding).
    const padTop = Number(cell.match(/padding:\s*([\d.]+)rem/)![1]);
    const pillPad = pill.match(/padding:\s*([\d.]+)rem\s+[\d.]+rem\s+([\d.]+)rem/)!;
    const pillH = rem(pill, 'font-size') + Number(pillPad[1]) + Number(pillPad[2]);
    const total = padTop + rem(label, 'font-size') + rem(timeRule, 'margin-top') + time + rem(pill, 'margin-top') + pillH;
    expect(total).toBeLessThanOrEqual(h - 0.2);
    // Phase screens place the same bar at the same low position.
    const phaseBar = rule(styles, '.screen--phase .pbar');
    expect(rem(phaseBar, 'bottom')).toBeLessThanOrEqual(2.2);
    expect(rem(phaseBar, 'bottom')).toBeGreaterThanOrEqual(1.2);
  });

  it('logo is sized by height with its natural aspect, at most 30 % of the width and 2x its bitmap', () => {
    expect(rule(styles, '.logo')).toMatch(/object-fit:\s*contain/);
    for (const sel of ['.ident__logo', '.poster-strip__logo']) {
      const body = rule(styles, sel);
      // height: min(<rem>, var(--logo-cap, ...)) : the rem is the design height, --logo-cap the 2x bitmap cap.
      expect(body, sel).toMatch(/height:\s*min\(\s*[\d.]+rem\s*,\s*var\(--logo-cap/);
      expect(body, sel).toMatch(/width:\s*auto/);
      expect(body, sel).toMatch(/max-width:\s*[\d.]+rem/);
      expect(Number(body.match(/max-width:\s*([\d.]+)rem/)![1])).toBeLessThanOrEqual(30);
    }
    // Header logo: about 2.5-3x the surau-name line (1.25rem type, ~1.56rem line).
    const headerH = Number(rule(styles, '.ident__logo').match(/height:\s*min\(\s*([\d.]+)rem/)![1]);
    expect(headerH).toBeGreaterThanOrEqual(1.56 * 2.5);
    expect(headerH).toBeLessThanOrEqual(1.56 * 3);
    // A wide wordmark gets its own slot: the name never shrinks beside it, it moves under the logo instead.
    expect(rule(styles, '.ident__head.has-logo')).toMatch(/flex-wrap:\s*wrap/);
  });
});
