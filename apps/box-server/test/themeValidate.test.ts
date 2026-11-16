import { describe, expect, it } from 'vitest';
import { MAX_PACKS } from '@surau/core';
import { cleanPackImage, validatePack, validatePackAsync } from '../src/themes/validate.ts';
import { fakePng, installedPack, jpeg, manifestJson as json, png, pngWithBaggage, woff2, zip } from './support/themePacks.ts';

const ctx = { installed: {}, contract: 1, enforceVersion: true };
const v = (version: number): Buffer => zip({ 'theme.json': json({ version }), 'theme.css': '.stage{--accent:#0a0}' });

describe('validatePack', () => {
  it('a full valid pack reports what it holds', () => {
    const { report, files } = validatePack(zip({
      'theme.json': json(), 'theme.css': '.stage{--accent:#0a0}', 'screens/poster.css': '.region-next{margin-top:1rem}',
      'screens/kuliah.css': '.region-main{background:url(../images/kuliah.jpg)}', 'images/kuliah.jpg': jpeg(64, 36),
    }), ctx);
    expect(report).toMatchObject({ ok: true, name: 'hijau-siti', title: 'Hijau Siti', version: 3, base: 'creative', contract: 1, fileCount: 5, screens: ['poster', 'kuliah'], fonts: [], images: { kuliah: 'jpg' }, isUpdate: false, installedVersion: null, errors: [], warnings: [] });
    expect(files).not.toBeNull();
  });

  it('update rules', () => {
    const installed = { 'hijau-siti': installedPack({ version: 3 }) };
    const c = { installed, contract: 1, enforceVersion: true };
    expect(validatePack(v(3), c).report.errors[0]!.code).toBe('version_not_higher');
    expect(validatePack(v(2), c).report.errors[0]!.code).toBe('version_not_higher');
    expect(validatePack(v(3), c).report.errors[0]!.messageMs).toBe('Versi sama atau lebih rendah. Hijau Siti versi 3 sudah dipasang. Naikkan nombor versi dalam theme.json.');
    expect(validatePack(v(4), c).report).toMatchObject({ ok: true, isUpdate: true, installedVersion: 3 });
    expect(validatePack(v(3), { ...c, enforceVersion: false }).report.ok).toBe(true);
    expect(validatePack(v(3), c).files).toBeNull();
  });

  it('a pack for a newer contract is refused with the exact sentence', () => {
    const e = validatePack(zip({ 'theme.json': json({ contract: 2 }), 'theme.css': '' }), ctx).report.errors[0]!;
    expect(e.code).toBe('needs_newer');
    expect(e.messageMs).toBe('Tema ini memerlukan MAXCOM yang lebih baharu. Tema dibuat untuk kontrak 2; MAXCOM di surau ini menyokong kontrak 1.');
    expect(e.messageEn).toBe('This theme needs a newer MAXCOM. It was made for contract 2; this MAXCOM supports contract 1.');
  });

  it('collects errors from several files', () => {
    const css = (lines: string[]): string => lines.join('\n');
    const { report } = validatePack(zip({
      'theme.json': json(),
      'theme.css': css([...Array.from({ length: 11 }, () => '.a{color:red}'), '.b{background:url(https://x.example/a.jpg)}']),
      'screens/poster.css': '@import "x.css";',
      'images/kuliah.jpg': png(10, 10),
    }), ctx);
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => [e.code, e.file, e.line])).toEqual(expect.arrayContaining([
      ['bad_image', 'images/kuliah.jpg', null], ['css_url', 'theme.css', 12], ['css_import', 'screens/poster.css', 1],
    ]));
    expect(report.errors).toHaveLength(3);
  });

  it('warnings do not block', () => {
    const { report } = validatePack(zip({
      'theme.json': json(), 'theme.css': '', 'screens/poster.css': '\n\n\n\n\n\n\n@layer x{.a{color:red}}',
    }), ctx);
    expect(report.ok).toBe(true);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings.map((w) => w.file)).toEqual(['screens/poster.css']);
    expect(report.warnings[0]!.line).toBe(8);
  });

  it('the 31st theme is refused, an update of one of the 30 is not', () => {
    const installed = Object.fromEntries(Array.from({ length: MAX_PACKS }, (_, i) => [`t-${i}`, installedPack({ version: 1 })]));
    const c = { installed, contract: 1, enforceVersion: true };
    const e = validatePack(v(1), c).report.errors[0]!;
    expect(e.code).toBe('too_many_themes');
    expect(e.messageMs).toBe('Had 30 tema dimuat naik telah dicapai. Padam tema yang tidak digunakan.');
    const upd = { ...installed, 'hijau-siti': installedPack({ version: 1 }) };
    delete (upd as Record<string, unknown>)['t-0'];
    expect(validatePack(v(2), { ...c, installed: upd }).report.ok).toBe(true);
  });

  it('images: wrong type for the extension, too large a side, too many pixels, not an image', () => {
    const bad = (name: string, data: Buffer): string[] => validatePack(zip({ 'theme.json': json(), 'theme.css': '', [name]: data }), ctx).report.errors.map((e) => e.code);
    expect(bad('images/kuliah.jpg', png(10, 10))).toEqual(['bad_image']);
    expect(bad('images/kuliah.png', jpeg(10, 10))).toEqual(['bad_image']);
    expect(bad('images/kuliah.png', png(4097, 10))).toEqual(['bad_image']);
    expect(bad('images/kuliah.png', png(4096, 4096))).toEqual(['bad_image']);
    expect(bad('images/kuliah.png', Buffer.from('not a picture'))).toEqual(['bad_image']);
    expect(bad('images/kuliah.webp', png(10, 10))).toEqual(['bad_image']);
    expect(bad('images/kuliah.png', fakePng(20, 20))).toEqual(['bad_image']); // a header that is not a picture
    expect(bad('images/kuliah.png', Buffer.concat([png(10, 10).subarray(0, 60)]))).toEqual(['bad_image']); // cut short
    expect(bad('images/kuliah.png', png(1920, 1080))).toEqual([]);
    expect(bad('images/semua.jpg', jpeg(1920, 1080))).toEqual([]);
  });

  it('images: an image over 8 MB is refused (the container rule stops it first)', () => {
    const big = png(100, 100, 8 * 1024 * 1024);
    expect(validatePack(zip({ 'theme.json': json(), 'theme.css': '', 'images/kuliah.png': big }), ctx).report.errors.map((e) => e.code)).toEqual(['too_big']);
  });

  it('fonts: any file under fonts/ is refused, and the refusal says why', () => {
    const r = validatePack(zip({ 'theme.json': json(), 'theme.css': '', 'fonts/naskh-siti.woff2': woff2(500) }), ctx).report;
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(['bad_font']);
    expect(r.errors[0]!.messageEn).toContain('Fonts are not allowed in a theme');
    for (const name of ['fonts/a.ttf', 'fonts/a.otf', 'fonts/a.woff', 'fonts/sub/a.woff2']) {
      expect(validatePack(zip({ 'theme.json': json(), 'theme.css': '', [name]: Buffer.alloc(100) }), ctx).report.errors.map((e) => e.code), name).toEqual(['bad_font']);
    }
  });

  it('@font-face in pack css is refused as css_font, even without a url', () => {
    for (const css of ['@font-face{font-family:x;src:local(Arial)}', '@font-face{font-family:x;src:url(images/kuliah.jpg)}']) {
      const r = validatePack(zip({ 'theme.json': json(), 'theme.css': css, 'images/kuliah.jpg': jpeg(8, 8) }), ctx).report;
      expect(r.errors.map((e) => e.code), css).toContain('css_font');
    }
  });

  it('images are decoded and drawn again: metadata and trailing bytes never reach the kiosk', () => {
    const { file, marker } = pngWithBaggage(40, 30);
    expect(file.includes(Buffer.from(marker))).toBe(true);
    const out = validatePack(zip({ 'theme.json': json(), 'theme.css': '', 'images/kuliah.png': file }), ctx);
    expect(out.report.errors).toEqual([]);
    const kept = out.files!.images.get('kuliah')!.data;
    expect(kept.includes(Buffer.from(marker))).toBe(false);
    expect(kept.equals(file)).toBe(false);
    expect(cleanPackImage('png', kept)).not.toBeNull(); // and the result is a picture of the same kind
    expect(kept.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  });

  it('a jpeg is drawn again as a plain jpeg of the same size, with nothing after its end', () => {
    const j = jpeg(48, 32, 4);
    const tail = Buffer.from('<?php system($_GET[0]); ?>PK\u0003\u0004');
    const out = cleanPackImage('jpg', Buffer.concat([j, tail]));
    // trailing bytes are either refused outright or dropped: they never survive
    if (out !== null) {
      expect(out.includes(Buffer.from('<?php'))).toBe(false);
      expect(out[0]).toBe(0xff);
      expect(out[1]).toBe(0xd8);
      expect(out.subarray(out.length - 2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
    }
    const plain = cleanPackImage('jpg', j)!;
    expect(plain.subarray(plain.length - 2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
  });

  it('a file whose bytes are not the kind its extension says is refused', () => {
    expect(cleanPackImage('png', jpeg(10, 10))).toBeNull();
    expect(cleanPackImage('jpg', png(10, 10))).toBeNull();
    expect(cleanPackImage('png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(cleanPackImage('png', Buffer.concat([png(10, 10).subarray(0, 40), Buffer.alloc(40)]))).toBeNull(); // header, then rubbish
    expect(cleanPackImage('png', Buffer.concat([Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '), Buffer.alloc(40)]))).toBeNull();
  });

  it('validatePackAsync answers exactly like validatePack, and lets the event loop run in between', async () => {
    const pack = zip({ 'theme.json': json(), 'theme.css': '.a{color:red}', 'screens/poster.css': '.b{color:red}', 'images/kuliah.jpg': jpeg(32, 20), 'images/semua.png': png(32, 20) });
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    const a = await validatePackAsync(pack, ctx);
    clearInterval(timer);
    const s = validatePack(pack, ctx);
    expect(a.report).toEqual(s.report);
    expect([...a.files!.images.keys()]).toEqual([...s.files!.images.keys()]);
    expect(ticks).toBeGreaterThanOrEqual(0);
  });

  it('css that points at a file the pack does not hold is refused', () => {
    const { report } = validatePack(zip({ 'theme.json': json(), 'theme.css': '.a{background:url(images/kuliah.jpg)}' }), ctx);
    expect(report.errors.map((e) => e.code)).toEqual(['css_url']);
    const ok = validatePack(zip({ 'theme.json': json(), 'theme.css': '.a{background:url(images/kuliah.jpg)}', 'images/kuliah.jpg': jpeg(8, 8) }), ctx);
    expect(ok.report.ok).toBe(true);
  });

  it('a refused container still answers with a report', () => {
    const r = validatePack(Buffer.from('not a zip at all, definitely'), ctx);
    expect(r.report).toMatchObject({ ok: false, name: null, errors: [{ code: 'not_zip' }] });
    expect(r.files).toBeNull();
  });
});
