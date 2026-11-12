import { describe, expect, it } from 'vitest';
import { rgbaWantsLightPlate } from '../src/ui/logoInk.ts';

type C = [number, number, number, number];
function canvas(w: number, h: number, paint: (x: number, y: number) => C): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(paint(x, y), (y * w + x) * 4);
  return d;
}
const CLEAR: C = [0, 0, 0, 0];
const ink = (c: C, x: number, y: number): C | null => (x >= 10 && x < 90 && y >= 10 && y < 30 ? c : null);
const mark = (c: C, accent?: C) => canvas(100, 40, (x, y) => (accent && x >= 80 && x < 90 && y < 18 && ink(c, x, y) ? accent : (ink(c, x, y) ?? CLEAR)));

describe('rgbaWantsLightPlate', () => {
  it('black and dark navy ink on transparency gets a plate', () => {
    expect(rgbaWantsLightPlate(mark([0, 0, 0, 255]), 100, 40)).toBe(true);
    expect(rgbaWantsLightPlate(mark([20, 40, 90, 255]), 100, 40)).toBe(true);
  });
  it('white and gold ink need none', () => {
    expect(rgbaWantsLightPlate(mark([255, 255, 255, 255]), 100, 40)).toBe(false);
    expect(rgbaWantsLightPlate(mark([240, 201, 122, 255]), 100, 40)).toBe(false);
  });
  it('an opaque black-on-white logo needs none', () => {
    const d = canvas(100, 40, (x, y) => (ink([0, 0, 0, 255], x, y) ?? [255, 255, 255, 255]));
    expect(rgbaWantsLightPlate(d, 100, 40)).toBe(false);
  });
  it('black with a small gold accent still gets a plate; white with a small black accent does not', () => {
    expect(rgbaWantsLightPlate(mark([0, 0, 0, 255], [240, 201, 122, 255]), 100, 40)).toBe(true);
    expect(rgbaWantsLightPlate(mark([255, 255, 255, 255], [0, 0, 0, 255]), 100, 40)).toBe(false);
  });
  it('black letters with half the ink coloured still get a plate', () => {
    const d = canvas(100, 40, (x, y) => (x < 10 || x >= 90 || y < 10 || y >= 30 ? CLEAR : x < 50 ? [0, 0, 0, 255] : x < 70 ? [60, 170, 60, 255] : [240, 75, 20, 255]));
    expect(rgbaWantsLightPlate(d, 100, 40)).toBe(true);
  });
  it('a gold wordmark with a dark shadow under 40 % needs none', () => {
    const d = canvas(100, 40, (x, y) => (x < 10 || x >= 90 || y < 10 || y >= 30 ? CLEAR : x < 70 ? [240, 201, 122, 255] : [0, 0, 0, 255]));
    expect(rgbaWantsLightPlate(d, 100, 40)).toBe(false);
  });
  it('empty, malformed and fully transparent input needs none; a large picture is sampled', () => {
    expect(rgbaWantsLightPlate(new Uint8ClampedArray(0), 0, 0)).toBe(false);
    expect(rgbaWantsLightPlate(new Uint8ClampedArray(3), 2, 2)).toBe(false);
    expect(rgbaWantsLightPlate(new Uint8ClampedArray(100 * 40 * 4), 100, 40)).toBe(false);
    const big = new Uint8ClampedArray(2000 * 1500 * 4);
    for (let y = 500; y < 1000; y++) for (let x = 200; x < 1800; x++) big[(y * 2000 + x) * 4 + 3] = 255;
    expect(rgbaWantsLightPlate(big, 2000, 1500)).toBe(true);
  });
});
