import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeFakeBundle, writeTarGz } from './helpers/fakeBundle.ts';

const psm1 = fileURLToPath(new URL('../../../scripts/setup/MaxcomSetup.psm1', import.meta.url));
const fakeBundleTs = fileURLToPath(new URL('./helpers/fakeBundle.ts', import.meta.url));
const win = process.platform === 'win32';

vi.setConfig({ testTimeout: 150000, hookTimeout: 150000 });

describe('MaxcomSetup.psm1 (static)', () => {
  const text = readFileSync(psm1, 'utf8');
  // code only: block comments and whole-line comments removed
  const code = text.replace(/<#[\s\S]*?#>/g, '').replace(/^\s*#.*$/gm, '');

  it('is ASCII only (PowerShell 5.1 reads BOM-less files as ANSI)', () => {
    for (const ch of text) expect(ch.charCodeAt(0)).toBeLessThan(128);
    for (const ch of readFileSync(fakeBundleTs, 'utf8')) expect(ch.charCodeAt(0)).toBeLessThan(128);
  });

  it('uses no PowerShell 7 syntax, no cmd.exe and no download', () => {
    expect(code).not.toMatch(/&&|\|\||\?\?|\?\./);
    expect(code).not.toMatch(/cmd(\.exe)?\s+\/c/i);
    expect(code).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|DownloadFile/i);
    // tools by full System32 path, never by name
    expect(text).toMatch(/Get-SystemTool 'tar\.exe'/);
    expect(text).toMatch(/Get-SystemTool 'icacls\.exe'/);
  });

  it('never deletes with Remove-Item -Recurse (it follows junctions in PowerShell 5.1)', () => {
    expect(code).not.toMatch(/Remove-Item[^\n]*-Recurse/i);
    expect(code).not.toMatch(/Get-ChildItem[^\n]*-Recurse/i);
  });
});

describe.runIf(win)('MaxcomSetup.psm1 (runs)', () => {
  let base = '';
  let counter = 0;
  const prelude = [
    "$ErrorActionPreference = 'Stop'",
    `Import-Module -Name ${q(psm1)} -Force`,
    "function TryIt([scriptblock]$b) { try { & $b | Out-Null; return '' } catch { return [string]$_.Exception.Message } }",
    "function J($o) { Write-Output ('@@' + (ConvertTo-Json -InputObject $o -Compress -Depth 6)) }",
    '',
  ].join('\n');

  function q(p: string): string {
    return "'" + p.replaceAll("'", "''") + "'";
  }

  /** A fresh folder whose name has a space, an ampersand and a quote. */
  function sub(name: string): string {
    const d = join(base, `${name} ${++counter} & 'x'`);
    mkdirSync(d, { recursive: true });
    return d;
  }

  function ps(script: string) {
    const enc = Buffer.from(prelude + script, 'utf16le').toString('base64');
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
      { encoding: 'utf8', timeout: 140000 },
    );
    const line = r.stdout.split(/\r?\n/).reverse().find((l) => l.startsWith('@@'));
    return {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      json: (line ? JSON.parse(line.slice(2)) : undefined) as any,
    };
  }

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "mx p9 & 'setup-"));
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('exports the interface the other setup scripts rely on', () => {
    const r = ps('J @((Get-Module MaxcomSetup).ExportedFunctions.Keys)');
    const want = [
      'Get-MaxcomPaths', 'Test-MaxcomElevated', 'Resolve-SetupScript', 'Write-Step', 'Invoke-Step',
      'Get-UntrustedWriters', 'Test-SafeInstallRoot', 'Set-MaxcomRootAcl', 'Set-MaxcomDataAcl',
      'Test-BundleManifest', 'Test-ArchiveEntries', 'Expand-Release', 'New-WorkspaceLinks', 'Switch-Current',
      'Remove-JunctionSafe', 'Remove-TreeSafe', 'Get-PrivateIPv4', 'Get-PortOwner', 'Read-InstallState', 'Write-InstallState',
    ];
    for (const n of want) expect(r.json).toContain(n);
  });

  it('Get-MaxcomPaths gives every layout path as a full path without trailing slash', () => {
    const root = join(sub('paths'), 'Program Files', 'MAXCOM');
    const data = join(sub('paths'), 'ProgData', 'MAXCOM', 'data');
    const r = ps(`J (Get-MaxcomPaths -InstallRoot ${q(root + '\\')} -DataDir ${q(data + '\\')})`);
    const p = r.json;
    expect(p.InstallRoot).toBe(root);
    expect(p.Current).toBe(join(root, 'current'));
    expect(p.Releases).toBe(join(root, 'releases'));
    expect(p.NodeExe).toBe(join(root, 'runtime', 'node', 'node.exe'));
    expect(p.LiveTools).toBe(join(root, 'tools', 'live'));
    expect(p.Launcher).toBe(join(root, 'launcher.mjs'));
    expect(p.BoxConfig).toBe(join(root, 'box-config.json'));
    expect(p.PreviousTxt).toBe(join(root, 'previous.txt'));
    expect(p.InstallJson).toBe(join(root, 'state', 'install.json'));
    expect(p.PowerBefore).toBe(join(root, 'state', 'power-before.json'));
    expect(p.Bin).toBe(join(root, 'bin'));
    expect(p.DataDir).toBe(data);
    expect(p.Db).toBe(join(data, 'surau.db'));
    expect(p.Secret).toBe(join(data, 'secret'));
    expect(p.Pki).toBe(join(data, 'pki'));
    expect(p.BoxLog).toBe(join(data, 'logs', 'box.log'));
    expect(p.Backups).toBe(join(data, '..', 'backups'));
    expect(p.FirewallCopy).toBe(join(p.MaxcomHome, 'ensure-live-firewall.ps1'));
    for (const v of Object.values(p) as string[]) expect(v.endsWith('\\')).toBe(false);
    // defaults when nothing is given
    const d = ps('J (Get-MaxcomPaths)').json;
    expect(d.InstallRoot.toLowerCase()).toBe(join(process.env.ProgramFiles ?? '', 'MAXCOM').toLowerCase());
    // a relative path is refused: no script uses the current directory
    const rel = ps(`J (TryIt { Get-MaxcomPaths -InstallRoot 'relative\\x' })`);
    expect(rel.json).toMatch(/GAGAL/);
  });

  it('Test-SafeInstallRoot refuses a drive root, a user profile folder, a junction and a path below a junction', () => {
    const dir = sub('safe');
    const real = join(dir, 'real');
    const link = join(dir, 'link');
    mkdirSync(join(real, 'inner'), { recursive: true });
    const good = join(dir, 'MAXCOM uji & satu');
    const r = ps(`
New-Item -ItemType Junction -Path ${q(link)} -Target ${q(real)} | Out-Null
J ([ordered]@{
  driveRoot = (Test-SafeInstallRoot 'C:\\')
  profile = (Test-SafeInstallRoot (Join-Path $env:USERPROFILE 'MAXCOM'))
  usersDir = (Test-SafeInstallRoot 'C:\\Users\\Public\\MAXCOM')
  junction = (Test-SafeInstallRoot ${q(link)} -AllowUserProfile)
  belowJunction = (Test-SafeInstallRoot ${q(join(link, 'inner'))} -AllowUserProfile)
  relative = (Test-SafeInstallRoot 'MAXCOM')
  percent = (Test-SafeInstallRoot ${q(join(dir, '%TEMP%'))} -AllowUserProfile)
  programFiles = (Test-SafeInstallRoot (Join-Path $env:ProgramFiles 'MAXCOM'))
  spaceAndQuote = (Test-SafeInstallRoot ${q(good)} -AllowUserProfile)
  profileReason = ((Get-InstallRootProblem (Join-Path $env:USERPROFILE 'MAXCOM')) -join '|')
})`);
    expect(r.json.driveRoot).toBe(false);
    expect(r.json.profile).toBe(false);
    expect(r.json.usersDir).toBe(false);
    expect(r.json.junction).toBe(false);
    expect(r.json.belowJunction).toBe(false);
    expect(r.json.relative).toBe(false);
    expect(r.json.percent).toBe(false);
    expect(r.json.programFiles).toBe(true);
    expect(r.json.spaceAndQuote).toBe(true);
    expect(r.json.profileReason).toMatch(/profil/);
  });

  it('Test-BundleManifest passes the fake bundle and fails on a changed byte, a missing file and an extra file', () => {
    const dir = sub('manifest');
    const b = makeFakeBundle(dir, { nodeStub: true, extraFiles: { 'setup/readme.txt': 'hello' } });
    const ok = ps(`J (Test-BundleManifest ${q(dir)})`);
    expect(ok.json).toBe(true);

    // one changed byte, same size
    const bytes = readFileSync(b.mediamtxZip);
    const flipped = Buffer.from(bytes);
    flipped[flipped.length - 1] ^= 0xff;
    writeFileSync(b.mediamtxZip, flipped);
    const changed = ps(`J @(Get-BundleManifestProblem ${q(dir)})`);
    expect(changed.json.length).toBe(1);
    expect(changed.json[0]).toMatch(/sha256 tidak sama: payload\/mediamtx/);
    writeFileSync(b.mediamtxZip, bytes);
    expect(ps(`J (Test-BundleManifest ${q(dir)})`).json).toBe(true);

    // size change
    writeFileSync(b.ffmpegZip, Buffer.concat([readFileSync(b.ffmpegZip), Buffer.from('x')]));
    expect(ps(`J @(Get-BundleManifestProblem ${q(dir)})`).json[0]).toMatch(/saiz tidak sama/);
    writeFileSync(b.ffmpegZip, Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]));

    // extra file
    writeFileSync(join(dir, 'payload', 'extra.exe'), 'x');
    expect(ps(`J @(Get-BundleManifestProblem ${q(dir)})`).json[0]).toMatch(/tambahan.*payload\/extra\.exe/);
    rmSync(join(dir, 'payload', 'extra.exe'));

    // missing file
    rmSync(join(dir, 'setup', 'readme.txt'));
    expect(ps(`J @(Get-BundleManifestProblem ${q(dir)})`).json[0]).toMatch(/hilang: setup\/readme\.txt/);
    writeFileSync(join(dir, 'setup', 'readme.txt'), 'hello');

    // manifest.json itself is the one file that may be unlisted; a path that escapes is refused
    const m = JSON.parse(readFileSync(b.manifest, 'utf8'));
    m.files[0].path = '../escape.txt';
    writeFileSync(b.manifest, JSON.stringify(m));
    expect(ps(`J (Test-BundleManifest ${q(dir)})`).json).toBe(false);
  });

  it('Test-ArchiveEntries passes the fake archive and refuses ../x, C:/x, /x, backslash names and link entries', () => {
    const dir = sub('archive');
    const b = makeFakeBundle(dir, { nodeStub: true });
    const bad: Record<string, { name: string; type?: 'symlink' | 'hardlink' | 'file'; linkname?: string }[]> = {
      dotdot: [{ name: 'a/ok.txt' }, { name: '../x' }],
      dotdotMid: [{ name: 'a/../../x' }],
      drive: [{ name: 'C:/x' }],
      rooted: [{ name: '/x' }],
      backslash: [{ name: 'a\\b.txt' }],
      symlink: [{ name: 'ok.txt' }, { name: 'link', type: 'symlink', linkname: 'C:/Windows' }],
      hardlink: [{ name: 'ok.txt' }, { name: 'hl', type: 'hardlink', linkname: 'ok.txt' }],
      device: [{ name: 'apps/CON.txt' }],
      stream: [{ name: 'a.txt:evil' }],
      trailingDot: [{ name: 'dir./x' }],
    };
    for (const [k, entries] of Object.entries(bad)) {
      writeTarGz(join(dir, `bad-${k}.tar.gz`), entries.map((e) => ({ data: 'x', ...e })));
    }
    writeTarGz(join(dir, 'good-dot.tar.gz'), [{ name: './', type: 'dir' as never }, { name: './a/b.txt', data: 'x' }, { name: 'd/', type: 'dir' as never }]);
    const keys = Object.keys(bad);
    const r = ps(`
$res = [ordered]@{ good = (Test-ArchiveEntries ${q(b.archive)}); goodDot = (Test-ArchiveEntries ${q(join(dir, 'good-dot.tar.gz'))}) }
foreach ($k in @(${keys.map((k) => q(k)).join(',')})) {
  $res[$k] = (Test-ArchiveEntries (Join-Path ${q(dir)} ('bad-' + $k + '.tar.gz')))
}
$res.missing = (Test-ArchiveEntries (Join-Path ${q(dir)} 'nope.tar.gz'))
J $res`);
    expect(r.json.good).toBe(true);
    expect(r.json.goodDot).toBe(true);
    for (const k of keys) expect(r.json[k], k).toBe(false);
    expect(r.json.missing).toBe(false);
  });

  it('Expand-Release extracts with links, is a no-op the second time and redoes an interrupted extraction safely', () => {
    const work = sub('expand');
    const releases = join(work, 'root', 'releases');
    const b1 = makeFakeBundle(join(work, 'b1'), { version: '2026.11.1', nodeStub: true });
    const b2 = makeFakeBundle(join(work, 'b2'), { version: '2026.11.2', nodeStub: true });
    const b3 = makeFakeBundle(join(work, 'b3'), { version: '2026.11.3', nodeStub: true });
    const outside = join(work, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'must survive');
    // 2026.11.2: a leftover .part folder; 2026.11.3: a folder without .ok holding a junction to the outside folder
    mkdirSync(join(releases, '2026.11.2.part'), { recursive: true });
    writeFileSync(join(releases, '2026.11.2.part', 'junk.txt'), 'junk');
    mkdirSync(join(releases, '2026.11.3'), { recursive: true });
    const r = ps(`
$rel = ${q(releases)}
$a = Expand-Release -Archive ${q(b1.archive)} -ReleasesDir $rel -Version '2026.11.1'
$okFile = Join-Path $rel '2026.11.1\\.ok'
$t1 = (Get-Item -LiteralPath $okFile).LastWriteTimeUtc.Ticks
Start-Sleep -Milliseconds 1100
$b = Expand-Release -Archive ${q(b1.archive)} -ReleasesDir $rel -Version '2026.11.1'
$t2 = (Get-Item -LiteralPath $okFile).LastWriteTimeUtc.Ticks
$link = Join-Path $rel '2026.11.1\\node_modules\\@surau\\core'
$linkItem = Get-Item -LiteralPath $link -Force
$c = Expand-Release -Archive ${q(b2.archive)} -ReleasesDir $rel -Version '2026.11.2'
New-Item -ItemType Junction -Path (Join-Path $rel '2026.11.3\\evil') -Target ${q(outside)} | Out-Null
$d = Expand-Release -Archive ${q(b3.archive)} -ReleasesDir $rel -Version '2026.11.3'
$wrongVersion = TryIt { Expand-Release -Archive ${q(b1.archive)} -ReleasesDir $rel -Version '2026.11.9' }
$badVersion = TryIt { Expand-Release -Archive ${q(b1.archive)} -ReleasesDir $rel -Version '..\\evil' }
J ([ordered]@{
  firstChanged = $a.Changed; secondChanged = $b.Changed; sameTime = ($t1 -eq $t2)
  linkType = $linkItem.LinkType; linkTarget = ([string]($linkItem.Target | Select-Object -First 1))
  coreSrc = (Test-Path -LiteralPath (Join-Path $link 'src\\index.ts'))
  c = $c.Changed; d = $d.Changed
  wrongVersion = $wrongVersion; badVersion = $badVersion
})`);
    expect(r.status).toBe(0);
    expect(r.json.firstChanged).toBe(true);
    expect(r.json.secondChanged).toBe(false);
    expect(r.json.sameTime).toBe(true);
    expect(r.json.linkType).toBe('Junction');
    expect(r.json.linkTarget.toLowerCase()).toBe(join(releases, '2026.11.1', 'packages', 'core').toLowerCase());
    expect(r.json.coreSrc).toBe(true);
    expect(r.json.c).toBe(true);
    expect(r.json.d).toBe(true);
    expect(r.json.wrongVersion).toMatch(/GAGAL/);
    expect(r.json.badVersion).toMatch(/versi tidak sah/);
    expect(readdirSync(releases).sort()).toEqual(['2026.11.1', '2026.11.2', '2026.11.3']);
    expect(existsSync(join(releases, '2026.11.2', 'junk.txt'))).toBe(false);
    expect(existsSync(join(releases, '2026.11.2', '.ok'))).toBe(true);
    expect(existsSync(join(releases, '2026.11.3', 'evil'))).toBe(false);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('must survive');
  });

  it('Expand-Release refuses a hostile archive before extracting anything', () => {
    const work = sub('hostile');
    const releases = join(work, 'releases');
    const evil = join(work, 'evil.tar.gz');
    writeTarGz(evil, [
      { name: 'release.json', data: JSON.stringify({ v: 1, version: '2026.11.1', workspaceLinks: [] }) },
      { name: '../pwned.txt', data: 'x' },
    ]);
    const r = ps(`J (TryIt { Expand-Release -Archive ${q(evil)} -ReleasesDir ${q(releases)} -Version '2026.11.1' })`);
    expect(r.json).toMatch(/arkib keluaran ditolak/);
    expect(existsSync(join(work, 'pwned.txt'))).toBe(false);
    expect(existsSync(join(releases, '2026.11.1'))).toBe(false);
    expect(existsSync(join(releases, '2026.11.1.part'))).toBe(false);
  });

  it('New-WorkspaceLinks refuses a name or target that leaves the release', () => {
    const work = sub('links');
    const cases: [string, { name: string; target: string }][] = [
      ['dotdot', { name: '@surau/core', target: '..\\..\\Windows' }],
      ['dotdotSlash', { name: '@surau/core', target: '../../Windows' }],
      ['rooted', { name: '@surau/core', target: 'C:/Windows' }],
      ['badScope', { name: '@evil/core', target: 'packages/core' }],
      ['traversalName', { name: '@surau/../x', target: 'packages/core' }],
      ['missingTarget', { name: '@surau/core', target: 'packages/nope' }],
    ];
    for (const [k, link] of cases) {
      const rel = join(work, k);
      mkdirSync(join(rel, 'packages', 'core'), { recursive: true });
      writeFileSync(join(rel, 'release.json'), JSON.stringify({ v: 1, version: '2026.11.1', workspaceLinks: [link] }));
    }
    const good = join(work, 'good');
    mkdirSync(join(good, 'packages', 'core'), { recursive: true });
    writeFileSync(join(good, 'release.json'), JSON.stringify({ v: 1, version: '2026.11.1', workspaceLinks: [{ name: '@surau/core', target: 'packages/core' }] }));
    const r = ps(`
$res = [ordered]@{}
foreach ($k in @(${cases.map(([k]) => q(k)).join(',')})) { $res[$k] = (TryIt { New-WorkspaceLinks (Join-Path ${q(work)} $k) }) }
$res.good = @(New-WorkspaceLinks ${q(good)}).Count
$res.goodAgain = @(New-WorkspaceLinks ${q(good)}).Count
J $res`);
    for (const [k] of cases) expect(r.json[k], k).toMatch(/GAGAL/);
    expect(r.json.good).toBe(1);
    expect(r.json.goodAgain).toBe(0);
    for (const [k] of cases) expect(existsSync(join(work, k, 'node_modules')), k).toBe(false);
  });

  it('Switch-Current moves the junction, writes previous.txt and keeps the old release', () => {
    const work = sub('switch');
    const root = join(work, 'root');
    const b1 = makeFakeBundle(join(work, 'b1'), { version: '2026.11.1', nodeStub: true });
    const b2 = makeFakeBundle(join(work, 'b2'), { version: '2026.11.2', nodeStub: true });
    const r = ps(`
$root = ${q(root)}
$rel = Join-Path $root 'releases'
Expand-Release -Archive ${q(b1.archive)} -ReleasesDir $rel -Version '2026.11.1' | Out-Null
Expand-Release -Archive ${q(b2.archive)} -ReleasesDir $rel -Version '2026.11.2' | Out-Null
Set-Content -LiteralPath (Join-Path $rel '2026.11.1\\marker.txt') -Value 'in A'
$noOk = TryIt { Switch-Current -Root $root -Version '2026.11.7' }
$s1 = Switch-Current -Root $root -Version '2026.11.1'
$prev1 = Test-Path -LiteralPath (Join-Path $root 'previous.txt')
$cur1 = Get-LinkTarget (Join-Path $root 'current')
$viaCurrent = (Get-Content -LiteralPath (Join-Path $root 'current\\release.json') -Raw | ConvertFrom-Json).version
$same = Switch-Current -Root $root -Version '2026.11.1'
$s2 = Switch-Current -Root $root -Version '2026.11.2'
$cur2 = Get-LinkTarget (Join-Path $root 'current')
$viaCurrent2 = (Get-Content -LiteralPath (Join-Path $root 'current\\release.json') -Raw | ConvertFrom-Json).version
J ([ordered]@{
  noOk = $noOk; s1 = $s1.Changed; prev1 = $prev1; cur1 = $cur1; viaCurrent = $viaCurrent
  same = $same.Changed; s2 = $s2.Changed; s2from = $s2.From; cur2 = $cur2; viaCurrent2 = $viaCurrent2
  previous = [string](Get-Content -LiteralPath (Join-Path $root 'previous.txt') -Raw)
  marker = (Test-Path -LiteralPath (Join-Path $rel '2026.11.1\\marker.txt'))
})`);
    expect(r.status).toBe(0);
    expect(r.json.noOk).toMatch(/\.ok tiada/);
    expect(r.json.s1).toBe(true);
    expect(r.json.prev1).toBe(false);
    expect(r.json.cur1.toLowerCase()).toBe(join(root, 'releases', '2026.11.1').toLowerCase());
    expect(r.json.viaCurrent).toBe('2026.11.1');
    expect(r.json.same).toBe(false);
    expect(r.json.s2).toBe(true);
    expect(r.json.s2from).toBe('2026.11.1');
    expect(r.json.cur2.toLowerCase()).toBe(join(root, 'releases', '2026.11.2').toLowerCase());
    expect(r.json.viaCurrent2).toBe('2026.11.2');
    expect(r.json.previous).toBe('2026.11.1');
    expect(r.json.marker).toBe(true);
  });

  it('Remove-JunctionSafe removes only the link; Remove-TreeSafe never follows a junction out of the tree', () => {
    const work = sub('delete');
    const target = join(work, 'target');
    const plain = join(work, 'plain');
    const tree = join(work, 'tree');
    const outside = join(work, 'outside');
    for (const d of [target, plain, join(tree, 'deep', 'er'), outside, join(outside, 'sub')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(target, 't.txt'), 'target file');
    writeFileSync(join(plain, 'p.txt'), 'plain file');
    writeFileSync(join(tree, 'deep', 'er', 'f.txt'), 'in tree');
    writeFileSync(join(outside, 'o.txt'), 'outside');
    writeFileSync(join(outside, 'sub', 'o2.txt'), 'outside 2');
    const link1 = join(work, 'link1');
    const r = ps(`
New-Item -ItemType Junction -Path ${q(link1)} -Target ${q(target)} | Out-Null
New-Item -ItemType Junction -Path ${q(join(tree, 'deep', 'er', 'escape'))} -Target ${q(outside)} | Out-Null
New-Item -ItemType Junction -Path ${q(join(work, 'throughLink'))} -Target ${q(tree)} | Out-Null
(Get-Item -LiteralPath ${q(join(tree, 'deep', 'er', 'f.txt'))}).Attributes = 'ReadOnly'
$removed = Remove-JunctionSafe ${q(link1)}
$onPlain = TryIt { Remove-JunctionSafe ${q(plain)} }
$onMissing = Remove-JunctionSafe ${q(join(work, 'does-not-exist'))}
$outsideUnder = TryIt { Remove-TreeSafe ${q(outside)} -Under ${q(tree)} }
$driveRoot = TryIt { Remove-TreeSafe ${q(tree)} -Under 'C:\\' }
$viaLink = TryIt { Remove-TreeSafe ${q(join(work, 'throughLink', 'deep'))} -Under ${q(work)} }
$tr = Remove-TreeSafe ${q(tree)} -Under ${q(work)}
J ([ordered]@{
  removed = $removed; onPlain = $onPlain; onMissing = $onMissing; outsideUnder = $outsideUnder
  driveRoot = $driveRoot; viaLink = $viaLink; tr = $tr
  linkGone = -not (Test-Path -LiteralPath ${q(link1)})
  treeGone = -not (Test-Path -LiteralPath ${q(tree)})
})`);
    expect(r.status).toBe(0);
    expect(r.json.removed).toBe(true);
    expect(r.json.onPlain).toMatch(/bukan pautan/);
    expect(r.json.onMissing).toBe(false);
    expect(r.json.outsideUnder).toMatch(/di luar/);
    expect(r.json.driveRoot).toMatch(/GAGAL/);
    expect(r.json.viaLink).toMatch(/GAGAL/);
    expect(r.json.tr).toBe(true);
    expect(r.json.linkGone).toBe(true);
    expect(r.json.treeGone).toBe(true);
    expect(readFileSync(join(target, 't.txt'), 'utf8')).toBe('target file');
    expect(readFileSync(join(plain, 'p.txt'), 'utf8')).toBe('plain file');
    expect(readFileSync(join(outside, 'o.txt'), 'utf8')).toBe('outside');
    expect(readFileSync(join(outside, 'sub', 'o2.txt'), 'utf8')).toBe('outside 2');
  });

  it('Set-MaxcomDataAcl leaves SYSTEM, Administrators and the service account only, and children inherit', () => {
    const data = join(sub('acl'), 'data');
    mkdirSync(join(data, 'secret'), { recursive: true });
    writeFileSync(join(data, 'surau.db'), 'db');
    writeFileSync(join(data, 'secret', 'box.key'), 'k');
    const r = ps(`
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$badSid = TryIt { Set-MaxcomDataAcl ${q(data)} -ServiceSid 'x; calc' }
$dry = Set-MaxcomDataAcl ${q(data)} -ServiceSid $me -DryRun
$ret = Set-MaxcomDataAcl ${q(data)} -ServiceSid $me
$again = Set-MaxcomDataAcl ${q(data)} -ServiceSid $me
Set-Content -LiteralPath (Join-Path ${q(data)} 'new.txt') -Value 'new'
New-Item -ItemType Directory -Path (Join-Path ${q(data)} 'newdir') | Out-Null
function Sids($p) { @((Get-Acl -LiteralPath $p).Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique) }
J ([ordered]@{
  me = $me; badSid = $badSid; dry = $dry; ret = $ret; again = $again
  dataProtected = (Get-Acl -LiteralPath ${q(data)}).AreAccessRulesProtected
  dataSids = (Sids ${q(data)})
  dbSids = (Sids (Join-Path ${q(data)} 'surau.db'))
  keySids = (Sids (Join-Path ${q(data)} 'secret\\box.key'))
  newSids = (Sids (Join-Path ${q(data)} 'new.txt'))
  newDirSids = (Sids (Join-Path ${q(data)} 'newdir'))
  dbProtected = (Get-Acl -LiteralPath (Join-Path ${q(data)} 'surau.db')).AreAccessRulesProtected
})
& icacls.exe ${q(data)} /reset /T /C /L /Q | Out-Null`);
    expect(r.status).toBe(0);
    const expected = ['S-1-5-18', 'S-1-5-32-544', r.json.me].sort();
    expect(r.json.badSid).toMatch(/SID/);
    expect(r.json.dry).toBe(false);
    expect(r.json.ret).toBe(true);
    expect(r.json.dataProtected).toBe(true);
    expect(r.json.dbProtected).toBe(false);
    for (const k of ['dataSids', 'dbSids', 'keySids', 'newSids', 'newDirSids']) {
      const sids = [r.json[k]].flat().sort();
      expect(sids, k).toEqual(expected);
      expect(sids, k).not.toContain('S-1-5-32-545'); // Users
      expect(sids, k).not.toContain('S-1-1-0'); // Everyone
      expect(sids, k).not.toContain('S-1-5-11'); // Authenticated Users
    }
  });

  it('data ACL contract: secret and pki exact, a second run changes nothing, a planted writer is flagged, the box account cannot rename secret', () => {
    const data = join(sub('contract'), 'data');
    mkdirSync(join(data, 'secret'), { recursive: true });
    mkdirSync(join(data, 'pki'), { recursive: true });
    writeFileSync(join(data, 'secret', 'box.key'), 'k');
    writeFileSync(join(data, 'pki', 'root-ca.cer'), 'c');
    writeFileSync(join(data, 'surau.db'), 'db');
    const r = ps(`
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$d = ${q(data)}
function Keys($p) { @((Get-Acl -LiteralPath $p).Access | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value, [int]$_.FileSystemRights, [int]$_.InheritanceFlags, [int]$_.PropagationFlags } | Sort-Object) }
function Snap { (@('data','secret','pki','secret\\box.key','pki\\root-ca.cer','surau.db') | ForEach-Object { (& icacls.exe (Join-Path $d $_)) -join '|' }) -join '##' }
$before = @(Get-MaxcomDataAclProblem $d -ServiceSid $me).Count
[void](Set-MaxcomDataAcl $d -ServiceSid $me)
$ok1 = @(Get-MaxcomDataAclProblem $d -ServiceSid $me)
$snap1 = Snap
[void](Set-MaxcomDataAcl $d -ServiceSid $me)
$snap2 = Snap
$secretKeys = Keys (Join-Path $d 'secret')
$pkiKeys = Keys (Join-Path $d 'pki')
$rename = TryIt { [System.IO.Directory]::Move((Join-Path $d 'secret'), (Join-Path $d 'secret-x')) }
$deleteDir = TryIt { [System.IO.Directory]::Delete((Join-Path $d 'pki'), $true) }
$writeKey = TryIt { Set-Content -LiteralPath (Join-Path $d 'secret\\box.key') -Value 'k2' }
$newFile = TryIt { Set-Content -LiteralPath (Join-Path $d 'secret\\new.pfx') -Value 'n' }
& icacls.exe (Join-Path $d 'secret') /grant 'BUILTIN\\Users:(OI)(CI)M' | Out-Null
$planted = @(Get-MaxcomDataAclProblem $d -ServiceSid $me)
[void](Set-MaxcomDataAcl $d -ServiceSid $me)
$healed = @(Get-MaxcomDataAclProblem $d -ServiceSid $me).Count
& icacls.exe (Join-Path $d 'pki') /grant 'BUILTIN\\Users:(M)' | Out-Null
$plantedPki = @(Get-MaxcomDataAclProblem $d -ServiceSid $me)
& icacls.exe $d /reset /T /C /L /Q | Out-Null
J ([ordered]@{ me = $me; before = $before; ok1 = $ok1; same = ($snap1 -ceq $snap2); secretKeys = $secretKeys; pkiKeys = $pkiKeys
  rename = $rename; deleteDir = $deleteDir; writeKey = $writeKey; newFile = $newFile; planted = $planted; healed = $healed; plantedPki = $plantedPki })`);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const j = r.json;
    expect(j.before).toBeGreaterThan(0);
    expect([j.ok1].flat().filter(Boolean)).toEqual([]);
    expect(j.same).toBe(true); // second run: no ACL change at all
    expect(j.secretKeys).toEqual(
      ['S-1-5-18|2032127|3|0', 'S-1-5-32-544|2032127|3|0', `${j.me}|1245631|3|2`, `${j.me}|1180095|0|0`].sort(),
    );
    expect(j.pkiKeys).toEqual(['S-1-5-18|2032127|3|0', 'S-1-5-32-544|2032127|3|0', `${j.me}|1179817|3|0`].sort());
    expect(j.rename).toMatch(/denied|Access/i); // no DELETE on secret\ for the box account
    expect(j.deleteDir).not.toBe(''); // pki\ cannot be deleted either (read only for it)
    expect(j.writeKey).toBe(''); // but the files inside secret\ can be written
    expect(j.newFile).toBe('');
    expect([j.planted].flat().join(' ')).toMatch(/BUILTIN\\Users/);
    expect(j.healed).toBe(0);
    expect([j.plantedPki].flat().join(' ')).toMatch(/BUILTIN\\Users/);
  });

  it('Get-MaxcomHomeProblem refuses a drive-root-style parent, %ProgramData%\\x and a profile, but not a dedicated folder', () => {
    const stand = sub('driveroot'); // stands in for D:\
    writeFileSync(join(stand, 'other.txt'), 'x');
    const only = sub('onlydata');
    mkdirSync(join(only, 'data'));
    const pd = sub('progdata');
    writeFileSync(join(pd, 'Microsoft.txt'), 'x');
    const r = ps(`
$env:MAXCOM_EXTRA_PROTECTED_DIRS = ${q(stand)} + ';' + ${q(only)}
$env:ProgramData = ${q(pd)}
J ([ordered]@{
  driveRoot = @(Get-MaxcomHomeProblem ${q(join(stand, 'surau'))})
  realRoot = @(Get-MaxcomHomeProblem 'C:\\surau')
  onlyData = @(Get-MaxcomHomeProblem ${q(join(only, 'data'))})
  progData = @(Get-MaxcomHomeProblem ${q(join(pd, 'x'))})
  maxcom = @(Get-MaxcomHomeProblem ${q(join(pd, 'MAXCOM', 'data'))})
  deep = @(Get-MaxcomHomeProblem ${q(join(stand, 'surau', 'data'))})
  profile = @(Get-MaxcomHomeProblem (Join-Path $env:USERPROFILE 'data'))
})`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.json.driveRoot.length).toBe(1);
    expect(r.json.realRoot.length).toBe(1);
    expect(r.json.onlyData).toEqual([]);
    expect(r.json.progData.length).toBe(1);
    expect(r.json.maxcom).toEqual([]);
    expect(r.json.deep).toEqual([]);
    expect(r.json.profile.length).toBe(1);
  });

  it('Test-PathInside compares whole segments: C:\\MAXCOM-data is not inside C:\\MAXCOM', () => {
    const r = ps(`J ([ordered]@{
  sibling = (Test-PathInside 'C:\\MAXCOM-data' 'C:\\MAXCOM')
  child = (Test-PathInside 'C:\\MAXCOM\\data' 'C:\\MAXCOM')
  equal = (Test-PathInside 'C:\\MAXCOM' 'C:\\MAXCOM')
  equalOk = (Test-PathInside 'C:\\MAXCOM\\' 'C:\\maxcom' -AllowEqual)
})`);
    expect(r.json).toEqual({ sibling: false, child: true, equal: false, equalOk: true });
  });

  it('Remove-OldBackups keeps the newest 3 pre-<version>-<stamp> folders and the one just made; pre-install-* is never touched', () => {
    const b = sub('bk');
    const names = [
      'pre-1.0.0-20260101-000001', 'pre-1.0.1-20260102-000001', 'pre-1.0.2-20260103-000001',
      'pre-1.0.3-20260104-000001', 'pre-1.0.4-20260105-000001', 'pre-install-20250101-000000', 'notes',
    ];
    for (const n of names) {
      mkdirSync(join(b, n));
      writeFileSync(join(b, n, 'surau.db'), n);
    }
    const r = ps(`J (Remove-OldBackups ${q(b)} -Keep 3 -Except ${q(join(b, 'pre-1.0.4-20260105-000001'))})`);
    expect(r.json).toBe(2);
    expect(readdirSync(b).sort()).toEqual(
      ['notes', 'pre-1.0.2-20260103-000001', 'pre-1.0.3-20260104-000001', 'pre-1.0.4-20260105-000001', 'pre-install-20250101-000000'],
    );
    const again = ps(`J (Remove-OldBackups ${q(b)} -Keep 3)`);
    expect(again.json).toBe(0);
  });

  it('Set-MaxcomRootAcl needs administrator rights (and says so) and prints its plan with -DryRun', () => {
    const root = sub('rootacl');
    const r = ps(`
$dry = Set-MaxcomRootAcl ${q(root)} -DryRun
J ([ordered]@{ elevated = (Test-MaxcomElevated); dry = $dry; refused = (TryIt { Set-MaxcomRootAcl ${q(root)} }) })`);
    expect(r.stdout).toMatch(/DRYRUN acl akar: icacls .*\/inheritance:r .*\*S-1-5-32-545:\(OI\)\(CI\)RX/);
    expect(r.json.dry).toBe(false);
    if (!r.json.elevated) expect(r.json.refused).toMatch(/administrator/);
    // the real icacls run is covered by the controller's proof step on an elevated shell: it would
    // remove this account's own access to the temp folder
  });

  it('Get-UntrustedWriters names a writer that is not SYSTEM, Administrators or TrustedInstaller', () => {
    const dir = sub('writers');
    const r = ps(`
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$mySid = $me.User.Value
& "$env:SystemRoot\\System32\\icacls.exe" ${q(dir)} /inheritance:r /grant:r "*\${mySid}:(OI)(CI)F" | Out-Null
$none = @(Get-UntrustedWriters (Join-Path ${q(dir)} 'missing'))
$bad = @(Get-UntrustedWriters ${q(dir)})
$trusted = @(Get-UntrustedWriters ${q(dir)} -AlsoTrusted @($mySid))
J ([ordered]@{ me = $me.Name; none = $none.Count; bad = $bad; trusted = $trusted.Count })`);
    expect(r.json.none).toBe(0);
    expect(r.json.bad.length).toBeGreaterThanOrEqual(1);
    expect(r.json.bad.join('|')).toContain(r.json.me);
    expect(r.json.trusted).toBe(0);
  });

  it('Invoke-Step prints OK, SET, DRYRUN and GAGAL lines and stops on a failure with the step name', () => {
    const r = ps(`
$script:ran = 0
$a = Invoke-Step -Name 'satu' -Action { $script:ran++; $true }
$b = Invoke-Step -Name 'dua' -Action { $script:ran++; $false }
$c = Invoke-Step -Name 'tiga' -DryRun -Describe 'akan buat folder' -Action { $script:ran++; $true }
$d = TryIt { Invoke-Step -Name 'empat' -Action { throw 'rosak' } }
J ([ordered]@{ a = $a; b = $b; c = $c; ran = $script:ran; d = $d })`);
    expect(r.stdout).toMatch(/^SET satu: selesai$/m);
    expect(r.stdout).toMatch(/^OK dua sudah siap$/m);
    expect(r.stdout).toMatch(/^DRYRUN tiga: akan buat folder$/m);
    expect(r.stdout).toMatch(/^GAGAL: empat: rosak$/m);
    expect(r.json.a).toBe(true);
    expect(r.json.b).toBe(false);
    expect(r.json.c).toBe(false);
    expect(r.json.ran).toBe(2);
    expect(r.json.d).toBe('GAGAL: empat');
  });

  it('Get-PortOwner names the process that listens; Get-PrivateIPv4 lists only private addresses', async () => {
    const server = createServer();
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const port = (server.address() as { port: number }).port;
    try {
      const r = ps(`
$o = @(Get-PortOwner ${port})
$free = @(Get-PortOwner 1)
J ([ordered]@{ owners = $o; free = $free.Count; ips = @(Get-PrivateIPv4) })`);
      expect(r.status).toBe(0);
      expect(r.json.owners.length).toBeGreaterThanOrEqual(1);
      expect(r.json.owners[0].Pid).toBe(process.pid);
      expect(r.json.owners[0].Name.toLowerCase()).toBe('node.exe');
      expect(r.json.owners[0].CommandLine).not.toBe('');
      expect(r.json.free).toBe(0);
      for (const ip of r.json.ips as string[]) {
        expect(ip).toMatch(/^(10\.|192\.16[8]\.|172\.(1[6-9]|2\d|3[01])\.)\d+\.\d+(\.\d+)?$/);
      }
    } finally {
      server.close();
    }
  });

  it('Write-InstallState merges, writes atomically and refuses anything named like a secret', () => {
    const root = sub('state');
    const r = ps(`
$root = ${q(root)}
$none = Read-InstallState $root
Write-InstallState $root -State @{ version = '2026.11.1'; kioskMode = 'khas' } | Out-Null
Write-InstallState $root -State @{ ip = '10.168.1.14'; paths = @{ data = 'C:\\ProgramData\\MAXCOM\\data' } } | Out-Null
$bad1 = TryIt { Write-InstallState $root -State @{ pfxPass = 'x' } }
$bad2 = TryIt { Write-InstallState $root -State @{ ok = @{ apiKey = 'x' } } }
$s = Read-InstallState $root
J ([ordered]@{ none = ($null -eq $none); state = $s; bad1 = $bad1; bad2 = $bad2 })`);
    expect(r.json.none).toBe(true);
    expect(r.json.state.v).toBe(1);
    expect(r.json.state.version).toBe('2026.11.1');
    expect(r.json.state.kioskMode).toBe('khas');
    expect(r.json.state.ip).toBe('10.168.1.14');
    expect(r.json.state.paths.data).toBe('C:\\ProgramData\\MAXCOM\\data');
    expect(r.json.bad1).toMatch(/rahsia/);
    expect(r.json.bad2).toMatch(/rahsia/);
    expect(readdirSync(join(root, 'state'))).toEqual(['install.json']);
    expect(statSync(join(root, 'state', 'install.json')).size).toBeGreaterThan(10);
    expect(readFileSync(join(root, 'state', 'install.json'), 'utf8')).not.toMatch(/pfx|secret|apiKey/i);
  });

  it('Resolve-SetupScript finds the module folder and its parent, and refuses path tricks', () => {
    const r = ps(`
J ([ordered]@{
  here = (Resolve-SetupScript 'MaxcomSetup.psm1')
  parent = (Resolve-SetupScript 'box-ca.ps1')
  trick = (TryIt { Resolve-SetupScript '..\\box-ca.ps1' })
  missing = (TryIt { Resolve-SetupScript 'no-such-script.ps1' })
})`);
    expect(r.json.here.toLowerCase()).toBe(psm1.replaceAll('/', '\\').toLowerCase());
    expect(r.json.parent.toLowerCase()).toMatch(/\\scripts\\box-ca\.ps1$/);
    expect(r.json.trick).toMatch(/GAGAL/);
    expect(r.json.missing).toMatch(/tidak dijumpai/);
  });
});
