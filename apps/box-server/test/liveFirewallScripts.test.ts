import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ensure = fileURLToPath(new URL('../../../scripts/ensure-live-firewall.ps1', import.meta.url));
const install = fileURLToPath(new URL('../../../scripts/install-live-tools.ps1', import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-live-src-'));
  dirs.push(d);
  return d;
}

describe('ensure-live-firewall.ps1 (static)', () => {
  const text = readFileSync(ensure, 'utf8');

  it('is ASCII only (PowerShell 5.1 reads BOM-less files as ANSI)', () => {
    for (const ch of text) expect(ch.charCodeAt(0)).toBeLessThan(128);
  });

  it('keeps exactly two UDP rules, every profile, local subnet only, no TCP and no other port', () => {
    expect(text).toContain('MAXCOM Live WebRTC');
    expect(text).toContain('MAXCOM Live SRT');
    expect(text).toMatch(/\[int\]\$WebrtcPort\s*=\s*8189/);
    expect(text).toMatch(/\[int\]\$SrtPort\s*=\s*8890/);
    expect(text).not.toMatch(/protocol=tcp/i);
    const adds = text.split('\n').filter((l) => /add rule/.test(l));
    expect(adds.length).toBe(1);
    expect(adds[0]).toMatch(/dir=in action=allow protocol=udp localport=\$Port profile=any remoteip=localsubnet/);
    expect(text).not.toMatch(/profile=(private|public|domain)/i);
    // the only port numbers in the file are the two defaults
    const ports = (text.match(/\b\d{4,5}\b/g) ?? []).filter((n) => n !== '8189' && n !== '8890');
    expect(ports).toEqual([]);
  });

  it('refuses to run without administrator rights, with a clear message and a non-zero exit', () => {
    const check = text.indexOf('IsInRole');
    expect(check).toBeGreaterThan(-1);
    const gate = text.indexOf('exit 1', check);
    expect(gate).toBeGreaterThan(check);
    expect(text.slice(check, gate)).toMatch(/elevated PowerShell/);
    // nothing is changed before the check
    expect(text.indexOf('delete rule')).toBeGreaterThan(gate);
    expect(text.indexOf('add rule')).toBeGreaterThan(gate);
  });

  it('only writes the firewall: no files, no registry, no tasks', () => {
    expect(text).not.toMatch(/Set-Content|Out-File|Add-Content|New-Item|Remove-Item|Set-ItemProperty|Register-ScheduledTask/);
  });

  it('skips a rule that is already exactly right, and deletes by name before adding', () => {
    expect(text).toMatch(/show rule name=/);
    expect(text).toMatch(/delete rule name=/);
  });
});

describe.runIf(process.platform === 'win32')('ensure-live-firewall.ps1 (run)', () => {
  const elevated = spawnSync('net', ['session'], { encoding: 'utf8' }).status === 0;
  it.runIf(!elevated)('without administrator rights it exits non-zero and says what to do', () => {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ensure], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('elevated PowerShell');
  });
});

describe('install-live-tools.ps1 boot task (static)', () => {
  const text = readFileSync(install, 'utf8');

  it('registers the MAXCOM Live Firewall task as SYSTEM, at startup, highest privileges', () => {
    expect(text).toContain("'MAXCOM Live Firewall'");
    expect(text).toMatch(/New-ScheduledTaskTrigger -AtStartup/);
    expect(text).toMatch(/New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest/);
    expect(text).toMatch(/Register-ScheduledTask -TaskName \$taskName/);
    // it runs the ensure script, not an inline netsh
    expect(text).toMatch(/-File "\{0\}"/);
    expect(text).toContain('ensure-live-firewall.ps1');
  });

  it('only registers the task when elevated and not -SkipFirewall, and refuses a script folder others can write', () => {
    const reg = text.indexOf('Register-ScheduledTask');
    expect(reg).toBeGreaterThan(-1);
    expect(text.lastIndexOf('elseif ($admin)', reg)).toBeGreaterThan(-1);
    expect(text).toMatch(/Get-UntrustedWriters/);
    expect(text.indexOf('Get-UntrustedWriters', text.indexOf('function Get-UntrustedWriters') + 10)).toBeLessThan(reg);
  });

  it('adds no TCP rule and no port beyond the two UDP ones', () => {
    expect(text).not.toMatch(/protocol=tcp/i);
    const ports = (text.match(/\b\d{4,5}\b/g) ?? []).filter((n) => !['8189', '8890'].includes(n));
    expect(ports).toEqual([]);
  });

  it('the SYSTEM task runs an admin-only copy under ProgramData, never the repo script the installing user can write', () => {
    expect(text).toMatch(/\$secureDir\s*=\s*Join-Path \$env:ProgramData 'MAXCOM'/);
    expect(text).toMatch(/\$secureScript\s*=\s*Join-Path \$secureDir 'ensure-live-firewall\.ps1'/);
    // a repeat run refreshes the copy
    expect(text).toMatch(/Copy-Item -Force \$ensureScript \$secureScript/);
    // folder ACL: inheritance off, only Administrators and SYSTEM
    expect(text).toMatch(/SetAccessRuleProtection\(\$true, \$false\)/);
    expect(text).toMatch(/S-1-5-18/);
    expect(text).toMatch(/S-1-5-32-544/);
    // no current-user trust any more
    expect(text).not.toMatch(/\$meSid/);
    expect(text).not.toMatch(/WindowsIdentity\]::GetCurrent\(\)\.User/);
    // the ACL is verified after it is set; a failed check stops the task registration with a warning
    const setAcl = text.indexOf('SetAccessRuleProtection');
    const verify = text.indexOf('Get-UntrustedWriters $secureDir');
    const reg = text.indexOf('Register-ScheduledTask');
    expect(setAcl).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(setAcl);
    expect(reg).toBeGreaterThan(verify);
    expect(text).toMatch(/Boot task NOT registered/);
    // the repo scripts folder is no longer what is checked
    expect(text).not.toMatch(/Get-UntrustedWriters \$PSScriptRoot/);
  });

  it('the task action is an absolute powershell.exe running the ProgramData copy with WorkingDirectory ProgramData', () => {
    const action = text.split('\n').find((l) => l.includes('New-ScheduledTaskAction')) ?? '';
    expect(action).toMatch(/-Execute \$psExe/);
    expect(text).toMatch(/\$psExe\s*=\s*Join-Path \$env:SystemRoot 'System32\\WindowsPowerShell\\v1\.0\\powershell\.exe'/);
    expect(action).toMatch(/-WorkingDirectory \$secureDir/);
    const arg = text.split('\n').find((l) => l.includes('$taskArg =')) ?? '';
    expect(arg).toMatch(/-File "\{0\}"/);
    expect(arg).toMatch(/-f \$secureScript/);
    expect(text).not.toMatch(/-Execute 'powershell\.exe'/);
  });

  it('is ASCII only', () => {
    for (const ch of text) expect(ch.charCodeAt(0)).toBeLessThan(128);
  });
});

describe('install-live-tools.ps1 -SourceDir (static)', () => {
  const text = readFileSync(install, 'utf8');

  it('takes both zips from the bundle folder and never downloads in that branch', () => {
    expect(text).toMatch(/\[string\]\$SourceDir\s*=\s*''/);
    expect(text).toContain('mediamtx_${MediamtxVersion}_windows_amd64.zip');
    expect(text).toContain('([Uri]$FfmpegUrl).Segments[-1]');
    const bundleAt = text.indexOf('$mtxZip = Get-BundleFile $mtxSource');
    expect(bundleAt).toBeGreaterThan(-1);
    const elseAt = text.indexOf('} else {', bundleAt);
    expect(elseAt).toBeGreaterThan(bundleAt);
    const bundlePart = text.slice(bundleAt, elseAt);
    expect(bundlePart).toContain('$ffZip = Get-BundleFile $ffSource');
    expect(bundlePart).not.toContain('Get-Verified');
    const downloadPart = text.slice(elseAt, text.indexOf('$mtxOut =', elseAt));
    expect(downloadPart).toContain('$mtxZip = Get-Verified $mtxUrl');
    expect(downloadPart).toContain('$ffZip = Get-Verified $FfmpegUrl');
  });

  it('still checks a bundle file against Get-FileHash and the sha256 parameter', () => {
    const fn = text.indexOf('function Get-BundleFile');
    expect(fn).toBeGreaterThan(-1);
    const body = text.slice(fn, text.indexOf('\n}', fn));
    expect(body).toContain('Get-FileHash');
    expect(body).toContain('$Sha256.ToUpperInvariant()');
    expect(body).toContain('throw');
  });

  it('copies a bundle file into the work folder first and hashes and uses the copy, not the original', () => {
    const fn = text.indexOf('function Get-BundleFile');
    const body = text.slice(fn, text.indexOf('\n}', fn));
    const copyAt = body.indexOf('Copy-Item -LiteralPath $Path -Destination $copy');
    const hashAt = body.indexOf('Get-FileHash');
    expect(copyAt).toBeGreaterThan(-1);
    expect(hashAt).toBeGreaterThan(copyAt);
    expect(body).toContain('Get-FileHash -Algorithm SHA256 -LiteralPath $copy');
    expect(body).toContain('return $copy');
    expect(body).not.toMatch(/return \$Path/);
    expect(body).toContain('Join-Path $work $Name');
  });

  it('locks the work folder to Administrators and SYSTEM when elevated, before any file goes in', () => {
    const made = text.indexOf('New-Item -ItemType Directory -Path $work');
    const lock = text.indexOf('Set-Acl -LiteralPath $work', made);
    const firstUse = text.indexOf('function Get-Verified');
    expect(made).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(made);
    expect(lock).toBeLessThan(firstUse);
    expect(text.slice(made, lock)).toContain('if ($admin)');
    expect(text.slice(made, lock)).toContain("'S-1-5-18', 'S-1-5-32-544'");
  });

  it('checks the bundle files exist before the elevation gate, the download or any change', () => {
    const presence = text.indexOf('$mtxSource = Join-Path $SourceDir $mtxZipName');
    const elevation = text.indexOf('if (-not $admin -and -not $SkipFirewall)');
    const download = text.indexOf('Invoke-WebRequest');
    expect(presence).toBeGreaterThan(-1);
    expect(presence).toBeLessThan(elevation);
    expect(presence).toBeLessThan(download);
    const preflight = text.slice(presence, elevation);
    expect(preflight).toContain('Test-Path -LiteralPath $mtxSource');
    expect(preflight).toContain('Test-Path -LiteralPath $ffSource');
  });
});

describe.runIf(process.platform === 'win32')('install-live-tools.ps1 -SourceDir (run)', () => {
  const SHA_A = 'a'.repeat(64);
  const SHA_B = 'b'.repeat(64);
  const run = (args: string[]): { status: number | null; out: string } => {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', install, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  function bundle(): { base: string; src: string; mtx: string; ff: string } {
    const base = tempDir();
    const src = join(base, 'payload');
    mkdirSync(src, { recursive: true });
    const mtx = join(src, 'mediamtx_v1.21.3_windows_amd64.zip');
    const ff = join(src, 'ffmpeg-release-essentials.zip');
    writeFileSync(mtx, 'x');
    writeFileSync(ff, 'x');
    return { base, src, mtx, ff };
  }

  it('lists the bundle files it would use and changes nothing', () => {
    const b = bundle();
    const dest = join(b.base, 'live');
    const r = run(['-Dest', dest, '-SourceDir', b.src, '-MediamtxSha256', SHA_A, '-FfmpegSha256', SHA_B, '-DryRun']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('bundle');
    expect(r.out).toContain(b.mtx);
    expect(r.out).toContain(b.ff);
    expect(existsSync(dest)).toBe(false);
  });

  it('fails before any change when the bundle has no MediaMTX zip', () => {
    const b = bundle();
    rmSync(b.mtx);
    const dest = join(b.base, 'live');
    const r = run(['-Dest', dest, '-SourceDir', b.src, '-MediamtxSha256', SHA_A, '-FfmpegSha256', SHA_B]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('mediamtx_v1.21.3_windows_amd64.zip');
    expect(existsSync(dest)).toBe(false);
  });

  it('fails before any change when the bundle has no ffmpeg zip', () => {
    const b = bundle();
    rmSync(b.ff);
    const dest = join(b.base, 'live');
    const r = run(['-Dest', dest, '-SourceDir', b.src, '-MediamtxSha256', SHA_A, '-FfmpegSha256', SHA_B]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('ffmpeg-release-essentials.zip');
    expect(existsSync(dest)).toBe(false);
  });

  it('installs from a good bundle (zips copied to the work folder, originals untouched)', () => {
    const base = tempDir();
    const src = join(base, 'payload');
    mkdirSync(src, { recursive: true });
    const stage = join(base, 'stage');
    mkdirSync(join(stage, 'ffmpeg-7.1-essentials_build', 'bin'), { recursive: true });
    writeFileSync(join(stage, 'mediamtx.exe'), 'x');
    writeFileSync(join(stage, 'ffmpeg-7.1-essentials_build', 'bin', 'ffmpeg.exe'), 'x');
    const mtx = join(src, 'mediamtx_v1.21.3_windows_amd64.zip');
    const ff = join(src, 'ffmpeg-release-essentials.zip');
    const zip = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -Path '${join(stage, 'mediamtx.exe')}' -DestinationPath '${mtx}'; ` +
          `Compress-Archive -Path '${join(stage, 'ffmpeg-7.1-essentials_build')}' -DestinationPath '${ff}'`],
      { encoding: 'utf8', timeout: 60_000 },
    );
    expect(zip.status).toBe(0);
    const hash = (f: string) =>
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-FileHash -Algorithm SHA256 -LiteralPath '${f}').Hash`], { encoding: 'utf8' }).stdout.trim();
    const before = { mtx: hash(mtx), ff: hash(ff) };
    const dest = join(base, 'live');
    const r = run(['-Dest', dest, '-SourceDir', src, '-MediamtxSha256', before.mtx, '-FfmpegSha256', before.ff, '-SkipFirewall']);
    expect(r.status).toBe(0);
    expect(existsSync(join(dest, 'mediamtx', 'mediamtx.exe'))).toBe(true);
    expect(existsSync(join(dest, 'ffmpeg', 'ffmpeg.exe'))).toBe(true);
    expect(hash(mtx)).toBe(before.mtx);
    expect(hash(ff)).toBe(before.ff);
    expect(existsSync(mtx)).toBe(true);
  });

  it('still checks the sha256 of a bundle file, so a mismatch installs nothing', () => {
    const b = bundle();
    const dest = join(b.base, 'live');
    const r = run(['-Dest', dest, '-SourceDir', b.src, '-MediamtxSha256', SHA_A, '-FfmpegSha256', SHA_B, '-SkipFirewall']);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/sha256 (mismatch|tidak sepadan)/);
    expect(existsSync(dest)).toBe(false);
  });
});
