import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const setupDir = fileURLToPath(new URL('../../../scripts/setup/', import.meta.url));
const uninstallPs1 = join(setupDir, 'uninstall.ps1');
const switchPs1 = join(setupDir, 'switch-release.ps1');
const cmdFile = join(setupDir, 'Buang MAXCOM.cmd');
const win = process.platform === 'win32';

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

describe('uninstall.ps1, switch-release.ps1, Buang MAXCOM.cmd (static)', () => {
  const files = [uninstallPs1, switchPs1, cmdFile];
  const code = (f: string) =>
    readFileSync(f, 'utf8')
      .replace(/<#[\s\S]*?#>/g, '')
      .replace(/^\s*#.*$/gm, '');

  it('is ASCII only, CRLF, and uses no PowerShell 7 syntax', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const ch of text) expect(ch.charCodeAt(0), f).toBeLessThan(128);
      expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    }
    for (const f of [uninstallPs1, switchPs1]) expect(code(f)).not.toMatch(/&&|\|\||\?\?|\?\./);
  });

  it('deletes only through Remove-TreeSafe / Remove-JunctionSafe, stops processes by PID only, builds no cmd line', () => {
    for (const f of [uninstallPs1, switchPs1]) {
      const c = code(f);
      expect(c, f).not.toMatch(/Remove-Item/i);
      expect(c, f).not.toMatch(/-Recurse/i);
      expect(c, f).not.toMatch(/IO\.(File|Directory)\]::Delete|\brmdir\b|\bdel\b\s|\brd\b\s/i);
      expect(c, f).not.toMatch(/cmd(\.exe)?\s+\/c/i);
      expect(c, f).not.toMatch(/Stop-Process\s+-Name|Get-Process\s+-Name|taskkill|Stop-Process\s+(?!-Id)/i);
      expect(c, f).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod/i);
    }
    const u = code(uninstallPs1);
    expect(u).toMatch(/Remove-TreeSafe/);
    expect(u).toMatch(/Remove-JunctionSafe/);
    // every Remove-TreeSafe call names the folder it may not leave
    for (const m of u.matchAll(/Remove-TreeSafe[^\n]*/g)) expect(m[0]).toMatch(/-Under/);
    // the only other delete is the Apps list registry key, by exact name
    expect(u).toMatch(/DeleteSubKey\('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MAXCOM'/);
  });

  it('names the tasks and rules exactly and asks the plan questions in BM', () => {
    const u = readFileSync(uninstallPs1, 'utf8');
    for (const n of ['MAXCOM Kiosk', 'MAXCOM Box', 'MaxcomCertRenew', 'MAXCOM Live Firewall', 'MAXCOM Live WebRTC', 'MAXCOM Live SRT', 'MAXCOM Box HTTPS']) {
      expect(u).toContain(`'${n}'`);
    }
    expect(u).toContain('Buang perisian MAX Kiosk Server dari PC ini? Data surau DIKEKALKAN. (y/t)');
    expect(u).toContain('BUANG DATA');
    expect(u).toContain('BUANG SIJIL');
  });

  it('self-elevates like setup.ps1 (argument array, RunAs) and takes the CA thumbprint from install.json', () => {
    const u = code(uninstallPs1);
    expect(u).toMatch(/function Start-Elevated/);
    expect(u).toMatch(/Start-Process[^\n]*-ArgumentList \$a -Verb RunAs -Wait -PassThru/);
    expect(u).toMatch(/\$a \+= '-PauseAtEnd'/);
    expect(u).toMatch(/\$state\.rootThumbprint/);
    // the key is deleted for ECDSA and RSA, and a failed key delete is an error, not a message
    expect(u).toMatch(/ECDsaCertificateExtensions\]::GetECDsaPrivateKey/);
    expect(u).toMatch(/RSACertificateExtensions\]::GetRSAPrivateKey/);
    expect(u).toMatch(/throw 'kunci peribadi sijil root CA tidak dapat dibuang/);
    expect(u).toMatch(/CN=MAXCOM Root CA\*/);
    // the elevation request comes before the typed words and the question
    expect(u.indexOf('$code = Start-Elevated')).toBeGreaterThan(-1);
    expect(u.indexOf('$code = Start-Elevated')).toBeLessThan(u.indexOf('$haveData = $true'));
  });

  it('switch-release disables the task before the swap, re-enables it in a finally, and shows the doctor output', () => {
    const s = code(switchPs1);
    const dis = s.indexOf('Disable-ScheduledTask -TaskName');
    const stop = s.indexOf('Stop-ScheduledTask -TaskName');
    const swap = s.indexOf('Switch-Current');
    const fin = s.indexOf('} finally {');
    expect(dis).toBeGreaterThan(-1);
    expect(dis).toBeLessThan(stop);
    expect(stop).toBeLessThan(swap);
    expect(fin).toBeGreaterThan(swap);
    expect(s.indexOf('Enable-ScheduledTask', fin)).toBeGreaterThan(fin);
    expect(s).toMatch(/-Wait 90 \| ForEach-Object \{ Write-Host/);
    expect(s).toMatch(/\$doctorExit = \$LASTEXITCODE/);
  });

  it('Buang MAXCOM.cmd is one command line plus pause, started from %TEMP%', () => {
    const lines = readFileSync(cmdFile, 'utf8').split(/\r\n/).filter((l) => l.trim() !== '' && !/^@echo off$/i.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/pause/);
    expect(lines[0]).toMatch(/uninstall\.ps1/);
    expect(lines[0]).toMatch(/cd \/d "%TEMP%"/);
  });
});

describe.runIf(win)('uninstall.ps1 and switch-release.ps1 (run, temp folders only)', () => {
  let base = '';
  let counter = 0;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'maxcom uninstall '));
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  interface Layout {
    dir: string;
    root: string;
    data: string;
    backups: string;
    outside: string;
  }

  function hashList(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d).sort()) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else out.push(`${p.slice(dir.length)}:${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
      }
    };
    walk(dir);
    return out;
  }

  function put(p: string, text: string) {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  }

  /** A fake installed layout: two releases (.ok), current junction, previous.txt, data, backups and an outside folder. */
  function makeLayout(opts: { installJson?: boolean; dataInsideRoot?: boolean } = {}): Layout {
    const dir = join(base, `MAXCOM uji ${++counter} & 'satu'`);
    const root = join(dir, 'Program MAXCOM');
    const data = opts.dataInsideRoot ? join(root, 'data') : join(dir, 'MAXCOM Home', 'data');
    const backups = join(dir, 'MAXCOM Home', 'backups');
    const outside = join(dir, 'outside folder');
    put(join(outside, 'precious.txt'), 'do not delete me');
    put(join(outside, 'sub', 'more.txt'), 'nor me');
    mkdirSync(root, { recursive: true });
    if (opts.installJson !== false) put(join(root, 'state', 'install.json'), JSON.stringify({ v: 1, version: '2.0.0' }));
    put(join(root, 'launcher.mjs'), '// fake launcher\n');
    put(join(root, 'start.cmd'), '@echo off\r\n');
    put(join(root, 'box-config.json'), JSON.stringify({ v: 1, dataDir: data, env: {} }));
    for (const v of ['1.0.0', '2.0.0']) {
      const rel = join(root, 'releases', v);
      put(join(rel, 'release.json'), JSON.stringify({ version: v }));
      put(join(rel, '.ok'), v);
      put(join(rel, 'packages', 'core', 'core.ts'), `core ${v}`);
      mkdirSync(join(rel, 'node_modules', '@surau'), { recursive: true });
      symlinkSync(join(rel, 'packages', 'core'), join(rel, 'node_modules', '@surau', 'core'), 'junction');
    }
    symlinkSync(join(root, 'releases', '2.0.0'), join(root, 'current'), 'junction');
    writeFileSync(join(root, 'previous.txt'), '1.0.0');
    // a junction inside the root that points at a folder outside it
    mkdirSync(join(root, 'tools', 'live'), { recursive: true });
    symlinkSync(outside, join(root, 'tools', 'live', 'outlink'), 'junction');
    put(join(root, 'bin', 'MaxcomSetup.psm1'), '# module copy\n');
    put(join(data, 'surau.db'), 'NEW DB');
    put(join(data, 'surau.db-wal'), 'NEW WAL');
    put(join(data, 'secret', 'box.key'), 'not a real key');
    put(join(data, 'pki', 'root-ca.cer'), 'not a real cert');
    put(join(data, 'logs', 'box.log'), 'log line\n');
    put(join(backups, 'pre-2.0.0-20260101-000000', 'surau.db'), 'OLD DB');
    put(join(backups, 'pre-2.0.0-20250101-000000', 'surau.db'), 'OLDER DB');
    put(join(backups, 'pre-install-20240101-000000', 'data', 'surau.db'), 'FIRST DB');
    return { dir, root, data, backups, outside };
  }

  function run(script: string, args: string[]) {
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { encoding: 'utf8', timeout: 110000, cwd: tmpdir() },
    );
    return { status: r.status, out: r.stdout + r.stderr };
  }

  const unins = (l: Layout, ...extra: string[]) => run(uninstallPs1, ['-InstallRoot', l.root, ...extra]);
  const sw = (l: Layout, ...extra: string[]) => run(switchPs1, ['-InstallRoot', l.root, ...extra]);
  const snapshot = (l: Layout) => ({ root: hashList(l.root), data: hashList(l.data), backups: hashList(l.backups) });

  it('refuses a folder without state\\install.json, a drive root and a root under the user profile (not -LayoutOnly)', () => {
    const l = makeLayout({ installJson: false });
    const before = hashList(l.root);
    const r = unins(l, '-LayoutOnly', '-Yes');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: .*bukan pemasangan MAXCOM/);
    expect(hashList(l.root)).toEqual(before);
    expect(existsSync(l.data)).toBe(true);

    const good = makeLayout();
    const snap = snapshot(good);
    const prof = unins(good, '-Yes'); // not -LayoutOnly: the temp folder is under the user profile
    expect(prof.status).toBe(1);
    expect(prof.out).toMatch(/profil pengguna/);
    expect(snapshot(good)).toEqual(snap);

    const drive = run(uninstallPs1, ['-InstallRoot', 'C:\\', '-LayoutOnly', '-Yes']);
    expect(drive.status).toBe(1);
    expect(drive.out).toMatch(/akar pemacu/);
    const rel = run(uninstallPs1, ['-InstallRoot', 'relative\\path', '-LayoutOnly', '-Yes']);
    expect(rel.status).toBe(1);
  });

  it('refuses a data folder inside the install root', () => {
    const l = makeLayout({ dataInsideRoot: true });
    const before = hashList(l.root);
    const r = unins(l, '-LayoutOnly', '-Yes');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/tidak boleh berada di dalam/);
    expect(hashList(l.root)).toEqual(before);
  });

  it('-DryRun lists what would go and what stays and changes nothing (layout only and full list)', () => {
    const l = makeLayout();
    const snap = snapshot(l);
    const junctionTarget = readdirSync(l.outside);
    const lay = unins(l, '-LayoutOnly', '-DryRun');
    expect(lay.status).toBe(0);
    expect(lay.out).toMatch(/DRYRUN pautan/);
    expect(lay.out).toMatch(/DRYRUN folder pemasangan/);
    expect(lay.out).toContain(`KEKAL: data surau di ${l.data}`);
    expect(lay.out).toContain(`KEKAL: salinan simpanan di ${l.backups}`);
    expect(snapshot(l)).toEqual(snap);

    // the full list needs no elevation with -DryRun
    const full = unins(l, '-DryRun', '-RemoveData');
    expect(full.status).toBe(0);
    for (const n of ['MAXCOM Kiosk', 'MAXCOM Box', 'MaxcomCertRenew', 'MAXCOM Live Firewall', 'MAXCOM Live WebRTC', 'MAXCOM Box HTTPS']) {
      expect(full.out).toContain(n);
    }
    expect(full.out).toMatch(/DRYRUN data surau/);
    expect(full.out).toMatch(/BELUM diberi/);
    expect(full.out).toMatch(/KEKAL: sijil root CA/);
    expect(snapshot(l)).toEqual(snap);
    expect(readdirSync(l.outside)).toEqual(junctionTarget);
    expect(existsSync(join(l.root, 'current'))).toBe(true);
  });

  it('-LayoutOnly -Yes removes the root and leaves the data folder, backups and a junction target untouched', () => {
    const l = makeLayout();
    const dataBefore = hashList(l.data);
    const backupsBefore = hashList(l.backups);
    const outsideBefore = hashList(l.outside);
    const r = unins(l, '-LayoutOnly', '-Yes');
    expect(r.out).toMatch(/Perisian MAX Kiosk Server telah dibuang/);
    expect(r.status).toBe(0);
    expect(existsSync(l.root)).toBe(false);
    expect(hashList(l.data)).toEqual(dataBefore);
    expect(hashList(l.backups)).toEqual(backupsBefore);
    expect(hashList(l.outside)).toEqual(outsideBefore);
    expect(r.out).toContain(`KEKAL: data surau di ${l.data}`);
  });

  it('-RemoveData -Yes without the typed word removes nothing; a wrong word too; the right word removes data and pre-* backups only', () => {
    const l = makeLayout();
    const snap = snapshot(l);
    const none = unins(l, '-LayoutOnly', '-Yes', '-RemoveData');
    expect(none.status).toBe(1);
    expect(none.out).toMatch(/BUANG DATA/);
    expect(snapshot(l)).toEqual(snap);
    const wrong = unins(l, '-LayoutOnly', '-Yes', '-RemoveData', '-ConfirmText', 'buang data');
    expect(wrong.status).toBe(1);
    expect(snapshot(l)).toEqual(snap);
    const other = unins(l, '-LayoutOnly', '-Yes', '-RemoveData', '-ConfirmText', 'BUANG SIJIL');
    expect(other.status).toBe(1);
    expect(snapshot(l)).toEqual(snap);

    const outsideBefore = hashList(l.outside);
    const ok = unins(l, '-LayoutOnly', '-Yes', '-RemoveData', '-ConfirmText', 'BUANG DATA');
    expect(ok.out).toMatch(/DIBUANG: data surau/);
    expect(ok.status).toBe(0);
    expect(existsSync(l.root)).toBe(false);
    expect(existsSync(l.data)).toBe(false);
    expect(existsSync(l.backups)).toBe(false);
    expect(hashList(l.outside)).toEqual(outsideBefore);
    expect(existsSync(join(l.dir, 'MAXCOM Home'))).toBe(true); // only data\ and backups\ went
  });

  it('-RemoveData keeps a backups folder that holds anything but pre-* copies, and refuses a folder that is not a data folder', () => {
    const l = makeLayout();
    put(join(l.backups, 'somebody-elses', 'file.txt'), 'x');
    const r = unins(l, '-LayoutOnly', '-Yes', '-RemoveData', '-ConfirmText', 'BUANG DATA');
    expect(r.status).toBe(0);
    expect(existsSync(l.data)).toBe(false);
    expect(readFileSync(join(l.backups, 'somebody-elses', 'file.txt'), 'utf8')).toBe('x');
    expect(r.out).toMatch(/LANGKAU backups/);

    const m = makeLayout();
    // point box-config at a real folder that holds nothing of MAXCOM
    const strange = join(m.dir, 'strange', 'data');
    put(join(strange, 'holiday-photos', 'a.jpg'), 'jpg');
    writeFileSync(join(m.root, 'box-config.json'), JSON.stringify({ v: 1, dataDir: strange, env: {} }));
    const before = hashList(strange);
    const s = unins(m, '-LayoutOnly', '-Yes', '-RemoveData', '-ConfirmText', 'BUANG DATA');
    expect(s.status).toBe(1);
    expect(s.out).toMatch(/tidak kelihatan seperti folder data MAXCOM/);
    expect(hashList(strange)).toEqual(before);
    expect(existsSync(m.root)).toBe(true);
  });

  it('a link as data folder is refused and its target is not touched', () => {
    const l = makeLayout();
    const real = join(l.dir, 'realdata');
    put(join(real, 'surau.db'), 'REAL');
    const link = join(l.dir, 'linkdata', 'data');
    mkdirSync(join(l.dir, 'linkdata'), { recursive: true });
    symlinkSync(real, link, 'junction');
    writeFileSync(join(l.root, 'box-config.json'), JSON.stringify({ v: 1, dataDir: link, env: {} }));
    const r = unins(l, '-LayoutOnly', '-Yes', '-RemoveData', '-ConfirmText', 'BUANG DATA');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/ialah pautan/);
    expect(readFileSync(join(real, 'surau.db'), 'utf8')).toBe('REAL');
    expect(existsSync(l.root)).toBe(true);
  });

  it('without -Yes and without a terminal it asks once and then removes nothing', () => {
    const l = makeLayout();
    const snap = snapshot(l);
    const r = unins(l, '-LayoutOnly');
    expect(r.status).toBe(2);
    expect(r.out).toContain('Buang perisian MAX Kiosk Server dari PC ini? Data surau DIKEKALKAN. (y/t)');
    expect(snapshot(l)).toEqual(snap);
  });

  it('Remove-MaxcomRootCa deletes the certificate AND its key (ECDSA and RSA) and refuses a foreign subject', () => {
    const probe = join(base, 'rootca-probe.ps1');
    writeFileSync(
      probe,
      [
        "$ErrorActionPreference = 'Stop'",
        '$ast = [System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$null, [ref]$null)',
        "foreach ($n in 'Remove-CertPrivateKey', 'Remove-MaxcomRootCa') {",
        '  $f = $ast.Find({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true)',
        '  . ([scriptblock]::Create($f.Extent.Text))',
        '}',
        '$made = @()',
        'try {',
        "  foreach ($alg in 'ECDSA_nistP256', 'RSA') {",
        "    $c = New-SelfSignedCertificate -Subject 'CN=MAXCOM Root CA Uji' -KeyAlgorithm $alg -CertStoreLocation Cert:\\CurrentUser\\My -KeyExportPolicy NonExportable",
        '    $made += $c.Thumbprint',
        '    if ($alg -eq "RSA") { $k = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($c) }',
        '    else { $k = [System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($c) }',
        '    $kn = $k.Key.KeyName; $k.Dispose()',
        '    $before = [System.Security.Cryptography.CngKey]::Exists($kn, [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider, [System.Security.Cryptography.CngKeyOpenOptions]::UserKey)',
        "    $r = Remove-MaxcomRootCa -Thumbprint $c.Thumbprint -Location 'CurrentUser'",
        '    $after = [System.Security.Cryptography.CngKey]::Exists($kn, [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider, [System.Security.Cryptography.CngKeyOpenOptions]::UserKey)',
        '    $left = @(Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Thumbprint -eq $c.Thumbprint }).Count',
        '    "RESULT $alg removed=$($r.Removed) keys=$($r.KeysDeleted) keyBefore=$before keyAfter=$after certLeft=$left"',
        '  }',
        "  $d = New-SelfSignedCertificate -Subject 'CN=Someone Else' -CertStoreLocation Cert:\\CurrentUser\\My",
        '  $made += $d.Thumbprint',
        "  try { [void](Remove-MaxcomRootCa -Thumbprint $d.Thumbprint -Location 'CurrentUser'); 'RESULT foreign=removed' }",
        '  catch { "RESULT foreign=refused" }',
        '  $stillThere = @(Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Thumbprint -eq $d.Thumbprint }).Count',
        '  "RESULT foreignLeft=$stillThere"',
        '} finally {',
        '  foreach ($t in $made) { $p = "Cert:\\CurrentUser\\My\\$t"; if (Test-Path $p) { Remove-Item -LiteralPath $p -DeleteKey -Force } }',
        '}',
        '',
      ].join('\r\n'),
    );
    const r = run(probe, [uninstallPs1]);
    const lines = r.out.split(/\r?\n/).filter((l) => l.startsWith('RESULT'));
    expect(lines, r.out).toEqual([
      'RESULT ECDSA_nistP256 removed=1 keys=1 keyBefore=True keyAfter=False certLeft=0',
      'RESULT RSA removed=1 keys=1 keyBefore=True keyAfter=False certLeft=0',
      'RESULT foreign=refused',
      'RESULT foreignLeft=1',
    ]);
  });

  it('switch-release -Previous flips current and swaps previous.txt; a release without .ok is refused', () => {
    const l = makeLayout();
    const dry = sw(l, '-Previous', '-LayoutOnly', '-DryRun');
    expect(dry.status).toBe(0);
    expect(dry.out).toMatch(/DRYRUN keluaran/);
    expect(readFileSync(join(l.root, 'previous.txt'), 'utf8')).toBe('1.0.0');
    expect(readFileSync(join(l.root, 'current', 'release.json'), 'utf8')).toContain('2.0.0');

    const r = sw(l, '-Previous', '-LayoutOnly', '-Yes');
    expect(r.out).toMatch(/Keluaran semasa: 1\.0\.0/);
    expect(r.status).toBe(0);
    expect(readFileSync(join(l.root, 'current', 'release.json'), 'utf8')).toContain('1.0.0');
    expect(readFileSync(join(l.root, 'previous.txt'), 'utf8')).toBe('2.0.0');
    expect(existsSync(join(l.root, 'releases', '2.0.0', '.ok'))).toBe(true);
    expect(readFileSync(join(l.data, 'surau.db'), 'utf8')).toBe('NEW DB'); // no -RestoreDb: the database stays

    // forward again by version
    const f = sw(l, '-Version', '2.0.0', '-LayoutOnly', '-Yes');
    expect(f.status).toBe(0);
    expect(readFileSync(join(l.root, 'previous.txt'), 'utf8')).toBe('1.0.0');

    // already current: nothing changes
    const same = sw(l, '-Version', '2.0.0', '-LayoutOnly', '-Yes');
    expect(same.status).toBe(0);
    expect(readFileSync(join(l.root, 'previous.txt'), 'utf8')).toBe('1.0.0');

    // no .ok, missing release, bad version, bad previous.txt, no choice, both choices
    const rel3 = join(l.root, 'releases', '3.0.0');
    put(join(rel3, 'release.json'), '{}');
    const before = hashList(l.root);
    const noOk = sw(l, '-Version', '3.0.0', '-LayoutOnly', '-Yes');
    expect(noOk.status).toBe(1);
    expect(noOk.out).toMatch(/\.ok tiada/);
    writeFileSync(join(l.root, 'previous.txt'), '3.0.0');
    const prevNoOk = sw(l, '-Previous', '-LayoutOnly', '-Yes');
    expect(prevNoOk.status).toBe(1);
    expect(prevNoOk.out).toMatch(/\.ok tiada/);
    writeFileSync(join(l.root, 'previous.txt'), '1.0.0');
    for (const bad of [['-Version', '9.9.9'], ['-Version', '..\\x'], ['-Version', '1.0'], [], ['-Previous', '-Version', '1.0.0']]) {
      const x = sw(l, ...bad, '-LayoutOnly', '-Yes');
      expect(x.status, bad.join(' ')).toBe(1);
    }
    expect(hashList(l.root)).toEqual(before);

    const noInstall = makeLayout({ installJson: false });
    expect(sw(noInstall, '-Previous', '-LayoutOnly', '-Yes').status).toBe(1);
  });

  it('switch-release -RestoreDb puts the newest saved database back and keeps the replaced one beside it', () => {
    const l = makeLayout();
    const r = sw(l, '-Previous', '-RestoreDb', '-LayoutOnly', '-Yes');
    expect(r.out).toMatch(/Keluaran semasa: 1\.0\.0/);
    expect(r.status).toBe(0);
    expect(readFileSync(join(l.data, 'surau.db'), 'utf8')).toBe('OLD DB'); // newest pre-2.0.0-*
    expect(existsSync(join(l.data, 'surau.db-wal'))).toBe(false); // the old WAL must not meet the restored database
    const kept = readdirSync(l.data).filter((n) => n.startsWith('surau.db.replaced-'));
    expect(kept).toHaveLength(2); // database and -wal
    const dbKept = kept.find((n) => !n.endsWith('-wal') && !n.endsWith('-shm'))!;
    expect(readFileSync(join(l.data, dbKept), 'utf8')).toBe('NEW DB');
    expect(readFileSync(join(l.data, kept.find((n) => n.endsWith('-wal'))!), 'utf8')).toBe('NEW WAL');
    expect(readFileSync(join(l.backups, 'pre-2.0.0-20260101-000000', 'surau.db'), 'utf8')).toBe('OLD DB'); // backup intact
    expect(readFileSync(join(l.root, 'previous.txt'), 'utf8')).toBe('2.0.0');
  });

  it('switch-release -RestoreDb without a saved database changes nothing', () => {
    const l = makeLayout();
    rmSync(join(l.backups, 'pre-2.0.0-20260101-000000'), { recursive: true });
    rmSync(join(l.backups, 'pre-2.0.0-20250101-000000'), { recursive: true });
    const snap = snapshot(l);
    const r = sw(l, '-Previous', '-RestoreDb', '-LayoutOnly', '-Yes');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/tiada salinan pangkalan data/);
    expect(snapshot(l)).toEqual(snap);
    expect(readFileSync(join(l.root, 'current', 'release.json'), 'utf8')).toContain('2.0.0');
  });
});
