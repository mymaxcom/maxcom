import { describe, expect, it } from 'vitest';
import { autoTone, contrastRatio, relativeLuminance } from '../src/tone.ts';

describe('contrastRatio', () => {
  it('returns the WCAG 2.1 contrast ratio', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 0);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });

  it('returns 1 for identical colours', () => {
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBe(1);
  });

  it('accepts 3-digit hex', () => {
    expect(relativeLuminance('#fff')).toBe(1);
    expect(relativeLuminance('#000')).toBe(0);
  });
});

describe('autoTone', () => {
  it('picks a darker shade alpha for bright images', () => {
    const bright = autoTone({ meanLuma: 0.7, palette: ['#c8b89a', '#4a6b5d', '#e0a040'] });
    const dark = autoTone({ meanLuma: 0.05, palette: ['#101820', '#ffb766'] });
    expect(bright.shadeAlpha).toBeGreaterThan(dark.shadeAlpha);
  });

  it('ensures white text contrasts with glass', () => {
    const bright = autoTone({ meanLuma: 0.7, palette: ['#c8b89a', '#4a6b5d', '#e0a040'] });
    const dark = autoTone({ meanLuma: 0.05, palette: ['#101820', '#ffb766'] });
    for (const t of [bright, dark]) {
      expect(contrastRatio(t.text, t.glass)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('falls back when palette is empty', () => {
    const tone = autoTone({ meanLuma: 0.5, palette: [] });
    expect(tone.glass).toBe('#06302b');
    expect(tone.accent).toBe('#f0c97a');
  });

  it('falls back when palette has only invalid entries', () => {
    const tone = autoTone({ meanLuma: 0.5, palette: ['not-a-color', '#gggggg'] });
    expect(tone.glass).toBe('#06302b');
    expect(tone.accent).toBe('#f0c97a');
  });

  it('outputs lowercase #rrggbb colours', () => {
    const tone = autoTone({ meanLuma: 0.5, palette: ['#ABC', '#123456'] });
    expect(tone.glass).toMatch(/^#[0-9a-f]{6}$/);
    expect(tone.accent).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('chooses an accent that contrasts with glass', () => {
    const tone = autoTone({ meanLuma: 0.5, palette: ['#c8b89a', '#4a6b5d', '#e0a040'] });
    expect(contrastRatio(tone.glass, tone.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('clamps meanLuma outside 0..1', () => {
    const low = autoTone({ meanLuma: -2, palette: ['#000000'] });
    const high = autoTone({ meanLuma: 3, palette: ['#ffffff'] });
    expect(low.shadeAlpha).toBe(0.35);
    expect(high.shadeAlpha).toBeGreaterThan(0.35);
  });
});
