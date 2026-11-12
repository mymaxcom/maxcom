import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const issBytes = readFileSync(join(repoRoot, 'scripts', 'setup', 'maxcom-setup.iss'));
const ps1Bytes = readFileSync(join(repoRoot, 'scripts', 'setup', 'build-setup-exe.ps1'));
const iss = issBytes.toString('utf8');
const ps1 = ps1Bytes.toString('utf8');

describe('maxcom-setup.iss', () => {
  it('runs elevated, carries no uninstaller and installs no app dir', () => {
    expect(iss).toMatch(/^PrivilegesRequired=admin$/m);
    expect(iss).toMatch(/^Uninstallable=no$/m);
    expect(iss).toMatch(/^CreateUninstallRegKey=no$/m);
    expect(iss).toMatch(/^CreateAppDir=no$/m);
    expect(iss).toMatch(/^DisableDirPage=yes$/m);
    expect(iss).toMatch(/^DisableProgramGroupPage=yes$/m);
    expect(iss).toMatch(/^DisableReadyPage=no$/m);
    expect(iss).toMatch(/^ArchitecturesAllowed=x64compatible$/m);
    expect(iss).toMatch(/^ArchitecturesInstallIn64BitMode=x64compatible$/m);
    expect(iss).toMatch(/^MinVersion=10\.0$/m);
    expect(iss).toMatch(/^WizardStyle=modern$/m);
    expect(iss).toMatch(/^Compression=lzma2$/m);
    expect(iss).toMatch(/^SolidCompression=yes$/m);
  });

  it('extracts to a random locked run folder under ProgramData, never to the user temp', () => {
    const lines = iss.split(/\r?\n/);
    const i = lines.indexOf('[Files]');
    expect(i).toBeGreaterThan(-1);
    const entries: string[] = [];
    for (const l of lines.slice(i + 1)) {
      if (l.startsWith('[')) break;
      if (l.trim() !== '' && !l.trim().startsWith(';')) entries.push(l);
    }
    expect(entries.length).toBe(1);
    expect(entries[0]).toContain('DestDir: "{code:GetRunDir}"');
    expect(entries[0]).toContain('{#BundleDir}');
    for (const flag of ['ignoreversion', 'recursesubdirs', 'createallsubdirs']) expect(entries[0]).toContain(flag);
    expect(entries[0]).not.toContain('deleteafterinstall');
    expect(iss).not.toMatch(/DestDir:\s*"\{(app|pf|commonpf|autopf|sd|userdocs|tmp)/);
    expect(iss).not.toContain('{tmp}\\maxcom-setup');
    expect(iss).toContain('function GetRunDir(Param: String): String;');
    expect(iss).toContain("ExpandConstant('{commonappdata}') + '\\MAXCOM-setup-' + Suffix");
    expect(iss).toContain('CoCreateGuid');
    // the folder is made fresh, locked by SID before any file is written, and checked empty
    expect(iss).toMatch(/if CurStep = ssInstall then\s+begin\s+PrepareRunDir;/);
    expect(iss).toContain('if DirExists(RunDir) then');
    expect(iss).toContain('CreateDir(RunDir)');
    expect(iss).toContain("{sys}\\icacls.exe");
    expect(iss).toContain('/inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F');
    expect(iss).toMatch(/\(ResultCode <> 0\)/);
    expect(iss).toContain('FolderIsEmpty(RunDir)');
    expect(iss.indexOf('/inheritance:r')).toBeLessThan(iss.indexOf('FolderIsEmpty(RunDir)'));
    expect(iss).not.toMatch(/icacls[^\n]*(Administrators|SYSTEM|Users)/i);
    // only the folder this run made is removed
    expect(iss).toMatch(/if RunDirCreated and \(RunDir <> ''\) then\s+DelTree\(RunDir, True, True, True\);/);
    expect(iss.match(/DelTree\(/g)?.length).toBe(1);
  });

  it('is silent-safe: only SuppressibleMsgBox, -PauseAtEnd only when not silent, and a real exit code', () => {
    expect(iss).not.toMatch(/(^|[^e])MsgBox\(/m);
    expect(iss).toContain('SuppressibleMsgBox(');
    expect(iss).toContain('if not WizardSilent then Result := Result + \' -PauseAtEnd\'');
    expect(iss.match(/-PauseAtEnd/g)?.length).toBe(1);
    expect(iss).toContain('function GetCustomSetupExitCode: Integer;');
    expect(iss).toMatch(/FailRun\(ResultCode\)/);
    expect(iss).toContain('Result := SetupExitCode;');
  });

  it('runs setup.ps1 with the fixed PowerShell flags, visible, waiting', () => {
    expect(iss).toContain("{sys}\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(iss).toContain('-NoProfile -ExecutionPolicy Bypass -File ');
    expect(iss).toContain("RunDir + '\\setup\\setup.ps1'");
    expect(iss).toContain('Args, RunDir, SW_SHOW');
    expect(iss).toContain('SW_SHOW');
    expect(iss).toContain('ewWaitUntilTerminated');
    expect(iss).toMatch(/CurStepChanged/);
    expect(iss).toMatch(/ssPostInstall/);
  });

  it('checks the exit code and does not claim success on failure', () => {
    expect(iss).toMatch(/if ResultCode <> 0 then/);
    expect(iss).toContain('RunFailed');
    expect(iss).toContain('RunDirExists');
    expect(iss).toContain('Kod keluar');
    expect(iss).toMatch(/RunOk := True;/);
    expect(iss).toContain('FinishedFail');
    expect(iss).toContain('FinishedOk');
    expect(iss).toMatch(/if RunDone and RunOk then/);
  });

  it('maps each switch to its setup.ps1 parameter and validates every value for quotes and newlines', () => {
    const map: Array<[string, string]> = [
      ['MIGRATEFROM', '-MigrateFrom'],
      ['SURAU', '-Surau'],
      ['KIOSK', '-Kiosk'],
      ['DATADIR', '-DataDir'],
      ['CLOUDURL', '-CloudUrl'],
    ];
    for (const [sw, prm] of map) {
      expect(iss).toContain(`{param:${sw}|}`);
      expect(iss).toContain(`' ${prm} ' + QuoteArg(`);
      expect(iss).toContain(`CheckValue('/${sw}'`);
    }
    expect(iss).toContain("SwitchGiven('YES')");
    expect(iss).toContain("' -Yes'");
    // IsBadValue rejects double quote, CR and LF; BuildArgs rechecks every value
    expect(iss).toMatch(/Pos\('"', S\) > 0/);
    expect(iss).toMatch(/Pos\(#13, S\) > 0/);
    expect(iss).toMatch(/Pos\(#10, S\) > 0/);
    for (const v of ['Migrate', 'Surau', 'Kiosk', 'DataDir', 'CloudUrl']) expect(iss).toContain(`IsBadValue(${v})`);
    // every value is quoted when put on the command line
    expect(iss).toMatch(/function QuoteArg/);
    expect(iss).toContain("Result := '\"' + V + '\"';");
    // abort before running when a value is bad
    expect(iss).toMatch(/function InitializeSetup\(\): Boolean;/);
  });

  it('whitelists KIOSK to khas, kongsi, tiada', () => {
    expect(iss).toContain("CompareText(Value, 'khas') = 0");
    expect(iss).toContain("CompareText(Value, 'kongsi') = 0");
    expect(iss).toContain("CompareText(Value, 'tiada') = 0");
    expect(iss).toContain('BadKiosk');
  });

  it('has the optional migrate page, skipped when /MIGRATEFROM is given, validated too', () => {
    expect(iss).toContain('CreateCustomPage(wpWelcome');
    expect(iss).toContain('Pindah data dari pemasangan lama');
    expect(iss).toMatch(/MigrateEdit\.Text := '';/);
    expect(iss).toMatch(/function ShouldSkipPage/);
    expect(iss).toMatch(/Result := ExpandConstant\('\{param:MIGRATEFROM\|\}'\) <> '';/);
    expect(iss).toContain("CheckValue('-MigrateFrom', MigrateEdit.Text)");
  });

  it('is in Bahasa Melayu (Malaysia) and names no third party', () => {
    for (const w of ['Seterusnya', 'Kembali', 'Batal', 'Pasang', 'Selesai', 'muat turun']) expect(iss).toContain(w);
    for (const bad of ['unduh', 'mengunduh', 'instal ', 'diperlukan oleh', 'membutuhkan', 'Jangan khawatir']) expect(iss).not.toContain(bad);
    expect(iss).not.toMatch(/xibo|inno setup wizard/i);
  });

  it('is pure ASCII', () => {
    for (const b of issBytes) expect(b).toBeLessThan(128);
  });
});

describe('build-setup-exe.ps1', () => {
  it('is pure ASCII (PS 5.1 reads BOM-less files as ANSI)', () => {
    for (const b of ps1Bytes) expect(b).toBeLessThan(128);
  });

  it('has the params, the version check and the ISCC lookup', () => {
    expect(ps1).toMatch(/\[string\]\$Version = ''/);
    expect(ps1).toContain("Resolve-ProductVersion 'kiosk-server-windows'");
    expect(ps1).toMatch(/--check --key \$Key/);
    expect(ps1).toContain('[string]$SetupDir');
    expect(ps1).toContain('[string]$Iscc');
    expect(ps1).toContain('[switch]$DryRun');
    expect(ps1).toContain("'^20[0-9]{2}\\.(0[1-9]|1[0-2])\\.[1-9][0-9]?$'");
    expect(ps1).toContain('Programs\\Inno Setup 6\\ISCC.exe');
    expect(ps1).toContain('${env:ProgramFiles(x86)}');
    expect(ps1).toMatch(/Fail 'ISCC\.exe/);
    expect(ps1).toContain('GAGAL:');
  });

  it('verifies the bundle with Test-BundleManifest before compiling', () => {
    const iTest = ps1.indexOf('Test-BundleManifest $bundle');
    const iRun = ps1.indexOf('& $Iscc');
    expect(iTest).toBeGreaterThan(-1);
    expect(iRun).toBeGreaterThan(iTest);
    expect(ps1).toContain('MaxcomSetup.psm1');
  });

  it('passes the icon by default, with an -IconFile override and a GAGAL when missing', () => {
    expect(ps1).toContain('[string]$IconFile');
    expect(ps1).toContain('branding\\maxcom\\maxcom.ico');
    expect(ps1).toContain('"/DIconFile=$IconFile"');
    expect(ps1).toMatch(/Fail "ikon tiada: \$IconFile/);
    expect(iss).toContain('#ifdef IconFile');
    expect(iss).toContain('SetupIconFile={#IconFile}');
  });

  it('passes the four defines, checks the ISCC exit code and writes the .sha256', () => {
    for (const d of ['/DMyVersion=$Version', '/DBundleDir=$bundle', '/DOutDir=$SetupDir', '/DOutBase=$topName']) expect(ps1).toContain(d);
    expect(ps1).toMatch(/\$LASTEXITCODE -ne 0/);
    expect(ps1).toContain('.sha256');
    expect(ps1).toContain('"$hash  $topName.exe`n"');
  });
});

const isccCandidates = [
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
  join(process.env.ProgramFiles ?? 'C:\Program Files', 'Inno Setup 6', 'ISCC.exe'),
];
const iscc = isccCandidates.find((p) => existsSync(p));

describe('maxcom-setup.iss compiles', () => {
  it.skipIf(!iscc)('compiles against a tiny fake bundle (ISCC exit 0, exe written)', () => {
    const d = mkdtempSync(join(tmpdir(), 'maxcom-iscc-'));
    try {
      const bundle = join(d, 'bundle');
      const out = join(d, 'out');
      mkdirSync(join(bundle, 'setup'), { recursive: true });
      mkdirSync(out, { recursive: true });
      writeFileSync(join(bundle, 'setup', 'setup.ps1'), 'exit 0\r\n');
      writeFileSync(join(bundle, 'manifest.json'), '{}\n');
      const r = spawnSync(
        iscc!,
        [
          '/DMyVersion=2026.11.2',
          `/DBundleDir=${bundle}`,
          `/DOutDir=${out}`,
          '/DOutBase=t',
          `/DIconFile=${join(repoRoot, 'branding', 'maxcom', 'maxcom.ico')}`,
          join(repoRoot, 'scripts', 'setup', 'maxcom-setup.iss'),
        ],
        { encoding: 'utf8', timeout: 120_000 },
      );
      expect(`${r.stdout}${r.stderr}`).toContain('Successful compile');
      expect(r.status).toBe(0);
      expect(existsSync(join(out, 't.exe'))).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 150_000);
});
