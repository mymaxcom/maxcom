import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { KIOSK_TEMPLATE_IDS } from '@surau/core';

/** `<id>/theme.json` and `<id>/theme.css` of every built-in theme, read from the kiosk sources. */
export function builtinThemeFiles(srcDir: string): Array<{ path: string; data: Buffer }> {
  const out: Array<{ path: string; data: Buffer }> = [];
  for (const id of KIOSK_TEMPLATE_IDS) {
    for (const file of ['theme.json', 'theme.css']) out.push({ path: `${id}/${file}`, data: readFileSync(join(srcDir, id, file)) });
  }
  return out;
}

/**
 * Copies the built-in themes' theme.json and theme.css to `dist/builtin-themes/<id>/`. The box server reads the
 * defaults from there when it builds a starting pack for download. The service worker does not precache them.
 */
export function builtinThemesPlugin(srcDir: string): Plugin {
  return {
    name: 'surau-builtin-themes',
    apply: 'build',
    writeBundle(options) {
      const dir = options.dir;
      if (!dir) return;
      for (const f of builtinThemeFiles(srcDir)) {
        const target = join(dir, 'builtin-themes', f.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, f.data);
      }
    },
  };
}
