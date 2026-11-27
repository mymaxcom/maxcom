import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeLegacyImportDir } from '../src/legacyImportCleanup.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), 'legacy-import-'));
  dirs.push(d);
  return d;
}

describe('removeLegacyImportDir', () => {
  it('removes <dataDir>/import and leaves its siblings alone', () => {
    const dir = fresh();
    mkdirSync(join(dir, 'import', 'x'), { recursive: true });
    writeFileSync(join(dir, 'import', 'x', 'upload.zip'), 'zip');
    writeFileSync(join(dir, 'surau.db'), 'db');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'keep.txt'), 'k');

    expect(removeLegacyImportDir(dir)).toBe(true);
    expect(existsSync(join(dir, 'import'))).toBe(false);
    expect(existsSync(join(dir, 'surau.db'))).toBe(true);
    expect(existsSync(join(dir, 'assets', 'keep.txt'))).toBe(true);
  });

  it('never deletes through a link or junction named import: the link and its target stay', () => {
    const dir = fresh();
    const outside = fresh();
    writeFileSync(join(outside, 'precious.txt'), 'p');
    const link = join(dir, 'import');
    symlinkSync(outside, link, 'junction');
    const warnings: string[] = [];
    try {
      expect(removeLegacyImportDir(dir, (m) => warnings.push(m))).toBe(false);
      expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(warnings).toHaveLength(1);
    } finally {
      // remove the link itself first, so the temp clean-up can never follow it
      unlinkSync(link);
    }
  });

  it('does nothing when there is no import folder, and never throws', () => {
    const dir = fresh();
    const warnings: string[] = [];
    expect(removeLegacyImportDir(dir, (m) => warnings.push(m))).toBe(false);
    expect(removeLegacyImportDir(join(dir, 'missing'), (m) => warnings.push(m))).toBe(false);
    expect(warnings).toEqual([]);
  });
});
