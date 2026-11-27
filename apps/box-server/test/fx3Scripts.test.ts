import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scripts = fileURLToPath(new URL('../../../scripts/', import.meta.url));
const read = (rel: string): string => readFileSync(`${scripts}${rel}`, 'utf8');
const win = process.platform === 'win32';
const ps = (args: string[]) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8' });

describe('leave-surau.ps1 (Windows follower way out, F19)', () => {
  const src = read('leave-surau.ps1');

  it('is ASCII only and has no em dash, en dash or arrow', () => {
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(src)).toBe(false);
  });

  it('reads the secret from the secret folder, once, from an open handle, and refuses a link', () => {
    expect(src).toContain("Join-Path $secretDir 'leave-secret'");
    expect(src).toContain('System.IO.FileStream');
    expect(src).toContain('FileShare]::Read');
    expect(src).toContain('Test-IsLink $secretFile');
    expect(src).toMatch(/\$fs\.Length -gt 128/);
    expect(src).toContain("'^[0-9a-f]{64}$'");
  });

  it('calls only the loopback routes with the secret header, and never prints the secret or the code', () => {
    expect(src).toContain('http://127.0.0.1:$Port$path');
    expect(src).toContain("'X-Maxcom-Leave' = $secret");
    expect(src).toContain('/api/follow/revert');
    expect(src).toContain('/api/follow/empty');
    for (const line of src.split(/\r?\n/)) {
      if (/Write-Host|Write-Output|Write-Verbose|Write-Debug|WriteLine/.test(line)) {
        expect(line, line).not.toMatch(/\$secret|\$code|\$sec\b|\$json|\$bodyObj/);
      }
    }
    // the recovery code is typed as a secure string
    expect(src).toContain('-AsSecureString');
  });

  it('the data folder secret path is the one the box writes', () => {
    const box = readFileSync(fileURLToPath(new URL('../src/follow/leaveSecret.ts', import.meta.url)), 'utf8');
    expect(box).toContain("['secret', 'leave-secret']");
  });

  it.runIf(win)('parses without error', () => {
    const r = ps(['-Command', `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${`${scripts}leave-surau.ps1`.replace(/'/g, "''")}',[ref]$t,[ref]$e);if($e.Count -gt 0){$e|%{$_.Message};exit 1}`]);
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it.runIf(win)('refuses to run without Administrator and does nothing else', () => {
    const elevated = ps(['-Command', '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)']).stdout.trim() === 'True';
    if (elevated) return; // an elevated test run would go on to look for the secret file
    const r = ps(['-File', `${scripts}leave-surau.ps1`, '-DataDir', 'C:\\does-not-exist\\data', '-Port', '1']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Administrator');
  });
});

describe('box-cert-renew.ps1 reads the claim file once (S5)', () => {
  const src = read('box-cert-renew.ps1');
  it('opens one handle with FileShare.Read, checks attributes and length, reads at most 1 KB', () => {
    expect(src).not.toContain('ReadAllText($claimFile');
    expect(src).toContain('System.IO.FileStream($claimFile');
    expect(src).toContain('[System.IO.FileShare]::Read');
    expect(src).toContain('$fs.Length -gt 1024');
    expect(src).toContain('ReparsePoint');
    expect(src).toContain('New-Object byte[] 1025');
    expect(src).toContain('$fs.Dispose()');
  });
});

describe('setup keeps the update path complete (F36)', () => {
  const setup = read('setup/setup.ps1');
  it('the firewall step re-runs when the mDNS rule is missing, not only on a changed script', () => {
    expect(setup).toContain("Get-NetFirewallRule -DisplayName 'MAXCOM Box mDNS'");
    expect(setup).toMatch(/\$null -ne \$rule -and \$null -ne \$ruleMdns -and \(Get-StateValue 'sigTembok'\) -eq \$sig/);
    // the signature covers the firewall script itself: an update that changes it runs it again
    expect(setup).toContain("Get-Sha256Of (Join-Path $S.P.Bin 'ensure-box-firewall.ps1')");
  });
  it('the cert renewal task is re-registered when its install script changes (the 15 minute task)', () => {
    expect(setup).toContain("'install-cert-renew-task.ps1'");
    expect(setup).toMatch(/foreach \(\$n in @\('install-box-task\.ps1', 'install-cert-renew-task\.ps1', 'install-kiosk-task\.ps1'\)\)/);
  });
  it('leave-surau.ps1 is copied into the install bin and put in the setup bundle', () => {
    expect(setup).toContain("'leave-surau.ps1'");
    expect(read('setup/build-setup.ps1')).toContain("'leave-surau.ps1'");
  });
});
