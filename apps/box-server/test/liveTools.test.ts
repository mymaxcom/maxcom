import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { liveTools } from '../src/live/tools.ts';

const script = fileURLToPath(new URL('../../../scripts/install-live-tools.ps1', import.meta.url));
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-live-'));
  dirs.push(d);
  return d;
}

const VERSIONS = `# MAXCOM live tools

| Name | Version | URL | sha256 | Licence | Date |
|---|---|---|---|---|---|
| mediamtx | v1.21.3 | https://github.com/bluenviron/mediamtx/releases/download/v1.21.3/mediamtx_v1.21.3_windows_amd64.zip | ${SHA_A} | MIT | 2026-11-04 |
| ffmpeg | 7.1.1 | https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip | ${SHA_B} | GPL-3.0 | 2026-11-04 |
`;

function install(dir: string, which: Array<'mediamtx' | 'ffmpeg'>, versions: string | null = VERSIONS): void {
  for (const name of which) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, `${name}.exe`), 'stub');
  }
  if (versions !== null) writeFileSync(join(dir, 'VERSIONS.md'), versions);
}

describe('liveTools', () => {
  it('flags a recorded MediaMTX older than v1.21.0 and accepts v1.21.0 and newer', () => {
    for (const [v, old] of [['v1.16.0', true], ['v1.20.9', true], ['v1.21.0', false], ['v1.21.3', false], ['v2.0.0', false]] as const) {
      const dir = tempDir();
      install(dir, ['mediamtx', 'ffmpeg'], VERSIONS.replaceAll('v1.21.3', v));
      expect(liveTools(dir).mediamtxTooOld, v).toBe(old ? v : null);
    }
    const none = tempDir();
    install(none, ['mediamtx', 'ffmpeg'], null);
    expect(liveTools(none).mediamtxTooOld).toBeNull();
  });

  it('finds both tools and reads VERSIONS.md', () => {
    const dir = tempDir();
    install(dir, ['mediamtx', 'ffmpeg']);
    const t = liveTools(dir);
    expect(t.missing).toEqual([]);
    expect(t.mediamtx).toBe(join(dir, 'mediamtx', 'mediamtx.exe'));
    expect(t.ffmpeg).toBe(join(dir, 'ffmpeg', 'ffmpeg.exe'));
    expect(t.versions?.mediamtx?.version).toBe('v1.21.3');
    expect(t.versions?.ffmpeg?.sha256).toBe(SHA_B);
  });

  it('reports ffmpeg missing', () => {
    const dir = tempDir();
    install(dir, ['mediamtx']);
    const t = liveTools(dir);
    expect(t.missing).toEqual(['ffmpeg']);
    expect(t.ffmpeg).toBeNull();
    expect(t.mediamtx).not.toBeNull();
  });

  it('reports both missing for an empty or absent folder, with no versions', () => {
    const dir = tempDir();
    expect(liveTools(dir).missing).toEqual(['mediamtx', 'ffmpeg']);
    expect(liveTools(dir).versions).toBeNull();
    expect(liveTools(join(dir, 'nope')).missing).toEqual(['mediamtx', 'ffmpeg']);
  });

  it('survives a corrupt VERSIONS.md', () => {
    const dir = tempDir();
    install(dir, ['mediamtx', 'ffmpeg'], '\u0000\u0001 not a table');
    const t = liveTools(dir);
    expect(t.missing).toEqual([]);
    expect(t.versions).toBeNull();
  });
});

describe('install-live-tools.ps1 (static)', () => {
  const text = readFileSync(script, 'utf8');

  it('is ASCII only (PowerShell 5.1 reads BOM-less files as ANSI)', () => {
    for (const ch of text) expect(ch.charCodeAt(0)).toBeLessThan(128);
  });

  it('makes both sha256 parameters mandatory', () => {
    expect(text).toMatch(/Mandatory\s*=\s*\$true\)\]\s*\[string\]\$MediamtxSha256/);
    expect(text).toMatch(/Mandatory\s*=\s*\$true\)\]\s*\[string\]\$FfmpegSha256/);
    expect(text).toMatch(/\[0-9a-fA-F\]\{64\}/);
  });

  it('installs the media rules through ensure-live-firewall.ps1, prints the two manual commands, and has no TCP rule', () => {
    // the rules themselves live in ensure-live-firewall.ps1 (see liveFirewallScripts.test.ts)
    expect(text).toContain('ensure-live-firewall.ps1');
    expect(text).not.toMatch(/protocol=tcp/i);
    expect(text).not.toMatch(/firewall delete rule/);
    expect(text).not.toMatch(/&\s*netsh/);
    // the manual commands printed for -SkipFirewall: every profile, local subnet only, both UDP ports
    const rules = text.split(/\r?\n/).filter((l) => /add rule/.test(l));
    expect(rules.length).toBe(2);
    expect(rules.join(' ')).toMatch(/localport=8189/);
    expect(rules.join(' ')).toMatch(/localport=8890/);
    for (const r of rules) {
      expect(r).toMatch(/profile=any/);
      expect(r).toMatch(/remoteip=localsubnet/);
      expect(r).toMatch(/protocol=udp/);
    }
    expect(text).not.toMatch(/profile=(private|public|domain)/i);
  });

  it('downloads only over https and writes VERSIONS.md', () => {
    expect(text).not.toMatch(/http:\/\//i);
    expect(text).toContain('VERSIONS.md');
    expect(text).toContain('Get-FileHash');
  });

  it('never touches or prints the MediaMTX credential', () => {
    expect(text).not.toMatch(/mediamtx\.pass/);
  });

  it('stops before downloading when not elevated, unless -SkipFirewall is passed', () => {
    expect(text).toMatch(/\[switch\]\$SkipFirewall/);
    const check = text.indexOf('if (-not $admin -and -not $SkipFirewall)');
    expect(check).toBeGreaterThan(-1);
    expect(text.slice(check, check + 400)).toMatch(/exit 1/);
    // the check comes before any download
    expect(check).toBeLessThan(text.indexOf('Invoke-WebRequest'));
    expect(check).toBeLessThan(text.indexOf('$mtxZip = Get-Verified'));
  });

  it('records the ffmpeg version from "ffmpeg -version" and the licence from the zip name', () => {
    expect(text).toMatch(/-version/);
    expect(text).toContain('^ffmpeg version (');
    expect(text).toContain('LGPL-2.1-or-later');
    expect(text).toMatch(/-match '-lgpl-'/);
    expect(text).toMatch(/-match '-gpl-'/);
    expect(text).toContain('| $ffLicence |');
    expect(text).not.toMatch(/\| GPL-3\.0 \|/);
  });
});

describe.runIf(process.platform === 'win32')('install-live-tools.ps1 (dry run)', () => {
  const run = (args: string[]): { status: number | null; out: string } => {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('refuses without the sha256 parameters', () => {
    const dest = join(tempDir(), 'live');
    const r = run(['-Dest', dest, '-DryRun']);
    expect(r.status).not.toBe(0);
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses a malformed hash', () => {
    const dest = join(tempDir(), 'live');
    const r = run(['-Dest', dest, '-MediamtxSha256', 'nothex', '-FfmpegSha256', SHA_B, '-DryRun']);
    expect(r.status).not.toBe(0);
    expect(existsSync(dest)).toBe(false);
  });

  const elevated = process.platform === 'win32' && spawnSync('net', ['session'], { encoding: 'utf8' }).status === 0;

  it.runIf(!elevated)('a real run without administrator rights stops at once and writes nothing', () => {
    const dest = join(tempDir(), 'live');
    const r = run(['-Dest', dest, '-MediamtxSha256', SHA_A, '-FfmpegSha256', SHA_B]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('elevated PowerShell');
    expect(r.out).toContain('-SkipFirewall');
    expect(existsSync(dest)).toBe(false);
  });

  it('dry run prints the plan, downloads nothing and changes nothing', () => {
    const dest = join(tempDir(), 'live');
    const r = run(['-Dest', dest, '-MediamtxSha256', SHA_A, '-FfmpegSha256', SHA_B, '-DryRun']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('https://github.com/bluenviron/mediamtx/releases/download/');
    expect(r.out).toContain('DRY RUN');
    expect(existsSync(dest)).toBe(false);
  });
});
