import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(repoRoot, 'scripts', 'android', 'build-box-apk.ps1');
const releaseScript = join(repoRoot, 'scripts', 'build-release.ps1');
const win = process.platform === 'win32';
const versions = JSON.parse(readFileSync(join(repoRoot, 'versions.json'), 'utf8')) as Record<string, string>;
const apkVersion = versions['kiosk-server-android'];
const winVersion = versions['kiosk-server-windows'];

const work = mkdtempSync(join(tmpdir(), 'maxcom-bapk-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function ps(args: string[], timeout = 60_000) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', timeout });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('build-box-apk.ps1 (static)', () => {
  const text = readFileSync(script, 'utf8');
  it('is ASCII only and has no em dash', () => {
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(text)).toBe(false);
  });
  it('downloads nothing and evaluates no strings', () => {
    expect(text).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|DownloadFile|Start-BitsTransfer|Invoke-Expression|\biex\b/);
  });
  it('calls external programs with argument arrays, never a joined command string', () => {
    expect(text).toMatch(/& \$psExe @brArgs/);
    expect(text).toMatch(/gradlew\.bat'\) ":app:\$task"/);
    expect(text).not.toMatch(/cmd(\.exe)?\s+\/c/i);
  });
  it('pins the Gradle wrapper, keeps the tgz asset stored and caps N at 99 in Gradle', () => {
    const android = join(repoRoot, 'apps', 'box-android');
    const props = readFileSync(join(android, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf8');
    expect(props).toMatch(/^distributionSha256Sum=[0-9a-f]{64}$/m);
    const gradle = readFileSync(join(android, 'app', 'build.gradle.kts'), 'utf8');
    expect(gradle).toMatch(/noCompress \+= listOf\("gz", "tgz"\)/);
    expect(gradle).toContain(String.raw`(\d{1,2})\.(\d{1,2})$`);
    const svc = readFileSync(join(android, 'app', 'src', 'main', 'kotlin', 'my', 'maxcom', 'box', 'BoxService.kt'), 'utf8');
    expect(svc).toContain(String.raw`[0-9]{1,2}\\.[0-9]{1,2})-android`);
  });
  it('refuses a release build without key.properties and never falls back to the debug key', () => {
    expect(text).toContain('key.properties tiada');
    expect(text).toContain('signingCertSha256 belum diisi');
  });
});

describe.runIf(win)('build-box-apk.ps1 (run)', () => {
  it('takes the version from versions.json (kiosk-server-android) and refuses another one', () => {
    const text = readFileSync(script, 'utf8');
    expect(text).toContain("Resolve-ProductVersion 'kiosk-server-android'");
    expect(text).toMatch(/--check --key \$Key/);
    const r = ps(['-File', script, '-Version', '2030.01.9', '-DryRun']);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/GAGAL: -Version 2030\.01\.9 tidak sama dengan versions\.json kiosk-server-android/);
    const d = ps(['-File', script, '-DryRun', '-OutDir', join(work, 'dflt')]);
    expect(d.status).toBe(0);
    expect(d.out).toContain(`-PboxVersion=${apkVersion}`);
  });
  it('rejects a malformed version', () => {
    const r = ps(['-File', script, '-Version', '1.2.3']);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('YYYY.MM.N');
  });
  it('rejects a release number above 99 (the version code would collide) and accepts 99', () => {
    const over = ps(['-File', script, '-Version', '2026.11.100', '-DryRun']);
    expect(over.status).not.toBe(0);
    expect(over.out).toContain('99');
    const ok = ps(['-File', script, '-Version', '2026.11.99', '-DryRun', '-OutDir', join(work, 'cap99')]);
    expect(ok.out).not.toContain('mesti berbentuk');
  });
  it('-DryRun prints the six steps and writes nothing', () => {
    const out = join(work, 'dryout');
    const r = ps(['-File', script, '-Version', apkVersion, '-DryRun', '-OutDir', out]);
    expect(r.status).toBe(0);
    for (const n of [1, 2, 3, 4, 5, 6]) expect(r.out).toContain(`DRYRUN ${n} `);
    expect(existsSync(out)).toBe(false);
  });
  it('build-release -Platform android -DryRun names the android archive; windows stays the default; linux is refused', () => {
    const a = ps(['-File', releaseScript, '-Version', apkVersion, '-Platform', 'android', '-DryRun']);
    expect(a.status).toBe(0);
    expect(a.out).toContain(`maxcom-box-${apkVersion}-android.tar.gz`);
    expect(a.out).not.toContain('ensure-live-firewall.ps1');
    const w = ps(['-File', releaseScript, '-Version', winVersion, '-DryRun']);
    expect(w.status).toBe(0);
    expect(w.out).toContain(`maxcom-box-${winVersion}-windows.tar.gz`);
    expect(w.out).toContain('ensure-live-firewall.ps1');
    const l = ps(['-File', releaseScript, '-Version', winVersion, '-Platform', 'linux', '-DryRun']);
    expect(l.status).not.toBe(0);
  });
  it('a debug build with the dev port listening is refused by build-release (nothing built)', async () => {
    const net = await import('node:net');
    const srv = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as import('node:net').AddressInfo).port;
    try {
      const r = await new Promise<{ status: number | null; out: string }>((resolve) => {
        import('node:child_process').then(({ spawn }) => {
          const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Version', apkVersion, '-Debug', '-SkipFetch', '-DevPorts', String(port)]);
          let out = '';
          p.stdout.on('data', (d) => (out += d));
          p.stderr.on('data', (d) => (out += d));
          p.on('close', (c) => resolve({ status: c, out }));
        });
      });
      expect(r.status).not.toBe(0);
      expect(r.out).toContain('sedang berjalan');
    } finally {
      srv.close();
    }
  }, 120_000);

  // The verification functions are loaded with -LoadFunctionsOnly and run against zips made here.
  describe('Test-ApkIntegrity / Test-ApkSigner', () => {
    const libA = 'lib-a-bytes';
    const libB = 'lib-b-bytes';
    const archive = 'archive-bytes';
    const archiveSha = sha(archive);
    const cases = join(work, 'cases.ps1');
    const result = join(work, 'cases.json');
    let res: Record<string, string[]>;

    it('runs all cases', () => {
      const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
      writeFileSync(
        cases,
        `
$ErrorActionPreference = 'Stop'
. ${q(script)} -LoadFunctionsOnly
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$dir = ${q(work)}
function Make-Zip([string]$name, $entries) {
  $p = Join-Path $dir $name
  if (Test-Path $p) { Remove-Item $p }
  $z = [System.IO.Compression.ZipFile]::Open($p, 'Create')
  foreach ($k in $entries.Keys) {
    $e = $z.CreateEntry($k)
    $w = New-Object System.IO.StreamWriter($e.Open(), (New-Object System.Text.UTF8Encoding($false)))
    $w.Write($entries[$k]); $w.Dispose()
  }
  $z.Dispose()
  return $p
}
$man = @(
  [pscustomobject]@{ apk = 'liba.so'; sha256 = ${q(sha(libA))} },
  [pscustomobject]@{ apk = 'libb.so'; sha256 = ${q(sha(libB))} }
)
function Base() { return [ordered]@{ 'lib/armeabi-v7a/liba.so' = ${q(libA)}; 'lib/armeabi-v7a/libb.so' = ${q(libB)}; 'assets/box/maxcom-box-2026.11.1-android.tar.gz' = ${q(archive)}; 'assets/box/release.sha256' = ${q(archiveSha + '\n')} } }
function Run($zip) { return @(Test-ApkIntegrity -Apk $zip -Abi 'armeabi-v7a' -Manifest $man -ArchiveName 'maxcom-box-2026.11.1-android.tar.gz' -ArchiveSha256 ${q(archiveSha)}) }
$out = [ordered]@{}
$out.good = Run (Make-Zip 'good.apk' (Base))
$e = Base; $e['lib/armeabi-v7a/liba.so'] = 'lib-a-byteX'
$out.changedByte = Run (Make-Zip 'changed.apk' $e)
$e = Base; $e['lib/armeabi-v7a/libextra.so'] = 'x'
$out.extraSo = Run (Make-Zip 'extra.apk' $e)
$e = Base; $e['lib/arm64-v8a/liba.so'] = ${q(libA)}
$out.secondAbi = Run (Make-Zip 'abi2.apk' $e)
$e = Base; $e.Remove('lib/armeabi-v7a/libb.so')
$out.missingSo = Run (Make-Zip 'missing.apk' $e)
$e = Base; $e['assets/box/maxcom-box-2026.11.1-android.tar.gz'] = 'other-archive'
$out.wrongArchive = Run (Make-Zip 'wrongarch.apk' $e)
$e = Base; $e['assets/box/release.sha256'] = ('0' * 64) + [char]10
$out.wrongReleaseSha = Run (Make-Zip 'wrongsha.apk' $e)
$out.emptyPin = @(Test-ApkSigner -Apk 'x.apk' -Pin '' -Release $true -ApkSignerJar 'x' -Java 'x')
$out.badPin = @(Test-ApkSigner -Apk 'x.apk' -Pin 'zz' -Release $true -ApkSignerJar 'x' -Java 'x')
ConvertTo-Json -InputObject $out -Depth 4 | Set-Content -LiteralPath ${q(result)} -Encoding UTF8
`,
        'utf8',
      );
      const r = ps(['-File', cases], 120_000);
      expect(r.status, r.out).toBe(0);
      res = JSON.parse(readFileSync(result, 'utf8').replace(/^﻿/, ''));
      for (const k of Object.keys(res)) if (!Array.isArray(res[k])) res[k] = res[k] == null ? [] : [res[k] as unknown as string];
    });
    it('passes a faithful APK', () => expect(res.good).toEqual([]));
    it('fails on a changed byte', () => expect(res.changedByte.join('|')).toMatch(/sha256 berubah untuk lib\/armeabi-v7a\/liba\.so/));
    it('fails on an extra .so not in the manifest', () => expect(res.extraSo.join('|')).toMatch(/libextra\.so/));
    it('fails on an entry under a second ABI', () => expect(res.secondAbi.join('|')).toMatch(/ABI kedua.*arm64-v8a/));
    it('fails when a manifest file is missing from the APK', () => expect(res.missingSo.join('|')).toMatch(/libb\.so/));
    it('fails when the bundled archive differs', () => expect(res.wrongArchive.join('|')).toMatch(/arkib dalam APK tidak sama/));
    it('fails when release.sha256 differs', () => expect(res.wrongReleaseSha.join('|')).toMatch(/release\.sha256 tidak sama/));
    it('an empty signer pin fails with the BM message', () => expect(res.emptyPin).toEqual(['signingCertSha256 belum diisi']));
    it('a malformed signer pin fails', () => expect(res.badPin.join('|')).toMatch(/tidak sah/));
  });
});
