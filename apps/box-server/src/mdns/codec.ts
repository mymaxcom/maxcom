/**
 * DNS message encode and decode for multicast DNS, only what the box speaks: A, PTR, SRV, TXT and NSEC (anything
 * else is kept as raw bytes). The shape and the limits mirror the Android box (core/mdns/DnsMessage.kt) so both
 * kinds of box behave alike on one LAN.
 *
 * `decodeMessage` NEVER throws: a short, malformed, looping or oversized packet gives null. Names may be compressed
 * on read (a pointer must go strictly backwards, so no loop can form); `encodeMessage` writes every name in full,
 * which every resolver accepts.
 */

export const DnsType = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, NSEC: 47, ANY: 255 } as const;

/** The data of a record. Names are dotted strings without a trailing dot; compare them with `dnsKey`. */
export type RData =
  | { kind: 'A'; addr: string }
  | { kind: 'PTR'; target: string }
  | { kind: 'SRV'; priority: number; weight: number; port: number; target: string }
  | { kind: 'TXT'; strings: string[] }
  | { kind: 'NSEC'; next: string; types: number[] }
  | { kind: 'RAW'; bytes: Buffer };

export interface DnsQuestion {
  name: string;
  type: number;
  /** The QU bit: the asker accepts a unicast answer. */
  unicastResponse: boolean;
}

export interface DnsRecord {
  name: string;
  type: number;
  data: RData;
  ttl: number;
  /** The cache-flush bit of a record the sender is the only owner of. */
  cacheFlush: boolean;
}

export interface DnsMessage {
  id: number;
  flags: number;
  questions: DnsQuestion[];
  answers: DnsRecord[];
  authorities: DnsRecord[];
  additionals: DnsRecord[];
}

export const FLAG_RESPONSE_AUTHORITATIVE = 0x8400;
/** A packet larger than this is dropped unread. */
export const MAX_PACKET = 9000;
/** A message announcing more records than this is dropped unread. */
export const MAX_RECORDS = 200;

export function isResponse(m: DnsMessage): boolean {
  return (m.flags & 0x8000) !== 0;
}

/** A response message: QR and AA set, id 0, no questions. */
export function responseMessage(answers: DnsRecord[], additionals: DnsRecord[] = []): DnsMessage {
  return { id: 0, flags: FLAG_RESPONSE_AUTHORITATIVE, questions: [], answers, authorities: [], additionals };
}

/** Lower-cases a DNS name for comparison (ASCII only, as DNS does). */
export function dnsKey(name: string): string {
  return name.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** `a.b.c.d` to four bytes, or null when it is not a dotted IPv4 address. */
export function ipv4Bytes(addr: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (m === null) return null;
  const out = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return out.every((b) => b <= 255) ? out : null;
}

// ---- encode ---------------------------------------------------------------------------------------------------

class Writer {
  private parts: number[] = [];

  u8(v: number): void {
    this.parts.push(v & 0xff);
  }
  u16(v: number): void {
    this.u8(v >> 8);
    this.u8(v);
  }
  u32(v: number): void {
    this.u16(Math.floor(v / 0x10000) & 0xffff);
    this.u16(v & 0xffff);
  }
  bytes(b: ArrayLike<number>): void {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]! & 0xff);
  }
  name(n: string): void {
    if (n !== '') {
      let total = 1;
      for (const label of n.split('.')) {
        const b = Buffer.from(label, 'utf8');
        if (b.length < 1 || b.length > 63) throw new RangeError('bad label');
        total += b.length + 1;
        if (total > 255) throw new RangeError('name too long');
        this.u8(b.length);
        this.bytes(b);
      }
    }
    this.u8(0);
  }
  get length(): number {
    return this.parts.length;
  }
  toBuffer(): Buffer {
    return Buffer.from(this.parts);
  }
}

function writeRecord(out: Writer, r: DnsRecord): void {
  out.name(r.name);
  out.u16(r.type);
  out.u16(1 | (r.cacheFlush ? 0x8000 : 0));
  out.u32(r.ttl);
  const body = new Writer();
  const d = r.data;
  switch (d.kind) {
    case 'A': {
      const b = ipv4Bytes(d.addr);
      if (b === null) throw new RangeError('bad A');
      body.bytes(b);
      break;
    }
    case 'PTR':
      body.name(d.target);
      break;
    case 'SRV':
      body.u16(d.priority);
      body.u16(d.weight);
      body.u16(d.port);
      body.name(d.target);
      break;
    case 'TXT': {
      if (d.strings.length === 0) body.u8(0);
      for (const s of d.strings) {
        const b = Buffer.from(s, 'utf8');
        if (b.length > 255) throw new RangeError('txt string too long');
        body.u8(b.length);
        body.bytes(b);
      }
      break;
    }
    case 'NSEC': {
      body.name(d.next);
      // one window block; the box only uses types below 256
      const types = [...new Set(d.types.filter((t) => t >= 0 && t <= 255))].sort((a, b) => a - b);
      if (types.length > 0) {
        const len = Math.floor(types[types.length - 1]! / 8) + 1;
        const bitmap = new Array<number>(len).fill(0);
        for (const t of types) bitmap[Math.floor(t / 8)]! |= 0x80 >> t % 8;
        body.u8(0);
        body.u8(len);
        body.bytes(bitmap);
      }
      break;
    }
    case 'RAW':
      body.bytes(d.bytes);
      break;
  }
  if (body.length > 65535) throw new RangeError('record too long');
  out.u16(body.length);
  out.bytes(body.toBuffer());
}

/** The wire form of a message. Throws RangeError for a record the format cannot hold (callers encode their own records only). */
export function encodeMessage(m: DnsMessage): Buffer {
  const out = new Writer();
  out.u16(m.id);
  out.u16(m.flags);
  out.u16(m.questions.length);
  out.u16(m.answers.length);
  out.u16(m.authorities.length);
  out.u16(m.additionals.length);
  for (const q of m.questions) {
    out.name(q.name);
    out.u16(q.type);
    out.u16(1 | (q.unicastResponse ? 0x8000 : 0));
  }
  for (const r of [...m.answers, ...m.authorities, ...m.additionals]) writeRecord(out, r);
  return out.toBuffer();
}

// ---- decode ---------------------------------------------------------------------------------------------------

class Reader {
  pos = 0;
  private readonly b: Buffer;
  constructor(b: Buffer) {
    this.b = b;
  }

  u8(): number {
    if (this.pos >= this.b.length) throw new RangeError('short');
    return this.b[this.pos++]!;
  }
  u16(): number {
    return (this.u8() << 8) | this.u8();
  }
  u32(): number {
    return this.u16() * 0x10000 + this.u16();
  }

  /** A name at the cursor; the cursor ends after the name (or after its first pointer). */
  name(): string {
    const labels: string[] = [];
    let at = this.pos;
    let jumped = false;
    let guard = 0;
    let total = 1;
    for (;;) {
      if (at >= this.b.length) throw new RangeError('short name');
      const len = this.b[at]!;
      if (len === 0) {
        if (!jumped) this.pos = at + 1;
        return labels.join('.');
      }
      if ((len & 0xc0) === 0xc0) {
        if (at + 1 >= this.b.length) throw new RangeError('short pointer');
        const target = ((len & 0x3f) << 8) | this.b[at + 1]!;
        // strictly backwards: a loop cannot form
        if (target >= at) throw new RangeError('forward pointer');
        if (!jumped) this.pos = at + 2;
        jumped = true;
        if (++guard > 64) throw new RangeError('pointer chain');
        at = target;
      } else if ((len & 0xc0) !== 0) {
        throw new RangeError('bad label type');
      } else {
        if (at + 1 + len > this.b.length) throw new RangeError('short label');
        total += len + 1;
        if (total > 255) throw new RangeError('name too long');
        const label = this.b.toString('utf8', at + 1, at + 1 + len);
        if (label.includes('.')) throw new RangeError('dot in label');
        labels.push(label);
        at += 1 + len;
      }
    }
  }

  record(): DnsRecord {
    const name = this.name();
    const type = this.u16();
    const c = this.u16();
    const ttl = this.u32();
    const rdlen = this.u16();
    if (this.pos + rdlen > this.b.length) throw new RangeError('short rdata');
    const end = this.pos + rdlen;
    let data: RData;
    switch (type) {
      case DnsType.A:
        if (rdlen !== 4) throw new RangeError('bad A');
        data = { kind: 'A', addr: `${this.b[this.pos]}.${this.b[this.pos + 1]}.${this.b[this.pos + 2]}.${this.b[this.pos + 3]}` };
        break;
      case DnsType.PTR:
        data = { kind: 'PTR', target: this.name() };
        break;
      case DnsType.SRV:
        if (rdlen < 7) throw new RangeError('bad SRV');
        data = { kind: 'SRV', priority: this.u16(), weight: this.u16(), port: this.u16(), target: this.name() };
        break;
      case DnsType.TXT: {
        const strings: string[] = [];
        while (this.pos < end) {
          const l = this.u8();
          if (this.pos + l > end) throw new RangeError('bad TXT');
          strings.push(this.b.toString('utf8', this.pos, this.pos + l));
          this.pos += l;
        }
        data = { kind: 'TXT', strings };
        break;
      }
      case DnsType.NSEC: {
        const next = this.name();
        const types: number[] = [];
        while (this.pos < end) {
          const window = this.u8();
          const len = this.u8();
          if (len < 1 || len > 32 || this.pos + len > end) throw new RangeError('bad NSEC');
          for (let i = 0; i < len; i++) {
            const octet = this.u8();
            for (let bit = 0; bit < 8; bit++) if ((octet & (0x80 >> bit)) !== 0) types.push(window * 256 + i * 8 + bit);
          }
        }
        data = { kind: 'NSEC', next, types };
        break;
      }
      default:
        data = { kind: 'RAW', bytes: Buffer.from(this.b.subarray(this.pos, end)) };
    }
    // names inside rdata are read through the cursor; always continue from the declared end
    this.pos = end;
    return { name, type, data, ttl, cacheFlush: (c & 0x8000) !== 0 };
  }

  message(): DnsMessage {
    const id = this.u16();
    const flags = this.u16();
    const qd = this.u16();
    const an = this.u16();
    const ns = this.u16();
    const ar = this.u16();
    if (qd + an + ns + ar > MAX_RECORDS) throw new RangeError('too many records');
    const questions: DnsQuestion[] = [];
    for (let i = 0; i < qd; i++) {
      const name = this.name();
      const type = this.u16();
      const c = this.u16();
      questions.push({ name, type, unicastResponse: (c & 0x8000) !== 0 });
    }
    const many = (n: number): DnsRecord[] => {
      const list: DnsRecord[] = [];
      for (let i = 0; i < n; i++) list.push(this.record());
      return list;
    };
    return { id, flags, questions, answers: many(an), authorities: many(ns), additionals: many(ar) };
  }
}

/** The message in [bytes], or null for anything malformed, truncated or oversized. Never throws. */
export function decodeMessage(bytes: Buffer): DnsMessage | null {
  try {
    if (bytes.length < 12 || bytes.length > MAX_PACKET) return null;
    return new Reader(bytes).message();
  } catch {
    return null;
  }
}

/** True when two record data values are the same value. */
export function rdataEquals(a: RData, b: RData): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'A':
      return a.addr === (b as typeof a).addr;
    case 'PTR':
      return dnsKey(a.target) === dnsKey((b as typeof a).target);
    case 'SRV': {
      const o = b as typeof a;
      return a.priority === o.priority && a.weight === o.weight && a.port === o.port && dnsKey(a.target) === dnsKey(o.target);
    }
    case 'TXT': {
      const o = b as typeof a;
      return a.strings.length === o.strings.length && a.strings.every((s, i) => s === o.strings[i]);
    }
    case 'NSEC': {
      const o = b as typeof a;
      return dnsKey(a.next) === dnsKey(o.next) && a.types.length === o.types.length && a.types.every((t, i) => t === o.types[i]);
    }
    case 'RAW':
      return a.bytes.equals((b as typeof a).bytes);
  }
}
