import { describe, expect, it } from 'vitest';
import { checkCss, rewriteUrls, scopePackCss } from '../src/themes/cssCheck.ts';
import { MAX_CSS_BYTES } from '../src/themes/packFormat.ts';

const ctx = { file: 'theme.css', images: new Set(['kuliah.jpg', 'semua.png']) };

/** Small seeded generator (mulberry32): the same 2000 cases on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Complete rules or at-rules, each one valid on its own and free of addresses.
const BENIGN = [
  '.stage{--accent:#0a0}', '.region-main{background:url(images/kuliah.jpg)}', '.region-next{margin-top:1rem;margin-left:1px}',
  ':root{--accent:#0a0;--pack-n:2}', '.stage[data-screen="poster"] .region-next{margin-top:1rem}',
  '[data-screen]{color:red}', '@media (min-width:100px){.a{color:red}}', '.k{padding:1px}',
  '.b{background:url(../images/semua.png) center / cover}', '.c .d > .e + .f ~ .g{margin:0 auto}', '.h1,.h2{font-weight:700}',
  '.clock{letter-spacing:.02em}', '.x:first-child{color:red}', '.y:last-child{color:blue}', '.z{box-shadow:0 0 1px red}',
  '/* a comment */', '.q{gap:8px}', '.r{color:#abc;background:linear-gradient(red,blue)}',
];
// Each one must always be refused.
const HOSTILE = [
  '@import "x.css";', '@IMPORT url(images/kuliah.jpg);', '@namespace x url(http://a/);',
  '.h1{background:url(https://x.example/a.jpg)}', '.h2{background:url(//x.example/a.jpg)}', '.h3{background:url(/assets/abc)}',
  '.h4{background:url(data:image/png;base64,AAAA)}', '.h5{background:url(images/missing.jpg)}', '.h6{background:u\\72l(https://x.example/a.jpg)}',
  '.h7{background:image-set("https://x.example/a.jpg" 1x)}', '@font-face{font-family:y;src:url(https://x.example/f.woff2)}',
  '.h8{background:url(blob:https://x/1)}', '.h9{background:url(images/../theme.json)}',
  '.i1{width:expression(alert(1))}', '.i2{behavior:url(images/kuliah.jpg)}', '.i3{-moz-binding:url(images/kuliah.jpg)}', '.i4{background:url("javascript:alert(1)")}',
  '.box-screen{display:none}', '.stage .BOX-SCREEN *{color:red}', '.\\62ox-screen{color:red}', ':is(.box-screen) p{color:red}', 'div:not(.x, .box-screen){color:red}',
  "[data-screen='setup']{display:none}", '[data-screen=pair]{color:red}', "[data-screen^='reco']{color:red}", "[data-screen*='ock']{color:red}",
  "[data-screen$='check' i]{color:red}", "[DATA-SCREEN='locked']{color:red}", '.stage:where(.a,.box-screen){color:red}',
  '.k1{animation:x 1s}', '@keyframes k{from{opacity:0}to{opacity:1}}', '.k2{filter:blur(9px)}', '.k3{backdrop-filter:blur(2px)}', '.k4{mix-blend-mode:difference}',
  '.k5{-webkit-text-fill-color:transparent}', '.k6{clip-path:inset(100%)}', '.k7{mask-image:none}', '.k8{content:"x"}', '.k9{position:fixed}', '.l1{z-index:5000}',
  '.l2{color:red!important}', '.l3{--u:"https://x.example/a.jpg"}', '.l4{background:image-set(var(--u) 1x)}', 'html{display:none}', 'body{display:none}', '#root{display:none}',
  ':root{display:none}', '.stage + .m1{color:red}', "[class*='box']{color:red}", '@font-face{font-family:z}',
  '.j1{color:red', '}}}{{{', '/* never closed', '.j2{content:"never closed}', '.j3{background:url(never-closed',
];

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

describe('checkCss fuzz', () => {
  it('never throws, stays fast, and always refuses a hostile fragment (2000 seeded cases)', () => {
    const r = rng(20261115);
    let slowest = 0;
    for (let i = 0; i < 2000; i++) {
      const parts: string[] = [];
      const n = 1 + Math.floor(r() * 8);
      for (let k = 0; k < n; k++) parts.push(pick(r, BENIGN));
      const hostile = r() < 0.5 ? 1 + Math.floor(r() * 2) : 0;
      let insertedAt = -1;
      for (let h = 0; h < hostile; h++) {
        // The unclosed fragments swallow what follows, so they go last; the rest anywhere between complete rules.
        const frag = pick(r, HOSTILE);
        const unclosed = /(\{\s*[^}]*$)|^\}\}\}|never closed/.test(frag) && !frag.endsWith('}');
        const at = unclosed ? parts.length : Math.floor(r() * (parts.length + 1));
        parts.splice(at, 0, frag);
        insertedAt = at;
      }
      const sep = pick(r, ['', '\n', ' ', '\n\n']);
      const css = parts.join(sep);
      const t0 = performance.now();
      const res = checkCss(css, ctx);
      slowest = Math.max(slowest, performance.now() - t0);
      if (hostile > 0) expect(res.errors.length, `case ${i} at ${insertedAt}: ${css}`).toBeGreaterThan(0);
      else expect(res.errors, `case ${i}: ${css}`).toEqual([]);
    }
    expect(slowest).toBeLessThan(1000);
  });

  it('accepted CSS stays accepted after scoping, and its rewritten urls are absolute and free of outside addresses', () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const parts: string[] = [];
      const n = 1 + Math.floor(r() * 8);
      for (let k = 0; k < n; k++) parts.push(pick(r, BENIGN));
      const css = parts.join('\n');
      expect(checkCss(css, ctx).errors, css).toEqual([]);
      const scoped = scopePackCss(css, { theme: 'hijau-siti', screen: 'poster' });
      expect(checkCss(scoped, ctx).errors, scoped).toEqual([]);
      const rewritten = rewriteUrls(scoped, '/themes/hijau-siti/3/');
      expect(rewritten).not.toMatch(/https?:/i);
      expect(rewritten).not.toContain('//');
      expect(rewritten.toLowerCase()).not.toContain('box-screen');
      // still readable CSS, and every address now sits under the pack folder
      const again = checkCss(rewritten, { ...ctx, images: new Set() });
      expect(again.errors.every((e) => e.code === 'css_url'), rewritten).toBe(true);
      for (const m of rewritten.matchAll(/url\("([^"]*)"\)/g)) expect(m[1]!.startsWith('/themes/hijau-siti/3/')).toBe(true);
    }
  });

  it('a 512 KB file is checked within a second', () => {
    const unit = '.region-main .card:nth-child(2n+1) > .title{color:#123456;margin:0 auto;background:url(images/kuliah.jpg)}\n';
    const css = unit.repeat(Math.floor(MAX_CSS_BYTES / unit.length));
    expect(css.length).toBeLessThanOrEqual(MAX_CSS_BYTES);
    const t0 = performance.now();
    const res = checkCss(css, ctx);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(res.errors).toEqual([]);
  });

  it('random bytes and truncated input never throw', () => {
    const r = rng(99);
    for (let i = 0; i < 300; i++) {
      const len = Math.floor(r() * 200);
      let s = '';
      for (let k = 0; k < len; k++) s += String.fromCharCode(Math.floor(r() * 0xd000));
      expect(() => checkCss(s, ctx)).not.toThrow();
      const cut = pick(r, BENIGN.concat(HOSTILE));
      expect(() => checkCss(cut.slice(0, Math.floor(r() * cut.length)), ctx)).not.toThrow();
    }
  });
});
