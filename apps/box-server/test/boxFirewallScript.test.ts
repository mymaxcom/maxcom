import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/ensure-box-firewall.ps1', import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-boxfw-'));
  dirs.push(d);
  return d;
}

function fakeNodeExe(base: string): string {
  const dir = join(base, 'runtime', 'node');
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, 'node.exe');
  writeFileSync(exe, '');
  return exe;
}

const run = (args: string[]): { status: number | null; out: string } => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

describe('ensure-box-firewall.ps1 (static)', () => {
  const text = readFileSync(script, 'utf8');

  it('is ASCII only (PowerShell 5.1 reads BOM-less files as ANSI)', () => {
    for (const ch of text) expect(ch.charCodeAt(0)).toBeLessThan(128);
  });

  it('has exactly one add rule line: inbound TCP, every profile, local subnet only, the port, the program quoted', () => {
    const adds = text.split(/\r?\n/).filter((l) => /'add', 'rule'/.test(l));
    expect(adds.length).toBe(1);
    expect(adds[0]).toMatch(/Get-QuotedArg 'name' \$ruleName/);
    for (const part of ["'dir=in'", "'action=allow'", "'protocol=tcp'", '"localport=$HttpsPort"', "'profile=any'", "'remoteip=localsubnet'"]) {
      expect(adds[0]).toContain(part);
    }
    expect(adds[0]).toMatch(/Get-QuotedArg 'program' \$Program/);
    // the helper builds key="value" so netsh always sees the documented quoted form
    expect(text).toMatch(/\$Key \+ '="' \+ \$Value \+ '"'/);
  });

  it('opens one TCP rule only: the MAXCOM Box HTTPS name, the 8443 default and no media or UDP rule', () => {
    expect(text).toContain("'MAXCOM Box HTTPS'");
    expect(text).toMatch(/\[int\]\$HttpsPort\s*=\s*8443/);
    expect(text).toMatch(/\[ValidateRange\(1, 65535\)\]/);
    expect(text).not.toMatch(/protocol=udp/i);
    expect(text).not.toMatch(/\budp\b/i);
    expect(text).not.toContain('MAXCOM Live WebRTC');
    expect(text).not.toContain('MAXCOM Live SRT');
    expect(text.match(/'add', 'rule'/g)?.length).toBe(1);
  });

  it('refuses without administrator rights, before any delete or add', () => {
    const check = text.indexOf('IsInRole');
    expect(check).toBeGreaterThan(-1);
    const gate = text.indexOf('exit 1', check);
    expect(gate).toBeGreaterThan(check);
    expect(text.slice(check, gate)).toMatch(/elevated PowerShell/);
    expect(text.slice(check, gate)).toMatch(/Nothing was changed/);
    expect(text.indexOf("'delete', 'rule'")).toBeGreaterThan(gate);
    expect(text.indexOf("'add', 'rule'")).toBeGreaterThan(gate);
  });

  it('keeps an exact rule and deletes by name before making a different one', () => {
    // the check reads the rule with the NetSecurity cmdlets, never from translated netsh text
    expect(text).not.toMatch(/'show', 'rule'/);
    for (const cmdlet of ['Get-NetFirewallRule', 'Get-NetFirewallPortFilter', 'Get-NetFirewallApplicationFilter', 'Get-NetFirewallAddressFilter']) {
      expect(text).toContain(cmdlet);
    }
    expect(text).toMatch(/'delete', 'rule', \(Get-QuotedArg 'name' \$ruleName\)/);
    expect(text).toMatch(/Test-RuleExact/);
    // the exact test looks at the protocol and the program as well
    expect(text).toMatch(/\$r\.Protocol -ne 'TCP'/);
    expect(text).toMatch(/\$r\.Program -ine \$ProgramPath/);
    expect(text).toMatch(/OK      \$ruleName/);
  });

  it('only writes the firewall: no files, no registry, no tasks', () => {
    expect(text).not.toMatch(/Set-Content|Out-File|Add-Content|New-Item|Remove-Item|Set-ItemProperty|Register-ScheduledTask/);
  });

  it('-Remove deletes the rule by exact name and exits', () => {
    expect(text).toMatch(/\[switch\]\$Remove/);
    const remove = text.indexOf('if ($Remove) {');
    const del = text.indexOf("'delete', 'rule'", remove);
    expect(remove).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(remove);
    expect(text).toMatch(/REMOVED \$ruleName/);
  });

  it('binds the rule to node.exe: a full path that ends in \\node.exe and exists', () => {
    expect(text).toMatch(/\[Parameter\(Mandatory = \$true\)\]\s*\n\s*\[string\]\$Program/);
    expect(text).toMatch(/\$Program -notmatch '\\\\node\\\.exe\$'/);
    expect(text).toMatch(/Test-Path -LiteralPath \$Program -PathType Leaf/);
  });
});

describe.runIf(process.platform === 'win32')('ensure-box-firewall.ps1 (run)', () => {
  const elevated = spawnSync('net', ['session'], { encoding: 'utf8' }).status === 0;

  it('a dry run prints the rule and the program path, and changes nothing', () => {
    const base = tempDir();
    // spaces, an ampersand and a quote in the path, like the real install root
    const exe = fakeNodeExe(join(base, "MAXCOM uji & 'satu'", 'Program Files', 'MAXCOM'));
    const r = run(['-Program', exe, '-DryRun']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('DRYRUN');
    expect(r.out).toContain('MAXCOM Box HTTPS');
    expect(r.out).toContain('TCP 8443');
    expect(r.out).toContain(exe);
  });

  it('a dry run of -Remove says it would delete the rule', () => {
    const exe = fakeNodeExe(tempDir());
    const r = run(['-Program', exe, '-Remove', '-DryRun']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('DRYRUN');
    expect(r.out).toMatch(/delete .*MAXCOM Box HTTPS/);
  });

  it('refuses a program that is not node.exe', () => {
    const base = tempDir();
    const exe = join(base, 'powershell.exe');
    writeFileSync(exe, '');
    const r = run(['-Program', exe, '-DryRun']);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('node.exe');
  });

  it('refuses a missing node.exe and a relative path', () => {
    const missing = run(['-Program', join(tempDir(), 'runtime', 'node.exe'), '-DryRun']);
    expect(missing.status).not.toBe(0);
    expect(missing.out).toContain('node.exe');
    const relative = run(['-Program', 'node.exe', '-DryRun']);
    expect(relative.status).not.toBe(0);
    expect(relative.out).toMatch(/laluan penuh|full path/);
  });

  const fakeNetshRun = (base: string, extra: string[], exe: string) => {
    const log = join(base, 'netsh-argv.log');
    const fake = join(base, 'netsh.cmd');
    // prints the raw command line it received (%*), one line per call
    writeFileSync(fake, '@echo off\r\necho %*>>"%FAKE_NETSH_LOG%"\r\nexit /b 0\r\n');
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Program', exe, ...extra, '-Netsh', fake],
      { encoding: 'utf8', timeout: 60_000, env: { ...process.env, FAKE_NETSH_LOG: log } },
    );
    const calls = existsSync(log) ? readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '') : [];
    return { status: r.status, calls, out: `${r.stdout}${r.stderr}` };
  };

  it('hands netsh name="MAXCOM Box HTTPS" and program="<path with spaces>" in the documented quoted form', () => {
    const base = tempDir();
    const exe = fakeNodeExe(join(base, 'Program Files', 'MAXCOM uji'));
    const r = fakeNetshRun(base, [], exe);
    expect(r.status).toBe(0);
    // the exactness check is a read through Get-NetFirewall*, so netsh only ever gets delete and add
    expect(r.calls[0]).toBe('advfirewall firewall delete rule name="MAXCOM Box HTTPS"');
    expect(r.calls[1]).toBe(
      'advfirewall firewall add rule name="MAXCOM Box HTTPS" dir=in action=allow protocol=tcp localport=8443 profile=any remoteip=localsubnet program="' + exe + '"',
    );
    expect(r.calls.length).toBe(2);
  });

  it('Test-RuleSnapshotExact accepts exactly the wanted rule and nothing else (locale-neutral values)', () => {
    const probe = join(tempDir(), 'fw-probe.ps1');
    writeFileSync(
      probe,
      [
        "$ast = [System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$null, [ref]$null)",
        "$f = $ast.Find({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq 'Test-RuleSnapshotExact' }, $true)",
        '. ([scriptblock]::Create($f.Extent.Text))',
        "$prog = 'C:\\Program Files\\MAXCOM\\runtime\\node\\node.exe'",
        "$good = [pscustomobject]@{ Enabled = 'True'; Direction = 'Inbound'; Action = 'Allow'; Profile = 'Any'; Protocol = 'TCP'; LocalPort = '8443'; RemotePort = 'Any'; Program = $prog; RemoteAddress = 'LocalSubnet'; LocalAddress = 'Any' }",
        'function Variant($name, $value) { $c = $good.PSObject.Copy(); $c.$name = $value; $c }',
        '"good=" + (Test-RuleSnapshotExact @($good) 8443 $prog)',
        '"case=" + (Test-RuleSnapshotExact @((Variant "Program" $prog.ToUpper())) 8443 $prog)',
        '"three=" + (Test-RuleSnapshotExact @((Variant "Profile" "Domain, Private, Public")) 8443 $prog)',
        '"none=" + (Test-RuleSnapshotExact @() 8443 $prog)',
        '"two=" + (Test-RuleSnapshotExact @($good, $good) 8443 $prog)',
        '"disabled=" + (Test-RuleSnapshotExact @((Variant "Enabled" "False")) 8443 $prog)',
        '"out=" + (Test-RuleSnapshotExact @((Variant "Direction" "Outbound")) 8443 $prog)',
        '"block=" + (Test-RuleSnapshotExact @((Variant "Action" "Block")) 8443 $prog)',
        '"priv=" + (Test-RuleSnapshotExact @((Variant "Profile" "Private")) 8443 $prog)',
        '"udp=" + (Test-RuleSnapshotExact @((Variant "Protocol" "UDP")) 8443 $prog)',
        '"port=" + (Test-RuleSnapshotExact @((Variant "LocalPort" "8444")) 8443 $prog)',
        '"any=" + (Test-RuleSnapshotExact @((Variant "RemoteAddress" "Any")) 8443 $prog)',
        '"prog=" + (Test-RuleSnapshotExact @((Variant "Program" "C:\\other\\node.exe")) 8443 $prog)',
        '',
      ].join('\r\n'),
    );
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe, script], { encoding: 'utf8', timeout: 60_000 });
    const got = Object.fromEntries(
      `${r.stdout}`.split(/\r?\n/).filter((l) => l.includes('=')).map((l) => l.split('=') as [string, string]),
    );
    expect(got, `${r.stdout}${r.stderr}`).toEqual({
      good: 'True', case: 'True', three: 'True', none: 'False', two: 'False', disabled: 'False', out: 'False', block: 'False',
      priv: 'False', udp: 'False', port: 'False', any: 'False', prog: 'False',
    });
  });

  it('-Remove hands netsh the quoted rule name', () => {
    const base = tempDir();
    const r = fakeNetshRun(base, ['-Remove'], fakeNodeExe(base));
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(['advfirewall firewall delete rule name="MAXCOM Box HTTPS"']);
  });

  it.runIf(!elevated)('without administrator rights a real run exits non-zero and says what to do', () => {
    const exe = fakeNodeExe(tempDir());
    const r = run(['-Program', exe]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('elevated PowerShell');
    expect(r.out).toContain('Nothing was changed');
  });

  it.runIf(!elevated)('without administrator rights -Remove changes nothing either', () => {
    const exe = fakeNodeExe(tempDir());
    const r = run(['-Program', exe, '-Remove']);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('elevated PowerShell');
  });
});
