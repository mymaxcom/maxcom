import { expect, it } from 'vitest';
import { effectiveShade, styleVars } from '../src/themes/styleVars.ts';

const url = (id: string) => `/assets/${id}`;
it('empty style gives nothing', () => { expect(styleVars({}, url)).toEqual({ vars: {}, attrs: {}, bgAssetId: null, packImageUrl: null }); });
it('the image controls', () => {
  const id = 'a'.repeat(64);
  expect(styleVars({ bgImage: id, bgFit: 'sederhana', bgPos: 'kiri', shade: 45 }, url)).toEqual({
    vars: { '--bg-image': `url("/assets/${id}")`, '--bg-fit': 'contain', '--bg-size': '70% auto', '--bg-pos': 'left center', '--shade': '0.45' },
    attrs: { 'data-bg': 'image' }, bgAssetId: id, packImageUrl: null });
  expect(styleVars({ bgImage: id, bgFit: 'kecil' }, url).vars['--bg-size']).toBe('45% auto');
  expect(styleVars({ bgImage: id, bgFit: 'regang' }, url).vars['--bg-size']).toBe('100% 100%');
  expect(styleVars({ bgImage: id, bgFit: 'penuh' }, url).vars['--bg-fit']).toBe('cover');
  expect(styleVars({ bgImage: id, bgPos: 'tengah' }, url).vars['--bg-pos']).toBe('center');
  expect(styleVars({ bgImage: id, bgPos: 'kanan' }, url).vars['--bg-pos']).toBe('right center');
});
it('a picture that is not available is left out, with its fit and position', () => {
  expect(styleVars({ bgImage: 'a'.repeat(64), bgFit: 'kecil', shade: 20 }, () => null)).toEqual({ vars: { '--shade': '0.2' }, attrs: {}, bgAssetId: null, packImageUrl: null });
});
it('colour, font, size, alignment', () => {
  const s = styleVars({ accent: '#2fd1b0', text: '#ffffff', font: 'amiri', scale: 'XL', align: 'kanan' }, url);
  expect(s.vars).toEqual({ '--accent': '#2fd1b0', '--accent-rgb': '47 209 176', '--text': '#ffffff', '--font': "'Amiri', serif", '--serif': "'Amiri', serif", '--scale': '1.3' });
  expect(s.attrs).toEqual({ 'data-align': 'right' });
  expect(styleVars({ font: 'jakarta' }, url).vars['--font']).toBe("'Plus Jakarta Sans', 'Segoe UI', system-ui, sans-serif");
  expect(styleVars({ font: 'siti-sans' }, url).vars['--font']).toBe("'mxf-siti-sans', 'Plus Jakarta Sans', sans-serif");
  expect(styleVars({ align: 'tengah' }, url).attrs['data-align']).toBe('center');
  expect(styleVars({ scale: 'S' }, url).vars['--scale']).toBe('1');
});
it('every value is written as itself: a built-in default is not mapped away', () => {
  const s = styleVars({ font: 'jakarta', scale: 'S', align: 'kiri' }, url);
  expect(s.vars['--font']).toContain('Plus Jakarta Sans');
  expect(s.vars['--scale']).toBe('1');
  expect(s.attrs['data-align']).toBe('left');
});
it('the layer darkness: saved, else theme default, else measured (default look) or 35; clamped on the default look', () => {
  expect(effectiveShade(60, 'creative', 0.5, true)).toBe(60);
  expect(effectiveShade(undefined, 'creative', 0.5, true)).toBe(35);
  expect(effectiveShade(undefined, 'default', 0.5, true)).toBe(50);
  expect(effectiveShade(5, 'default', 0.5, true)).toBe(25);
  expect(effectiveShade(5, 'default', 0.5, false)).toBe(5);
  expect(effectiveShade(5, 'minimal', 0.5, true)).toBe(5);
});
it('the Arabic controls', () => {
  const s = styleVars({ arFont: 'amiri-quran', arScale: 120, harakat: '#d9b25f', arLineHeight: 19, tarjamah: 'sisi' }, url);
  expect(s.vars).toEqual({ '--ar-scale': '1.2', '--harakat': '#d9b25f', '--ar-lh': '1.9' });
  expect(s.attrs).toEqual({ 'data-arfont': 'amiri-quran', 'data-tarjamah': 'beside' });
});
it('the gold outline switch puts data-gold on the stage', () => {
  expect(styleVars({ goldOutline: 'off' }, url).attrs).toEqual({ 'data-gold': 'off' });
  expect(styleVars({ goldOutline: 'on' }, url).attrs).toEqual({ 'data-gold': 'on' });
});
