// Generates the two default kiosk backgrounds as own work (no photos, no
// licence questions): an SVG scene rendered to JPEG with Playwright Chromium.
//
//   node scripts/make-backgrounds.mjs
//
// default-1.jpg: warm dusk, brighter (auto tone must shade it more).
// default-2.jpg: deep night, darker (auto tone shades it less, accent from the moon).
// Both 1920x1080, target < 400 KB.

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../apps/kiosk-display/src/assets/backgrounds');
const W = 1920;
const H = 1080;

/** Khatam-style eight-point star lattice as an SVG pattern (thin strokes only). */
function starPattern(id, stroke, opacity) {
  const c = 96; // cell size
  const h = c / 2;
  const r = c * 0.42;
  const pts = (n, rot) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = rot + (i * 2 * Math.PI) / n;
      out.push(`${(h + r * Math.cos(a)).toFixed(2)},${(h + r * Math.sin(a)).toFixed(2)}`);
    }
    return out.join(' ');
  };
  return `
  <pattern id="${id}" width="${c}" height="${c}" patternUnits="userSpaceOnUse">
    <g fill="none" stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="1.1">
      <polygon points="${pts(4, 0)}"/>
      <polygon points="${pts(4, Math.PI / 4)}"/>
      <line x1="0" y1="0" x2="${c}" y2="${c}"/>
      <line x1="${c}" y1="0" x2="0" y2="${c}"/>
    </g>
  </pattern>`;
}

/** Mosque silhouette along the horizon: arcade with open arches, onion dome, two slim minarets. */
function silhouette(fill) {
  const base = 960; // horizon y: the arcade sits behind the prayer bar, the dome rises above it
  const cx = W / 2;
  const wallH = 96;
  // Pointed arches cut out of the arcade wall through a mask.
  const arch = (x, w, hgt) =>
    `M${x},${base} v-${hgt * 0.5} q0,-${w * 0.55} ${w / 2},-${w * 0.62} q${w / 2},${w * 0.07} ${w / 2},${w * 0.62} v${hgt * 0.5} z`;
  let arches = '';
  for (let i = -6; i <= 6; i++) {
    if (Math.abs(i) <= 1) continue; // behind the central hall
    const w = 56;
    const x = cx + i * 96 - w / 2;
    arches += `<path d="${arch(x, w, wallH)}" fill="#000"/>`;
  }
  const minaret = (x) => `
    <rect x="${x - 9}" y="${base - 360}" width="18" height="360"/>
    <rect x="${x - 17}" y="${base - 376}" width="34" height="12" rx="3"/>
    <rect x="${x - 7}" y="${base - 420}" width="14" height="46"/>
    <path d="M${x - 13},${base - 420} q13,-46 26,0 z"/>
    <rect x="${x - 1.2}" y="${base - 486}" width="2.4" height="22"/>
    <circle cx="${x}" cy="${base - 468}" r="3"/>`;
  // Onion dome: bulges past its drum, then tapers to a finial.
  const dome = `M${cx - 150},${base - 236}
    C ${cx - 150},${base - 300} ${cx - 215},${base - 330} ${cx - 190},${base - 400}
    C ${cx - 160},${base - 470} ${cx - 40},${base - 470} ${cx},${base - 536}
    C ${cx + 40},${base - 470} ${cx + 160},${base - 470} ${cx + 190},${base - 400}
    C ${cx + 215},${base - 330} ${cx + 150},${base - 300} ${cx + 150},${base - 236} z`;
  return `
  <mask id="arcade">
    <rect x="${cx - 640}" y="${base - wallH}" width="1280" height="${wallH}" fill="#fff"/>
    ${arches}
  </mask>
  <g fill="${fill}">
    <rect x="0" y="${base - 4}" width="${W}" height="${H - base + 4}"/>
    <rect x="${cx - 640}" y="${base - wallH}" width="1280" height="${wallH}" mask="url(#arcade)"/>
    <rect x="${cx - 190}" y="${base - 236}" width="380" height="236"/>
    <rect x="${cx - 160}" y="${base - 246}" width="320" height="12" rx="3"/>
    <path d="${dome}"/>
    <rect x="${cx - 1.6}" y="${base - 572}" width="3.2" height="40"/>
    <circle cx="${cx}" cy="${base - 548}" r="4"/>
    ${minaret(cx - 470)}
    ${minaret(cx + 470)}
  </g>`;
}

function duskScene() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4f7489"/>
      <stop offset="0.38" stop-color="#9c9d8c"/>
      <stop offset="0.66" stop-color="#e2b47a"/>
      <stop offset="0.82" stop-color="#f3c88c"/>
      <stop offset="1" stop-color="#d9a06a"/>
    </linearGradient>
    <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#fff2d2" stop-opacity="0.95"/>
      <stop offset="0.35" stop-color="#ffd79a" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#ffc27a" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="haze" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f6d7a8" stop-opacity="0"/>
      <stop offset="1" stop-color="#f6d7a8" stop-opacity="0.55"/>
    </linearGradient>
    ${starPattern('lattice', '#ffffff', 0.09)}
  </defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  <rect width="${W}" height="${H}" fill="url(#lattice)"/>
  <ellipse cx="1180" cy="760" rx="640" ry="420" fill="url(#sun)"/>
  <rect y="600" width="${W}" height="300" fill="url(#haze)"/>
  ${silhouette('#1b3c3d')}
  </svg>`;
}

function nightScene() {
  let stars = '';
  let seed = 7;
  const rnd = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 160; i++) {
    const x = rnd() * W;
    const y = rnd() * 640;
    const r = 0.6 + rnd() * 1.4;
    const o = 0.25 + rnd() * 0.6;
    stars += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="#fff6e3" fill-opacity="${o.toFixed(2)}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#050b14"/>
      <stop offset="0.5" stop-color="#0a1a26"/>
      <stop offset="0.85" stop-color="#143039"/>
      <stop offset="1" stop-color="#1a3a3e"/>
    </linearGradient>
    <radialGradient id="moonglow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ffd59a" stop-opacity="0.55"/>
      <stop offset="0.4" stop-color="#ffb766" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#ffb766" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="horizon" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffb766" stop-opacity="0"/>
      <stop offset="1" stop-color="#ffb766" stop-opacity="0.22"/>
    </linearGradient>
    ${starPattern('lattice', '#ffffff', 0.05)}
  </defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  <rect width="${W}" height="${H}" fill="url(#lattice)"/>
  ${stars}
  <ellipse cx="1430" cy="300" rx="420" ry="320" fill="url(#moonglow)"/>
  <mask id="crescent"><circle cx="1430" cy="300" r="78" fill="#fff"/><circle cx="1462" cy="272" r="70" fill="#000"/></mask>
  <circle cx="1430" cy="300" r="78" fill="#ffe3b0" mask="url(#crescent)"/>
  <rect y="560" width="${W}" height="320" fill="url(#horizon)"/>
  ${silhouette('#061016')}
  </svg>`;
}

async function renderJpeg(page, svg, file) {
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:#000">${svg}</body></html>`,
  );
  const el = page.locator('svg');
  let quality = 82;
  let buf;
  for (;;) {
    buf = await el.screenshot({ type: 'jpeg', quality });
    if (buf.length < 400 * 1024 || quality <= 50) break;
    quality -= 6;
  }
  writeFileSync(file, buf);
  console.log(`${file}: ${statSync(file).size} bytes (quality ${quality})`);
}

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await renderJpeg(page, duskScene(), resolve(outDir, 'default-1.jpg'));
await renderJpeg(page, nightScene(), resolve(outDir, 'default-2.jpg'));
await browser.close();
