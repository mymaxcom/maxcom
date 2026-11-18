// Plan 14 Task 24: scripts/check-public-apk.mjs, the publish barrier. Fixture zips are built here
// (no zip library), so the scanner's own zip reader and both text encodings are exercised.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';

const repoRoot = resolve(__dirname, '..', '..', '..');
const script = join(repoRoot, 'scripts', 'check-public-apk.mjs');

function crc32(b: Buffer): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function makeZip(entries: Record<string, Buffer>, deflate = false): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let off = 0;
  for (const [name, data] of Object.entries(entries)) {
    const n = Buffer.from(name);
    const body = deflate ? deflateRawSync(data) : data;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc32(data), 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc32(data), 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, n, body);
    centrals.push(ch, n);
    off += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

function run(args: string[]) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

describe('check-public-apk.mjs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpa-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const markers = join(dir, 'markers.txt');
  writeFileSync(markers, '# c\nsuperadmin-badge\n\nAnda Pentadbir MAXCOM\n');
  const manifest = (id: string) => Buffer.from(`xx${id}.files`, 'utf16le');
  const so = (extra: Buffer) => Buffer.concat([Buffer.from('libapp-prefix'), extra, Buffer.from('suffix')]);
  const lib = 'lib/arm64-v8a/libapp.so';
  const clean = join(dir, 'clean.apk');
  const dirty8 = join(dir, 'dirty8.apk');
  const dirty16 = join(dir, 'dirty16.apk');
  const opsApk = join(dir, 'ops.apk');
  const opsId = join(dir, 'opsid.apk');
  writeFileSync(clean, makeZip({ 'AndroidManifest.xml': manifest('my.maxcom.app'), [lib]: so(Buffer.from('nothing')) }));
  writeFileSync(dirty8, makeZip({ 'AndroidManifest.xml': manifest('my.maxcom.app'), [lib]: so(Buffer.from('superadmin-badge')) }));
  writeFileSync(
    dirty16,
    makeZip({ 'AndroidManifest.xml': manifest('my.maxcom.app'), [lib]: so(Buffer.from('Anda Pentadbir MAXCOM', 'utf16le')) }, true),
  );
  writeFileSync(
    opsApk,
    makeZip({
      'AndroidManifest.xml': manifest('my.maxcom.app.ops'),
      [lib]: so(Buffer.concat([Buffer.from('superadmin-badge'), Buffer.from('Anda Pentadbir MAXCOM', 'utf16le')])),
    }),
  );
  writeFileSync(opsId, makeZip({ 'AndroidManifest.xml': manifest('my.maxcom.app.ops'), 'a.bin': Buffer.from('nothing') }));

  it('passes a clean public APK', () => {
    const r = run([clean, '--markers', markers]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('OK');
  });
  it('fails on a UTF-8 marker in libapp.so and names the entry, not the content', () => {
    const r = run([dirty8, '--markers', markers]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('superadmin-badge');
    expect(r.out).toContain(lib);
    expect(r.out).not.toContain('libapp-prefix');
  });
  it('fails on a UTF-16 marker inside a deflated entry', () => {
    const r = run([dirty16, '--markers', markers]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Anda Pentadbir MAXCOM');
  });
  it('fails at once on a package id ending .ops, with no marker present', () => {
    const r = run([opsId, '--markers', markers]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('.ops');
  });
  it('scans a plain main.dart.js file and a folder', () => {
    const jsDir = mkdtempSync(join(tmpdir(), 'cpajs-'));
    try {
      const js = join(jsDir, 'main.dart.js');
      writeFileSync(js, 'var a="lanjutan";var k="superadmin-badge";');
      expect(run([js, '--markers', markers]).code).toBe(1);
      expect(run([jsDir, '--markers', markers]).code).toBe(1);
      writeFileSync(js, 'var a="nothing";');
      expect(run([js, '--markers', markers]).code).toBe(0);
      expect(run([jsDir, '--markers', markers]).code).toBe(0);
    } finally {
      rmSync(jsDir, { recursive: true, force: true });
    }
  });
  it('refuses a missing or empty marker list (exit 2), never a pass', () => {
    expect(run([clean, '--markers', join(dir, 'nope.txt')]).code).toBe(2);
    const empty = join(dir, 'empty.txt');
    writeFileSync(empty, '# only a comment\n\n');
    expect(run([clean, '--markers', empty]).code).toBe(2);
  });
  it('positive control: the ops APK has every marker and a .ops id; a public or partial APK fails', () => {
    expect(run([opsApk, '--expect-ops', '--markers', markers]).code).toBe(0);
    expect(run([clean, '--expect-ops', '--markers', markers]).code).toBe(1);
    expect(run([opsId, '--expect-ops', '--markers', markers]).code).toBe(1);
  });
  it('--kind reads the package kind from the manifest', () => {
    expect(run(['--kind', clean]).out.trim()).toBe('public');
    expect(run(['--kind', opsApk]).out.trim()).toBe('ops');
  });
  it('the shipped ops-markers.txt is non-empty', () => {
    const t = readFileSync(join(repoRoot, 'apps', 'surau-app', 'ops-markers.txt'), 'utf8');
    const lines = t.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.startsWith('#'));
    expect(lines).toContain('superadmin-badge');
  });
});

describe.skipIf(process.platform !== 'win32')('publish-installers.ps1', () => {
  const pub = join(repoRoot, 'scripts', 'publish-installers.ps1');
  const dir = mkdtempSync(join(tmpdir(), 'pubi-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'MAXCOM-Installers');
  const man = (id: string) => Buffer.from(`xx${id}.files`, 'utf16le');
  const mk = (id: string, extra: string) => makeZip({ 'AndroidManifest.xml': man(id), 'a.bin': Buffer.from(extra) });
  const ok = join(dir, 'MAX-Admin-Client-1-arm64-v8a.apk');
  const dirty = join(dir, 'dirty.apk');
  const opsApk = join(dir, 'x.apk');
  const named = join(dir, 'MAXCOM-Ops-1-arm64-v8a.apk');
  writeFileSync(ok, mk('my.maxcom.app', 'nothing'));
  writeFileSync(dirty, mk('my.maxcom.app', 'lanjutan-card'));
  writeFileSync(opsApk, mk('my.maxcom.app.ops', 'nothing'));
  writeFileSync(named, mk('my.maxcom.app', 'nothing'));
  const sec = join(dir, 'secret', 'ops-builds');
  mkdirSync(sec, { recursive: true });
  writeFileSync(join(sec, 'a.apk'), mk('my.maxcom.app', 'nothing'));
  const ps = (file: string, dest: string) => {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', pub, '-File', file, '-DestDir', dest, '-InstallersRoot', root], { encoding: 'utf8' });
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
  };
  it('copies a clean public APK under the root', () => {
    const r = ps(ok, join(root, 'p', '1'));
    expect(r.code).toBe(0);
    expect(existsSync(join(root, 'p', '1', 'MAX-Admin-Client-1-arm64-v8a.apk'))).toBe(true);
  });
  it('refuses a marker hit, a .ops package, an ops name, a secret path and a destination outside the root; copies nothing', () => {
    for (const f of [dirty, opsApk, named, join(sec, 'a.apk')]) {
      const r = ps(f, join(root, 'q'));
      expect(r.code).toBe(1);
    }
    expect(existsSync(join(root, 'q'))).toBe(false);
    expect(ps(ok, join(dir, 'elsewhere')).code).toBe(1);
    expect(existsSync(join(dir, 'elsewhere'))).toBe(false);
  });
});
