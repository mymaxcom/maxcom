#!/usr/bin/env node
// MAXCOM: makes the TLS test fixtures that the test suites load (certificates, PFX files, test keys).
// Nothing here protects anything; the files are git-ignored and are never published.
//
//   node scripts/gen-test-fixtures.mjs
//
// Needs Windows PowerShell 5.1 (scripts/gen-test-pki.ps1 uses New-SelfSignedCertificate) and OpenSSL
// (on PATH, or the one that ships with Git for Windows). The box-android test keys come from
// apps/box-android/app/src/test/kotlin/my/maxcom/box/core/PkiTestKeys.kt.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => join(root, ...p);

if (process.platform !== 'win32') {
  console.error('gen-test-fixtures: the TLS fixtures are made with Windows PowerShell; run this on Windows.');
  process.exit(1);
}

function findOpenssl() {
  for (const c of ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/Git/mingw64/bin/openssl.exe']) {
    const r = spawnSync(c, ['version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  console.error('gen-test-fixtures: OpenSSL not found (install Git for Windows or put openssl on PATH).');
  process.exit(1);
}

// 1. pass files (the PFX passphrase of every test fixture is the word "test")
for (const d of ['apps/surau-app/test/fixtures/tls', 'apps/surau-app/test/fixtures/tls-nc']) {
  mkdirSync(at(d), { recursive: true });
}
for (const f of ['tls/pfx.pass', 'tls-nc/pfx.pass', 'tls-nc/ip-pfx.pass']) writeFileSync(at('apps/surau-app/test/fixtures', f), 'test');

// 2. certificates and PFX files
execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', at('scripts/gen-test-pki.ps1')], { stdio: 'inherit' });

// 3. PKCS#8 PEM keys of the two box-server leaves, taken out of their PFX files
const openssl = findOpenssl();
for (const [pfx, pem] of [['test-box.pfx', 'test-box-key.pem'], ['test-box2.pfx', 'test-box2-key.pem']]) {
  const dir = at('apps/box-server/test/fixtures');
  const out = execFileSync(openssl, ['pkcs12', '-in', join(dir, pfx), '-nocerts', '-nodes', '-passin', 'pass:test'], { encoding: 'utf8' });
  const m = out.match(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/);
  if (!m) throw new Error('no PKCS#8 key in ' + pfx);
  writeFileSync(join(dir, pem), m[0] + '\n');
}

// 4. the Android box test key (a fixed test key kept in PkiTestKeys.kt)
const kt = readFileSync(at('apps/box-android/app/src/test/kotlin/my/maxcom/box/core/PkiTestKeys.kt'), 'utf8');
const hex = kt.match(/LEAF_PKCS8 =\s*"([0-9a-f]+)"/);
if (!hex) throw new Error('LEAF_PKCS8 not found in PkiTestKeys.kt');
const b64 = Buffer.from(hex[1], 'hex').toString('base64').match(/.{1,64}/g).join('\n');
mkdirSync(at('apps/surau-app/test/fixtures/android-box-pki'), { recursive: true });
writeFileSync(at('apps/surau-app/test/fixtures/android-box-pki/box-key.pem'), '-----BEGIN PRIVATE KEY-----\n' + b64 + '\n-----END PRIVATE KEY-----\n');

console.log('test fixtures made');
