// Exact pixel compare of two screenshot directories (golden harness, themes plan A).
//
//   node scripts/shots-compare.mjs <dirA> <dirB>
//
// One line per PNG: SAME or DIFF <n> px. Exit 1 on any DIFF, a size mismatch, or a file present in one directory only.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { PNG } = createRequire(resolve(here, '../apps/box-server/package.json'))('pngjs');

/** Exact RGBA compare; a size mismatch is never the same. */
export function comparePng(a, b) {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return { same: false, diffPixels: Math.max(pa.width * pa.height, pb.width * pb.height) };
  let diffPixels = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    if (pa.data[i] !== pb.data[i] || pa.data[i + 1] !== pb.data[i + 1] || pa.data[i + 2] !== pb.data[i + 2] || pa.data[i + 3] !== pb.data[i + 3]) diffPixels++;
  }
  return { same: diffPixels === 0, diffPixels };
}

function compareDirs(dirA, dirB) {
  const list = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.png')) : []);
  const a = list(dirA);
  const b = list(dirB);
  const names = [...new Set([...a, ...b])].sort();
  let bad = names.length === 0;
  if (names.length === 0) console.log('FAIL no PNG files in either directory');
  for (const n of names) {
    if (!a.includes(n) || !b.includes(n)) { console.log(`ONLY ${n} (${a.includes(n) ? dirA : dirB})`); bad = true; continue; }
    const r = comparePng(readFileSync(resolve(dirA, n)), readFileSync(resolve(dirB, n)));
    console.log(`${r.same ? 'SAME' : `DIFF ${r.diffPixels} px`} ${n}`);
    if (!r.same) bad = true;
  }
  return bad;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [dirA, dirB] = process.argv.slice(2);
  if (!dirA || !dirB) { console.error('usage: node scripts/shots-compare.mjs <dirA> <dirB>'); process.exit(2); }
  process.exit(compareDirs(resolve(dirA), resolve(dirB)) ? 1 : 0);
}
