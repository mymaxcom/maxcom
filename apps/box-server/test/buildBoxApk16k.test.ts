import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const buildScript = join(repoRoot, 'scripts', 'android', 'build-box-apk.ps1');
const checkScript = join(repoRoot, 'scripts', 'android', 'check-elf-align.ps1');
const win = process.platform === 'win32';
const work = mkdtempSync(join(tmpdir(), 'maxcom-16k-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function ps(args: string[], timeout = 60_000) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', timeout });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// A minimal ELF64 little endian image with one PT_LOAD per given p_align (and a PT_NOTE that must be ignored).
function elf(aligns: number[]): Buffer {
  const n = aligns.length + 1;
  const b = Buffer.alloc(64 + 56 * n);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  b.writeBigUInt64LE(64n, 32);
  b.writeUInt16LE(64, 52);
  b.writeUInt16LE(56, 54);
  b.writeUInt16LE(n, 56);
  b.writeUInt32LE(4, 64); // PT_NOTE
  b.writeBigUInt64LE(8n, 64 + 48);
  aligns.forEach((a, i) => {
    const o = 64 + 56 * (i + 1);
    b.writeUInt32LE(1, o);
    b.writeBigUInt64LE(BigInt(a), o + 48);
  });
  return b;
}

describe('Play bundle: both ABIs and 16 KB pages (static)', () => {
  const build = readFileSync(buildScript, 'utf8');
  const check = readFileSync(checkScript, 'utf8');
  it('both scripts are ASCII only', () => {
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(build + check)).toBe(false);
  });
  it('the bundle needs -Abi both, checks the two ABIs and the 16 KB alignment before copying', () => {
    expect(build).toMatch(/\$PlayBundle -and \$Abi -ne 'both'/);
    expect(build).toMatch(/Test-AabAbis -Aab \$aabs\[0\]\.FullName -Want @\('armeabi-v7a', 'arm64-v8a'\)/);
    expect(build).toMatch(/Test-Apk16k -File \$aabs\[0\]\.FullName -Abi 'arm64-v8a'/);
    expect(build.indexOf('Test-Apk16k -File $aabs[0]')).toBeLessThan(build.indexOf('Copy-Item -LiteralPath $aabs[0].FullName'));
  });
  it('the arm64 APK is 16 KB checked too', () => {
    expect(build).toMatch(/if \(\$a -eq 'arm64-v8a'\) \{ \$errs \+= @\(Test-Apk16k -File \$apk/);
  });
  it('ffmpeg arm64 links with max-page-size=16384', () => {
    expect(readFileSync(join(repoRoot, 'scripts', 'android', 'build-ffmpeg-android.sh'), 'utf8')).toMatch(/arm64-v8a\)[\s\S]*ARCH_LD="-Wl,-z,max-page-size=16384"/);
  });
  it.skipIf(!win)('-PlayBundle with a single ABI is refused before anything is built', () => {
    const r = ps(['-File', buildScript, '-Abi', 'armeabi-v7a', '-PlayBundle', '-DryRun']);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/-PlayBundle perlu -Abi both/);
  });
  it.skipIf(!win)('-DryRun -PlayBundle -Abi both names the ABI and 16 KB checks', () => {
    const r = ps(['-File', buildScript, '-Abi', 'both', '-PlayBundle', '-DryRun', '-OutDir', join(work, 'dry')]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/DRYRUN 7[^\n]*armeabi-v7a, arm64-v8a[^\n]*16 KB/);
  });
});

describe.skipIf(!win)('check-elf-align.ps1', () => {
  it('passes 0x4000 and 0x10000, fails 0x1000 and lists the failing file', () => {
    const d = join(work, 'dir');
    mkdirSync(d);
    writeFileSync(join(d, 'libok.so'), elf([0x4000, 0x10000]));
    writeFileSync(join(d, 'libold.so'), elf([0x4000, 0x1000]));
    const r = ps(['-File', checkScript, '-Path', d]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/PASS p_align=0x4000 .*libok\.so/);
    expect(r.out).toMatch(/FAIL p_align=0x1000 .*libold\.so/);
  });
  it('passes a directory of aligned libraries', () => {
    const d = join(work, 'good');
    mkdirSync(d);
    writeFileSync(join(d, 'liba.so'), elf([0x10000]));
    const r = ps(['-File', checkScript, '-Path', d]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/OK: 1 perpustakaan/);
  });
  it('a non-ELF .so fails, and an empty directory fails', () => {
    const d = join(work, 'junk');
    mkdirSync(d);
    writeFileSync(join(d, 'libx.so'), 'not an elf');
    expect(ps(['-File', checkScript, '-Path', d]).status).toBe(1);
    const e = join(work, 'empty');
    mkdirSync(e);
    expect(ps(['-File', checkScript, '-Path', e]).status).toBe(1);
  });
  it('reads only the requested ABI inside an .aab and Test-AabAbis demands exactly both ABIs', () => {
    const script = join(work, 'zip.ps1');
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const make = (name: string, a32: number[], a64: number[] | null) => {
      const root = join(work, name);
      mkdirSync(join(root, 'base', 'lib', 'armeabi-v7a'), { recursive: true });
      writeFileSync(join(root, 'base', 'lib', 'armeabi-v7a', 'liba.so'), elf(a32));
      if (a64) {
        mkdirSync(join(root, 'base', 'lib', 'arm64-v8a'), { recursive: true });
        writeFileSync(join(root, 'base', 'lib', 'arm64-v8a', 'liba.so'), elf(a64));
      }
      return root;
    };
    const good = make('aabgood', [0x1000], [0x4000]);
    const bad = make('aabbad', [0x1000], [0x1000]);
    const one = make('aabone', [0x1000], null);
    writeFileSync(
      script,
      `$ErrorActionPreference = 'Stop'
. ${q(buildScript)} -LoadFunctionsOnly
Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach ($n in 'aabgood','aabbad','aabone') {
  $src = Join-Path ${q(work)} $n
  $dst = Join-Path ${q(work)} ($n + '.aab')
  $z = [System.IO.Compression.ZipFile]::Open($dst, 'Create')
  foreach ($f in Get-ChildItem -LiteralPath $src -Recurse -File) {
    $rel = $f.FullName.Substring($src.Length + 1).Replace([char]92, [char]47)
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, $f.FullName, $rel)
  }
  $z.Dispose()
}
$o = @{}
foreach ($n in 'aabgood','aabbad','aabone') {
  $f = Join-Path ${q(work)} ($n + '.aab')
  $o[$n] = @{ abis = @(Test-AabAbis -Aab $f -Want @('armeabi-v7a','arm64-v8a')); k16 = @(Test-Apk16k -File $f -Abi 'arm64-v8a') }
}
ConvertTo-Json -InputObject $o -Depth 5 | Set-Content -LiteralPath ${q(join(work, 'zip.json'))} -Encoding UTF8
`,
    );
    const r = ps(['-File', script]);
    expect(r.out).toBe('');
    expect(r.status).toBe(0);
    const j = JSON.parse(readFileSync(join(work, 'zip.json'), 'utf8').replace(/^﻿/, '')) as Record<string, { abis: string[] | string | null; k16: string[] | string | null }>;
    const list = (v: string[] | string | null | undefined): string[] => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);
    expect(list(j.aabgood?.abis)).toEqual([]);
    expect(list(j.aabgood?.k16)).toEqual([]); // the 4 KB armeabi-v7a library is not checked
    expect(list(j.aabbad?.k16).join('|')).toMatch(/16 KB: FAIL p_align=0x1000 .*arm64-v8a/);
    expect(list(j.aabone?.abis).join('|')).toMatch(/ABI tiada dalam bundle: arm64-v8a/);
  });
});
