import { deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { decodeImage } from '../src/imageResize.ts';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG whose IHDR claims `w` x `h` but whose body is a few bytes of (invalid) data. */
function fakePng(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  const idat = Buffer.concat([Buffer.from([0, 0, 0, 4]), Buffer.from('IDAT'), deflateSync(Buffer.alloc(4)), Buffer.alloc(4)]);
  return Buffer.concat([SIG, ihdr, idat]);
}

describe('decodeImage PNG header check', () => {
  it('refuses a 50000x50000 header before decoding (size error, not zlib)', () => {
    expect(() => decodeImage(fakePng(50000, 50000))).toThrow('image is too large');
  });
  it('refuses a side over the maximum even when the pixel count is small', () => {
    expect(() => decodeImage(fakePng(100000, 1))).toThrow('image is too large');
  });
  it('refuses zero width or height', () => {
    expect(() => decodeImage(fakePng(0, 10))).toThrow('image has no size');
    expect(() => decodeImage(fakePng(10, 0))).toThrow('image has no size');
  });
  it('refuses a PNG larger than the upload cap', () => {
    const big = Buffer.concat([fakePng(10, 10), Buffer.alloc(8 * 1024 * 1024)]);
    expect(() => decodeImage(big)).toThrow('image is too large');
  });
  it('refuses a PNG whose first chunk is not IHDR', () => {
    const b = fakePng(10, 10);
    b.write('XXXX', 12, 'latin1');
    expect(() => decodeImage(b)).toThrow('damaged PNG header');
  });
  it('still decodes a normal PNG', () => {
    const p = new PNG({ width: 4, height: 3 });
    p.data.fill(200);
    const out = decodeImage(PNG.sync.write(p));
    expect(out.width).toBe(4);
    expect(out.height).toBe(3);
  });
});
