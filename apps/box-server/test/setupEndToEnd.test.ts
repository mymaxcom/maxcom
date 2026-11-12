// Plan 9 Task 14: one end-to-end walk through the installer scripts in a temp folder (no elevation).
// setup -LayoutOnly, the launcher and its restart, upgrade with backup, switch-release -Previous,
// setup -MigrateFrom (migrate-data -SkipAcl) into a second root, doctor, uninstall -LayoutOnly.
// Random ports only (never 8787); the launcher's ProgramData is pointed at a temp folder.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { makeFakeBundle, type FakeBundle } from './helpers/fakeBundle.ts';

const isWin = process.platform === 'win32';
const setupDir = fileURLToPath(new URL('../../../scripts/setup/', import.meta.url));
const script = (n: string): string => join(setupDir, n);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const bases: string[] = [];
const launchers: ChildProcess[] = [];

afterAll(() => {
  for (const c of launchers.splice(0)) killTree(c);
  for (const d of bases.splice(0)) rmSync(d, { recursive: true, force: true });
});

function killTree(c: ChildProcess): void {
  if (c.pid && c.exitCode === null) {
    spawnSync('taskkill.exe', ['/T', '/F', '/PID', String(c.pid)], { windowsHide: true });
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function ps(file: string, args: string[]): { status: number | null; out: string; stdout: string } {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
}

function psCommand(command: string): string {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return String(r.stdout ?? '').trim();
}

/** Scheduled task, firewall and certificate-store state that this test must leave exactly as it found it. */
function systemSnapshot(): string {
  return psCommand(
    [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$t = @(Get-ScheduledTask | Where-Object { $_.TaskName -like '*MAXCOM*' -or $_.TaskName -like 'Maxcom*' } | ForEach-Object { $_.TaskPath + $_.TaskName + '=' + $_.State } | Sort-Object)",
      "$f = @(Get-NetFirewallRule | Where-Object { $_.DisplayName -like '*MAXCOM*' } | ForEach-Object { $_.DisplayName + '=' + $_.Enabled } | Sort-Object)",
      "$c = @(foreach ($s in 'Cert:\\LocalMachine\\Root','Cert:\\LocalMachine\\My','Cert:\\CurrentUser\\Root','Cert:\\CurrentUser\\My') { $s + '=' + ((Get-ChildItem $s | ForEach-Object { $_.Thumbprint } | Sort-Object) -join ',') })",
      "ConvertTo-Json -Compress @{ tasks = $t; fw = $f; certs = $c }",
    ].join('; '),
  );
}

function sha(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** relative path (forward slashes) -> sha256, files only. */
function hashList(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).replace(/\\/g, '/')] = sha(p);
    }
  };
  walk(dir);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Real %ProgramData%\MAXCOM: file names, sizes and times, or null when the folder does not exist. */
function realProgramDataState(): string | null {
  const pd = process.env.ProgramData ?? 'C:\\ProgramData';
  const dir = join(pd, 'MAXCOM');
  if (!existsSync(dir)) return null;
  const rows: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      rows.push(`${relative(dir, p)}|${st.isDirectory() ? 'd' : st.size}|${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return rows.sort().join('\n');
}

async function health(port: number): Promise<{ ok: boolean; version?: string } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return (await r.json()) as { ok: boolean; version?: string };
  } catch {
    return null;
  }
}

async function waitHealth(port: number, seconds: number, version?: string): Promise<{ ok: boolean; version?: string }> {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const h = await health(port);
    if (h?.ok && (version === undefined || h.version === version)) return h;
    await sleep(250);
  }
  throw new Error(`no health on port ${port}${version ? ` with version ${version}` : ''} within ${seconds} s`);
}

async function waitPortClosed(port: number, seconds: number): Promise<void> {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if ((await health(port)) === null) return;
    await sleep(250);
  }
  throw new Error(`port ${port} still answers after ${seconds} s`);
}

/** Starts <root>\start.cmd (the launcher) through cmd.exe, with ProgramData pointed at a temp folder. */
function startLauncher(root: string, programData: string): ChildProcess {
  const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${join(root, 'start.cmd')}""`], {
    windowsVerbatimArguments: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, ProgramData: programData, PROGRAMDATA: programData },
  });
  launchers.push(child);
  return child;
}

async function stopLauncher(child: ChildProcess, port: number): Promise<void> {
  killTree(child);
  await waitPortClosed(port, 15);
  await sleep(300);
}

function readPid(data: string): number {
  return Number(readFileSync(join(data, 'logs', 'box.pid'), 'utf8').trim());
}

function writePins(file: string, fb: FakeBundle): void {
  const pins = {
    node: { version: '24.0.0', url: `https://nodejs.org/dist/v24.0.0/${fb.nodeZipName}`, sha256: fb.sha256.nodeZip, licence: 'MIT' },
    mediamtx: { version: 'v1.0.0', url: 'https://example.invalid/mediamtx_v1.0.0_windows_amd64.zip', sha256: fb.sha256.mediamtxZip, licence: 'MIT' },
    ffmpeg: { version: 'fake', url: 'https://example.invalid/ffmpeg-fake-win64.zip', sha256: fb.sha256.ffmpegZip, licence: 'GPL-3.0' },
  };
  writeFileSync(file, JSON.stringify(pins, null, 2));
}

function makeDb(file: string, rows: number): void {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS uji (id INTEGER PRIMARY KEY, nama TEXT)');
  for (let i = 0; i < rows; i++) db.prepare('INSERT INTO uji (nama) VALUES (?)').run(`surau ${i}`);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

describe.runIf(isWin)('box install, restart, upgrade, switch back, migrate and uninstall (temp folder)', () => {
  it(
    'walks the whole life of an install without touching tasks, firewall, certificates or the real ProgramData',
    async () => {
      const base = mkdtempSync(join(tmpdir(), "MAXCOM uji & 'satu' "));
      bases.push(base);
      const fakeProgramData = join(base, 'ProgramData');
      mkdirSync(fakeProgramData, { recursive: true });
      const realPdBefore = realProgramDataState();
      const sysBefore = systemSnapshot();
      expect(sysBefore).toContain('tasks');

      const b1 = makeFakeBundle(join(base, 'bundle-1'), { version: '2026.11.1' });
      const b2 = makeFakeBundle(join(base, 'bundle-2'), { version: '2026.11.2' });
      const pins1 = join(base, 'pins-1.json');
      const pins2 = join(base, 'pins-2.json');
      writePins(pins1, b1);
      writePins(pins2, b2);

      const root = join(base, 'Program Files', 'MAXCOM');
      const data = join(base, 'Data', 'data');
      const backups = join(base, 'Data', 'backups');
      const port = await freePort();
      const layout = (bundle: FakeBundle, pins: string, extra: string[] = []): string[] => [
        '-LayoutOnly', '-Yes', '-InstallRoot', root, '-DataDir', data, '-BundleDir', bundle.dir, '-PinsFile', pins,
        '-Ip', '127.0.0.1', '-Surau', 'Uji', '-Kiosk', 'tiada', '-Port', String(port), ...extra,
      ];

      // 1. first install, empty data folder
      let r = ps(script('setup.ps1'), layout(b1, pins1));
      expect(r.status, r.out).toBe(0);
      expect(existsSync(join(root, 'start.cmd'))).toBe(true);
      expect(existsSync(join(root, 'runtime', 'node', 'node.exe'))).toBe(true);
      expect(readFileSync(join(root, 'releases', '2026.11.1', 'release.json'), 'utf8')).toContain('2026.11.1');
      const dbFile = join(data, 'surau.db');
      makeDb(dbFile, 5);
      const dbHash = sha(dbFile);

      // 2. launcher up, doctor ok
      let launcher = startLauncher(root, fakeProgramData);
      await waitHealth(port, 30, '2026.11.1');
      const d1 = ps(script('doctor.ps1'), ['-InstallRoot', root, '-Json', '-SkipSystemChecks', '-Wait', '30']);
      expect(d1.status, d1.out).toBe(0);
      const rep = JSON.parse(d1.stdout.trim().split(/\r?\n/).pop() ?? '{}') as { ok: boolean; checks: { id: string; state: string }[] };
      expect(rep.ok, d1.out).toBe(true);
      expect(rep.checks.find((c) => c.id === 'health_http')?.state).toBe('ok');
      expect(rep.checks.find((c) => c.id === 'release')?.state).toBe('ok');

      // 3. kill the box child by PID: the launcher restarts it within 10 s
      const pid1 = readPid(data);
      expect(pid1).toBeGreaterThan(0);
      process.kill(pid1);
      const t0 = Date.now();
      let pid2 = pid1;
      while (Date.now() - t0 < 10_000) {
        try {
          const p = readPid(data);
          if (p !== pid1 && (await health(port))?.ok) {
            pid2 = p;
            break;
          }
        } catch {
          /* pid file between runs */
        }
        await sleep(250);
      }
      expect(pid2, 'launcher did not restart the box within 10 s').not.toBe(pid1);
      expect((await health(port))?.version).toBe('2026.11.1');
      expect(existsSync(join(data, 'logs', 'box.log'))).toBe(true);
      await stopLauncher(launcher, port);

      // 4. upgrade to 2026.11.2 with a database present: previous.txt, backup copy, new version answers
      r = ps(script('setup.ps1'), layout(b2, pins2));
      expect(r.status, r.out).toBe(0);
      expect(readFileSync(join(root, 'previous.txt'), 'utf8').trim()).toBe('2026.11.1');
      const pre = readdirSync(backups).filter((n) => n.startsWith('pre-2026.11.2-'));
      expect(pre.length, `backups: ${readdirSync(backups).join(', ')}`).toBe(1);
      expect(sha(join(backups, pre[0], 'surau.db'))).toBe(dbHash);
      expect(sha(dbFile)).toBe(dbHash);
      launcher = startLauncher(root, fakeProgramData);
      await waitHealth(port, 30, '2026.11.2');
      await stopLauncher(launcher, port);

      // 5. switch back to the previous release
      r = ps(script('switch-release.ps1'), ['-InstallRoot', root, '-Previous', '-Yes', '-LayoutOnly']);
      expect(r.status, r.out).toBe(0);
      expect(readFileSync(join(root, 'previous.txt'), 'utf8').trim()).toBe('2026.11.2');
      launcher = startLauncher(root, fakeProgramData);
      await waitHealth(port, 30, '2026.11.1');
      await stopLauncher(launcher, port);

      // 6. migration of a separate data folder into a fresh root (setup -MigrateFrom runs migrate-data.ps1 -SkipAcl)
      const source = join(base, 'old box data');
      mkdirSync(join(source, 'secret'), { recursive: true });
      mkdirSync(join(source, 'assets'), { recursive: true });
      const key = randomBytes(32);
      writeFileSync(join(source, 'secret', 'box.key'), key);
      writeFileSync(join(source, 'assets', "gambar [1] & 'dua'.png"), Buffer.from('PNG-' + 'x'.repeat(3000)));
      makeDb(join(source, 'surau.db'), 20);
      const sourceBefore = hashList(source);
      const boxId = createHash('sha256').update(key).digest('hex').slice(0, 16);

      const root2 = join(base, 'Program Files 2', 'MAXCOM');
      const data2 = join(base, 'Data 2', 'data');
      const port2 = await freePort();
      r = ps(script('setup.ps1'), [
        '-LayoutOnly', '-Yes', '-InstallRoot', root2, '-DataDir', data2, '-BundleDir', b1.dir, '-PinsFile', pins1,
        '-Ip', '127.0.0.1', '-Surau', 'Uji', '-Kiosk', 'tiada', '-Port', String(port2), '-MigrateFrom', source,
      ]);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(boxId);
      expect(hashList(source)).toEqual(sourceBefore);
      const copied = hashList(data2);
      for (const [rel, h] of Object.entries(sourceBefore)) expect(copied[rel], rel).toBe(h);
      const launcher2 = startLauncher(root2, fakeProgramData);
      await waitHealth(port2, 30, '2026.11.1');
      const d2 = ps(script('doctor.ps1'), ['-InstallRoot', root2, '-Json', '-SkipSystemChecks', '-Wait', '30', '-ExpectBoxId', boxId]);
      expect(d2.status, d2.out).toBe(0);
      const rep2 = JSON.parse(d2.stdout.trim().split(/\r?\n/).pop() ?? '{}') as { ok: boolean; checks: { id: string; state: string }[] };
      expect(rep2.ok, d2.out).toBe(true);
      expect(rep2.checks.find((c) => c.id === 'box_id')?.state).toBe('ok');
      await stopLauncher(launcher2, port2);

      // 7. uninstall both roots: roots gone, the data folders unchanged
      const dataBefore = hashList(data);
      const data2Before = hashList(data2);
      r = ps(script('uninstall.ps1'), ['-InstallRoot', root, '-LayoutOnly', '-Yes']);
      expect(r.status, r.out).toBe(0);
      expect(existsSync(root)).toBe(false);
      r = ps(script('uninstall.ps1'), ['-InstallRoot', root2, '-LayoutOnly', '-Yes']);
      expect(r.status, r.out).toBe(0);
      expect(existsSync(root2)).toBe(false);
      expect(hashList(data)).toEqual(dataBefore);
      expect(hashList(data2)).toEqual(data2Before);
      expect(existsSync(backups)).toBe(true);

      // 8. nothing outside the temp folder changed
      expect(systemSnapshot()).toBe(sysBefore);
      expect(realProgramDataState()).toBe(realPdBefore);
    },
    180_000,
  );
});
