import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEGACY_MAX_BYTES, LEGACY_MAX_QUESTIONS, MdnsIdentity, replyTo, SERVICE_PORT } from '../src/mdns/answerer.ts';
import { decodeMessage, DnsType, encodeMessage, isResponse } from '../src/mdns/codec.ts';
import type { DnsMessage } from '../src/mdns/codec.ts';
import { MdnsResponder, UdpTransport } from '../src/mdns/responder.ts';
import type { IfaceAddr, UdpSocketLike } from '../src/mdns/responder.ts';
import { startBoxNaming } from '../src/mdns/service.ts';
import type { BoxNaming } from '../src/mdns/service.ts';
import { MAX_RENUMBERS_PER_DAY } from '../src/mdns/store.ts';
import { FakeClock, MemoryBus } from './support/mdnsBus.ts';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const WIFI: IfaceAddr = { addr: '10.168.50.10', prefix: 24, ident: 'wifi' };
const VPN: IfaceAddr = { addr: '10.0.0.5', prefix: 24, ident: 'vpn' };

/**
 * A socket that defers every send to a later tick and sends from the interface that is set AT THAT MOMENT, like the
 * real one (the address lookup of Node's send is asynchronous).
 */
class DeferredSocket implements UdpSocketLike {
  iface = '';
  closed = false;
  readonly sent: { iface: string; data: Buffer; closedAtSend: boolean }[] = [];
  private onListening: (() => void) | null = null;
  on(): unknown {
    return this;
  }
  once(event: string, fn: () => void): unknown {
    if (event === 'listening') this.onListening = fn;
    return this;
  }
  bind(): unknown {
    setImmediate(() => this.onListening?.());
    return this;
  }
  address(): { port: number } {
    return { port: 5353 };
  }
  setMulticastTTL(): unknown {
    return this;
  }
  setMulticastLoopback(): unknown {
    return this;
  }
  setMulticastInterface(addr: string): unknown {
    this.iface = addr;
    return this;
  }
  addMembership(): unknown {
    return this;
  }
  dropMembership(): unknown {
    return this;
  }
  send(data: Buffer, _port: number, _address: string, cb: (e: Error | null) => void): unknown {
    setImmediate(() => {
      this.sent.push({ iface: this.iface, data, closedAtSend: this.closed });
      cb(null);
    });
    return this;
  }
  close(): unknown {
    this.closed = true;
    return this;
  }
}

const noop = { onPacket: () => undefined, onError: () => undefined };
const message = (n: number): Buffer => Buffer.from([n]);

describe('F2 / F13: the real transport with deferred sends', () => {
  it('each multicast leaves by the interface it was asked for (two interfaces)', async () => {
    const sock = new DeferredSocket();
    const t = new UdpTransport(5353, true, '0.0.0.0', () => sock);
    await t.open(noop);
    t.sendMulticast(WIFI, message(1));
    t.sendMulticast(VPN, message(2));
    t.sendMulticast(WIFI, message(3));
    for (let i = 0; i < 6; i++) await tick();
    expect(sock.sent.map((s) => [s.data[0], s.iface])).toEqual([
      [1, WIFI.addr],
      [2, VPN.addr],
      [3, WIFI.addr],
    ]);
    t.close();
  });

  it('close waits for the queued goodbyes, then closes once', async () => {
    const sock = new DeferredSocket();
    const t = new UdpTransport(5353, true, '0.0.0.0', () => sock);
    await t.open(noop);
    t.sendMulticast(WIFI, message(1));
    t.sendMulticast(VPN, message(2));
    t.close();
    expect(sock.closed).toBe(false);
    for (let i = 0; i < 6; i++) await tick();
    expect(sock.sent.map((s) => s.data[0])).toEqual([1, 2]);
    expect(sock.sent.every((s) => !s.closedAtSend)).toBe(true);
    expect(sock.closed).toBe(true);
    // a send after the close is dropped
    t.sendMulticast(WIFI, message(9));
    await tick();
    expect(sock.sent).toHaveLength(2);
  });

  it('the responder stop leaves the goodbyes on the wire before the socket closes', async () => {
    const sock = new DeferredSocket();
    const clock = new FakeClock();
    const r = new MdnsResponder({ transport: new UdpTransport(5353, true, '0.0.0.0', () => sock), clock, random: () => 0 });
    r.start(1, [WIFI, VPN]);
    await clock.advance(2000);
    for (let i = 0; i < 20; i++) await tick();
    expect(r.claimedHost).toBe('box1-surau.local');
    const before = sock.sent.length;
    r.stop();
    for (let i = 0; i < 20; i++) await tick();
    const goodbyes = sock.sent.slice(before).map((s) => ({ ...s, m: decodeMessage(s.data) }));
    expect(goodbyes.map((g) => g.iface).sort()).toEqual([VPN.addr, WIFI.addr]);
    expect(goodbyes.every((g) => g.m !== null && isResponse(g.m) && g.m.answers.every((a) => a.ttl === 0))).toBe(true);
    expect(goodbyes.every((g) => !g.closedAtSend)).toBe(true);
    expect(sock.closed).toBe(true);
  });
});

describe('S3: a legacy unicast reply stays small and answers only what was asked', () => {
  const id = new MdnsIdentity(1);
  const q = (name: string): DnsMessage['questions'][number] => ({ name, type: DnsType.A, unicastResponse: false });
  const query = (names: string[]): DnsMessage => ({ id: 7, flags: 0, questions: names.map(q), answers: [], authorities: [], additionals: [] });

  it('echoes only the answered question', () => {
    const r = replyTo(id, '10.168.50.10', query(['box1-surau.local', 'other.local']), true);
    expect(r).not.toBeNull();
    expect(r!.message.questions.map((x) => x.name)).toEqual(['box1-surau.local']);
    expect(r!.message.id).toBe(7);
  });

  it('refuses a legacy query with many questions, but a normal asker is still answered', () => {
    const many = query(Array.from({ length: LEGACY_MAX_QUESTIONS + 1 }, () => 'box1-surau.local'));
    expect(replyTo(id, '10.168.50.10', many, true)).toBeNull();
    expect(replyTo(id, '10.168.50.10', many, false)).not.toBeNull();
    const ok = query(Array.from({ length: LEGACY_MAX_QUESTIONS }, () => 'box1-surau.local'));
    expect(replyTo(id, '10.168.50.10', ok, true)).not.toBeNull();
    expect(encodeMessage(replyTo(id, '10.168.50.10', ok, true)!.message).length).toBeLessThan(LEGACY_MAX_BYTES);
  });
});

describe('S4: a full source table drops new sources and never forgets a tracked one', () => {
  it('a flooder keeps its count while rotating sources come and go', async () => {
    const bus = new MemoryBus();
    const clock = new FakeClock();
    const t = bus.node();
    const r = new MdnsResponder({ transport: t, clock, random: () => 0, maxPerSource: 2, maxTrackedSources: 3, allowNonPrivate: true });
    r.start(1, [WIFI]);
    await clock.advance(2000);
    expect(r.claimedHost).toBe('box1-surau.local');
    const ask = (from: string): number => {
      const before = bus.log.length;
      t.deliver(encodeMessage({ id: 0, flags: 0, questions: [{ name: 'box1-surau.local', type: DnsType.A, unicastResponse: false }], authorities: [], answers: [], additionals: [] }), from, 5353);
      return bus.log.length - before;
    };
    const flooder = '10.168.50.77';
    expect(ask(flooder)).toBe(1);
    expect(ask(flooder)).toBe(1);
    expect(ask(flooder)).toBe(0); // over its cap
    expect(ask('10.168.50.80')).toBe(1); // second tracked source
    // the table is full (three): new sources are dropped, not allowed to clear the table
    expect(ask('10.168.50.81')).toBe(1); // third tracked source
    expect(ask('10.168.50.82')).toBe(0);
    expect(ask('10.168.50.83')).toBe(0);
    expect(ask(flooder)).toBe(0); // the flooder was not reset
  });
});

describe('F35: the SRV record names the real HTTPS port', () => {
  it('uses the configured port, 8443 by default', () => {
    const q: DnsMessage = { id: 0, flags: 0, questions: [{ name: 'MAXCOM box1._maxcom._tcp.local', type: DnsType.SRV, unicastResponse: false }], answers: [], authorities: [], additionals: [] };
    const port = (p?: number): number => {
      const r = replyTo(new MdnsIdentity(1, null, null, p), WIFI.addr, q, false)!;
      const srv = r.message.answers.find((a) => a.type === DnsType.SRV)!;
      return srv.data.kind === 'SRV' ? srv.data.port : -1;
    };
    expect(port()).toBe(SERVICE_PORT);
    expect(port(9443)).toBe(9443);
    expect(port(0)).toBe(SERVICE_PORT);
  });
});

describe('box naming service: renumber cap before the first claim, advertising', () => {
  const dirs: string[] = [];
  const running: BoxNaming[] = [];
  afterEach(() => {
    for (const r of running.splice(0)) r.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'surau-fx3-'));
    dirs.push(d);
    return d;
  };
  const ME: IfaceAddr = { addr: '10.168.50.10', prefix: 24, ident: 'eth0' };

  function box(bus: MemoryBus, clock: FakeClock, dir: string, certNames: () => string[], iface: IfaceAddr = ME) {
    const t = bus.node();
    const naming = startBoxNaming({
      dataDir: dir, certNames, clock, random: () => 0, transport: t, interfaces: () => [iface], now: () => new Date('2026-11-24T10:00:00Z'),
    });
    running.push(naming);
    return { naming, t };
  }
  const forge = (n: number): Buffer =>
    encodeMessage({ id: 0, flags: 0x8400, questions: [], answers: [{ name: `box${n}-surau.local`, type: DnsType.A, data: { kind: 'A', addr: '10.168.50.99' }, ttl: 120, cacheFlush: true }], authorities: [], additionals: [] });

  it('S2: a box with a stored name cannot be walked up the numbers by answers to its first probes', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'box-name.json'), '{"n":1,"claimedAt":"2026-11-14T10:00:00Z"}\n');
    const clock = new FakeClock();
    const a = box(new MemoryBus(), clock, dir, () => []);
    // the intruder answers every probe, for whatever number the box is on, from the first moment
    for (let i = 0; i < 40; i++) {
      a.t.deliver(forge(a.naming.responder.number ?? 1), '10.168.50.99', 5353);
      await clock.advance(100);
    }
    await clock.advance(200_000);
    expect(a.naming.responder.number).toBeLessThanOrEqual(1 + MAX_RENUMBERS_PER_DAY);
  });

  it('S2: a box with no stored name still walks past a taken name (first start)', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const first = box(bus, clock, tmp(), () => []);
    await clock.advance(2000);
    const second = box(bus, clock, tmp(), () => [], { addr: '10.168.50.11', prefix: 24, ident: 'eth0' });
    await clock.advance(4000);
    expect(first.naming.responder.claimedHost).toBe('box1-surau.local');
    expect(second.naming.responder.claimedHost).toBe('box2-surau.local');
  });

  it('F14: the numbered name is claimed and defended but advertised only once the certificate carries it', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    let names: string[] = [];
    const a = box(bus, clock, tmp(), () => names);
    await clock.advance(2000);
    expect(a.naming.responder.claimedHost).toBe('box1-surau.local');
    // nothing was announced, and a query for the name is not answered
    const answered = (): number => {
      const before = bus.log.length;
      a.t.deliver(encodeMessage({ id: 0, flags: 0, questions: [{ name: 'box1-surau.local', type: DnsType.A, unicastResponse: false }], authorities: [], answers: [], additionals: [] }), '10.168.50.77', 5353);
      return bus.log.length - before;
    };
    expect(bus.log.filter((s) => { const m = decodeMessage(s.data); return m !== null && isResponse(m); })).toHaveLength(0);
    expect(answered()).toBe(0);
    // a probe for the name is still defended
    const before = bus.log.length;
    a.t.deliver(encodeMessage({ id: 0, flags: 0, questions: [{ name: 'box1-surau.local', type: DnsType.ANY, unicastResponse: false }], authorities: [{ name: 'box1-surau.local', type: DnsType.A, data: { kind: 'A', addr: '10.168.50.88' }, ttl: 120, cacheFlush: false }], answers: [], additionals: [] }), '10.168.50.88', 5353);
    expect(bus.log.length).toBeGreaterThan(before);
    // the renewed leaf now carries the name: it is announced and answered
    names = ['localhost', 'box1-surau.local'];
    const mark = bus.log.length;
    await clock.advance(10_500);
    expect(bus.log.slice(mark).some((s) => { const m = decodeMessage(s.data); return m !== null && isResponse(m) && m.answers.some((x) => x.ttl > 0 && x.type === DnsType.A); })).toBe(true);
    expect(answered()).toBe(1);
  });

  it('F35: the SRV port of the announcement is the HTTPS port given', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const t = bus.node();
    const naming = startBoxNaming({
      dataDir: tmp(), certNames: () => ['box1-surau.local'], clock, random: () => 0, transport: t, interfaces: () => [ME], httpsPort: 9443,
    });
    running.push(naming);
    await clock.advance(12_000);
    const srv = bus.log.map((s) => decodeMessage(s.data)).flatMap((m) => m?.answers ?? []).find((a) => a.type === DnsType.SRV && a.ttl > 0);
    expect(srv?.data).toMatchObject({ kind: 'SRV', port: 9443 });
  });
});
