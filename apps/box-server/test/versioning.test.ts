import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { boxVersion } from '../src/productVersion.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const setVersion = join(repoRoot, 'scripts', 'set-version.mjs');
const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), 'utf8');

const KEYS = ['admin-client-android', 'kiosk-server-android', 'kiosk-server-windows'];
const VERSION_RE = /^20\d\d\.(0[1-9]|1[0-2])\.([1-9]|[1-9]\d)$/;
const versions = JSON.parse(read('versions.json')) as Record<string, string>;
const code = (v: string) => {
  const [y, m, n] = v.split('.').map(Number);
  return ((y - 2000) * 10000 + m * 100 + n) * 10;
};

function run(root: string, args: string[]) {
  const r = spawnSync(process.execPath, [setVersion, '--root', root, ...args], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const dartFile = (v: string) => `const String appVersion = String.fromEnvironment(\r\n  'MAXCOM_VERSION',\r\n  defaultValue: '${v}',\r\n);\r\n`;
const dartPath = (d: string) => join(d, 'apps', 'surau-app', 'lib', 'app', 'app_version.dart');

/** A temp checkout with only the files the key table names (CRLF pubspec like the real one). */
function tempRoot(v = '2026.11.2'): string {
  const d = mkdtempSync(join(tmpdir(), 'maxcom-ver-'));
  dirs.push(d);
  writeFileSync(join(d, 'versions.json'), `${JSON.stringify({ 'kiosk-server-windows': v, 'kiosk-server-android': v, 'admin-client-android': v }, null, 2)}\n`);
  mkdirSync(join(d, 'apps', 'surau-app'), { recursive: true });
  writeFileSync(join(d, 'apps', 'surau-app', 'pubspec.yaml'), `name: surau_app\r\nversion: ${v}+${code(v)}\r\n\r\nenvironment:\r\n  sdk: ^3.13.7\r\n`);
  mkdirSync(join(d, 'apps', 'surau-app', 'lib', 'app'), { recursive: true });
  writeFileSync(dartPath(d), dartFile(v));
  return d;
}

describe('versions.json', () => {
  it('has exactly the three product keys, each a valid YYYY.MM.N (N 1..99)', () => {
    expect(Object.keys(versions).sort()).toEqual(KEYS);
    for (const k of KEYS) expect(versions[k], k).toMatch(VERSION_RE);
  });
  it('is 2-space JSON with a trailing newline', () => {
    const text = read('versions.json');
    expect(text).toBe(`${JSON.stringify(versions, null, 2)}\n`);
  });
});

describe('files that carry a product version agree with versions.json', () => {
  it('node scripts/set-version.mjs --check exits 0 on the real checkout', () => {
    const r = run(repoRoot, ['--check']);
    expect(r.out).toContain('sepadan');
    expect(r.status).toBe(0);
  });
  it('admin-client-android: pubspec.yaml version is <version>+<code> with code = (YY*10000+MM*100+N)*10, above the old +1', () => {
    const m = /^version:\s*(\S+)\+(\d+)\s*$/m.exec(read('apps', 'surau-app', 'pubspec.yaml'));
    expect(m).not.toBeNull();
    expect(m![1]).toBe(versions['admin-client-android']);
    expect(Number(m![2])).toBe(code(versions['admin-client-android']));
    expect(Number(m![2])).toBeGreaterThan(1);
  });
  it('admin client: the compile-time default of MAXCOM_VERSION is the pubspec version', () => {
    const dart = read('apps', 'surau-app', 'lib', 'app', 'app_version.dart');
    expect(dart).toContain("String.fromEnvironment(");
    expect(dart).toContain("'MAXCOM_VERSION'");
    expect(dart).toContain(`defaultValue: '${versions['admin-client-android']}'`);
  });
  it('the source tree packages carry a valid version that no product is checked against', () => {
    for (const p of [['apps', 'box-server'], ['apps', 'kiosk-display'], ['packages', 'core'], ['packages', 'device-client']]) {
      expect(JSON.parse(read(...p, 'package.json')).version, p.join('/')).toMatch(VERSION_RE);
    }
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version: string }> };
    for (const p of ['apps/box-server', 'apps/kiosk-display', 'packages/core', 'packages/device-client']) {
      expect(lock.packages[p].version, p).toBe(JSON.parse(read(...p.split('/'), 'package.json')).version);
    }
    expect(read('scripts', 'set-version.mjs')).toMatch(/NOT tied to any product/);
  });
});

describe('scripts/set-version.mjs', () => {
  it('bumps admin-client-android: versions.json and pubspec.yaml (CRLF kept, code from the formula)', () => {
    const d = tempRoot();
    const r = run(d, ['admin-client-android', '2026.11.3']);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(join(d, 'versions.json'), 'utf8'))).toEqual({
      'kiosk-server-windows': '2026.11.2',
      'kiosk-server-android': '2026.11.2',
      'admin-client-android': '2026.11.3',
    });
    expect(readFileSync(join(d, 'versions.json'), 'utf8').endsWith('}\n')).toBe(true);
    const pub = readFileSync(join(d, 'apps', 'surau-app', 'pubspec.yaml'), 'utf8');
    expect(pub).toBe(`name: surau_app\r\nversion: 2026.11.3+${code('2026.11.3')}\r\n\r\nenvironment:\r\n  sdk: ^3.13.7\r\n`);
    // the Dart compile-time default is rewritten too (CRLF kept)
    expect(readFileSync(dartPath(d), 'utf8')).toBe(dartFile('2026.11.3'));
    expect(run(d, ['--check']).status).toBe(0);
  });
  it('--check catches a Dart default that disagrees (pubspec and versions.json still agree)', () => {
    const d = tempRoot();
    writeFileSync(dartPath(d), dartFile('2026.11.1'));
    const r = run(d, ['--check']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('apps/surau-app/lib/app/app_version.dart');
    expect(r.out).toContain('2026.11.2');
    // a bump repairs it, and leaves no temp file behind
    expect(run(d, ['admin-client-android', '2026.11.2']).status).toBe(0);
    expect(readFileSync(dartPath(d), 'utf8')).toBe(dartFile('2026.11.2'));
    expect(run(d, ['--check']).status).toBe(0);
    expect(existsSync(`${dartPath(d)}.tmp-${process.pid}`)).toBe(false);
  });
  it('bumps a server product on its own: only versions.json changes, the other products stay', () => {
    const d = tempRoot();
    const pubBefore = readFileSync(join(d, 'apps', 'surau-app', 'pubspec.yaml'), 'utf8');
    expect(run(d, ['kiosk-server-android', '2026.12.1']).status).toBe(0);
    const v = JSON.parse(readFileSync(join(d, 'versions.json'), 'utf8')) as Record<string, string>;
    expect(v['kiosk-server-android']).toBe('2026.12.1');
    expect(v['kiosk-server-windows']).toBe('2026.11.2');
    expect(v['admin-client-android']).toBe('2026.11.2');
    expect(readFileSync(join(d, 'apps', 'surau-app', 'pubspec.yaml'), 'utf8')).toBe(pubBefore);
  });
  it('accepts the same version again (idempotent) and N up to 99', () => {
    const d = tempRoot();
    expect(run(d, ['kiosk-server-windows', '2026.11.2']).status).toBe(0);
    expect(run(d, ['kiosk-server-windows', '2026.11.99']).status).toBe(0);
  });
  it('refuses a version lower than the current one and changes nothing', () => {
    const d = tempRoot('2026.11.5');
    const before = readFileSync(join(d, 'versions.json'), 'utf8');
    const pubBefore = readFileSync(join(d, 'apps', 'surau-app', 'pubspec.yaml'), 'utf8');
    for (const low of ['2026.11.4', '2026.10.9', '2025.12.99']) {
      const r = run(d, ['admin-client-android', low]);
      expect(r.status, low).toBe(1);
      expect(r.out, low).toContain('GAGAL');
      expect(r.out, low).toContain('lebih rendah');
    }
    expect(readFileSync(join(d, 'versions.json'), 'utf8')).toBe(before);
    expect(readFileSync(join(d, 'apps', 'surau-app', 'pubspec.yaml'), 'utf8')).toBe(pubBefore);
  });
  it('refuses an unknown key (nothing written) and names the known ones', () => {
    const d = tempRoot();
    const before = readFileSync(join(d, 'versions.json'), 'utf8');
    const r = run(d, ['admin-client-ios', '2026.11.3']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('kunci tidak dikenali');
    for (const k of KEYS) expect(r.out).toContain(k);
    expect(readFileSync(join(d, 'versions.json'), 'utf8')).toBe(before);
  });
  it('refuses a malformed version (month 13, N 0 or 100, no zero pad, wrong shape) and a missing argument', () => {
    const d = tempRoot();
    for (const bad of ['2026.13.1', '2026.11.0', '2026.11.100', '2026.1.1', '26.11.1', '2026.11', 'v2026.11.3']) {
      const r = run(d, ['kiosk-server-windows', bad]);
      expect(r.status, bad).toBe(1);
      expect(r.out, bad).toContain('GAGAL');
    }
    expect(run(d, ['kiosk-server-windows']).status).toBe(1);
    expect(run(d, []).status).toBe(1);
  });
  it('--check catches a pubspec that disagrees, and a missing key or file, and lists them', () => {
    const d = tempRoot();
    expect(run(d, ['--check']).status).toBe(0);
    const pub = join(d, 'apps', 'surau-app', 'pubspec.yaml');
    writeFileSync(pub, readFileSync(pub, 'utf8').replace(/^version:.*$/m, 'version: 0.1.0+1'));
    const r = run(d, ['--check']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('apps/surau-app/pubspec.yaml');
    expect(r.out).toContain('admin-client-android');
    // a wrong code alone is a mismatch too
    writeFileSync(pub, readFileSync(pub, 'utf8').replace(/^version:.*$/m, 'version: 2026.11.2+1'));
    expect(run(d, ['--check']).status).toBe(1);
    // the build of another product is not stopped by it
    expect(run(d, ['--check', '--key', 'kiosk-server-windows']).status).toBe(0);
    expect(run(d, ['--check', '--key', 'admin-client-android']).status).toBe(1);
    rmSync(pub);
    expect(run(d, ['--check']).out).toContain('fail tiada');
    writeFileSync(join(d, 'versions.json'), JSON.stringify({ 'kiosk-server-windows': '2026.11.2', 'kiosk-server-android': '2026.11.2' }));
    expect(run(d, ['--check', '--key', 'admin-client-android']).out).toContain('versions.json');
  });
  it('--check refuses an unknown key in versions.json', () => {
    const d = tempRoot();
    writeFileSync(join(d, 'versions.json'), JSON.stringify({ 'kiosk-server-windows': '2026.11.2', 'kiosk-server-android': '2026.11.2', 'admin-client-android': '2026.11.2', 'admin-client-ios': '2026.11.2' }));
    const r = run(d, ['--check']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('admin-client-ios');
  });
  it('keeps one key table as the only place to extend', () => {
    const text = read('scripts', 'set-version.mjs');
    expect(text).toMatch(/ONE ROW to PRODUCTS/);
    expect(text).toContain('export const PRODUCTS');
  });
});

describe('build scripts default -Version from versions.json (static)', () => {
  const rel = read('scripts', 'build-release.ps1');
  const apk = read('scripts', 'android', 'build-box-apk.ps1');
  const setup = read('scripts', 'setup', 'build-setup.ps1');
  const exe = read('scripts', 'setup', 'build-setup-exe.ps1');
  const app = read('scripts', 'build-app.ps1');
  it('are ASCII only (Windows PowerShell 5.1)', () => {
    for (const t of [rel, apk, setup, exe, app]) {
      // eslint-disable-next-line no-control-regex
      expect(/[^\x00-\x7F]/.test(t)).toBe(false);
    }
  });
  it('build-release picks the key by -Platform, defaults -Version and runs --check first', () => {
    expect(rel).toMatch(/\[string\]\$Version = ''/);
    expect(rel).toContain('$versionKey = "kiosk-server-$Platform"');
    expect(rel).toContain('if ($Version -eq \'\') { $Version = $declared }');
    expect(rel).toContain('GAGAL');
    expect(rel.indexOf('--check --key $versionKey')).toBeGreaterThan(-1);
    expect(rel.indexOf('--check --key $versionKey')).toBeLessThan(rel.indexOf('Pins file: shape only'));
    expect(rel).not.toContain('$pkg.version');
  });
  it('the Windows setup and exe builds use kiosk-server-windows; the APK build uses kiosk-server-android', () => {
    for (const t of [setup, exe]) {
      expect(t).toMatch(/\[string\]\$Version = ''/);
      expect(t).toContain("Resolve-ProductVersion 'kiosk-server-windows'");
      expect(t).toMatch(/--check --key \$Key/);
      expect(t).toContain("tidak sama dengan versions.json");
    }
    expect(apk).toMatch(/\[string\]\$Version = ''/);
    expect(apk).toContain("Resolve-ProductVersion 'kiosk-server-android'");
    expect(apk).toMatch(/--check --key \$Key/);
    expect(apk).toContain('-PboxVersion=$Version');
  });
  it('build-app checks admin-client-android first and passes MAXCOM_VERSION to every flutter build', () => {
    expect(app).toMatch(/--check --key admin-client-android/);
    expect(app.indexOf('--check --key admin-client-android')).toBeLessThan(app.indexOf('& $flutter build'));
    expect(app).toContain('--dart-define=MAXCOM_VERSION=$appVersion');
    expect((app.match(/& \$flutter build [^\n]*\$defineVersion/g) ?? []).length).toBe(3);
  });
  it('the Gradle property keeps its name boxVersion', () => {
    expect(read('apps', 'box-android', 'app', 'build.gradle.kts')).toContain('findProperty("boxVersion")');
  });
});

describe('the box server reports its own version', () => {
  it('boxVersion() is the release.json version of a release, else this package version (a checkout)', () => {
    const rj = join(repoRoot, 'release.json');
    const expected = existsSync(rj) ? (JSON.parse(readFileSync(rj, 'utf8')) as { version: string }).version : (JSON.parse(read('apps', 'box-server', 'package.json')) as { version: string }).version;
    expect(boxVersion()).toBe(expected);
    expect(boxVersion()).toMatch(VERSION_RE);
  });
  it('build-release stamps the version into release.json at the archive root', () => {
    expect(read('scripts', 'build-release.ps1')).toMatch(/version = \$Version/);
    expect(read('apps', 'box-server', 'src', 'productVersion.ts')).toContain("'release.json'");
  });
});
