import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(repoRoot, 'scripts', 'build-release.ps1');
const pinsPath = join(repoRoot, 'scripts', 'release-pins.json');
const win = process.platform === 'win32';
const pkgVersion = JSON.parse(readFileSync(join(repoRoot, 'apps', 'box-server', 'package.json'), 'utf8')).version as string;
const versions = JSON.parse(readFileSync(join(repoRoot, 'versions.json'), 'utf8')) as Record<string, string>;
const winVersion = versions['kiosk-server-windows'];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(prefix = 'maxcom-brel-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function runBuild(args: string[], timeout = 60_000) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    encoding: 'utf8',
    timeout,
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('build-release.ps1 (static)', () => {
  const text = readFileSync(script, 'utf8');
  it('is ASCII only', () => {
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(text)).toBe(false);
  });
  it('takes an optional -Version (default: versions.json kiosk-server-<platform>), checks every version file, and has the integrity flags', () => {
    expect(text).toMatch(/\[string\]\$Version = ''/);
    expect(text).not.toMatch(/Mandatory = \$true\)\]\[string\]\$Version/);
    expect(text).toContain('$versionKey = "kiosk-server-$Platform"');
    expect(text).toContain("'versions.json'");
    expect(text).toContain("'set-version.mjs'");
    expect(text).toMatch(/--check --key \$versionKey/);
    expect(text).not.toContain('$pkg.version');
    expect(text).toContain('--ignore-scripts');
    expect(text).toContain('--omit=dev');
    expect(text).toContain('[switch]$DryRun');
    expect(text).toContain('[switch]$SkipAppBuild');
  });
  it('calls tar.exe by its full System32 path and downloads nothing', () => {
    expect(text).toMatch(/System32\\tar\.exe/);
    expect(text).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|DownloadFile|Start-BitsTransfer/);
  });
  it('runs tar -czf under EAP Continue so its stderr cannot terminate the script, then judges by exit code', () => {
    const i = text.indexOf('& $tar -czf $archivePath');
    expect(i).toBeGreaterThan(-1);
    const before = text.slice(Math.max(0, i - 500), i);
    expect(before).toMatch(/\$ErrorActionPreference = 'Continue'/);
    const after = text.slice(i, i + 700);
    expect(after).toMatch(/finally \{ \$ErrorActionPreference = \$eapBefore \}/);
    expect(after).toMatch(/\$tarExit = \$LASTEXITCODE/);
    expect(after).toMatch(/Write-Host "  tar: /);
    expect(after).toMatch(/if \(\$tarExit -ne 0\)/);
  });
  it.runIf(process.platform === 'win32')('mechanism: native stderr through 2>&1 kills a script under Stop but not under Continue', () => {
    const ps = (body: string) =>
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', body], { encoding: 'utf8', timeout: 30_000 });
    const stop = ps("$ErrorActionPreference='Stop'; $o = @(& cmd.exe /c 'echo warn 1>&2 & exit 0' 2>&1); 'AFTER'");
    expect(stop.stdout).not.toContain('AFTER');
    const cont = ps("$ErrorActionPreference='Stop'; $e=$ErrorActionPreference; $ErrorActionPreference='Continue'; try { $o = @(& cmd.exe /c 'echo warn 1>&2 & exit 0' 2>&1 | ForEach-Object { \"$_\" }) } finally { $ErrorActionPreference=$e }; \"AFTER $LASTEXITCODE $($o -join '|')\"");
    expect(cont.stdout).toContain('AFTER 0 warn');
  });
  it('never deletes with a link-following recursive walk (links are removed as links first)', () => {
    expect(text).toContain('function Remove-TreeSafe');
    expect(text).toContain('function Get-TreeEntries');
    expect(text).not.toMatch(/Get-ChildItem[^\n]*-Recurse/);
  });
});

describe('release-pins.json', () => {
  const pins = JSON.parse(readFileSync(pinsPath, 'utf8')) as Record<string, Record<string, string>>;
  it('has node, mediamtx and ffmpeg with version, https url, sha256 and licence', () => {
    expect(Object.keys(pins).sort()).toEqual(['ffmpeg', 'mediamtx', 'node']);
    for (const name of Object.keys(pins)) {
      const e = pins[name];
      expect(typeof e.version, name).toBe('string');
      expect(e.version.length, name).toBeGreaterThan(0);
      expect(e.url.startsWith('https://'), name).toBe(true);
      expect(typeof e.licence, name).toBe('string');
      expect(e.licence.length, name).toBeGreaterThan(0);
      // empty until the operator step; if filled it must be a real sha256
      expect(e.sha256 === '' || /^[0-9a-f]{64}$/i.test(e.sha256), name).toBe(true);
    }
  });
  it('uses a versioned ffmpeg url, not the moving release-essentials zip', () => {
    expect(pins.ffmpeg.url).not.toContain('release-essentials');
    expect(pins.ffmpeg.url).toContain(pins.ffmpeg.version);
  });
  it('names zips the setup can read (node-v<ver>-win-x64.zip, mediamtx_<ver>_windows_amd64.zip)', () => {
    expect(pins.node.url.endsWith(`/node-v${pins.node.version}-win-x64.zip`)).toBe(true);
    expect(pins.mediamtx.url.endsWith(`/mediamtx_${pins.mediamtx.version}_windows_amd64.zip`)).toBe(true);
    expect(pins.mediamtx.version).toMatch(/^v\d+\.\d+\.\d+$/);
  });
});

describe('box-server version', () => {
  it('is the first release version in YYYY.MM.N form', () => {
    expect(pkgVersion).toMatch(/^20\d\d\.(0[1-9]|1[0-2])\.[1-9]\d*$/);
    const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
    expect(lock.packages['apps/box-server'].version).toBe(pkgVersion);
  });
});

describe.runIf(win)('build-release.ps1 refusals on the real checkout', () => {
  it('fails without -Version', () => {
    const r = runBuild([]);
    expect(r.status).not.toBe(0);
  });
  it('fails for a version that is not YYYY.MM.N', () => {
    const r = runBuild(['-Version', '1.2']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('GAGAL');
  });
  it('fails for a version that differs from versions.json', () => {
    const r = runBuild(['-Version', '2030.01.9']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL.*versions\.json kiosk-server-windows/);
  });
  it('-DryRun without -Version takes the version from versions.json', () => {
    const r = runBuild(['-DryRun', '-OutDir', join(tempDir(), 'never-made')]);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`maxcom-box-${winVersion}-windows.tar.gz`);
    const a = runBuild(['-DryRun', '-Platform', 'android', '-OutDir', join(tempDir(), 'never-made')]);
    expect(a.status).toBe(0);
    expect(a.out).toContain(`maxcom-box-${versions['kiosk-server-android']}-android.tar.gz`);
  });
  it('-DryRun prints the stage list and writes nothing', () => {
    const out = join(tempDir(), 'never-made');
    const r = runBuild(['-Version', winVersion, '-OutDir', out, '-DryRun']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('DRYRUN stage: apps/kiosk-display/dist/');
    expect(r.out).toContain('DRYRUN stage: release.json');
    expect(r.out).toContain('DRYRUN tar:');
    expect(r.out).toContain(`maxcom-box-${winVersion}-windows.tar.gz`);
    expect(existsSync(out)).toBe(false);
  });
  it('refuses a real build while a dev server port listens (the live box on 8787 is never disturbed)', async () => {
    const server = net.createServer();
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    const port = (server.address() as net.AddressInfo).port;
    const out = join(tempDir(), 'never-made');
    try {
      // spawnSync would block this process, and with it the listener's accept loop; the OS still completes the TCP connect.
      const r = runBuild(['-Version', winVersion, '-OutDir', out, '-DevPorts', String(port)]);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(new RegExp(`GAGAL: pelayan pembangunan sedang berjalan pada :${port}`));
      expect(existsSync(out)).toBe(false);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

// ---- A fixture checkout (git repo in a temp folder) so the whole build runs without touching this checkout,
// ---- its kiosk build, the live box on 8787 or the network (the fixture has no dependencies to install).
// ---- The smoke test inside build-release.ps1 runs here on a random free port.
const FIXTURE_MAIN = [
  "import http from 'node:http';",
  "import { readFileSync } from 'node:fs';",
  "import { resolve } from 'node:path';",
  "import { core } from '@surau/core';",
  "const root = resolve(import.meta.dirname, '../../..');",
  'const port = Number(process.env.SURAU_PORT);',
  'const server = http.createServer((req, res) => {',
  "  if (req.url === '/api/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: core === true })); return; }",
  "  if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(readFileSync(resolve(root, 'apps/kiosk-display/dist/index.html'))); return; }",
  "  if (req.url === '/app/') { res.setHeader('content-type', 'text/html'); res.end(readFileSync(resolve(root, 'apps/box-server/public/app/index.html'))); return; }",
  '  res.statusCode = 404; res.end("not found");',
  '});',
  "server.listen(port, '127.0.0.1');",
  "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
  '',
].join('\n');

function put(root: string, rel: string, data: string): void {
  const p = join(root, ...rel.split('/'));
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, data);
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

function makeFixture(version = '2026.11.1', opts: { badSums?: boolean; testFile?: boolean } = {}): string {
  const root = tempDir('maxcom-brel-fx-');
  put(root, 'package.json', JSON.stringify({ name: 'fx', private: true, workspaces: ['packages/*', 'apps/*'] }));
  put(root, 'apps/box-server/package.json', JSON.stringify({ name: '@surau/box-server', version, private: true, type: 'module', dependencies: { '@surau/core': '*' } }));
  // the two server products carry their own versions: the android one differs on purpose
  put(root, 'versions.json', `${JSON.stringify({ 'kiosk-server-windows': version, 'kiosk-server-android': '2026.11.3', 'admin-client-android': '2026.11.2' }, null, 2)}\n`);
  put(root, 'apps/box-server/THIRD-PARTY.md', 'fx\n');
  put(root, 'apps/box-server/src/main.ts', FIXTURE_MAIN);
  if (opts.testFile) put(root, 'apps/box-server/src/old.test.ts', '// a test file that must not ship\n');
  const webIndex = '<html><body>web app</body></html>\n';
  put(root, 'apps/box-server/public/app/index.html', webIndex);
  const sum = opts.badSums ? '0'.repeat(64) : createHash('sha256').update(webIndex).digest('hex');
  put(root, 'apps/box-server/public/app/sha256sums.txt', `${sum}  index.html\n`);
  put(root, 'apps/kiosk-display/package.json', JSON.stringify({ name: '@surau/kiosk-display', version: '0.0.0', private: true }));
  put(root, 'apps/kiosk-display/dist/index.html', '<html><body>kiosk</body></html>\n');
  put(root, 'packages/core/package.json', JSON.stringify({ name: '@surau/core', version: '0.0.0', type: 'module', exports: { '.': './src/index.ts' } }));
  put(root, 'packages/core/src/index.ts', 'export const core: boolean = true;\n');
  put(root, 'packages/device-client/package.json', JSON.stringify({ name: '@surau/device-client', version: '0.0.0', private: true }));
  put(root, 'scripts/ensure-live-firewall.ps1', '# fixture\n');
  put(root, 'THIRD-PARTY-NOTICES.md', 'fx\n');
  const npm = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, encoding: 'utf8', shell: true });
  if (npm.status !== 0) throw new Error(`fixture npm failed: ${npm.stderr}`);
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return root;
}

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

function tarList(archive: string, flags: string): string[] {
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const r = spawnSync(tar, [flags, archive], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  return r.stdout.split(/\r?\n/).filter((l) => l !== '');
}

describe.runIf(win)('build-release.ps1 end to end on a fixture checkout', () => {
  it('builds the archive: entries at the root, release.json, no links, no tests, smoke test passed', async () => {
    const fx = makeFixture();
    const out = join(tempDir(), 'out');
    const r = runBuild(['-Version', '2026.11.1', '-RepoRoot', fx, '-OutDir', out, '-SkipAppBuild', '-DevPorts', String(await freePort())], 240_000);
    expect(r.out).toContain('Ujian asap lulus');
    expect(r.status).toBe(0);
    const archive = join(out, 'maxcom-box-2026.11.1-windows.tar.gz');
    expect(existsSync(archive)).toBe(true);
    const bytes = readFileSync(archive);
    const last = r.out.trim().split(/\r?\n/).pop() ?? '';
    expect(last).toBe(`sha256 ${createHash('sha256').update(bytes).digest('hex')} size ${bytes.length}`);

    const names = tarList(archive, '-tzf');
    expect(names[0]).toBe('release.json');
    expect(names).toContain('apps/box-server/src/main.ts');
    expect(names).toContain('apps/box-server/public/app/index.html');
    expect(names).toContain('apps/kiosk-display/dist/index.html');
    expect(names).toContain('packages/core/src/index.ts');
    expect(names).toContain('scripts/ensure-live-firewall.ps1');
    expect(names).toContain('THIRD-PARTY-NOTICES.md');
    expect(names.some((n) => n.startsWith('./') || n.startsWith('/') || n.includes('..'))).toBe(false);
    expect(names.some((n) => /\.test\.ts$/.test(n))).toBe(false);
    expect(names.some((n) => n.startsWith('node_modules/@surau'))).toBe(false);
    expect(names.some((n) => n.includes('.package-lock.json'))).toBe(false);
    expect(names.some((n) => n === 'apps/kiosk-display/package.json' || n.startsWith('packages/device-client'))).toBe(false);
    expect(tarList(archive, '-tvzf').filter((l) => /^[lh]/.test(l))).toEqual([]);

    // release.json is read back from a fresh extraction
    const x = tempDir();
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    expect(spawnSync(tar, ['-xzf', archive, '-C', x]).status).toBe(0);
    const meta = JSON.parse(readFileSync(join(x, 'release.json'), 'utf8'));
    expect(meta.v).toBe(1);
    expect(meta.version).toBe('2026.11.1');
    expect(meta.platform).toBe('windows');
    expect(meta.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(meta.builtAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(meta.node).toBe(JSON.parse(readFileSync(pinsPath, 'utf8')).node.version);
    expect(meta.workspaceLinks).toEqual([{ name: '@surau/core', target: 'packages/core' }]);
    expect(existsSync(join(x, 'apps', 'kiosk-display', 'package.json'))).toBe(false);
  }, 300_000);

  it('without -Version builds with the platform key of versions.json: the android archive carries its own version, stamped in release.json', async () => {
    const fx = makeFixture();
    const out = join(tempDir(), 'out');
    const r = runBuild(['-RepoRoot', fx, '-OutDir', out, '-Platform', 'android', '-SkipAppBuild', '-DevPorts', String(await freePort())], 240_000);
    expect(r.status).toBe(0);
    const archive = join(out, 'maxcom-box-2026.11.3-android.tar.gz');
    expect(existsSync(archive)).toBe(true);
    const x = tempDir();
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    expect(spawnSync(tar, ['-xzf', archive, '-C', x]).status).toBe(0);
    const meta = JSON.parse(readFileSync(join(x, 'release.json'), 'utf8'));
    expect(meta.version).toBe('2026.11.3');
    expect(meta.platform).toBe('android');
  }, 300_000);

  it('refuses a -Version that is not the versions.json one for that platform', async () => {
    const fx = makeFixture();
    const out = join(tempDir(), 'out');
    const r = runBuild(['-Version', '2026.11.1', '-Platform', 'android', '-RepoRoot', fx, '-OutDir', out, '-SkipAppBuild', '-DevPorts', String(await freePort())]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: -Version 2026\.11\.1 tidak sama dengan versions\.json kiosk-server-android \(2026\.11\.3\)/);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses uncommitted changes under apps/ and builds nothing', async () => {
    const fx = makeFixture();
    put(fx, 'apps/box-server/src/extra.ts', 'export {};\n');
    const out = join(tempDir(), 'out');
    const r = runBuild(['-Version', '2026.11.1', '-RepoRoot', fx, '-OutDir', out, '-SkipAppBuild', '-DevPorts', String(await freePort())]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: ada perubahan belum commit/);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses an uncommitted versions.json bump (it would be stamped into release.json)', async () => {
    const fx = makeFixture();
    const vf = join(fx, 'versions.json');
    writeFileSync(vf, readFileSync(vf, 'utf8').replace(/"admin-client-android": "[^"]+"/, '"admin-client-android": "2026.11.9"'));
    const out = join(tempDir(), 'out');
    const r = runBuild(['-Version', '2026.11.1', '-RepoRoot', fx, '-OutDir', out, '-SkipAppBuild', '-DevPorts', String(await freePort())]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: ada perubahan belum commit di apps\/, packages\/ atau versions\.json/);
    expect(r.out).toContain('versions.json');
    expect(existsSync(out)).toBe(false);
  });

  it('refuses a web app build whose sha256sums.txt does not match, and when public/app is missing', async () => {
    const fx = makeFixture('2026.11.1', { badSums: true });
    const out = join(tempDir(), 'out');
    const r = runBuild(['-Version', '2026.11.1', '-RepoRoot', fx, '-OutDir', out, '-SkipAppBuild', '-DevPorts', String(await freePort())]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: sha256 tidak sepadan untuk app\/index\.html/);
    expect(existsSync(out)).toBe(false);
    rmSync(join(fx, 'apps', 'box-server', 'public', 'app'), { recursive: true, force: true });
    git(fx, 'add', '-A');
    git(fx, 'commit', '-q', '-m', 'drop web app');
    const r2 = runBuild(['-Version', '2026.11.1', '-RepoRoot', fx, '-OutDir', out, '-SkipAppBuild', '-DevPorts', String(await freePort())]);
    expect(r2.status).toBe(1);
    expect(r2.out).toMatch(/GAGAL: apps\/box-server\/public\/app\/index\.html tiada/);
  }, 120_000);

  it('refuses to pack a stage that still holds a *.test.ts', async () => {
    const fx = makeFixture('2026.11.1', { testFile: true });
    const out = join(tempDir(), 'out');
    const r = runBuild(['-Version', '2026.11.1', '-RepoRoot', fx, '-OutDir', out, '-SkipAppBuild', '-DevPorts', String(await freePort())], 120_000);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: stage masih ada fail ujian/);
    expect(r.out).not.toContain('AMARAN');
    expect(existsSync(join(out, 'maxcom-box-2026.11.1-windows.tar.gz'))).toBe(false);
  }, 180_000);

  it('refuses a dev server port even on the fixture', async () => {
    const fx = makeFixture();
    const server = net.createServer();
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    const port = (server.address() as net.AddressInfo).port;
    const out = join(tempDir(), 'out');
    try {
      const r = runBuild(['-Version', '2026.11.1', '-RepoRoot', fx, '-OutDir', out, '-SkipAppBuild', '-DevPorts', String(port)]);
      expect(r.status).toBe(1);
      expect(r.out).toContain(`:${port}`);
      expect(existsSync(out)).toBe(false);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});
