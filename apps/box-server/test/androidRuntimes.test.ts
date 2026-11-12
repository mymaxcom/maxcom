import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(repoRoot, 'scripts', 'android', 'fetch-box-runtimes.ps1');
const pinsPath = join(repoRoot, 'scripts', 'android', 'android-pins.json');
const win = process.platform === 'win32';
const tarExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
const PREFIX = './data/data/com.termux/files/usr';

type Pin = { version: string; url: string; file: string; sha256: string; licence: string };
type Pins = Record<string, unknown> & { termux: Record<string, Record<string, Pin>>; mediamtx: Record<string, Pin> };
const pinsJson = JSON.parse(readFileSync(pinsPath, 'utf8')) as Pins;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(prefix = 'maxcom-andrt-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function run(args: string[], timeout = 60_000) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    encoding: 'utf8',
    timeout,
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ---- fixture builders: a tiny ELF32 ARM file, a hand-written ustar, an ar (.deb) archive

function elf32(needed: string[]): Buffer {
  const strs = Buffer.concat([Buffer.from([0]), ...needed.map((n) => Buffer.from(`${n}\0`, 'ascii'))]);
  const offs: number[] = [];
  let o = 1;
  for (const n of needed) {
    offs.push(o);
    o += n.length + 1;
  }
  const phoff = 52;
  const dynOff = phoff + 2 * 32;
  const dynSize = (needed.length + 2) * 8;
  const strOff = dynOff + dynSize;
  const total = strOff + strs.length;
  const b = Buffer.alloc(total);
  b.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1], 0);
  b.writeUInt16LE(3, 16);
  b.writeUInt16LE(40, 18);
  b.writeUInt32LE(1, 20);
  b.writeUInt32LE(phoff, 28);
  b.writeUInt16LE(52, 40);
  b.writeUInt16LE(32, 42);
  b.writeUInt16LE(2, 44);
  // PT_LOAD over the whole file at vaddr 0
  b.writeUInt32LE(1, phoff);
  b.writeUInt32LE(0, phoff + 4);
  b.writeUInt32LE(0, phoff + 8);
  b.writeUInt32LE(total, phoff + 16);
  b.writeUInt32LE(total, phoff + 20);
  // PT_DYNAMIC
  const p2 = phoff + 32;
  b.writeUInt32LE(2, p2);
  b.writeUInt32LE(dynOff, p2 + 4);
  b.writeUInt32LE(dynOff, p2 + 8);
  b.writeUInt32LE(dynSize, p2 + 16);
  b.writeUInt32LE(dynSize, p2 + 20);
  let d = dynOff;
  for (const off of offs) {
    b.writeUInt32LE(1, d);
    b.writeUInt32LE(off, d + 4);
    d += 8;
  }
  b.writeUInt32LE(5, d);
  b.writeUInt32LE(strOff, d + 4);
  strs.copy(b, strOff);
  return b;
}

type Ent = { path: string; data?: Buffer; link?: string };
function ustar(entries: Ent[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    h.write(e.path, 0, 'ascii');
    h.write(e.link ? '0000777\0' : '0000755\0', 100, 'ascii');
    h.write('0000000\0', 108, 'ascii');
    h.write('0000000\0', 116, 'ascii');
    const size = e.link ? 0 : (e.data?.length ?? 0);
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    h.write('00000000000\0', 136, 'ascii');
    h.write('        ', 148, 'ascii');
    h.write(e.link ? '2' : '0', 156, 'ascii');
    if (e.link) h.write(e.link, 157, 'ascii');
    h.write('ustar\0', 257, 'ascii');
    h.write('00', 263, 'ascii');
    let sum = 0;
    for (const x of h) sum += x;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    parts.push(h);
    if (!e.link && e.data && e.data.length > 0) {
      parts.push(e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function arArchive(members: Array<[string, Buffer]>): Buffer {
  const parts: Buffer[] = [Buffer.from('!<arch>\n', 'ascii')];
  for (const [name, data] of members) {
    const h = Buffer.alloc(60, 0x20);
    h.write(`${name}/`, 0, 'ascii');
    h.write('0', 16, 'ascii');
    h.write('0', 28, 'ascii');
    h.write('0', 34, 'ascii');
    h.write('100644', 40, 'ascii');
    h.write(String(data.length), 48, 'ascii');
    h.write('`\n', 58, 'ascii');
    parts.push(h, data);
    if (data.length % 2 === 1) parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}

/** A .deb whose data.tar.xz holds `entries` (names relative to the Termux prefix unless they start with ./). */
function makeDeb(work: string, tag: string, entries: Ent[]): Buffer {
  const dir = join(work, `deb-${tag}`);
  mkdirSync(dir, { recursive: true });
  const tarPath = join(dir, 'data.tar');
  writeFileSync(
    tarPath,
    ustar(entries.map((e) => ({ ...e, path: e.path.startsWith('./') ? e.path : `${PREFIX}/${e.path}` }))),
  );
  const xz = join(dir, 'data.tar.xz');
  const r = spawnSync(tarExe, ['-cJf', xz, `@${tarPath}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar -cJ failed: ${r.stderr}`);
  return arArchive([
    ['debian-binary', Buffer.from('2.0\n')],
    ['control.tar.xz', Buffer.from('x')],
    ['data.tar.xz', readFileSync(xz)],
  ]);
}

function makeMtxTarGz(work: string, tag: string): Buffer {
  const dir = join(work, `mtx-${tag}`);
  mkdirSync(dir, { recursive: true });
  const tarPath = join(dir, 'm.tar');
  writeFileSync(tarPath, ustar([{ path: 'LICENSE', data: Buffer.from('MIT test licence\n') }, { path: 'mediamtx', data: elf32([]) }]));
  const gz = join(dir, 'm.tar.gz');
  const r = spawnSync(tarExe, ['-czf', gz, `@${tarPath}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar -cz failed: ${r.stderr}`);
  return readFileSync(gz);
}

type Fixture = { work: string; cache: string; out: string; pinsFile: string; pins: Pins };
/** Cache pre-filled with three tiny .deb files and a MediaMTX tar.gz, plus a pins file that matches them. */
function fixture(opts: { nodeNeeds?: string[]; extraNodeEntries?: Ent[] } = {}): Fixture {
  const work = tempDir();
  const cache = join(work, 'cache');
  const out = join(work, 'out');
  mkdirSync(cache, { recursive: true });
  const libz = elf32([]);
  const debs: Record<string, { file: string; buf: Buffer; version: string }> = {
    'fake-node': {
      file: 'fake-node_1_2_arm.deb',
      version: '1:2',
      buf: makeDeb(work, 'node', [
        { path: 'bin/node', data: elf32(opts.nodeNeeds ?? ['libc.so', 'libz.so.1']) },
        ...(opts.extraNodeEntries ?? []),
      ]),
    },
    'fake-zlib': {
      file: 'fake-zlib_1.4_arm.deb',
      version: '1.4',
      buf: makeDeb(work, 'zlib', [
        { path: 'lib/libz.so.1.4', data: libz },
        { path: 'lib/libz.so.1', link: 'libz.so.1.4' },
        { path: 'lib/libz.so', link: 'libz.so.1' },
        { path: 'share/doc/fake-zlib/copyright', link: '../../LICENSES/Zlib.txt' },
      ]),
    },
    'fake-certs': {
      file: 'fake-certs_9_all.deb',
      version: '9',
      buf: makeDeb(work, 'certs', [
        { path: 'etc/tls/cert.pem', data: Buffer.from('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n') },
        { path: 'share/doc/fake-certs/copyright', data: Buffer.from('MPL test\n') },
      ]),
    },
  };
  const termuxArm: Record<string, Pin> = {};
  for (const [name, d] of Object.entries(debs)) {
    writeFileSync(join(cache, d.file), d.buf);
    termuxArm[name] = { version: d.version, url: `https://127.0.0.1:9/${d.file}`, file: d.file, sha256: sha(d.buf), licence: 'test' };
  }
  const mtx = makeMtxTarGz(work, 'a');
  writeFileSync(join(cache, 'mediamtx_test_linux_armv7.tar.gz'), mtx);
  const pins: Pins = {
    termux: { arm: termuxArm, aarch64: {} },
    mediamtx: {
      'armeabi-v7a': { version: 'v9.9.9', url: 'https://127.0.0.1:9/mediamtx_test_linux_armv7.tar.gz', file: 'mediamtx_test_linux_armv7.tar.gz', sha256: sha(mtx), licence: 'MIT' },
    },
  };
  const pinsFile = join(work, 'pins.json');
  writeFileSync(pinsFile, JSON.stringify(pins, null, 2));
  return { work, cache, out, pinsFile, pins };
}
function writePins(fx: Fixture) {
  writeFileSync(fx.pinsFile, JSON.stringify(fx.pins, null, 2));
}
const runFx = (fx: Fixture, extra: string[] = []) =>
  run(['-Abi', 'armeabi-v7a', '-CacheDir', fx.cache, '-OutDir', fx.out, '-PinsFile', fx.pinsFile, ...extra], 120_000);

describe('fetch-box-runtimes.ps1 (static)', () => {
  const text = readFileSync(script, 'utf8');
  it('is ASCII only', () => {
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(text)).toBe(false);
  });
  it('downloads in exactly one function and calls tar.exe by its full System32 path', () => {
    expect(text.match(/Invoke-WebRequest/g)?.length).toBe(1);
    expect(text).not.toMatch(/DownloadFile|Start-BitsTransfer|Invoke-RestMethod|curl|wget/);
    expect(text).toMatch(/System32\\tar\.exe/);
    expect(text).toContain('SecurityProtocolType]3072'); // TLS 1.2
  });
  it('requires https, a filled sha256 and checks the hash before moving a download into the cache', () => {
    expect(text).toContain('https://');
    expect(text).toContain('sha256 belum diisi untuk');
    const dl = text.indexOf('Get-PinnedDownload -Url');
    const hashCheck = text.indexOf('sha256 tidak sepadan', dl);
    const move = text.indexOf('Move-Item -LiteralPath $part', dl);
    expect(dl).toBeGreaterThan(0);
    expect(hashCheck).toBeGreaterThan(dl);
    expect(move).toBeGreaterThan(hashCheck);
  });
  it('unpacks outside the checkout and refuses .. and absolute entries', () => {
    expect(text).toContain('GetTempPath()');
    expect(text).toContain('entri dengan .. dalam');
    expect(text).toContain('entri di luar awalan Termux');
  });
});

describe('android-pins.json', () => {
  const eight = ['nodejs-lts', 'libc++', 'openssl', 'c-ares', 'libicu', 'libsqlite', 'zlib', 'ca-certificates'];
  it('has both arches with the eight packages, https urls, sha256, version, licence and a safe cache file name', () => {
    for (const arch of ['arm', 'aarch64']) {
      const pk = pinsJson.termux[arch];
      expect(Object.keys(pk).sort()).toEqual([...eight].sort());
      for (const [name, p] of Object.entries(pk)) {
        expect(p.url, `${arch} ${name} url`).toMatch(/^https:\/\//);
        expect(p.sha256, `${arch} ${name} sha256`).toMatch(/^[0-9a-f]{64}$/);
        expect(p.version, `${arch} ${name} version`).not.toBe('');
        expect(p.licence, `${arch} ${name} licence`).not.toBe('');
        expect(p.file, `${arch} ${name} file`).toMatch(/^[A-Za-z0-9][A-Za-z0-9._+-]*\.deb$/);
        // the file is the URL's last segment with the epoch colon made safe for Windows
        expect(p.url.endsWith(`/${p.file.replace(/^(.*?)_(\d+)_/, '$1_$2:')}`) || p.url.endsWith(`/${p.file}`), `${arch} ${name} file vs url`).toBe(true);
      }
    }
  });
  it('has both MediaMTX entries of one version, with the release asset names', () => {
    expect(Object.keys(pinsJson.mediamtx).sort()).toEqual(['arm64-v8a', 'armeabi-v7a']);
    const a = pinsJson.mediamtx['armeabi-v7a'];
    const b = pinsJson.mediamtx['arm64-v8a'];
    expect(a.version).toBe(b.version);
    expect(a.url).toMatch(/^https:\/\/github\.com\/bluenviron\/mediamtx\/releases\/download\/v[\d.]+\/mediamtx_v[\d.]+_linux_armv7\.tar\.gz$/);
    expect(b.url).toMatch(/_linux_arm64\.tar\.gz$/);
    for (const p of [a, b]) {
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p.licence).toBe('MIT');
    }
  });
  it('keeps the four keys Task 3 owns', () => {
    for (const k of ['ffmpegSrc', 'opusSrc', 'mbedtlsSrc', 'ndkImage']) expect(pinsJson[k], k).toBeDefined();
  });
});

describe.skipIf(!win)('fetch-box-runtimes.ps1 (run)', () => {
  it('rename rule table (decision 6)', () => {
    const r = run(['-RenameNames', 'libz.so.1,libicuuc.so.78,libc++_shared.so,libsqlite3.so,libcrypto.so.3,libfoo.so.1.2.3,exe:node,exe:mediamtx,exe:ffmpeg']);
    expect(r.status).toBe(0);
    const lines = r.out.trim().split(/\r?\n/);
    expect(lines).toEqual([
      'libz.so.1=>libz_so_1.so',
      'libicuuc.so.78=>libicuuc_so_78.so',
      'libc++_shared.so=>libc++_shared.so',
      'libsqlite3.so=>libsqlite3.so',
      'libcrypto.so.3=>libcrypto_so_3.so',
      'libfoo.so.1.2.3=>libfoo_so_1_2_3.so',
      'exe:node=>libnode.so',
      'exe:mediamtx=>libmediamtx.so',
      'exe:ffmpeg=>libffmpeg.so',
    ]);
    const bad = run(['-RenameNames', 'weird name.so']);
    expect(bad.status).not.toBe(0);
  });

  it('-DryRun with the real pins lists what it would fetch and writes nothing', () => {
    const work = tempDir();
    const cache = join(work, 'cache');
    const out = join(work, 'out');
    const r = run(['-Abi', 'arm64-v8a', '-DryRun', '-CacheDir', cache, '-OutDir', out]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('fetch   nodejs-lts');
    expect(r.out).toContain('fetch   mediamtx');
    expect(existsSync(cache)).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  it('an empty sha256 fails by name before anything is fetched', () => {
    const fx = fixture();
    fx.pins.termux.arm!['fake-zlib']!.sha256 = '';
    writePins(fx);
    const r = runFx(fx);
    expect(r.status).toBe(1);
    expect(r.out).toContain('GAGAL: sha256 belum diisi untuk fake-zlib');
    expect(existsSync(fx.out)).toBe(false);
  });

  it('rejects http:// and a cache file name with a colon or a path', () => {
    const a = fixture();
    a.pins.termux.arm!['fake-zlib']!.url = 'http://127.0.0.1:9/x.deb';
    writePins(a);
    const ra = runFx(a);
    expect(ra.status).toBe(1);
    expect(ra.out).toContain('GAGAL: url mesti https://');
    const b = fixture();
    b.pins.termux.arm!['fake-zlib']!.file = '..\\evil.deb';
    writePins(b);
    expect(runFx(b).out).toContain('GAGAL: nama fail tidak sah');
    const c = fixture();
    c.pins.termux.arm!['fake-zlib']!.file = 'a:b.deb';
    writePins(c);
    expect(runFx(c).out).toContain('GAGAL: nama fail tidak sah');
  });

  it('unpacks cached debs: renamed libraries, libmap.json, manifest hashes, cert, licences, VERSIONS.md', () => {
    const fx = fixture();
    const r = runFx(fx);
    expect(r.out).toContain('Siap');
    expect(r.status).toBe(0);
    const lib = join(fx.out, 'jniLibs', 'armeabi-v7a');
    expect(readdirSync(lib).sort()).toEqual(['libmediamtx.so', 'libnode.so', 'libz_so_1.so']);
    expect(JSON.parse(readFileSync(join(fx.out, 'libmap.json'), 'utf8'))).toEqual([{ apk: 'libz_so_1.so', name: 'libz.so.1' }]);
    const manifest = JSON.parse(readFileSync(join(fx.out, 'runtime-manifest.json'), 'utf8')) as Array<{ apk: string; name: string; sha256: string; size: number; from: string }>;
    expect(manifest.map((m) => m.apk)).toEqual(['libmediamtx.so', 'libnode.so', 'libz_so_1.so']);
    for (const m of manifest) {
      const bytes = readFileSync(join(lib, m.apk));
      expect(m.sha256).toBe(sha(bytes));
      expect(m.size).toBe(bytes.length);
    }
    expect(manifest.find((m) => m.apk === 'libz_so_1.so')!.from).toBe('termux:fake-zlib:1.4:lib/libz.so.1.4');
    expect(readFileSync(join(fx.out, 'cert.pem'), 'utf8')).toContain('BEGIN CERTIFICATE');
    expect(readFileSync(join(fx.out, 'licences', 'fake-certs', 'copyright'), 'utf8')).toBe('MPL test\n');
    expect(readFileSync(join(fx.out, 'licences', 'fake-zlib', 'copyright.link.txt'), 'utf8')).toContain('../../LICENSES/Zlib.txt');
    expect(readFileSync(join(fx.out, 'licences', 'mediamtx', 'LICENSE'), 'utf8')).toContain('MIT');
    const versions = readFileSync(join(fx.out, 'VERSIONS.md'), 'utf8');
    expect(versions).toMatch(/^\| mediamtx \| v9\.9\.9 \| https:\/\/\S+ \| [0-9a-f]{64} \| MIT \| \d{4}-\d{2}-\d{2} \|$/m);
  }, 120_000);

  it('a second run over the same output replaces it (no stale file survives)', () => {
    const fx = fixture();
    expect(runFx(fx).status).toBe(0);
    writeFileSync(join(fx.out, 'jniLibs', 'armeabi-v7a', 'libstale.so'), 'x');
    expect(runFx(fx).status).toBe(0);
    expect(existsSync(join(fx.out, 'jniLibs', 'armeabi-v7a', 'libstale.so'))).toBe(false);
  }, 120_000);

  it('a cached file with a wrong hash is deleted and the run fails (nothing is used)', () => {
    const fx = fixture();
    const f = join(fx.cache, 'fake-zlib_1.4_arm.deb');
    writeFileSync(f, Buffer.concat([readFileSync(f), Buffer.from('tampered')]));
    const r = runFx(fx);
    expect(r.status).toBe(1);
    expect(r.out).toContain('GAGAL:');
    expect(existsSync(f)).toBe(false);
    expect(existsSync(join(fx.out, 'jniLibs'))).toBe(false);
  }, 120_000);

  it('a library nobody provides fails and names it', () => {
    const fx = fixture({ nodeNeeds: ['libc.so', 'libz.so.1', 'libnobody.so.9'] });
    const r = runFx(fx);
    expect(r.status).toBe(1);
    expect(r.out).toContain('GAGAL: perpustakaan diperlukan tetapi tiada dalam mana-mana pakej: libnobody.so.9');
  }, 120_000);

  it('an archive entry with .. or outside the Termux prefix is refused', () => {
    const a = fixture({ extraNodeEntries: [{ path: `${PREFIX}/../../evil.txt`, data: Buffer.from('x') }] });
    const ra = runFx(a);
    expect(ra.status).toBe(1);
    expect(ra.out).toMatch(/GAGAL: entri (dengan \.\.|di luar awalan Termux)/);
    const b = fixture({ extraNodeEntries: [{ path: './etc/passwd', data: Buffer.from('x') }] });
    const rb = runFx(b);
    expect(rb.status).toBe(1);
    expect(rb.out).toContain('GAGAL: entri di luar awalan Termux');
  }, 120_000);

  it('the libmap pairs of the real cache (when present) match the rename rule and Termux file names', () => {
    const real = join(repoRoot, 'dist', 'android-runtime', 'armeabi-v7a', 'libmap.json');
    if (!existsSync(real)) return;
    const map = JSON.parse(readFileSync(real, 'utf8')) as Array<{ apk: string; name: string }>;
    for (const m of map) expect(m.apk).toMatch(/^lib[A-Za-z0-9_+-]+\.so$/);
    expect(map.map((m) => m.name)).toContain('libz.so.1');
  });
});
