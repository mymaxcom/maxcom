import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(new URL('../../../scripts/install-box-task.ps1', import.meta.url));
const src = readFileSync(scriptPath, 'utf8');

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-boxtask-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake install root with a space in its name; the current user owns (and can write) every file. */
function fakeRoot(withNode = true): string {
  const root = join(tmp(), 'MAXCOM uji & satu');
  mkdirSync(join(root, 'runtime', 'node'), { recursive: true });
  if (withNode) writeFileSync(join(root, 'runtime', 'node', 'node.exe'), 'x');
  writeFileSync(join(root, 'launcher.mjs'), '// x');
  writeFileSync(join(root, 'box-config.json'), '{}');
  return root;
}

describe('install-box-task.ps1 static checks', () => {
  it('is pure ASCII', () => {
    for (let i = 0; i < src.length; i++) expect(src.charCodeAt(i)).toBeLessThan(128);
  });

  it('runs as LOCAL SERVICE (S-1-5-19), never SYSTEM and never highest privileges', () => {
    expect(src).toContain('S-1-5-19');
    expect(src).toContain('-LogonType ServiceAccount');
    expect(src).toContain('-RunLevel Limited');
    expect(src).not.toMatch(/-UserId\s+['"]?(NT AUTHORITY\\)?SYSTEM/i);
    expect(src).not.toMatch(/RunLevel\s+Highest/i);
  });

  it('builds the argument with the launcher path in double quotes and uses the installed node.exe', () => {
    expect(src).toContain(`'"{0}"' -f $launcher`);
    expect(src).toContain("'runtime\\node\\node.exe'");
    expect(src).toContain('-WorkingDirectory $root');
  });

  it('has the task name, restart, no time limit and the 5 minute repetition checked from the XML', () => {
    expect(src).toContain("'MAXCOM Box'");
    expect(src).toContain('-MultipleInstances IgnoreNew');
    expect(src).toContain('-RestartCount 3');
    expect(src).toContain('[TimeSpan]::Zero');
    expect(src).toContain("'PT15S'");
    expect(src).toContain('PT5M');
    expect(src).toContain('Export-ScheduledTask');
    expect(src).not.toContain('[TimeSpan]::MaxValue');
    expect(src).not.toContain('[timespan]::MaxValue');
  });

  it('checks writers before registering and does not trust the current user or LOCAL SERVICE', () => {
    expect(src).toContain('Get-UntrustedWriters');
    expect(src).toContain('S-1-5-32-544');
    const trusted = /\$trustedSids = @\(([^)]*)\)/.exec(src);
    expect(trusted).not.toBeNull();
    expect(trusted![1]).not.toContain('S-1-5-19');
    expect(trusted![1]).not.toContain('$meSid');
    expect(src).not.toContain('WindowsIdentity]::GetCurrent().User');
    expect(src.indexOf('Get-UntrustedWriters $p')).toBeLessThan(src.indexOf('Register-ScheduledTask'));
    for (const f of ['$root', '$nodeExe', '$launcher', '$config']) expect(src).toContain(f);
  });

  it('keeps the messages a volunteer reads in Bahasa Malaysia and starts failures with GAGAL', () => {
    expect(src).toContain('GAGAL:');
    expect(src).not.toMatch(/[^\x00-\x7f]/);
  });
});

describe.skipIf(process.platform !== 'win32')('install-box-task.ps1 dry run (nothing is registered)', () => {
  const ps = (args: string[]) =>
    spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], { encoding: 'utf8' });

  it('prints the task, the account, both triggers and the exact quoted command for a root with a space', () => {
    const root = fakeRoot();
    const r = ps(['-InstallRoot', root, '-DryRun']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/DRYRUN task\s+: MAXCOM Box/);
    expect(r.stdout).toContain('S-1-5-19');
    expect(r.stdout).toContain('LOCAL SERVICE');
    expect(r.stdout).toMatch(/at startup \(delay 15 seconds\)/);
    expect(r.stdout).toMatch(/every 5 minutes with no end/);
    expect(r.stdout).toContain(`DRYRUN command : ${join(root, 'runtime', 'node', 'node.exe')} "${join(root, 'launcher.mjs')}"`);
  }, 60_000);

  it('says it would refuse and names the writer when the current user can write the files', () => {
    const root = fakeRoot();
    const r = ps(['-InstallRoot', root, '-DryRun']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/DRYRUN would refuse: .*launcher\.mjs can be changed by /);
    expect(r.stdout).toMatch(/DRYRUN would refuse: .*node\.exe can be changed by /);
    expect(r.stdout).toMatch(/DRYRUN would refuse: .*box-config\.json can be changed by /);
  }, 60_000);

  it('fails when node.exe is missing or the root is not given or not a full path', () => {
    const root = fakeRoot(false);
    let r = ps(['-InstallRoot', root, '-DryRun']);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/GAGAL/);
    r = ps(['-DryRun']);
    expect(r.status).not.toBe(0);
    r = ps(['-InstallRoot', 'relatif\\jalan', '-DryRun']);
    expect(r.status).not.toBe(0);
  }, 90_000);

  it('-Uninstall -DryRun only prints', () => {
    const r = ps(['-Uninstall', '-DryRun']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/DRYRUN (would stop and remove task|task) .*MAXCOM Box|DRYRUN task MAXCOM Box/);
  }, 60_000);
});
