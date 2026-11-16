// Per-theme check of the style-driven settings (brief 2026-11-16, guard 2): for each setting, every built-in theme and
// every screen the TV reaches for it is rendered twice in Chromium (template-shots.mjs, value A and value B) and the
// computed result of its text and picture elements is compared (setting-matrix-measure.mjs). A screen where the two
// values render the same fails the run. The screenshots of both runs stay in <outDir>/<case>/<a|b>/.
//
//   node scripts/setting-matrix.mjs <outDir> [case,case...]
//
// Env: SHOT_PORT (default 5187) and SHOT_VITE_CACHE (default <outDir>/.vite) keep the script's dev server apart from
// one the operator may be running from this checkout. SHOT_SIZE as in template-shots.mjs.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] ?? 'setting-matrix');
const THEMES = ['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic'];
const styles = (v) => ({ themeStyle: { styles: Object.fromEntries(THEMES.map((t) => [t, { semua: v, skrin: {} }])) } });
const TEXT_SCREENS = ['normal', 'hadis', 'ayat', 'arab-ayat', 'arab-hadis', 'arab-zikir', 'pengumuman', 'program', 'takwim'];

const CASES = {
  scale: { a: styles({ scale: 'S' }), b: styles({ scale: 'XL' }), states: TEXT_SCREENS, props: ['fontSize'] },
  align: { a: styles({ align: 'kiri' }), b: styles({ align: 'kanan' }), states: TEXT_SCREENS, props: ['textAlign', 'line', 'box'] },
  'hadis-fontSize': { a: { hadis: { fontSize: 'l' } }, b: { hadis: { fontSize: 's' } }, states: ['hadis', 'arab-hadis'], props: ['fontSize'] },
  'ayat-textSize': { a: { ayatCard: { textSize: 's' } }, b: { ayatCard: { textSize: 'l' } }, states: ['ayat', 'arab-ayat'], props: ['fontSize'] },
  'photo-shape': { a: { penceramahPhoto: { shape: 'round' } }, b: { penceramahPhoto: { shape: 'square' } }, states: ['normal'], props: ['radius', 'clip'] },
  backgrounds: { a: {}, b: { backgrounds: { images: ['@asset:program1'] } }, states: ['biasa', 'normal', 'hadis'], props: ['stage', 'bgImage', 'src', 'scrim'] },
  // Ubah suai "Garis emas pada tajuk" (theme round 2): offered and drawn in Default, Old School and Arabic Art only.
  goldOutline: {
    a: styles({ goldOutline: 'on' }), b: styles({ goldOutline: 'off' }), themes: ['default', 'oldschool', 'arabic'],
    states: ['biasa', 'normal', 'iqamah'], props: ['textShadow'],
  },
};

// The stage entry (data-bg, data-screen) counts as one value, compared whole when the case lists 'stage'.
const pick = (o, props, sel) => (sel === 'stage' ? (props.includes('stage') ? JSON.stringify(o) : '') : JSON.stringify(props.map((p) => (o ? o[p] : undefined))));
function load(file) {
  const m = new Map();
  if (!existsSync(file)) return m;
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    m.set(`${r.template}|${r.stateName}`, r.data);
  }
  return m;
}

const wanted = process.argv[3] ? process.argv[3].split(',') : Object.keys(CASES);
const env = { ...process.env, SHOT_PORT: process.env.SHOT_PORT ?? '5187', SHOT_VITE_CACHE: process.env.SHOT_VITE_CACHE ?? resolve(outDir, '.vite'), MEASURE_MODULE: resolve(here, 'setting-matrix-measure.mjs') };
const failures = [];
for (const name of wanted) {
  const c = CASES[name];
  if (!c) throw new Error(`unknown case ${name}`);
  const runs = {};
  for (const side of ['a', 'b']) {
    const dir = resolve(outDir, name, side);
    mkdirSync(dir, { recursive: true });
    const settingsFile = resolve(dir, 'settings.json');
    writeFileSync(settingsFile, JSON.stringify(c[side], null, 1));
    const jsonl = resolve(dir, 'measure.jsonl');
    rmSync(jsonl, { force: true });
    const r = spawnSync(process.execPath, [resolve(here, 'template-shots.mjs'), dir, (c.themes ?? THEMES).join(','), c.states.join(','), settingsFile], {
      env: { ...env, MATRIX_OUT: jsonl },
      encoding: 'utf8',
    });
    writeFileSync(resolve(dir, 'log.txt'), `${r.stdout}\n${r.stderr}`);
    if (r.status !== 0) failures.push(`${name}/${side}: template-shots exited ${r.status} (see ${dir}/log.txt)`);
    runs[side] = load(jsonl);
  }
  for (const theme of c.themes ?? THEMES) {
    for (const state of c.states) {
      const key = `${theme}|${state}`;
      const A = runs.a.get(key);
      const B = runs.b.get(key);
      if (!A || !B) { failures.push(`${name}: ${key} not measured`); continue; }
      const sels = [...new Set([...Object.keys(A), ...Object.keys(B)])];
      const changed = sels.filter((s) => pick(A[s], c.props, s) !== pick(B[s], c.props, s));
      const ok = changed.length > 0;
      if (!ok) failures.push(`${name}: ${key} renders the same for both values`);
      console.log(`${ok ? 'OK  ' : 'SAME'} ${name.padEnd(15)} ${theme.padEnd(10)} ${state.padEnd(11)} ${changed.slice(0, 6).join(' ')}`);
    }
  }
}
if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s):\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('\nall style-driven settings change every screen in every theme');
