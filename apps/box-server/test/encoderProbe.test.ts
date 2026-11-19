import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EncoderCapability, PROBE_RETRY_MS, probeLibx264 } from '../src/live/encoder.ts';

const dir = mkdtempSync(join(tmpdir(), 'surau-encprobe-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function stub(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}
const probe = (script: string, timeoutMs = 3000): Promise<boolean | null> => probeLibx264(process.execPath, timeoutMs, [script]);

describe('probeLibx264', () => {
  it('capable: exit 0 and a normal encoder description', async () => {
    const s = stub('ok.cjs', "console.log('Encoder libx264 [libx264 H.264]');");
    expect(await probe(s)).toBe(true);
  });

  it('not recognized (even with exit 0) is false', async () => {
    const s = stub('nr.cjs', "console.error('Codec libx264 is not recognized by FFmpeg.');");
    expect(await probe(s)).toBe(false);
  });

  it('not recognized with a failing exit is still a definite false', async () => {
    const s = stub('nr1.cjs', "console.error('Codec libx264 is not recognized by FFmpeg.'); process.exit(1);");
    expect(await probe(s)).toBe(false);
  });

  it('a non-zero exit without that sentence cannot tell (null)', async () => {
    const s = stub('bad.cjs', 'process.exit(1);');
    expect(await probe(s)).toBeNull();
  });

  it('a spawn error cannot tell (null)', async () => {
    expect(await probeLibx264(join(dir, 'no-such-ffmpeg'), 1000)).toBeNull();
  });

  it('a hang times out to null', async () => {
    const s = stub('hang.cjs', 'setInterval(() => {}, 1000);');
    expect(await probe(s, 150)).toBeNull();
  });
});

describe('EncoderCapability', () => {
  it('probes once per path, caches, and probes again when the path changes', async () => {
    const seen: string[] = [];
    const cap = new EncoderCapability(async (p) => {
      seen.push(p);
      return p === 'a';
    });
    expect(cap.peek('a')).toBeNull();
    expect(await Promise.all([cap.check('a'), cap.check('a')])).toEqual([true, true]);
    expect(await cap.check('a')).toBe(true);
    expect(cap.peek('a')).toBe(true);
    expect(seen).toEqual(['a']);
    expect(await cap.check('b')).toBe(false);
    expect(cap.peek('a')).toBeNull();
    expect(seen).toEqual(['a', 'b']);
  });

  it('a throwing probe is false', async () => {
    const cap = new EncoderCapability(async () => {
      throw new Error('x');
    });
    expect(await cap.check('a')).toBe(false);
  });

  it('a definite no is cached for good; an inconclusive answer is false for a minute and then probed again', async () => {
    let t = 1_000_000;
    const answers: (boolean | null)[] = [null, true];
    let runs = 0;
    const cap = new EncoderCapability(async () => {
      runs++;
      return answers.length > 0 ? answers.shift()! : false;
    }, () => t);
    expect(await cap.check('a')).toBe(false);
    expect(cap.peek('a')).toBe(false);
    t += PROBE_RETRY_MS - 1;
    expect(await cap.check('a')).toBe(false);
    expect(runs).toBe(1);
    t += 2;
    expect(cap.peek('a')).toBeNull();
    expect(await cap.check('a')).toBe(true);
    expect(runs).toBe(2);
    t += 10 * PROBE_RETRY_MS;
    expect(await cap.check('a')).toBe(true);
    expect(runs).toBe(2);

    let noRuns = 0;
    const no = new EncoderCapability(async () => {
      noRuns++;
      return false;
    }, () => t);
    expect(await no.check('a')).toBe(false);
    t += 10 * PROBE_RETRY_MS;
    expect(await no.check('a')).toBe(false);
    expect(noRuns).toBe(1);
  });
});
