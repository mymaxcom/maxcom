import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { writeTarGz } from './helpers/fakeBundle';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(repoRoot, 'scripts', 'setup', 'build-setup.ps1');
const psm = join(repoRoot, 'scripts', 'setup', 'MaxcomSetup.psm1');
const realPins = join(repoRoot, 'scripts', 'release-pins.json');
const win = process.platform === 'win32';
const VERSION = (JSON.parse(readFileSync(join(repoRoot, 'versions.json'), 'utf8')) as Record<string, string>)['kiosk-server-windows'];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  // a space, an ampersand and an apostrophe on purpose
  const d = mkdtempSync(join(tmpdir(), "maxcom bsetup & o'k-"));
  dirs.push(d);
  return d;
}
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function ps(args: string[], timeout = 120_000) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', timeout });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
function build(args: string[]) {
  return ps(['-File', script, ...args]);
}

function zipFolder(zipPath: string, stage: string, top: string[]): void {
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const r = spawnSync(tar, ['-a', '-cf', zipPath, '-C', stage, ...top], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar.exe: ${r.stderr}`);
}

interface Fixture {
  root: string;
  cache: string;
  releaseDir: string;
  outDir: string;
  pinsFile: string;
  pins: Record<string, { version: string; url: string; sha256: string; licence: string }>;
}

/** Cache of three tiny zips, a pins file with their real hashes, and a fake release archive. */
function fixture(opts: { releaseVersion?: string } = {}): Fixture {
  const root = tempDir();
  const cache = join(root, 'cache');
  const releaseDir = join(root, 'release');
  const outDir = join(root, 'out');
  mkdirSync(cache, { recursive: true });
  mkdirSync(releaseDir, { recursive: true });
  const stage = join(root, 'stage');
  const mk = (rel: string, data: string) => {
    mkdirSync(join(stage, rel, '..'), { recursive: true });
    writeFileSync(join(stage, rel), data);
  };
  mk('node-v1.0.0-win-x64/node.exe', 'MZ fake node');
  mk('node-v1.0.0-win-x64/LICENSE', 'NODE LICENCE TEXT\n');
  mk('mtx/LICENSE', 'MEDIAMTX LICENCE TEXT\n');
  mk('mtx/mediamtx.exe', 'MZ fake mtx');
  mk('ffmpeg-n1.0-win64-gpl-1.0/LICENSE.txt', 'FFMPEG GPL TEXT\n');
  mk('ffmpeg-n1.0-win64-gpl-1.0/bin/ffmpeg.exe', 'MZ fake ffmpeg');
  zipFolder(join(cache, 'node-v1.0.0-win-x64.zip'), stage, ['node-v1.0.0-win-x64']);
  zipFolder(join(cache, 'mediamtx_v1.0.0_windows_amd64.zip'), join(stage, 'mtx'), ['LICENSE', 'mediamtx.exe']);
  zipFolder(join(cache, 'ffmpeg-n1.0-win64-gpl-1.0.zip'), stage, ['ffmpeg-n1.0-win64-gpl-1.0']);
  const h = (n: string) => sha(readFileSync(join(cache, n)));
  const pins = {
    node: { version: '1.0.0', url: 'https://example.invalid/dist/v1.0.0/node-v1.0.0-win-x64.zip', sha256: h('node-v1.0.0-win-x64.zip'), licence: 'MIT' },
    mediamtx: { version: 'v1.0.0', url: 'https://example.invalid/mediamtx/v1.0.0/mediamtx_v1.0.0_windows_amd64.zip', sha256: h('mediamtx_v1.0.0_windows_amd64.zip'), licence: 'MIT' },
    ffmpeg: { version: 'n1.0', url: 'https://example.invalid/BtbN/FFmpeg-Builds/releases/download/autobuild-x/ffmpeg-n1.0-win64-gpl-1.0.zip', sha256: h('ffmpeg-n1.0-win64-gpl-1.0.zip'), licence: 'GPL-3.0-or-later' },
  };
  const pinsFile = join(root, 'pins.json');
  writeFileSync(pinsFile, JSON.stringify(pins, null, 2));
  writeTarGz(join(releaseDir, `maxcom-box-${VERSION}-windows.tar.gz`), [
    { name: 'release.json', data: JSON.stringify({ v: 1, version: opts.releaseVersion ?? VERSION, platform: 'windows' }) },
    { name: 'package.json', data: '{}' },
  ]);
  return { root, cache, releaseDir, outDir, pinsFile, pins };
}
function args(f: Fixture, extra: string[] = []): string[] {
  return ['-Version', VERSION, '-ReleaseDir', f.releaseDir, '-CacheDir', f.cache, '-OutDir', f.outDir, '-PinsFile', f.pinsFile, ...extra];
}

describe('build-setup.ps1 (static)', () => {
  const text = readFileSync(script, 'utf8');
  it('is ASCII only', () => {
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(text)).toBe(false);
  });
  it('has Invoke-WebRequest in exactly one function, https enforced, TLS 1.2 or later', () => {
    expect(text.match(/Invoke-WebRequest/g)?.length).toBe(1);
    const fn = text.slice(text.indexOf('function Receive-HttpsFile'), text.indexOf('function Get-PinnedFile'));
    expect(fn).toContain('Invoke-WebRequest');
    expect(fn).toMatch(/\^https:\/\//);
    expect(fn).toContain('Tls12');
    expect(text).not.toMatch(/DownloadFile|Start-BitsTransfer|Invoke-RestMethod/);
  });
  it('hashes a download before it is used and deletes on mismatch', () => {
    const fn = text.slice(text.indexOf('function Get-PinnedFile'), text.indexOf('function Copy-ZipEntry'));
    expect(fn.indexOf('Receive-HttpsFile')).toBeGreaterThan(-1);
    expect(fn.indexOf('Get-Sha256Of $part')).toBeGreaterThan(fn.indexOf('Receive-HttpsFile'));
    expect(fn.indexOf('Move-Item')).toBeGreaterThan(fn.indexOf('Get-Sha256Of $part'));
    expect(fn).toMatch(/Remove-Item -LiteralPath \$path/);
    expect(fn).toMatch(/Remove-Item -LiteralPath \$part/);
  });
  it('has an optional -Version (default: versions.json kiosk-server-windows, checked with set-version.mjs), -PinsFile and -DryRun', () => {
    expect(text).toMatch(/\[string\]\$Version = ''/);
    expect(text).not.toMatch(/Mandatory = \$true\)\]\[string\]\$Version/);
    expect(text).toContain("Resolve-ProductVersion 'kiosk-server-windows'");
    expect(text).toMatch(/--check --key \$Key/);
    expect(text).toContain('[string]$PinsFile');
    expect(text).toContain('[switch]$DryRun');
  });
});

describe('release-pins.json (real file, as committed)', () => {
  const pins = JSON.parse(readFileSync(realPins, 'utf8')) as Record<string, { version: string; url: string; licence: string; sha256: string }>;
  it('pins a versioned BtbN GPL ffmpeg build (relay.ts re-encodes with libx264)', () => {
    expect(pins.ffmpeg.url).toMatch(/^https:\/\/github\.com\/BtbN\/FFmpeg-Builds\/releases\/download\/autobuild-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\//);
    expect(pins.ffmpeg.url).toContain('-win64-gpl-');
    expect(pins.ffmpeg.url).not.toContain('latest');
    expect(pins.ffmpeg.url).toContain(pins.ffmpeg.version);
    expect(pins.ffmpeg.licence).toContain('GPL');
  });
  it('has a 64-char lowercase hex sha256 and an https url for every pin', () => {
    expect(Object.keys(pins).sort()).toEqual(['ffmpeg', 'mediamtx', 'node']);
    for (const n of Object.keys(pins)) {
      expect(pins[n].sha256, n).toMatch(/^[0-9a-f]{64}$/);
      expect(pins[n].url, n).toMatch(/^https:\/\//);
    }
  });
});

/** Temp copy of the real pins with every sha256 blanked. */
function blankedPins(root: string): string {
  const p = JSON.parse(readFileSync(realPins, 'utf8')) as Record<string, { sha256: string }>;
  for (const n of Object.keys(p)) p[n].sha256 = '';
  const file = join(root, 'pins-blank.json');
  writeFileSync(file, JSON.stringify(p, null, 2));
  return file;
}

describe.runIf(win)('build-setup.ps1 (run)', () => {
  it('refuses a -Version that is not the versions.json one', () => {
    const r = build(['-Version', '1.2']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('GAGAL:');
    const other = build(['-Version', '2030.01.9']);
    expect(other.status).toBe(1);
    expect(other.out).toMatch(/GAGAL: -Version 2030\.01\.9 tidak sama dengan versions\.json kiosk-server-windows/);
  });

  it('empty sha256 in the pins stops the build: GAGAL: sha256 belum diisi untuk node', () => {
    const f = fixture();
    const r = build(['-Version', VERSION, '-ReleaseDir', f.releaseDir, '-CacheDir', f.cache, '-OutDir', f.outDir, '-PinsFile', blankedPins(f.root)]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('GAGAL: sha256 belum diisi untuk node');
    expect(existsSync(f.outDir)).toBe(false);
  });

  it('-DryRun lists the bundle files, writes nothing, and warns about empty pins', () => {
    const f = fixture();
    const out = join(f.root, 'dry-out');
    const r = build(['-Version', VERSION, '-ReleaseDir', f.releaseDir, '-CacheDir', join(f.root, 'dry-cache'), '-OutDir', out, '-PinsFile', blankedPins(f.root), '-DryRun']);
    expect(r.status).toBe(0);
    for (const s of ['Pasang MAXCOM.cmd', 'PANDUAN PASANG.txt', 'setup/setup.ps1', 'setup/MaxcomSetup.psm1', 'setup/launcher.mjs', 'setup/start.cmd', 'setup/release-pins.json', 'setup/maxcom.ico', `payload/maxcom-box-${VERSION}-windows.tar.gz`, 'payload/node-v24.22.1-win-x64.zip', 'licences/ffmpeg-LICENSE.txt', 'manifest.json']) {
      expect(r.out, s).toContain(s);
    }
    expect(r.out).toContain('sha256 belum diisi untuk ffmpeg');
    expect(existsSync(out)).toBe(false);
    expect(existsSync(join(f.root, 'dry-cache'))).toBe(false);
  });

  it('a cached file with the wrong hash is deleted and the build fails', () => {
    const f = fixture();
    const victim = join(f.cache, 'mediamtx_v1.0.0_windows_amd64.zip');
    writeFileSync(victim, 'tampered bytes');
    const r = build(args(f));
    expect(r.status).toBe(1);
    expect(r.out).toContain('GAGAL:');
    expect(r.out).toContain('mediamtx');
    expect(existsSync(victim)).toBe(false);
    expect(existsSync(join(f.outDir, `MAX-Kiosk-Server-Setup-${VERSION}-windows.zip`))).toBe(false);
  });

  it('a failed download leaves no file and no zip', () => {
    const f = fixture();
    const pins = JSON.parse(readFileSync(f.pinsFile, 'utf8'));
    pins.node.url = 'https://127.0.0.1:1/dist/node-v1.0.0-win-x64.zip';
    writeFileSync(f.pinsFile, JSON.stringify(pins));
    rmSync(join(f.cache, 'node-v1.0.0-win-x64.zip'));
    const r = build(args(f));
    expect(r.status).toBe(1);
    expect(r.out).toContain('GAGAL: muat turun node gagal');
    expect(readdirSync(f.cache).filter((n) => n.startsWith('node'))).toEqual([]);
  });

  it('refuses a non-https pin, a release.json of another version and a missing release archive', () => {
    const f = fixture();
    const pins = JSON.parse(readFileSync(f.pinsFile, 'utf8'));
    pins.ffmpeg.url = 'http://example.invalid/x/ffmpeg-n1.0-win64-gpl-1.0.zip';
    const p2 = join(f.root, 'pins-http.json');
    writeFileSync(p2, JSON.stringify(pins));
    expect(build(args(f).map((a) => (a === f.pinsFile ? p2 : a))).out).toContain('https://');

    const g = fixture({ releaseVersion: '2025.01.1' });
    const r = build(args(g));
    expect(r.status).toBe(1);
    expect(r.out).toContain('release.json');

    const h = fixture();
    rmSync(join(h.releaseDir, `maxcom-box-${VERSION}-windows.tar.gz`));
    expect(build(args(h)).status).toBe(1);
  });

  it('makes the bundle folder, the zip and the .sha256; manifest covers every file; Test-BundleManifest accepts it', () => {
    const f = fixture();
    const r = build(args(f));
    expect(r.out).toContain('OK zip');
    expect(r.status).toBe(0);
    const top = `MAX-Kiosk-Server-Setup-${VERSION}-windows`;
    const bundle = join(f.outDir, top);
    const zip = join(f.outDir, `${top}.zip`);
    expect(existsSync(zip)).toBe(true);

    // .sha256: one line, lower-case hex, file name
    const shaLine = readFileSync(`${zip}.sha256`, 'utf8');
    expect(shaLine).toBe(`${sha(readFileSync(zip))}  ${top}.zip\n`);

    const m = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')) as { v: number; version: string; builtAt: string; files: { path: string; size: number; sha256: string }[] };
    expect(m.v).toBe(1);
    expect(m.version).toBe(VERSION);
    expect(m.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const paths = m.files.map((x) => x.path);
    expect(paths).toEqual([...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    for (const p of [
      'Pasang MAXCOM.cmd', 'PANDUAN PASANG.txt', 'setup/setup.ps1', 'setup/MaxcomSetup.psm1', 'setup/doctor.ps1', 'setup/uninstall.ps1',
      'setup/switch-release.ps1', 'setup/migrate-data.ps1', 'setup/box-ca.ps1', 'setup/install-live-tools.ps1', 'setup/ensure-box-firewall.ps1',
      'setup/launcher.mjs', 'setup/start.cmd', 'setup/cli.mjs', 'setup/maxcom.cmd', 'setup/release-pins.json', 'setup/maxcom.ico', 'Semak MAXCOM.cmd'.replace(/^/, 'setup/'),
      `payload/maxcom-box-${VERSION}-windows.tar.gz`, 'payload/node-v1.0.0-win-x64.zip', 'payload/mediamtx_v1.0.0_windows_amd64.zip', 'payload/ffmpeg-n1.0-win64-gpl-1.0.zip',
      'licences/node-LICENSE.txt', 'licences/mediamtx-LICENSE.txt', 'licences/ffmpeg-LICENSE.txt', 'licences/ffmpeg-SOURCE.txt',
    ]) {
      expect(paths, p).toContain(p);
    }
    expect(paths).not.toContain('manifest.json');
    // every file on disk is listed and matches
    const walk = (d: string, base = ''): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]));
    expect(walk(bundle).filter((p) => p !== 'manifest.json').sort()).toEqual([...paths].sort());
    for (const e of m.files) expect(sha(readFileSync(join(bundle, e.path))), e.path).toBe(e.sha256);
    expect(m.files.every((e) => /^[0-9a-f]{64}$/.test(e.sha256))).toBe(true);

    // the pins file in the bundle is the one verified against
    expect(readFileSync(join(bundle, 'setup', 'release-pins.json'), 'utf8')).toBe(readFileSync(f.pinsFile, 'utf8'));
    expect(readFileSync(join(bundle, 'licences', 'node-LICENSE.txt'), 'utf8')).toContain('NODE LICENCE TEXT');
    expect(readFileSync(join(bundle, 'licences', 'mediamtx-LICENSE.txt'), 'utf8')).toContain('MEDIAMTX LICENCE TEXT');
    expect(readFileSync(join(bundle, 'licences', 'ffmpeg-LICENSE.txt'), 'utf8')).toContain('FFMPEG GPL TEXT');
    const src = readFileSync(join(bundle, 'licences', 'ffmpeg-SOURCE.txt'), 'utf8');
    expect(src).toContain('https://example.invalid/BtbN/FFmpeg-Builds/releases/download/autobuild-x/ffmpeg-n1.0-win64-gpl-1.0.zip');

    // Test-BundleManifest (Task 7) on the folder, and on the zip after extracting it
    const check = (dir: string) => ps(['-Command', `Import-Module -Name '${psm.replace(/'/g, "''")}'; if (Test-BundleManifest '${dir.replace(/'/g, "''")}') { 'MANIFESTOK' } else { 'MANIFESTBAD' }`]);
    expect(check(bundle).out).toContain('MANIFESTOK');
    const ex = join(f.root, 'extracted');
    const x = ps(['-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${ex.replace(/'/g, "''")}'`]);
    expect(x.status).toBe(0);
    expect(existsSync(join(ex, top, 'manifest.json'))).toBe(true);
    expect(check(join(ex, top)).out).toContain('MANIFESTOK');
  });

  it('a second build over the same output replaces the bundle cleanly', () => {
    const f = fixture();
    expect(build(args(f)).status).toBe(0);
    const stale = join(f.outDir, `MAX-Kiosk-Server-Setup-${VERSION}-windows`, 'stale.txt');
    writeFileSync(stale, 'x');
    expect(build(args(f)).status).toBe(0);
    expect(existsSync(stale)).toBe(false);
  });
});
