import { expect, it } from 'vitest';
import { PICTURE_RETRY_FLOOR_MS, PICTURE_RETRY_MS, createFailedPictures } from '../src/themes/failedPictures.ts';

const v1 = {};
const v2 = {};
it('a failed picture stays hidden until the minute is over, per id', () => {
  const f = createFailedPictures();
  f.mark('a', v1, 1000);
  expect(f.blocked('a', v1, 1000)).toBe(true);
  expect(f.blocked('a', v1, 1000 + PICTURE_RETRY_MS - 1)).toBe(true);
  expect(f.blocked('a', v1, 1000 + PICTURE_RETRY_MS)).toBe(false);
  expect(f.blocked('b', v1, 1000)).toBe(false);
});
it('a failure of one picture never hides another', () => {
  const f = createFailedPictures();
  f.mark('a', v1, 0);
  f.mark('b', v1, 10);
  expect(f.blocked('a', v1, 20)).toBe(true);
  expect(f.blocked('b', v1, 20)).toBe(true);
  expect(f.blocked('c', v1, 20)).toBe(false);
});
it('new settings retry at once, but not faster than the floor, and a second failure waits a minute again', () => {
  const f = createFailedPictures();
  f.mark('a', v1, 0);
  expect(f.blocked('a', v2, PICTURE_RETRY_FLOOR_MS - 1)).toBe(true);
  expect(f.blocked('a', v2, PICTURE_RETRY_FLOOR_MS)).toBe(false);
  f.mark('a', v2, PICTURE_RETRY_FLOOR_MS);
  expect(f.blocked('a', v2, PICTURE_RETRY_FLOOR_MS + 30_000)).toBe(true);
  expect(f.blocked('a', v2, PICTURE_RETRY_FLOOR_MS + PICTURE_RETRY_MS)).toBe(false);
});
