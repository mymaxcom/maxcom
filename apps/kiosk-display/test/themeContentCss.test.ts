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
  const norm = (r: { sel: string; body: string }): string => `${r.sel.replace(/\.pbar \.pcell/g, '.pcell')}{${r.body}}`;
  const known = new Set(rulesOf(before(id)).map(norm));
  // (the live screen's own dress, plan D task 5, is checked in liveLayout.test.ts)
  return rulesOf(themeCss(id)).filter((r) => !known.has(norm(r)) && !/live/.test(`${r.sel} ${r.body}`));
}

const FIVE_DRESSED = ['colourful', 'creative', 'oldschool', 'minimal'];

describe('content screens in the built-in themes', () => {
  for (const id of FIVE_DRESSED) {
    it(`${id}: dresses the content kind and nothing unscoped`, () => {
      const added = newRules(id);
      expect(added.length).toBeGreaterThan(5);
      for (const r of added) {
        for (const sel of selectors(r.sel)) expect(sel, sel).toMatch(/\[data-kind='content'\]|\[data-screen='[a-z-]+'\]/);
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
      for (const r of newRules(id)) expect(r.sel, id).not.toMatch(/\[data-screen='biasa'\]|\[data-kind='full'\]/);
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
