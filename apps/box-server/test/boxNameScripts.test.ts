import { X509Certificate } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const scriptsDir = fileURLToPath(new URL('../../../scripts/', import.meta.url));
const caPath = join(scriptsDir, 'box-ca.ps1');
const renewPath = join(scriptsDir, 'box-cert-renew.ps1');
const installPath = join(scriptsDir, 'install-cert-renew-task.ps1');
const v2Fixture = fileURLToPath(new URL('../../surau-app/test/fixtures/tls-nc-v2/root-ca.cer', import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-name-ps-'));
  dirs.push(d);
  return d;
}
const ps = (file: string, args: string[]) =>
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { encoding: 'utf8' });

const leafOf = (dir: string): X509Certificate => new X509Certificate(readFileSync(join(dir, 'pki', 'box-leaf.cer')));
const rootOf = (dir: string): X509Certificate => new X509Certificate(readFileSync(join(dir, 'pki', 'root-ca.cer')));
const meta = (dir: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, 'pki', 'box-ca.json'), 'utf8'));
const claim = (dir: string, text: string): void => writeFileSync(join(dir, 'box-name.json'), text);
const claimN = (n: number): string => `{"n":${n},"claimedAt":"2026-11-24T10:00:00Z"}\n`;
const logLines = (dir: string): string[] => readFileSync(join(dir, 'logs', 'cert-renew.log'), 'utf8').trim().split(/\r?\n/);

/** The NameConstraints extension bytes of a certificate (from its OID to the end of the value). */
function ncBytes(c: X509Certificate): Buffer {
  const at = c.raw.indexOf(Buffer.from([0x55, 0x1d, 0x1e, 0x01, 0x01, 0xff]));
  expect(at).toBeGreaterThan(0);
  // after the OID and the critical flag: OCTET STRING (04) with a two byte length (82 hh ll), then the value
  const lenAt = at + 6;
  expect(c.raw[lenAt]).toBe(0x04);
  expect(c.raw[lenAt + 1]).toBe(0x82);
  const len = c.raw.readUInt16BE(lenAt + 2);
  return c.raw.subarray(at, lenAt + 4 + len);
}

describe('local name scripts (static)', () => {
  for (const f of [caPath, renewPath, installPath]) {
    it(`${f.split(/[\\/]/).pop()} is ASCII only`, () => {
      // eslint-disable-next-line no-control-regex
      expect(/[^\x00-\x7F]/.test(readFileSync(f, 'utf8'))).toBe(false);
    });
  }

  it('box-ca.ps1 checks the exact name shape before any folder is made, and builds the leaf from the root kind', () => {
    const src = readFileSync(caPath, 'utf8');
    expect(src).toContain("-cnotmatch '^box([1-9][0-9]?)-surau\\.local\\z'");
    expect(src.indexOf('BoxName must be')).toBeLessThan(src.indexOf('New-Item -ItemType Directory'));
    // a legacy root vouches for box.surau.local only, a v2 root for the one claimed name; never both
    expect(src).toMatch(/if \(\$gen -eq 'legacy'\) \{ \$sanDns \+= 'DNS=box\.surau\.local' \}/);
    expect(src).toMatch(/elseif \(\$BoxName -ne ''\) \{ \$sanDns \+= "DNS=\$BoxName"/);
    expect(src).toContain('rootGeneration = $gen');
  });

  it('box-cert-renew.ps1 takes only an integer from the box-written claim file and builds the name itself', () => {
    const src = readFileSync(renewPath, 'utf8');
    expect(src).toContain('$item.Length -gt 1024');
    expect(src).toContain('ReparsePoint');
    expect(src).toContain("'\"n\"\\s*:\\s*([1-9][0-9]?)\\s*[,}]'");
    expect(src).toContain("('box{0}-surau.local' -f [int]");
    // the name only matters under a v2 root recorded in pki\
    expect(src).toContain("-ceq 'v2'");
    expect(src).not.toMatch(/Invoke-Expression|iex |Start-Process/i);
  });
});

describe.runIf(process.platform === 'win32')('install-cert-renew-task.ps1 dry run', () => {
  it('the task also runs every 15 minutes (the name check), next to the daily and start-up runs', () => {
    const d = tmp();
    mkdirSync(join(d, 'pki'), { recursive: true });
    writeFileSync(join(d, 'pki', 'box-ca.json'), JSON.stringify({ ip: '10.168.1.50', store: 'LocalMachine', surau: 'X', days: 730, noTrust: false }));
    const r = ps(installPath, ['-DataDir', d, '-DryRun']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/daily 03:30 \(random delay up to 10 minutes\); at startup \(random delay up to 10 minutes\); every 15 minutes/);
  }, 60_000);
});

describe.runIf(process.platform === 'win32')('box-ca.ps1 and box-cert-renew.ps1 with the local name (CurrentUser store, no trust)', () => {
  const tag = `NmTest${process.pid}${Date.now() % 100000}`;
  const run = (dir: string, surau: string, extra: string[] = []) =>
    ps(caPath, ['-Ip', '10.168.1.50', '-DataDir', dir, '-Store', 'CurrentUser', '-NoTrust', '-Surau', surau, ...extra]);
  const renew = (dir: string, extra: string[] = []) => ps(renewPath, ['-DataDir', dir, ...extra]);

  afterAll(() => {
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `$c = @(Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -like '*${tag}*' }); foreach ($x in $c) { Remove-Item -Path ('Cert:\\CurrentUser\\My\\' + $x.Thumbprint) -DeleteKey -Force }`]);
  });

  it('a new root is v2: the 99 numbered names (byte for byte the Android v2 list), the leaf carries the claimed name only', () => {
    const dir = tmp();
    const r = run(dir, `${tag}a`, ['-BoxName', 'box2-surau.local']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const root = rootOf(dir);
    expect(root.raw.includes(Buffer.from('box99-surau.local'))).toBe(true);
    expect(root.raw.includes(Buffer.from('box.surau.local'))).toBe(false);
    expect(ncBytes(root).equals(ncBytes(new X509Certificate(readFileSync(v2Fixture))))).toBe(true);
    const leaf = leafOf(dir);
    expect(leaf.subjectAltName).toContain('DNS:localhost');
    expect(leaf.subjectAltName).toContain('DNS:box2-surau.local');
    expect(leaf.subjectAltName).not.toContain('box.surau.local');
    expect(leaf.subjectAltName).toContain('IP Address:10.168.1.50');
    expect(leaf.verify(root.publicKey)).toBe(true);
    expect(meta(dir)).toEqual({ ip: '10.168.1.50', store: 'CurrentUser', surau: `${tag}a`, days: 730, noTrust: true, rootGeneration: 'v2' });
    expect(r.stdout).toContain('Local name: box2-surau.local');
  }, 120_000);

  it('a v2 root without a claim yet gives a leaf with localhost and the address only', () => {
    const dir = tmp();
    expect(run(dir, `${tag}b`).status).toBe(0);
    expect(leafOf(dir).subjectAltName).not.toMatch(/surau\.local/);
    expect(meta(dir).rootGeneration).toBe('v2');
  }, 120_000);

  it('a legacy root keeps localhost and box.surau.local and never takes the numbered name', () => {
    const dir = tmp();
    const r = run(dir, `${tag}c`, ['-LegacyRoot', '-BoxName', 'box2-surau.local']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const root = rootOf(dir);
    expect(root.raw.includes(Buffer.from('box.surau.local'))).toBe(true);
    expect(root.raw.includes(Buffer.from('box99-surau.local'))).toBe(false);
    const leaf = leafOf(dir);
    expect(leaf.subjectAltName).toContain('DNS:box.surau.local');
    expect(leaf.subjectAltName).not.toContain('box2-surau.local');
    expect(leaf.verify(root.publicKey)).toBe(true);
    expect(meta(dir).rootGeneration).toBe('legacy');
    expect(r.stdout).toContain('NOT in the leaf');
    // a plain renewal reuses the legacy root and stays legacy
    const again = run(dir, `${tag}c`, ['-Renew', '-BoxName', 'box2-surau.local']);
    expect(again.status, again.stderr).toBe(0);
    expect(rootOf(dir).fingerprint256).toBe(root.fingerprint256);
    expect(leafOf(dir).subjectAltName).toContain('DNS:box.surau.local');
  }, 180_000);

  it('-NewRoot moves a legacy box to a v2 root once; later runs keep that root', () => {
    const dir = tmp();
    expect(run(dir, `${tag}d`, ['-LegacyRoot']).status).toBe(0);
    const legacy = rootOf(dir);
    const moved = run(dir, `${tag}d`, ['-NewRoot', '-BoxName', 'box1-surau.local']);
    expect(moved.status, moved.stderr + moved.stdout).toBe(0);
    const v2 = rootOf(dir);
    expect(v2.fingerprint256).not.toBe(legacy.fingerprint256);
    expect(leafOf(dir).subjectAltName).toContain('DNS:box1-surau.local');
    expect(meta(dir).rootGeneration).toBe('v2');
    // both roots are now in the store: a renewal with no flag prefers v2 and does not make a third
    const again = run(dir, `${tag}d`, ['-Renew', '-BoxName', 'box1-surau.local']);
    expect(again.status, again.stderr).toBe(0);
    expect(rootOf(dir).fingerprint256).toBe(v2.fingerprint256);
    const twice = run(dir, `${tag}d`, ['-NewRoot']);
    expect(twice.status, twice.stderr).toBe(0);
    expect(rootOf(dir).fingerprint256).toBe(v2.fingerprint256);
  }, 240_000);

  it('refuses a name that is not exactly boxN-surau.local (and the odd switch pairs) before anything is written', () => {
    const bad = ['box0-surau.local', 'box100-surau.local', 'box01-surau.local', 'Box1-surau.local', 'BOX1-SURAU.LOCAL', 'box1.surau.local', 'box.surau.local', 'evil-surau.local',
      'box1-surau.local;calc', 'box1-surau.local&DNS=evil.com', 'box1-surau.local, DNS:evil.com', 'xbox1-surau.local', 'box1-surau.localx', 'box1-surau.local' + String.fromCharCode(10)];
    for (const name of bad) {
      const dir = tmp();
      const r = run(dir, `${tag}e`, ['-BoxName', name]);
      expect(r.status, name).not.toBe(0);
      expect(r.stderr, name).toContain('BoxName must be');
      expect(existsSync(join(dir, 'secret')), name).toBe(false);
      expect(existsSync(join(dir, 'pki')), name).toBe(false);
    }
    for (const pair of [['-NewRoot', '-LegacyRoot'], ['-NewRoot', '-Renew']]) {
      const dir = tmp();
      const r = run(dir, `${tag}e`, pair);
      expect(r.status, pair.join(' ')).not.toBe(0);
      expect(existsSync(join(dir, 'pki')), pair.join(' ')).toBe(false);
    }
  }, 240_000);

  it('the renewal puts a claimed name into the leaf at once, follows a change, then is quiet', () => {
    const dir = tmp();
    expect(run(dir, `${tag}f`).status).toBe(0);
    const root = rootOf(dir);
    // nothing claimed: nothing to do
    let r = renew(dir);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/SKIP/);
    // the box service claims box3
    claim(dir, claimN(3));
    r = renew(dir);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/RENEWED local name box3-surau\.local is not in the leaf/);
    let leaf = leafOf(dir);
    expect(leaf.subjectAltName).toContain('DNS:box3-surau.local');
    expect(leaf.verify(root.publicKey)).toBe(true);
    expect(rootOf(dir).fingerprint256).toBe(root.fingerprint256);
    // already there: skip
    r = renew(dir);
    expect(r.stdout).toMatch(/SKIP/);
    // a conflict moved it to box4
    claim(dir, claimN(4));
    r = renew(dir);
    expect(r.stdout).toMatch(/RENEWED local name box4-surau\.local/);
    leaf = leafOf(dir);
    expect(leaf.subjectAltName).toContain('DNS:box4-surau.local');
    expect(leaf.subjectAltName).not.toContain('box3-surau.local');
    // a renewal for another reason keeps the claimed name; with no claim file it keeps the name the leaf had
    rmSync(join(dir, 'box-name.json'));
    r = renew(dir, ['-Force']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(leafOf(dir).subjectAltName).toContain('DNS:box4-surau.local');
    // the log keeps one SKIP line a day, not one per run
    const n0 = logLines(dir).length;
    for (let i = 0; i < 3; i++) expect(renew(dir).stdout).toMatch(/SKIP/);
    expect(logLines(dir).length).toBe(n0 + 1);
  }, 360_000);

  it('a hostile or damaged claim file changes nothing: only an integer 1 to 99 in a small plain file counts', () => {
    const dir = tmp();
    expect(run(dir, `${tag}g`, ['-BoxName', 'box1-surau.local']).status).toBe(0);
    const before = readFileSync(join(dir, 'pki', 'box-leaf.cer'));
    const hostile: [string, string][] = [
      ['zero', claimN(0)],
      ['over 99', claimN(100)],
      ['three digits', claimN(123)],
      ['leading zero', '{"n":007,"claimedAt":"2026-11-24T10:00:00Z"}'],
      ['string', '{"n":"2","claimedAt":"2026-11-24T10:00:00Z"}'],
      ['injection', '{"n":2;calc,"claimedAt":"x"}'],
      ['name text', '{"n":"box2-surau.local; DNS:evil.com"}'],
      ['negative', claimN(-2)],
      ['float', '{"n":2.5}'],
      ['not an object', '[2]'],
      ['nested braces', '{"a":{"n":2}}'],
      ['empty', ''],
      ['binary', '\u0000\u0001\u0002'],
      ['too big', `{"n":2,"pad":"${'x'.repeat(3000)}"}`],
    ];
    for (const [label, text] of hostile) {
      claim(dir, text);
      const r = renew(dir);
      expect(r.status, label).toBe(0);
      expect(readFileSync(join(dir, 'pki', 'box-leaf.cer')).equals(before), label).toBe(true);
    }
    // a folder where the file belongs
    rmSync(join(dir, 'box-name.json'));
    mkdirSync(join(dir, 'box-name.json'));
    const r = renew(dir);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, 'pki', 'box-leaf.cer')).equals(before)).toBe(true);
  }, 240_000);

  it('a claim file reached through a link is not read', () => {
    const dir = tmp();
    expect(run(dir, `${tag}h`, ['-BoxName', 'box1-surau.local']).status).toBe(0);
    const before = readFileSync(join(dir, 'pki', 'box-leaf.cer'));
    const outside = tmp();
    writeFileSync(join(outside, 'real.json'), claimN(9));
    // a file symbolic link needs a privilege the box account does not have; a test account may not have it either
    const made = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `try { New-Item -ItemType SymbolicLink -Path '${join(dir, 'box-name.json')}' -Target '${join(outside, 'real.json')}' -ErrorAction Stop | Out-Null; 'made' } catch { 'denied' }`], { encoding: 'utf8' });
    if (made.stdout.trim() !== 'made') return;
    const r = renew(dir);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, 'pki', 'box-leaf.cer')).equals(before)).toBe(true);
    expect(leafOf(dir).subjectAltName).not.toContain('box9-surau.local');
  }, 120_000);

  it('under a legacy root a claim renews nothing (a legacy root cannot vouch for it): no renewal loop', () => {
    const dir = tmp();
    expect(run(dir, `${tag}i`, ['-LegacyRoot']).status).toBe(0);
    const before = readFileSync(join(dir, 'pki', 'box-leaf.cer'));
    claim(dir, claimN(2));
    const r = renew(dir);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/SKIP/);
    expect(readFileSync(join(dir, 'pki', 'box-leaf.cer')).equals(before)).toBe(true);
  }, 180_000);

  it('the renewal never prints or logs the claim file text', () => {
    const dir = tmp();
    expect(run(dir, `${tag}j`).status).toBe(0);
    claim(dir, '{"n":2,"claimedAt":"2026-11-24T10:00:00Z","secret":"SENTINEL-TEXT-1234"}');
    const r = renew(dir);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout + r.stderr).not.toContain('SENTINEL-TEXT-1234');
    expect(readFileSync(join(dir, 'logs', 'cert-renew.log'), 'utf8')).not.toContain('SENTINEL-TEXT-1234');
  }, 180_000);
});
