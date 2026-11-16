import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The kiosk's `src` folder, whether vitest runs from the repo root or from apps/kiosk-display. */
export function srcDir(): string {
  const hit = ['src', 'apps/kiosk-display/src'].map((p) => resolve(process.cwd(), p)).find(existsSync);
  if (!hit) throw new Error(`src not found from ${process.cwd()}`);
  return hit;
}

/** The four non-default built-in theme stylesheets, joined in the order templates.css imports them. */
export function themesCss(): string {
  return ['colourful', 'creative', 'oldschool', 'minimal', 'arabic']
    .map((id) => readFileSync(resolve(srcDir(), `themes/${id}/theme.css`), 'utf8'))
    .join('\n');
}

/** One built-in theme's stylesheet. */
export function themeCss(id: string): string {
  return readFileSync(resolve(srcDir(), `themes/${id}/theme.css`), 'utf8');
}
