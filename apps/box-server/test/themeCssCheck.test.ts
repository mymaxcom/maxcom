import { describe, expect, it } from 'vitest';
import { checkCss, cssUnescape, rewriteUrls, scopePackCss } from '../src/themes/cssCheck.ts';

const ctx = { file: 'theme.css', images: new Set(['kuliah.jpg']) };
const codes = (css: string): string[] => checkCss(css, ctx).errors.map((e) => e.code);

describe('checkCss', () => {
  it('clean CSS has no errors', () => {
    expect(codes(`.stage{--accent:#0a0} .region-main{background:url(images/kuliah.jpg)} .stage[data-screen='poster'] .region-next{margin-top:1rem} [data-screen]{color:red} @media (min-width:100px){.a{color:red}} .b{background:url(../images/kuliah.jpg)} .c{background:url(./images/kuliah.jpg)} :root{--pack-x:1} .d{padding:1px;box-shadow:0 0 1px red}`)).toEqual([]);
  });

  it.each([
    ['@import "x.css";', 'css_import'], ['@import url(images/kuliah.jpg);', 'css_import'], ['@IMPORT "a";', 'css_import'], ['@\\69mport "a";', 'css_import'],
    ['@namespace svg url(http://www.w3.org/2000/svg);', 'css_import'],
    ['a{background:url(https://x.example/a.jpg)}', 'css_url'], ['a{background:url(//x.example/a.jpg)}', 'css_url'], ['a{background:url(/assets/abc)}', 'css_url'],
    ['a{background:url(data:image/png;base64,AAAA)}', 'css_url'], ['a{background:url(blob:https://x/1)}', 'css_url'], ['a{background:url(images/missing.jpg)}', 'css_url'], ['a{background:url(images/../theme.json)}', 'css_url'],
    ['a{background:url(images/%2e%2e/theme.json)}', 'css_url'], ['a{background:url(images/kuliah.jpg?x=1)}', 'css_url'], ['a{background:url(IMAGES/kuliah.jpg)}', 'css_url'],
    ['a{background:url(fonts/kuliah.jpg)}', 'css_url'], ['a{background:url(images/naskh-siti.woff2)}', 'css_url'],
    ['a{background:u\\72l(https://x.example/a.jpg)}', 'css_url'], ['a{background:U\\0072L(//x.example/a.jpg)}', 'css_url'],
    ['a{background:image-set("https://x.example/a.jpg" 1x)}', 'css_url'], ['a{background:-webkit-image-set("//x.example/a.jpg" 1x)}', 'css_url'],
    ['a{background:image-set("images/missing.jpg" 1x)}', 'css_url'], ['a{background:image-set(url(https://x/a.jpg) 1x)}', 'css_url'],
    ['a{background:src("https://x.example/a.jpg")}', 'css_url'], ['a{background:image("https://x.example/a.jpg")}', 'css_url'],
    ['a{background:url(images\\\\..\\\\x)}', 'css_url'], ['a{--x:url(https://x.example/a.jpg)}', 'css_url'],
    ['@font-face{font-family:x;src:url(https://x.example/f.woff2)}', 'css_url'], ['@font-face{font-family:x;src:url(//x.example/f.woff2)}', 'css_url'],
    ['@font-face{font-family:x;src:url(images/kuliah.jpg)}', 'css_font'], ['@FONT-FACE{font-family:x}', 'css_font'], ['@\\66ont-face{font-family:x}', 'css_font'],
    ['a{background:url(fonts/naskh-siti.woff2)}', 'css_url'],
    ['@media (min-width:1px){a{background:url(https://x/a.jpg)}}', 'css_url'], ['@supports (display:grid){a{background:url(https://x/a.jpg)}}', 'css_url'],
    ['a{width:expression(alert(1))}', 'css_script'], ['a{width:EXPRESSION(alert(1))}', 'css_script'], ['a{behavior:url(images/kuliah.jpg)}', 'css_script'], ['a{-moz-binding:url(images/kuliah.jpg)}', 'css_script'],
    ['a{b\\65havior:url(images/kuliah.jpg)}', 'css_script'],
    ['a{background:url("javascript:alert(1)")}', 'css_script'], ['a{background:url(JaVaScRiPt:alert(1))}', 'css_script'], ['a{background:url("vbscript:msgbox(1)")}', 'css_script'],
    ['a{background:url("java\\73 cript:alert(1)")}', 'css_script'], ['a{content:"javascript:alert(1)"}', 'css_script'],
    ['.box-screen{display:none}', 'css_box_screen'], ['.stage .BOX-SCREEN *{color:red}', 'css_box_screen'], ['.\\62ox-screen{color:red}', 'css_box_screen'], ['.\\62 ox-screen{color:red}', 'css_box_screen'],
    ['.box\\2d screen{color:red}', 'css_box_screen'], ['.screen--setup{display:none}', 'css_box_screen'], ['.screen--netcheck .x{display:none}', 'css_box_screen'],
    [':is(.box-screen) p{color:red}', 'css_box_screen'], ['div:not(.x, .box-screen){color:red}', 'css_box_screen'], [':where(.a,.box-screen){color:red}', 'css_box_screen'], [':matches(.box-screen){color:red}', 'css_box_screen'],
    ['.stage:not(.a) .box-screen{color:red}', 'css_box_screen'],
    ["[data-screen='setup']{display:none}", 'css_box_screen'], ['[data-screen=pair]{color:red}', 'css_box_screen'], ["[data-screen^='reco']{color:red}", 'css_box_screen'],
    ["[data-screen*='ock']{color:red}", 'css_box_screen'], ["[data-screen$='check' i]{color:red}", 'css_box_screen'], ["[DATA-SCREEN='locked']{color:red}", 'css_box_screen'],
    ["[data-screen~='setup']{color:red}", 'css_box_screen'], ["[data-screen|='setup']{color:red}", 'css_box_screen'], ['[ data-screen = "setup" ]{color:red}', 'css_box_screen'],
    ["[*|data-screen='setup']{color:red}", 'css_box_screen'], ["[data\\2d screen='setup']{color:red}", 'css_box_screen'], ["[data-screen='\\73 etup']{color:red}", 'css_box_screen'],
    ['.a:not([data-screen=poster]){color:red}', 'css_box_screen'], ["[class~='box-screen']{color:red}", 'css_box_screen'], ["[class*='box-sc']{color:red}", 'css_box_screen'], ["[class^='box']{color:red}", 'css_box_screen'],
    ["[class*='region-']{color:red}", 'css_box_screen'], ["[class$='n']{color:red}", 'css_box_screen'], ['[class]{color:red}', 'css_box_screen'], ["[class='x']{color:red}", 'css_box_screen'],
    ["[class|='box']{color:red}", 'css_box_screen'], ["[class~='']{color:red}", 'css_box_screen'], ["[class~='a b']{color:red}", 'css_box_screen'], ["[CLASS^='b' i]{color:red}", 'css_box_screen'],
    ['.a{ & .box-screen{color:red} }', 'css_box_screen'],
    ['a{color:red', 'css_parse'], ['}}}{{{', 'css_parse'], ['a{color:red}}', 'css_parse'], ['/* never closed', 'css_parse'], ['a{content:"never closed}', 'css_parse'],
    ['a{background:url(never-closed', 'css_parse'], ['@media (min-width:1px){a{color:red}', 'css_parse'], ['a{b:(}', 'css_parse'], ['a{b:url(a b)}', 'css_parse'],
  ])('%s is refused as %s', (css, code) => {
    expect(codes(css)).toContain(code);
  });

  it('allowed look-alikes stay allowed', () => {
    for (const css of ["[data-screen^='po']{color:red}", "[data-screen='poster']{color:red}", "[class~='region-main']{color:red}", "[data-screen*='arab']{color:red}", '.box{color:red}', '.screen{color:red}', '.stage[data-screen=azan] .x{color:red}']) {
      expect(codes(css), css).toEqual([]);
    }
  });

  it('reports file and line', () => {
    const e = checkCss('.a{color:red}\n\n\n.b{background:url(http://x/a.jpg)}', ctx).errors[0]!;
    expect(e.file).toBe('theme.css');
    expect(e.line).toBe(4);
    expect(e.messageMs).toContain('theme.css baris 4');
    expect(e.messageEn).toContain('theme.css line 4');
    expect(e.messageMs.startsWith('Alamat luar tidak dibenarkan.')).toBe(true);
  });

  it('uses the specified sentences', () => {
    const m = (css: string): string => checkCss(css, ctx).errors[0]!.messageMs;
    expect(m('@import "a";')).toBe('theme.css baris 1: @import tidak dibenarkan.');
    expect(checkCss('.a{--pack-x:expression(1)}', ctx).errors.find((e) => e.code === 'css_script')!.messageMs).toBe('theme.css baris 1: skrip tidak dibenarkan dalam tema.');
    expect(m('.box-screen{}')).toBe('theme.css baris 1: skrin tetapan kotak MAXCOM tidak boleh digayakan.');
    expect(m('a{')).toBe('theme.css baris 1: CSS tidak dapat dibaca.');
  });

  it('newer CSS warns and never refuses', () => {
    const r = checkCss('@container (min-width:1px){.a{color:red}} .d{color:color-mix(in srgb,red,blue)} @layer x{.a{color:red}}', ctx);
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(['css_newer', 'css_newer', 'css_newer']);
    expect(r.warnings[0]!.messageMs).toBe('Kotak T95 (Chrome 91). theme.css baris 1 guna @container. Gaya ini tidak akan kelihatan pada kotak ini. Waktu solat dan jam tidak terjejas.');
    const more = checkCss('.a{color:red}'+String.fromCharCode(10)+'@layer x{.a{color:red}}'+String.fromCharCode(10)+'.p{ &:first-child{color:red} }', ctx);
    expect(more.errors).toEqual([]);
    expect(more.warnings.map((w) => w.messageEn.match(/uses (.*)\. This/)![1])).toEqual(['@layer', 'CSS nesting']);
  });

  it('one warning per construct and line', () => {
    const r = checkCss('@layer a{.a{color:red}} @layer b{.a{color:red}}'+String.fromCharCode(10)+'@layer c{.b{color:red}}', ctx);
    expect(r.warnings).toHaveLength(2);
  });

  it('never throws on pathological input', () => {
    expect(() => checkCss('a{b:' + '('.repeat(100000), ctx)).not.toThrow();
    expect(checkCss('a{b:' + '('.repeat(100000), ctx).errors.length).toBeGreaterThan(0);
    expect(() => checkCss('\u0000\uFFFF{}', ctx)).not.toThrow();
    expect(() => checkCss('', ctx)).not.toThrow();
    expect(checkCss('', ctx).errors).toEqual([]);
  });
});

describe('cssUnescape', () => {
  it('decodes hex and character escapes', () => {
    expect(cssUnescape('\\62 ox-screen')).toBe('box-screen');
    expect(cssUnescape('\\62ox')).toBe('box');
    expect(cssUnescape('u\\72l')).toBe('url');
    expect(cssUnescape('\\.a')).toBe('.a');
    expect(cssUnescape('\\0')).toBe('\uFFFD');
  });
});

describe('scopePackCss', () => {
  const T = "[data-theme='hijau-siti']";
  it('scopes a screen file under the theme and the screen', () => {
    const out = scopePackCss(".region-next{top:1px} .stage[data-live='blur'] .x, .y{color:red}", { theme: 'hijau-siti', screen: 'poster' });
    expect(out).toContain(`.stage${T}[data-screen='poster'] .region-next`);
    expect(out).toContain(`.stage${T}[data-screen='poster'][data-live='blur'] .x`);
    expect(out).toContain(`.stage${T}[data-screen='poster'] .y`);
  });

  it('scopes theme.css and arabic.css under the theme alone, and inside @media', () => {
    const out = scopePackCss('.a{color:red} .stage .b{color:red} .stage[data-screen] .c{color:red} @media (min-width:1px){.d{color:red}} *{margin:0}', { theme: 'hijau-siti' });
    expect(out).toContain(`.stage${T} .a{`);
    expect(out).toContain(`.stage${T} .b{`);
    expect(out).toContain(`.stage${T}[data-screen] .c{`);
    expect(out).toContain(`@media (min-width:1px){.stage${T} .d{`);
    expect(out).toContain(`.stage${T} *{`);
  });

  it('a bare :root rule of variables becomes the scoped stage', () => {
    const out = scopePackCss(':root{--accent:#0a0}', { theme: 'hijau-siti' });
    expect(out).toBe(`.stage${T}{--accent:#0a0}`);
  });

  it('every selector of a list is scoped, and nothing is left bare', () => {
    const out = scopePackCss('.a, .b > .c, .d .e{color:red}', { theme: 'hijau-siti' });
    expect(out.match(/\.stage\[data-theme='hijau-siti'\]/g)).toHaveLength(3);
  });

  it('the scoped result is still accepted', () => {
    const css = '.region-next{margin-top:1px} .stage .x{color:red} @media (min-width:1px){.a{color:red}} :root{--pack-k:1}';
    expect(checkCss(scopePackCss(css, { theme: 'hijau-siti', screen: 'poster' }), ctx).errors).toEqual([]);
  });

  it('refuses a name that is not a theme name', () => {
    expect(() => scopePackCss('.a{color:red}', { theme: "x']{}" })).toThrow();
  });
});

describe('rewriteUrls', () => {
  it('rewrites pack urls to absolute paths', () => {
    expect(rewriteUrls('a{background:url(images/kuliah.jpg)} b{background:url("../images/kuliah.jpg")}', '/themes/hijau-siti/0123456789abcdef/')).toMatch(/url\("?\/themes\/hijau-siti\/0123456789abcdef\/images\/kuliah\.jpg"?\).*url\("?\/themes\/hijau-siti\/0123456789abcdef\/images\/kuliah\.jpg"?\)/s);
  });
  it('rewrites image-set strings and tolerates a base without a trailing slash', () => {
    const out = rewriteUrls('a{background:image-set("images/kuliah.jpg" 1x)}', '/api/themes/staged/ab');
    expect(out).toContain('"/api/themes/staged/ab/images/kuliah.jpg"');
  });
  it('an address that does not belong never survives', () => {
    const out = rewriteUrls('a{background:url(https://x.example/a.jpg)}', '/themes/x/1/');
    expect(out).not.toContain('x.example');
  });
});
