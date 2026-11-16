import { describe, expect, it } from 'vitest';
import { pictureTone } from '../src/ui/Background.tsx';

describe('pictureTone (free text over a menu picture)', () => {
  it('a dark picture gets light text, a light picture dark text', () => {
    expect(pictureTone(0.05, 0)).toBe('dark');
    expect(pictureTone(0.12, 0.4)).toBe('dark');
    expect(pictureTone(0.8, 0.1)).toBe('light');
    expect(pictureTone(0.45, 0)).toBe('light');
  });

  it("the surau's shade darkens a light picture: the same picture flips with enough shade", () => {
    expect(pictureTone(0.4, 0)).toBe('light');
    expect(pictureTone(0.4, 0.5)).toBe('dark');
  });

  it('is null until the picture is measured, and clamps a bad shade', () => {
    expect(pictureTone(null, 0.3)).toBeNull();
    expect(pictureTone(Number.NaN, 0)).toBeNull();
    expect(pictureTone(0.5, Number.NaN)).toBe('light');
    expect(pictureTone(0.5, 7)).toBe('dark');
  });
});
