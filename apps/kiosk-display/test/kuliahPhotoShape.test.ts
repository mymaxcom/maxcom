import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// penceramahPhoto.shape (round | square) must win in every built-in theme: a theme may colour or frame the kuliah
// photo, but a rule that gives it its outline (border-radius, clip-path) has to name the shape it is for.
const themesDir = join(fileURLToPath(import.meta.url), '..', '..', 'src', 'themes');
const THEMES = ['default', 'minimal', 'colourful', 'creative', 'oldschool', 'arabic'];

function rules(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ selector: m[1]!.trim(), body: m[2]! });
  return out;
}

describe('kuliah photo shape in the built-in themes', () => {
  for (const theme of THEMES) {
    it(`${theme}: outline rules on .kul-photo are scoped to .is-round or .is-square`, () => {
      let css: string;
      try {
        css = readFileSync(join(themesDir, theme, 'theme.css'), 'utf8');
      } catch {
        return; // a theme without its own stylesheet uses the contract
      }
      const bad = rules(css)
        .filter((r) => /\.kul-photo(?![\w-])/.test(r.selector) && /(border-radius|clip-path)\s*:/.test(r.body))
        .flatMap((r) => r.selector.split(',').map((s) => s.trim()))
        .filter((s) => /\.kul-photo(?![\w-])/.test(s) && !/\.kul-photo\.is-(round|square)/.test(s));
      expect(bad).toEqual([]);
    });
  }
});
