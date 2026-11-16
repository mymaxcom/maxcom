// Real-browser check that the health check does not fail a pack that changes nothing: for every built-in theme and every
// screen state of scripts/template-shots.mjs, the protected rules are attached, the stage is marked as wearing a pack,
// and the real health check runs on the real screen. Any role that fails here would make the box reject a harmless pack.
//
//   MEASURE_MODULE=scripts/proof-theme-health-builtins.mjs node scripts/template-shots.mjs <outDir> [templates] [states]
//
// With PACK_DIR=<folder of an unpacked theme> (for example docs/guide/tema/sample/hijau-siti) the same check runs with that pack
// installed on its base theme (scoped as the box scopes it): only the pack's base theme is measured, every screen must still pass.
//
// Prints one line per screen; the line starts with FAIL when the health check says no. (It runs after the screenshot, so the
// pictures are the plain built-in ones.)
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { PROTECTED } = await import(pathToFileURL(resolve(repo, 'packages/core/src/index.ts')).href);
const { PROTECTED_CSS } = await import(pathToFileURL(resolve(repo, 'apps/kiosk-display/src/themes/protectedCss.ts')).href);
let src = readFileSync(resolve(repo, 'apps/kiosk-display/src/themes/health.ts'), 'utf8');
src = stripTypeScriptTypes(src, { mode: 'strip' });
src = src.replace(/^import .*$/gm, '').replace(/^export /gm, '');
const minSizes = JSON.parse(readFileSync(resolve(repo, 'apps/kiosk-display/src/themes/minSizes.json'), 'utf8'));
const prelude = `const PROTECTED = ${JSON.stringify(PROTECTED)}; const minSizes = ${JSON.stringify(minSizes)};\n`;

// The pack under test (optional): its manifest, theme.css and screens/<id>.css.
const PACK_DIR = process.env.PACK_DIR === undefined ? null : resolve(repo, process.env.PACK_DIR);
let packManifest = null;
let packScope = null;
if (PACK_DIR !== null) {
  packManifest = JSON.parse(readFileSync(resolve(PACK_DIR, 'theme.json'), 'utf8'));
  packScope = (await import(pathToFileURL(resolve(repo, 'apps/box-server/src/themes/cssCheck.ts')).href)).scopePackCss;
}
const packCssFor = (screen) => {
  const parts = [];
  const all = resolve(PACK_DIR, 'theme.css');
  if (existsSync(all)) parts.push(packScope(readFileSync(all, 'utf8'), { theme: packManifest.name }));
  const own = resolve(PACK_DIR, 'screens', `${screen}.css`);
  if (existsSync(own)) parts.push(packScope(readFileSync(own, 'utf8'), { theme: packManifest.name, screen }));
  return parts.join(' ');
};

export default async function measure({ page, template, stateName }) {
  if (PACK_DIR !== null && template !== packManifest.base) return;
  await page.evaluate(({ css, code }) => {
    if (typeof checkScreenHealth === 'undefined') {
      const s = document.createElement('script');
      s.textContent = code;
      document.head.appendChild(s);
    }
    if (document.getElementById('mx-protected') === null) {
      const style = document.createElement('style');
      style.id = 'mx-protected';
      style.textContent = css;
      document.head.appendChild(style);
    }
    // a pack that changes nothing: its (empty) stylesheet is in the page, as it is on a box
    if (document.getElementById('mx-theme-pack') === null) {
      const pack = document.createElement('style');
      pack.id = 'mx-theme-pack';
      document.head.insertBefore(pack, document.getElementById('mx-protected'));
    }
    document.querySelector('.stage')?.setAttribute('data-pack', 'ready');
  }, { css: PROTECTED_CSS, code: prelude + src });
  if (PACK_DIR !== null) {
    const screen = await page.evaluate(() => document.querySelector('.stage').getAttribute('data-screen'));
    await page.evaluate(({ css, name }) => {
      document.querySelector('.stage').setAttribute('data-theme', name);
      document.getElementById('mx-theme-pack').textContent = css;
    }, { css: packCssFor(screen), name: packManifest.name });
    await page.waitForTimeout(150);
  }
  const res = await page.evaluate((logoSet) => {
    const stage = document.querySelector('.stage');
    const screen = stage.getAttribute('data-screen');
    applyPlates(stage);
    const r = checkScreenHealth(stage, screen, { logoSet, base: stage.getAttribute('data-template') ?? 'default', viewport: { width: innerWidth, height: innerHeight }, measure: realMeasure });
    // what each failing role looks like, for the log
    const why = r.failed.map((role) => {
      const el = stage.querySelector(`[data-role="${role}"]`);
      if (el === null) return `${role}: no element`;
      const m = realMeasure(el);
      const bad = (m.musts ?? []).map((x, i) => ({ i, x })).filter(({ x }) => !(x.displayed && x.hasText && x.visible && x.opacity >= 0.9 && !x.covered && !x.textHidden && !x.picture && !x.transformed && (x.contrast === null || x.contrast >= 3) && x.fontRem >= 0.7));
      const hits = [];
      for (const x of [...el.querySelectorAll('[data-must]')]) {
        const rs = textRects(x);
        if (rs.length === 0) continue;
        for (const [px, py] of probePoints(rs[0])) {
          const h = hitTest(Math.min(Math.max(px, 0), innerWidth - 1), Math.min(Math.max(py, 0), innerHeight - 1));
          if (h !== null && !(h === x || x.contains(h) || h.contains(x))) hits.push(`${x.className}@${Math.round(px)},${Math.round(py)} <- ${h.tagName.toLowerCase()}.${String(h.className).slice(0, 40)}`);
        }
      }
      const th = [...el.querySelectorAll('*'), el].filter((e) => (e.textContent ?? '').trim() !== '' && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '')).filter((e) => { const c = getComputedStyle(e); return !(parseFloat(c.fontSize) >= 8 || false) || chainOpacity(e) < 0.9 || e.getBoundingClientRect().width === 0; }).map((e) => `${e.tagName}.${String(e.className).slice(0, 30)} op=${chainOpacity(e).toFixed(2)} fs=${getComputedStyle(e).fontSize}`);
      return `${role}: textHiddenBy=${JSON.stringify(th.slice(0, 3))} hits=${JSON.stringify(hits.slice(0, 4))} displayed=${m.displayed} covered=${m.covered} textHidden=${m.textHidden} contrast=${m.contrast} font=${m.fontRem.toFixed(2)} musts=${(m.musts ?? []).length} badMusts=${JSON.stringify(bad.map(({ x }) => ({ d: x.displayed, t: x.hasText, c: x.covered, h: x.textHidden, p: x.picture, tr: x.transformed, k: x.contrast === null ? null : Number(x.contrast.toFixed(2)), f: Number(x.fontRem.toFixed(2)) })))} cells=${JSON.stringify(m.cells)}`;
    });
    return { ok: r.ok, failed: r.failed, screen, why };
  }, stateName.startsWith('logo'));
  console.log(`${res.ok ? 'HEALTH-OK  ' : 'HEALTH-FAIL'} ${template}-${stateName} screen=${res.screen}${res.ok ? '' : ` failed=${res.failed} :: ${res.why.join(' || ')}`}`);
}
