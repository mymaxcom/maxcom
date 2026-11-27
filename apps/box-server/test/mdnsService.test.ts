import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeMessage, DnsType, encodeMessage, isResponse } from '../src/mdns/codec.ts';
import type { DnsMessage } from '../src/mdns/codec.ts';
import { startBoxNaming, listLanInterfaces, prefixOf } from '../src/mdns/service.ts';
import type { BoxNaming } from '../src/mdns/service.ts';
import { BoxNameStore, MAX_RENUMBERS_PER_DAY } from '../src/mdns/store.ts';
import { FakeClock, MemoryBus } from './support/mdnsBus.ts';

const dirs: string[] = [];
const running: BoxNaming[] = [];
afterEach(() => {
  for (const r of running.splice(0)) r.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-name-'));
  dirs.push(d);
  return d;
}

describe('BoxNameStore (data/box-name.json)', () => {
  const NOW = new Date('2026-11-24T10:00:00Z');

  it('writes the claim and reads it back; claimedAt moves only when the number does', () => {
    const f = join(tmp(), 'box-name.json');
    const s = new BoxNameStore(f);
    expect(s.read()).toBeNull();
    s.persistClaim(3, NOW);
    expect(s.read()).toEqual({ n: 3, claimedAt: '2026-11-24T10:00:00Z', renumbers: [] });
    expect(readFileSync(f, 'utf8')).toBe('{"n":3,"claimedAt":"2026-11-24T10:00:00Z"}\n');
    s.persistClaim(3, new Date('2026-12-01T00:00:00Z'));
    expect(s.read()!.claimedAt).toBe('2026-11-24T10:00:00Z');
    s.persistClaim(4, new Date('2026-12-01T00:00:00Z'));
    expect(s.read()).toMatchObject({ n: 4, claimedAt: '2026-12-01T00:00:00Z' });
  });

  it('rejects a damaged, oversized or odd file as "no name" (never a guess)', () => {
    const d = tmp();
    const f = join(d, 'box-name.json');
    const s = new BoxNameStore(f);
    const bad: string[] = [
      '',
      'not json',
      '[]',
      'null',
      '{"n":0,"claimedAt":"2026-11-24T10:00:00Z"}',
      '{"n":100,"claimedAt":"2026-11-24T10:00:00Z"}',
      '{"n":1.5,"claimedAt":"2026-11-24T10:00:00Z"}',
      '{"n":"1","claimedAt":"2026-11-24T10:00:00Z"}',
      '{"n":-1,"claimedAt":"2026-11-24T10:00:00Z"}',
      '{"n":1}',
      '{"n":1,"claimedAt":"yesterday"}',
      '{"n":1,"claimedAt":"2026-11-24T10:00:00Z","renumbers":"x"}',
      `{"n":1,"claimedAt":"2026-11-24T10:00:00Z","pad":"${'x'.repeat(2000)}"}`,
    ];
    for (const text of bad) {
      writeFileSync(f, text);
      expect(s.read(), text.slice(0, 60)).toBeNull();
    }
    // a folder where the file should be
    rmSync(f);
    mkdirSync(f);
    expect(s.read()).toBeNull();
  });

  it('keeps only whole numbers as renumber times and at most 16 of them', () => {
    const f = join(tmp(), 'box-name.json');
    writeFileSync(f, `{"n":2,"claimedAt":"2026-11-24T10:00:00Z","renumbers":[1,"x",2.5,-3,${Array.from({ length: 30 }, (_, i) => 100 + i).join(',')}]}`);
    const r = new BoxNameStore(f).read()!;
    expect(r.renumbers.length).toBe(16);
    expect(r.renumbers.every((t) => Number.isInteger(t) && t >= 0)).toBe(true);
  });

  it('the renumber cap: three a day, the fourth is refused, a day later it is free again', () => {
    const s = new BoxNameStore(join(tmp(), 'box-name.json'));
    expect(s.tryRecordRenumber(NOW)).toBe(true); // no claim yet: nothing to cap
    s.persistClaim(1, NOW);
    for (let i = 0; i < MAX_RENUMBERS_PER_DAY; i++) expect(s.tryRecordRenumber(new Date(NOW.getTime() + i * 1000))).toBe(true);
    expect(s.renumbersInLastDay(new Date(NOW.getTime() + 10_000))).toBe(3);
    expect(s.tryRecordRenumber(new Date(NOW.getTime() + 10_000))).toBe(false);
    expect(s.tryRecordRenumber(new Date(NOW.getTime() + 25 * 3_600_000))).toBe(true);
    // the record survives a new claim number
    s.persistClaim(2, new Date(NOW.getTime() + 25 * 3_600_000 + 1000));
    expect(s.read()!.renumbers.length).toBeGreaterThan(0);
  });

  it('leaves no temporary file behind', () => {
    const d = tmp();
    new BoxNameStore(join(d, 'box-name.json')).persistClaim(1, NOW);
    expect(existsSync(join(d, `.box-name.${process.pid}.tmp`))).toBe(false);
  });
});

describe('interfaces', () => {
  it('prefixOf reads a contiguous netmask only', () => {
    expect(prefixOf('255.255.255.0')).toBe(24);
    expect(prefixOf('255.255.0.0')).toBe(16);
    expect(prefixOf('255.255.255.252')).toBe(30);
    for (const bad of ['255.0.255.0', '0.255.255.255', '255.255.255', '256.0.0.0', 'x', '']) expect(prefixOf(bad), bad).toBeNull();
  });

  it('listLanInterfaces gives private, non-loopback IPv4 addresses only', () => {
    for (const i of listLanInterfaces()) {
      expect(i.addr).toMatch(/^(10\.|172\.(1[6-9]|2\d|3[01])\.|10\.168\.|169\.254\.)/);
      expect(i.prefix).toBeGreaterThanOrEqual(8);
      expect(i.prefix).toBeLessThanOrEqual(30);
    }
  });
});

describe('startBoxNaming', () => {
  const ME = { addr: '10.168.50.10', prefix: 24, ident: 'eth0' };
  const OTHER = { addr: '10.168.50.11', prefix: 24, ident: 'eth0' };

  function box(bus: MemoryBus, clock: FakeClock, dir: string, iface = ME, extra: Partial<Parameters<typeof startBoxNaming>[0]> = {}) {
    const names: string[][] = [[]];
    const checks = { n: 0 };
    const logs: string[] = [];
    const naming = startBoxNaming({
      dataDir: dir,
      certNames: () => names[0]!,
      checkCert: () => void checks.n++,
      log: (m) => logs.push(m),
      clock,
      random: () => 0,
      transport: bus.node(),
      interfaces: () => [iface],
      now: () => new Date('2026-11-24T10:00:00Z'),
      ...extra,
    });
    running.push(naming);
    return { naming, names, checks, logs };
  }

  it('claims box1 on a fresh box, stores it, and keeps it across a restart', async () => {
    const clock = new FakeClock();
    const dir = tmp();
    const a = box(new MemoryBus(), clock, dir);
    await clock.advance(2000);
    expect(a.naming.responder.claimedHost).toBe('box1-surau.local');
    expect(JSON.parse(readFileSync(join(dir, 'box-name.json'), 'utf8'))).toMatchObject({ n: 1 });
    a.naming.stop();
    // restart on the same folder with a stored number 4: it starts probing at 4 and keeps it
    writeFileSync(join(dir, 'box-name.json'), '{"n":4,"claimedAt":"2026-11-14T10:00:00Z"}\n');
    const clock2 = new FakeClock();
    const b = box(new MemoryBus(), clock2, dir);
    await clock2.advance(2000);
    expect(b.naming.responder.number).toBe(4);
  });

  it('two boxes on one LAN: the second ends on box2 and stores 2; the first keeps 1', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const d1 = tmp();
    const d2 = tmp();
    const a = box(bus, clock, d1, ME);
    await clock.advance(2000);
    const b = box(bus, clock, d2, OTHER);
    await clock.advance(4000);
    expect(a.naming.responder.claimedHost).toBe('box1-surau.local');
    expect(b.naming.responder.claimedHost).toBe('box2-surau.local');
    expect(JSON.parse(readFileSync(join(d1, 'box-name.json'), 'utf8')).n).toBe(1);
    expect(JSON.parse(readFileSync(join(d2, 'box-name.json'), 'utf8')).n).toBe(2);
  });

  it('asks the server to look at the certificate while the claimed name is missing from it, and stops when it is there', async () => {
    const clock = new FakeClock();
    const a = box(new MemoryBus(), clock, tmp(), ME, { pollMs: 10_000 });
    await clock.advance(2000);
    expect(a.checks.n).toBe(0);
    await clock.advance(60_000);
    expect(a.checks.n).toBeGreaterThanOrEqual(1);
    const seen = a.checks.n;
    a.names[0] = ['localhost', 'box1-surau.local'];
    await clock.advance(120_000);
    expect(a.checks.n).toBe(seen);
  });

  it('a claim that cannot be saved is logged and does not stop the box answering', async () => {
    const clock = new FakeClock();
    const dir = tmp();
    mkdirSync(join(dir, 'box-name.json')); // a folder where the file belongs: every write fails
    const a = box(new MemoryBus(), clock, dir);
    await clock.advance(2000);
    expect(a.naming.responder.claimedHost).toBe('box1-surau.local');
    expect(a.logs.some((l) => l.includes('not saved'))).toBe(true);
  });

  it('with the renumber record unsaveable, a spoofer still gets at most three renumbers a day', async () => {
    const clock = new FakeClock();
    const dir = tmp();
    mkdirSync(join(dir, 'box-name.json'));
    const a = box(new MemoryBus(), clock, dir);
    await clock.advance(2000);
    const forge = (n: number): Buffer =>
      encodeMessage({ id: 0, flags: 0x8400, questions: [], answers: [{ name: `box${n}-surau.local`, type: DnsType.A, data: { kind: 'A', addr: '10.168.50.99' }, ttl: 120, cacheFlush: true }], authorities: [], additionals: [] });
    const hear = (b: Buffer): void => (a.naming.responder as unknown as { onPacket(d: Buffer, ad: string, p: number): void }).onPacket(b, '10.168.50.99', 5353);
    for (let i = 0; i < 8; i++) {
      // the intruder answers again and again for whatever number the box is on, also to its re-probes
      for (let k = 0; k < 8; k++) {
        hear(forge(a.naming.responder.number ?? 1));
        await clock.advance(200);
      }
      await clock.advance(70_000);
    }
    // 1 + the cap of three: no further, however long the forged answers go on
    expect(a.naming.responder.number).toBe(1 + MAX_RENUMBERS_PER_DAY);
    expect(a.naming.responder.claimedHost).toBe(`box${1 + MAX_RENUMBERS_PER_DAY}-surau.local`);
  });

  it('stop sends goodbyes for the claimed name', async () => {
    const clock = new FakeClock();
    const bus = new MemoryBus();
    const a = box(bus, clock, tmp());
    await clock.advance(2000);
    const before = bus.log.length;
    a.naming.stop();
    const sent = bus.log.slice(before).map((s) => decodeMessage(s.data)).filter((m): m is DnsMessage => m !== null);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((m) => isResponse(m) && m.answers.every((r) => r.ttl === 0))).toBe(true);
  });
});
