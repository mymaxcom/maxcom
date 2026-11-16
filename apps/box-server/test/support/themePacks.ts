import { createRequire } from 'node:module';
import { writeStoredZip } from '../../src/files/zipWrite.ts';
import type { InstalledPack } from '@surau/core';
import type { PNG as PngClass } from 'pngjs';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs') as { PNG: typeof PngClass };
const jpegJs = require('jpeg-js') as { encode(img: { width: number; height: number; data: Uint8Array }, quality: number): { data: Buffer } };

/** Test builders for .maxtheme files and their parts. `zip` uses a fixed time stamp: the same files always give the same bytes, so the same hash. */
export const zip = (files: Record<string, string | Buffer>): Buffer =>
  writeStoredZip(Object.entries(files).map(([name, d]) => ({ name, data: Buffer.isBuffer(d) ? d : Buffer.from(d) })), new Date('2026-11-15T00:00:00Z'));

export const manifestJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'hijau-siti', title: 'Hijau Siti', version: 3, contract: 1, base: 'creative', defaults: {}, ...over });

/** Pixels of a small test picture: `salt` (0 to 255) shifts the colours so two pictures differ. */
function pixels(width: number, height: number, salt: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = (i * 7 + salt) & 255;
    data[i * 4 + 1] = (i * 3 + salt * 5) & 255;
    data[i * 4 + 2] = (salt * 11) & 255;
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** Past the box's own picture limits (or a big `salt`): only the header and size are real, the way an oversize file would look. */
const isOversize = (width: number, height: number, salt: number): boolean =>
  width > 4096 || height > 4096 || width * height > 16_000_000 || salt > 255;

/** A header-only JPEG of the given size (not decodable): for the limit tests. */
export function fakeJpeg(width: number, height: number, salt = 0): Buffer {
  const b = Buffer.alloc(2 + 4 + 14 + 2 + salt);
  b.writeUInt16BE(0xffd8, 0);
  b.writeUInt16BE(0xffe0, 2);
  b.writeUInt16BE(2, 4);
  b.writeUInt16BE(0xffc0, 6);
  b.writeUInt16BE(11, 8);
  b[10] = 8;
  b.writeUInt16BE(height, 11);
  b.writeUInt16BE(width, 13);
  b[15] = 1;
  return b;
}

/** A header-only PNG of the given size (not decodable): for the limit tests. */
export function fakePng(width: number, height: number, salt = 0): Buffer {
  const b = Buffer.alloc(33 + salt);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** A real JPEG (decodes, re-encodes); a size past the limits is header-only. Same arguments, same bytes. */
export function jpeg(width: number, height: number, salt = 0): Buffer {
  if (isOversize(width, height, salt)) return fakeJpeg(width, height, salt);
  return Buffer.from(jpegJs.encode({ width, height, data: pixels(width, height, salt) }, 80).data);
}

/** A real PNG; a size past the limits is header-only. Same arguments, same bytes. */
export function png(width: number, height: number, salt = 0): Buffer {
  if (isOversize(width, height, salt)) return fakePng(width, height, salt);
  const p = new PNG({ width, height });
  pixels(width, height, salt).copy(p.data);
  return PNG.sync.write(p);
}

/** A PNG with a text chunk (metadata) and bytes after the end: what re-encoding must drop. */
export function pngWithBaggage(width: number, height: number): { file: Buffer; marker: string } {
  const base = png(width, height);
  const marker = 'SECRET-METADATA-MARKER';
  const chunk = (type: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    const crcBuf = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    let c = 0xffffffff;
    for (const byte of crcBuf) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([len, crcBuf, crc]);
  };
  const ihdrEnd = 8 + 4 + 4 + 13 + 4;
  const text = chunk('tEXt', Buffer.from(`Comment\0${marker}`, 'latin1'));
  return { file: Buffer.concat([base.subarray(0, ihdrEnd), text, base.subarray(ihdrEnd)]), marker };
}

export function woff2(size: number, fill = 0): Buffer {
  const b = Buffer.alloc(Math.max(48, size), fill);
  b.write('wOF2', 0, 'latin1');
  b.writeUInt32BE(b.length, 8);
  return b;
}

export function installedPack(over: Partial<InstalledPack> = {}): InstalledPack {
  return { assetId: 'a'.repeat(64), version: 3, title: 'Hijau Siti', base: 'creative', contract: 1, bytes: 100, fonts: [], screens: [], images: {}, defaults: {}, ...over };
}

/** A PNG of seeded noise: it does not compress, so a few of them make a pack of a known weight. */
export function noisePng(width: number, height: number, seed = 1): Buffer {
  const p = new PNG({ width, height });
  let a = seed >>> 0;
  for (let i = 0; i < p.data.length; i++) {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    p.data[i] = i % 4 === 3 ? 255 : a >>> 24;
  }
  return PNG.sync.write(p);
}
