import { describe, expect, it } from 'vitest';
import { checkCss, scopePackCss } from '../src/themes/cssCheck.ts';

// Negative tests for the theme pack security fixes: everything that can hide or move the clock, the prayer times, the
// countdowns, the next-prayer chip or the logo; strings through custom properties; reach beyond the stage.
const ctx = { file: 'theme.css', images: new Set(['kuliah.jpg']) };
const codes = (css: string): string[] => checkCss(css, ctx).errors.map((e) => e.code);

describe('item 1: what can hide a protected element is refused in pack CSS', () => {
  it.each([
    ['.region-clock{animation:fade 1s infinite}'], ['.region-clock{animation-name:x}'], ['.region-clock{-webkit-animation:x 1s}'], ['.region-clock{-webkit-animation-duration:1s}'],
    ['.region-clock{ANIMATION-DELAY:1s}'], ['.region-clock{anim\\61tion:x 1s}'], ['@keyframes k{from{opacity:0}to{opacity:1}}'], ['@-webkit-keyframes k{from{opacity:0}}'], ['@KEYFRAMES k{from{opacity:0}}'],
    ['.region-clock{filter:opacity(0)}'], ['.region-clock{filter:blur(40px)}'], ['.region-clock{-webkit-filter:blur(1px)}'], ['.a{backdrop-filter:blur(2px)}'], ['.a{-webkit-backdrop-filter:blur(2px)}'],
    ['.region-clock{mix-blend-mode:difference}'], ['.region-clock{-webkit-text-fill-color:transparent}'], ['.region-clock{-webkit-text-fill-color:red}'],
    ['.region-clock{clip-path:inset(100%)}'], ['.region-clock{-webkit-clip-path:circle(0)}'], ['.region-clock{clip:rect(0,0,0,0)}'],
    ['.region-clock{mask:linear-gradient(#000,transparent)}'], ['.region-clock{mask-image:none}'], ['.region-clock{-webkit-mask-image:linear-gradient(#000,transparent)}'], ['.region-clock{-webkit-mask-size:0}'],
    ['.region-clock{content-visibility:hidden}'],
    ['.region-clock::after{content:"x"}'], ['.region-clock::before{content:"  "}'], ['.region-clock::before{content:attr(data-x)}'], ['.a::after{content:url(images/kuliah.jpg)}'],
    ['.a::after{content:counter(x)}'], ['.a::after{content:open-quote}'], ['.a::after{content:var(--x)}'], ['.a::after{content:"" "x"}'], ['.a::after{CONTENT:"x"}'],
    ['.region-clock{position:fixed}'], ['.region-clock{POSITION:FIXED}'], ['.region-clock{position:var(--p)}'], ['.region-clock{position:\\66ixed}'],
    ['.deco{z-index:31}'], ['.deco{z-index:999999}'], ['.deco{z-index:var(--z)}'], ['.deco{z-index:calc(1 + 1)}'], ['.deco{z-index:1e3}'], ['.deco{z-index:31 !important}'],
    ['.region-clock{opacity:0 !important}'], ['.region-clock{color:red!important}'], ['.region-clock{color:red ! IMPORTANT}'],
    ['.a{background:element(#x)}'], ['.a{background:-moz-element(#x)}'], ['.a{background:paint(x)}'],
    ['@font-face{font-family:x;src:url(images/kuliah.jpg)}'], ['@page{margin:0}'], ['@property --x{syntax:"*";inherits:false}'], ['@counter-style x{system:cyclic;symbols:"a"}'],
    ['@media (min-width:1px){.a{animation:x 1s}}'], ['@supports (display:grid){.a{filter:blur(1px)}}'], ['@media screen{@keyframes k{from{opacity:0}}}'],
  ])('%s is refused', (css) => {
    expect(codes(css).length, css).toBeGreaterThan(0);
  });

  it('the refusal names the property in both languages and the line', () => {
    const e = checkCss('.a{color:red}\n.b{animation:x 1s}', ctx).errors[0]!;
    expect(e.code).toBe('css_property');
    expect(e.line).toBe(2);
    expect(e.messageMs).toContain('animation');
    expect(e.messageEn).toContain('animation');
  });

  it('what is harmless stays allowed (round 2: a re-skin only)', () => {
    for (const css of [
      '.a{background:linear-gradient(red,blue)}', '.a{box-shadow:0 0 1px red}', '.a{text-shadow:0 0 1px red}', '.a{--pack-x:1} :root{--pack-y:red}', '@media (min-width:1px){.a{color:red}}',
      '.a{border-radius:.5rem;padding:.5rem}',
    ]) {
      expect(codes(css), css).toEqual([]);
    }
  });
});

describe('item 2: strings through custom properties', () => {
  it.each([
    ['.a{--u:"https://x.example/a.jpg";background:image-set(var(--u) 1x)}'],
    ['.a{--u:"https://x.example/a.jpg"}'], ["a{--u:'images/kuliah.jpg'}"], [':root{--u:"x"}'], ['.a{--u:  "x" }'], ['.a{--U:"x"}'], ['.a{--u:foo "x" bar}'],
    ['.a{--u:url("images/kuliah.jpg")}.b{background:image-set(var(--u) 1x)}'],
    ['.a{background:image-set(var(--u) 1x)}'], ['.a{background:-webkit-image-set(var(--u) 1x)}'], ['.a{background:cross-fade(var(--u),url(images/kuliah.jpg),50%)}'],
    ['.a{background:image(var(--u))}'], ['.a{background:src(var(--u))}'], ['.a{background:image-set(url(images/kuliah.jpg) calc(var(--r)*1x))}'],
    ['.a{--u:"javascript:alert(1)"}'],
  ])('%s is refused', (css) => {
    expect(codes(css).length, css).toBeGreaterThan(0);
  });

  it('numbers, colours and a url() of the pack in a custom property stay allowed', () => {
    for (const css of ['.a{--pack-n:1.5;--pack-c:#0a0;--pack-w:2rem;--pack-i:url(images/kuliah.jpg)}', '.a{background:var(--pack-c)}', '.a{background:url(images/kuliah.jpg) var(--pos)}']) {
      expect(codes(css), css).toEqual([]);
    }
  });
});

describe('item 3: reach beyond the stage', () => {
  it.each([
    ['html{display:none}'], ['body{display:none}'], ['HTML .a{color:red}'], ['html body .a{color:red}'], ['*|html{color:red}'], ['.a, body{color:red}'], [':is(html) .a{color:red}'], ['h\\74 ml{color:red}'],
    ['#root{display:none}'], ['#ROOT .a{color:red}'], ['.a #root{color:red}'], ['#\\72oot{color:red}'],
    [':root{color:red}'], [':root{--a:1;color:red}'], [':root .a{color:red}'], [':root.a{--x:1}'], ['.a:root{--x:1}'], [':root, .b{--x:1}'], ['.a{color:red} :root{width:1px}'], [':root{background:red}'],
    ['.stage + .x{color:red}'], ['.stage ~ div{color:red}'], ['.stage+.x{color:red}'], ['.stage[data-screen] + .x{color:red}'],
    ['@media (min-width:1px){html{display:none}}'], ['@media (min-width:1px){:root{color:red}}'],
    ["[class]{display:none}"], ["[class*='a']{color:red}"], ["[class^='a']{color:red}"], ["[class$='a']{color:red}"], ["[class='a']{color:red}"], ["[class|='a']{color:red}"], ["[class~='a b']{color:red}"], ["[class~='']{color:red}"],
    ["[class~='Box-Screen']{color:red}"], ["[class~='screen--setup']{color:red}"], ["[class~=1a]{color:red}"],
  ])('%s is refused', (css) => {
    expect(codes(css).length, css).toBeGreaterThan(0);
  });

  it('allowed: a class token of a theme, descendants of the stage, variables on :root', () => {
    for (const css of ["[class~='region-main']{color:red}", '[class~=arab]{color:red}', '.stage .a + .b{color:red}', '.stage > .a ~ .b{color:red}', ':root{--accent:#0a0;--pack-x:1}', '.stage[data-screen=azan] .a{color:red}']) {
      expect(codes(css), css).toEqual([]);
    }
  });

  it('scoping puts every rule, whatever it is, under this theme\'s stage', () => {
    const css = ".a,.b>.c{color:red} .stage .d{color:red} :root{--pack-x:1} @media (min-width:1px){.e{color:red}} .stage[data-screen='azan']{color:red} * {margin:0}";
    for (const screen of [undefined, 'kuliah' as const]) {
      const out = scopePackCss(css, { theme: 'tema-satu', ...(screen === undefined ? {} : { screen }) });
      // every selector in the output begins with the scoped stage
      for (const m of out.matchAll(/(?:^|[{}])\s*([^{}@]+)\{/g)) {
        for (const sel of m[1]!.split(',')) expect(sel.trim().startsWith(".stage[data-theme='tema-satu']"), sel).toBe(true);
      }
    }
  });
});
