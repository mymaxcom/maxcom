import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { spawnRunner } from '../src/live/audioInputs.ts';
import { startMediamtx } from '../src/live/mediamtx.ts';
import { spawnJoin } from '../src/live/recordings.ts';

// F1: the helper programs the live feature starts get a bare environment: the box's own secrets are not passed on.
const SECRET = 'kiosk-token-must-not-leak';
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DUMP = 'console.error(JSON.stringify(process.env))';

describe('F1: child environment', () => {
  it('the recording join gets no box secret and still has PATH', async () => {
    vi.stubEnv('SURAU_KIOSK_TOKEN', SECRET);
    const r = await spawnJoin(process.execPath, ['-e', DUMP], 10_000);
    expect(r.stderr).not.toContain(SECRET);
    expect(r.stderr).not.toContain('SURAU_KIOSK_TOKEN');
    expect(Object.keys(JSON.parse(r.stderr) as object).map((k) => k.toUpperCase())).toContain('PATH');
  });

  it('the audio input probe gets no box secret', async () => {
    vi.stubEnv('SURAU_KIOSK_TOKEN', SECRET);
    const r = await spawnRunner(process.execPath, ['-e', DUMP], 10_000);
    expect(r.output).not.toContain(SECRET);
    expect(r.output).not.toContain('SURAU_KIOSK_TOKEN');
    expect(r.output).toContain('PATH');
  });

  it('the media server gets no box secret', async () => {
    vi.stubEnv('SURAU_KIOSK_TOKEN', SECRET);
    const dir = mkdtempSync(join(tmpdir(), 'maxcom-env-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'live'), { recursive: true });
    const out = join(dir, 'env.json').split(String.fromCharCode(92)).join('/');
    const s = startMediamtx({
      exe: process.execPath,
      args: ['-e', `require('fs').writeFileSync('${out}', JSON.stringify(process.env)); setInterval(() => {}, 1000)`],
      dataDir: dir,
      backoffBaseMs: 10,
      backoffMaxMs: 40,
    });
    s.start();
    try {
      const until = Date.now() + 10_000;
      let text = '';
      while (Date.now() < until && text === '') {
        try {
          text = readFileSync(out, 'utf8');
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      expect(text).not.toBe('');
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('SURAU_KIOSK_TOKEN');
      expect(text.toUpperCase()).toContain('PATH');
    } finally {
      await s.stop();
    }
  });
});

describe('F8: the leave secret in the environment', () => {
  it('is taken out of the environment by buildApp on a box that never reaches the link routes (the cloud)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'maxcom-env-'));
    dirs.push(dir);
    vi.stubEnv('SURAU_LEAVE_SECRET', 'ab'.repeat(32));
    const app = buildApp(':memory:', { role: 'cloud', dataDir: dir, boxId: '0c10ad000000000d' });
    try {
      await app.ready();
      expect(process.env.SURAU_LEAVE_SECRET).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
