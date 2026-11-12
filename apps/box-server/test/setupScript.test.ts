import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { makeFakeBundle, type FakeBundle } from './helpers/fakeBundle.ts';

const setupPath = fileURLToPath(new URL('../../../scripts/setup/setup.ps1', import.meta.url));
const cmdPath = fileURLToPath(new URL('../../../scripts/setup/Pasang MAXCOM.cmd', import.meta.url));
const src = readFileSync(setupPath, 'utf8');
const cmd = readFileSync(cmdPath, 'utf8');
const isWin = process.platform === 'win32';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "maxcom uji & 'setup' "));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('setup.ps1 static checks', () => {
  it('setup.ps1 and Pasang MAXCOM.cmd are pure ASCII with CRLF line ends', () => {
    for (const text of [src, cmd]) {
      for (let i = 0; i < text.length; i++) expect(text.charCodeAt(i)).toBeLessThan(128);
      expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    }
  });

  it('prints the required Bahasa Malaysia lines', () => {
    expect(src).toContain('Pemasangan MAX Kiosk Server selesai.');
    expect(src).toContain('GAGAL:');
    expect(src).toContain('Imbas kod QR pada skrin dengan aplikasi MAX Admin Client');
    expect(src).toContain('Telefon yang sudah didaftar terus boleh digunakan');
  });

  it('does not download anything and does not use PowerShell 7 syntax', () => {
    expect(src).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|DownloadFile|DownloadString/);
    expect(src).not.toContain('&&');
    expect(src).not.toMatch(/\?\?|\?\./);
  });

  it('self-elevates with Start-Process -Verb RunAs and an argument array of quoted values', () => {
    expect(src).toMatch(/Start-Process[^\n]*-ArgumentList \$a -Verb RunAs/);
    expect(src).toContain('$a = @(');
    expect(src).toContain('ConvertTo-QuotedArg');
    expect(src).not.toMatch(/-ArgumentList\s+["'$(][^$\n]*-join/);
  });

  it('calls its sibling scripts through Resolve-SetupScript and applies the data ACL after box-ca.ps1', () => {
    expect(src).toContain('Resolve-SetupScript $Name');
    const i = src.indexOf("Invoke-SetupScript 'box-ca.ps1' $a)");
    expect(i).toBeGreaterThan(0);
    const after = src.slice(i, i + 400);
    expect(after).toContain('Set-MaxcomDataAcl');
    expect(src).toContain('-AsSystem');
    expect(src).toContain("'-ScriptDir', $P.Bin");
    expect(src).toContain('$LASTEXITCODE');
  });

  it('has no private Test-PathInside copy, applies the one data ACL contract, restores the task in a finally, keeps 3 backups, records the root thumbprint', () => {
    expect(src).not.toMatch(/function Test-PathInside/);
    expect(src).not.toContain("TrimEnd('')");
    expect(src).toContain('Test-MaxcomDataAcl');
    expect(src).toContain('Get-MaxcomHomeProblem');
    expect(src).toMatch(/\} finally \{\s+Restore-AfterFailure/);
    expect(src).toMatch(/function Restore-AfterFailure[\s\S]*Enable-ScheduledTask -TaskName 'MAXCOM Box'/);
    expect(src).toContain('$script:TaskDisabled = $true');
    expect(src).toContain('Remove-OldBackups $P.Backups -Keep 3 -Except $dir');
    expect(src).toContain("'-LogDir', $P.HomeLogs");
    expect(src).toContain('rootThumbprint');
    expect(src).toContain('ToUpperInvariant()');
    // the old hand-run box: the command line migrate-data printed is shown again after a failure
    expect(src).toContain('Untuk menghidupkannya semula');
    expect(src).toContain('Folder datanya TIDAK diubah');
    // the migration certificate check happens in the preflight, before anything is stopped
    const pre = src.slice(src.indexOf('function Invoke-Preflight'), src.indexOf('function Start-Elevated'));
    expect(pre).toContain('box-ca.json');
    expect(pre).toContain('-NewRoot');
  });

  it('Pasang MAXCOM.cmd runs setup\\setup.ps1 with the arguments and pauses', () => {
    expect(cmd).toContain('@echo off');
    expect(cmd).toContain('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\\setup.ps1" %*');
    expect(cmd).toMatch(/\r\npause\r\n/);
  });
});

interface Env {
  base: string;
  root: string;
  data: string;
  bundle: FakeBundle;
  pins: string;
}

function writePins(file: string, fb: FakeBundle): void {
  const pins = {
    node: { version: '24.0.0', url: `https://nodejs.org/dist/v24.0.0/${fb.nodeZipName}`, sha256: fb.sha256.nodeZip, licence: 'MIT' },
    mediamtx: { version: 'v1.0.0', url: 'https://example.invalid/mediamtx_v1.0.0_windows_amd64.zip', sha256: fb.sha256.mediamtxZip, licence: 'MIT' },
    ffmpeg: { version: 'fake', url: 'https://example.invalid/ffmpeg-fake-win64.zip', sha256: fb.sha256.ffmpegZip, licence: 'GPL-3.0' },
  };
  writeFileSync(file, JSON.stringify(pins, null, 2));
}

function makeEnv(version = '2026.11.1', nodeStub = true): Env {
  const base = tmp();
  const bundle = makeFakeBundle(join(base, 'bundle'), { version, nodeStub });
  const pins = join(base, 'release-pins.json');
  writePins(pins, bundle);
  return { base, root: join(base, 'Program Files', 'MAXCOM'), data: join(base, 'data'), bundle, pins };
}

function runSetup(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', setupPath, ...args],
    { encoding: 'utf8', timeout: 150_000, env: { ...process.env, ...env } },
  );
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function layoutArgs(e: Env, extra: string[] = []): string[] {
  return [
    '-LayoutOnly', '-Yes', '-InstallRoot', e.root, '-DataDir', e.data, '-BundleDir', e.bundle.dir,
    '-PinsFile', e.pins, '-Ip', '127.0.0.1', '-Surau', 'Uji', '-Kiosk', 'tiada', '-Port', '18787', ...extra,
  ];
}

function listFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listFiles(p, out);
    else out.push(p);
  }
  return out;
}

describe.runIf(isWin)('setup.ps1 runs', () => {
  it('-DryRun prints the eleven steps in order and creates nothing', () => {
    const e = makeEnv();
    const suffix = Math.random().toString(36).slice(2, 8);
    const root = `C:\\MAXCOM-uji-${suffix}`;
    const data = `C:\\ProgramData\\MAXCOM-uji-${suffix}\\data`;
    const r = runSetup([
      '-DryRun', '-Yes', '-InstallRoot', root, '-DataDir', data, '-BundleDir', e.bundle.dir, '-PinsFile', e.pins,
      '-Ip', '127.0.0.1', '-Surau', 'Uji', '-Kiosk', 'tiada',
    ]);
    expect(r.status, r.out).toBe(0);
    const lines = r.out.split(/\r?\n/).filter((l) => /^DRYRUN [0-9]+ /.test(l));
    expect(lines.length).toBe(11);
    lines.forEach((l, i) => expect(l.startsWith(`DRYRUN ${i + 1} `), l).toBe(true));
    expect(existsSync(root)).toBe(false);
    expect(existsSync(`C:\\ProgramData\\MAXCOM-uji-${suffix}`)).toBe(false);
  });

  it('-DryRun refuses a data folder whose parent is %ProgramData% or another shared folder (setup would lock all of it)', () => {
    const e = makeEnv();
    const suffix = Math.random().toString(36).slice(2, 8);
    const common = ['-DryRun', '-Yes', '-InstallRoot', `C:\\MAXCOM-uji-${suffix}`, '-BundleDir', e.bundle.dir, '-PinsFile', e.pins, '-Ip', '127.0.0.1', '-Surau', 'Uji', '-Kiosk', 'tiada'];
    let r = runSetup([...common, '-DataDir', `C:\\ProgramData\\uji-${suffix}`]);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/GAGAL: pra-semak: folder induk bagi folder data/);
    expect(r.out).not.toMatch(/^DRYRUN [0-9]+ /m);
    // a folder with other things in it, standing in for a drive root (D:\surau style)
    r = runSetup([...common, '-DataDir', join(e.base, 'surau')], { MAXCOM_EXTRA_PROTECTED_DIRS: e.base });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/bukan folder khas MAXCOM/);
    expect(existsSync(join(e.base, 'surau'))).toBe(false);
  });

  it('-DryRun -MigrateFrom: an old root certificate that cannot be used here is refused BEFORE anything is stopped, unless -NewRoot', () => {
    const e = makeEnv();
    const from = join(e.base, 'old data');
    mkdirSync(join(from, 'secret'), { recursive: true });
    mkdirSync(join(from, 'pki'), { recursive: true });
    writeFileSync(join(from, 'surau.db'), 'db');
    writeFileSync(join(from, 'secret', 'box.key'), Buffer.alloc(32, 1));
    writeFileSync(join(from, 'pki', 'box-ca.json'), JSON.stringify({ ip: '10.168.1.5', store: 'CurrentUser', surau: 'X', days: 730, noTrust: false }));
    const suffix = Math.random().toString(36).slice(2, 8);
    const args = [
      '-DryRun', '-Yes', '-InstallRoot', `C:\\MAXCOM-uji-${suffix}`, '-DataDir', `C:\\ProgramData\\MAXCOM-uji-${suffix}\\data`,
      '-BundleDir', e.bundle.dir, '-PinsFile', e.pins, '-Ip', '127.0.0.1', '-Surau', 'Uji', '-Kiosk', 'tiada', '-MigrateFrom', from,
    ];
    let r = runSetup(args);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/AMARAN: kunci sijil akar kotak lama tiada/);
    expect(r.out).toMatch(/GAGAL: pra-semak: sijil akar kotak lama/);
    expect(r.out).not.toMatch(/^DRYRUN [0-9]+ /m);
    r = runSetup([...args, '-NewRoot']);
    expect(r.out).toMatch(/AMARAN: kunci sijil akar/);
    expect(r.out).not.toMatch(/GAGAL: pra-semak: sijil akar/);
    expect(r.status, r.out).toBe(0);
    // the old data folder is never touched
    expect(readFileSync(join(from, 'surau.db'), 'utf8')).toBe('db');
  });

  it('-DryRun with an install root under the user profile is refused', () => {
    const e = makeEnv();
    const r = runSetup([
      '-DryRun', '-Yes', '-InstallRoot', e.root, '-DataDir', 'C:\\ProgramData\\MAXCOM-uji-x\\data', '-BundleDir', e.bundle.dir,
      '-PinsFile', e.pins, '-Ip', '127.0.0.1', '-Kiosk', 'tiada',
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('GAGAL:');
    expect(r.out).toMatch(/profil pengguna/);
    expect(r.out).not.toMatch(/^DRYRUN /m);
    expect(existsSync(e.root)).toBe(false);
  });

  it('-LayoutOnly lays out the tree, then a second identical run reports every step as done and changes no file', () => {
    const e = makeEnv();
    const r = runSetup(layoutArgs(e));
    expect(r.status, r.out).toBe(0);
    const ok = join(e.root, 'releases', '2026.11.1', '.ok');
    expect(existsSync(ok)).toBe(true);
    expect(existsSync(join(e.root, 'current', 'apps', 'box-server', 'src', 'main.ts'))).toBe(true);
    expect(existsSync(join(e.root, 'current', 'node_modules', '@surau', 'core', 'package.json'))).toBe(true);
    expect(existsSync(join(e.root, 'runtime', 'node', 'node.exe'))).toBe(true);
    for (const f of ['launcher.mjs', 'start.cmd', 'box-config.json']) expect(existsSync(join(e.root, f)), f).toBe(true);
    for (const f of ['setup.ps1', 'MaxcomSetup.psm1', 'box-ca.ps1', 'install-box-task.ps1', 'cli.mjs', 'maxcom.cmd']) {
      expect(existsSync(join(e.root, 'bin', f)), f).toBe(true);
    }
    const cfg = JSON.parse(readFileSync(join(e.root, 'box-config.json'), 'utf8'));
    expect(cfg.v).toBe(1);
    expect(cfg.dataDir).toBe(e.data);
    expect(cfg.env.SURAU_PORT).toBe('18787');
    expect(cfg.env).not.toHaveProperty('SURAU_ROLE');
    const stateText = readFileSync(join(e.root, 'state', 'install.json'), 'utf8');
    const state = JSON.parse(stateText);
    expect(state.version).toBe('2026.11.1');
    for (const k of Object.keys(state)) expect(k).not.toMatch(/pass|secret|token|pfx|pwd|private|key/i);
    expect(existsSync(e.data)).toBe(true);

    const before = new Map(listFiles(e.root).map((p) => [p, statSync(p).mtimeMs]));
    const r2 = runSetup(layoutArgs(e));
    expect(r2.status, r2.out).toBe(0);
    for (const n of ['1 salin-persediaan', '3 runtime-alat', '4 keluaran', '5 konfigurasi', '6 folder-data']) {
      expect(r2.out, n).toContain(`OK ${n} sudah siap`);
    }
    expect(r2.out).not.toMatch(/^SET /m);
    const after = listFiles(e.root);
    expect(after.length).toBe(before.size);
    for (const p of after) expect(statSync(p).mtimeMs, p).toBe(before.get(p));
  });

  it('a changed byte in the bundle stops at the preflight with GAGAL and creates nothing', () => {
    const e = makeEnv();
    writeFileSync(e.bundle.mediamtxZip, Buffer.from('tampered'));
    const r = runSetup(layoutArgs(e));
    expect(r.status).toBe(1);
    expect(r.out).toContain('GAGAL:');
    expect(r.out).toMatch(/sha256 tidak sama|saiz tidak sama/);
    expect(existsSync(e.root)).toBe(false);
    expect(existsSync(e.data)).toBe(false);
  });

  it('a second version installs beside the first, previous.txt names the first and the database is copied', () => {
    const e1 = makeEnv('2026.11.1');
    const r1 = runSetup(layoutArgs(e1));
    expect(r1.status, r1.out).toBe(0);
    mkdirSync(e1.data, { recursive: true });
    writeFileSync(join(e1.data, 'surau.db'), 'fake database bytes');

    const b2 = makeFakeBundle(join(e1.base, 'bundle2'), { version: '2026.11.2', nodeStub: true });
    const pins2 = join(e1.base, 'release-pins2.json');
    writePins(pins2, b2);
    const r2 = runSetup(layoutArgs({ ...e1, bundle: b2, pins: pins2 }));
    expect(r2.status, r2.out).toBe(0);
    expect(readFileSync(join(e1.root, 'previous.txt'), 'utf8')).toBe('2026.11.1');
    expect(existsSync(join(e1.root, 'releases', '2026.11.1', '.ok'))).toBe(true);
    expect(existsSync(join(e1.root, 'releases', '2026.11.2', '.ok'))).toBe(true);
    expect(existsSync(join(e1.root, 'current', 'release.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(e1.root, 'current', 'release.json'), 'utf8')).version).toBe('2026.11.2');
    const backups = join(e1.base, 'backups');
    const pre = readdirSync(backups).filter((n) => n.startsWith('pre-2026.11.2-'));
    expect(pre.length).toBe(1);
    expect(readFileSync(join(backups, pre[0], 'surau.db'), 'utf8')).toBe('fake database bytes');
  });

  it('refuses to install an older version over a newer one', () => {
    const e2 = makeEnv('2026.11.2');
    expect(runSetup(layoutArgs(e2)).status).toBe(0);
    const b1 = makeFakeBundle(join(e2.base, 'bundle1'), { version: '2026.11.1', nodeStub: true });
    const pins1 = join(e2.base, 'release-pins1.json');
    writePins(pins1, b1);
    const r = runSetup(layoutArgs({ ...e2, bundle: b1, pins: pins1 }));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: 4 keluaran/);
    expect(readFileSync(join(e2.root, 'current', 'release.json'), 'utf8')).toContain('2026.11.2');
  });
});

describe('setup.ps1 locks %ProgramData%\\MAXCOM before data\\ (static)', () => {
  it('Initialize-MaxcomHome runs first in the data and backups steps and uses icacls with inheritance off', () => {
    const fn = src.indexOf('function Initialize-MaxcomHome');
    expect(fn).toBeGreaterThan(0);
    const body = src.slice(fn, src.indexOf('function Initialize-BackupsDir'));
    expect(body).toContain('/inheritance:r');
    expect(body).toContain('/setowner');
    expect(body).toContain('S-1-5-32-545');
    expect(body).toContain('(OI)(CI)RX');
    expect(body).toMatch(/if \(-not \$S\.LayoutOnly\)/);
    const bk = src.slice(src.indexOf('function Initialize-BackupsDir'));
    expect(bk.indexOf('Initialize-MaxcomHome')).toBeGreaterThan(0);
    expect(bk.indexOf('Initialize-MaxcomHome')).toBeLessThan(bk.indexOf('CreateDirectory'));
    const df = src.slice(src.indexOf('function Step-DataFolder'));
    expect(df.indexOf('Initialize-MaxcomHome')).toBeGreaterThan(0);
    expect(df.indexOf('Initialize-MaxcomHome')).toBeLessThan(df.indexOf('CreateDirectory($P.DataDir)'));
  });

  it('copies the pins file into bin so doctor can compare versions', () => {
    expect(src).toContain("(Join-Path $P.Bin 'release-pins.json')");
  });

  it('names the product MAX Kiosk Server in the Apps list, with the icon, and keeps the MAXCOM folders', () => {
    expect(src).toContain("DisplayName = 'MAX Kiosk Server'");
    expect(src).toContain("Publisher = 'MAXCOM'");
    expect(src).toContain("$want['DisplayIcon'] = $icoUse");
    expect(src).toContain("Join-Path $P.Bin 'maxcom.ico'");
    expect(src).toContain('$e.IconLocation');
    expect(src).toContain('$s.IconLocation = $iconWant');
    expect(src).toContain("'Semak MAXCOM.cmd', 'Buang MAXCOM.cmd', 'maxcom.ico'");
    expect(src).not.toContain("DisplayName = 'MAXCOM'");
    const psm = readFileSync(join(dirname(setupPath), 'MaxcomSetup.psm1'), 'utf8');
    expect(psm).toMatch(/UninstallKey\s*=\s*'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MAXCOM'/);
    expect(psm).toMatch(/StartMenu\s*=\s*\$startMenu/);
    expect(psm).toMatch(/Programs\\MAXCOM'/);
  });
});

describe.runIf(isWin)('setup.ps1 ProgramData folder and installed layout', () => {
  /** A data folder whose parent ("MaxcomHome") is <base>\pd, created by the test. */
  function homeEnv() {
    const e = makeEnv();
    const home = join(e.base, 'pd');
    return { e, home, data: join(home, 'data') };
  }
  function args(e: Env, data: string, extra: string[] = []): string[] {
    return layoutArgs({ ...e, data }, extra);
  }
  function junction(target: string, link: string): void {
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link, 'junction');
  }

  it('refuses a %ProgramData%\\MAXCOM that is a junction and creates nothing through it', () => {
    const { e, home, data } = homeEnv();
    const elsewhere = join(e.base, 'elsewhere');
    junction(elsewhere, home);
    try {
      const r = runSetup(args(e, data));
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(/GAGAL: pra-semak: pautan \(reparse point\)/);
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(existsSync(e.root)).toBe(false);
    } finally {
      rmdirSync(home);
    }
  });

  it('refuses a data\\ that is a junction, before any step runs', () => {
    const { e, home, data } = homeEnv();
    mkdirSync(home, { recursive: true });
    const elsewhere = join(e.base, 'elsewhere');
    junction(elsewhere, data);
    try {
      const r = runSetup(args(e, data));
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(/pautan \(reparse point\)/);
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(existsSync(e.root)).toBe(false);
    } finally {
      rmdirSync(data);
    }
  });

  it('refuses a backups\\ that is a junction', () => {
    const { e, home, data } = homeEnv();
    mkdirSync(home, { recursive: true });
    const elsewhere = join(e.base, 'elsewhere');
    junction(elsewhere, join(home, 'backups'));
    try {
      const r = runSetup(args(e, data));
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(/pautan \(reparse point\)/);
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      rmdirSync(join(home, 'backups'));
    }
  });

  it('a pre-created folder that others can write is reported, and the plan to reset it is printed (-LayoutOnly warns, -DryRun plans)', () => {
    const { e, home, data } = homeEnv();
    mkdirSync(home, { recursive: true }); // made by this (non-elevated) user: user-writable, like a planted folder
    const lay = runSetup(args(e, data));
    expect(lay.status, lay.out).toBe(0);
    expect(lay.out).toMatch(/AMARAN pra-semak: folder .* boleh ditulis oleh/);
    expect(lay.out).toContain('menetapkan semula');
    // -DryRun needs a root outside the user profile, so it points at drive-root paths and creates nothing
    const suffix = Math.random().toString(36).slice(2, 8);
    const dryHome = `C:\\ProgramData\\MAXCOM-uji-${suffix}`;
    const dry = runSetup([
      '-DryRun', '-Yes', '-InstallRoot', `C:\\MAXCOM-uji-${suffix}`, '-DataDir', `${dryHome}\\data`, '-BundleDir', e.bundle.dir,
      '-PinsFile', e.pins, '-Ip', '127.0.0.1', '-Surau', 'Uji', '-Kiosk', 'tiada',
    ]);
    expect(dry.status, dry.out).toBe(0);
    const line = dry.out.split(/\r?\n/).find((l) => l.startsWith('DRYRUN kunci folder')) ?? '';
    expect(line).toContain(dryHome);
    expect(line).toContain('/inheritance:r');
    expect(line).toContain('Administrators:(OI)(CI)F');
    expect(line).toContain('Users:(OI)(CI)RX');
    expect(existsSync(dryHome)).toBe(false);
  });

  it('-LayoutOnly copies release-pins.json into bin', () => {
    const e = makeEnv();
    const r = runSetup(layoutArgs(e));
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(e.root, 'bin', 'release-pins.json'), 'utf8')).toBe(readFileSync(e.pins, 'utf8'));
  });

  it('<root>\\bin\\maxcom.cmd runs a CLI of the installed release against the install data (bin layout)', () => {
    const e = makeEnv('2026.11.1', false);
    const r = runSetup(layoutArgs(e));
    expect(r.status, r.out).toBe(0);
    const cliDir = join(e.root, 'current', 'apps', 'box-server', 'src', 'cli');
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(cliDir, 'hello.ts'), "console.log('HELLO ' + process.env.SURAU_DB + ' | ' + process.env.SURAU_DATA_DIR);\n");
    const cmdFile = join(e.root, 'bin', 'maxcom.cmd');
    const run = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${cmdFile}" hello"`], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsVerbatimArguments: true,
    });
    const out = `${run.stdout}${run.stderr}`;
    expect(run.status, out).toBe(0);
    expect(out).toContain(`HELLO ${join(e.data, 'surau.db')} | ${e.data}`);
  });
});
