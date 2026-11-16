import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { GOLD_OUTLINE_THEMES, KIOSK_TEMPLATE_IDS, THEME_TITLES } from '@surau/core';
import { BUILT_IN_THEMES, resolveTheme } from '../src/themes/index.ts';
import { srcDir } from './themeCss.ts';
const file = (id: string, name: string) => resolve(srcDir(), 'themes', id, name);
it('every built-in is a pack: theme.json and theme.css', () => {
  for (const id of KIOSK_TEMPLATE_IDS) {
    expect(existsSync(file(id, 'theme.css')), id).toBe(true);
    expect(BUILT_IN_THEMES[id]).toEqual({ name: id, title: THEME_TITLES[id], version: 1, contract: 1, base: id, defaults: { semua: { ...(id === 'arabic' ? { arFont: 'hafs' } : { shade: id === 'default' ? 55 : 35 }), ...(GOLD_OUTLINE_THEMES as readonly string[]).includes(id) ? { goldOutline: 'on' } : {} } } });
  }
});
it('a theme file styles only its own template', () => {
  for (const id of KIOSK_TEMPLATE_IDS) {
    const css = readFileSync(file(id, 'theme.css'), 'utf8');
    const others = [...css.matchAll(/data-template='([a-z]+)'/g)].map((m) => m[1]).filter((x) => x !== id);
    expect(others, id).toEqual([]);
  }
});
it('the reduced-motion rules moved with their template and stayed inside the media query', () => {
  const total = KIOSK_TEMPLATE_IDS.map((id) => readFileSync(file(id, 'theme.css'), 'utf8'))
    .map((css) => (css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) ?? []).join('').match(/data-template='/g)?.length ?? 0)
    .reduce((a, b) => a + b, 0);
  expect(total).toBe(4); // today's block holds one selector each for oldschool, minimal, colourful, creative
});
it('templates.css is the six imports, in order', () => {
  const css = readFileSync(resolve(srcDir(), 'templates.css'), 'utf8');
  const imports = [...css.matchAll(/@import '\.\/themes\/([a-z]+)\/theme\.css';/g)].map((m) => m[1]);
  expect(imports).toEqual(['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic']);
  expect(css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import '[^']+';/g, '').trim()).toBe('');
});
it('the sixth built-in is Arabic Art', () => {
  expect(KIOSK_TEMPLATE_IDS).toEqual(['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic']);
  expect(THEME_TITLES.arabic).toBe('Arabic Art');
  expect(resolveTheme({ kioskTemplate: { enabled: true, templateId: 'arabic' } } as never)).toMatchObject({ name: 'arabic', base: 'arabic', builtIn: true });
});
it('resolveTheme: built-in ids resolve to themselves, anything else to default', () => {
  const builtIn = (id: string) => ({ name: id, base: id, builtIn: true, pack: null, cssUrl: null });
  expect(resolveTheme({ kioskTemplate: { enabled: true, templateId: 'creative' } } as never)).toEqual(builtIn('creative'));
  expect(resolveTheme({ kioskTemplate: { enabled: true, templateId: 'neon' } } as never)).toEqual(builtIn('default'));
  expect(resolveTheme(null)).toEqual(builtIn('default'));
  expect(resolveTheme({ kioskTemplate: { enabled: false, templateId: 'creative' } } as never)).toEqual(builtIn('default'));
});

const packs = { 'hijau-siti': { assetId: 'a'.repeat(64), version: 3, title: 'Hijau Siti', base: 'creative', contract: 1, bytes: 1, fonts: [], screens: [], images: { kuliah: 'jpg' }, defaults: { semua: { accent: '#0a8f4e' } } } };
const withTheme = (name: string, p: unknown) => ({ kioskTemplate: { enabled: true, templateId: name }, themeStyle: { styles: {}, packs: p } }) as never;
it('resolveTheme: installed pack, newer contract, unknown name', () => {
  expect(resolveTheme(withTheme('hijau-siti', packs))).toMatchObject({ name: 'hijau-siti', base: 'creative', builtIn: false, cssUrl: '/themes/hijau-siti/aaaaaaaaaaaaaaaa-2/bundle.css' });
  expect(resolveTheme(withTheme('hijau-siti', { 'hijau-siti': { ...packs['hijau-siti'], contract: 2 } }))).toMatchObject({ name: 'default', builtIn: true, pack: null, cssUrl: null });
  expect(resolveTheme(withTheme('tiada', packs))).toMatchObject({ name: 'default', base: 'default', builtIn: true, pack: null, cssUrl: null });
  // a damaged record is the same as none; a name that is not a theme name is never looked up
  expect(resolveTheme(withTheme('hijau-siti', { 'hijau-siti': { version: 0 } }))).toMatchObject({ name: 'default' });
  expect(resolveTheme(withTheme('__proto__', packs))).toMatchObject({ name: 'default' });
  expect(resolveTheme({ kioskTemplate: { enabled: true, templateId: 'hijau-siti' } } as never)).toMatchObject({ name: 'default' });
});
