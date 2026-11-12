import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const scriptsDir = fileURLToPath(new URL('../../../scripts/', import.meta.url));
const caPath = join(scriptsDir, 'box-ca.ps1');
const renewPath = join(scriptsDir, 'box-cert-renew.ps1');
const installPath = join(scriptsDir, 'install-cert-renew-task.ps1');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-certs-'));
  dirs.push(d);
  return d;
}
const ps = (file: string, args: string[]) =>
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { encoding: 'utf8' });

/** SIDs of the allow entries on a path, sorted. */
function aclSids(path: string): string[] {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Acl -LiteralPath '${path}').Access | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }`],
    { encoding: 'utf8' },
  );
  return [...new Set(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))].sort();
}
function mySid(): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8' }).trim();
}

describe('certificate scripts (static)', () => {
  for (const f of [caPath, renewPath, installPath]) {
    it(`${f.split(/[\\/]/).pop()} is ASCII only`, () => {
      // eslint-disable-next-line no-control-regex
      expect(/[^\x00-\x7F]/.test(readFileSync(f, 'utf8'))).toBe(false);
    });
  }

  it('box-ca.ps1 validates -ServiceAccount to a SID before it writes anything, and still never prints the passphrase', () => {
    const src = readFileSync(caPath, 'utf8');
    expect(src).toMatch(/\[string\]\$ServiceAccount/);
    expect(src).toContain('SecurityIdentifier');
    // validation sits before the first folder is created
    expect(src.indexOf('ServiceAccount must be')).toBeGreaterThan(0);
    expect(src.indexOf('ServiceAccount must be')).toBeLessThan(src.indexOf('New-Item -ItemType Directory'));
    // the grant uses the resolved SID, never the raw parameter
    // the contract: inherit-only Modify inside secret, folder-only RX,WD,AD,WEA,WA (no DELETE), RX on pki, all with /L
    expect(src).toContain('"*${svcSid}:(OI)(CI)(IO)M" "*${svcSid}:(RX,WD,AD,WEA,WA)" /L');
    expect(src).toContain('"*${svcSid}:(OI)(CI)RX" /L');
    expect(src).toContain("-ne 'S-1-5-19'");
    expect(src).toContain('(\\\\[A-Za-z0-9 ._$-]{1,64})?$');
    // every icacls call names the link itself
    for (const m of src.match(/& icacls\.exe[^\r\n]*/g) ?? []) expect(m, m).toContain('/L');
    // links are refused before the first folder is created
    expect(src.indexOf('Assert-NoLink')).toBeLessThan(src.indexOf('New-Item -ItemType Directory'));
    expect(src).not.toMatch(/\$ServiceAccount:\(/);
    expect(src).toContain("$meta['serviceAccount'] = $svcSid");
    expect(src).not.toMatch(/Write-(Host|Output|Verbose|Debug)[^\r\n]*\$pass/i);
    expect(src).not.toMatch(/\$pass\w*\s*\|\s*(Out-|Write-)/i);
  });

  it('box-cert-renew.ps1 passes only a SID-shaped serviceAccount on to box-ca.ps1', () => {
    const src = readFileSync(renewPath, 'utf8');
    expect(src).toContain('serviceAccount');
    expect(src).toContain("$caArgs['ServiceAccount'] = $svc");
    expect(src).toContain("$svc -cne 'S-1-5-19'");
    expect(src).toContain('[string]$LogDir');
    expect(src).toContain('Get-LinkProblem');
  });

  it('install-cert-renew-task.ps1 -AsSystem: SYSTEM principal, no current-user trust, refusal checks, new help', () => {
    const src = readFileSync(installPath, 'utf8');
    expect(src).toMatch(/\[switch\]\$AsSystem/);
    expect(src).toMatch(/\[string\]\$ScriptDir/);
    expect(src).toContain("'NT AUTHORITY\\SYSTEM'");
    expect(src).toContain("'ServiceAccount'");
    // the trusted list for -AsSystem has no $meSid
    const at = src.indexOf('if ($AsSystem) { $trustedSids');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, src.indexOf('\n', at))).not.toContain('$meSid');
    // refusal conditions
    expect(src).toContain("-ne 'LocalMachine'");
    expect(src).toContain('no serviceAccount');
    expect(src).toContain('ReparsePoint');
    // old "Do NOT use SYSTEM" blanket paragraph is gone
    expect(src).not.toContain('Do NOT\n      use SYSTEM');
    expect(src).not.toMatch(/Do NOT\s+use SYSTEM/);
    expect(src).toContain('-AsSystem');
    // the task executes the script from ScriptDir, not from PSScriptRoot
    expect(src).toMatch(/\$renewScript = Join-Path \$ScriptDir 'box-cert-renew\.ps1'/);
  });
});

describe.runIf(process.platform === 'win32')('install-cert-renew-task.ps1 -AsSystem dry run (nothing is registered)', () => {
  const meta = (d: string, extra: Record<string, unknown>) => {
    mkdirSync(join(d, 'pki'), { recursive: true });
    writeFileSync(join(d, 'pki', 'box-ca.json'), JSON.stringify({ ip: '10.168.1.50', store: 'LocalMachine', surau: 'X', days: 730, noTrust: false, ...extra }));
  };

  it('refuses a CurrentUser CA, and a CA without serviceAccount', () => {
    const d = tmp();
    meta(d, { store: 'CurrentUser', serviceAccount: 'S-1-5-19' });
    let r = ps(installPath, ['-DataDir', d, '-AsSystem', '-DryRun']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/DRYRUN would refuse -AsSystem/);
    expect(r.stdout).toContain('CurrentUser');
    meta(d, { store: 'LocalMachine' });
    r = ps(installPath, ['-DataDir', d, '-AsSystem', '-DryRun']);
    expect(r.stdout).toMatch(/DRYRUN would refuse -AsSystem/);
    expect(r.stdout).toContain('no serviceAccount');
    // a missing box-ca.json is refused as well
    r = ps(installPath, ['-DataDir', tmp(), '-AsSystem', '-DryRun']);
    expect(r.stdout).toMatch(/DRYRUN would refuse -AsSystem/);
  }, 60_000);

  it('real (non dry-run) refusal needs no elevation to be reached: store CurrentUser throws before any change', () => {
    const d = tmp();
    meta(d, { store: 'CurrentUser', serviceAccount: 'S-1-5-19' });
    const r = ps(installPath, ['-DataDir', d, '-AsSystem']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Run this script from an elevated|Refusing -AsSystem/);
  }, 60_000);

  it('describes the SYSTEM task, drops the current user from the trusted writers, and uses -ScriptDir', () => {
    const d = tmp();
    meta(d, { serviceAccount: 'S-1-5-19' });
    const r = ps(installPath, ['-DataDir', d, '-AsSystem', '-DryRun', '-ScriptDir', scriptsDir]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/account : NT AUTHORITY\\SYSTEM \(logon ServiceAccount, run level Highest, CA store LocalMachine\)/);
    expect(r.stdout).toContain('box-cert-renew.ps1');
    expect(r.stdout).toContain(scriptsDir.replace(/[\\/]$/, ''));
    // the repo checkout is owned by a normal user, who is NOT trusted under -AsSystem
    expect(r.stdout).toMatch(/DRYRUN would refuse: the scripts folder can be changed by/);
  }, 60_000);

  it('-AsSystem with -Password is refused', () => {
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `& '${installPath}' -DataDir '${tmp()}' -AsSystem -DryRun -Password (ConvertTo-SecureString 'x' -AsPlainText -Force)`],
      { encoding: 'utf8' },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('cannot be combined');
  }, 60_000);

  it('without -AsSystem the dry run prints today\'s lines unchanged', () => {
    const d = tmp();
    meta(d, {});
    const r = ps(installPath, ['-DataDir', d, '-DryRun']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/task\s+: MaxcomCertRenew/);
    expect(r.stdout).toMatch(/logon S4U, run level Highest, CA store LocalMachine/);
    expect(r.stdout).toMatch(/daily 03:30 \(random delay up to 10 minutes\); at startup/);
    expect(r.stdout).toContain('box-cert-renew.ps1');
    expect(r.stdout).not.toContain('NT AUTHORITY');
  }, 60_000);
});

describe.runIf(process.platform === 'win32')('box-ca.ps1 -ServiceAccount (CurrentUser store, no trust)', () => {
  const tag = `CsTest${process.pid}${Date.now() % 100000}`;
  const run = (dataDir: string, surau: string, extra: string[] = []) =>
    ps(caPath, ['-Ip', '10.168.1.50', '-DataDir', dataDir, '-Store', 'CurrentUser', '-NoTrust', '-Surau', surau, ...extra]);

  afterAll(() => {
    // Remove every throw-away CA/leaf this block made from Cert:\CurrentUser\My, by thumbprint.
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command',
        `$c = @(Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -like '*${tag}*' }); foreach ($x in $c) { Remove-Item -Path ('Cert:\\CurrentUser\\My\\' + $x.Thumbprint) -DeleteKey -Force }`],
    );
  });

  it('without -ServiceAccount the secret ACL is today\'s (current user + SYSTEM) and box-ca.json has no serviceAccount', () => {
    const dir = tmp();
    const r = run(dir, `${tag}a`);
    expect(r.status, r.stderr).toBe(0);
    expect(aclSids(join(dir, 'secret'))).toEqual([mySid(), 'S-1-5-18'].sort());
    const m = JSON.parse(readFileSync(join(dir, 'pki', 'box-ca.json'), 'utf8'));
    expect(m).toEqual({ ip: '10.168.1.50', store: 'CurrentUser', surau: `${tag}a`, days: 730, noTrust: true });
    // never printed
    expect(r.stdout).not.toMatch(/pfx\.pass.*[A-Za-z0-9]{32}/);
  }, 120_000);

  it('with -ServiceAccount S-1-5-19 the box account gets Modify on secret and Read on pki; renewal keeps it on the new box.pfx', () => {
    const dir = tmp();
    const r = run(dir, `${tag}b`, ['-ServiceAccount', 'S-1-5-19']);
    expect(r.status, r.stderr).toBe(0);
    const base = [mySid(), 'S-1-5-18', 'S-1-5-19', 'S-1-5-32-544'].sort();
    expect(aclSids(join(dir, 'secret'))).toEqual(base);
    expect(aclSids(join(dir, 'secret', 'box.pfx'))).toContain('S-1-5-19');
    expect(aclSids(join(dir, 'secret', 'pfx.pass'))).toContain('S-1-5-19');
    expect(aclSids(join(dir, 'pki'))).toContain('S-1-5-19');
    const m = JSON.parse(readFileSync(join(dir, 'pki', 'box-ca.json'), 'utf8'));
    expect(m.serviceAccount).toBe('S-1-5-19');
    expect(JSON.stringify(m)).not.toMatch(/pass|pfx|key/i);

    // The automatic renewal passes the recorded account on, so the new files stay readable.
    const before = readFileSync(join(dir, 'secret', 'box.pfx'));
    const renewed = ps(renewPath, ['-DataDir', dir, '-Force']);
    expect(renewed.status, renewed.stderr + renewed.stdout).toBe(0);
    expect(renewed.stdout).toMatch(/RENEWED/);
    expect(readFileSync(join(dir, 'secret', 'box.pfx')).equals(before)).toBe(false);
    expect(aclSids(join(dir, 'secret'))).toEqual(base);
    expect(aclSids(join(dir, 'secret', 'box.pfx'))).toContain('S-1-5-19');
    expect(aclSids(join(dir, 'secret', 'pfx.pass'))).toContain('S-1-5-19');
    expect(JSON.parse(readFileSync(join(dir, 'pki', 'box-ca.json'), 'utf8')).serviceAccount).toBe('S-1-5-19');
  }, 180_000);

  /** "sid|rights|inherit|propagation" of every allow entry of a folder. */
  function aceKeys(path: string): string[] {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Acl -LiteralPath '${path}').Access | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value, [int]$_.FileSystemRights, [int]$_.InheritanceFlags, [int]$_.PropagationFlags }`],
      { encoding: 'utf8' },
    );
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).sort();
  }

  it('the ACL box-ca.ps1 leaves is the contract (box account: no DELETE on secret, RX only on pki), and a renewal keeps it', () => {
    const dir = tmp();
    const r = run(dir, `${tag}k`, ['-ServiceAccount', 'S-1-5-19']);
    expect(r.status, r.stderr).toBe(0);
    const me = mySid();
    const wantSecret = [
      'S-1-5-18|2032127|3|0', 'S-1-5-32-544|2032127|3|0', 'S-1-5-19|1245631|3|2', 'S-1-5-19|1180095|0|0', `${me}|2032127|3|0`,
    ].sort();
    const wantPki = ['S-1-5-18|2032127|3|0', 'S-1-5-32-544|2032127|3|0', 'S-1-5-19|1179817|3|0', `${me}|2032127|3|0`].sort();
    expect(aceKeys(join(dir, 'secret'))).toEqual(wantSecret);
    expect(aceKeys(join(dir, 'pki'))).toEqual(wantPki);
    const renewed = ps(renewPath, ['-DataDir', dir, '-Force']);
    expect(renewed.status, renewed.stderr + renewed.stdout).toBe(0);
    expect(aceKeys(join(dir, 'secret'))).toEqual(wantSecret);
    expect(aceKeys(join(dir, 'pki'))).toEqual(wantPki);
  }, 180_000);

  it('accepts only S-1-5-19 as the service account (the current user SID is refused before anything is written)', () => {
    const dir = tmp();
    const r = run(dir, `${tag}m`, ['-ServiceAccount', mySid()]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('exactly S-1-5-19');
    expect(existsSync(join(dir, 'secret'))).toBe(false);
  }, 60_000);

  it('refuses a junction at pki, secret or data (nothing written, nothing locked), in box-ca.ps1 and in the renewal', () => {
    const outside = tmp();
    for (const which of ['pki', 'secret']) {
      const dir = tmp();
      mkdirSync(dir, { recursive: true });
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `New-Item -ItemType Junction -Path '${join(dir, which)}' -Target '${outside}' | Out-Null`]);
      const r = run(dir, `${tag}j`, ['-ServiceAccount', 'S-1-5-19']);
      expect(r.status, which).not.toBe(0);
      expect(r.stderr, which).toContain('GAGAL');
      expect(readdirSync(outside), which).toEqual([]);
      const rn = ps(renewPath, ['-DataDir', dir, '-Force', '-LogDir', join(dir, 'logs')]);
      expect(rn.status, which).toBe(1);
      expect(readFileSync(join(dir, 'logs', 'cert-renew.log'), 'utf8')).toMatch(/FAIL GAGAL/);
      expect(readdirSync(outside), which).toEqual([]);
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[IO.Directory]::Delete('${join(dir, which)}', $false)`]);
    }
    // a junction as the log folder: nothing is written through it
    const dir = tmp();
    mkdirSync(join(dir, 'pki'), { recursive: true });
    const lg = join(tmp(), 'lg');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `New-Item -ItemType Junction -Path '${lg}' -Target '${outside}' | Out-Null`]);
    const rn = ps(renewPath, ['-DataDir', dir, '-Force', '-LogDir', lg]);
    expect(rn.status).toBe(1);
    expect(readdirSync(outside)).toEqual([]);
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[IO.Directory]::Delete('${lg}', $false)`]);
  }, 240_000);

  it('the renewal writes its log to -LogDir and refuses a serviceAccount other than S-1-5-19 in box-ca.json', () => {
    const dir = tmp();
    const r = run(dir, `${tag}n`, ['-ServiceAccount', 'S-1-5-19']);
    expect(r.status, r.stderr).toBe(0);
    const logs = join(tmp(), 'logs');
    const ok = ps(renewPath, ['-DataDir', dir, '-LogDir', logs]);
    expect(ok.status, ok.stderr + ok.stdout).toBe(0);
    expect(readFileSync(join(logs, 'cert-renew.log'), 'utf8')).toMatch(/SKIP/);
    expect(existsSync(join(dir, 'logs'))).toBe(false);
    const metaFile = join(dir, 'pki', 'box-ca.json');
    const m = JSON.parse(readFileSync(metaFile, 'utf8'));
    m.serviceAccount = mySid();
    writeFileSync(metaFile, JSON.stringify(m));
    const bad = ps(renewPath, ['-DataDir', dir, '-LogDir', logs, '-Force']);
    expect(bad.status).toBe(1);
    expect(readFileSync(join(logs, 'cert-renew.log'), 'utf8')).toMatch(/FAIL GAGAL: serviceAccount/);
  }, 240_000);

  it('refuses a ServiceAccount that is not a SID or an account name, before writing anything', () => {
    for (const bad of ['x; calc', 'S-1-5-19)(A;;FA;;;WD', 'NoSuchAccount-zz-' + tag, '*S-1-1-0']) {
      const dir = tmp();
      const r = run(dir, `${tag}c`, ['-ServiceAccount', bad]);
      expect(r.status, bad).not.toBe(0);
      expect(r.stderr, bad).toContain('ServiceAccount must be');
      expect(existsSync(join(dir, 'secret')), bad).toBe(false);
      expect(existsSync(join(dir, 'pki')), bad).toBe(false);
    }
  }, 180_000);
});
