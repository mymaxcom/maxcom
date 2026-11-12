// Test helper for the Windows installer (Plan 9): builds a tiny but real setup bundle in a folder.
//
// Layout written by makeFakeBundle(dir, opts):
//   <dir>/manifest.json                                   { v: 1, files: [{ path, size, sha256 }] } (every other file)
//   <dir>/maxcom-box-<version>-windows.tar.gz             release archive, entries at the archive root
//   <dir>/payload/node-v<nodeVersion>-win-x64.zip         holds node-v<nodeVersion>-win-x64/{node.exe,LICENSE}
//   <dir>/payload/mediamtx_v1.0.0_windows_amd64.zip       empty zip stand-in
//   <dir>/payload/ffmpeg-fake-win64.zip                   empty zip stand-in
//   plus any opts.extraFiles ({ 'rel/path': content }), listed in the manifest too.
// The release archive holds a 20-line fake apps/box-server/src/main.ts that answers /api/health on SURAU_PORT.
// Archives are written by writeTarGz (no tar.exe, no symlink privilege needed), so tests can also craft
// hostile archives (../x, C:/x, /x, symlink entries). Zips need Windows tar.exe (bsdtar), so use this on win32.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

export interface TarEntry {
  name: string;
  type?: 'file' | 'dir' | 'symlink' | 'hardlink';
  data?: string | Buffer;
  linkname?: string;
}

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function tarHeader(e: TarEntry, size: number): Buffer {
  const type = e.type ?? 'file';
  const flag = { file: '0', hardlink: '1', symlink: '2', dir: '5' }[type];
  const mode = type === 'dir' ? 0o755 : type === 'symlink' ? 0o777 : 0o644;
  const name = Buffer.from(e.name, 'utf8');
  if (name.length > 100) throw new Error(`fake tar entry name too long: ${e.name}`);
  const b = Buffer.alloc(512);
  name.copy(b, 0);
  b.write(octal(mode, 8), 100, 'ascii');
  b.write(octal(0, 8), 108, 'ascii');
  b.write(octal(0, 8), 116, 'ascii');
  b.write(octal(size, 12), 124, 'ascii');
  b.write(octal(1700000000, 12), 136, 'ascii');
  b.fill(0x20, 148, 156);
  b.write(flag, 156, 'ascii');
  if (e.linkname) Buffer.from(e.linkname, 'utf8').copy(b, 157);
  b.write('ustar\0', 257, 'ascii');
  b.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return b;
}

/** Writes a .tar.gz with exactly the entries given (no name sanitising: hostile names are the point). */
export function writeTarGz(file: string, entries: TarEntry[]): void {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const type = e.type ?? 'file';
    const data = type === 'file' ? Buffer.from(e.data ?? '') : Buffer.alloc(0);
    parts.push(tarHeader(e, data.length));
    if (data.length > 0) {
      parts.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, gzipSync(Buffer.concat(parts)));
}

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function systemTar(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
}

/** Zip made by Windows bsdtar: -a picks the format from the .zip extension. */
function zipFolder(zipPath: string, stageDir: string, topLevel: string[]): void {
  const r = spawnSync(systemTar(), ['-a', '-cf', zipPath, '-C', stageDir, ...topLevel], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar.exe could not make ${zipPath}: ${r.stderr}`);
}

const EMPTY_ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);

/**
 * A zip holding a copy of this machine's node.exe (about 30 MB), built once per cache folder and copied
 * for every bundle. nodeStub: true gives a few bytes instead (for tests that never run the copy).
 */
function nodeZip(dest: string, nodeVersion: string, stub: boolean): void {
  const cacheDir = join(tmpdir(), 'maxcom-fakebundle-cache');
  mkdirSync(cacheDir, { recursive: true });
  const cached = join(cacheDir, `node-v${nodeVersion}-${stub ? 'stub' : process.version}.zip`);
  if (!existsSync(cached)) {
    const work = join(cacheDir, `build-${process.pid}-${Date.now()}`);
    const inner = `node-v${nodeVersion}-win-x64`;
    mkdirSync(join(work, inner), { recursive: true });
    if (stub) writeFileSync(join(work, inner, 'node.exe'), 'MZ fake node.exe');
    else copyFileSync(process.execPath, join(work, inner, 'node.exe'));
    writeFileSync(join(work, inner, 'LICENSE'), 'Node.js fake licence for tests\n');
    const tmpZip = join(cacheDir, `tmp-${process.pid}-${Date.now()}.zip`);
    zipFolder(tmpZip, work, [inner]);
    rmSync(work, { recursive: true, force: true });
    try {
      renameSync(tmpZip, cached);
    } catch {
      rmSync(tmpZip, { force: true }); // another worker won the race: its file is just as good
    }
  }
  copyFileSync(cached, dest);
}

function listFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listFiles(root, p, out);
    else out.push(p);
  }
  return out;
}

export interface FakeBundleOptions {
  version?: string;
  nodeVersion?: string;
  /** Use a few bytes for node.exe instead of a copy of the real one (fast; the node cannot be run). */
  nodeStub?: boolean;
  /** Extra bundle files, relative path (forward slashes) -> text. They are listed in the manifest. */
  extraFiles?: Record<string, string>;
}

export interface FakeBundle {
  dir: string;
  version: string;
  archive: string;
  archiveName: string;
  payloadDir: string;
  nodeZip: string;
  nodeZipName: string;
  mediamtxZip: string;
  ffmpegZip: string;
  manifest: string;
  sha256: { archive: string; nodeZip: string; mediamtxZip: string; ffmpegZip: string };
  releaseEntries: TarEntry[];
}

const FAKE_MAIN = [
  "import http from 'node:http';",
  'const port = Number(process.env.SURAU_PORT || 8787);',
  'const version = __VERSION__;',
  'const server = http.createServer((req, res) => {',
  "  if (req.url === '/api/health') {",
  "    res.setHeader('content-type', 'application/json');",
  '    res.end(JSON.stringify({ ok: true, version }));',
  '    return;',
  '  }',
  '  res.statusCode = 404;',
  "  res.end('not found');",
  '});',
  "server.listen(port, '127.0.0.1');",
  "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
  '',
].join('\n');

export function releaseEntriesFor(version: string, nodeVersion: string): TarEntry[] {
  const releaseJson = {
    v: 1,
    version,
    platform: 'windows',
    commit: 'fakecommit',
    builtAt: '2026-11-10T00:00:00.000Z',
    node: nodeVersion,
    workspaceLinks: [{ name: '@surau/core', target: 'packages/core' }],
  };
  return [
    { name: 'release.json', data: JSON.stringify(releaseJson, null, 2) },
    { name: 'package.json', data: JSON.stringify({ name: 'maxcom-fake', private: true, version }) },
    { name: 'apps/box-server/package.json', data: JSON.stringify({ name: '@surau/box-server', version }) },
    { name: 'apps/box-server/src/main.ts', data: FAKE_MAIN.replace('__VERSION__', JSON.stringify(version)) },
    { name: 'packages/core/package.json', data: JSON.stringify({ name: '@surau/core', version }) },
    { name: 'packages/core/src/index.ts', data: 'export const core = true;\n' },
    { name: 'scripts/ensure-live-firewall.ps1', data: '# fake\n' },
    { name: 'THIRD-PARTY-NOTICES.md', data: 'fake\n' },
  ];
}

export function makeFakeBundle(dir: string, opts: FakeBundleOptions = {}): FakeBundle {
  const version = opts.version ?? '2026.11.1';
  const nodeVersion = opts.nodeVersion ?? '24.0.0';
  const payloadDir = join(dir, 'payload');
  mkdirSync(payloadDir, { recursive: true });

  const archiveName = `maxcom-box-${version}-windows.tar.gz`;
  const archive = join(dir, archiveName);
  const releaseEntries = releaseEntriesFor(version, nodeVersion);
  writeTarGz(archive, releaseEntries);

  const nodeZipName = `node-v${nodeVersion}-win-x64.zip`;
  const nodeZipPath = join(payloadDir, nodeZipName);
  nodeZip(nodeZipPath, nodeVersion, opts.nodeStub === true);
  const mediamtxZip = join(payloadDir, 'mediamtx_v1.0.0_windows_amd64.zip');
  const ffmpegZip = join(payloadDir, 'ffmpeg-fake-win64.zip');
  writeFileSync(mediamtxZip, EMPTY_ZIP);
  writeFileSync(ffmpegZip, EMPTY_ZIP);

  for (const [rel, text] of Object.entries(opts.extraFiles ?? {})) {
    const p = join(dir, ...rel.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }

  const files = listFiles(dir)
    .map((p) => p.slice(dir.length + 1).replaceAll('\\', '/'))
    .filter((rel) => rel !== 'manifest.json')
    .sort()
    .map((rel) => {
      const p = join(dir, ...rel.split('/'));
      return { path: rel, size: statSync(p).size, sha256: sha256File(p) };
    });
  const manifest = join(dir, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ v: 1, files }, null, 2));

  return {
    dir,
    version,
    archive,
    archiveName,
    payloadDir,
    nodeZip: nodeZipPath,
    nodeZipName,
    mediamtxZip,
    ffmpegZip,
    manifest,
    sha256: {
      archive: sha256File(archive),
      nodeZip: sha256File(nodeZipPath),
      mediamtxZip: sha256File(mediamtxZip),
      ffmpegZip: sha256File(ffmpegZip),
    },
    releaseEntries,
  };
}
