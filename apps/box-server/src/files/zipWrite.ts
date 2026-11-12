import { crc32 } from 'node:zlib';
import { badEntryName, ZipError } from './zipRead.ts';

export interface ZipEntry { name: string; data: Buffer }

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getUTCFullYear()));
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/**
 * A store-only zip (method 0) of fixed, caller-chosen names: used for the Excel template. Names follow the same
 * rules the reader enforces, so what this writes the reader reads.
 */
export function writeStoredZip(entries: ZipEntry[], now: Date = new Date()): Buffer {
  if (entries.length === 0 || entries.length > 0xfffe) throw new ZipError('bad entry count');
  const { time, date } = dosTime(now);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const e of entries) {
    const bad = badEntryName(e.name);
    if (bad !== null || e.name.endsWith('/')) throw new ZipError('unsafe entry name');
    if (seen.has(e.name)) throw new ZipError('duplicate entry name');
    seen.add(e.name);
    if (e.data.length > 0xfffffff0 || offset > 0xfffffff0) throw new ZipError('too large');
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, e.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
