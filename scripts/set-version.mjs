#!/usr/bin/env node
// MAXCOM: one place for every product's release version.
//
//   node scripts/set-version.mjs <key> <YYYY.MM.N>   bump one product (never lower than its current version)
//   node scripts/set-version.mjs --check             exit 1 and list every file that disagrees with versions.json
//   node scripts/set-version.mjs --check --key <key> the same, for one product only (the build scripts use this)
//   --root <dir>                                     another checkout (default: the parent of this scripts folder)
//
// versions.json (repo root) is the source of truth: { "<product>-<platform>": "YYYY.MM.N", ... }.
// Every product starts at the same version and is bumped on its own.
//
// TO ADD A PRODUCT: add one entry to versions.json and ONE ROW to PRODUCTS below. Unknown keys are refused.
//
// NOT tied to any product: the "version" fields of apps/box-server, apps/kiosk-display and packages/* (and their
// package-lock.json entries). They are set to 2026.11.2 and nothing checks them any more: the Windows and the
// Android server share one source tree but carry different versions, which the build stamps into release.json
// (read by the box server as its own version). The cloud deploy has no key yet.

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION_RE = /^20[0-9]{2}\.(0[1-9]|1[0-2])\.([1-9]|[1-9][0-9])$/;

/** Flutter build number for YYYY.MM.N: (YY*10000 + MM*100 + N) * 10; always above the old "+1". */
export function pubspecCode(version) {
  const m = /^20([0-9]{2})\.([0-9]{2})\.([0-9]{1,2})$/.exec(version);
  if (!m) throw new Error(`bad version ${version}`);
  return (Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3])) * 10;
}

const PUBSPEC = 'apps/surau-app/pubspec.yaml';
const APP_VERSION_DART = 'apps/surau-app/lib/app/app_version.dart';
const DART_DEFAULT = /(defaultValue:[ \t]*')([^'\r\n]*)(')/;
const PUBSPEC_LINE = /^version:[ \t]*([^\s+]+)\+([0-9]+)[ \t]*(?=\r?$)/m;

/**
 * The single key table. `files` lists every in-repo file that carries the product's version:
 *   read(text) -> the version the file holds (or null), write(text, version) -> the new text.
 * A product with no file (the two server products) is carried by its build script only.
 */
export const PRODUCTS = {
  'kiosk-server-windows': {
    label: 'MAX Kiosk Server for Windows',
    files: [],
  },
  'kiosk-server-android': {
    label: 'MAX Kiosk Server for Android',
    files: [],
  },
  'admin-client-android': {
    label: 'MAX Admin Client for Android',
    files: [
      {
        path: PUBSPEC,
        read: (t) => {
          const m = PUBSPEC_LINE.exec(t);
          return m ? `${m[1]}+${m[2]}` : null;
        },
        expected: (v) => `${v}+${pubspecCode(v)}`,
        write: (t, v) => {
          if (!PUBSPEC_LINE.test(t)) throw new Error(`${PUBSPEC}: no "version:" line`);
          return t.replace(PUBSPEC_LINE, `version: ${v}+${pubspecCode(v)}`);
        },
      },
      {
        // the compile-time default of MAXCOM_VERSION (a build without --dart-define shows it)
        path: APP_VERSION_DART,
        read: (t) => {
          const m = DART_DEFAULT.exec(t);
          return m ? m[2] : null;
        },
        write: (t, v) => {
          if (!DART_DEFAULT.test(t)) throw new Error(`${APP_VERSION_DART}: no defaultValue literal`);
          return t.replace(DART_DEFAULT, (_all, a, _old, c) => `${a}${v}${c}`);
        },
      },
    ],
  },
};

function fail(msg) {
  process.stderr.write(`GAGAL: ${msg}\n`);
  process.exit(1);
}

function cmp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

function loadVersions(root) {
  const file = join(root, 'versions.json');
  if (!existsSync(file)) fail(`versions.json tiada di ${root}`);
  let obj;
  try {
    obj = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fail('versions.json bukan JSON yang sah');
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) fail('versions.json mesti objek');
  return { file, obj };
}

/** Write temp + rename, so a crash never leaves a half-written file. */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw e;
  }
}

function writeVersions(file, obj) {
  writeAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);
}

/** Problems for the products (all, or one key): [] when versions.json and every file agree. */
export function checkVersions(root, onlyKey = null) {
  const problems = [];
  const { obj } = loadVersions(root);
  for (const k of Object.keys(obj)) if (!(k in PRODUCTS)) problems.push(`versions.json: kunci tidak dikenali "${k}"`);
  const keys = onlyKey === null ? Object.keys(PRODUCTS) : [onlyKey];
  for (const key of keys) {
    if (!(key in PRODUCTS)) {
      problems.push(`kunci tidak dikenali "${key}"`);
      continue;
    }
    const v = obj[key];
    if (typeof v !== 'string' || !VERSION_RE.test(v)) {
      problems.push(`versions.json: ${key} tiada atau bukan YYYY.MM.N (${JSON.stringify(v)})`);
      continue;
    }
    for (const f of PRODUCTS[key].files) {
      const p = join(root, ...f.path.split('/'));
      if (!existsSync(p)) {
        problems.push(`${f.path}: fail tiada (${key})`);
        continue;
      }
      const have = f.read(readFileSync(p, 'utf8'));
      const want = f.expected ? f.expected(v) : v;
      if (have !== want) problems.push(`${f.path}: ${have === null ? 'tiada versi' : have}, sepatutnya ${want} (${key})`);
    }
  }
  return problems;
}

function main(argv) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const rest = [];
  let check = false;
  let key = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') check = true;
    else if (a === '--root') root = resolve(argv[++i] ?? fail('--root perlukan folder'));
    else if (a === '--key') key = argv[++i] ?? fail('--key perlukan kunci');
    else if (a.startsWith('--')) fail(`pilihan tidak dikenali ${a}`);
    else rest.push(a);
  }

  if (check) {
    if (rest.length > 0) fail('--check tidak menerima hujah lain');
    const problems = checkVersions(root, key);
    if (problems.length > 0) {
      process.stdout.write(`GAGAL: versi tidak sepadan dengan versions.json:\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
      process.exit(1);
    }
    process.stdout.write('versi sepadan dengan versions.json\n');
    return;
  }

  if (key !== null || rest.length !== 2) fail('guna: node scripts/set-version.mjs <kunci> <YYYY.MM.N>  atau  --check');
  const [k, version] = rest;
  if (!(k in PRODUCTS)) fail(`kunci tidak dikenali "${k}" (ada: ${Object.keys(PRODUCTS).join(', ')})`);
  if (!VERSION_RE.test(version)) fail(`versi mesti berbentuk YYYY.MM.N dengan N antara 1 dan 99, diberi: ${version}`);
  const { file, obj } = loadVersions(root);
  const cur = obj[k];
  if (typeof cur !== 'string' || !VERSION_RE.test(cur)) fail(`versions.json: ${k} tiada atau tidak sah`);
  if (cmp(version, cur) < 0) fail(`${k}: ${version} lebih rendah daripada versi semasa ${cur}`);

  // read every file first so a missing one stops the bump before anything is written
  const edits = [];
  for (const f of PRODUCTS[k].files) {
    const p = join(root, ...f.path.split('/'));
    if (!existsSync(p)) fail(`${f.path} tiada`);
    edits.push({ p, text: f.write(readFileSync(p, 'utf8'), version) });
  }
  // product files first, versions.json LAST; each write is atomic
  for (const e of edits) writeAtomic(e.p, e.text);
  obj[k] = version;
  writeVersions(file, obj);
  process.stdout.write(`${k}: ${cur} -> ${version}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
