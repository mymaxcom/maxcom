import { describe, expect, it } from 'vitest';
import { checkCss, rewriteUrls } from '../src/themes/cssCheck.ts';

// Round 2: the pack CSS check is an ALLOW-LIST (selectors, properties, bounded values). A pack in v1 is a re-skin.
const ctx = { file: 'theme.css', images: new Set(['kuliah.jpg']) };
const codes = (css: string): string[] => checkCss(css, ctx).errors.map((e) => e.code);

describe('properties outside the allow-list are refused', () => {
  it.each([
    'transform:scale(.1)', 'transform:none', 'scale:.1', 'rotate:180deg', 'translate:9999px', 'zoom:.1', 'perspective:1px', 'transform-origin:0 0', '-webkit-transform:scaleX(-1)',
    'opacity:.99', 'opacity:1', 'visibility:visible', 'display:none', 'display:list-item', 'position:relative', 'position:absolute', 'inset:0', 'top:0', 'left:-5000px', 'right:0', 'bottom:0',
    'z-index:0', 'z-index:-1', 'isolation:isolate', 'contain:paint', 'will-change:transform', 'overflow:hidden', 'overflow-x:clip', 'clip:rect(0,0,0,0)', 'clip-path:none',
    'mask-image:none', 'filter:none', 'mix-blend-mode:normal', 'font-family:Wingdings', 'font-size:1px', 'font:12px serif', 'direction:rtl', 'unicode-bidi:bidi-override', 'writing-mode:vertical-rl',
    'text-indent:-9999px', 'text-decoration:line-through', 'text-decoration-thickness:2rem', 'text-decoration-color:red', 'text-decoration-line:line-through',
    '-webkit-text-security:disc', '-webkit-text-stroke:3rem red', '-webkit-text-fill-color:red', 'text-fill-color:red',
    'list-style:none', 'list-style-type:"99:99"', 'quotes:none', 'content:""', 'content:none', 'counter-reset:x', 'counter-increment:x',
    'transition:opacity 1s', 'transition-delay:1s', 'animation:x 1s', 'cursor:none', 'pointer-events:none', 'columns:2', 'order:1', 'float:left', 'unknown-thing:1', '-webkit-unknown-thing:1',
    'box-sizing:border-box', 'background-clip:text', '-webkit-background-clip:text', 'background-attachment:fixed', 'background-blend-mode:difference', 'border-image:url(images/kuliah.jpg) 1',
  ])('%s is refused', (decl) => {
    expect(codes(`.a{${decl}}`), decl).toContain('css_property');
  });

  it('the vendor prefix does not hide a property', () => {
    expect(codes('.a{-WEBKIT-text-security:disc}')).toContain('css_property');
    expect(codes('.a{-moz-opacity:.5}')).toContain('css_property');
    expect(codes('.a{op\\61city:.5}')).toContain('css_property');
  });
});

describe('what a re-skin needs stays allowed', () => {
  it.each([
    'color:#fff', 'color:rgb(1,2,3)', 'color:var(--ink)', 'background-color:#0a1f18', 'background-color:var(--panel)', 'background:linear-gradient(#000,#fff)', 'background-image:radial-gradient(#000,#fff)',
    'background-image:url(images/kuliah.jpg)', 'background:url(images/kuliah.jpg) center/cover no-repeat', 'background-size:cover', 'background-position:50% 50%', 'background-repeat:no-repeat',
    'border:1px solid #fff', 'border-color:var(--accent)', 'border-width:.3rem', 'border-radius:1rem', 'border-top-left-radius:50%', 'outline:.2rem solid #fff', 'outline-offset:.1rem',
    'box-shadow:0 0 1rem rgba(0,0,0,.5)', 'box-shadow:inset 0 0 0 .1rem #fff, 0 .2rem 1rem #000', 'text-shadow:0 0 .5rem #fff', 'text-shadow:.1rem .1rem 0 #000',
    'padding:1rem 2rem', 'padding-left:0', 'margin:0 auto', 'margin-top:1rem', 'gap:1rem', 'row-gap:.5rem', 'font-weight:800', 'font-weight:bold', 'font-style:italic', 'text-transform:uppercase',
    'letter-spacing:.1em', 'word-spacing:.2em', 'line-height:1.2', 'text-align:center', 'width:10rem', 'min-height:2rem', 'max-width:100%', '--accent:#0a0', '--pack-x:1',
  ])('%s is accepted', (decl) => {
    expect(codes(`.deco{${decl}}`), decl).toEqual([]);
  });

  it('size properties are refused on protected classes and data-role', () => {
    for (const sel of ['.region-clock', '.clock__hm', '.region-prayers', '.pcell', '.pcell__time', '.region-next', "[data-role='clock']", '.stage .region-clock .x', '.phase__clock', '.clock', '.hm']) {
      expect(codes(`${sel}{width:1rem}`), sel).toContain('css_property');
      expect(codes(`${sel}{max-height:1rem}`), sel).toContain('css_property');
    }
    expect(codes('.deco{width:1rem}')).toEqual([]);
  });
});

describe('bounded values', () => {
  it.each([
    'box-shadow:0 0 0 4000px #000', 'box-shadow:0 0 0 1rem #000', 'box-shadow:0 0 5rem #000', 'box-shadow:20rem 0 0 #000', 'box-shadow:0 0 var(--b) #000',
    'text-shadow:0 0 5rem #000', 'text-shadow:5rem 0 0 #000',
    'outline:4000px solid red', 'outline:1rem solid red', 'outline-width:1rem', 'outline-offset:5rem',
    'border:3rem solid red', 'border-width:1rem', 'border-top:2rem solid red', 'border:1px solid var(--x)',
    'padding:-1rem', 'padding-top:-1px', 'padding:50rem', 'margin:-9rem', 'margin-top:-1px', 'margin:50rem', 'margin-left:-4000px', 'gap:50rem',
    'letter-spacing:1em', 'letter-spacing:-.1em', 'word-spacing:2em', 'line-height:.5', 'line-height:0', 'line-height:var(--lh)', 'width:calc(100% + 4000px)', 'width:var(--w)', 'height:100vh',
  ])('%s is refused', (decl) => {
    expect(codes(`.deco{${decl}}`), decl).toContain('css_property');
  });
});

describe('selectors outside the allow-list are refused', () => {
  it.each([
    '*', 'div', 'span', 'img', '#x', '.a::marker', '.a::before', '.a::after', '.a::selection', '.a::first-line', '.a:before', '.a:has(.b)', '.a:hover', '.a:focus', ':is(.a)', ':where(.a)',
    '.host-exit', '.host-exit img', '.netcheck', '.netcheck__x', '.preview-ribbon', '.stage .host-exit', '.stage > .host-exit--x', '[data-x]', '[data-pulse]', '[title]', '.a + *', '.stage *',
  ])('%s is refused', (sel) => {
    expect(codes(`${sel}{color:red}`), sel).not.toEqual([]);
  });

  it.each([
    '.a', '.stage', '.stage .region-clock', ".stage[data-screen='poster'] .x", '.a:first-child', '.a:last-child', '.a:nth-child(2n+1)', '.a:not(.b)', ".a:not([data-kind='live'])", "[data-role='clock']",
    "[data-phase='azan'] .x", "[data-live='blur'] .y", "[data-live-layout='framed'] .y", "[data-harakat='on'] .z", "[data-dim='true'] .z", "[data-pic] .z", "[data-theme='hijau-siti'] .z", '.a > .b', '.a .b', '.a, .b',
  ])('%s is accepted', (sel) => {
    expect(codes(`${sel}{color:red}`), sel).toEqual([]);
  });

  it('the box own screens stay refused with the box code', () => {
    expect(codes('.host-exit{color:red}')).toContain('css_box_screen');
    expect(codes('.netcheck{color:red}')).toContain('css_box_screen');
    expect(codes('.preview-ribbon{color:red}')).toContain('css_box_screen');
  });

  it(':root keeps its rewriting rule (only custom properties)', () => {
    expect(codes(':root{--accent:#0a0}')).toEqual([]);
    expect(codes(':root{color:red}')).not.toEqual([]);
  });
});

describe('S4: the url function written with an escape', () => {
  it('a backslash in a function name is refused', () => {
    expect(codes('.a{background:\\75rl("https://x.example/a.jpg")}')).not.toEqual([]);
    expect(codes('.a{background:\\75rl(images/kuliah.jpg)}')).not.toEqual([]);
    expect(codes('.a{background:u\\72l("images/kuliah.jpg")}')).not.toEqual([]);
    expect(codes('.a{background:lin\\65ar-gradient(#000,#fff)}')).not.toEqual([]);
  });
  it('a url function with a quoted pack picture is checked and rewritten', () => {
    expect(codes('.a{background:url("images/kuliah.jpg")}')).toEqual([]);
    expect(codes('.a{background:url("https://x.example/a.jpg")}')).toContain('css_url');
    expect(rewriteUrls('.a{background:url("images/kuliah.jpg")}', '/themes/x/0123456789abcdef-2/')).toContain('/themes/x/0123456789abcdef-2/images/kuliah.jpg');
  });
});
