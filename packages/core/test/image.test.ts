import { describe, expect, it } from 'vitest';
import { validateContent } from '../src/content/schema.ts';
import { validateFeatureSettings, resolveSettings } from '../src/features/settings.ts';
import { IMAGE_SLOTS, imageAssetId, isAdjustedImage, validateImageRef } from '../src/image.ts';

const A = 'a'.repeat(64);
const check = (v: unknown, slot: Parameters<typeof validateImageRef>[3] = 'poster') => {
  const errors: string[] = [];
  const value = validateImageRef('img', v, errors, slot);
  return { value, errors };
};

describe('validateImageRef', () => {
  it('accepts the legacy plain asset id (no adjustment)', () => {
    const r = check(A);
    expect(r.errors).toEqual([]);
    expect(r.value).toBe(A);
    expect(isAdjustedImage(A)).toBe(false);
    expect(imageAssetId(A)).toBe(A);
  });

  it('accepts an object with only the asset, or with every adjustment', () => {
    expect(check({ asset: A }).errors).toEqual([]);
    const full = { asset: A, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, bg: 'remove', rotate: 90 };
    const r = check(full);
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual(full);
    expect(isAdjustedImage(r.value!)).toBe(true);
    expect(imageAssetId(r.value!)).toBe(A);
  });

  it('refuses a bad asset id, text that is not an id, and non-objects', () => {
    for (const bad of ['', 'xyz', 'A'.repeat(64), 5, null, [], true]) expect(check(bad).errors.length, String(bad)).toBeGreaterThan(0);
    expect(check({ asset: 'nope' }).errors.length).toBeGreaterThan(0);
    expect(check({}).errors.length).toBeGreaterThan(0);
  });

  it('refuses unknown keys (also inside a rect)', () => {
    expect(check({ asset: A, extra: 1 }).errors.join()).toMatch(/extra/);
    expect(check({ asset: A, crop: { x: 0, y: 0, w: 1, h: 1, z: 1 } }).errors.join()).toMatch(/z/);
  });

  it('refuses a crop that is out of range, empty, not finite or not numbers', () => {
    const bad = [
      { x: -0.1, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: 0, h: 0.5 },
      { x: 0, y: 0, w: 0.5, h: -1 },
      { x: 0.6, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.7, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: 1e9, h: 1e9 },
      { x: 0, y: 0, w: 0.001, h: 0.5 },
      { x: Number.NaN, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: Infinity, h: 0.5 },
      { x: '0', y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: 0.5 },
      [0, 0, 1, 1],
    ];
    for (const crop of bad) expect(check({ asset: A, crop }).errors.length, JSON.stringify(crop)).toBeGreaterThan(0);
    expect(check({ asset: A, crop: { x: 0, y: 0, w: 1, h: 1 } }).errors).toEqual([]);
    expect(check({ asset: A, crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } }).errors).toEqual([]);
  });

  it('checks bg and rotate values', () => {
    for (const bg of ['keep', 'remove', 'card']) expect(check({ asset: A, bg }).errors).toEqual([]);
    expect(check({ asset: A, bg: 'blue' }).errors.length).toBeGreaterThan(0);
    for (const rotate of [0, 90, 180, 270]) expect(check({ asset: A, rotate }).errors).toEqual([]);
    for (const rotate of [45, '90', 360, -90]) expect(check({ asset: A, rotate }).errors.length).toBeGreaterThan(0);
  });

  it('allows `square` for the logo only', () => {
    const sq = { x: 0.1, y: 0, w: 0.5, h: 0.5 };
    expect(check({ asset: A, square: sq }, 'logo').errors).toEqual([]);
    expect(check({ asset: A, square: sq }, 'poster').errors.join()).toMatch(/square/);
    expect(check({ asset: A, square: { x: 0, y: 0, w: 2, h: 1 } }, 'logo').errors.length).toBeGreaterThan(0);
  });

  it('exports one slot table with the shapes app and kiosk share', () => {
    expect(IMAGE_SLOTS.logo.aspect).toBe('free');
    expect(IMAGE_SLOTS.logoSquare.aspect).toBe(1);
    expect(IMAGE_SLOTS.poster.aspect).toBeCloseTo(16 / 9);
    expect(IMAGE_SLOTS.poster.fit).toBe('contain');
    expect(IMAGE_SLOTS.penceramah.aspect).toBe(1);
    expect(IMAGE_SLOTS.penceramah.mask).toBe('circle');
    expect(IMAGE_SLOTS.kitab.aspect).toBeCloseTo(2 / 3);
    for (const s of Object.values(IMAGE_SLOTS)) {
      expect(s.maxW).toBeGreaterThan(0);
      expect(s.maxW).toBeLessThanOrEqual(4096);
      expect(s.maxH).toBeLessThanOrEqual(4096);
    }
  });
});

describe('image refs in content items', () => {
  const adjusted = { asset: A, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } };
  it('a legacy asset id string still validates on every image field', () => {
    expect(validateContent('poster', { title: 'P', assetId: A, days: ['umum'], order: 1 }).ok).toBe(true);
    expect(validateContent('penceramah', { name: 'N', photoAssetId: A }).ok).toBe(true);
    expect(validateContent('kitab', { title: 'K', coverAssetId: A }).ok).toBe(true);
    expect(validateContent('petugas', { name: 'N', photoAssetId: A }).ok).toBe(true);
    expect(validateContent('takwim', { date: '2026-01-01', title: 'T', assetId: A }).ok).toBe(true);
  });
  it('an ImageRef object validates; a bad one is refused with the field name', () => {
    const ok = validateContent('poster', { title: 'P', assetId: adjusted, days: ['umum'], order: 1 });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect((ok.value as { assetId: unknown }).assetId).toEqual(adjusted);
    const bad = validateContent('penceramah', { name: 'N', photoAssetId: { asset: A, crop: { x: 0, y: 0, w: 9, h: 9 } } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join()).toMatch(/photoAssetId/);
  });
});

describe('surauInfo logo and showName', () => {
  it('showName defaults to true and takes a boolean only', () => {
    expect(resolveSettings({}).surauInfo.showName).toBe(true);
    expect(validateFeatureSettings('surauInfo', { showName: false }).ok).toBe(true);
    expect(validateFeatureSettings('surauInfo', { showName: 'no' }).ok).toBe(false);
  });
  it('logo accepts empty, a legacy id, or an ImageRef (with square); refuses the rest', () => {
    for (const logo of ['', A, { asset: A }, { asset: A, bg: 'card', square: { x: 0, y: 0, w: 0.5, h: 0.5 } }]) {
      expect(validateFeatureSettings('surauInfo', { logo }).ok, JSON.stringify(logo)).toBe(true);
    }
    for (const logo of ['abc', { asset: 'x' }, { asset: A, crop: { x: 0, y: 0, w: 5, h: 5 } }, 5, []]) {
      expect(validateFeatureSettings('surauInfo', { logo }).ok, JSON.stringify(logo)).toBe(false);
    }
  });
  it('a stored object logo survives resolveSettings; a damaged one falls back to the default', () => {
    const ref = { asset: A, bg: 'remove' as const };
    expect(resolveSettings({ surauInfo: { logo: ref } as never }).surauInfo.logo).toEqual(ref);
    expect(resolveSettings({ surauInfo: { logo: { asset: 'bad' } } as never }).surauInfo.logo).toBe('');
  });
});
