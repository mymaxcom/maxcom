import { createSocket } from 'node:dgram';
import { describe, expect, it } from 'vitest';
import {
  allRecords,
  announcement,
  goodbye,
  hostFor,
  MdnsIdentity,
  parseHost,
  probeMessage,
  replyTo,
  SERVICE,
  SERVICE_ENUM,
} from '../src/mdns/answerer.ts';
import { NameClaim, PROBE_GAP_MS } from '../src/mdns/claim.ts';
import type { ClaimAction } from '../src/mdns/claim.ts';
import { decodeMessage, DnsType, encodeMessage, ipv4Bytes, isResponse, MAX_PACKET, responseMessage } from '../src/mdns/codec.ts';
import type { DnsMessage, DnsRecord } from '../src/mdns/codec.ts';
import { isPrivateV4, MdnsResponder, UdpTransport } from '../src/mdns/responder.ts';
import { FakeClock, MemoryBus } from './support/mdnsBus.ts';

const ME = '10.168.50.10';
const OTHER = '10.168.50.11';
const IFACE = { addr: ME, prefix: 24, ident: 'eth0' };

function query(name: string, type: number = DnsType.A, o: { qu?: boolean; id?: number } = {}): DnsMessage {
  return { id: o.id ?? 0, flags: 0, questions: [{ name, type, unicastResponse: o.qu === true }], answers: [], authorities: [], additionals: [] };
}
const aRecord = (name: string, addr: string, ttl = 120): DnsRecord => ({ name, type: DnsType.A, data: { kind: 'A', addr }, ttl, cacheFlush: true });
const response = (...answers: DnsRecord[]): DnsMessage => responseMessage(answers);

/** A tiny seeded generator so a failing fuzz case can be replayed. */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}

describe('codec', () => {
  const id = new MdnsIdentity(3, '0123456789abcdef', 'fedcba9876543210');

  it('round-trips the announcement (A, NSEC, PTR, SRV, TXT, enumeration)', () => {
    const msg = announcement(id, ME);
    const back = decodeMessage(encodeMessage(msg));
    expect(back).not.toBeNull();
    expect(back!.flags).toBe(msg.flags);
    expect(back!.answers).toEqual(msg.answers);
    expect(isResponse(back!)).toBe(true);
    const types = back!.answers.map((r) => r.type);
    expect(types).toEqual([DnsType.A, DnsType.NSEC, DnsType.PTR, DnsType.SRV, DnsType.TXT, DnsType.PTR]);
    const txt = back!.answers.find((r) => r.type === DnsType.TXT)!;
    expect(txt.data).toEqual({ kind: 'TXT', strings: ['v=1', 'id=0123456789abcdef', 'ca=fedcba9876543210'] });
  });

  it('round-trips a probe: the question and the proposed A record in the authority section', () => {
    const back = decodeMessage(encodeMessage(probeMessage(hostFor(2), ME)))!;
    expect(back.questions).toEqual([{ name: 'box2-surau.local', type: DnsType.ANY, unicastResponse: false }]);
    expect(back.authorities).toHaveLength(1);
    expect(back.authorities[0]!.data).toEqual({ kind: 'A', addr: ME });
  });

  it('keeps the QU bit and the cache-flush bit apart', () => {
    const back = decodeMessage(encodeMessage(query('box1-surau.local', DnsType.A, { qu: true })))!;
    expect(back.questions[0]!.unicastResponse).toBe(true);
    const r = decodeMessage(encodeMessage(response(aRecord('box1-surau.local', ME))))!;
    expect(r.answers[0]!.cacheFlush).toBe(true);
  });

  it('reads a compressed name (a pointer that goes back)', () => {
    // header: 1 question, 1 answer; question name at 12; the answer name is a pointer to it
    const name = Buffer.from([5, ...Buffer.from('box1-'), 0]);
    const full = Buffer.concat([Buffer.from([4]), Buffer.from('box1'), Buffer.from([0])]);
    void name;
    const header = Buffer.from([0, 0, 0x84, 0, 0, 1, 0, 1, 0, 0, 0, 0]);
    const q = Buffer.concat([full, Buffer.from([0, 1, 0, 1])]);
    const a = Buffer.concat([Buffer.from([0xc0, 12]), Buffer.from([0, 1, 0x80, 1, 0, 0, 0, 120, 0, 4, 10, 0, 0, 7])]);
    const msg = decodeMessage(Buffer.concat([header, q, a]))!;
    expect(msg.questions[0]!.name).toBe('box1');
    expect(msg.answers[0]!.name).toBe('box1');
    expect(msg.answers[0]!.data).toEqual({ kind: 'A', addr: '10.0.0.7' });
  });

  it('refuses a forward pointer, a self pointer, a bad label type and a bad A length', () => {
    const header = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    const tail = Buffer.from([0, 1, 0, 1]);
    expect(decodeMessage(Buffer.concat([header, Buffer.from([0xc0, 12]), tail]))).toBeNull(); // points at itself
    expect(decodeMessage(Buffer.concat([header, Buffer.from([0xc0, 40]), tail]))).toBeNull(); // forward
    expect(decodeMessage(Buffer.concat([header, Buffer.from([0x80, 1, 2, 0]), tail]))).toBeNull(); // reserved label type
    const badA = Buffer.concat([Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from([1, 97, 0, 0, 1, 0, 1, 0, 0, 0, 120, 0, 3, 1, 2, 3])]);
    expect(decodeMessage(badA)).toBeNull();
  });

  it('refuses a packet that is too short, too big or announces too many records', () => {
    expect(decodeMessage(Buffer.alloc(0))).toBeNull();
    expect(decodeMessage(Buffer.alloc(11))).toBeNull();
    expect(decodeMessage(Buffer.alloc(MAX_PACKET + 1))).toBeNull();
    const many = Buffer.from([0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0]);
    expect(decodeMessage(many)).toBeNull();
  });

  it('every truncation of a valid packet decodes to null or a message, never throws', () => {
    const wire = encodeMessage(announcement(id, ME));
    for (let n = 0; n <= wire.length; n++) expect(() => decodeMessage(wire.subarray(0, n))).not.toThrow();
    expect(decodeMessage(wire.subarray(0, wire.length - 1))).toBeNull();
  });

  it('fuzz: random and mutated packets never throw', () => {
    const next = rng(20261124);
    const valid = [encodeMessage(announcement(id, ME)), encodeMessage(probeMessage(hostFor(1), ME)), encodeMessage(query(SERVICE, DnsType.PTR))];
    for (let i = 0; i < 4000; i++) {
      const len = Math.floor(next() * 300);
      const b = Buffer.alloc(len);
      for (let k = 0; k < len; k++) b[k] = Math.floor(next() * 256);
      expect(() => decodeMessage(b)).not.toThrow();
    }
    for (let i = 0; i < 6000; i++) {
      const b = Buffer.from(valid[i % valid.length]!);
      const flips = 1 + Math.floor(next() * 6);
      for (let k = 0; k < flips; k++) b[Math.floor(next() * b.length)] = Math.floor(next() * 256);
      expect(() => decodeMessage(b)).not.toThrow();
    }
  });

  it('encode refuses what the format cannot hold, decode of encode never grows a label past 63', () => {
    expect(() => encodeMessage(query('a'.repeat(64) + '.local'))).toThrow(RangeError);
    expect(() => encodeMessage(query(`${'a'.repeat(60)}.`.repeat(5) + 'local'))).toThrow(RangeError);
  });

  it('ipv4Bytes takes dotted addresses only', () => {
    expect(ipv4Bytes('10.168.50.10')).toEqual([192, 168, 50, 10]);
    for (const bad of ['', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.x', '::1', ' 1.2.3.4']) expect(ipv4Bytes(bad), bad).toBeNull();
  });
});

describe('names', () => {
  it('hostFor and parseHost agree with the certificate rule', () => {
    expect(hostFor(1)).toBe('box1-surau.local');
    expect(hostFor(99)).toBe('box99-surau.local');
    for (const bad of [0, 100, -1, 1.5, Number.NaN]) expect(() => hostFor(bad), String(bad)).toThrow(RangeError);
    expect(parseHost('box7-surau.local')).toBe(7);
    for (const bad of ['box0-surau.local', 'box100-surau.local', 'Box1-surau.local', 'box1.surau.local', 'box.surau.local', 'xbox1-surau.local']) expect(parseHost(bad), bad).toBeNull();
  });

  it('private ranges are the LAN ranges only', () => {
    for (const ok of ['10.0.0.1', '172.16.0.1', '172.31.255.1', '10.168.0.1', '169.254.3.4']) expect(isPrivateV4(ok), ok).toBe(true);
    for (const bad of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '127.0.0.1', '224.0.0.251', '100.64.0.1', 'x']) expect(isPrivateV4(bad), bad).toBe(false);
  });
});

describe('answerer', () => {
  const id = new MdnsIdentity(1, '0123456789abcdef', 'fedcba9876543210');

  it('answers its own host name with its address, any letter case', () => {
    const r = replyTo(id, ME, query('BOX1-Surau.LOCAL'), false)!;
    expect(r.unicast).toBe(false);
    expect(r.message.answers.map((a) => a.data)).toContainEqual({ kind: 'A', addr: ME });
    expect(isResponse(r.message)).toBe(true);
  });

  it('answers nothing for any other name, type or non-question', () => {
    for (const other of ['box2-surau.local', 'box.surau.local', 'box1.surau.local', 'evil.local', 'box1-surau.local.evil.com', 'localhost', '']) {
      expect(replyTo(id, ME, query(other), false), other).toBeNull();
    }
    expect(replyTo(id, ME, query('box1-surau.local', DnsType.SRV), false)).toBeNull();
    expect(replyTo(id, ME, response(aRecord('box1-surau.local', OTHER)), false)).toBeNull();
    expect(replyTo(id, ME, { ...query('box1-surau.local'), questions: [] }, false)).toBeNull();
  });

  it('answers the service type, its instance and the enumeration', () => {
    const ptr = replyTo(id, ME, query(SERVICE, DnsType.PTR), false)!;
    expect(ptr.message.answers[0]!.data).toEqual({ kind: 'PTR', target: `MAXCOM box1.${SERVICE}` });
    expect(ptr.message.additionals.map((r) => r.type)).toEqual(expect.arrayContaining([DnsType.SRV, DnsType.TXT, DnsType.A]));
    const srv = replyTo(id, ME, query(`MAXCOM box1.${SERVICE}`, DnsType.SRV), false)!;
    expect(srv.message.answers[0]!.data).toMatchObject({ kind: 'SRV', port: 8443, target: 'box1-surau.local' });
    const en = replyTo(id, ME, query(SERVICE_ENUM, DnsType.PTR), false)!;
    expect(en.message.answers[0]!.data).toEqual({ kind: 'PTR', target: SERVICE });
    expect(replyTo(id, ME, query('MAXCOM box2._maxcom._tcp.local', DnsType.SRV), false)).toBeNull();
  });

  it('a legacy asker (not port 5353) gets a unicast reply that echoes id and question, TTL at most 10, no cache flush', () => {
    const r = replyTo(id, ME, query('box1-surau.local', DnsType.A, { id: 0x1234 }), true)!;
    expect(r.unicast).toBe(true);
    expect(r.message.id).toBe(0x1234);
    expect(r.message.questions).toHaveLength(1);
    for (const a of [...r.message.answers, ...r.message.additionals]) {
      expect(a.ttl).toBeLessThanOrEqual(10);
      expect(a.cacheFlush).toBe(false);
    }
  });

  it('answers by unicast only when every answered question asked for it (QU)', () => {
    expect(replyTo(id, ME, query('box1-surau.local', DnsType.A, { qu: true }), false)!.unicast).toBe(true);
    expect(replyTo(id, ME, query('box1-surau.local', DnsType.A), false)!.unicast).toBe(false);
  });

  it('known-answer suppression: nothing is sent when the asker holds the record with more than half its TTL', () => {
    const q = query('box1-surau.local');
    // every answer is already known: nothing at all is sent
    expect(replyTo(id, ME, { ...q, answers: [aRecord('box1-surau.local', ME, 100)] }, false)).toBeNull();
    const stale = replyTo(id, ME, { ...q, answers: [aRecord('box1-surau.local', ME, 20)] }, false)!;
    expect(stale.message.answers.map((a) => a.type)).toContain(DnsType.A);
  });

  it('the goodbye carries TTL 0 on every record and the TXT only carries well-formed hints', () => {
    for (const r of goodbye(id, ME).answers) expect(r.ttl).toBe(0);
    expect(allRecords(id, ME).every((r) => r.ttl > 0)).toBe(true);
    const odd = new MdnsIdentity(1, 'not-hex', 'ABC');
    expect(odd.txt()).toEqual({ kind: 'TXT', strings: ['v=1'] });
  });
});

describe('NameClaim (RFC 6762 probing)', () => {
  const zero = (): number => 0;
  /** Runs the machine forward in 50 ms steps, collecting actions. */
  function run(c: NameClaim, from: number, to: number, hear?: (t: number) => DnsMessage | null): { at: number; a: ClaimAction }[] {
    const out: { at: number; a: ClaimAction }[] = [];
    for (let t = from; t <= to; t += 50) {
      const m = hear?.(t);
      if (m) for (const a of c.onMessage(m, t)) out.push({ at: t, a });
      for (const a of c.tick(t)) out.push({ at: t, a });
    }
    return out;
  }

  it('claims after three probes 250 ms apart and announces twice, one second apart', () => {
    const c = new NameClaim(1, zero);
    c.setAddresses([ME]);
    c.start(0);
    const acts = run(c, 0, 3000);
    const probes = acts.filter((x) => x.a.type === 'probe').map((x) => x.at);
    expect(probes).toEqual([0, 250, 500]);
    const claimed = acts.find((x) => x.a.type === 'claimed')!;
    expect(claimed.at).toBe(500 + PROBE_GAP_MS);
    expect(claimed.a).toEqual({ type: 'claimed', n: 1 });
    const announces = acts.filter((x) => x.a.type === 'announce').map((x) => x.at);
    expect(announces).toEqual([750, 1750]);
    expect(c.claimed).toBe(true);
    expect(c.host).toBe('box1-surau.local');
  });

  it('keeps its stored number: it starts probing at it, not at 1', () => {
    const c = new NameClaim(5, zero);
    c.setAddresses([ME]);
    c.start(0);
    const acts = run(c, 0, 1000);
    expect(acts.filter((x) => x.a.type === 'probe').every((x) => (x.a as { host: string }).host === 'box5-surau.local')).toBe(true);
    expect(c.n).toBe(5);
  });

  it('clamps a wrong start number into 1..99', () => {
    expect(new NameClaim(0, zero).n).toBe(1);
    expect(new NameClaim(400, zero).n).toBe(99);
    expect(new NameClaim(Number.NaN, zero).n).toBe(1);
  });

  it('a response for our name from another address while probing moves to the next number, never a lower one', () => {
    const c = new NameClaim(1, zero);
    c.setAddresses([ME]);
    c.start(0);
    run(c, 0, 100);
    const acts = c.onMessage(response(aRecord('box1-surau.local', OTHER)), 100);
    expect(acts).toEqual([]); // never claimed: no 'lost'
    expect(c.n).toBe(2);
    run(c, 100, 2000);
    expect(c.claimed).toBe(true);
    expect(c.host).toBe('box2-surau.local');
  });

  it('a response that carries only our own address, or a goodbye (TTL 0), is no conflict', () => {
    const c = new NameClaim(1, zero);
    c.setAddresses([ME]);
    c.start(0);
    run(c, 0, 100);
    c.onMessage(response(aRecord('box1-surau.local', ME)), 100);
    c.onMessage(response(aRecord('box1-surau.local', OTHER, 0)), 110);
    c.onMessage(response(aRecord('box2-surau.local', OTHER)), 120);
    expect(c.n).toBe(1);
  });

  it('simultaneous probes: the box whose address sorts later wins, the other takes the next number', () => {
    const lo = new NameClaim(1, zero);
    lo.setAddresses([ME]); // .10 sorts earlier: loses
    lo.start(0);
    run(lo, 0, 100);
    const theirsHigher = probeMessage('box1-surau.local', OTHER);
    lo.onMessage(theirsHigher, 100);
    expect(lo.n).toBe(2);

    const hi = new NameClaim(1, zero);
    hi.setAddresses([OTHER]);
    hi.start(0);
    run(hi, 0, 100);
    hi.onMessage(probeMessage('box1-surau.local', ME), 100);
    expect(hi.n).toBe(1);
  });

  it('after the claim a conflicting response only starts a re-probe; one more answer to our probe moves the name', () => {
    const c = new NameClaim(1, zero);
    c.setAddresses([ME]);
    c.start(0);
    run(c, 0, 1000);
    expect(c.claimed).toBe(true);
    // one spoofed packet: re-probe, the name is not given up
    expect(c.onMessage(response(aRecord('box1-surau.local', OTHER)), 2000)).toEqual([]);
    expect(c.state).toBe('probing');
    expect(c.n).toBe(1);
    // nobody answers our probes: claimed again at the same number
    run(c, 2000, 4000);
    expect(c.claimed).toBe(true);
    expect(c.n).toBe(1);
    // a real owner answers one of OUR probes of a re-probe
    c.onMessage(response(aRecord('box1-surau.local', OTHER)), 20_000);
    run(c, 20_000, 20_100);
    const acts = c.onMessage(response(aRecord('box1-surau.local', OTHER)), 20_100);
    expect(acts).toEqual([{ type: 'lost', oldHost: 'box1-surau.local' }]);
    expect(c.n).toBe(2);
  });

  it('a spoofer cannot walk the box through the numbers: the renumber cap keeps the name', () => {
    let allowed = 1;
    const c = new NameClaim(1, zero);
    c.renumberGate = () => allowed-- > 0;
    c.setAddresses([ME]);
    c.start(0);
    run(c, 0, 100);
    c.onMessage(response(aRecord('box1-surau.local', OTHER)), 100); // first conflict: allowed
    expect(c.n).toBe(2);
    run(c, 100, 2000);
    expect(c.claimed).toBe(true);
    const denied = c.onMessage(response(aRecord('box2-surau.local', OTHER)), 2100);
    expect(denied).toEqual([]); // claimed: a re-probe first
    run(c, 2100, 2300);
    const acts = c.onMessage(response(aRecord('box2-surau.local', OTHER)), 2300);
    expect(acts.map((a) => a.type)).toEqual(['renumberDenied', 'claimed', 'announce']);
    expect(c.n).toBe(2);
    expect(c.claimed).toBe(true);
  });

  it('with all 99 names taken the state is exhausted and nothing is claimed', () => {
    const c = new NameClaim(99, zero);
    c.setAddresses([ME]);
    c.start(0);
    run(c, 0, 100);
    const acts = c.onMessage(response(aRecord('box99-surau.local', OTHER)), 100);
    expect(acts).toEqual([{ type: 'exhausted' }]);
    expect(c.state).toBe('exhausted');
    expect(c.claimed).toBe(false);
    expect(c.nextDeadline()).toBeNull();
  });

  it('ignores messages while idle', () => {
    const c = new NameClaim(1, zero);
    expect(c.onMessage(response(aRecord('box1-surau.local', OTHER)), 0)).toEqual([]);
    expect(c.n).toBe(1);
  });
});

describe('MdnsResponder over a virtual LAN', () => {
  const fixed = (): number => 0;
  function node(bus: MemoryBus, clock: FakeClock, addr: string, n = 1, o: { log?: string[] } = {}) {
    const t = bus.node();
    const events: ClaimAction[] = [];
    const r = new MdnsResponder({
      transport: t,
      clock,
      random: fixed,
      onAction: (a) => events.push(a),
      log: (m) => o.log?.push(m),
    });
    r.start(n, [{ addr, prefix: 24, ident: 'eth0' }]);
    return { t, r, events };
  }
  const decoded = (bus: MemoryBus): DnsMessage[] => bus.log.map((s) => decodeMessage(s.data)).filter((m): m is DnsMessage => m !== null);
  const replies = (bus: MemoryBus, from: number): DnsMessage[] => decoded(bus).slice(from).filter((m) => isResponse(m) && m.answers.some((a) => a.type === DnsType.A && a.ttl > 0));

  it('claims box1-surau.local alone, announces, then answers a query for it', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const a = node(bus, clock, ME);
    await clock.advance(2000);
    expect(a.r.bound).toBe(true);
    expect(a.r.claimedHost).toBe('box1-surau.local');
    expect(a.events.map((e) => e.type).filter((t) => t !== 'probe')).toEqual(['claimed', 'announce', 'announce']);
    const before = bus.log.length;
    a.t.deliver(encodeMessage(query('box1-surau.local')), '10.168.50.77', 5353);
    const got = replies(bus, before);
    expect(got).toHaveLength(1);
    expect(got[0]!.answers.find((r) => r.type === DnsType.A)!.data).toEqual({ kind: 'A', addr: ME });
  });

  it('does not answer before the name is claimed', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const a = node(bus, clock, ME);
    await clock.advance(100); // probing
    expect(a.r.claimedHost).toBeNull();
    const before = bus.log.length;
    a.t.deliver(encodeMessage(query('box1-surau.local')), '10.168.50.77', 5353);
    expect(replies(bus, before)).toHaveLength(0);
  });

  it('answers for its own names only, nothing for any other name', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const a = node(bus, clock, ME);
    await clock.advance(2000);
    const before = bus.log.length;
    for (const other of ['box2-surau.local', 'box.surau.local', 'evil-surau.local', 'localhost', 'box1-surau.local.evil.com', 'MAXCOM box2._maxcom._tcp.local']) {
      a.t.deliver(encodeMessage(query(other, DnsType.ANY)), '10.168.50.77', 5353);
    }
    a.t.deliver(encodeMessage(query('_ipp._tcp.local', DnsType.PTR)), '10.168.50.77', 5353);
    expect(bus.log.length).toBe(before);
  });

  it('two boxes: the second one that finds box1 taken claims box2 (conflict gives the next number)', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const a = node(bus, clock, ME);
    await clock.advance(2000);
    expect(a.r.claimedHost).toBe('box1-surau.local');
    const b = node(bus, clock, OTHER);
    await clock.advance(3000);
    expect(b.r.claimedHost).toBe('box2-surau.local');
    expect(b.events.map((e) => e.type).filter((t) => t !== 'probe')).toEqual(['claimed', 'announce', 'announce']);
    expect(a.r.claimedHost).toBe('box1-surau.local'); // the first box is not disturbed
    expect(a.events.filter((e) => e.type === 'lost')).toEqual([]);
    // each answers for its own name and not for the other's
    const before = bus.log.length;
    b.t.deliver(encodeMessage(query('box1-surau.local')), '10.168.50.77', 5353);
    expect(replies(bus, before)).toHaveLength(0);
    a.t.deliver(encodeMessage(query('box1-surau.local')), '10.168.50.77', 5353);
    expect(replies(bus, before)).toHaveLength(1);
  });

  it('two boxes starting at the same moment: exactly one gets box1, the other box2', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const a = node(bus, clock, ME);
    const b = node(bus, clock, OTHER);
    await clock.advance(5000);
    const names = [a.r.claimedHost, b.r.claimedHost].sort();
    expect(names).toEqual(['box1-surau.local', 'box2-surau.local']);
    expect(b.r.claimedHost).toBe('box1-surau.local'); // the later address wins the tiebreak
  });

  it('a box restarted at its stored number keeps it when nobody else holds it', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const a = node(bus, clock, ME, 7);
    await clock.advance(2000);
    expect(a.r.claimedHost).toBe('box7-surau.local');
    expect(a.r.number).toBe(7);
  });

  it('ignores packets from a public address, from a private address outside its subnet and from its own address', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const a = node(bus, clock, ME);
    await clock.advance(2000);
    const before = bus.log.length;
    for (const src of ['8.8.8.8', '203.0.113.9', '10.9.8.7', '10.168.51.20', '127.0.0.1', ME, 'not-an-address']) {
      a.t.deliver(encodeMessage(query('box1-surau.local')), src, 5353);
    }
    expect(bus.log.length).toBe(before);
    a.t.deliver(encodeMessage(query('box1-surau.local')), '10.168.50.200', 5353);
    expect(bus.log.length).toBe(before + 1);
  });

  it('a response or a probe from a port other than 5353 cannot contest the name', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const a = node(bus, clock, ME);
    await clock.advance(100);
    a.t.deliver(encodeMessage(response(aRecord('box1-surau.local', OTHER))), OTHER, 40000);
    a.t.deliver(encodeMessage(probeMessage('box1-surau.local', OTHER)), OTHER, 40000);
    await clock.advance(2000);
    expect(a.r.claimedHost).toBe('box1-surau.local');
    // and once claimed, a forged response from another port does not even start a re-probe
    const before = bus.log.length;
    a.t.deliver(encodeMessage(response(aRecord('box1-surau.local', OTHER))), OTHER, 40000);
    await clock.advance(1500);
    const probes = decoded(bus).slice(before).filter((m) => !isResponse(m) && m.authorities.length > 0);
    expect(probes).toHaveLength(0);
  });

  it('one forged response after the claim re-probes but does not move the name', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const a = node(bus, clock, ME);
    await clock.advance(2000);
    a.t.deliver(encodeMessage(response(aRecord('box1-surau.local', '10.168.50.99'))), '10.168.50.99', 5353);
    await clock.advance(3000);
    expect(a.r.claimedHost).toBe('box1-surau.local');
    expect(a.r.number).toBe(1);
  });

  it('M1: while a forged response has the box re-probing a name it holds, it keeps answering for it; the re-probe is logged once', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const log: string[] = [];
    const a = node(bus, clock, ME, 1, { log });
    await clock.advance(2000);
    expect(a.r.claimedHost).toBe('box1-surau.local');
    a.t.deliver(encodeMessage(response(aRecord('box1-surau.local', '10.168.50.99'))), '10.168.50.99', 5353);
    // inside the re-probe: a question for the name is still answered
    const before = bus.log.length;
    a.t.deliver(encodeMessage(query('box1-surau.local')), '10.168.50.77', 5353);
    expect(replies(bus, before).length).toBeGreaterThan(0);
    // a second forged response 10 s later starts another re-probe; the log has one line for both
    await clock.advance(11_000);
    a.t.deliver(encodeMessage(response(aRecord('box1-surau.local', '10.168.50.99'))), '10.168.50.99', 5353);
    await clock.advance(3000);
    expect(a.r.claimedHost).toBe('box1-surau.local');
    expect(log.filter((m) => m.includes('another host answered'))).toHaveLength(1);
  });

  it('a legacy unicast asker (source port not 5353) is answered by unicast with a short TTL', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const a = node(bus, clock, ME);
    const asker = bus.node();
    asker.join({ addr: '10.168.50.77', prefix: 24, ident: 'x' });
    await clock.advance(2000);
    const before = bus.log.length;
    a.t.deliver(encodeMessage(query('box1-surau.local', DnsType.A, { id: 0x4242 })), '10.168.50.77', 40001);
    const sent = bus.log.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.multicast).toBe(false);
    expect(sent[0]!.to).toBe('10.168.50.77:40001');
    const m = decodeMessage(sent[0]!.data)!;
    expect(m.id).toBe(0x4242);
    expect(m.answers.every((r) => r.ttl <= 10)).toBe(true);
  });

  it('rate limit: one source gets at most 20 answers a second; another source is still served', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const a = node(bus, clock, ME);
    await clock.advance(2000);
    const before = bus.log.length;
    for (let i = 0; i < 60; i++) a.t.deliver(encodeMessage(query('box1-surau.local')), '10.168.50.88', 5353);
    expect(bus.log.length - before).toBe(20);
    a.t.deliver(encodeMessage(query('box1-surau.local')), '10.168.50.89', 5353);
    expect(bus.log.length - before).toBe(21);
    await clock.advance(1000);
    a.t.deliver(encodeMessage(query('box1-surau.local')), '10.168.50.88', 5353);
    expect(bus.log.length - before).toBe(22);
  });

  it('the global cap holds when many sources send at once', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const a = node(bus, clock, ME);
    await clock.advance(2000);
    const before = bus.log.length;
    for (let i = 0; i < 600; i++) a.t.deliver(encodeMessage(query('box1-surau.local')), `10.168.50.${20 + (i % 200)}`, 5353);
    expect(bus.log.length - before).toBeLessThanOrEqual(200);
  });

  it('fuzz: malformed packets never crash it and it keeps answering', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const logs: string[] = [];
    const a = node(bus, clock, ME, 1, { log: logs });
    await clock.advance(2000);
    const next = rng(77);
    const valid = [encodeMessage(announcement(new MdnsIdentity(2), OTHER)), encodeMessage(probeMessage('box1-surau.local', OTHER)), encodeMessage(query('box1-surau.local'))];
    for (let i = 0; i < 3000; i++) {
      const len = Math.floor(next() * 200);
      const b = Buffer.alloc(len);
      for (let k = 0; k < len; k++) b[k] = Math.floor(next() * 256);
      expect(() => a.t.deliver(b, `10.168.50.${100 + (i % 100)}`, 5353)).not.toThrow();
    }
    for (let i = 0; i < 3000; i++) {
      const b = Buffer.from(valid[i % valid.length]!);
      for (let k = 0; k < 3; k++) b[Math.floor(next() * b.length)] = Math.floor(next() * 256);
      expect(() => a.t.deliver(b, `10.168.50.${100 + (i % 100)}`, 5353)).not.toThrow();
      if (i % 50 === 0) await clock.advance(1000); // the rate-limit windows move on
    }
    await clock.advance(5000);
    expect(a.r.bound).toBe(true);
    const before = bus.log.length;
    a.t.deliver(encodeMessage(query(a.r.claimedHost ?? 'box1-surau.local')), '10.168.50.42', 5353);
    expect(bus.log.length).toBeGreaterThan(before);
    expect(logs.filter((l) => l.includes('step failed'))).toEqual([]);
  });

  it('a socket that cannot be bound reports it, keeps trying with a back-off and recovers; nothing throws', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const t = bus.node();
    t.failOpen = Object.assign(new Error('in use'), { code: 'EADDRINUSE' });
    const status: [boolean, string | null][] = [];
    const r = new MdnsResponder({ transport: t, clock, random: fixed, onStatus: (b, why) => status.push([b, why]) });
    r.start(1, [IFACE]);
    await clock.advance(0);
    expect(r.bound).toBe(false);
    expect(r.failure).toBe('bind: EADDRINUSE');
    await clock.advance(4000);
    expect(t.opened).toBe(0);
    t.failOpen = null;
    await clock.advance(1100); // 5 s after the first try
    expect(r.bound).toBe(true);
    expect(r.failure).toBeNull();
    await clock.advance(2000);
    expect(r.claimedHost).toBe('box1-surau.local');
    expect(status).toEqual([[false, 'bind: EADDRINUSE'], [true, null]]);
  });

  it('a socket that dies later drops the name, then comes back and claims again', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const a = node(bus, clock, ME);
    await clock.advance(2000);
    expect(a.r.claimedHost).toBe('box1-surau.local');
    a.t.die('ECONNRESET');
    expect(a.r.bound).toBe(false);
    expect(a.r.claimedHost).toBeNull();
    await clock.advance(5100);
    expect(a.r.bound).toBe(true);
    await clock.advance(2000);
    expect(a.r.claimedHost).toBe('box1-surau.local');
  });

  it('stop sends a goodbye (TTL 0) for the claimed name and closes the socket', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const a = node(bus, clock, ME);
    await clock.advance(2000);
    const before = bus.log.length;
    a.r.stop();
    const sent = decoded(bus).slice(before);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((m) => m.answers.every((r) => r.ttl === 0))).toBe(true);
    expect(a.t.closed).toBeGreaterThan(0);
    expect(a.r.claimedHost).toBeNull();
  });

  it('losing the only interface drops the name; it comes back with the interface', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const a = node(bus, clock, ME);
    await clock.advance(2000);
    a.r.updateInterfaces([]);
    expect(a.r.claimedHost).toBeNull();
    await clock.advance(1000);
    a.r.updateInterfaces([IFACE]);
    await clock.advance(2000);
    expect(a.r.claimedHost).toBe('box1-surau.local');
  });
});

describe('UdpTransport (real sockets, loopback)', () => {
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  async function until(cond: () => boolean, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await wait(25);
  }

  it('claims over a real socket and answers a unicast asker with the box address', async () => {
    const transport = new UdpTransport(0, false, '127.0.0.2');
    const r = new MdnsResponder({ transport, random: () => 0, allowNonPrivate: true });
    r.start(1, [{ addr: '127.0.0.2', prefix: 8, ident: 'lo' }]);
    try {
      await until(() => r.claimedHost !== null, 4000);
      expect(r.claimedHost).toBe('box1-surau.local');
      const asker = createSocket('udp4');
      const got = new Promise<Buffer>((resolve) => asker.once('message', (m) => resolve(m)));
      await new Promise<void>((resolve) => asker.bind(0, '127.0.0.1', resolve));
      asker.send(encodeMessage(query('box1-surau.local', DnsType.A, { id: 7 })), transport.localPort, '127.0.0.2');
      const reply = decodeMessage(await Promise.race([got, wait(3000).then(() => Buffer.alloc(0))]));
      asker.close();
      expect(reply).not.toBeNull();
      expect(reply!.id).toBe(7);
      expect(reply!.answers[0]!.data).toEqual({ kind: 'A', addr: '127.0.0.2' });
    } finally {
      r.stop();
    }
  }, 15_000);

  it('shares the port with another mDNS service that bound it with address reuse (Bonjour)', async () => {
    const other = createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise<void>((resolve) => other.bind(0, '0.0.0.0', resolve));
    const port = other.address().port;
    const t = new UdpTransport(port, false);
    await expect(t.open({ onPacket: () => undefined, onError: () => undefined })).resolves.toBeUndefined();
    expect(t.localPort).toBe(port);
    t.close();
    other.close();
  });

  it('a port held without reuse is a reported failure, not a crash', async () => {
    const holder = createSocket('udp4');
    await new Promise<void>((resolve) => holder.bind(0, '0.0.0.0', resolve));
    const port = holder.address().port;
    const t = new UdpTransport(port, false);
    // the responder must report it and carry on (open() rejects; Windows may also allow a reuse bind, so only a rejection is checked)
    const outcome = await t.open({ onPacket: () => undefined, onError: () => undefined }).then(
      () => 'opened',
      (e: NodeJS.ErrnoException) => e.code ?? 'error',
    );
    t.close();
    holder.close();
    expect(['opened', 'EADDRINUSE', 'EACCES']).toContain(outcome);
    const bus = new MemoryBus();
    const n = bus.node();
    n.failOpen = Object.assign(new Error('x'), { code: 'EADDRINUSE' });
    const r = new MdnsResponder({ transport: n, clock: new FakeClock(), random: () => 0 });
    r.start(1, [IFACE]);
    await Promise.resolve();
    await Promise.resolve();
    expect(r.bound).toBe(false);
  });
});
