import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkCss } from '../src/themes/cssCheck.ts';
import { ALLOWED_COLOUR_TOKENS, ALLOWED_RGB_TOKENS } from '../src/themes/cssAllow.ts';

// Round 3: a pack may set only its own --pack-* variables and a short list of base-theme COLOUR tokens. Every other
// theme variable (fonts, sizes, angles, plates, shade, live-screen geometry) stays out of a pack's reach, because the
// built-in CSS feeds those into properties the allow-list refuses.
const ctx = { file: 'theme.css', images: new Set(['kuliah.jpg']) };
const codes = (css: string): string[] => checkCss(css, ctx).errors.map((e) => e.code);

const KIOSK_SRC = resolve(__dirname, '../../kiosk-display/src');

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...cssFiles(p));
    else if (name.endsWith('.css')) out.push(p);
  }
  return out;
}

/** Properties whose value a pack must never steer (even through a variable). Colour-ish properties are the complement. */
const COLOURISH = /^(?:color|background|background-color|background-image|border(?:-(?:top|right|bottom|left|inline|inline-start|inline-end|block|block-start|block-end))?(?:-color)?|outline-color|box-shadow|text-shadow|fill|stroke|stop-color|caret-color|--[\w-]+)$/;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

interface Use { prop: string; token: string; file: string }

function scan(): { uses: Use[]; defs: Map<string, string[]> } {
  const uses: Use[] = [];
  const defs = new Map<string, string[]>();
  for (const file of cssFiles(KIOSK_SRC)) {
    const css = stripComments(readFileSync(file, 'utf8'));
    for (const m of css.matchAll(/([\w-]+)\s*:\s*([^;{}]*)/g)) {
      const prop = m[1]!.toLowerCase();
      const value = m[2]!;
      const tokens = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((t) => t[1]!);
      for (const token of tokens) uses.push({ prop, token, file });
      if (prop.startsWith('--')) defs.set(prop, [...(defs.get(prop) ?? []), ...tokens]);
    }
  }
  return { uses, defs };
}

/** Every variable that feeds a non-colour property, directly or through another variable's definition. */
function sensitiveTokens(): Set<string> {
  const { uses, defs } = scan();
  const sensitive = new Set<string>();
  for (const u of uses) {
    if (u.prop.startsWith('--')) continue;
    if (!COLOURISH.test(u.prop)) sensitive.add(u.token);
  }
  // box-shadow and border shorthands also carry lengths: a token used there only counts as colour when it is a colour token.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, inner] of defs) {
      if (!sensitive.has(name)) continue;
      for (const t of inner) if (!sensitive.has(t)) { sensitive.add(t); grew = true; }
    }
  }
  return sensitive;
}

describe('a pack cannot set a theme variable that feeds a refused property', () => {
  const sensitive = [...sensitiveTokens()].sort();

  it('the scan finds the variables the review named', () => {
    for (const t of ['--font', '--serif', '--font-arab', '--font-arabic', '--font-quran', '--scale', '--fit', '--ar-scale', '--slant-angle', '--slant']) {
      expect(sensitive, t).toContain(t);
    }
  });

  it.each(sensitive)('%s is refused when a pack sets it', (token) => {
    expect(codes(`.stage{${token}:1rem}`), token).toContain('css_property');
    expect(codes(`:root{${token}:red}`), token).toContain('css_property');
    expect(codes(`.region-clock{${token.toUpperCase()}:1}`), token).toContain('css_property');
  });

  it('no colour token the pack may set is one the built-in CSS feeds into a refused property', () => {
    for (const t of [...ALLOWED_COLOUR_TOKENS, ...ALLOWED_RGB_TOKENS]) expect(sensitive, t).not.toContain(t);
  });

  it('the review attacks', () => {
    expect(codes(':root{--font:Wingdings}')).toContain('css_property');
    expect(codes(':root{--slant-angle:179deg}')).toContain('css_property');
    expect(codes('.stage{--scale:.01}')).toContain('css_property');
    expect(codes('.stage{--fit:.01}')).toContain('css_property');
    expect(codes('.stage{--shade:0}')).toContain('css_property');
    expect(codes('.stage{--plate-bg:transparent;--plate-pad:0}')).toContain('css_property');
    expect(codes('.stage{--mark-plate:transparent}')).toContain('css_property');
    expect(codes('.stage{--live-frame-w:1rem}')).toContain('css_property');
    expect(codes('.stage{--something-new:1}')).toContain('css_property');
  });
});

describe('what a pack may still set', () => {
  it('its own --pack-* variables: colours, bounded lengths, numbers, gradients, pack pictures', () => {
    for (const css of [
      '.stage{--pack-gold:#f3e27a}', ':root{--pack-n:2}', '.a{--pack-w:1.5rem}', '.a{--pack-p:50%}', '.a{--pack-g:linear-gradient(red,blue)}',
      '.a{--pack-i:url(images/kuliah.jpg)}', '.a{--pack-c:rgb(1 2 3 / .5)}', '.a{--pack-t:transparent}', '.a{--pack-v:var(--accent)}', '.a{--pack-v:var(--pack-gold)}',
    ]) expect(codes(css), css).toEqual([]);
  });

  it('the base-theme colour tokens, with colour or gradient values', () => {
    for (const css of [
      '.stage{--accent:#0a0}', '.stage{--accent-2:#f3e27a}', '.stage{--text:#fff}', '.stage{--ink:rgb(1 2 3)}', '.stage{--muted:rgb(246 236 212 / .72)}', '.stage{--paper:#fff}',
      '.stage{--hair:#ddd}', '.stage{--rule:hsl(10 20% 30%)}', '.stage{--mint:#2fd1ad}', '.stage{--green:#0a0}', '.stage{--sunset:linear-gradient(135deg,#e2457a,#f2793f)}',
      '.stage{--harakat:#ffd966}', '.stage{--cell-a:#111}', '.stage{--cell-b:#222}', '.stage{--slab-a:#111}', '.stage{--slab-b:#222}',
      '.stage{--accent-rgb:127 220 154}', '.stage{--glass-rgb:6 48 43}', '.stage{--live-frame-ring:rgb(1 2 3 / .5)}', '.stage{--live-frame-fill:#012}', '.stage{--live-veil:rgb(1 2 3 / .5)}',
    ]) expect(codes(css), css).toEqual([]);
  });

  it('a colour token takes a colour only', () => {
    for (const css of [
      '.stage{--accent:1rem}', '.stage{--accent:url(images/kuliah.jpg)}', '.stage{--accent:calc(1rem + 2px)}', '.stage{--accent:var(--font)}',
      '.stage{--text:179deg}', '.stage{--accent-rgb:#fff}', '.stage{--accent-rgb:999 0 0}', '.stage{--accent-rgb:1 2}', '.stage{--glass-rgb:red}', '.stage{--accent:}',
    ]) expect(codes(css), css).not.toEqual([]);
  });

  it('a --pack-* variable refuses text, outside lengths, other functions and a variable that is not a colour token', () => {
    for (const css of [
      ".a{--pack-s:'x'}", '.a{--pack-s:\"x\"}', '.a{--pack-l:50rem}', '.a{--pack-l:-3rem}', '.a{--pack-l:calc(1rem*2)}', '.a{--pack-f:attr(x)}',
      '.a{--pack-u:url(https://x.example/a.jpg)}', '.a{--pack-v:var(--font)}', '.a{--pack-v:var(--scale)}', '.a{--pack-e:expression(1)}', '.a{--pack-x:}',
    ]) expect(codes(css), css).not.toEqual([]);
  });

  it('a name written with an escape or other case is judged as written', () => {
    expect(codes('.a{--\\66 ont:Wingdings}')).toContain('css_property');
    expect(codes('.a{--FONT:Wingdings}')).toContain('css_property');
    expect(codes('.a{--Pack-Gold:#fff}')).toEqual([]);
  });
});
