import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { srcDir, themeCss } from './themeCss.ts';

/** The rules of a stylesheet as { selector list, body } pairs, comments removed, nested blocks (@media) flattened. */
function rulesOf(css: string): Array<{ sel: string; body: string }> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Array<{ sel: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const sel = m[1]!.trim().replace(/^@media[^{]*$/, '');
    if (sel !== '' && !sel.startsWith('@')) out.push({ sel: sel.replace(/\s+/g, ' '), body: m[2]!.replace(/\s+/g, ' ').trim() });
  }
  return out;
}
const selectors = (list: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
};

const before = (id: string): string => readFileSync(resolve(srcDir(), '../test/fixtures/themes-before-d4', `${id}.css`), 'utf8');
/** Rules that are in theme.css now and were not in the copy kept from before this task. The main layout's `.pcell` rules
 *  moved under `.pbar` (so the compact strip is not reached by them): that rewrite is not a new rule. */
function newRules(id: string): Array<{ sel: string; body: string }> {
  // W14 rewrote left/right as logical properties (the same left to right, mirrored for an Arabic screen): not a new rule.
  const physical = (body: string): string =>
    body
      .replace(/inset-inline-start/g, 'left')
      .replace(/inset-inline-end/g, 'right')
      .replace(/(margin|padding|border)-inline-start/g, '$1-left')
      .replace(/(margin|padding|border)-inline-end/g, '$1-right')
      .replace(/text-align: start/g, 'text-align: left')
      .replace(/text-align: end/g, 'text-align: right');
  const norm = (r: { sel: string; body: string }): string => `${r.sel.replace(/\.pbar \.pcell/g, '.pcell')}{${physical(r.body)}}`;
  const known = new Set(rulesOf(before(id)).map(norm));
  // (the live screen's own dress, plan D task 5, is checked in liveLayout.test.ts)
  return rulesOf(themeCss(id)).filter((r) => !known.has(norm(r)) && !/live/.test(`${r.sel} ${r.body}`));
}

const FIVE_DRESSED = ['colourful', 'creative', 'oldschool', 'minimal'];
/** Themes whose main screen changed in theme round 2 (DECISIONS rules 14 and 16), on [data-kind='full'] only. */
const ROUND2_FULL = ['creative', 'minimal'];

describe('content screens in the built-in themes', () => {
  for (const id of FIVE_DRESSED) {
    it(`${id}: dresses the content kind and nothing unscoped`, () => {
      const added = newRules(id);
      expect(added.length).toBeGreaterThan(5);
      for (const r of added) {
        // (rules on the main layout's bar column, `.pbar`, cannot reach a content screen: its strip is not a .pbar)
        // (theme round 2: Creative's biasa is the Cadangan mockup (rule 16) and Minimal's main clock is bold (rule 14),
        // both scoped to the main screen kind, [data-kind='full'])
        for (const sel of selectors(r.sel)) {
          if (/\.pbar(?![\w-])/.test(sel)) continue;
          const scoped = ROUND2_FULL.includes(id)
            ? /\[data-kind='content'\]|\[data-screen='[a-z-]+'\]|\[data-kind='full'\]/
            : /\[data-kind='content'\]|\[data-screen='[a-z-]+'\]/;
          expect(sel, sel).toMatch(scoped);
        }
      }
      expect(themeCss(id)).toContain(`.stage[data-template='${id}'][data-kind='content']`);
    });
  }

  it('the default theme is the contract itself: its stylesheet adds no content rules', () => {
    expect(newRules('default').length).toBe(0);
    expect(rulesOf(themeCss('default')).length).toBeLessThanOrEqual(0);
  });

  it('only Old School keeps a vertical timetable, and only on the main screen: no theme restyles biasa in the content block', () => {
    for (const id of FIVE_DRESSED) {
      for (const r of newRules(id)) {
        if (ROUND2_FULL.includes(id) && /\[data-kind='full'\]/.test(r.sel)) continue;
        expect(r.sel, id).not.toMatch(/\[data-screen='biasa'\]|\[data-kind='full'\]/);
      }
    }
    // The vertical timetable is the main layout's own (.pbar under .screen--main), so the content strip stays horizontal.
    const old = themeCss('oldschool');
    expect(old).not.toMatch(/\[data-kind='content'\][^{}]*\.pbar/);
  });

  it('the main layout rules of the compact strip cannot reach it: every .pcell rule of a theme sits under .pbar', () => {
    for (const id of FIVE_DRESSED) {
      for (const r of rulesOf(themeCss(id))) {
        for (const sel of selectors(r.sel)) {
          if (/\.pcell(?![\w-])/.test(sel) && !/\.strip/.test(sel)) expect(sel, `${id}: ${sel}`).toContain('.pbar');
        }
      }
    }
  });

  it('no rule hides the logo, the clock, the chip or the strip on a content screen', () => {
    const roles = /\.(?:logo|ident__logo|region-clock|clock--compact|next--chip|region-next|strip|region-prayers|region-brand|brand)\b|\[data-role=/;
    for (const id of FIVE_DRESSED) {
      for (const r of rulesOf(themeCss(id))) {
        if (!/\[data-kind='content'\]|\[data-screen='[a-z-]+'\]/.test(r.sel)) continue;
        if (!selectors(r.sel).some((s) => roles.test(s))) continue;
        expect(r.body, `${id}: ${r.sel}`).not.toMatch(/display:\s*none|visibility:\s*hidden|opacity:\s*0(?:[;\s]|$)/);
      }
    }
  });
});

describe('poster frame (2026.11.13): below the header, Regangkan', () => {
  const css = readFileSync(resolve(srcDir(), 'themes/contract.css'), 'utf8');
  const rules = rulesOf(css);
  const body = (sel: string): string => rules.find((r) => r.sel === sel)?.body ?? '';
  it('starts below the measured header (with a fallback), small even insets, no header scrim', () => {
    const f = body('.poster-frame');
    expect(f).toMatch(/top: calc\(var\(--poster-top, [\d.]+rem\) \+ 0\.833rem\)/);
    for (const side of ['inset-inline-start', 'inset-inline-end', 'bottom']) expect(f).toContain(`${side}: 0.833rem`);
    expect(rules.some((r) => r.sel.includes('.poster-stage::after'))).toBe(false);
  });
  it('stretch fills the frame exactly; stretch false keeps the picture whole', () => {
    expect(body('.poster-frame img')).toMatch(/width: 100%.*height: 100%.*object-fit: fill/);
    expect(body(".poster-frame[data-stretch='false'] img")).toContain('object-fit: contain');
  });
});
