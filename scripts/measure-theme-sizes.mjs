// Measures how big the built-in themes draw the elements an uploaded theme must never shrink (the clock, the prayer
// times, the countdowns, the next-prayer chip, the logo), and writes the table the kiosk's health check compares with.
//
//   node scripts/measure-theme-sizes.mjs
//
// It runs scripts/template-shots.mjs (same dev server and fixtures) for every built-in theme and every state at both
// sizes (1920x1080@1 and 960x540@2). Sizes are in rem, so the two must agree to 0.01 rem or the script fails. The result is
// apps/kiosk-display/src/themes/minSizes.json: { [theme]: { [screen]: { [role]: rem } } }, per element role the LARGEST
// visible element of that role (the one a reader sees), the smallest value when several states show the same screen.
// Regenerate when layouts change (themes plan D).

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROLES = ['clock', 'prayers', 'countdown', 'next', 'logo'];

/** The hook template-shots.mjs calls after each screenshot: appends what the stage draws to $MEASURE_OUT. */
export default async function measure({ page, template, stateName }) {
  const seen = await page.evaluate((roles) => {
    const stage = document.querySelector('.stage');
    if (!stage) return null;
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const out = {};
    for (const el of stage.querySelectorAll('[data-role]')) {
      const role = el.getAttribute('data-role');
      if (!roles.includes(role) || el.parentElement?.closest("[aria-hidden='true']")) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const rem = role === 'logo' ? r.height / root : (parseFloat(getComputedStyle(el).fontSize) || 0) / root;
      out[role] = Math.max(out[role] ?? 0, rem);
    }
    return { screen: stage.getAttribute('data-screen'), roles: out };
  }, ROLES);
  if (seen && seen.screen) appendFileSync(process.env.MEASURE_OUT, `${JSON.stringify({ template, stateName, ...seen })}\n`);
}

/** Records to { [theme]: { [screen]: { [role]: rem } } }: the smallest of the states that show one screen, 3 decimals. */
export function buildTable(records) {
  const table = {};
  for (const r of records) {
    const t = (table[r.template] ??= {});
    const s = (t[r.screen] ??= {});
    for (const [role, rem] of Object.entries(r.roles)) s[role] = s[role] === undefined ? rem : Math.min(s[role], rem);
  }
  // `biasa` (the prayer screen with no card) has no state of its own in the fixtures; its prayer layer is the one of `kuliah`.
  for (const t of Object.values(table)) if (t.kuliah && !t.biasa) t.biasa = { ...t.kuliah };
  for (const t of Object.values(table)) for (const s of Object.values(t)) for (const k of Object.keys(s)) s[k] = Math.round(s[k] * 1000) / 1000;
  return table;
}

/** Every difference larger than `tol` rem (or a key present in one table only), as readable lines. */
export function tableDiffs(a, b, tol = 0.01) {
  const out = [];
  const keys = (o) => Object.keys(o ?? {});
  for (const t of new Set([...keys(a), ...keys(b)])) {
    for (const s of new Set([...keys(a[t]), ...keys(b[t])])) {
      for (const k of new Set([...keys(a[t]?.[s]), ...keys(b[t]?.[s])])) {
        const x = a[t]?.[s]?.[k];
        const y = b[t]?.[s]?.[k];
        if (x === undefined || y === undefined) out.push(`${t}/${s}/${k}: ${x ?? 'missing'} vs ${y ?? 'missing'}`);
        else if (Math.abs(x - y) > tol) out.push(`${t}/${s}/${k}: ${x} vs ${y}`);
      }
    }
  }
  return out;
}

function run(size) {
  const dir = mkdtempSync(join(tmpdir(), 'maxcom-sizes-'));
  const jsonl = join(dir, 'measure.jsonl');
  writeFileSync(jsonl, '');
  const r = spawnSync(process.execPath, [resolve(here, 'template-shots.mjs'), join(dir, 'shots')], {
    env: { ...process.env, SHOT_SIZE: size, MEASURE_MODULE: fileURLToPath(import.meta.url), MEASURE_OUT: jsonl },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.status !== 0) throw new Error(`template-shots failed at ${size} (exit ${r.status})`);
  const records = readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  rmSync(dir, { recursive: true, force: true });
  return buildTable(records);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const big = run('1920x1080@1');
  const small = run('960x540@2');
  const diffs = tableDiffs(big, small);
  if (diffs.length > 0) {
    console.error(`The two sizes disagree by more than 0.01 rem:\n${diffs.join('\n')}`);
    process.exit(1);
  }
  const out = resolve(here, '../apps/kiosk-display/src/themes/minSizes.json');
  if (!existsSync(dirname(out))) throw new Error('kiosk themes folder not found');
  writeFileSync(out, `${JSON.stringify(big, null, 2)}\n`);
  const cells = Object.values(big).reduce((n, t) => n + Object.values(t).reduce((m, s) => m + Object.keys(s).length, 0), 0);
  console.log(`wrote ${out} (${Object.keys(big).length} themes, ${cells} measured elements)`);
}
