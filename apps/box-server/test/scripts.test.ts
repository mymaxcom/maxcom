import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/retire-legacy-watcher.ps1', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-retire-'));
  dirs.push(d);
  return d;
}

describe('retire-legacy-watcher.ps1 (static)', () => {
  const text = readFileSync(script, 'utf8');
  it('is ASCII only', () => {
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(text)).toBe(false);
  });
  it('is dry-run unless -Apply, with mandatory names and no hardcoded old product', () => {
    expect(text).toMatch(/\[switch\]\$Apply/);
    expect(text).toMatch(/if \(-not \$Apply\)/);
    expect(text).toMatch(/Mandatory = \$true\)\]\[string\]\$TaskName/);
    expect(text).toMatch(/Mandatory = \$true\)\]\[string\]\$Folder/);
    expect(text).not.toMatch(/waqaf/i);
  });
  it('never removes files, only moves the folder', () => {
    expect(text).not.toMatch(/Remove-Item/);
  });
});

describe.runIf(process.platform === 'win32')('retire-legacy-watcher.ps1 (run)', () => {
  const run = (args: string[]): { status: number | null; out: string } => {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('dry run changes nothing', () => {
    const base = tempDir();
    const folder = join(base, 'oldwatcher');
    mkdirSync(folder);
    writeFileSync(join(folder, 'a.txt'), 'x');
    const r = run(['-TaskName', 'NoSuchTask-xyz-123', '-Folder', folder]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/DRY RUN/);
    expect(existsSync(join(folder, 'a.txt'))).toBe(true);
    expect(existsSync(join(base, 'retired-' + new Date().toISOString().slice(0, 10)))).toBe(false);
  });

  it('refuses a folder inside the repo, one containing the repo, and a wildcard task', () => {
    expect(run(['-TaskName', 'T', '-Folder', join(repoRoot, 'scripts'), '-Apply']).status).toBe(1);
    expect(run(['-TaskName', 'T', '-Folder', join(repoRoot, '..'), '-Apply']).status).toBe(1);
    const base = tempDir();
    mkdirSync(join(base, 'f'));
    expect(run(['-TaskName', 'Task*', '-Folder', join(base, 'f')]).status).toBe(1);
    expect(existsSync(join(base, 'f'))).toBe(true);
  });

  it('refuses the data folder', () => {
    const data = tempDir();
    mkdirSync(join(data, 'sub'));
    const r = run(['-TaskName', 'T', '-Folder', join(data, 'sub'), '-DataDir', data, '-Apply']);
    expect(r.status).toBe(1);
  });
});
