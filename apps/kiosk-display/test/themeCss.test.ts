import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { srcDir, themeCss } from './themeCss.ts';

const content = readFileSync(resolve(srcDir(), 'content/content.css'), 'utf8');
const styles = readFileSync(resolve(srcDir(), 'styles.css'), 'utf8');

/** The declaration block of the rule whose selector is exactly `sel`. */
function rule(css: string, sel: string): string {
  const i = css.indexOf(`\n${sel} {`);
  if (i < 0) throw new Error(`no rule ${sel}`);
  return css.slice(i, css.indexOf('}', i));
}

it('every fitted card text also follows --scale', () => {
  const fits = content.match(/font-size:[^;]*var\(--fit[^;]*;/g) ?? [];
  expect(fits.length).toBe(9); // the tabung screen (tabung-r1) fits through its own --f below
  for (const d of fits) expect(d, d).toContain('var(--scale, 1)');
  // The tabung screen: one factor for the fit and the text size, used by every text that grows with the page.
  expect(content).toContain('--f: calc(var(--fit, 1) * var(--scale, 1));');
  const tabungFits = content.match(/font-size:[^;]*var\(--f[,)][^;]*;/g) ?? [];
  expect(tabungFits.length).toBeGreaterThanOrEqual(12);
});
it('the phase title and sub line follow --scale; the big countdown and the clock do not', () => {
  expect(rule(styles, '.phase__title')).toMatch(/font-size:\s*calc\(3\.2rem \* var\(--scale, 1\)\)/);
  expect(rule(styles, '.phase__sub')).toMatch(/font-size:\s*calc\(2\.4rem \* var\(--scale, 1\)\)/);
  expect(rule(styles, '.phase__big')).not.toContain('--scale');
  for (const id of ['colourful', 'creative', 'oldschool', 'minimal']) {
    expect(themeCss(id), id).not.toMatch(/\.phase__big[^{]*\{[^}]*--scale/);
    for (const m of themeCss(id).matchAll(/\.phase__(?:title|sub)[^{]*\{([^}]*)\}/g)) {
      const size = /font-size:\s*([^;}]+)/.exec(m[1] ?? '');
      if (size) expect(size[1], `${id}: ${m[0]}`).toContain('var(--scale, 1)');
    }
  }
});
it('alignment rules exist for left, center and right, one attribute higher than the theme rules', () => {
  for (const a of ['left', 'center', 'right']) expect(styles).toContain(`.stage[data-align='${a}'][data-phase] .region-main { text-align: ${a}; }`);
});
it('the stage owns the text font so a menu font reaches every region', () => {
  expect(rule(styles, '.stage')).toMatch(/font-family:\s*var\(--font\)/);
});
it('the default look hides the background list picture behind a menu picture', () => {
  expect(styles).toContain(".stage[data-template='default'][data-bg='image'] .bg__img { display: none; }");
});
it('each non-default theme shows a menu picture, with a shade above it', () => {
  for (const id of ['colourful', 'creative', 'oldschool', 'minimal']) {
    const css = themeCss(id);
    expect(css, id).toContain(`.stage[data-template='${id}'][data-bg='image'] .bg__menu`);
    expect(css, id).toContain(`.stage[data-template='${id}'][data-bg='image'] .bg__shade { display: block; background: rgb(0 0 0 / var(--shade, 0)); }`);
  }
  expect(styles).toMatch(/\.bg__menu\s*\{[^}]*var\(--bg-image\) var\(--bg-pos, center\) \/ var\(--bg-size, cover\) no-repeat/);
});
it('every theme plates free text by group, with one colour per tone and the shared shape', () => {
  expect(styles).toContain('.stage[data-pic] { --plate-pad: 0.55rem; --plate-radius: 1rem; }');
  expect(styles).toMatch(/\.phase__plate \{ display: contents; \}/);
  for (const id of ['default', 'colourful', 'creative', 'oldschool', 'minimal']) {
    const css = id === 'default' ? styles : themeCss(id);
    expect(css, id).toContain(`.stage[data-template='${id}'][data-pic='dark'] { --plate-bg:`);
    expect(css, id).toContain(`.stage[data-template='${id}'][data-pic='light'] { --plate-bg:`);
    // One plate rule, built from the variables: no per-word spread of its own.
    expect(css.match(/box-shadow: 0 0 0 var\(--plate-pad\) var\(--plate-bg\);/g)?.length, id).toBe(1);
  }
});
it('the phase text group is one plate wrapper around the centre content', () => {
  const phase = readFileSync(resolve(srcDir(), 'screens/Phase.tsx'), 'utf8');
  expect(phase).toContain('<div class="phase__plate">{centre}</div>');
});
