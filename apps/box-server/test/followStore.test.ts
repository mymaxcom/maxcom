import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFollowStore, parseFollowRecord } from '../src/follow/store.ts';
import type { FollowRecord } from '../src/follow/store.ts';
import { identityPub } from '../src/link/sign.ts';
import { ephemeralIdentity } from '../src/setup/identity.ts';

const BOX_ID = 'a1b2c3d4e5f60718';
const TOKEN = 'T0kenForTheFollowerTvAbcdefghijklmnopqrs'.padEnd(43, 'x').slice(0, 43);
const master = ephemeralIdentity();

const record = (over: Partial<FollowRecord> = {}): FollowRecord => ({
  v: 1,
  linkId: 'ab'.repeat(16),
  masterBoxId: '0123456789abcdef',
  masterKeyFp: master.keyFp,
  masterPub: identityPub(master),
  masterCa: 'cd'.repeat(32),
  masterName: 'Surau Al-Hidayah',
  addresses: ['https://10.168.50.11:8443'],
  token: TOKEN,
  deviceId: 'dev_Ruang_Muslimat1',
  linkedAt: '2026-11-22T10:00:00.000Z',
  hadStore: false,
  ...over,
});

let dir: string;
const own = ephemeralIdentity();
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'surau-follow-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const file = (): string => join(dir, 'secret', 'follow.json');

describe('follow store on a data folder', () => {
  it('starts empty: not present, nothing to read', () => {
    const s = createFollowStore(dir, own, BOX_ID);
    expect(s.present()).toBe(false);
    expect(s.read()).toBeNull();
  });

  it('round trip: write, read, present, a new store object reads the same record', () => {
    const s = createFollowStore(dir, own, BOX_ID);
    s.write(record());
    expect(s.present()).toBe(true);
    expect(s.read()).toEqual(record());
    const again = createFollowStore(dir, own, BOX_ID);
    expect(again.present()).toBe(true);
    expect(again.read()).toEqual(record());
  });

  it('the file is sealed: no token, name, address or key in its text, and it is not the record as JSON', () => {
    createFollowStore(dir, own, BOX_ID).write(record());
    const text = readFileSync(file(), 'utf8');
    for (const secret of [TOKEN, 'Surau Al-Hidayah', '10.168.50.11', record().masterCa, record().linkId, record().deviceId, record().masterPub.x]) {
      expect(text, secret).not.toContain(secret);
    }
    const outer = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(outer).sort()).toEqual(['sealed', 'v']);
    expect(parseFollowRecord(outer)).toBeNull();
    expect(typeof outer.sealed).toBe('string');
    // the temp file of an atomic write is gone
    expect(() => readFileSync(`${file()}.tmp`)).toThrow();
  });

  it('a record sealed for another box id reads as null but present() stays true', () => {
    createFollowStore(dir, own, BOX_ID).write(record());
    const other = createFollowStore(dir, own, 'ffffffffffffffff');
    expect(other.present()).toBe(true);
    expect(other.read()).toBeNull();
  });

  it('a record sealed for another identity reads as null but present() stays true', () => {
    createFollowStore(dir, own, BOX_ID).write(record());
    const other = createFollowStore(dir, ephemeralIdentity(), BOX_ID);
    expect(other.present()).toBe(true);
    expect(other.read()).toBeNull();
  });

  it('a copied file does not open on another box even with the same box id and a new key', () => {
    createFollowStore(dir, own, BOX_ID).write(record());
    const dir2 = mkdtempSync(join(tmpdir(), 'surau-follow-'));
    try {
      const raw = readFileSync(file(), 'utf8');
      createFollowStore(dir2, own, BOX_ID).write(record());
      writeFileSync(join(dir2, 'secret', 'follow.json'), raw);
      expect(createFollowStore(dir2, own, BOX_ID).read()).toEqual(record());
      expect(createFollowStore(dir2, ephemeralIdentity(), BOX_ID).read()).toBeNull();
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('a damaged file: present() true (still a follower, not a master), read() null', () => {
    const s = createFollowStore(dir, own, BOX_ID);
    s.write(record());
    for (const junk of ['', 'not json', '{}', '{"v":1}', '{"v":1,"sealed":"zzzz"}', '{"v":1,"sealed":42}', 'null', '[]']) {
      writeFileSync(file(), junk);
      expect(s.present(), junk).toBe(true);
      expect(s.read(), junk).toBeNull();
      expect(createFollowStore(dir, own, BOX_ID).read(), junk).toBeNull();
    }
    // a flipped byte inside the sealed text
    s.write(record());
    const outer = JSON.parse(readFileSync(file(), 'utf8')) as { v: number; sealed: string };
    const mid = Math.floor(outer.sealed.length / 2);
    const flipped = outer.sealed.slice(0, mid) + (outer.sealed[mid] === 'A' ? 'B' : 'A') + outer.sealed.slice(mid + 1);
    writeFileSync(file(), JSON.stringify({ v: 1, sealed: flipped }));
    expect(createFollowStore(dir, own, BOX_ID).read()).toBeNull();
    // writing again repairs it
    s.write(record());
    expect(s.read()).toEqual(record());
  });

  it('a file changed on disk is read again (the cache follows the file)', () => {
    const s = createFollowStore(dir, own, BOX_ID);
    s.write(record());
    expect(s.read()?.masterName).toBe('Surau Al-Hidayah');
    createFollowStore(dir, own, BOX_ID).write(record({ masterName: 'Surau Ar-Rahman' }));
    expect(s.read()?.masterName).toBe('Surau Ar-Rahman');
  });

  it('clear() removes the file and the record; clearing twice is harmless', () => {
    const s = createFollowStore(dir, own, BOX_ID);
    s.write(record());
    s.clear();
    expect(s.present()).toBe(false);
    expect(s.read()).toBeNull();
    expect(() => readFileSync(file())).toThrow();
    s.clear();
    expect(s.present()).toBe(false);
  });

  it('setAddresses keeps the rest of the record, drops what is not an https origin, de-duplicates and caps at 8', () => {
    const s = createFollowStore(dir, own, BOX_ID);
    s.write(record());
    s.setAddresses(['https://10.168.50.21:8443', 'https://10.168.50.21:8443', 'http://10.168.50.22:8080', 'https://10.0.0.5:8443/path', 'junk']);
    expect(s.read()).toEqual(record({ addresses: ['https://10.168.50.21:8443'] }));
    s.setAddresses(Array.from({ length: 12 }, (_, i) => `https://10.0.0.${i + 1}:8443`));
    expect(s.read()!.addresses).toHaveLength(8);
    expect(s.read()!.token).toBe(TOKEN);
    // nothing usable: the old list stays
    s.setAddresses(['http://x', '']);
    expect(s.read()!.addresses).toHaveLength(8);
    s.setAddresses([]);
    expect(s.read()!.addresses).toHaveLength(8);
  });

  it('setAddresses on a box that follows nobody does nothing', () => {
    const s = createFollowStore(dir, own, BOX_ID);
    s.setAddresses(['https://10.168.50.21:8443']);
    expect(s.present()).toBe(false);
  });

  it('write refuses a record that does not hold together and leaves the old one', () => {
    const s = createFollowStore(dir, own, BOX_ID);
    s.write(record());
    expect(() => s.write(record({ token: 'short' }))).toThrow('follow: bad record');
    expect(s.read()).toEqual(record());
  });
});

describe('follow store in memory (no data folder)', () => {
  it('keeps the record for the life of the object, and clear() drops it', () => {
    const s = createFollowStore(null, own, BOX_ID);
    expect(s.present()).toBe(false);
    s.write(record());
    expect(s.present()).toBe(true);
    expect(s.read()).toEqual(record());
    s.setAddresses(['https://10.168.50.30:8443']);
    expect(s.read()!.addresses).toEqual(['https://10.168.50.30:8443']);
    s.clear();
    expect(s.present()).toBe(false);
    expect(s.read()).toBeNull();
  });
});

describe('strict parse of a follow record', () => {
  it('accepts the good record', () => {
    expect(parseFollowRecord(record())).toEqual(record());
  });

  it('keeps only the known fields', () => {
    const r = parseFollowRecord({ ...record(), extra: 'x', masterPub: { ...record().masterPub, d: 'secret' } }) as unknown as Record<string, unknown>;
    expect(r).not.toBeNull();
    expect(Object.keys(r).sort()).toEqual(Object.keys(record()).sort());
    expect(Object.keys(r.masterPub as object).sort()).toEqual(['crv', 'kty', 'x', 'y']);
  });

  it('refuses a fingerprint that is not the one of the key', () => {
    expect(parseFollowRecord(record({ masterKeyFp: '0'.repeat(16) }))).toBeNull();
    expect(parseFollowRecord(record({ masterKeyFp: ephemeralIdentity().keyFp }))).toBeNull();
    // the key of another box with the first box's fingerprint
    expect(parseFollowRecord(record({ masterPub: identityPub(ephemeralIdentity()) }))).toBeNull();
  });

  const cases: [string, Partial<FollowRecord> | Record<string, unknown>][] = [
    ['http origin', { addresses: ['http://10.168.50.11:8080'] }],
    ['origin with a path', { addresses: ['https://10.168.50.11:8443/api'] }],
    ['origin with credentials', { addresses: ['https://user:pw@10.168.50.11:8443'] }],
    ['no address', { addresses: [] }],
    ['nine addresses', { addresses: Array.from({ length: 9 }, (_, i) => `https://10.0.0.${i + 1}:8443`) }],
    ['address that is not a string', { addresses: [42] }],
    ['address too long', { addresses: [`https://${'a'.repeat(200)}.example:8443`] }],
    ['short token', { token: 'abc' }],
    ['long token', { token: 'a'.repeat(44) }],
    ['token with a bad character', { token: `${'a'.repeat(42)}+` }],
    ['token not a string', { token: 12345 }],
    ['bad link id', { linkId: 'xyz' }],
    ['upper case link id', { linkId: 'AB'.repeat(16) }],
    ['bad master box id', { masterBoxId: '123' }],
    ['bad CA hash', { masterCa: 'cd'.repeat(31) }],
    ['empty master name', { masterName: '' }],
    ['master name over 60', { masterName: 'x'.repeat(61) }],
    ['bad device id', { deviceId: 'a b' }],
    ['short device id', { deviceId: 'abc' }],
    ['bad date', { linkedAt: 'yesterday' }],
    ['hadStore not boolean', { hadStore: 'yes' }],
    ['version 2', { v: 2 }],
    ['wrong curve', { masterPub: { ...record().masterPub, crv: 'P-384' } }],
    ['wrong key type', { masterPub: { ...record().masterPub, kty: 'RSA' } }],
    ['no key', { masterPub: null }],
  ];
  it.each(cases)('refuses %s', (_name, over) => {
    expect(parseFollowRecord({ ...record(), ...over })).toBeNull();
  });

  it.each([[null], [undefined], [42], ['x'], [[]], [true]])('refuses %j', (v) => {
    expect(parseFollowRecord(v)).toBeNull();
  });
});
