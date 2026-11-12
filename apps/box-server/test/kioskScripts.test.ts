import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const setupDir = fileURLToPath(new URL('../../../scripts/setup/', import.meta.url));
const startKiosk = join(setupDir, 'start-kiosk.ps1');
const installTask = join(setupDir, 'install-kiosk-task.ps1');
const setPower = join(setupDir, 'set-box-power.ps1');
const srcs = {
  start: readFileSync(startKiosk, 'utf8'),
  task: readFileSync(installTask, 'utf8'),
  power: readFileSync(setPower, 'utf8'),
};

const win = process.platform === 'win32';
const dirs: string[] = [];
const servers: Server[] = [];
const pids: number[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "surau kiosk & 'uji' "));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

function ps(script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 90_000 },
  );
}

function psAsync(script: string, args: string[], env: Record<string, string>): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      env: { ...process.env, ...env },
    });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ out, code }));
  });
}

function fakeBox(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      if (req.url === '/api/health') {
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true,"version":"test"}');
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port));
  });
}

/** A copy of cmd.exe named msedge.exe in a folder with a space, an ampersand and an apostrophe. */
function fakeEdge(): string {
  const dir = tmp();
  const exe = join(dir, 'msedge.exe');
  copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), exe);
  return exe;
}

describe('kiosk scripts static checks', () => {
  it('are pure ASCII with CRLF line endings', () => {
    for (const s of Object.values(srcs)) {
      for (let i = 0; i < s.length; i++) expect(s.charCodeAt(i)).toBeLessThan(128);
      expect(s).not.toMatch(/[^\r]\n/);
    }
  });

  it('start-kiosk: loopback HTTP only, integer port, Edge args as an array, no secrets or other hosts', () => {
    const s = srcs.start;
    expect(s).toContain('[ValidateRange(1, 65535)][int]$Port');
    expect(s).toContain('http://127.0.0.1:$Port/');
    expect(s).not.toMatch(/https:\/\//);
    expect(s).not.toMatch(/\[string\]\$(Url|Uri|Host)/i);
    expect(s).toContain('$edgeArgs = @(');
    for (const a of [
      "'--kiosk'",
      '--edge-kiosk-type=fullscreen',
      '--no-first-run',
      '--no-default-browser-check',
      '--kiosk-idle-timeout-minutes=0',
      '--autoplay-policy=no-user-gesture-required',
      '--user-data-dir=$profileDir',
    ]) {
      expect(s).toContain(a);
    }
    expect(s).toContain('App Paths\\msedge.exe');
    expect(s).toContain('kiosk-stop');
    expect(s).toContain('kiosk-profile');
    expect(s).toContain('180');
    expect(s).not.toMatch(/Invoke-Expression|iex\s|cmd\s+\/c/i);
  });

  it('install-kiosk-task: logon trigger, interactive Limited principal, refuses untrusted writers, never SYSTEM', () => {
    const s = srcs.task;
    expect(s).toContain("'MAXCOM Kiosk'");
    expect(s).toContain('-AtLogOn -User $User');
    expect(s).toContain('-LogonType Interactive');
    expect(s).toContain('-RunLevel Limited');
    expect(s).not.toContain('-RunLevel Highest');
    expect(s).toContain('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"');
    expect(s).toContain('Get-UntrustedWriters');
    expect(s).toContain('S-1-5-32-544');
    expect(s).toContain('ReparsePoint');
    expect(s).toContain('-Uninstall');
  });

  it('set-box-power: mains values only, no battery (DC) change, state recorded once', () => {
    const s = srcs.power;
    expect(s).not.toMatch(/-dc\b|setdcvalueindex|DC Power/i);
    expect(s).toContain('/setacvalueindex');
    expect(s).toContain('standby-timeout-ac');
    expect(s).toContain('hibernate-timeout-ac');
    expect(s).toContain('monitor-timeout-ac');
    expect(s).toContain('LIDACTION');
    expect(s).toContain('Test-Path -LiteralPath $state');
  });
});

describe.runIf(win)('start-kiosk.ps1 runs', () => {
  it('-PrintOnly prints the exact program and arguments and starts nothing', () => {
    const edge = fakeEdge();
    const local = tmp();
    const r = ps(startKiosk, ['-PrintOnly', '-Port', '9123', '-EdgePath', edge], { LOCALAPPDATA: local });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const lines = r.stdout.split(/\r?\n/).filter(Boolean);
    expect(lines[0]).toBe(`PROGRAM ${edge}`);
    const args = lines.filter((l) => l.startsWith('ARG ')).map((l) => l.slice(4));
    expect(args).toEqual([
      '--kiosk',
      'http://127.0.0.1:9123/',
      '--edge-kiosk-type=fullscreen',
      '--no-first-run',
      '--no-default-browser-check',
      '--kiosk-idle-timeout-minutes=0',
      '--autoplay-policy=no-user-gesture-required',
      `--user-data-dir=${join(local, 'MAXCOM', 'kiosk-profile')}`,
    ]);
    // Nothing was created or started.
    expect(existsSync(join(local, 'MAXCOM'))).toBe(false);
  });

  it('refuses a bad port, a non-numeric port and an EdgePath not named msedge.exe', () => {
    const local = tmp();
    const notEdge = join(local, 'notepad.exe');
    writeFileSync(notEdge, 'x');
    for (const bad of ['0', '65536', 'abc', '-1']) {
      const r = ps(startKiosk, ['-PrintOnly', '-Port', bad], { LOCALAPPDATA: local });
      expect(r.status, `port ${bad}`).not.toBe(0);
    }
    const r = ps(startKiosk, ['-PrintOnly', '-EdgePath', notEdge], { LOCALAPPDATA: local });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('msedge.exe');
    const r2 = ps(startKiosk, ['-PrintOnly', '-EdgePath', join(local, 'msedge.exe')], { LOCALAPPDATA: local });
    expect(r2.status).not.toBe(0);
  });

  it('-Once waits for health, starts the (fake) Edge and returns', async () => {
    const port = await fakeBox();
    const edge = fakeEdge();
    const local = tmp();
    mkdirSync(join(local, 'MAXCOM'), { recursive: true });
    const r = await psAsync(startKiosk, ['-Once', '-Port', String(port), '-EdgePath', edge], { LOCALAPPDATA: local });
    const m = /\(PID (\d+)\)/.exec(r.out);
    if (m) pids.push(Number(m[1]));
    expect(r.code, r.out).toBe(0);
    expect(m, r.out).not.toBeNull();
    expect(r.out).toContain(edge);
  });

  it('-Once never deletes the kiosk-stop file: a stop request is honoured and Edge is not started', async () => {
    const port = await fakeBox();
    const edge = fakeEdge();
    const local = tmp();
    mkdirSync(join(local, 'MAXCOM'), { recursive: true });
    const stopFile = join(local, 'MAXCOM', 'kiosk-stop');
    writeFileSync(stopFile, '');
    const r = await psAsync(startKiosk, ['-Once', '-Port', String(port), '-EdgePath', edge], { LOCALAPPDATA: local });
    const m = /\(PID (\d+)\)/.exec(r.out);
    if (m) pids.push(Number(m[1]));
    expect(r.code, r.out).toBe(0);
    expect(m, r.out).toBeNull();
    expect(existsSync(stopFile)).toBe(true);
  });

  it('without -Once an old stop file is removed when the script starts for real', () => {
    const text = readFileSync(startKiosk, 'utf8');
    expect(text).toMatch(/if \(-not \$Once -and \(Test-Path -LiteralPath \$stopFile\)\) \{ Remove-Item -LiteralPath \$stopFile -Force \}/);
  });
});

describe.runIf(win)('start-kiosk.ps1 exit helper (loopback listener)', () => {
  /** Dot-sources start-kiosk.ps1 (functions only), serves exit requests until one is valid, injecting the stop action. */
  function driver(): string {
    const f = join(tmp(), 'drive.ps1');
    writeFileSync(
      f,
      [
        `. '${startKiosk.replace(/'/g, "''")}'`,
        '$t = New-ExitToken',
        '$l = Start-ExitListener',
        '$port = ([System.Net.IPEndPoint]$l.LocalEndpoint).Port',
        '[Console]::Out.WriteLine("READY $port $t"); [Console]::Out.Flush()',
        '$sw = [System.Diagnostics.Stopwatch]::StartNew()',
        '$done = $false',
        'while (-not $done -and $sw.Elapsed.TotalSeconds -lt 40) {',
        '  if (Invoke-ExitListener $l $t { [Console]::Out.WriteLine("STOPPED"); [Console]::Out.Flush() }) { $done = $true } else { Start-Sleep -Milliseconds 50 }',
        '}',
        '$l.Stop()',
        'if ($done) { exit 0 } else { exit 3 }',
      ].join('\r\n'),
    );
    return f;
  }

  it('answers 204 and runs the stop action only for POST /exit with the exact token; everything else is refused', async () => {
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver()]);
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    const closed = new Promise<number | null>((r) => c.on('close', (code) => r(code)));
    try {
      let m: RegExpExecArray | null = null;
      for (let i = 0; i < 400 && !m; i++) {
        m = /READY (\d+) ([0-9a-f]{64})/.exec(out);
        if (!m) await new Promise((r) => setTimeout(r, 50));
      }
      expect(m, out).not.toBeNull();
      const port = Number(m![1]);
      const token = m![2]!;
      expect(port).toBeGreaterThanOrEqual(1024);
      const url = `http://127.0.0.1:${port}/exit`;
      const post = (body: string, path = '/exit', method = 'POST') =>
        fetch(`http://127.0.0.1:${port}${path}`, { method, body: method === 'POST' ? body : undefined });
      // Refused: wrong token, empty body, a longer or shorter token, wrong path, wrong method, oversize body.
      expect((await post('x'.repeat(64))).status).toBe(400);
      expect((await post('')).status).toBe(400);
      expect((await post(token + '0')).status).toBe(400);
      expect((await post(token.slice(1))).status).toBe(400);
      expect((await post(token, '/other')).status).toBe(404);
      expect((await post(token, '/exit', 'GET')).status).toBe(404);
      // Oversize: refused with 400, or the connection is dropped (the listener never reads more than 4 KB).
      const big = await post(token.padEnd(8000, 'a')).then((r) => r.status, () => 'reset');
      expect([400, 'reset']).toContain(big);
      expect(out).not.toContain('STOPPED');
      // Accepted.
      const ok = await fetch(url, { method: 'POST', body: token });
      expect(ok.status).toBe(204);
      expect(await closed).toBe(0);
      expect(out).toContain('STOPPED');
    } finally {
      try {
        c.kill();
      } catch {
        /* gone */
      }
    }
  }, 60_000);

  it('a client that sends nothing is dropped after about 2 seconds and does not block a valid request', async () => {
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver()]);
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    const closed = new Promise<number | null>((r) => c.on('close', (code) => r(code)));
    try {
      let m: RegExpExecArray | null = null;
      for (let i = 0; i < 400 && !m; i++) {
        m = /READY (\d+) ([0-9a-f]{64})/.exec(out);
        if (!m) await new Promise((r) => setTimeout(r, 50));
      }
      expect(m, out).not.toBeNull();
      const { createConnection } = await import('node:net');
      const idle = createConnection({ host: '127.0.0.1', port: Number(m![1]) });
      idle.on('error', () => undefined);
      const t0 = Date.now();
      const ok = await fetch(`http://127.0.0.1:${m![1]}/exit`, { method: 'POST', body: m![2] });
      expect(ok.status).toBe(204);
      expect(Date.now() - t0).toBeLessThan(8000);
      idle.destroy();
      expect(await closed).toBe(0);
    } finally {
      try {
        c.kill();
      } catch {
        /* gone */
      }
    }
  }, 60_000);

  it('static: TcpListener on loopback, constant-time compare, 4 KB and 2 s caps, tree kill by PID, no stop file, shortcut in every mode', () => {
    const s = srcs.start;
    expect(s).toContain('System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)');
    expect(s).not.toMatch(/HttpListener/);
    expect(s).toContain('$max = 4096');
    expect(s).toContain('2000 - [int]$sw.ElapsedMilliseconds');
    expect(s).toContain('/PID $ProcessId /T /F');
    expect(s).not.toMatch(/taskkill[^\r\n]*\/IM/i);
    expect(s).toContain('#mxhost=$hport.$token');
    expect(s).not.toMatch(/New-Item[^\r\n]*kiosk-stop/);
    const setup = readFileSync(join(setupDir, 'setup.ps1'), 'utf8');
    const line = setup.split(/\r?\n/).find((l) => l.includes("'Skrin MAXCOM.lnk'"));
    expect(line).toBeDefined();
    // Created unconditionally (khas and kongsi): the line is not inside the khas-only branch.
    expect(setup).toMatch(/-File ' \+ \(ConvertTo-QuotedArg \$kioskPs1\) \+ ' -NoRestart'/);
    expect(setup.slice(setup.indexOf('$kioskPs1 = Join-Path'), setup.indexOf("'Skrin MAXCOM.lnk'"))).not.toContain("-eq 'khas'");
  });
});

describe.runIf(win)('install-kiosk-task.ps1 -DryRun', () => {
  function fakeRoot(): string {
    const root = join(tmp(), 'MAXCOM uji & satu');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, 'bin', 'start-kiosk.ps1'), '# x');
    return root;
  }
  const me = `${process.env.USERDOMAIN ?? process.env.COMPUTERNAME}\\${process.env.USERNAME}`;

  it('prints the task with the quoted script path and changes nothing', () => {
    const root = fakeRoot();
    const r = ps(installTask, ['-InstallRoot', root, '-User', me, '-DryRun']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('DRYRUN task    : MAXCOM Kiosk');
    expect(r.stdout).toContain(me);
    expect(r.stdout).toContain('Interactive');
    expect(r.stdout).toContain('Limited');
    expect(r.stdout).toContain(`-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${join(root, 'bin', 'start-kiosk.ps1')}"`);
    // The current user owns the temp files, so a real run would refuse; the dry run says so.
    expect(r.stdout).toContain('DRYRUN would refuse');
  });

  it('refuses SYSTEM, LOCAL SERVICE and a missing user; -Uninstall -DryRun is a no-op', () => {
    const root = fakeRoot();
    for (const bad of ['SYSTEM', 'NT AUTHORITY\\LOCAL SERVICE', 'NT AUTHORITY\\SYSTEM']) {
      const r = ps(installTask, ['-InstallRoot', root, '-User', bad, '-DryRun']);
      expect(r.status, bad).not.toBe(0);
    }
    expect(ps(installTask, ['-InstallRoot', root, '-DryRun']).status).not.toBe(0);
    expect(ps(installTask, ['-User', me, '-DryRun']).status).not.toBe(0);
    const u = ps(installTask, ['-Uninstall', '-DryRun']);
    expect(u.status, u.stdout + u.stderr).toBe(0);
    expect(u.stdout).toMatch(/DRYRUN (would stop and remove task MAXCOM Kiosk|task MAXCOM Kiosk is not installed)/);
  });

  it('a real (non-dry) run without elevation is refused', () => {
    const isAdmin = spawnSync('net.exe', ['session'], { encoding: 'utf8' }).status === 0;
    if (isAdmin) return;
    const r = ps(installTask, ['-InstallRoot', fakeRoot(), '-User', me]);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('Pentadbir');
  });
});

describe.runIf(win)('set-box-power.ps1', () => {
  it('-Apply -DryRun prints the four changes and writes no state file', () => {
    const state = join(tmp(), 'state', 'power-before.json');
    const r = ps(setPower, ['-Apply', '-DryRun', '-StateFile', state]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const lines = r.stdout.split(/\r?\n/).filter((l) => l.startsWith('DRYRUN powercfg'));
    expect(lines).toHaveLength(4);
    expect(r.stdout).toContain('/change standby-timeout-ac 0');
    expect(r.stdout).toContain('/change hibernate-timeout-ac 0');
    expect(r.stdout).toContain('/change monitor-timeout-ac 0');
    expect(r.stdout).toContain('SUB_BUTTONS LIDACTION 0');
    expect(existsSync(state)).toBe(false);
  });

  it('-Restore with a missing state file is a clean no-op', () => {
    const state = join(tmp(), 'power-before.json');
    const r = ps(setPower, ['-Restore', '-StateFile', state]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(state)).toBe(false);
  });

  it('-Restore -DryRun prints the recorded values and keeps the state file; a damaged file is refused', () => {
    const dir = tmp();
    const state = join(dir, 'power-before.json');
    writeFileSync(
      state,
      JSON.stringify({ v: 1, scheme: '381b4222-f694-41f0-9685-ff5bb260df2e', saved: 'x', ac: { standby: 1800, hibernate: 0, monitor: 600, lid: 1 } }),
    );
    const r = ps(setPower, ['-Restore', '-DryRun', '-StateFile', state]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('SUB_SLEEP STANDBYIDLE 1800');
    expect(r.stdout).toContain('SUB_VIDEO VIDEOIDLE 600');
    expect(r.stdout).toContain('SUB_BUTTONS LIDACTION 1');
    expect(existsSync(state)).toBe(true);

    writeFileSync(state, JSON.stringify({ v: 1, scheme: 'not-a-guid; calc', ac: {} }));
    const bad = ps(setPower, ['-Restore', '-DryRun', '-StateFile', state]);
    expect(bad.status).not.toBe(0);
  });

  it('needs exactly one of -Apply / -Restore and a state file', () => {
    expect(ps(setPower, ['-StateFile', join(tmp(), 'x.json')]).status).not.toBe(0);
    expect(ps(setPower, ['-Apply', '-Restore', '-StateFile', join(tmp(), 'x.json'), '-DryRun']).status).not.toBe(0);
    expect(ps(setPower, ['-Apply', '-DryRun']).status).not.toBe(0);
  });
});
