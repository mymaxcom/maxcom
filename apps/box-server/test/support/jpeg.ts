/** A header-valid JPEG of the given size (SOF0 frame, then padding). */
export function jpeg(bytes: number, width = 640, height = 480): Buffer {
  const head = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);
  const pad = Buffer.alloc(Math.max(0, bytes - head.length));
  pad.fill(7, 0, Math.min(pad.length, 64));
  pad.writeUInt32BE(bytes, 0);
  return Buffer.concat([head, pad]);
}
