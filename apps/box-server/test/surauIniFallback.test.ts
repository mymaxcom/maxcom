import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/imageAdjust.ts', async (orig) => ({
  ...(await orig<typeof import('../src/imageAdjust.ts')>()),
  deriveImage: () => {
    throw new Error('render failed');
  },
}));

import { openDb } from '../src/db.ts';
import { getSettings } from '../src/settingsStore.ts';
import { applySurauIni } from '../src/surauIni.ts';

const MAXCOM = readFileSync(fileURLToPath(new URL('./fixtures/maxcom-logo.png', import.meta.url)));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('first-boot logo whose pre-render fails', () => {
  it('stores the plain asset id, not the adjusted ref', () => {
    const d = mkdtempSync(join(tmpdir(), 'surau-ini-fb-'));
    dirs.push(d);
    writeFileSync(join(d, 'surau.ini'), 'name = Surau Maxcom\n');
    writeFileSync(join(d, 'logo.png'), MAXCOM);
    const db = openDb(join(d, 'x.db'));
    const warns: string[] = [];
    applySurauIni(db, d, { info: () => undefined, warn: (m) => warns.push(m) });
    expect(warns.some((w) => /pre-rendered/.test(w))).toBe(true);
    try {
      expect(getSettings(db).surauInfo.logo).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      db.close();
    }
  });
});
