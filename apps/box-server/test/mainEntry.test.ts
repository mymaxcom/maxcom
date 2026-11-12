import { spawn, type ChildProcess } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

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

let child: ChildProcess | undefined;
let root: string | undefined;
let link: string | undefined;
let tail = '';

afterEach(async () => {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    const c = child;
    const done = new Promise<void>((r) => {
      c.once('exit', () => r());
      c.once('error', () => r());
    });
    c.kill();
    await done;
    await sleep(300);
  }
  child = undefined;
  let linkGone = true;
  if (link !== undefined) {
    try {
      unlinkSync(link); // remove the link itself, never recurse through it
    } catch {
      try {
        rmSync(link); // Windows junction fallback (a directory link)
      } catch {
        /* already gone */
      }
    }
    // if the link survived, never recurse through it: leave the temp dir behind
    linkGone = lstatSync(link, { throwIfNoEntry: false }) === undefined;
    link = undefined;
  }
  if (root !== undefined && linkGone) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  root = undefined;
});

describe('main.ts entry detection', () => {
  it('starts the server when launched through a directory link (junction / symlink)', async () => {
    root = mkdtempSync(join(tmpdir(), 'maxcom-entry-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    link = join(root, 'current');
    if (process.platform === 'win32') symlinkSync(srcDir, link, 'junction');
    else symlinkSync(relative(root, srcDir), link, 'dir');
    const port = await freePort();
    child = spawn(process.execPath, [join(link, 'main.ts')], {
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SURAU_'))),
        SURAU_DB: join(dataDir, 'surau.db'),
        SURAU_DATA_DIR: dataDir,
        SURAU_PORT: String(port),
        SURAU_HTTPS_PORT: String(await freePort()),
        SURAU_LIVE_TOOLS: join(dataDir, 'no-live-tools'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    tail = '';
    const keep = (d: Buffer): void => {
      tail = (tail + d.toString()).slice(-4096);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.once('error', (e) => {
      tail += `
spawn error: ${String(e)}`;
    });
    let ok = false;
    for (let i = 0; i < 120 && !ok; i++) {
      if (child.exitCode !== null) break;
      try {
        ok = (await fetch(`http://127.0.0.1:${port}/api/box/info`)).ok;
      } catch {
        /* not up yet */
      }
      if (!ok) await sleep(250);
    }
    expect(ok, `exit=${child.exitCode} output:
${tail}`).toBe(true);
  }, 60_000);
});
