import { crc32, inflateRawSync } from 'node:zlib';

/**
 * A bounded reader for the zip files this box accepts from a person (an Excel workbook).
 * It reads the central directory only, takes only the entries the caller asks for by exact name, supports the
 * methods store (0) and deflate (8), and refuses anything that could be abused: too many entries, an entry or
 * a total that inflates past its cap, a name that climbs out of the folder, a name used twice, encryption,
 * zip64, a local header that disagrees with the directory, a wrong checksum. Nothing is ever written to disk.
 */

export interface ZipCaps {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_CAPS: ZipCaps = {
  maxEntries: 2000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
};

/** A refusal with a fixed, safe message (no file content, no names from the archive). */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipReadOptions {
  /**
   * Strict (default): an entry with a bad name makes the whole archive refused. Lenient: such an entry is
   * left out and its (cleaned) description is passed to `onSkip`, so the caller can warn.
   */
  lenient?: boolean;
  onSkip?: (description: string) => void;
  /** Windows PowerShell 5.1 Compress-Archive may write `\` between folders: read it as `/` (the rest of the name rules still apply). */
  backslashAsSlash?: boolean;
}

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX_NAME_BYTES = 200;
const MAX_EOCD_SEARCH = 22 + 0xffff;

/** Why a name is not acceptable, or null. Pure; also used by the writer. */
export function badEntryName(name: string): string | null {
  if (name.length === 0) return 'empty name';
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return 'name too long';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'control character in name';
  if (name.includes('\\')) return 'backslash in name';
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'absolute path';
  const parts = name.endsWith('/') ? name.slice(0, -1).split('/') : name.split('/');
  for (const p of parts) {
    if (p === '' ) return 'empty path segment';
    if (p === '.' || p === '..') return 'path climbs out of the folder';
  }
  return null;
}

/** Safe text for a message: printable ASCII only, short. */
function describe(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, '?').slice(0, 60);
}

function findEocd(buf: Buffer): number {
  const lowest = Math.max(0, buf.length - MAX_EOCD_SEARCH);
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) return i;
    }
  }
  throw new ZipError('not a zip file');
}

export function readZipEntries(
  buf: Buffer,
  wanted: (name: string) => boolean,
  caps: ZipCaps = DEFAULT_ZIP_CAPS,
  options: ZipReadOptions = {},
): Map<string, Buffer> {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('not a zip file');
  const eocd = findEocd(buf);
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entriesHere = buf.readUInt16LE(eocd + 8);
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || entriesHere !== entries) throw new ZipError('multi-part zip not supported');
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('zip64 not supported');
  if (entries > caps.maxEntries) throw new ZipError('too many entries');
  if (cdOffset + cdSize > eocd) throw new ZipError('bad central directory');

  const out = new Map<string, Buffer>();
  const seen = new Set<string>();
  let total = 0;
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;

  for (let n = 0; n < entries; n++) {
    if (p + 46 > cdEnd || buf.readUInt32LE(p) !== SIG_CD) throw new ZipError('bad central directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > cdEnd) throw new ZipError('bad central directory');
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    const rawName = nameBytes.toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1');
    const name = options.backslashAsSlash === true ? rawName.replace(/\\/g, '/') : rawName;
    p = next;

    const bad = badEntryName(name);
    if (bad !== null) {
      if (options.lenient === true) { options.onSkip?.(`${bad}: ${describe(name)}`); continue; }
      throw new ZipError(`unsafe entry name (${bad})`);
    }
    if (seen.has(name)) throw new ZipError('duplicate entry name');
    seen.add(name);
    if (name.endsWith('/') || !wanted(name)) continue;

    if ((flags & 1) !== 0) throw new ZipError('encrypted entries not supported');
    if (method !== 0 && method !== 8) throw new ZipError('unsupported compression method');
    if (size > caps.maxEntryBytes) throw new ZipError('entry too large');
    total += size;
    if (total > caps.maxTotalBytes) throw new ZipError('archive too large');

    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new ZipError('bad local header');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > cdOffset) throw new ZipError('entry data out of bounds');
    if (!buf.subarray(localOffset + 30, localOffset + 30 + lNameLen).equals(nameBytes)) throw new ZipError('local header disagrees with the directory');
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === 0) {
      if (compSize !== size) throw new ZipError('size mismatch');
      data = Buffer.from(raw);
    } else {
      try {
        // The limit is the declared size: an entry that lies about its size stops here, never at the heap.
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
      } catch {
        throw new ZipError('entry too large or damaged');
      }
      if (data.length !== size) throw new ZipError('size mismatch');
    }
    if ((crc32(data) >>> 0) !== crc) throw new ZipError('checksum mismatch');
    out.set(name, data);
  }
  return out;
}
