import { describe, expect, it } from 'vitest';
import { readZipEntries, ZipError } from '../src/files/zipRead.ts';
import { writeStoredZip } from '../src/files/zipWrite.ts';
import { buildZip } from './support/zipBuild.ts';

const text = (s: string): Buffer => Buffer.from(s, 'utf8');
const all = (): boolean => true;

describe('readZipEntries', () => {
  it('returns the wanted entries only, stored and deflated', () => {
    const zip = buildZip([
      { name: 'a.txt', data: text('alpha'), method: 8 },
      { name: 'b.txt', data: text('bravo'), method: 0 },
      { name: 'c.txt', data: text('charlie') },
      { name: 'dir/', data: Buffer.alloc(0), method: 0 },
    ]);
    const got = readZipEntries(zip, (n) => n === 'a.txt' || n === 'b.txt');
    expect([...got.keys()].sort()).toEqual(['a.txt', 'b.txt']);
    expect(got.get('a.txt')!.toString()).toBe('alpha');
    expect(got.get('b.txt')!.toString()).toBe('bravo');
  });

  it('reads what the in-house writer writes', () => {
    const zip = writeStoredZip([{ name: 'x/y.xml', data: text('<a/>') }, { name: 'z.txt', data: text('zed') }]);
    const got = readZipEntries(zip, all);
    expect(got.get('x/y.xml')!.toString()).toBe('<a/>');
    expect(got.get('z.txt')!.toString()).toBe('zed');
  });

  it('refuses an entry that declares more than the per-entry cap', () => {
    const zip = buildZip([{ name: 'big.bin', data: text('hi'), declaredSize: 100 * 1024 * 1024 }]);
    expect(() => readZipEntries(zip, all)).toThrow(/entry too large/);
  });

  it('stops a deflate bomb at its declared size, never at memory', () => {
    const bomb = Buffer.alloc(30 * 1024 * 1024, 0x41);
    const zip = buildZip([{ name: 'bomb.bin', data: bomb, declaredSize: 1000 }]);
    expect(() => readZipEntries(zip, all)).toThrow(/too large|damaged/);
    // honest 30 MB under the cap inflates fine
    const ok = buildZip([{ name: 'ok.bin', data: bomb }]);
    expect(readZipEntries(ok, all).get('ok.bin')!.length).toBe(bomb.length);
  });

  it('refuses a total over the archive cap', () => {
    const zip = buildZip([{ name: 'a', data: Buffer.alloc(1000) }, { name: 'b', data: Buffer.alloc(1000) }]);
    expect(() => readZipEntries(zip, all, { maxEntries: 10, maxEntryBytes: 1500, maxTotalBytes: 1800 })).toThrow(/archive too large/);
  });

  it('refuses 2,001 entries and accepts 2,000', () => {
    const mk = (n: number) => buildZip(Array.from({ length: n }, (_, i) => ({ name: `f${i}.txt`, data: text('x'), method: 0 as const })));
    expect(() => readZipEntries(mk(2001), () => false)).toThrow(/too many entries/);
    expect(readZipEntries(mk(2000), (n) => n === 'f7.txt').get('f7.txt')!.toString()).toBe('x');
  });

  it.each(['../x', '/x', 'a\\b', 'a/../../x', 'xl/worksheets/../../x', 'C:/x', 'a//b', 'a/./b', 'a\u0007b', 'x'.repeat(201), ''])(
    'refuses the unsafe name %j',
    (name) => {
      const zip = buildZip([{ name: name === '' ? 'placeholder' : name, data: text('x'), method: 0 }]);
      if (name === '') return; // an empty name cannot be written by the builder; the reader rule is covered by badEntryName
      expect(() => readZipEntries(zip, () => false)).toThrow(ZipError);
    },
  );

  it('lenient mode leaves a bad name out and reports it', () => {
    const zip = buildZip([{ name: '../evil.txt', data: text('x'), method: 0 }, { name: 'good.txt', data: text('ok'), method: 0 }]);
    const skipped: string[] = [];
    const got = readZipEntries(zip, all, undefined, { lenient: true, onSkip: (d) => skipped.push(d) });
    expect([...got.keys()]).toEqual(['good.txt']);
    expect(skipped).toHaveLength(1);
  });

  it('refuses a duplicate name, encryption, an odd method, a wrong checksum and a lying local header', () => {
    expect(() => readZipEntries(buildZip([{ name: 'a', data: text('1'), method: 0 }, { name: 'a', data: text('2'), method: 0 }]), () => false)).toThrow(/duplicate/);
    expect(() => readZipEntries(buildZip([{ name: 'a', data: text('1'), method: 0, flags: 1 }]), all)).toThrow(/encrypted/);
    expect(() => readZipEntries(buildZip([{ name: 'a', data: text('1'), method: 0, crc: 12345 }]), all)).toThrow(/checksum/);
    expect(() => readZipEntries(buildZip([{ name: 'a', data: text('1'), method: 0, localName: 'b' }]), all)).toThrow(/local header/);
    const odd = buildZip([{ name: 'a', data: text('1'), method: 0 }]);
    odd.writeUInt16LE(12, odd.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
    expect(() => readZipEntries(odd, all)).toThrow(/method/);
  });

  it('refuses things that are not zips, and never throws anything but ZipError', () => {
    for (const junk of [Buffer.alloc(0), Buffer.from('not a zip at all, just text'), Buffer.alloc(100, 0x50)]) {
      expect(() => readZipEntries(junk, all)).toThrow(ZipError);
    }
    const good = buildZip([{ name: 'a', data: text('1') }]);
    for (let cut = 1; cut < good.length; cut += 7) {
      try { readZipEntries(good.subarray(0, cut), all); } catch (e) { expect(e).toBeInstanceOf(ZipError); }
    }
  });
});

describe('writeStoredZip', () => {
  it('refuses unsafe or repeated names and an empty list', () => {
    expect(() => writeStoredZip([{ name: '../x', data: text('1') }])).toThrow(ZipError);
    expect(() => writeStoredZip([{ name: 'a', data: text('1') }, { name: 'a', data: text('2') }])).toThrow(ZipError);
    expect(() => writeStoredZip([])).toThrow(ZipError);
  });
});
