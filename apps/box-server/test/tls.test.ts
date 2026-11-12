import { execFileSync, spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, utimesSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import https from 'node:https';
import { connect } from 'node:tls';
import { certInfo, expiryWarning, loadTls, pkiStatus, startCertReload } from '../src/tls.ts';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const scriptPath = fileURLToPath(new URL('../../../scripts/box-ca.ps1', import.meta.url));
const renewPath = fileURLToPath(new URL('../../../scripts/box-cert-renew.ps1', import.meta.url));
const installPath = fileURLToPath(new URL('../../../scripts/install-cert-renew-task.ps1', import.meta.url));

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-tls-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Lays the checked-in fixture out as a data dir. */
function fixtureDir(): string {
  const d = tmp();
  mkdirSync(join(d, 'secret'));
  mkdirSync(join(d, 'pki'));
  cpSync(join(fixtures, 'test-box.pfx'), join(d, 'secret', 'box.pfx'));
  writeFileSync(join(d, 'secret', 'pfx.pass'), 'test');
  cpSync(join(fixtures, 'test-box-leaf.cer'), join(d, 'pki', 'box-leaf.cer'));
  return d;
}

describe('loadTls', () => {
  it('returns null for an empty data dir', () => {
    expect(loadTls(tmp())).toBeNull();
  });

  it('loads the fixture PFX and reads SANs from the leaf', () => {
    const t = loadTls(fixtureDir());
    expect(t).not.toBeNull();
    expect(t!.mode).toBe('ip');
    expect(t!.ipSan).toContain('127.0.0.1');
    expect(t!.dnsSan).toContain('localhost');
    expect(t!.pfx.length).toBeGreaterThan(0);
    const info = certInfo(t!);
    expect(Number.isInteger(info.daysLeft)).toBe(true);
    expect(info.daysLeft).toBeGreaterThan(0);
    expect(info.mode).toBe('ip');
    expect(info.ipSan).toContain('127.0.0.1');
  });

  it('is at most 825 days valid', () => {
    const t = loadTls(fixtureDir())!;
    const leaf = readFileSync(join(fixtures, 'test-box-leaf.cer'));
    expect(leaf.length).toBeGreaterThan(0);
    const days = (t.notAfter.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeLessThanOrEqual(825);
  });

  it('throws /expired/ when notAfter is in the past', () => {
    expect(() => loadTls(fixtureDir(), new Date('2099-01-01'))).toThrow(/expired/);
  });

  it('throws /passphrase/ when the passphrase file is wrong, without echoing it', () => {
    const d = fixtureDir();
    writeFileSync(join(d, 'secret', 'pfx.pass'), 'definitely-wrong-pass');
    let msg = '';
    try {
      loadTls(d);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/passphrase/);
    expect(msg).not.toContain('definitely-wrong-pass');
  });

  it('returns null when only some files exist (never a partial load)', () => {
    const d = fixtureDir();
    rmSync(join(d, 'pki', 'box-leaf.cer'));
    expect(loadTls(d)).toBeNull();
  });

  it('domain mode with missing files is null; bad tls.json throws', () => {
    const d = tmp();
    mkdirSync(join(d, 'secret'));
    writeFileSync(
      join(d, 'secret', 'tls.json'),
      JSON.stringify({ mode: 'domain', certFile: join(d, 'no.crt'), keyFile: join(d, 'no.key') }),
    );
    expect(loadTls(d)).toBeNull();
    writeFileSync(join(d, 'secret', 'tls.json'), '{not json');
    expect(() => loadTls(d)).toThrow(/tls\.json/);
  });
});

function putPem(d: string, which: '' | '2' = ''): void {
  cpSync(join(fixtures, `test-box${which}-key.pem`), join(d, 'secret', 'box-key.pem'));
  cpSync(join(fixtures, `test-box${which}-leaf.cer`), join(d, 'pki', 'box-leaf.cer'));
}

function pemDir(): string {
  const d = tmp();
  mkdirSync(join(d, 'secret'));
  mkdirSync(join(d, 'pki'));
  putPem(d);
  return d;
}

describe('loadTls with a PEM leaf key (no PFX)', () => {
  it('loads the pair and reports the leaf names', () => {
    const t = loadTls(pemDir())!;
    expect(t.mode).toBe('ip');
    expect(t.pfx.length).toBe(0);
    expect(t.passphrase).toBe('');
    expect(t.cert!.length).toBeGreaterThan(0);
    expect(t.key!.length).toBeGreaterThan(0);
    expect(t.ipSan).toContain('127.0.0.1');
    expect(t.dnsSan).toContain('localhost');
  });

  it('throws a fixed message for a key that does not match, without key bytes', () => {
    const d = pemDir();
    cpSync(join(fixtures, 'test-box2-key.pem'), join(d, 'secret', 'box-key.pem'));
    let message = '';
    try {
      loadTls(d);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe('TLS key does not match the certificate');
    const keyBody = readFileSync(join(fixtures, 'test-box2-key.pem'), 'utf8').split('\n')[1]!;
    expect(message).not.toContain(keyBody);
  });

  it('uses the PFX when both a PFX and a PEM pair are present', () => {
    const d = fixtureDir();
    cpSync(join(fixtures, 'test-box2-key.pem'), join(d, 'secret', 'box-key.pem'));
    const t = loadTls(d)!;
    expect(t.pfx.length).toBeGreaterThan(0);
    expect(t.key).toBeUndefined();
  });

  it('reload from one PEM pair to a renewed one answers reloaded', () => {
    const d = pemDir();
    const calls: unknown[] = [];
    const r = startCertReload({
      server: { setSecureContext: (o) => void calls.push(o) },
      dataDir: d,
      current: loadTls(d)!,
      baseOptions: { minVersion: 'TLSv1.2' },
      intervalMs: 3_600_000,
      warn: () => undefined,
    });
    try {
      expect(r.check()).toBe('unchanged');
      putPem(d, '2');
      expect(r.check()).toBe('reloaded');
      expect(calls).toHaveLength(1);
      expect((calls[0] as { key?: Buffer }).key).toBeDefined();
    } finally {
      r.stop();
    }
  });
});

function putFixture2(d: string): void {
  cpSync(join(fixtures, 'test-box2.pfx'), join(d, 'secret', 'box.pfx'));
  cpSync(join(fixtures, 'test-box2-leaf.cer'), join(d, 'pki', 'box-leaf.cer'));
}

function peerFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      const fp = socket.getPeerCertificate().fingerprint256;
      socket.end();
      resolve(fp);
    });
    socket.on('error', reject);
  });
}

describe('startCertReload (renewed leaf without a restart)', () => {
  const base = { minVersion: 'TLSv1.2' as const };

  it('swaps in a changed valid leaf, ignores an unchanged one, keeps the old context on a bad file', () => {
    const d = fixtureDir();
    const calls: unknown[] = [];
    const warnings: string[] = [];
    const first = loadTls(d)!;
    const r = startCertReload({
      server: { setSecureContext: (o) => void calls.push(o) },
      dataDir: d,
      current: first,
      baseOptions: base,
      intervalMs: 3_600_000,
      warn: (m) => void warnings.push(m),
    });
    try {
      expect(r.check()).toBe('unchanged');
      expect(calls).toHaveLength(0);

      // A new leaf appears (second fixture).
      putFixture2(d);
      expect(r.check()).toBe('reloaded');
      expect(calls).toHaveLength(1);
      const applied = calls[0] as { pfx: Buffer; passphrase: string; minVersion: string };
      expect(applied.pfx.equals(readFileSync(join(d, 'secret', 'box.pfx')))).toBe(true);
      expect(applied.minVersion).toBe('TLSv1.2');
      expect(r.current().ipSan).toContain('10.168.1.60');
      expect(r.check()).toBe('unchanged');

      // Garbage replaces the leaf and PFX: the previous context stays, one warning, no passphrase in it.
      writeFileSync(join(d, 'secret', 'box.pfx'), 'not a pfx');
      expect(r.check()).toBe('invalid');
      expect(r.check()).toBe('invalid');
      expect(calls).toHaveLength(1);
      expect(r.current().ipSan).toContain('10.168.1.60');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/previous one/);
      expect(warnings[0]).not.toContain('test"');

      // An unreadable leaf file is also kept out.
      putFixture2(d);
      writeFileSync(join(d, 'pki', 'box-leaf.cer'), 'junk');
      expect(r.check()).toBe('invalid');
      expect(calls).toHaveLength(1);

      // Missing files: warn, keep.
      rmSync(join(d, 'pki', 'box-leaf.cer'));
      expect(r.check()).toBe('invalid');
      expect(calls).toHaveLength(1);
    } finally {
      r.stop();
    }
  });

  it('an exception in onReload is caught and logged: the new leaf is still in use and the timer survives', () => {
    const d = fixtureDir();
    const calls: unknown[] = [];
    const warnings: string[] = [];
    const r = startCertReload({
      server: { setSecureContext: (o) => void calls.push(o) },
      dataDir: d,
      current: loadTls(d)!,
      baseOptions: base,
      warn: (m) => void warnings.push(m),
      onReload: () => {
        throw new TypeError("Cannot read properties of undefined (reading 'setAllowedHosts')");
      },
    });
    try {
      putFixture2(d);
      expect(() => r.check()).not.toThrow();
      expect(r.check()).toBe('unchanged');
      expect(calls).toHaveLength(1);
      expect(r.current().ipSan).toContain('10.168.1.60');
      expect(warnings.some((w) => /reload callback failed/.test(w))).toBe(true);
    } finally {
      r.stop();
    }
  });

  it('a callback that works is still called once with the new material', () => {
    const d = fixtureDir();
    const seen: string[][] = [];
    const r = startCertReload({
      server: { setSecureContext: () => undefined },
      dataDir: d,
      current: loadTls(d)!,
      baseOptions: base,
      warn: () => undefined,
      onReload: (next) => void seen.push(next.ipSan),
    });
    try {
      putFixture2(d);
      expect(r.check()).toBe('reloaded');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('10.168.1.60');
    } finally {
      r.stop();
    }
  });

  it('refuses a new leaf that is already expired', () => {
    const d = fixtureDir();
    const calls: unknown[] = [];
    const r = startCertReload({
      server: { setSecureContext: (o) => void calls.push(o) },
      dataDir: d,
      current: loadTls(d)!,
      baseOptions: base,
      now: () => new Date('2099-01-01'),
      warn: () => undefined,
    });
    try {
      putFixture2(d);
      expect(r.check()).toBe('invalid');
      expect(calls).toHaveLength(0);
    } finally {
      r.stop();
    }
  });

  it('a live HTTPS server serves the new leaf to new connections after check()', async () => {
    const d = fixtureDir();
    const first = loadTls(d)!;
    const server = https.createServer({ pfx: first.pfx, passphrase: first.passphrase });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as { port: number }).port;
    const r = startCertReload({ server, dataDir: d, current: first, baseOptions: base, warn: () => undefined });
    try {
      const before = await peerFingerprint(port);
      expect(r.check()).toBe('unchanged');
      putFixture2(d);
      expect(r.check()).toBe('reloaded');
      const after = await peerFingerprint(port);
      expect(after).not.toBe(before);
      expect(after).toBe(new X509Certificate(readFileSync(join(d, 'pki', 'box-leaf.cer'))).fingerprint256);
    } finally {
      r.stop();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe('pkiStatus', () => {
  it('is all null for an empty data dir', () => {
    expect(pkiStatus(tmp())).toEqual({ leafNotAfter: null, leafDaysLeft: null, rootNotAfter: null });
  });

  it('reads expiry from the files and the last renewal that did something from the log', () => {
    const d = fixtureDir();
    cpSync(join(fixtures, 'test-box2-leaf.cer'), join(d, 'pki', 'root-ca.cer'));
    mkdirSync(join(d, 'logs'));
    const log = join(d, 'logs', 'cert-renew.log');
    writeFileSync(log, '2026-11-01T03:30:00+08:00 RENEWED ok\r\n2026-11-02T03:30:00+08:00 SKIP fine\r\n');
    let s = pkiStatus(d, new Date('2026-11-04T00:00:00Z'));
    expect(s.lastRenewOk).toBe(true);
    expect(s.lastRenewAttempt).toBe(new Date('2026-11-01T03:30:00+08:00').toISOString());
    expect(s.leafDaysLeft).toBeGreaterThan(100);
    expect(s.rootNotAfter).toMatch(/^20\d\d-/);
    writeFileSync(log, 'garbage line\r\n2026-11-03T03:30:00+08:00 FAIL boom\r\nnot a date FAIL x\r\n');
    s = pkiStatus(d);
    expect(s.lastRenewOk).toBe(false);
    writeFileSync(log, 'garbage\r\n');
    s = pkiStatus(d);
    expect(s).not.toHaveProperty('lastRenewAttempt');
    expect(s).not.toHaveProperty('lastRenewOk');
  });

  describe('renewal log location', () => {
    const OLD = '2026-11-01T03:30:00+08:00 RENEWED old\r\n';
    const NEW = '2026-11-05T03:30:00+08:00 FAIL new\r\n';
    function layout(): { data: string; oldLog: string; newLog: string } {
      const parent = tmp();
      const data = join(parent, 'data');
      mkdirSync(join(data, 'logs'), { recursive: true });
      mkdirSync(join(parent, 'logs'));
      return { data, oldLog: join(data, 'logs', 'cert-renew.log'), newLog: join(parent, 'logs', 'cert-renew.log') };
    }
    const at = (f: string, sec: number): void => utimesSync(f, sec, sec);

    it('reads only the old <dataDir>/logs path', () => {
      const l = layout();
      writeFileSync(l.oldLog, OLD);
      expect(pkiStatus(l.data).lastRenewOk).toBe(true);
    });

    it('reads only the new <parent>/logs path', () => {
      const l = layout();
      writeFileSync(l.newLog, NEW);
      const s = pkiStatus(l.data);
      expect(s.lastRenewOk).toBe(false);
      expect(s.lastRenewAttempt).toBe(new Date('2026-11-05T03:30:00+08:00').toISOString());
    });

    it('prefers the newer file by mtime when both exist', () => {
      const l = layout();
      writeFileSync(l.oldLog, OLD);
      writeFileSync(l.newLog, NEW);
      at(l.oldLog, 1000);
      at(l.newLog, 2000);
      expect(pkiStatus(l.data).lastRenewOk).toBe(false);
      at(l.oldLog, 3000);
      expect(pkiStatus(l.data).lastRenewOk).toBe(true);
    });

    it('does not throw and reports no renewal when neither exists', () => {
      const s = pkiStatus(layout().data);
      expect(s).not.toHaveProperty('lastRenewAttempt');
      expect(s).not.toHaveProperty('lastRenewOk');
    });
  });
});

describe('expiryWarning', () => {
  it('warns under 30 days, silent otherwise', () => {
    const t = loadTls(fixtureDir())!;
    expect(expiryWarning(t)).toBeNull();
    const near = new Date(t.notAfter.getTime() - 10 * 86_400_000);
    expect(expiryWarning(t, near)).toMatch(/10 days/);
  });
});

describe('box-ca.ps1 static checks', () => {
  const src = readFileSync(scriptPath, 'utf8');

  it('is pure ASCII', () => {
    for (let i = 0; i < src.length; i++) expect(src.charCodeAt(i)).toBeLessThan(128);
  });

  it('has the required security elements', () => {
    expect(src).toContain('-TextExtension');
    expect(src).toContain('825');
    expect(src).toContain('icacls');
    expect(src).toContain('ECDSA_nistP256');
    expect(src).toContain('2.5.29.19={critical}{text}ca=true');
    expect(src).toContain('IPAddress=');
    expect(src).toContain('1.3.6.1.5.5.7.3.1');
  });

  it('constrains the root CA to the box names with critical NameConstraints (S1)', () => {
    expect(src).toContain('2.5.29.30={critical}{hex}');
    expect(src).toMatch(/NameConstraints/i);
    // Permitted subtrees: DNS names only (localhost, box.surau.local). BoringSSL (Flutter / Android
    // app) fails the handshake on an IP subtree ("unsupported name constraint type"), so none may be built.
    expect(src).toContain('localhost');
    expect(src).toContain('box.surau.local');
    expect(src).not.toContain('0x87');
    expect(src).toMatch(/function Get-NameConstraintsHex\(\[string\[\]\]\$dnsNames\)/);
    expect(src).not.toContain('Test-CaPermitsIp');
    // The constraint is part of the CA request, not of the leaf request.
    const caCall = src.slice(src.indexOf('$ca = New-SelfSignedCertificate'), src.indexOf('$leaf = New-SelfSignedCertificate'));
    expect(caCall).toContain('$nameConstraints');
    const leafCall = src.slice(src.indexOf('$leaf = New-SelfSignedCertificate'));
    expect(leafCall.slice(0, leafCall.indexOf('-CertStoreLocation'))).not.toContain('nameConstraints');
  });

  it('root CA lives 20 years and the leaf stays under the Apple limit; settings are recorded for the renewal job', () => {
    expect(src).toContain('.AddYears(20)');
    expect(src).not.toContain('.AddYears(10)');
    expect(src).toContain('[int]$Days = 730');
    expect(src).toContain("'box-ca.json'");
    // Only non-secret settings are recorded.
    const at = src.indexOf('$meta = ');
    const metaLine = src.slice(at, src.indexOf('\n', at));
    expect(metaLine).toContain('ip = $Ip');
    expect(metaLine).not.toMatch(/phrase|pass|pfx|key/i);
  });

  it('never prints the passphrase and does not use openssl', () => {
    expect(src).not.toMatch(/Write-(Host|Output|Verbose|Debug)[^\r\n]*\$pass/i);
    expect(src).not.toMatch(/\$pass\w*\s*\|\s*(Out-|Write-)/i);
    expect(src).not.toMatch(/openssl/i);
  });
});

describe('renewal scripts static checks', () => {
  for (const [name, path] of [
    ['box-cert-renew.ps1', renewPath],
    ['install-cert-renew-task.ps1', installPath],
  ] as const) {
    const src = readFileSync(path, 'utf8');
    it(`${name} is pure ASCII and never touches the passphrase`, () => {
      for (let i = 0; i < src.length; i++) expect(src.charCodeAt(i)).toBeLessThan(128);
      expect(src).not.toMatch(/pfx\.pass|\$phrase/i);
      expect(src).not.toMatch(/openssl/i);
    });
  }

  it('the renew script keeps 200 log lines, reads the recorded settings and runs box-ca.ps1 -Renew', () => {
    const src = readFileSync(renewPath, 'utf8');
    expect(src).toContain('200');
    expect(src).toContain('cert-renew.log');
    expect(src).toContain('box-ca.json');
    expect(src).toContain('Renew = $true');
    expect(src).toContain('$ThresholdDays = 60');
  });

  it('the task installer registers MaxcomCertRenew daily 03:30 plus startup, highest privileges, not SYSTEM', () => {
    const src = readFileSync(installPath, 'utf8');
    expect(src).toContain("'MaxcomCertRenew'");
    expect(src).toContain("'03:30'");
    expect(src).toContain('-AtStartup');
    expect(src).toContain('-RunLevel Highest');
    expect(src).toContain('[switch]$Uninstall');
    expect(src).not.toMatch(/-UserId\s+['"]?SYSTEM/i);
  });

  it('the task installer checks write access to the scripts folder and data\pki before registering (S4)', () => {
    const src = readFileSync(installPath, 'utf8');
    expect(src).toContain('Get-UntrustedWriters');
    expect(src).toContain('S-1-5-32-544');
    expect(src).toContain('icacls.exe $pkiDir');
    expect(src).toMatch(/Refusing to register/);
    // the check runs before the task is registered
    expect(src.indexOf('Get-UntrustedWriters $PSScriptRoot')).toBeLessThan(src.indexOf('Register-ScheduledTask'));
  });
});

describe.skipIf(process.platform !== 'win32')('install-cert-renew-task.ps1 dry run (nothing is registered)', () => {
  const psFile = (args: string[]) =>
    spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installPath, ...args], { encoding: 'utf8' });

  it('describes the task for a LocalMachine CA (S4U, highest) and for a CurrentUser CA (interactive)', () => {
    const d = tmp();
    mkdirSync(join(d, 'pki'));
    writeFileSync(join(d, 'pki', 'box-ca.json'), JSON.stringify({ ip: '10.168.1.50', store: 'LocalMachine', surau: 'X', days: 730, noTrust: false }));
    let r = psFile(['-DataDir', d, '-DryRun']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/task\s+: MaxcomCertRenew/);
    expect(r.stdout).toMatch(/logon S4U, run level Highest, CA store LocalMachine/);
    expect(r.stdout).toMatch(/daily 03:30/);
    expect(r.stdout).toMatch(/at startup/);
    expect(r.stdout).toContain('box-cert-renew.ps1');
    writeFileSync(join(d, 'pki', 'box-ca.json'), JSON.stringify({ ip: '10.168.1.50', store: 'CurrentUser', surau: 'X', days: 730, noTrust: true }));
    r = psFile(['-DataDir', d, '-DryRun']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/logon Interactive, run level Highest, CA store CurrentUser/);
    r = psFile(['-Uninstall', '-DryRun']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/MaxcomCertRenew/);
  }, 60_000);
});

describe.skipIf(process.platform !== 'win32')('box-ca.ps1 run (CurrentUser store, no trust)', () => {
  const tag = `NcTest${process.pid}${Date.now() % 100000}`;
  const subject = (n: string): string => `CN=MAXCOM Root CA ${n}`;
  const ps = (args: string[]) =>
    spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], { encoding: 'utf8' });
  const run = (dataDir: string, surau: string, extra: string[] = []) =>
    ps(['-Ip', '10.168.1.50', '-DataDir', dataDir, '-Store', 'CurrentUser', '-NoTrust', '-Surau', surau, ...extra]);

  afterAll(() => {
    // Remove every throw-away CA/leaf this block made from Cert:\CurrentUser\My.
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command',
        `$c = @(Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -like '*${tag}*' }); foreach ($x in $c) { Remove-Item -Path ('Cert:\\CurrentUser\\My\\' + $x.Thumbprint) -DeleteKey -Force }`],
    );
  });

  it('works with an absolute -DataDir, constrains the root to the two DNS names only and renews', () => {
    const dir = tmp();
    const r = run(dir, `${tag}a`);
    expect(r.status, r.stderr).toBe(0);
    const root = new X509Certificate(readFileSync(join(dir, 'pki', 'root-ca.cer')));
    // Raw DER: critical NameConstraints (2.5.29.30) = permitted [0] with exactly two dNSName ([2]) subtrees.
    const der = root.raw;
    const expectedNc = Buffer.concat([
      Buffer.from([0x30, 0x22, 0xa0, 0x20, 0x30, 0x0b, 0x82, 0x09]),
      Buffer.from('localhost'),
      Buffer.from([0x30, 0x11, 0x82, 0x0f]),
      Buffer.from('box.surau.local'),
    ]);
    expect(der.includes(expectedNc)).toBe(true);
    expect(der.includes(Buffer.from([0x55, 0x1d, 0x1e, 0x01, 0x01, 0xff]))).toBe(true);
    // No iPAddress ([7]) subtree base anywhere.
    expect(der.includes(Buffer.from([0x87, 0x08]))).toBe(false);
    const leaf = new X509Certificate(readFileSync(join(dir, 'pki', 'box-leaf.cer')));
    expect(leaf.subjectAltName).toContain('IP Address:10.168.1.50');
    expect(leaf.subjectAltName).toContain('DNS:localhost');
    expect(leaf.subjectAltName).toContain('DNS:box.surau.local');
    expect(leaf.verify(root.publicKey)).toBe(true);
    // Renew keeps the same root.
    const again = run(dir, `${tag}a`, ['-Renew']);
    expect(again.status, again.stderr).toBe(0);
    const root2 = new X509Certificate(readFileSync(join(dir, 'pki', 'root-ca.cer')));
    expect(root2.fingerprint256).toBe(root.fingerprint256);
  }, 120_000);

  it('makes a 20 year root, records its settings and box-cert-renew.ps1 renews only when due, logging each run', () => {
    const name = `${tag}c`;
    const dir = tmp();
    const made = run(dir, name, ['-Days', '400']);
    expect(made.status, made.stderr).toBe(0);
    const root = new X509Certificate(readFileSync(join(dir, 'pki', 'root-ca.cer')));
    const years = (new Date(root.validTo).getTime() - Date.now()) / (365.25 * 86_400_000);
    expect(years).toBeGreaterThan(19.9);
    expect(years).toBeLessThan(20.1);
    const meta = JSON.parse(readFileSync(join(dir, 'pki', 'box-ca.json'), 'utf8'));
    expect(meta).toEqual({ ip: '10.168.1.50', store: 'CurrentUser', surau: name, days: 400, noTrust: true });
    const leafBefore = readFileSync(join(dir, 'pki', 'box-leaf.cer'));
    const logFile = join(dir, 'logs', 'cert-renew.log');
    const logLines = (): string[] => readFileSync(logFile, 'utf8').trim().split(/\r?\n/);
    const renew = (extra: string[] = []) =>
      spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', renewPath, '-DataDir', dir, ...extra], { encoding: 'utf8' });

    // Valid for 400 days: nothing to do, one SKIP line, leaf untouched.
    let r = renew();
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(readFileSync(join(dir, 'pki', 'box-leaf.cer')).equals(leafBefore)).toBe(true);
    expect(logLines()).toHaveLength(1);
    expect(logLines()[0]).toMatch(/^\S+ SKIP /);

    // -CheckOnly changes and logs nothing.
    r = renew(['-ThresholdDays', '500', '-CheckOnly']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/WOULD-RENEW/);
    expect(readFileSync(join(dir, 'pki', 'box-leaf.cer')).equals(leafBefore)).toBe(true);
    expect(logLines()).toHaveLength(1);

    // Inside the threshold: renewed under the same root and IP, new leaf file.
    r = renew(['-ThresholdDays', '500']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const leafAfter = readFileSync(join(dir, 'pki', 'box-leaf.cer'));
    expect(leafAfter.equals(leafBefore)).toBe(false);
    const leaf = new X509Certificate(leafAfter);
    expect(leaf.subjectAltName).toContain('IP Address:10.168.1.50');
    expect(leaf.verify(root.publicKey)).toBe(true);
    expect(new X509Certificate(readFileSync(join(dir, 'pki', 'root-ca.cer'))).fingerprint256).toBe(root.fingerprint256);
    expect(logLines()).toHaveLength(2);
    expect(logLines()[1]).toMatch(/^\S+ RENEWED /);
    const pass = readFileSync(join(dir, 'secret', 'pfx.pass'), 'utf8').trim();
    expect(readFileSync(logFile, 'utf8')).not.toContain(pass);
    expect(r.stdout + r.stderr).not.toContain(pass);
    expect(pkiStatus(dir)).toMatchObject({ lastRenewOk: true });

    // A missing leaf is rebuilt from the recorded settings; a missing box-ca.json is a FAIL with exit 1.
    rmSync(join(dir, 'pki', 'box-leaf.cer'));
    r = renew();
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(existsSync(join(dir, 'pki', 'box-leaf.cer'))).toBe(true);
    rmSync(join(dir, 'pki', 'box-ca.json'));
    r = renew(['-Force']);
    expect(r.status).toBe(1);
    expect(logLines().pop()).toMatch(/^\S+ FAIL /);
    expect(pkiStatus(dir)).toMatchObject({ lastRenewOk: false });
  }, 240_000);

  it('keeps only the last 200 log lines', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'pki'));
    mkdirSync(join(dir, 'logs'));
    const logFile = join(dir, 'logs', 'cert-renew.log');
    writeFileSync(logFile, Array.from({ length: 250 }, (_, i) => `2026-01-01T00:00:00+08:00 SKIP old ${i}`).join('\r\n') + '\r\n');
    cpSync(join(fixtures, 'test-box-leaf.cer'), join(dir, 'pki', 'box-leaf.cer'));
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', renewPath, '-DataDir', dir], { encoding: 'utf8' });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const lines = readFileSync(logFile, 'utf8').trim().split(/\r?\n/);
    expect(lines).toHaveLength(200);
    expect(lines[199]).toMatch(/SKIP leaf valid/);
    expect(lines[0]).toMatch(/old 51$/);
  }, 60_000);

  it('refuses -Renew for a root without the DNS-only constraint (older roots)', () => {
    const name = `${tag}b`;
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `New-SelfSignedCertificate -Subject '${subject(name)}' -KeyAlgorithm ECDSA_nistP256 -KeyUsage CertSign,CRLSign -TextExtension @('2.5.29.19={critical}{text}ca=true') -CertStoreLocation Cert:\\CurrentUser\\My | Out-Null`]);
    const r = run(tmp(), name, ['-Renew']);
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/cannot be renewed/);
    expect(`${r.stderr}${r.stdout}`).toMatch(/new root/i);
  }, 120_000);
});
