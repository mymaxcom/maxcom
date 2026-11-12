import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const doctorPath = fileURLToPath(new URL('../../../scripts/setup/doctor.ps1', import.meta.url));
const cmdPath = fileURLToPath(new URL('../../../scripts/setup/Semak MAXCOM.cmd', import.meta.url));
const src = readFileSync(doctorPath, 'utf8');
const cmd = readFileSync(cmdPath, 'utf8');
const isWin = process.platform === 'win32';

const CHECK_IDS = [
  'health_http', 'health_https', 'release', 'cert_days', 'fw_webrtc', 'fw_srt', 'fw_https', 'tools', 'task_box',
  'task_renew', 'task_firewall', 'task_kiosk', 'box_account', 'acl_data', 'acl_root', 'disk', 'log_warnings', 'box_id',
];
const PFX_PASS = 'SECRET-PFX-PASS-9f3a1c7e-do-not-print';

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('doctor.ps1 static checks', () => {
  it('doctor.ps1 and Semak MAXCOM.cmd are pure ASCII with CRLF line ends', () => {
    for (const text of [src, cmd]) {
      for (let i = 0; i < text.length; i++) expect(text.charCodeAt(i)).toBeLessThan(128);
      expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    }
  });

  it('only reads: no Set-, Remove-, Register-, icacls /grant or netsh add', () => {
    expect(src).not.toMatch(/\bSet-/);
    expect(src).not.toMatch(/\bRemove-/);
    expect(src).not.toMatch(/\bRegister-/);
    expect(src).not.toMatch(/icacls[^\r\n]*\/grant/i);
    expect(src).not.toMatch(/netsh[^\r\n]*\badd\b/i);
    expect(src).not.toMatch(/Unregister|Start-ScheduledTask|Stop-|Enable-|Disable-|New-Item|Out-File|Add-Content|WriteAllText/);
    expect(src).not.toContain('&&');
    expect(src).not.toMatch(/\?\?|\?\./);
  });

  it('declares the documented parameters and every check id', () => {
    for (const p of ['$InstallRoot', '$Wait', '[switch]$Json', '$ExpectBoxId', '[switch]$SkipSystemChecks']) expect(src).toContain(p);
    for (const id of CHECK_IDS) expect(src, id).toContain(`'${id}'`);
  });

  it('uses the names the setup writes: tasks, firewall rules, accounts, data ACL', () => {
    for (const s of ['MAXCOM Box', 'MaxcomCertRenew', 'MAXCOM Live Firewall', 'MAXCOM Kiosk']) expect(src).toContain(s);
    for (const s of ['MAXCOM Live WebRTC', 'MAXCOM Live SRT', 'MAXCOM Box HTTPS']) expect(src).toContain(s);
    for (const s of ['S-1-5-18', 'S-1-5-32-544', 'S-1-5-19', 'Get-MaxcomDataAclProblem', 'box-leaf.cer']) expect(src).toContain(s);
    expect(src).toContain('perlukan Run as administrator');
  });

  it('checks the firewall with the NetSecurity cmdlets and filters, not netsh text (locale neutral)', () => {
    for (const s of ['Get-NetFirewallRule', 'Get-NetFirewallPortFilter', 'Get-NetFirewallApplicationFilter', 'Get-NetFirewallAddressFilter']) expect(src).toContain(s);
    expect(src).not.toMatch(/netsh/i);
  });

  it('does not override certificate validation and never reads pfx.pass', () => {
    expect(src).not.toMatch(/ServerCertificateValidationCallback|ServerCertificateCustomValidationCallback|CertificatePolicy|-SkipCertificateCheck/);
    expect(src).not.toContain('pfx.pass');
  });

  it('Semak MAXCOM.cmd runs doctor.ps1 on the folder above bin and pauses', () => {
    expect(cmd).toContain('@echo off');
    expect(cmd).toContain('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0doctor.ps1" -InstallRoot "%~dp0.." %*');
    expect(cmd).toMatch(/ & pause\r\n$/);
  });
});

interface Env {
  base: string;
  root: string;
  data: string;
  port: number;
  boxKey: Buffer;
}

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "maxcom uji & 'doctor' "));
  dirs.push(d);
  return d;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

/** A hand-made installed layout (what setup -LayoutOnly leaves) in a temp folder with a space, & and '. */
async function makeEnv(version = '2026.11.1'): Promise<Env> {
  const base = tmp();
  const root = join(base, 'Program Files', 'MAXCOM');
  const data = join(base, 'ProgramData', 'MAXCOM', 'data');
  const port = await freePort();
  const rel = join(root, 'releases', version);
  mkdirSync(rel, { recursive: true });
  writeFileSync(join(rel, 'release.json'), JSON.stringify({ v: 1, version, platform: 'windows', workspaceLinks: [] }));
  writeFileSync(join(rel, '.ok'), '');
  symlinkSync(rel, join(root, 'current'), 'junction');
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(data, 'secret'), { recursive: true });
  mkdirSync(join(data, 'logs'), { recursive: true });
  const boxKey = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex');
  writeFileSync(join(data, 'secret', 'box.key'), boxKey);
  writeFileSync(join(data, 'secret', 'pfx.pass'), PFX_PASS);
  writeFileSync(join(data, 'surau.db'), 'x');
  writeFileSync(join(root, 'box-config.json'), JSON.stringify({ v: 1, dataDir: data, env: { SURAU_PORT: String(port) } }));
  writeFileSync(
    join(root, 'state', 'install.json'),
    JSON.stringify({ v: 1, installRoot: root, dataDir: data, ip: '127.0.0.1', kiosk: 'tiada', port, httpsPort: 18443, version }),
  );
  return { base, root, data, port, boxKey };
}

async function startFakeBox(e: Env, version = '2026.11.1'): Promise<ChildProcess> {
  const code = [
    "const http = require('node:http');",
    "http.createServer((q, s) => {",
    "  if (q.url === '/api/health') { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify({ ok: true, version: process.env.FAKE_VERSION })); return; }",
    "  s.statusCode = 404; s.end('x');",
    "}).listen(Number(process.env.FAKE_PORT), '127.0.0.1');",
  ].join('\n');
  const child = spawn(process.execPath, ['-e', code], {
    env: { ...process.env, FAKE_PORT: String(e.port), FAKE_VERSION: version },
    stdio: 'ignore',
  });
  children.push(child);
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${e.port}/api/health`);
      if (r.ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('fake box did not start');
}

interface Check { id: string; state: 'ok' | 'fail' | 'skip'; text: string }
interface Report { ok: boolean; checks: Check[] }

function runDoctor(args: string[], timeout = 120_000) {
  const t0 = Date.now();
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', doctorPath, ...args],
    { encoding: 'utf8', timeout },
  );
  return { status: r.status, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}`, ms: Date.now() - t0 };
}

function parse(out: string): Report {
  return JSON.parse(out.trim()) as Report;
}

function byId(rep: Report, id: string): Check {
  const c = rep.checks.find((x) => x.id === id);
  if (!c) throw new Error(`check ${id} missing`);
  return c;
}

function listAll(dir: string, out: Map<string, number> = new Map()): Map<string, number> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    out.set(p, st.mtimeMs);
    if (st.isDirectory()) listAll(p, out);
  }
  return out;
}

describe.runIf(isWin)('doctor.ps1 runs', () => {
  it('-Json -SkipSystemChecks with the box up: health_http and release ok, system checks skip, exit 0', async () => {
    const e = await makeEnv();
    await startFakeBox(e);
    const r = runDoctor(['-InstallRoot', e.root, '-Json', '-SkipSystemChecks']);
    expect(r.status, r.out + r.err).toBe(0);
    const rep = parse(r.out);
    expect(rep.ok).toBe(true);
    expect(rep.checks.map((c) => c.id)).toEqual(CHECK_IDS);
    expect(byId(rep, 'health_http').state).toBe('ok');
    expect(byId(rep, 'release').state).toBe('ok');
    expect(byId(rep, 'release').text).toContain('2026.11.1');
    for (const id of ['health_https', 'cert_days', 'fw_webrtc', 'fw_srt', 'fw_https', 'tools', 'task_box', 'task_renew', 'task_firewall', 'task_kiosk', 'box_account', 'acl_data', 'acl_root', 'disk', 'log_warnings']) {
      expect(byId(rep, id).state, id).toBe('skip');
    }
    expect(byId(rep, 'box_id').state).toBe('skip');
  }, 120_000);

  it('text mode prints OK / LANGKAU lines in BM and never the pfx.pass content', async () => {
    const e = await makeEnv();
    await startFakeBox(e);
    const r = runDoctor(['-InstallRoot', e.root, '-SkipSystemChecks']);
    expect(r.status, r.out + r.err).toBe(0);
    expect(r.out).toMatch(/^OK health_http /m);
    expect(r.out).toMatch(/^OK release /m);
    expect(r.out).toMatch(/^LANGKAU health_https: /m);
    expect(r.out).toContain('Semak MAXCOM: semua semakan yang dijalankan lulus.');
    expect(r.out + r.err).not.toContain(PFX_PASS);
    expect(r.out + r.err).not.toContain(e.boxKey.toString('hex'));
  }, 120_000);

  it('with the box stopped: health_http fails, exit 1, and -Wait 3 returns in about 3 s', async () => {
    const e = await makeEnv();
    const r = runDoctor(['-InstallRoot', e.root, '-Json', '-SkipSystemChecks', '-Wait', '3']);
    expect(r.status, r.out + r.err).toBe(1);
    const rep = parse(r.out);
    expect(rep.ok).toBe(false);
    expect(byId(rep, 'health_http').state).toBe('fail');
    expect(byId(rep, 'release').state).toBe('ok');
    expect(r.ms).toBeGreaterThan(2500);
    expect(r.ms).toBeLessThan(25_000);
    const r0 = runDoctor(['-InstallRoot', e.root, '-Json', '-SkipSystemChecks']);
    expect(r0.status).toBe(1);
    expect(r0.ms).toBeLessThan(r.ms);
  }, 120_000);

  it('-Wait picks the box up when it starts during the wait', async () => {
    const e = await makeEnv();
    const p = new Promise<ReturnType<typeof runDoctor>>((resolve) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', doctorPath, '-InstallRoot', e.root, '-Json', '-SkipSystemChecks', '-Wait', '30'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      child.stdout.on('data', (d) => (out += String(d)));
      child.on('close', (code) => resolve({ status: code, out, err: '', ms: 0 }));
    });
    await new Promise((r) => setTimeout(r, 2500));
    await startFakeBox(e);
    const r = await p;
    expect(r.status, r.out).toBe(0);
    expect(byId(parse(r.out), 'health_http').state).toBe('ok');
  }, 120_000);

  it('-ExpectBoxId: the right id passes, a wrong id fails box_id, a malformed id is refused', async () => {
    const e = await makeEnv();
    await startFakeBox(e);
    const id = createHash('sha256').update(e.boxKey).digest('hex').slice(0, 16);
    const good = runDoctor(['-InstallRoot', e.root, '-Json', '-SkipSystemChecks', '-ExpectBoxId', id]);
    expect(good.status, good.out + good.err).toBe(0);
    expect(byId(parse(good.out), 'box_id').state).toBe('ok');
    const bad = runDoctor(['-InstallRoot', e.root, '-Json', '-SkipSystemChecks', '-ExpectBoxId', '0123456789abcdef']);
    expect(bad.status).toBe(1);
    const c = byId(parse(bad.out), 'box_id');
    expect(c.state).toBe('fail');
    expect(c.text).toContain(id);
    expect(bad.out).not.toContain(e.boxKey.toString('hex'));
    const junk = runDoctor(['-InstallRoot', e.root, '-Json', '-ExpectBoxId', 'not-hex']);
    expect(junk.status).not.toBe(0);
  }, 180_000);

  it('without -SkipSystemChecks a bare layout fails the install checks and the elevated checks skip or fail, never ok', async () => {
    const e = await makeEnv();
    await startFakeBox(e);
    const r = runDoctor(['-InstallRoot', e.root, '-Json']);
    expect(r.status, r.out + r.err).toBe(1);
    const rep = parse(r.out);
    expect(byId(rep, 'health_http').state).toBe('ok');
    expect(byId(rep, 'health_https').state).toBe('fail');
    expect(byId(rep, 'cert_days').state).toBe('fail');
    expect(byId(rep, 'tools').state).toBe('fail');
    for (const id of ['task_box', 'task_renew', 'task_firewall', 'acl_data', 'acl_root', 'box_account']) {
      const c = byId(rep, id);
      expect(c.state, id).not.toBe('ok');
      if (c.state === 'skip') expect(c.text).toBe('perlukan Run as administrator');
    }
    expect(byId(rep, 'task_kiosk').state).not.toBe('ok');
  }, 120_000);

  it('cert_days reads pki\\box-leaf.cer: ok with a warning under 60 days, fail when expired', () => {
    const e = { base: tmp() };
    const mk = (name: string, notBefore: string, notAfter: string) =>
      `$c = New-SelfSignedCertificate -Subject 'CN=maxcom-doctor-test-${name}' -CertStoreLocation Cert:\\CurrentUser\\My -NotBefore ${notBefore} -NotAfter ${notAfter}; ` +
      `try { Export-Certificate -Cert $c -FilePath '${join(e.base, name + '.cer').replaceAll("'", "''")}' -Type CERT | Out-Null } finally { Remove-Item -LiteralPath ('Cert:\\CurrentUser\\My\\' + $c.Thumbprint) -Force }`;
    const script = [
      mk('soon', '(Get-Date).AddDays(-10)', '(Get-Date).AddDays(20)'),
      mk('past', '(Get-Date).AddDays(-30)', '(Get-Date).AddDays(-5)'),
      mk('far', '(Get-Date).AddDays(-1)', '(Get-Date).AddDays(400)'),
    ].join('; ');
    const mkc = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 120_000 });
    expect(mkc.status, `${mkc.stdout}${mkc.stderr}`).toBe(0);
    const results: Record<string, Check> = {};
    for (const name of ['soon', 'past', 'far']) {
      const root = join(e.base, name, 'MAXCOM');
      const data = join(e.base, name, 'data');
      mkdirSync(join(root, 'state'), { recursive: true });
      mkdirSync(join(data, 'pki'), { recursive: true });
      writeFileSync(join(root, 'box-config.json'), JSON.stringify({ v: 1, dataDir: data, env: { SURAU_PORT: '1' } }));
      writeFileSync(join(data, 'pki', 'box-leaf.cer'), readFileSync(join(e.base, name + '.cer')));
      const r = runDoctor(['-InstallRoot', root, '-Json']);
      results[name] = byId(parse(r.out), 'cert_days');
    }
    expect(results.soon.state).toBe('ok');
    expect(results.soon.text).toMatch(/AMARAN.*(19|20) hari/);
    expect(results.past.state).toBe('fail');
    expect(results.far.state).toBe('ok');
    expect(results.far.text).not.toContain('AMARAN');
    expect(results.far.text).toMatch(/\b(39[89]|400) hari/);
  }, 240_000);

  it('changes nothing: the install and data trees are identical before and after', async () => {
    const e = await makeEnv();
    await startFakeBox(e);
    const before = listAll(e.base);
    const stateBefore = readFileSync(join(e.root, 'state', 'install.json'), 'utf8');
    const r = runDoctor(['-InstallRoot', e.root, '-Json']);
    expect(r.status === 0 || r.status === 1).toBe(true);
    const after = listAll(e.base);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [p, m] of before) expect(after.get(p), p).toBe(m);
    expect(readFileSync(join(e.root, 'state', 'install.json'), 'utf8')).toBe(stateBefore);
    expect(existsSync(join(e.data, 'surau.db'))).toBe(true);
  }, 120_000);

  it('a missing install root fails cleanly with exit 1 and valid JSON', () => {
    const base = tmp();
    const r = runDoctor(['-InstallRoot', join(base, 'tiada', 'MAXCOM'), '-Json', '-SkipSystemChecks']);
    expect(r.status, r.out + r.err).toBe(1);
    const rep = parse(r.out);
    expect(byId(rep, 'release').state).toBe('fail');
  }, 120_000);
});

describe('doctor.ps1 acl_data covers the parent folder (static)', () => {
  it('checks %ProgramData%\\MAXCOM, data\\ and backups\\ for links and the parent for untrusted writers', () => {
    const i = src.indexOf("Test-Run 'acl_data'");
    expect(i).toBeGreaterThan(0);
    const body = src.slice(i, src.indexOf("Test-Run 'acl_root'"));
    expect(body).toContain('$P.MaxcomHome');
    expect(body).toContain('$P.Backups');
    expect(body).toContain('Test-IsReparsePoint');
    expect(body).toContain('Get-UntrustedWriters $P.MaxcomHome');
  });
});

describe.runIf(process.platform === 'win32')('doctor.ps1 tools check on an installed copy', () => {
  it('compares tools\\live\\VERSIONS.md with bin\\release-pins.json when setup put it there', async () => {
    const e = await makeEnv();
    const shaM = 'a'.repeat(64);
    const shaF = 'b'.repeat(64);
    const live = join(e.root, 'tools', 'live');
    mkdirSync(join(live, 'mediamtx'), { recursive: true });
    mkdirSync(join(live, 'ffmpeg'), { recursive: true });
    writeFileSync(join(live, 'mediamtx', 'mediamtx.exe'), 'x');
    writeFileSync(join(live, 'ffmpeg', 'ffmpeg.exe'), 'x');
    writeFileSync(join(live, 'VERSIONS.md'), `mediamtx ${shaM}\nffmpeg ${shaF}\n`);
    mkdirSync(join(e.root, 'runtime', 'node'), { recursive: true });
    writeFileSync(join(e.root, 'runtime', 'node', 'node.exe'), 'x');
    const bin = join(e.root, 'bin');
    mkdirSync(bin, { recursive: true });
    for (const n of ['doctor.ps1', 'MaxcomSetup.psm1']) copyFileSync(join(dirname(doctorPath), n), join(bin, n));
    const runBin = () => {
      const r = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(bin, 'doctor.ps1'), '-InstallRoot', e.root, '-Json'],
        { encoding: 'utf8', timeout: 120_000 },
      );
      return parse(String(r.stdout ?? ''));
    };
    // setup before this fix did not copy the pins: versions are not compared
    expect(byId(runBin(), 'tools').text).toContain('release-pins.json tiada');
    const pins = { mediamtx: { sha256: shaM }, ffmpeg: { sha256: shaF } };
    writeFileSync(join(bin, 'release-pins.json'), JSON.stringify(pins));
    const ok = byId(runBin(), 'tools');
    expect(ok.state, ok.text).toBe('ok');
    expect(ok.text).toContain('versi sama dengan pin');
    writeFileSync(join(live, 'VERSIONS.md'), `mediamtx ${shaM}\nffmpeg ${'c'.repeat(64)}\n`);
    const bad = byId(runBin(), 'tools');
    expect(bad.state).toBe('fail');
    expect(bad.text).toContain('ffmpeg tidak sama dengan versi pin');
  }, 180_000);
});
