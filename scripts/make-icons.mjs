// MAXCOM: renders the brand mark to PNGs and packs branding/maxcom/maxcom.ico.
// Node 24, no npm dependency. Uses Microsoft Edge headless to rasterise the SVG.
// Usage: node scripts/make-icons.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const brand = join(repo, 'branding', 'maxcom');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const BG = '#06302B'; // same dark green as the phone app icon background
const EDGES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const edge = EDGES.find((p) => existsSync(p));
if (!edge) throw new Error('GAGAL: msedge.exe tidak dijumpai');

const svg = readFileSync(join(brand, 'maxcom-mark-dark.svg'), 'utf8').replace(/<\?xml[^>]*>\s*/, '');
const tmp = mkdtempSync(join(tmpdir(), 'maxcom-icons-'));

function render(n) {
  // dark rounded square with the MAX mark at ~84% of the side, centred
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden}
.i{width:${n}px;height:${n}px;background:${BG};border-radius:${Math.round(n * 0.22)}px;display:flex;align-items:center;justify-content:center}
.i svg{width:84%;height:84%;display:block}
</style></head><body><div class="i">${svg}</div></body></html>`;
  const page = join(tmp, `i${n}.html`);
  const out = join(tmp, `i${n}.png`);
  writeFileSync(page, html);
  // some Edge builds refuse a window under ~500 px wide, so render big and crop is not possible without deps:
  // instead keep the requested size and verify the PNG header afterwards.
  execFileSync(edge, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--default-background-color=00000000', `--screenshot=${out}`, `--window-size=${n},${n}`,
    `--user-data-dir=${join(tmp, 'profile')}`, pathToFileURL(page).href,
  ], { stdio: 'ignore', timeout: 60000 });
  const png = readFileSync(out);
  return png;
}

function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('GAGAL: bukan PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

const pngs = [];
try {
  for (const n of SIZES) {
    const png = render(n);
    const [w, h] = pngSize(png);
    if (w !== n || h !== n) throw new Error(`GAGAL: PNG ${n} keluar ${w}x${h} (Edge mengubah saiz tetingkap)`);
    writeFileSync(join(brand, `maxcom-icon-${n}.png`), png);
    pngs.push([n, png]);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ICO: 6-byte header, 16-byte entries, then the PNG blobs
const head = Buffer.alloc(6);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
let offset = 6 + 16 * pngs.length;
const dir = [];
for (const [n, png] of pngs) {
  const e = Buffer.alloc(16);
  e[0] = n === 256 ? 0 : n; e[1] = n === 256 ? 0 : n; e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12);
  dir.push(e); offset += png.length;
}
const icoPath = join(brand, 'maxcom.ico');
mkdirSync(brand, { recursive: true });
writeFileSync(icoPath, Buffer.concat([head, ...dir, ...pngs.map((p) => p[1])]));

// read back
const ico = readFileSync(icoPath);
if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('GAGAL: kepala ICO salah');
const count = ico.readUInt16LE(4);
const got = [];
for (let i = 0; i < count; i++) {
  const o = 6 + 16 * i;
  const w = ico[o] || 256;
  const len = ico.readUInt32LE(o + 8);
  const off = ico.readUInt32LE(o + 12);
  const [pw, ph] = pngSize(ico.subarray(off, off + len));
  if (pw !== w || ph !== w) throw new Error(`GAGAL: entri ${i} lebar ${w} tetapi PNG ${pw}x${ph}`);
  got.push(w);
}
if (count !== SIZES.length || got.join() !== SIZES.join()) throw new Error(`GAGAL: ICO ada ${got.join()}`);
console.log(`OK ${icoPath}: ${count} entri (${got.join(', ')}), ${ico.length} bait`);
