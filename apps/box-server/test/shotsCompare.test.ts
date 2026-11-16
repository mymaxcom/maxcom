import { expect, it } from 'vitest';
import { PNG } from 'pngjs';
// @ts-expect-error plain .mjs script without types
import { comparePng } from '../../../scripts/shots-compare.mjs';
const png = (rgba: number[]) => { const p = new PNG({ width: 2, height: 1 }); p.data = Buffer.from(rgba); return PNG.sync.write(p); };
it('identical pixels are the same', () => {
  expect(comparePng(png([1,2,3,255, 4,5,6,255]), png([1,2,3,255, 4,5,6,255]))).toEqual({ same: true, diffPixels: 0 });
});
it('one changed channel is one differing pixel', () => {
  expect(comparePng(png([1,2,3,255, 4,5,6,255]), png([1,2,3,255, 4,5,7,255]))).toEqual({ same: false, diffPixels: 1 });
});
it('a size mismatch is never the same', () => {
  const wide = new PNG({ width: 3, height: 1 }); wide.data = Buffer.alloc(12);
  expect(comparePng(png([0,0,0,0, 0,0,0,0]), PNG.sync.write(wide)).same).toBe(false);
});
