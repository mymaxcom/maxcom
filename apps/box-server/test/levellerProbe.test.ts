import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LevellerCapability, probeLevellerFilters } from '../src/live/levellerProbe.ts';

const FFMPEG = ((): string | null => {
  for (const c of [process.env.MAXCOM_TEST_FFMPEG, 'ffmpeg']) {
    if (c === undefined || c === '') continue;
    try {
      if (spawnSync(c, ['-version'], { windowsHide: true }).status === 0) return c;
    } catch {
      /* next */
    }
  }
  return null;
})();

describe('LevellerCapability', () => {
  it('asks once per ffmpeg path and caches a definite answer (concurrent callers share the run)', async () => {
    const probe = vi.fn(async () => false as boolean | null);
    const c = new LevellerCapability(probe);
    const [a, b] = await Promise.all([c.check('/x/ffmpeg'), c.check('/x/ffmpeg')]);
    expect([a, b]).toEqual([false, false]);
    expect(await c.check('/x/ffmpeg')).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    await c.check('/y/ffmpeg');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('markMissing records false for that path only: the next check answers false without probing', async () => {
    const probe = vi.fn(async () => null as boolean | null);
    const c = new LevellerCapability(probe);
    c.markMissing('/x/ffmpeg');
    expect(await c.check('/x/ffmpeg')).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(await c.check('/y/ffmpeg')).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('a probe still in flight when markMissing is called does not overwrite it', async () => {
    let release: (v: boolean | null) => void = () => undefined;
    const probe = vi.fn(() => new Promise<boolean | null>((r) => (release = r)));
    const c = new LevellerCapability(probe);
    const first = c.check('f');
    await Promise.resolve();
    await Promise.resolve();
    c.markMissing('f');
    release(true);
    await first;
    expect(await c.check('f')).toBe(false);
  });

  it('does not cache "could not tell" or a throwing probe: the next start asks again', async () => {
    const answers: Array<boolean | null | Error> = [null, new Error('boom'), true];
    const probe = vi.fn(async () => {
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a ?? null;
    });
    const c = new LevellerCapability(probe);
    expect(await c.check('f')).toBeNull();
    expect(await c.check('f')).toBeNull();
    expect(await c.check('f')).toBe(true);
    expect(await c.check('f')).toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
  });
});

describe('probeLevellerFilters', () => {
  it('a program that does not exist gives null, never throws', async () => {
    expect(await probeLevellerFilters('definitely-not-an-ffmpeg-binary')).toBeNull();
  });

  it('the two filter probes run in parallel: an ffmpeg that never answers costs one timeout, not two', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-'));
    const script = join(dir, 'hang.js');
    writeFileSync(script, "require('node:fs').appendFileSync(process.argv[1] + '.log', Date.now() + '\\n'); setTimeout(() => {}, 10000);\n");
    try {
      const timeout = 600;
      const t0 = Date.now();
      const r = await probeLevellerFilters(process.execPath, [script], timeout);
      const elapsed = Date.now() - t0;
      expect(r).toBeNull();
      expect(elapsed).toBeGreaterThanOrEqual(timeout - 50);
      expect(elapsed).toBeLessThan(timeout * 2 - 100); // sequential would be >= 2 * timeout
      expect(readFileSync(`${script}.log`, 'utf8').trim().split('\n')).toHaveLength(2); // both spawned
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(FFMPEG === null)('the real ffmpeg has both filters', async () => {
    expect(await probeLevellerFilters(FFMPEG as string)).toBe(true);
  });
});
