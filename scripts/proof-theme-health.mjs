// Real-browser proof of the allow-list validator, the protected rules and the health check (Chromium through playwright).
// Every attack on the clock, the prayer times and the next-prayer chip is injected straight into the page (bypassing the
// validator, as the box would bundle it: scoped, with protected.css last), and the report says, for each one, whether the
// VALIDATOR refuses it (the pack is never installed) and what the HEALTH CHECK says if it got through anyway.
// An attack is handled when the validator refuses it, or the health check catches it, or protected.css neutralises it
// (the strongest ones are refused AND caught). Exit code 1 when a case is not what it should be.
//
//   node scripts/proof-theme-health.mjs
//
// To see the same attacks against an older health check, point HEALTH_FILE and PROTECTED_FILE at older copies of
// themes/health.ts and themes/protectedCss.ts (the report then shows the attacks that were not caught).
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(pathToFileURL(resolve(repo, 'package.json')))('playwright');
const { PROTECTED } = await import(pathToFileURL(resolve(repo, 'packages/core/src/index.ts')).href);
const protectedFile = process.env.PROTECTED_FILE ?? resolve(repo, 'apps/kiosk-display/src/themes/protectedCss.ts');
const { PROTECTED_CSS } = await import(pathToFileURL(protectedFile).href);
const { scopePackCss, checkCss } = await import(pathToFileURL(resolve(repo, 'apps/box-server/src/themes/cssCheck.ts')).href);

const healthFile = process.env.HEALTH_FILE ?? resolve(repo, 'apps/kiosk-display/src/themes/health.ts');
let src = readFileSync(healthFile, 'utf8');
src = stripTypeScriptTypes(src, { mode: 'strip' });
src = src.replace(/^import .*$/gm, '').replace(/^export /gm, '');
const minSizes = JSON.parse(readFileSync(`${repo}/apps/kiosk-display/src/themes/minSizes.json`, 'utf8'));
const prelude = `const PROTECTED = ${JSON.stringify(PROTECTED)}; const minSizes = ${JSON.stringify(minSizes)};\n`;
const HOST_EXIT_CSS = readFileSync(`${repo}/apps/kiosk-display/src/ui/hostExit.css`, 'utf8');

const BASE_CSS = `
html,body{margin:0;font-size:19.2px}
.stage{position:relative;width:1920px;height:1080px;background:#102a22;color:#eef8f1;overflow:hidden;font-family:sans-serif}
.region-clock{position:absolute;left:100px;top:60px;font-size:8rem}
.region-prayers{position:absolute;left:100px;top:500px;font-size:2rem;display:flex;gap:2rem}
.pcell{background:#0a1f18}
.region-next{position:absolute;left:1200px;top:100px;font-size:2rem;background:#0a1f18;padding:1rem}
.screen{position:relative}
.deco{position:absolute;inset:0;pointer-events:none}
.deco i{position:absolute;display:block}
${HOST_EXIT_CSS}
`;
const HTML = `<div class="stage" data-pack="ready" data-theme="hijau-siti" data-screen="biasa" data-template="creative">
 <div class="deco" aria-hidden="true"><i class="d1"></i><i class="d2"></i></div>
 <div class="screen">
  <div class="region-clock" data-role="clock"><span class="clock__hm" data-must="">10:15</span></div>
  <div class="region-prayers" data-role="prayers" data-cells="2"><div class="pcell"><span class="pcell__label" data-must="">Subuh</span> <span class="pcell__time" data-must="">05:50</span></div><div class="pcell"><span class="pcell__label" data-must="">Zohor</span> <span class="pcell__time" data-must="">13:10</span></div></div>
  <div class="region-next" data-role="next"><span data-must="">Seterusnya Zohor</span></div>
 </div>
 <button class="host-exit" aria-label="MAXCOM"><span style="color:#fff;font-size:.7rem">MAXCOM</span></button>
</div>`;

// a picture of the pack, served from where the box serves them (the health check knows a pack picture by its /themes/ address)
const PIC_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><rect width='40' height='40' fill='#f3e27a'/><circle cx='20' cy='20' r='12' fill='#eef8f1'/></svg>";
const PIC = 'url("http://proof.local/themes/hijau-siti/0123456789abcdef/images/kuliah.svg")';
const hostExitSmall = `(() => { const r = document.querySelector('.host-exit').getBoundingClientRect(); return r.width < 250 && r.height < 60 && getComputedStyle(document.querySelector('.host-exit')).display !== 'none'; })()`;

// [label, packCss, health ('ok' | 'fail'), { html?, noProtected?, check?, accepted? }]
//   health: what the health check must say with the protected rules in place
//   accepted: the validator accepts it (a legitimate re-skin); every other case is an attack and must be refused,
//   except `byDesign`: colours and gradients are allowed in a re-skin, so the validator cannot tell the harmless from the
//   hostile one; the health check (contrast against every stop, plates) is what catches those
const CASES = [
  ['control: no pack css at all', '', 'ok', { accepted: true }],
  ['control: no pack css and no protected rules (the baseline of the "health check alone" cases)', '', 'ok', { accepted: true, noProtected: true }],
  ['good: clock repainted, prayer panel and next chip re-skinned', '.region-clock{color:#f3e27a}.region-prayers{border:.15rem solid #7fdc9a;border-radius:1rem}.region-next{background-color:#0a2219;border-radius:1rem;box-shadow:0 0 1rem #000}', 'ok', { accepted: true }],

  // --- the earlier cases (the validator now refuses all of them, and the layers behind it still hold)
  ['clock opacity .1 (protected resets it)', '.region-clock{opacity:.1}', 'ok'],
  ['clock transform translateX(-5000px) (protected resets it)', '.region-clock{transform:translateX(-5000px)}', 'ok'],
  ['clock visibility hidden (protected resets it)', '.region-clock{visibility:hidden}', 'ok'],
  ['clock inner opacity (protected resets descendants)', '.clock__hm{opacity:0}', 'ok'],
  ['overlay with a lower z-index than the protected 35', '.d1{inset:0;background:#000;z-index:30;pointer-events:none}', 'ok'],
  ['overlay in a stacking context that wraps the clock', '.screen{z-index:1}.d1{position:absolute;inset:0;background:#000;z-index:30;pointer-events:none}', 'fail'],
  ['clock display none', '.region-clock{display:none}', 'fail'],
  ['clock text transparent', '.region-clock{color:transparent}', 'fail', { byDesign: true }],
  ['clock text same colour as its panel', '.region-next{color:#0a1f18}', 'fail', { byDesign: true }],
  ['prayers time at font-size 1px', '.pcell__time{font-size:1px}', 'fail'],
  ['prayers text pushed out with text-indent', '.pcell__label{display:inline-block;width:5rem;overflow:hidden;white-space:nowrap;text-indent:-9999px}', 'fail'],
  ['clock font-size 0', '.region-clock{font-size:0}', 'fail'],
  ['next chip moved off screen with left', '.region-next{left:5000px}', 'fail'],
  ['prayers cells shrunk to zero width', '.pcell{width:0;overflow:hidden}', 'fail'],
  ['clock text in low-contrast grey on grey panel', '.region-clock{background:#777;color:#7a7a7a}', 'fail', { byDesign: true }],
  ['the box network check (z-index 40, opaque, a whole box screen) is not a theme problem', '', 'ok', { accepted: true, html: '<div class="netcheck box-screen" style="position:absolute;inset:0;z-index:40;background:#000"></div>' }],

  // --- S1: shrink, mirror, turn, zoom (on an ancestor too)
  ['S1 ancestor scale(.1) shrinks the clock', '.screen{transform:scale(.1)}', 'fail'],
  ['S1 ancestor scaleX(-1) mirrors the clock', '.screen{transform:scaleX(-1)}', 'fail'],
  ['S1 ancestor rotate(180deg)', '.screen{transform:rotate(180deg)}', 'fail'],
  ['S1 ancestor zoom .1', '.screen{zoom:.1}', 'fail'],
  ['S1 ancestor individual scale .1', '.screen{scale:.1}', 'fail'],
  ['S1 ancestor individual rotate 180deg', '.screen{rotate:180deg}', 'fail'],
  ['S1 the clock itself scaled (protected resets it)', '.region-clock{transform:scale(.1)}', 'ok'],

  // --- S2: falsify the text
  ['S2 list marker with a fake time (display list-item)', '.clock__hm{display:list-item;list-style-type:"99:99";list-style-position:inside}', 'ok'],
  ['S2 bidi override reverses the digits (protected resets unicode-bidi)', '.pcell__time{direction:rtl;unicode-bidi:bidi-override}', 'ok'],
  ['S2 symbol font on the clock (validator only: font-family is not allowed)', ".clock__hm{font-family:Wingdings,'Segoe UI Symbol'}", 'ok'],
  ['S2 thick text stroke in the panel colour (protected resets it)', '.pcell__time{-webkit-text-stroke:.5rem #0a1f18}', 'ok'],

  // --- S3: contrast against a gradient or a picture
  ['S3 gradient in the text colour behind the clock', '.region-clock{background-image:linear-gradient(#f3e27a,#f3e27a);color:#f3e27a}', 'fail', { byDesign: true }],
  ['S3 gradient whose one end is the text colour', '.region-clock{background-image:linear-gradient(#000,#f3e27a);color:#f3e27a}', 'fail', { byDesign: true }],
  ['S3 gradient on the stage in the clock colour', '.stage{background-image:linear-gradient(#eef8f1,#eef8f1)}.pcell{background:transparent}', 'fail', { byDesign: true }],
  ['S3 picture behind the clock: it gets its own plate and still reads', `.region-clock{background-image:${PIC};background-size:cover}`, 'ok', { check: `document.querySelector('.clock__hm').hasAttribute('data-mx-plate')` }],
  ['S3 picture behind the clock and clock text in the picture colour (the plate rescues it)', `.region-clock{background-image:${PIC};color:#f3e27a}`, 'ok', { check: `document.querySelector('.clock__hm').hasAttribute('data-mx-plate')` }],

  // --- S5 / N1: the box's own overlay
  ['S5 host-exit display none (protected pins it)', '.host-exit{display:none}', 'ok', { check: hostExitSmall }],
  ['N1 host-exit grown over the whole screen (protected pins it)', `.host-exit{left:0;top:0;right:0;bottom:0;width:100vw;height:100vh;background:${PIC}}`, 'ok', { check: hostExitSmall }],
  ['N1 host-exit grown over the whole screen, protected rules absent: the health check alone', `.host-exit{position:fixed;left:0;top:0;width:100vw;height:100vh;background:${PIC};z-index:40}`, 'fail', { noProtected: true }],
  ['N1 netcheck class on a grown element over the clock is still only for a box screen', '', 'ok', { accepted: true, html: '<div class="netcheck box-screen" style="position:absolute;left:0;top:0;width:100px;height:100px;z-index:40"></div>' }],

  // --- N2: hide a part inside a protected element
  ['N2 clock hour and minute display none', '.clock__hm{display:none}', 'fail'],
  ['N2 prayer time display none', '.pcell__time{display:none}', 'fail'],
  ['N2 prayer name display none', '.pcell__label{display:none}', 'fail'],
  ['N2 one prayer cell display none', '.pcell:last-child{display:none}', 'fail'],
  ['N2 next chip text display none', '.region-next span{display:none}', 'fail'],

  // --- N3: stacking context, shadow and outline covers, clipping
  ['N3 small sibling with a 4000px box-shadow behind a stacking context', '.screen{z-index:0}.d1{left:900px;top:900px;width:10px;height:10px;box-shadow:0 0 0 4000px #000;z-index:34}', 'fail'],
  ['N3 small sibling with a 4000px outline behind a stacking context', '.screen{isolation:isolate}.d1{left:900px;top:900px;width:10px;height:10px;outline:4000px solid #000;z-index:34}', 'fail'],
  ['N3 ancestor opacity .99 stacking context plus a box-shadow cover', '.screen{opacity:.99}.d1{left:900px;top:900px;width:10px;height:10px;box-shadow:0 0 0 4000px #000;z-index:34}', 'fail'],
  ['N3 overflow hidden on the clock clips half the digits', '.region-clock{overflow:hidden;width:4rem}', 'fail'],
  ['N3 overflow hidden on an ancestor clips the clock', '.screen{overflow:hidden;width:3rem;height:3rem}', 'fail'],

  // --- N4: strike out or mask the digits
  ['N4 text-security disc on the clock (protected resets it)', '.clock__hm{-webkit-text-security:disc}', 'ok'],
  ['N4 thick line-through in the panel colour (protected resets it)', '.clock__hm{text-decoration:line-through;text-decoration-thickness:3rem;text-decoration-color:#102a22}', 'ok'],
  ['N4 text-security disc with the protected rules absent: the health check alone', '.clock__hm{-webkit-text-security:disc}', 'fail', { noProtected: true }],
  ['N4 line-through with the protected rules absent: the health check alone', '.clock__hm{text-decoration:line-through;text-decoration-thickness:3rem;text-decoration-color:#102a22}', 'fail', { noProtected: true }],
];

const browser = await chromium.launch();
let bad = 0;
let refusedCount = 0;
let caughtCount = 0;
let neutralisedCount = 0;
for (const [label, packCss, expectHealth, o = {}] of CASES) {
  const check = packCss === '' ? { errors: [] } : checkCss(packCss, { file: 'theme.css', images: new Set() });
  const scoped = packCss === '' ? '' : scopePackCss(packCss, { theme: 'hijau-siti' });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.route('http://proof.local/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: PIC_SVG }));
  await page.setContent(`<!doctype html><html><head><style>${BASE_CSS}</style><style id="mx-theme-pack">${scoped}</style>${o.noProtected ? '' : `<style id="mx-protected">${PROTECTED_CSS}</style>`}</head><body>${HTML.replace('<div class="deco"', (o.html ?? '') + '<div class="deco"')}</body></html>`);
  await page.addScriptTag({ content: prelude + src });
  const res = await page.evaluate(() => {
    const stage = document.querySelector('.stage');
    // eslint-disable-next-line no-undef
    if (typeof applyPlates === 'function') applyPlates(stage);
    // eslint-disable-next-line no-undef
    return checkScreenHealth(stage, 'biasa', { logoSet: false, base: 'creative', viewport: { width: innerWidth, height: innerHeight }, measure: realMeasure });
  });
  const checked = o.check === undefined ? true : await page.evaluate(o.check);
  const healthOk = res.ok === (expectHealth === 'ok');
  const refused = check.errors.length > 0;
  const validatorOk = o.accepted === true || o.byDesign === true ? !refused : refused;
  const fine = healthOk && validatorOk && checked;
  if (!fine) bad++;
  if (o.accepted !== true) {
    if (refused) refusedCount++;
    if (!res.ok) caughtCount++;
    else neutralisedCount++;
  }
  const tag = o.accepted === true ? 'accepted' : o.byDesign === true ? 'by design' : refused ? 'REFUSED ' : 'NOT REFUSED';
  console.log(`${fine ? 'as expected' : 'UNEXPECTED '} validator=${tag.padEnd(11)} health=${res.ok ? 'ok  ' : 'FAIL'}${res.ok ? '' : ' [' + res.failed + ']'}${checked ? '' : ' CHECK-FAILED'} :: ${label}`);
  await page.close();
}
await browser.close();
console.log(`attacks: ${refusedCount} refused by the validator, ${caughtCount} caught by the health check, ${neutralisedCount} neutralised by protected.css (health ok)`);
console.log(bad === 0 ? 'ALL AS EXPECTED' : `${bad} UNEXPECTED`);
process.exit(bad === 0 ? 0 : 1);
