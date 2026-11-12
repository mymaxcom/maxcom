export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface ImageHeader {
  mime: ImageMime;
  width: number;
  height: number;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ok(mime: ImageMime, width: number, height: number): ImageHeader | null {
  return width > 0 && height > 0 ? { mime, width, height } : null;
}

function readPng(buf: Buffer): ImageHeader | null {
  if (buf.length < 24) return null;
  if (!PNG_SIG.every((b, i) => buf[i] === b)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR' || buf.readUInt32BE(8) !== 13) return null;
  return ok('image/png', buf.readUInt32BE(16), buf.readUInt32BE(20));
}

function readJpeg(buf: Buffer): ImageHeader | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return null;
    let marker = buf[pos + 1]!;
    while (marker === 0xff && pos + 2 < buf.length) {
      pos += 1;
      marker = buf[pos + 1]!;
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      pos += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end / scan data before any frame header
    const len = buf.readUInt16BE(pos + 2);
    if (len < 2) return null;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (pos + 9 > buf.length) return null;
      return ok('image/jpeg', buf.readUInt16BE(pos + 7), buf.readUInt16BE(pos + 5));
    }
    pos += 2 + len;
  }
  return null;
}

function readWebp(buf: Buffer): ImageHeader | null {
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return ok('image/webp', buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1);
  }
  if (chunk === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return ok('image/webp', buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return ok('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return null;
}

/** Image type and pixel size from the file header alone; null for anything else (SVG included). */
export function readImageHeader(buf: Buffer): ImageHeader | null {
  try {
    return readPng(buf) ?? readJpeg(buf) ?? readWebp(buf);
  } catch {
    return null;
  }
}
