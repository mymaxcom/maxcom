import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KIOSK_TEMPLATE_IDS } from '@surau/core';
import { builtinThemeFiles, builtinThemesPlugin } from '../build/builtin-themes-plugin.ts';

const SRC = resolve(process.cwd(), 'src/themes');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('builtin themes plugin', () => {
  it('lists theme.json and theme.css for each built-in theme', () => {
    const files = builtinThemeFiles(SRC);
    expect(files.map((f) => f.path).sort()).toEqual(KIOSK_TEMPLATE_IDS.flatMap((id) => [`${id}/theme.css`, `${id}/theme.json`]).sort());
    for (const f of files.filter((x) => x.path.endsWith('.json'))) {
      const m = JSON.parse(f.data.toString('utf8')) as { name: string; base: string; contract: number };
      expect(m.name).toBe(f.path.split('/')[0]);
      expect(m.contract).toBe(1);
    }
  });

  it('writes them under builtin-themes/<id>/ in the build folder', () => {
    const out = mkdtempSync(join(tmpdir(), 'surau-bt-'));
    dirs.push(out);
    const plugin = builtinThemesPlugin(SRC) as unknown as { writeBundle: (o: { dir: string }) => void };
    plugin.writeBundle({ dir: out });
    expect(JSON.parse(readFileSync(join(out, 'builtin-themes', 'creative', 'theme.json'), 'utf8')).defaults).toEqual({ semua: { shade: 35 } });
    expect(readFileSync(join(out, 'builtin-themes', 'default', 'theme.css'), 'utf8')).toContain('MAXCOM kiosk theme');
  });
});
