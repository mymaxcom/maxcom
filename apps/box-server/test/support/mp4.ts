/** Builds a minimal but well-formed MP4 (ftyp, moov with a video track, mdat) for tests; no real media inside. */
export function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}

export interface Mp4Opts {
  codec?: string;
  width?: number;
  height?: number;
  seconds?: number;
  /** Put `moov` after `mdat` (a file not made for streaming). */
  moovLast?: boolean;
  /** Extra payload bytes in `mdat`, to make the file a given size. */
  padding?: number;
  /** Salt so two files differ (the id is the hash of the bytes). */
  salt?: number;
  /** Leave the movie header out, or write this time scale / raw duration into it. */
  mvhd?: boolean;
  timescale?: number;
  durationUnits?: number;
  /** Extra top-level boxes put between ftyp and the rest. */
  before?: Buffer[];
  /** Extra boxes put inside moov (after mvhd). */
  inMoov?: Buffer[];
}

export function mp4(o: Mp4Opts = {}): Buffer {
  const { codec = 'avc1', width = 1280, height = 720, seconds = 30, moovLast = false, padding = 64, salt = 0 } = o;
  const timescale = o.timescale ?? 1000;
  const ftyp = box('ftyp', Buffer.from('isom'), Buffer.alloc(4), Buffer.from('isomavc1'));
  const mvhdBody = Buffer.alloc(100);
  mvhdBody.writeUInt32BE(timescale, 12); // timescale
  mvhdBody.writeUInt32BE(o.durationUnits ?? Math.round(seconds * 1000), 16); // duration
  const mvhd = box('mvhd', mvhdBody);
  const hdlrBody = Buffer.alloc(24);
  hdlrBody.write('vide', 8, 'latin1');
  const hdlr = box('hdlr', hdlrBody);
  const entry = Buffer.alloc(86);
  entry.writeUInt32BE(86, 0);
  entry.write(codec, 4, 'latin1');
  entry.writeUInt16BE(width, 32);
  entry.writeUInt16BE(height, 34);
  const stsdHead = Buffer.alloc(8);
  stsdHead.writeUInt32BE(1, 4);
  const stsd = box('stsd', stsdHead, entry);
  const trak = box('trak', box('mdia', hdlr, box('minf', box('stbl', stsd))));
  const moov = box('moov', ...(o.mvhd === false ? [] : [mvhd]), ...(o.inMoov ?? []), trak);
  const pad = Buffer.alloc(padding);
  pad.writeUInt32BE(salt, 0);
  const mdat = box('mdat', pad);
  const extra = o.before ?? [];
  return Buffer.concat(moovLast ? [ftyp, ...extra, mdat, moov] : [ftyp, ...extra, moov, mdat]);
}
