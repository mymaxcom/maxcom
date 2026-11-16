import { expect, it } from 'vitest';
import { THEME_STYLE_MAX_BYTES, resolveScreenStyle, sanitizeThemeStyles, styleValueError, themeStylesError, packsError, sanitizePacks, themeOfferable } from '../src/index.ts';

it('accepts every control value of the table and refuses its neighbours', () => {
  const ok: [string, unknown][] = [['bgImage', 'a'.repeat(64)], ['bgFit', 'sederhana'], ['bgPos', 'kanan'], ['shade', 0], ['shade', 80], ['accent', '#2fd1b0'], ['text', '#FFFFFF'], ['font', 'jakarta'], ['scale', 'XL'], ['align', 'tengah'], ['arFont', 'amiri-quran'], ['arScale', 100], ['arScale', 160], ['harakat', '#d9b25f'], ['arLineHeight', 19], ['tarjamah', 'sembunyi']];
  for (const [k, v] of ok) expect(styleValueError(k, v), `${k}=${String(v)}`).toBeNull();
  const bad: [string, unknown][] = [['bgImage', 'http://x/a.jpg'], ['bgImage', '../a'], ['bgFit', 'cover'], ['shade', 81], ['shade', -1], ['shade', 20.5], ['accent', 'red'], ['accent', '#fff'], ['font', 'Comic Sans'], ['scale', 'XS'], ['scale', 0.8], ['align', 'left'], ['arScale', 90], ['arLineHeight', 30], ['tarjamah', 'hidden'], ['nope', 1]];
  for (const [k, v] of bad) expect(styleValueError(k, v), `${k}=${String(v)}`).not.toBeNull();
});
it('write check: shape, names, values, 32 KB', () => {
  expect(themeStylesError({})).toBeNull();
  expect(themeStylesError({ creative: { semua: { shade: 20 }, skrin: { kuliah: { align: 'kanan' } } } })).toBeNull();
  expect(themeStylesError({ creative: { semua: { shade: 99 }, skrin: {} } })).toMatch(/shade/);
  expect(themeStylesError({ 'Bad Name': { semua: {}, skrin: {} } })).not.toBeNull();
  expect(themeStylesError([])).not.toBeNull();
  const big = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`t${i}`, { semua: { accent: '#123456', bgImage: 'a'.repeat(64) }, skrin: {} }]));
  expect(JSON.stringify(big).length).toBeGreaterThan(THEME_STYLE_MAX_BYTES);
  expect(themeStylesError(big)).toMatch(/32 KB/);
});
it('read side drops what it does not know and keeps the rest', () => {
  expect(sanitizeThemeStyles({ creative: { semua: { shade: 20, future: 1, accent: 5 }, skrin: { kuliah: { scale: 'L' }, 'no-such-screen': { scale: 'L' } }, extra: 1 }, 'BAD': {}, x: 7 }))
    .toEqual({ creative: { semua: { shade: 20 }, skrin: { kuliah: { scale: 'L' } } } });
  expect(sanitizeThemeStyles(null)).toEqual({});
  expect(sanitizeThemeStyles({ __proto__: { semua: {} } })).toEqual({});
});
it('layers: defaults, then all screens, then one screen', () => {
  const styles = { creative: { semua: { accent: '#111111', shade: 10 }, skrin: { kuliah: { shade: 40 } } } };
  const defaults = { semua: { accent: '#999999', scale: 'M' as const }, skrin: { kuliah: { align: 'kanan' as const } } };
  expect(resolveScreenStyle(styles, 'creative', 'kuliah', defaults)).toEqual({ accent: '#111111', scale: 'M', align: 'kanan', shade: 40 });
  expect(resolveScreenStyle(styles, 'creative', 'hadis', defaults)).toEqual({ accent: '#111111', scale: 'M', shade: 10 });
  expect(resolveScreenStyle(styles, 'minimal', 'kuliah')).toEqual({});
});
const pack = () => ({ assetId: 'b'.repeat(64), version: 1, title: 'Hijau Siti', base: 'creative', contract: 1, bytes: 1000, fonts: ['siti-sans'], screens: ['kuliah'], images: { kuliah: 'jpg' }, defaults: { semua: { accent: '#112233' }, skrin: {} } });
it('packs: valid record passes, bad ones are refused and dropped on read', () => {
  expect(packsError({})).toBeNull();
  expect(packsError({ 'hijau-siti': pack() })).toBeNull();
  expect(packsError({ default: pack() })).not.toBeNull();
  expect(packsError({ 'x-y': { ...pack(), title: '<b>' } })).not.toBeNull();
  expect(packsError({ 'x-y': { ...pack(), base: 'nope' } })).not.toBeNull();
  expect(packsError({ 'x-y': { ...pack(), defaults: { semua: { bgImage: 'a'.repeat(64) }, skrin: {} } } })).not.toBeNull();
  expect(packsError({ 'x-y': { ...pack(), images: { zzz: 'jpg' } } })).not.toBeNull();
  expect(Object.keys(sanitizePacks({ 'hijau-siti': pack(), bad: { version: 0 } }))).toEqual(['hijau-siti']);
});

it('write check refuses unknown keys and unknown screens, naming them', () => {
  expect(themeStylesError({ creative: { semua: { shade: 20, future: 1 }, skrin: {} } })).toMatch(/semua\.future/);
  expect(themeStylesError({ creative: { semua: {}, skrin: { 'no-such-screen': { shade: 20 } } } })).toMatch(/no-such-screen/);
  expect(themeStylesError({ creative: { semua: {}, skrin: {}, extra: 1 } })).toMatch(/creative\.extra/);
  expect(themeStylesError({ creative: { semua: {}, skrin: { kuliah: { scale: 'L', wat: 2 } } } })).toMatch(/kuliah\.wat/);
  expect(themeStylesError({ creative: { semua: { shade: 20 } } })).toBeNull();
});
it('packs: a removal marker is accepted on write and never shown on read', () => {
  expect(packsError({ 'hijau-siti': { removed: true } })).toBeNull();
  expect(packsError({ 'hijau-siti': { removed: false } })).not.toBeNull();
  expect(packsError({ 'hijau-siti': { removed: true, version: 1 } })).not.toBeNull();
  expect(packsError({ creative: { removed: true } })).not.toBeNull();
  expect(sanitizePacks({ 'hijau-siti': { removed: true }, 'x-y': pack() })).toEqual({ 'x-y': pack() });
});
it('packs: unknown keys and screens refused, screens bounded, total 64 KB', () => {
  expect(packsError({ 'x-y': { ...pack(), extra: 1 } })).toMatch(/x-y\.extra/);
  expect(packsError({ 'x-y': { ...pack(), screens: ['kuliah', 'kuliah'] } })).toMatch(/screens/);
  expect(packsError({ 'x-y': { ...pack(), screens: ['nope'] } })).toMatch(/screens/);
  expect(packsError({ 'x-y': { ...pack(), defaults: { semua: { wat: 1 }, skrin: {} } } })).toMatch(/defaults\.semua\.wat/);
  expect(packsError({ 'x-y': { ...pack(), defaults: { semua: {}, skrin: { nope: {} } } } })).toMatch(/nope/);
  const big = { ...pack(), title: 'x', images: Object.fromEntries(['semua', 'kuliah', 'hadis'].map((k) => [k, 'jpg'])) };
  expect(packsError({ 'x-y': big })).toBeNull();
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p-${i}`, { ...pack(), fonts: Array.from({ length: 10 }, (_, f) => `font-number-${f}-aaaaaaaaaaaaaaaaaaaaaaaa`), defaults: { semua: {}, skrin: Object.fromEntries(['kuliah', 'hadis', 'azan', 'biasa', 'iqamah', 'solat', 'jumaat', 'poster', 'program', 'zikir', 'tilawah', 'takwim', 'tabung', 'ayat', 'live'].map((id) => [id, { accent: '#112233', bgFit: 'penuh', bgPos: 'kiri', shade: 20, text: '#ffffff', font: 'jakarta', scale: 'XL', align: 'kanan' }])) } }]));
  expect(JSON.stringify(many).length).toBeGreaterThan(64 * 1024);
  expect(packsError(many)).toMatch(/64 KB/);
});

it('themeOfferable: only when the list is complete and every box has the contract (and the built-in theme)', () => {
  const b = (c: number | null, bi: string[] = ['default']) => ({ contract: c, builtIn: bi });
  expect(themeOfferable({ boxes: [b(1), b(1)], complete: true }, { contract: 1 })).toBe(true);
  expect(themeOfferable({ boxes: [b(1), b(null)], complete: true }, { contract: 1 })).toBe(false);
  expect(themeOfferable({ boxes: [b(1)], complete: false }, { contract: 1 })).toBe(false);
  expect(themeOfferable({ boxes: [b(1, ['default', 'arabic']), b(1)], complete: true }, { contract: 1, builtIn: 'arabic' })).toBe(false);
  expect(themeOfferable({ boxes: [b(1, ['default', 'arabic']), b(2, ['default', 'arabic'])], complete: true }, { contract: 1, builtIn: 'arabic' })).toBe(true);
  expect(themeOfferable({ boxes: [b(1)], complete: true }, { contract: 2 })).toBe(false);
  expect(themeOfferable({ boxes: [], complete: true }, { contract: 1 })).toBe(true);
});
