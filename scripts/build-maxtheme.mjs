// Builds a .maxtheme file from a source folder.
//
//   node scripts/build-maxtheme.mjs <sourceDir> <out.maxtheme>
//
// The folder holds the fixed paths of a theme pack (theme.json, theme.css, arabic.css, screens/<id>.css,
// images/<id>.jpg|png; no fonts in this version). Any other file is refused, naming it. When a stylesheet points at
// images/kuliah.png and the folder has no such picture, a 960 by 540 picture of soft diagonal green bands is drawn
// here with pngjs, so the sample theme needs no outside picture. The box's own validator is not run here; the test
// and `scripts/build-theme-guide.mjs` do that.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { writeStoredZip } from '../apps/box-server/src/files/zipWrite.ts';
import { packPathError } from '../apps/box-server/src/themes/packFormat.ts';

/** Every file below `dir`, as forward-slash paths relative to it. */
function walk(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    if (statSync(join(dir, rel)).isDirectory()) out.push(...walk(dir, rel));
    else out.push(rel);
  }
  return out;
}

/** A 960 by 540 picture of soft diagonal green bands. Same bytes on every run. */
export function greenBandsPng() {
  const w = 960;
  const h = 540;
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = (x * 0.8 + y * 1.2) / 140;
      const band = 0.5 + 0.5 * Math.sin(d * Math.PI);
      const soft = 0.5 + 0.5 * Math.sin((x - y * 0.4) / 260);
      const k = 0.55 * band + 0.45 * soft;
      const i = (y * w + x) * 4;
      png.data[i] = Math.round(10 + 22 * k);
      png.data[i + 1] = Math.round(36 + 52 * k);
      png.data[i + 2] = Math.round(26 + 34 * k);
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png, { colorType: 2 });
}

/** The pack as bytes. Throws, naming the file, on anything that is not one of the fixed theme paths. */
export function buildMaxtheme(sourceDir) {
  const root = resolve(sourceDir);
  const files = walk(root);
  const entries = [];
  for (const rel of files) {
    const bad = packPathError(rel);
    if (bad !== null) throw new Error(`${rel}: ${bad}`);
    entries.push({ name: rel, data: readFileSync(join(root, rel)) });
  }
  const wantsPicture = entries.some((e) => e.name.endsWith('.css') && e.data.toString('utf8').includes('images/kuliah.png'));
  if (wantsPicture && !files.includes('images/kuliah.png')) entries.push({ name: 'images/kuliah.png', data: greenBandsPng() });
  // theme.json first, as a person would pack it; the rest in path order.
  entries.sort((a, b) => (a.name === 'theme.json' ? -1 : b.name === 'theme.json' ? 1 : a.name < b.name ? -1 : 1));
  // A fixed time so the same source gives the same file.
  return writeStoredZip(entries, new Date(Date.UTC(2026, 10, 15, 0, 0, 0)));
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) {
    console.error('usage: node scripts/build-maxtheme.mjs <sourceDir> <out.maxtheme>');
    process.exit(2);
  }
  if (!existsSync(src)) { console.error(`no such folder: ${src}`); process.exit(2); }
  try {
    const buf = buildMaxtheme(src);
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, buf);
    console.log(`${out} (${buf.length} bytes)`);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
}
