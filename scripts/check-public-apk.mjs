#!/usr/bin/env node
// Plan 14 Task 24: the publish barrier for the public MAX Admin Client.
//
//   node scripts/check-public-apk.mjs <apk|zip|file|folder>... [--markers <file>]   public scan
//   node scripts/check-public-apk.mjs <ops.apk> --expect-ops [--markers <file>]     positive control
//   node scripts/check-public-apk.mjs --kind <apk>                                  prints ops | public
//
// Public scan: every file inside the APK (and every plain file or folder given, for
// build/web/main.dart.js) is searched for each marker in apps/surau-app/ops-markers.txt, as UTF-8
// and as UTF-16LE (Dart keeps two-byte strings as UTF-16). Any hit, or a manifest whose package id
// ends ".ops", exits 1. A missing or empty marker list exits 2: a scan with nothing to look for must
// never pass. --expect-ops is the control on a real ops APK: the package id must end ".ops" and EVERY
// marker must be found, else the scan itself is broken (exit 1).
// Output names markers and entries, never file contents.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MARKERS = resolve(HERE, '..', 'apps', 'surau-app', 'ops-markers.txt');
const OPS_ID = 'my.maxcom.app.ops';
const PUBLIC_ID = 'my.maxcom.app';
const MAX_ENTRY = 512 * 1024 * 1024;

export function parseMarkers(text) {
  return [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#')))];
}

export function loadMarkers(file) {
  if (!existsSync(file)) throw new Error(`marker list tiada: ${file}`);
  const markers = parseMarkers(readFileSync(file, 'utf8'));
  if (markers.length === 0) throw new Error(`marker list kosong: ${file}`);
  return markers;
}

const needles = (s) => [Buffer.from(s, 'utf8'), Buffer.from(s, 'utf16le')];
const hasText = (buf, s) => needles(s).some((n) => buf.includes(n));

/** Reads a zip's entries: [{ name, data }]. Stored and deflated entries only (an APK has no other). */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('bukan fail zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip rosak');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    if (usize > MAX_ENTRY) throw new Error(`entri terlalu besar: ${name}`);
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('zip rosak');
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY });
    else throw new Error(`kaedah zip tidak disokong: ${method} (${name})`);
    out.push({ name, data });
  }
  return out;
}

function isZip(buf) {
  return buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
}

function collect(path, into) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const f of readdirSync(path).sort()) collect(join(path, f), into);
    return;
  }
  const buf = readFileSync(path);
  if (isZip(buf)) for (const e of readZip(buf)) into.push({ name: `${path}!${e.name}`, inner: e.name, data: e.data, zip: path });
  else into.push({ name: path, inner: null, data: buf, zip: null });
}

/** "ops" | "public" | "unknown" from the binary AndroidManifest.xml of an APK. */
export function apkKind(apkPath) {
  const entry = readZip(readFileSync(apkPath)).find((e) => e.name === 'AndroidManifest.xml');
  if (!entry) return 'unknown';
  if (hasText(entry.data, OPS_ID)) return 'ops';
  if (hasText(entry.data, PUBLIC_ID)) return 'public';
  return 'unknown';
}

/**
 * @returns {{ hits: {marker:string, entry:string}[], found: Set<string>, kinds: Record<string,string> }}
 */
export function scan(paths, markers) {
  const files = [];
  for (const p of paths) collect(p, files);
  const hits = [];
  const found = new Set();
  const kinds = {};
  for (const f of files) {
    if (f.inner === 'AndroidManifest.xml') kinds[f.zip] = hasText(f.data, OPS_ID) ? 'ops' : hasText(f.data, PUBLIC_ID) ? 'public' : 'unknown';
    for (const m of markers) {
      if (hasText(f.data, m)) {
        hits.push({ marker: m, entry: f.name });
        found.add(m);
      }
    }
  }
  return { hits, found, kinds };
}

function main(argv) {
  const args = argv.slice(2);
  let markersFile = DEFAULT_MARKERS;
  let expectOps = false;
  let kind = false;
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--markers') markersFile = resolve(args[++i] ?? '');
    else if (args[i] === '--expect-ops') expectOps = true;
    else if (args[i] === '--kind') kind = true;
    else paths.push(resolve(args[i]));
  }
  if (paths.length === 0) {
    console.error('GAGAL: beri laluan APK atau folder.');
    return 2;
  }
  for (const p of paths) {
    if (!existsSync(p)) {
      console.error(`GAGAL: tiada: ${p}`);
      return 2;
    }
  }
  if (kind) {
    const k = apkKind(paths[0]);
    console.log(k);
    return k === 'unknown' ? 1 : 0;
  }
  let markers;
  try { markers = loadMarkers(markersFile); } catch (e) {
    console.error(`GAGAL: ${e.message}`);
    return 2;
  }
  let res;
  try { res = scan(paths, markers); } catch (e) {
    console.error(`GAGAL: ${e.message}`);
    return 2;
  }
  if (expectOps) {
    const missing = markers.filter((m) => !res.found.has(m));
    const notOps = Object.entries(res.kinds).filter(([, k]) => k !== 'ops').map(([f]) => f);
    if (Object.keys(res.kinds).length === 0) notOps.push('(tiada AndroidManifest.xml)');
    if (missing.length || notOps.length) {
      for (const m of missing) console.error(`GAGAL: penanda tiada dalam binaan ops (imbasan rosak?): ${JSON.stringify(m)}`);
      for (const f of notOps) console.error(`GAGAL: bukan pakej .ops: ${f}`);
      return 1;
    }
    console.log(`OK: binaan ops mengandungi semua ${markers.length} penanda dan id .ops.`);
    return 0;
  }
  const bad = [];
  for (const h of res.hits) bad.push(`penanda ops ${JSON.stringify(h.marker)} dalam ${h.entry}`);
  for (const [f, k] of Object.entries(res.kinds)) if (k === 'ops') bad.push(`id pakej .ops dalam ${f}`);
  if (bad.length) {
    for (const b of bad) console.error(`GAGAL: ${b}`);
    console.error('GAGAL: binaan awam mengandungi bahan ops. Jangan terbitkan.');
    return 1;
  }
  console.log(`OK: bersih (${markers.length} penanda diimbas).`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
