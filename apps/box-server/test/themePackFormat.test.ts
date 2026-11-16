import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { writeStoredZip } from '../src/files/zipWrite.ts';
import { MAX_PACK_BYTES, packPathError, readPack, ThemeError } from '../src/themes/packFormat.ts';
import { buildZip } from './support/zipBuild.ts';

const zip = (files: Record<string, string | Buffer>): Buffer =>
  writeStoredZip(Object.entries(files).map(([name, d]) => ({ name, data: Buffer.isBuffer(d) ? d : Buffer.from(d) })));
const json = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'hijau-siti', title: 'Hijau Siti', version: 3, contract: 1, base: 'creative', defaults: {}, ...over });
const code = (b: Buffer): string => { try { readPack(b); return 'ok'; } catch (e) { return (e as ThemeError).issues[0]!.code; } };

describe('readPack', () => {
  it('reads the smallest valid pack', () => {
    const p = readPack(zip({ 'theme.json': json(), 'theme.css': '.stage{--accent:#0a0}' }));
    expect(p.manifest).toMatchObject({ name: 'hijau-siti', title: 'Hijau Siti', version: 3, contract: 1, base: 'creative' });
    expect([...p.css.keys()]).toEqual(['theme.css']);
    expect(p.fileCount).toBe(2);
  });

  it('accepts every fixed path and nothing else', () => {
    for (const ok of ['theme.json', 'theme.css', 'arabic.css', 'screens/poster.css', 'screens/arab-ayat.css', 'images/kuliah.jpg', 'images/semua.png']) expect(packPathError(ok), ok).toBeNull();
    for (const bad of ['theme.js', 'screens/setup.css', 'screens/poster.scss', 'images/kuliah.gif', 'images/../theme.css', 'fonts/A.woff2', 'fonts/x.ttf', 'a/b/c.css', 'THEME.CSS', 'screens/', 'index.html', '.htaccess', 'images/setup.png', 'images/semua.webp', 'fonts/naskh-siti.woff2', 'fonts/.woff2', `fonts/${'a'.repeat(33)}.woff2`]) expect(packPathError(bad), bad).not.toBeNull();
  });

  it('bounds', () => {
    expect(code(Buffer.alloc(MAX_PACK_BYTES + 1))).toBe('too_big');
    expect(code(Buffer.from('not a zip at all, definitely'))).toBe('not_zip');
    expect(code(Buffer.alloc(5))).toBe('not_zip');
    expect(code(zip(Object.fromEntries([['theme.json', json()], ['theme.css', ''], ...Array.from({ length: 59 }, (_, i) => [`fonts/f${i}.woff2`, 'x'])])))).toBe('too_many_files');
    expect(code(zip({ 'theme.json': json(), 'theme.css': '', 'evil.sh': 'x' }))).toBe('bad_path');
    expect(code(zip({ 'theme.json': json(), 'theme.css': '', 'images/kuliah.jpg': zip({ 'a.txt': 'x' }) }))).toBe('bad_path');
    expect(code(zip({ 'theme.css': '' }))).toBe('missing_file');
    expect(code(zip({ 'theme.json': json() }))).toBe('missing_file');
  });

  it('refuses names that climb, are absolute, or hold backslash tricks', () => {
    for (const name of ['../theme.css', 'images/../../x.css', '/etc/passwd', 'C:/x.css', 'images\\..\\..\\x.css', 'a\u0000b.css']) {
      const z = buildZip([{ name: 'theme.json', data: Buffer.from(json()) }, { name: 'theme.css', data: Buffer.from('') }, { name, data: Buffer.from('x'), method: 0 }]);
      expect(code(z), name).toBe('bad_path');
    }
  });

  it('refuses a name used twice', () => {
    const z = buildZip([{ name: 'theme.json', data: Buffer.from(json()) }, { name: 'theme.css', data: Buffer.from('') }, { name: 'theme.css', data: Buffer.from('b{}') }]);
    expect(code(z)).toBe('bad_path');
  });

  it('refuses a symlink entry', () => {
    const z = buildZip([{ name: 'theme.json', data: Buffer.from(json()) }, { name: 'theme.css', data: Buffer.from('/etc/passwd'), method: 0, unixMode: 0o120777 }]);
    expect(code(z)).toBe('bad_path');
    const ok = buildZip([{ name: 'theme.json', data: Buffer.from(json()) }, { name: 'theme.css', data: Buffer.from(''), method: 0, unixMode: 0o100644 }]);
    expect(code(ok)).toBe('ok');
  });

  it('a deflate entry that inflates past the cap is refused', () => {
    const big = Buffer.alloc(41 * 1024 * 1024);
    expect(deflateRawSync(big).length).toBeLessThan(MAX_PACK_BYTES);
    // honest sizes: the entry is above the per-entry cap
    expect(code(buildZip([{ name: 'theme.json', data: Buffer.from(json()) }, { name: 'theme.css', data: big }]))).toBe('too_big');
    // a lie: declares 100 bytes, really inflates far more
    expect(code(buildZip([{ name: 'theme.json', data: Buffer.from(json()) }, { name: 'theme.css', data: big, declaredSize: 100 }]))).toBe('too_big');
    // six 7 MB entries pass the entry cap but not the 40 MB total
    const seven = Buffer.alloc(7 * 1024 * 1024);
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({ name: `fonts/${n}.woff2`, data: seven }));
    expect(code(buildZip([{ name: 'theme.json', data: Buffer.from(json()) }, { name: 'theme.css', data: Buffer.from('') }, ...many]))).toBe('too_big');
  });

  it('theme.json rules', () => {
    for (const over of [{ name: 'Hijau' }, { name: '../x' }, { name: 5 }, { title: '' }, { title: 'a'.repeat(61) }, { title: '<b>x</b>' }, { title: 'a\nb' }, { version: 0 }, { version: 1.5 }, { version: 1000000 }, { version: '3' }, { contract: 0 }, { base: 'neon' }, { defaults: { semua: { shade: 99 } } }, { defaults: { oops: 1 } }, { defaults: { semua: { bgImage: 'a'.repeat(64) } } }, { defaults: { skrin: { kuliah: { bgImage: 'a'.repeat(64) } } } }, { defaults: { skrin: { setup: { shade: 1 } } } }, { defaults: 'x' }]) {
      expect(code(zip({ 'theme.json': json(over), 'theme.css': '' })), JSON.stringify(over)).toBe('bad_theme_json');
    }
    for (const name of ['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic']) expect(code(zip({ 'theme.json': json({ name }), 'theme.css': '' })), name).toBe('reserved_name');
    expect(code(zip({ 'theme.json': '{not json', 'theme.css': '' }))).toBe('bad_theme_json');
    expect(code(zip({ 'theme.json': '[1]', 'theme.css': '' }))).toBe('bad_theme_json');
    expect(code(zip({ 'theme.json': Buffer.from([0xff, 0xfe, 0x00]), 'theme.css': '' }))).toBe('bad_theme_json');
    expect(code(zip({ 'theme.json': ' '.repeat(65 * 1024) + json(), 'theme.css': '' }))).toBe('bad_theme_json');
  });

  it('unknown top-level keys are ignored and a BOM is tolerated', () => {
    const p = readPack(zip({ 'theme.json': '\uFEFF' + json({ extra: { a: 1 }, other: 1 }), 'theme.css': '' }));
    expect(p.manifest.name).toBe('hijau-siti');
    expect(Object.keys(p.manifest).sort()).toEqual(['base', 'contract', 'defaults', 'name', 'title', 'version']);
  });

  it('css files must be UTF-8 without NUL and not huge', () => {
    expect(code(zip({ 'theme.json': json(), 'theme.css': Buffer.from([0x61, 0xff, 0xfe]) }))).toBe('css_parse');
    expect(code(zip({ 'theme.json': json(), 'theme.css': 'a{}\u0000' }))).toBe('css_parse');
    expect(code(zip({ 'theme.json': json(), 'theme.css': 'a'.repeat(512 * 1024 + 1) }))).toBe('too_big');
  });

  it('two pictures for one screen are refused', () => {
    expect(code(zip({ 'theme.json': json(), 'theme.css': '', 'images/kuliah.jpg': 'x', 'images/kuliah.png': 'y' }))).toBe('bad_path');
  });

  it('a font is refused (v1: no fonts in a pack), with its own code and message', () => {
    expect(code(zip({ 'theme.json': json(), 'theme.css': '', 'fonts/naskh-siti.woff2': 'x' }))).toBe('bad_font');
    expect(code(zip({ 'theme.json': json(), 'theme.css': '', 'FONTS/a.woff2': 'x' }))).toBe('bad_font');
    expect(code(zip({ 'theme.json': json(), 'theme.css': '', 'fonts/a.ttf': 'x' }))).toBe('bad_font');
    const e = (b: Buffer): ThemeError => { try { readPack(b); } catch (x) { return x as ThemeError; } throw new Error('no error'); };
    expect(e(zip({ 'theme.json': json(), 'theme.css': '', 'fonts/a.woff2': 'x' })).issues[0]!.messageEn).toContain('Fonts are not allowed in a theme');
  });

  it('a WebP picture is refused (v1: PNG or JPEG only)', () => {
    expect(code(zip({ 'theme.json': json(), 'theme.css': '', 'images/kuliah.webp': 'x' }))).toBe('bad_image');
    expect(code(zip({ 'theme.json': json(), 'theme.css': '', 'images/semua.WEBP': 'x' }))).toBe('bad_image');
  });

  it('all css files together are held to 1 MB', () => {
    const half = 'a{}'.repeat(100_000); // about 300 KB each
    const ok = zip({ 'theme.json': json(), 'theme.css': half, 'screens/poster.css': half, 'screens/kuliah.css': half });
    expect(() => readPack(ok)).not.toThrow();
    const over = zip({ 'theme.json': json(), 'theme.css': half, 'screens/poster.css': half, 'screens/kuliah.css': half, 'screens/hadis.css': half });
    expect(code(over)).toBe('too_big');
  });

  it('Windows device names are reserved theme names, in any case', () => {
    const names = ['con', 'prn', 'aux', 'nul', 'CON', 'Nul', 'Aux', ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`), 'COM1', 'LPT9'];
    for (const name of names) {
      // isThemeName only takes lowercase, so an upper-case name stops at the name rule; either way it never gets in
      const c = code(zip({ 'theme.json': json({ name }), 'theme.css': '' }));
      expect(['reserved_name', 'bad_theme_json'], name).toContain(c);
      if (name === name.toLowerCase()) expect(c, name).toBe('reserved_name');
    }
    for (const name of ['com0', 'com10', 'lpt0', 'console', 'auxiliary', 'nul-a', 'my-con']) expect(code(zip({ 'theme.json': json({ name }), 'theme.css': '' })), name).not.toBe('reserved_name');
  });

  it('reads images and screen css into their maps', () => {
    const p = readPack(zip({ 'theme.json': json(), 'theme.css': 'a{}', 'arabic.css': 'b{}', 'screens/poster.css': 'c{}', 'images/kuliah.jpg': 'jpg', 'images/semua.png': 'p' }));
    expect([...p.css.keys()].sort()).toEqual(['arabic.css', 'screens/poster.css', 'theme.css']);
    expect(p.images.get('kuliah')?.ext).toBe('jpg');
    expect(p.images.get('semua')?.ext).toBe('png');
    expect(p.fileCount).toBe(6);
  });

  it('messages are the specified sentences', () => {
    const e = (b: Buffer): ThemeError => { try { readPack(b); } catch (x) { return x as ThemeError; } throw new Error('no error'); };
    expect(e(Buffer.alloc(MAX_PACK_BYTES + 1)).issues[0]).toMatchObject({ messageMs: 'Fail tema melebihi 15 MB.', messageEn: 'The theme file is larger than 15 MB.' });
    expect(e(Buffer.from('not a zip at all, definitely')).issues[0]!.messageMs).toBe('Fail ini bukan fail .maxtheme yang sah.');
    expect(e(zip({ 'theme.css': '' })).issues[0]!.messageMs).toBe('theme.json tiada dalam fail tema.');
    expect(e(zip({ 'theme.json': json({ name: 'minimal' }), 'theme.css': '' })).issues[0]!.messageEn).toBe('The theme name minimal is reserved for a built-in theme. Choose another name.');
    expect(e(zip({ 'theme.json': json(), 'theme.css': '', 'evil.sh': 'x' })).issues[0]!.messageMs).toBe('Fail tidak dibenarkan dalam tema: evil.sh.');
  });
});
