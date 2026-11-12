import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(new URL('../../../scripts/setup/migrate-data.ps1', import.meta.url));
const mainTs = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const src = readFileSync(scriptPath, 'utf8');
const SID = 'S-1-5-19';

describe('migrate-data.ps1 static checks', () => {
  it('is pure ASCII with CRLF line ends', () => {
    for (let i = 0; i < src.length; i++) expect(src.charCodeAt(i)).toBeLessThan(128);
    expect(src).toContain('\r\n');
    expect(src.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('stops processes only with Stop-Process -Id and never by name or pipeline', () => {
    const uses = src.match(/Stop-Process[^\r\n]*/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^Stop-Process -Id(?![A-Za-z])/);
    expect(src).not.toMatch(/\|\s*Stop-Process/);
    expect(src).not.toMatch(/\btaskkill\b/i);
    expect(src).not.toMatch(/Get-Process\s+-Name/i);
  });

  it('never deletes, moves or rewrites anything with the source as target', () => {
    expect(src).not.toMatch(/Remove-Item|Move-Item|Rename-Item|Set-Content|Add-Content|Out-File|Clear-Content/);
    expect(src).not.toMatch(/robocopy[^\r\n]*\/(MOVE|MOV|MIR|PURGE)\b/i);
    expect(src).not.toMatch(/'\/(MOVE|MOV|MIR|PURGE)'/i);
    // the only rename is of the target folder
    const moves = src.match(/\[System\.IO\.Directory\]::Move\([^\r\n]*/g) ?? [];
    expect(moves.length).toBe(1);
    expect(moves[0]).toContain('$dst');
    expect(moves[0]).not.toContain('$src');
    expect(moves[0]).not.toContain('$From');
    // every robocopy call names the source first and a destination variable second
    expect(src).toContain('Invoke-Robocopy $src $backupData');
    expect(src).toContain('Invoke-Robocopy $src $dst $skipFull');
    expect(src).not.toMatch(/\[System\.IO\.(File|Directory)\]::(Delete|Move|WriteAllText|WriteAllBytes|Create)[^\r\n]*\$(src|From)\b/);
  });

  it('copies with /COPY:DAT /XJ, applies the data ACL after the copy, and keeps -TestCorrupt behind -SkipAcl', () => {
    expect(src).toContain("'/COPY:DAT'");
    expect(src).toContain("'/XJ'");
    expect(src.lastIndexOf('Set-MaxcomDataAcl $dst')).toBeGreaterThan(src.indexOf('Invoke-Robocopy $src $dst $skipFull'));
    expect(src).toMatch(/if \(\$TestCorrupt -ne '' -and -not \$SkipAcl\) \{ throw/);
    expect(src).toContain('integrity_check');
    expect(src).toContain('readOnly:true');
    expect(src).toContain("'integrity-check'");
    expect(src).toContain('data.failed-');
    expect(src).not.toMatch(/Write-Host[^\r\n]*\$key\b/i);
  });

  it('keeps the messages in Bahasa Malaysia and failures start with GAGAL', () => {
    expect(src).toContain('GAGAL:');
    expect(src).toContain('Henti proses ini? (y/t)');
    expect(src).toContain('jangan hidupkan kotak lama lagi');
  });
});

// ------------------------------------------------------------------------------------------
// Runtime tests (Windows): a real box is started on a random port with a temp data folder.
// The pilot's real data folder and the live box on 8787 are never touched.
// ------------------------------------------------------------------------------------------

const roots: string[] = [];
const procs: ChildProcess[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'MAXCOM migrasi & \'satu\' '));
  roots.push(d);
  return d;
}

afterEach(() => {
  for (const p of procs.splice(0)) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
});
afterAll(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function startBox(dataDir: string, port: number): Promise<{ child: ChildProcess; boxId: string }> {
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, [mainTs], {
    env: {
      ...process.env,
      SURAU_DB: join(dataDir, 'surau.db'),
      SURAU_DATA_DIR: dataDir,
      SURAU_PORT: String(port),
      SURAU_HTTPS_PORT: String(await freePort()),
      SURAU_LIVE_TOOLS: join(dataDir, 'no-live-tools'),
    },
    stdio: 'ignore',
  });
  procs.push(child);
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/box/info`);
      if (r.ok) return { child, boxId: ((await r.json()) as { boxId: string }).boxId };
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('box did not start');
}

async function stopBox(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const done = new Promise<void>((r) => child.once('exit', () => r()));
  child.kill();
  await done;
  await sleep(300);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** relative path (forward slashes) -> sha256, files only, sorted. */
function hashList(dir: string, skip: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const rel = relative(dir, p).replace(/\\/g, '/');
        if (!skip.includes(rel)) out[rel] = createHash('sha256').update(readFileSync(p)).digest('hex');
      }
    }
  };
  walk(dir);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function addExtras(dataDir: string): void {
  mkdirSync(join(dataDir, 'assets'), { recursive: true });
  mkdirSync(join(dataDir, 'islamic'), { recursive: true });
  writeFileSync(join(dataDir, 'assets', 'gambar [1] & \'dua\'.png'), Buffer.from('PNGDATA-' + 'x'.repeat(5000)));
  writeFileSync(join(dataDir, 'islamic', 'a.json'), '{"a":1}');
  writeFileSync(join(dataDir, 'box-run.log'), 'old hand-run log\n');
}

function run(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    { encoding: 'utf8', timeout: 150_000 },
  );
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

function baseArgs(from: string, base: string, port: number, extra: string[] = []): string[] {
  return [
    '-From', from,
    '-DataDir', join(base, 'data'),
    '-BackupRoot', join(base, 'backups'),
    '-NodeExe', process.execPath,
    '-ServiceSid', SID,
    '-Port', String(port),
    '-SkipAcl',
    ...extra,
  ];
}

describe.skipIf(process.platform !== 'win32')('migrate-data.ps1 (real box, temp folders)', () => {
  let work = '';
  let source = '';
  let sourceBoxId = '';
  let sourceList: Record<string, string> = {};

  beforeAll(async () => {
    work = tmp();
    source = join(work, 'sumber lama');
    const port = await freePort();
    const { child, boxId } = await startBox(source, port);
    sourceBoxId = boxId;
    await stopBox(child);
    addExtras(source);
    sourceList = hashList(source);
    expect(Object.keys(sourceList)).toContain('secret/box.key');
    expect(Object.keys(sourceList)).toContain('surau.db');
  }, 60_000);

  it('migrates a stopped box: target equals source, backup and manifest match, BOXID is the real box id, source unchanged', async () => {
    const base = join(tmp(), 'pasang baru');
    mkdirSync(base);
    const r = run(baseArgs(source, base, await freePort()));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`BOXID ${sourceBoxId}`);
    expect(r.out).toMatch(/integrity_check ok/);
    expect(r.out).toContain('jangan hidupkan kotak lama lagi');

    // old log is skipped in the new data folder only
    expect(hashList(join(base, 'data'))).toEqual(hashList(source, ['box-run.log']));
    expect(existsSync(join(base, 'data', 'box-run.log'))).toBe(false);
    expect(hashList(source)).toEqual(sourceList);

    const backups = readdirSync(join(base, 'backups'));
    expect(backups.length).toBe(1);
    expect(backups[0]).toMatch(/^pre-install-\d{8}-\d{6}$/);
    const bdir = join(base, 'backups', backups[0]!);
    expect(hashList(join(bdir, 'data'))).toEqual(sourceList);
    const manifest = JSON.parse(readFileSync(join(bdir, 'source-manifest.json'), 'utf8')) as {
      v: number;
      boxId: string;
      files: { path: string; size: number; sha256: string }[];
    };
    expect(manifest.v).toBe(1);
    expect(manifest.boxId).toBe(sourceBoxId);
    expect(Object.fromEntries(manifest.files.map((f) => [f.path, f.sha256]))).toEqual(sourceList);
    // the manifest never carries the key bytes, only its hash
    expect(readFileSync(join(bdir, 'source-manifest.json'), 'utf8')).not.toContain(
      readFileSync(join(source, 'secret', 'box.key')).toString('hex'),
    );
  }, 150_000);

  it('the migrated folder starts as the same box (box id equals the one before the move)', async () => {
    const base = join(tmp(), 'pasang baru');
    mkdirSync(base);
    const r = run(baseArgs(source, base, await freePort()));
    expect(r.status, r.out).toBe(0);
    const port = await freePort();
    const { child, boxId } = await startBox(join(base, 'data'), port);
    expect(boxId).toBe(sourceBoxId);
    await stopBox(child);
  }, 150_000);

  it('refuses a target that already has surau.db and leaves it untouched', async () => {
    const base = join(tmp(), 'pasang baru');
    const data = join(base, 'data');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'surau.db'), 'existing database');
    const before = hashList(base);
    const r = run(baseArgs(source, base, await freePort()));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: .*sudah ada surau\.db/);
    expect(hashList(base)).toEqual(before);
    expect(existsSync(join(base, 'backups'))).toBe(false);
    expect(hashList(source)).toEqual(sourceList);
  }, 90_000);

  it('refuses a source without secret\\box.key and one without surau.db', async () => {
    const bad = join(tmp(), 'tanpa kunci');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'surau.db'), 'x');
    const base = join(tmp(), 'pasang baru');
    mkdirSync(base);
    let r = run(baseArgs(bad, base, await freePort()));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: .*box\.key/);
    expect(existsSync(join(base, 'data'))).toBe(false);
    expect(existsSync(join(base, 'backups'))).toBe(false);

    const bad2 = join(tmp(), 'tanpa db');
    mkdirSync(join(bad2, 'secret'), { recursive: true });
    writeFileSync(join(bad2, 'secret', 'box.key'), Buffer.alloc(32, 1));
    r = run(baseArgs(bad2, base, await freePort()));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: .*surau\.db/);
    expect(existsSync(join(base, 'data'))).toBe(false);
  }, 120_000);

  it('refuses a box.key of the wrong size and a target inside the source', async () => {
    const bad = join(tmp(), 'kunci pendek');
    mkdirSync(join(bad, 'secret'), { recursive: true });
    writeFileSync(join(bad, 'surau.db'), 'x');
    writeFileSync(join(bad, 'secret', 'box.key'), Buffer.alloc(5, 1));
    const base = join(tmp(), 'pasang baru');
    mkdirSync(base);
    let r = run(baseArgs(bad, base, await freePort()));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: .*32 bait/);

    const inside = join(source, 'dalam');
    r = run([
      '-From', source, '-DataDir', inside, '-BackupRoot', join(base, 'backups'),
      '-NodeExe', process.execPath, '-ServiceSid', SID, '-Port', String(await freePort()), '-SkipAcl',
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: .*satu sama lain/);
    expect(existsSync(inside)).toBe(false);
    expect(hashList(source)).toEqual(sourceList);
  }, 120_000);

  it('refuses -TestCorrupt without -SkipAcl and an unsafe -TestCorrupt path', async () => {
    const base = join(tmp(), 'pasang baru');
    mkdirSync(base);
    const noSkip = baseArgs(source, base, await freePort()).filter((a) => a !== '-SkipAcl');
    let r = run([...noSkip, '-TestCorrupt', 'surau.db']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: .*-TestCorrupt hanya dibenarkan bersama -SkipAcl/);
    r = run(baseArgs(source, base, await freePort(), ['-TestCorrupt', '..\\..\\x']));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: .*-TestCorrupt/);
    expect(existsSync(join(base, 'data'))).toBe(false);
  }, 120_000);

  it('does not stop a live process on the port that is not node main.ts', async () => {
    const port = await freePort();
    const other = spawn(
      process.execPath,
      ['-e', `require('net').createServer().listen(${port},'127.0.0.1');setInterval(function(){},1000)`],
      { stdio: 'ignore' },
    );
    procs.push(other);
    for (let i = 0; i < 40; i++) {
      const up = await new Promise<boolean>((res) => {
        const s = createServer();
        s.once('error', () => res(true));
        s.listen(port, '127.0.0.1', () => s.close(() => res(false)));
      });
      if (up) break;
      await sleep(250);
    }
    const base = join(tmp(), 'pasang baru');
    mkdirSync(base);
    const r = run(baseArgs(source, base, port, ['-Yes', '-StopPid', String(other.pid)]));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: .*bukan kotak MAXCOM tangan/);
    expect(r.out).toContain(`PID ${other.pid}`);
    expect(alive(other.pid!)).toBe(true);
    expect(existsSync(join(base, 'data'))).toBe(false);
    expect(existsSync(join(base, 'backups'))).toBe(false);
  }, 120_000);

  it('with -Yes it needs -StopPid and the PID must match the listener; nothing is stopped otherwise', async () => {
    const live = join(tmp(), 'kotak hidup');
    const port = await freePort();
    const { child } = await startBox(live, port);
    const base = join(tmp(), 'pasang baru');
    mkdirSync(base);
    let r = run(baseArgs(live, base, port, ['-Yes']));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: .*-StopPid/);
    expect(alive(child.pid!)).toBe(true);
    r = run(baseArgs(live, base, port, ['-Yes', '-StopPid', String(child.pid! + 4)]));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: .*tidak sama dengan PID/);
    expect(alive(child.pid!)).toBe(true);
    expect(existsSync(join(base, 'data'))).toBe(false);
    await stopBox(child);
  }, 150_000);

  it('with the real box running and -Yes -StopPid it stops exactly that PID and migrates', async () => {
    const live = join(tmp(), 'kotak hidup');
    const port = await freePort();
    const { child, boxId } = await startBox(live, port);
    const bystander = spawn(process.execPath, ['-e', 'setInterval(function(){},1000)'], { stdio: 'ignore' });
    procs.push(bystander);
    await sleep(500);
    const base = join(tmp(), 'pasang baru');
    mkdirSync(base);
    const r = run(baseArgs(live, base, port, ['-Yes', '-StopPid', String(child.pid)]));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`PID ${child.pid}`);
    expect(r.out).toContain(`BOXID ${boxId}`);
    expect(alive(child.pid!)).toBe(false);
    expect(alive(bystander.pid!)).toBe(true);
    const liveList = hashList(live);
    expect(hashList(join(base, 'data'))).toEqual(liveList);
    expect(Object.keys(hashList(join(base, 'data')))).toContain('surau.db');
    const bdir = join(base, 'backups', readdirSync(join(base, 'backups'))[0]!);
    expect(hashList(join(bdir, 'data'))).toEqual(liveList);
  }, 180_000);

  it('a corrupted copy ends with data.failed-*, exit 1 and an intact source', async () => {
    const base = join(tmp(), 'pasang baru');
    mkdirSync(base);
    const r = run(baseArgs(source, base, await freePort(), ['-TestCorrupt', 'assets\\gambar [1] & \'dua\'.png']));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: .*salinan tidak sama dengan sumber/);
    expect(existsSync(join(base, 'data'))).toBe(false);
    const failed = readdirSync(base).filter((n) => n.startsWith('data.failed-'));
    expect(failed.length).toBe(1);
    expect(r.out).toContain('Folder sumber tidak diubah');
    expect(hashList(source)).toEqual(sourceList);
    // the backup taken before the failure is still the rollback point
    const bdir = join(base, 'backups', readdirSync(join(base, 'backups'))[0]!);
    expect(hashList(join(bdir, 'data'))).toEqual(sourceList);
  }, 150_000);

  it('a corrupted database copy is caught as well', async () => {
    const base = join(tmp(), 'pasang baru');
    mkdirSync(base);
    const r = run(baseArgs(source, base, await freePort(), ['-TestCorrupt', 'surau.db']));
    expect(r.status).toBe(1);
    expect(readdirSync(base).some((n) => n.startsWith('data.failed-'))).toBe(true);
    expect(hashList(source)).toEqual(sourceList);
  }, 150_000);

  it('-DryRun changes nothing and still shows the box id', async () => {
    const base = join(tmp(), 'pasang baru');
    mkdirSync(base);
    const r = run(baseArgs(source, base, await freePort(), ['-DryRun']));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/DRYRUN salin/);
    expect(r.out).toContain(`BOXID ${sourceBoxId}`);
    expect(readdirSync(base)).toEqual([]);
    expect(hashList(source)).toEqual(sourceList);
  }, 90_000);

  it('-DryRun does not stop a live box', async () => {
    const live = join(tmp(), 'kotak hidup');
    const port = await freePort();
    const { child } = await startBox(live, port);
    const base = join(tmp(), 'pasang baru');
    mkdirSync(base);
    const r = run(baseArgs(live, base, port, ['-DryRun']));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`PID ${child.pid}`);
    expect(alive(child.pid!)).toBe(true);
    expect(readdirSync(base)).toEqual([]);
    await stopBox(child);
  }, 150_000);
});
