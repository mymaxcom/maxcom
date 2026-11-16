// MEASURE_MODULE for template-shots.mjs (used by setting-matrix.mjs): after each screenshot it records, for every
// text or picture element a style-driven setting may change, the computed values that show the change (size, alignment,
// position, outline, picture) and appends one JSON line per screen to MATRIX_OUT.
import { appendFileSync } from 'node:fs';

export const TARGETS = [
  // full-stage content screens
  '.kul-name', '.kul-topic', '.kul-photo', '.kul-photo img', '.kuliah',
  '.hadis-ar', '.hadis-ms', '.hadis-src', '.hadis',
  '.aa-text', '.aa-tr', '.aa-head', '.ah-ar', '.ah-ms', '.ah-src', '.zk-ar', '.zk-ms',
  // framed cards and the zikir page
  '.ayat__ar', '.ayat__ms', '.zikir__ar', '.zikir__ms', '.zikir__page',
  '.pengumuman__title', '.pengumuman__text', '.program__title', '.takwim__title', '.takwim__n', '.tabung__name',
  // the large text of the gold outline (theme round 2)
  '.clock__hm', '.clock--compact .hm', '.phase__big', '.screen--main .next .num',
  // stage pictures and the scrim over them
  '.bg__menu', '.bg__img', '.bg__scrim',
];

export default async function measure({ page, template, stateName }) {
  const out = process.env.MATRIX_OUT;
  if (!out) return;
  const data = await page.evaluate((targets) => {
    const res = {};
    const stage = document.querySelector('.stage');
    res.stage = { bg: stage?.getAttribute('data-bg') ?? null, screen: stage?.getAttribute('data-screen') ?? null };
    for (const sel of targets) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') { res[sel] = { hidden: true }; continue; }
      const r = el.getBoundingClientRect();
      // The first line box of the text: where the text itself starts and ends (alignment moves it inside its box).
      let line = null;
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((x) => x.width > 0);
      if (rects.length > 0) line = { l: Math.round(rects[0].left), r: Math.round(rects[0].right) };
      res[sel] = {
        fontSize: cs.fontSize,
        textAlign: cs.textAlign,
        alignSelf: cs.alignSelf,
        box: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        line,
        radius: cs.borderTopLeftRadius + ' ' + cs.borderTopRightRadius,
        clip: cs.clipPath,
        bgImage: cs.backgroundImage.slice(0, 80),
        src: el.getAttribute('src'),
        textShadow: cs.textShadow,
        scrim: el.classList.contains('bg__scrim') ? cs.backgroundImage.slice(0, 40) : undefined,
      };
    }
    return res;
  }, TARGETS);
  appendFileSync(out, JSON.stringify({ template, stateName, data }) + '\n');
}
