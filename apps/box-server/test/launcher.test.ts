import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const updateDir = fileURLToPath(new URL('../src/update', import.meta.url));
const launcher = join(updateDir, 'launcher.mjs');
const startCmd = join(updateDir, 'start.cmd');
const cli = join(updateDir, 'cli.mjs');
const maxcomCmd = join(updateDir, 'maxcom.cmd');

// The launcher reports errors to %ProgramData%\\MAXCOM\\launcher-error.log. Every test in this file must use a temp
// ProgramData, never the real one (a user-owned C:\\ProgramData\\MAXCOM would let a standard user plant a junction).
const realProgramData = process.env.ProgramData ?? process.env.PROGRAMDATA;
const realMaxcomHome = realProgramData ? join(realProgramData, 'MAXCOM') : undefined;
const realLog = realMaxcomHome ? join(realMaxcomHome, 'launcher-error.log') : undefined;
const realBefore = {
  home: realMaxcomHome ? existsSync(realMaxcomHome) : false,
  log: realLog && existsSync(realLog) ? statSync(realLog).mtimeMs + ':' + statSync(realLog).size : null,
};
let sandboxProgramData = '';
beforeAll(() => {
  sandboxProgramData = mkdtempSync(join(tmpdir(), 'surau-programdata-'));
  process.env.ProgramData = sandboxProgramData;
  if ('PROGRAMDATA' in process.env) process.env.PROGRAMDATA = sandboxProgramData;
});
afterAll(() => {
  if (realProgramData !== undefined) process.env.ProgramData = realProgramData;
  rmSync(sandboxProgramData, { recursive: true, force: true });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-launcher-'));
  dirs.push(d);
  return d;
}

function readLauncher(): string {
  return readFileSync(launcher, 'utf8');
}

function isAscii(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[^\x00-\x7F]/.test(text);
}

describe('update files (static)', () => {
  it('launcher.mjs is ASCII only and uses node: imports only', () => {
    const text = readLauncher();
    expect(isAscii(text)).toBe(true);
    const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"];?/g)].map((m) => m[1]);
    for (const mod of imports) {
      expect(mod.startsWith('node:') || mod === 'node:console').toBe(true);
    }
    expect(text).not.toMatch(/require\s*\(/);
  });

  it('start.cmd is ASCII only and runs the launcher', () => {
    const text = readFileSync(startCmd, 'utf8');
    expect(isAscii(text)).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(text).toContain('%~dp0runtime\\node\\node.exe');
    expect(text).toContain('%~dp0launcher.mjs');
  });

  it('maxcom.cmd is ASCII only and runs the cli', () => {
    const text = readFileSync(maxcomCmd, 'utf8');
    expect(isAscii(text)).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(text).toContain('%~dp0..\\runtime\\node\\node.exe');
    expect(text).toContain('%~dp0cli.mjs');
  });
});

describe('launcher.mjs unit exports', () => {
  const load = async () => import(/* @vite-ignore */ launcher + '?t=' + Date.now());

  it('readConfig accepts a valid config', async () => {
    const { readConfig } = await load();
    const root = tempDir();
    const dataDir = join(root, 'data');
    mkdirSync(dataDir);
    writeFileSync(
      join(root, 'box-config.json'),
      JSON.stringify({ v: 1, dataDir, env: { SURAU_PORT: '8787' } }),
    );
    expect(readConfig(root)).toEqual({ v: 1, dataDir, env: { SURAU_PORT: '8787' } });
  });

  it('readConfig rejects v other than 1', async () => {
    const { readConfig } = await load();
    const root = tempDir();
    writeFileSync(join(root, 'box-config.json'), JSON.stringify({ v: 2, dataDir: root, env: {} }));
    expect(() => readConfig(root)).toThrow();
  });

  it('readConfig rejects relative dataDir', async () => {
    const { readConfig } = await load();
    const root = tempDir();
    writeFileSync(
      join(root, 'box-config.json'),
      JSON.stringify({ v: 1, dataDir: 'data', env: {} }),
    );
    expect(() => readConfig(root)).toThrow();
  });

  it('readConfig rejects unknown env keys', async () => {
    const { readConfig } = await load();
    const root = tempDir();
    writeFileSync(
      join(root, 'box-config.json'),
      JSON.stringify({ v: 1, dataDir: root, env: { SURAU_FOO: 'x' } }),
    );
    expect(() => readConfig(root)).toThrow();
  });

  it('readConfig rejects SURAU_ROLE', async () => {
    const { readConfig } = await load();
    const root = tempDir();
    writeFileSync(
      join(root, 'box-config.json'),
      JSON.stringify({ v: 1, dataDir: root, env: { SURAU_ROLE: 'box' } }),
    );
    expect(() => readConfig(root)).toThrow();
  });

  it('childEnv gives the four computed keys and copies allowlisted keys', async () => {
    const { childEnv } = await load();
    const root = 'C:\\Program Files\\MAXCOM';
    const dataDir = 'C:\\ProgramData\\MAXCOM\\data';
    const env = childEnv(
      root,
      {
        v: 1,
        dataDir,
        env: {
          SURAU_PORT: '8787',
          SURAU_HTTPS_PORT: '8443',
          SURAU_ALLOWED_HOSTS: 'maxcom.local',
          SURAU_ASSETS_MAX_MB: '10',
          SURAU_FINANCE_PHOTOS_MAX_MB: '5',
          SURAU_CLOUD_URL: 'https://cloud.example',
          SURAU_WORKER_URL: 'https://worker.example',
        },
      },
      { SURAU_PORT: '9999', NODE_OPTIONS: '--inspect', SURAU_ROLE: 'box', PATH: 'C:\\bad' },
    );
    expect(env.SURAU_INSTALL_ROOT).toBe(root);
    expect(env.SURAU_DB).toBe(join(dataDir, 'surau.db'));
    expect(env.SURAU_DATA_DIR).toBe(dataDir);
    expect(env.SURAU_LIVE_TOOLS).toBe(join(root, 'tools', 'live'));
    expect(env.SURAU_PORT).toBe('8787');
    expect(env.SURAU_HTTPS_PORT).toBe('8443');
    expect(env.SURAU_ALLOWED_HOSTS).toBe('maxcom.local');
    expect(env.SURAU_ASSETS_MAX_MB).toBe('10');
    expect(env.SURAU_FINANCE_PHOTOS_MAX_MB).toBe('5');
    expect(env.SURAU_CLOUD_URL).toBe('https://cloud.example');
    expect(env.SURAU_WORKER_URL).toBe('https://worker.example');
    expect(env.SURAU_ROLE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    expect(env.PATH).toBe(
      `${systemRoot}\\System32;${systemRoot};${systemRoot}\\System32\\WindowsPowerShell\\v1.0`,
    );
  });

  it('childEnv copies the base Windows keys (any case) and nothing else from the base env', async () => {
    const { childEnv } = await load();
    const env = childEnv(
      'C:\\MAXCOM',
      { v: 1, dataDir: 'C:\\MAXCOM\\data', env: {} },
      {
        SystemRoot: 'C:\\Windows',
        windir: 'C:\\Windows',
        TEMP: 'C:\\Windows\\TEMP',
        ProgramData: 'C:\\ProgramData',
        comspec: 'C:\\Windows\\System32\\cmd.exe',
        PATHEXT: '.EXE',
        NODE_OPTIONS: '--inspect',
        NODE_ENV: 'development',
        SURAU_ROLE: 'box',
        SURAU_PORT: '9999',
        SECRET_TOKEN: 'x',
      },
    );
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.windir).toBe('C:\\Windows');
    expect(env.TEMP).toBe('C:\\Windows\\TEMP');
    expect(env.ProgramData).toBe('C:\\ProgramData');
    expect(env.comspec).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(env.PATHEXT).toBe('.EXE');
    for (const k of ['NODE_OPTIONS', 'NODE_ENV', 'SURAU_ROLE', 'SURAU_PORT', 'SECRET_TOKEN']) {
      expect(env[k]).toBeUndefined();
    }
  });

  it('nextDelayMs returns 0 for 75 and 5000 otherwise', async () => {
    const { nextDelayMs } = await load();
    expect(nextDelayMs(75)).toBe(0);
    expect(nextDelayMs(0)).toBe(5000);
    expect(nextDelayMs(1)).toBe(5000);
    expect(nextDelayMs(74)).toBe(5000);
    expect(nextDelayMs(76)).toBe(5000);
  });

  it('rotateLog keeps up to N backups and removes the oldest', async () => {
    const { rotateLog } = await load();
    const root = tempDir();
    const log = join(root, 'box.log');
    writeFileSync(log, 'aa');
    writeFileSync(`${log}.1`, 'b');
    writeFileSync(`${log}.2`, 'c');
    rotateLog(log, 1, 2);
    expect(readFileSync(`${log}.1`, 'utf8')).toBe('aa');
    expect(readFileSync(`${log}.2`, 'utf8')).toBe('b');
    expect(existsSync(`${log}.3`)).toBe(false);
  });
});

describe.runIf(process.platform === 'win32')('launcher.mjs run loop', () => {
  function makeRoot(withSpace = false): string {
    const base = tempDir();
    const root = withSpace ? join(base, 'MAXCOM uji & \'satu\'') : join(base, 'MAXCOM');
    const current = join(root, 'current', 'apps', 'box-server', 'src');
    mkdirSync(current, { recursive: true });
    const dataDir = join(root, 'data');
    mkdirSync(join(dataDir, 'logs'), { recursive: true });
    writeFileSync(
      join(root, 'box-config.json'),
      JSON.stringify({ v: 1, dataDir, env: {} }),
    );
    writeFileSync(join(root, 'launcher.mjs'), readFileSync(launcher));
    writeFileSync(
      join(current, 'main.ts'),
      `import { readFileSync, writeFileSync } from 'node:fs';\n` +
        `import { resolve } from 'node:path';\n` +
        `const dataDir = process.env.SURAU_DATA_DIR;\n` +
        `if (!dataDir) { console.error('no data dir'); process.exit(99); }\n` +
        `const f = resolve(dataDir, 'counter.txt');\n` +
        `let n = 0;\n` +
        `try { n = parseInt(readFileSync(f, 'utf8'), 10) || 0; } catch {}\n` +
        `console.log('start ' + n);\n` +
        `console.error('err ' + n);\n` +
        `writeFileSync(f, String(n + 1));\n` +
    `if (n === 0) process.exit(75);\n` +
    `if (n === 1) process.exit(1);\n` +
    `writeFileSync(resolve(dataDir, 'child.pid'), String(process.pid));\n` +
    `setInterval(() => {}, 60_000);\n`,
    );
    return root;
  }

  function runLauncher(root: string): ChildProcess {
    return spawn(process.execPath, [join(root, 'launcher.mjs')], {
      cwd: root,
      env: { ...process.env, SURAU_INSTALL_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  function waitForLog(root: string, substring: string, timeout = 15_000): Promise<void> {
    const log = join(root, 'data', 'logs', 'box.log');
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        try {
          if (readFileSync(log, 'utf8').includes(substring)) return resolve();
        } catch {}
        if (Date.now() - start > timeout) return reject(new Error(`timeout waiting for "${substring}"`));
        setTimeout(check, 100);
      };
      check();
    });
  }

  it('restarts on exit 75 immediately, on other codes after 5s, and a second launcher exits at once', async () => {
    const root = makeRoot(true);
    const proc = runLauncher(root);
    const out: string[] = [];
    proc.stdout?.on('data', (c) => out.push(c.toString()));
    proc.stderr?.on('data', (c) => out.push(c.toString()));

    await waitForLog(root, 'start 0');
    await waitForLog(root, 'start 1');
    await waitForLog(root, 'start 2');

    const log = readFileSync(join(root, 'data', 'logs', 'box.log'), 'utf8');
    expect(log).toContain('start 0');
    expect(log).toContain('err 0');
    expect(log).toContain('start 1');
    expect(log).toContain('err 1');
    expect(log).toContain('start 2');
    expect(log).toContain('err 2');

    // Gap between start 0 and start 1 should be roughly 0 (exit 75)
    // Gap between start 1 and start 2 should be at least 5s (exit 1)
    const times = log.split('\n')
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes('start 0') || l.includes('start 1') || l.includes('start 2'))
      .map(({ l }) => new Date(l.slice(0, 24)).getTime());
    expect(times.length).toBe(3);
    expect(times[1] - times[0]).toBeLessThan(2000);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(4500);

    // A second launcher on the same root exits immediately
    const second = spawnSync(process.execPath, [join(root, 'launcher.mjs')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(second.status).toBe(0);
    expect(second.stdout + second.stderr).toMatch(/already running|sudah berjalan/i);

    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => proc.on('exit', () => resolve()));
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  });

  it('killing the launcher ends the child', async () => {
    const root = makeRoot();
    const proc = runLauncher(root);
    await waitForLog(root, 'start 2', 15_000);

    const childPid = Number(readFileSync(join(root, 'data', 'child.pid'), 'utf8'));
    expect(Number.isFinite(childPid)).toBe(true);

    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => proc.on('exit', () => resolve()));

    // Give Windows a moment to reap the child, then confirm it is gone.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    let alive = false;
    try {
      process.kill(childPid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});

describe.runIf(process.platform === 'win32')('launcher.mjs environment, error log and orphan', () => {
  function idleRoot(mainSource: string): string {
    const root = join(tempDir(), 'MAXCOM');
    const src = join(root, 'current', 'apps', 'box-server', 'src');
    mkdirSync(src, { recursive: true });
    const dataDir = join(root, 'data');
    mkdirSync(join(dataDir, 'logs'), { recursive: true });
    writeFileSync(join(root, 'box-config.json'), JSON.stringify({ v: 1, dataDir, env: {} }));
    writeFileSync(join(root, 'launcher.mjs'), readFileSync(launcher));
    writeFileSync(join(src, 'main.ts'), mainSource);
    return root;
  }
  const idle = 'setInterval(() => {}, 60_000);\n';
  // Windows env names are case-insensitive: drop every spelling before setting one
  const envWith = (key: string, value: string): NodeJS.ProcessEnv => {
    const out: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.toLowerCase() !== key.toLowerCase()) out[k] = v;
    }
    out[key] = value;
    return out;
  };
  // proc.kill() is a hard kill on Windows, so the launcher's child would be left running
  const killAll = (proc: ChildProcess, root: string) => {
    proc.kill();
    try {
      process.kill(Number(readFileSync(join(root, 'data', 'logs', 'box.pid'), 'utf8')));
    } catch {
      // already gone
    }
  };
  const bystanderArgs = ['-e', 'setInterval(()=>{},60000)'];

  async function waitFor(check: () => boolean, ms = 20_000): Promise<void> {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('the child sees SystemRoot and can resolve localhost with dns.lookup', async () => {
    const root = idleRoot(
      "import dns from 'node:dns';\n" +
        "console.log('SR=' + process.env.SystemRoot);\n" +
        "dns.lookup('localhost', (e, a) => { console.log(e ? 'DNSFAIL ' + e.code : 'DNSOK ' + a); });\n" +
        idle,
    );
    const proc = spawn(process.execPath, [join(root, 'launcher.mjs')], {
      cwd: root,
      env: { ...process.env },
      stdio: 'ignore',
    });
    try {
      const log = join(root, 'data', 'logs', 'box.log');
      const read = () => {
        try {
          return readFileSync(log, 'utf8');
        } catch {
          return '';
        }
      };
      await waitFor(() => /DNSOK|DNSFAIL/.test(read()));
      const text = read();
      expect(text).toContain(`SR=${process.env.SystemRoot}`);
      expect(text).toContain('DNSOK');
    } finally {
      killAll(proc, root);
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  it('a config error goes to stderr and ProgramData, never into the install folder', () => {
    const root = join(tempDir(), 'MAXCOM');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'launcher.mjs'), readFileSync(launcher));
    const pd = tempDir();
    const r = spawnSync(process.execPath, [join(root, 'launcher.mjs')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      env: envWith('ProgramData', pd),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('GAGAL config');
    expect(readFileSync(join(pd, 'MAXCOM', 'launcher-error.log'), 'utf8')).toContain('GAGAL config');
    expect(existsSync(join(root, 'launcher.log'))).toBe(false);
    expect(existsSync(join(updateDir, 'launcher.log'))).toBe(false);
  });

  it('an unwritable ProgramData does not stop the error report', () => {
    const root = join(tempDir(), 'MAXCOM');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'launcher.mjs'), readFileSync(launcher));
    const blocker = join(tempDir(), 'file');
    writeFileSync(blocker, 'x');
    const r = spawnSync(process.execPath, [join(root, 'launcher.mjs')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      env: envWith('ProgramData', blocker),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('GAGAL config');
  });

  it('records the child pid in box.pid and ends an orphaned box left by a killed launcher', async () => {
    const root = idleRoot(idle);
    const mainScript = join(root, 'current', 'apps', 'box-server', 'src', 'main.ts');
    const orphan = spawn(process.execPath, [mainScript], { stdio: 'ignore' });
    const pidFile = join(root, 'data', 'logs', 'box.pid');
    writeFileSync(pidFile, String(orphan.pid));
    const bystander = spawn(process.execPath, bystanderArgs, { stdio: 'ignore' });
    const proc = spawn(process.execPath, [join(root, 'launcher.mjs')], {
      cwd: root,
      env: { ...process.env },
      stdio: 'ignore',
    });
    try {
      await waitFor(() => !alive(orphan.pid!));
      await waitFor(() => {
        try {
          const n = Number(readFileSync(pidFile, 'utf8'));
          return n > 0 && n !== orphan.pid && alive(n);
        } catch {
          return false;
        }
      });
      expect(alive(bystander.pid!)).toBe(true);
    } finally {
      killAll(proc, root);
      bystander.kill();
      orphan.kill();
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  it('reapOrphan leaves a live process that is not the box and drops the stale file', async () => {
    const { reapOrphan } = await import(/* @vite-ignore */ launcher + '?r=' + Date.now());
    const dir = tempDir();
    const pidFile = join(dir, 'box.pid');
    const bystander = spawn(process.execPath, bystanderArgs, { stdio: 'ignore' });
    try {
      writeFileSync(pidFile, String(bystander.pid));
      expect(reapOrphan(pidFile, join(dir, 'current', 'main.ts'))).toBeNull();
      expect(alive(bystander.pid!)).toBe(true);
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      bystander.kill();
    }
  });

  it('isLauncherHolder: only a live node running this launcher counts, decided by the query', async () => {
    const { isLauncherHolder } = await import(/* @vite-ignore */ launcher + '?h=' + Date.now());
    const script = 'C:\\Program Files\\MAXCOM\\launcher.mjs';
    const exe = process.execPath;
    const mine = () => ({ exe, cmd: `"${exe}" "${script}"` });
    expect(isLauncherHolder(process.pid, script, exe, mine)).toBe(true);
    // forward slashes and case differences still match
    expect(isLauncherHolder(process.pid, script, exe, () => ({ exe: exe.toUpperCase(), cmd: script.replace(/\\/g, '/') }))).toBe(true);
    // a reused PID: another program, or node running something else
    expect(isLauncherHolder(process.pid, script, exe, () => ({ exe: 'C:\\Windows\\notepad.exe', cmd: 'notepad' }))).toBe(false);
    expect(isLauncherHolder(process.pid, script, exe, () => ({ exe, cmd: `"${exe}" other.mjs` }))).toBe(false);
    // unreadable query result
    expect(isLauncherHolder(process.pid, script, exe, () => null)).toBe(false);
    // a dead PID never reaches the query
    let asked = false;
    expect(isLauncherHolder(2147483000, script, exe, () => { asked = true; return mine(); })).toBe(false);
    expect(asked).toBe(false);
  });

  it('a stale lock naming a live unrelated process does not block the launcher', async () => {
    const root = idleRoot(idle);
    const bystander = spawn(process.execPath, bystanderArgs, { stdio: 'ignore' });
    const lock = join(root, 'data', 'logs', 'launcher.lock');
    writeFileSync(lock, String(bystander.pid));
    const proc = spawn(process.execPath, [join(root, 'launcher.mjs')], {
      cwd: root,
      env: { ...process.env },
      stdio: 'ignore',
    });
    try {
      await waitFor(() => {
        try {
          return readFileSync(lock, 'utf8').trim() === String(proc.pid);
        } catch {
          return false;
        }
      });
      expect(alive(bystander.pid!)).toBe(true);
    } finally {
      killAll(proc, root);
      bystander.kill();
      await new Promise((r) => setTimeout(r, 1000));
    }
  });
});

describe.runIf(process.platform === 'win32')('cli.mjs run', () => {
  function makeRoot(): string {
    const root = tempDir();
    const cliDir = join(root, 'current', 'apps', 'box-server', 'src', 'cli');
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(
      join(root, 'box-config.json'),
      JSON.stringify({ v: 1, dataDir: join(root, 'data'), env: {} }),
    );
    writeFileSync(
      join(cliDir, 'users.ts'),
      `console.log('users ran'); console.log(process.env.SURAU_DB); console.log(process.env.SURAU_DATA_DIR);\n`,
    );
    writeFileSync(join(root, 'cli.mjs'), readFileSync(cli));
    return root;
  }

  function runCli(root: string, ...args: string[]): { status: number | null; out: string } {
    const r = spawnSync(process.execPath, [join(root, 'cli.mjs'), ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  it('runs an existing CLI with SURAU_DB and SURAU_DATA_DIR set', () => {
    const root = makeRoot();
    const r = runCli(root, 'users');
    expect(r.status).toBe(0);
    expect(r.out).toContain('users ran');
    expect(r.out).toContain(join(root, 'data', 'surau.db'));
    expect(r.out).toContain(join(root, 'data'));
    expect(r.out).toContain('owner only');
  });

  it('refuses bad names and missing CLI files', () => {
    const root = makeRoot();
    expect(runCli(root, '..\\x').status).not.toBe(0);
    expect(runCli(root, 'users;calc').status).not.toBe(0);
    expect(runCli(root, 'nope').status).not.toBe(0);
  });
});

describe.runIf(process.platform === 'win32')('cli.mjs installed in <root>\\bin', () => {
  it('finds box-config.json and current\\ one level up from bin', () => {
    const root = join(tempDir(), 'MAXCOM uji & \'bin\'');
    const cliDir = join(root, 'current', 'apps', 'box-server', 'src', 'cli');
    mkdirSync(cliDir, { recursive: true });
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'box-config.json'), JSON.stringify({ v: 1, dataDir: join(root, 'data'), env: {} }));
    writeFileSync(join(cliDir, 'users.ts'), `console.log('users ran'); console.log(process.env.SURAU_DB);\n`);
    writeFileSync(join(root, 'bin', 'cli.mjs'), readFileSync(cli));
    const r = spawnSync(process.execPath, [join(root, 'bin', 'cli.mjs'), 'users'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('users ran');
    expect(r.stdout).toContain(join(root, 'data', 'surau.db'));
  });
});

describe.runIf(process.platform === 'win32')('real ProgramData guard', () => {
  it('a launcher run with no config reports into the sandbox ProgramData, and the real folder is untouched', () => {
    const root = join(tempDir(), 'MAXCOM');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'launcher.mjs'), readFileSync(launcher));
    // no env override on purpose: the child inherits process.env, which beforeAll pointed at the sandbox
    const r = spawnSync(process.execPath, [join(root, 'launcher.mjs')], { cwd: root, encoding: 'utf8', timeout: 15_000 });
    expect(r.status).toBe(2);
    expect(process.env.ProgramData).toBe(sandboxProgramData);
    expect(existsSync(join(sandboxProgramData, 'MAXCOM', 'launcher-error.log'))).toBe(true);
    if (realMaxcomHome && realLog) {
      expect(existsSync(realMaxcomHome)).toBe(realBefore.home);
      const now = existsSync(realLog) ? statSync(realLog).mtimeMs + ':' + statSync(realLog).size : null;
      expect(now).toBe(realBefore.log);
    }
  });
});
