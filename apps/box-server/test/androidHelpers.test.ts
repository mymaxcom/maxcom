import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const installScript = join(repoRoot, 'scripts', 'android', 'install-android-box.ps1');
const doctorScript = join(repoRoot, 'scripts', 'android', 'doctor-android-box.ps1');
const win = process.platform === 'win32';
const SERIAL = '10.168.1.50:5555';

const work = mkdtempSync(join(tmpdir(), 'maxcom-ah-'));
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

// ---- the fake adb: logs argv (JSON line), answers from a fixture, fakes `forward` with a tiny HTTP server ----
const fakeJs = `
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const argv = process.argv.slice(2);
if (process.argv[2] === '--serve') {
  const port = Number(process.argv[3]);
  http.createServer((req, res) => {
    if (req.url === '/api/health') { res.setHeader('content-type', 'application/json'); res.end('{"ok":true,"version":"2026.11.1"}'); }
    else if (req.url === '/api/pki/root.cer') { res.end(Buffer.from('fake-root-der')); }
    else { res.statusCode = 404; res.end(); }
  }).listen(port, '127.0.0.1');
  return;
}
fs.appendFileSync(process.env.FAKE_ADB_LOG, JSON.stringify(argv) + '\\n');
const fx = JSON.parse(fs.readFileSync(process.env.FAKE_ADB_FIXTURE, 'utf8'));
if (argv[0] === 'devices') { process.stdout.write(fx.devices); process.exit(0); }
const rest = argv[0] === '-s' ? argv.slice(2) : argv;
const joined = rest.join(' ');
const fm = /^forward tcp:(\\d+) tcp:8787$/.exec(joined);
if (fm) {
  const child = spawn(process.execPath, [__filename, '--serve', fm[1]], { detached: true, stdio: 'ignore', env: process.env });
  fs.writeFileSync(process.env.FAKE_ADB_DIR + '/fwd-' + fm[1] + '.pid', String(child.pid));
  child.unref();
  process.exit(0);
}
const rm = /^forward --remove tcp:(\\d+)$/.exec(joined);
if (rm) {
  try { process.kill(Number(fs.readFileSync(process.env.FAKE_ADB_DIR + '/fwd-' + rm[1] + '.pid', 'utf8'))); } catch {}
  process.exit(0);
}
for (let i = 0; i < fx.rules.length; i++) {
  const r = fx.rules[i];
  if (new RegExp(r.re).test(joined)) {
    let out = r.out || '';
    if (r.seq) {
      const f = process.env.FAKE_ADB_DIR + '/seq-' + i + '.cnt';
      let n = 0;
      try { n = Number(fs.readFileSync(f, 'utf8')); } catch {}
      fs.writeFileSync(f, String(n + 1));
      out = r.seq[Math.min(n, r.seq.length - 1)];
    }
    process.stdout.write(out); process.exit(r.code || 0);
  }
}
process.exit(0);
`;

type Rule = { re: string; out: string; code?: number; seq?: string[] };
const wl = (...p: string[]) => `Some header
User Whitelist:
....[${p.join(', ')}]
Other: x
`;
const dumpBg = (...p: string[]): Rule => ({ re: '^shell dumpsys background$', out: wl(...p) });
const baseRules = (over: Rule[] = [], abilist = 'arm64-v8a,armeabi-v7a,armeabi'): Rule[] => [
  ...over,
  { re: '^shell getprop ro\\.product\\.cpu\\.abilist$', out: `${abilist}\n` },
  { re: '^shell getprop ro\\.build\\.version\\.sdk$', out: '30\n' },
  { re: '^shell df -k /data$', out: 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/dm-0 3800000 1500000 2300000 40% /data\n' },
  { re: '^shell dumpsys webviewupdate$', out: 'Current WebView package (name, version): (com.google.android.webview, 91.0.4472.114)\n' },
  { re: '^install ', out: 'Performing Streamed Install\nSuccess\n' },
  { re: '^shell dumpsys deviceidle whitelist \\+', out: 'Added: my.maxcom.box\n' },
  { re: '^shell service check background$', out: 'Service background: not found\n' },
  { re: '^shell ip -o -4 addr show$', out: '1: lo    inet 127.0.0.1/8 scope host lo\n3: wlan0    inet 10.168.1.50/24 brd 10.168.1.255 scope global wlan0\n' },
];

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function setup(name: string, rules: Rule[], devices = `List of devices attached\n${SERIAL}\tdevice\n\n`) {
  const dir = join(work, name);
  const apkDir = join(dir, 'apks');
  // mkdir via writeFileSync needs the folder first
  spawnSync('powershell.exe', ['-NoProfile', '-Command', `New-Item -ItemType Directory -Force -Path '${apkDir}' | Out-Null`]);
  writeFileSync(join(dir, 'fake-adb.js'), fakeJs);
  writeFileSync(join(dir, 'adb.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0fake-adb.js" %*\r\n`);
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ devices, rules }));
  for (const abi of ['arm64-v8a', 'armeabi-v7a']) {
    const apk = join(apkDir, `MAX-Kiosk-Server-2026.11.1-${abi}.apk`);
    const body = Buffer.from(`fake apk ${abi}`);
    writeFileSync(apk, body);
    writeFileSync(`${apk}.sha256`, `${sha(body)}  MAX-Kiosk-Server-2026.11.1-${abi}.apk\n`);
    const dbg = join(apkDir, `MAX-Kiosk-Server-2026.11.1-${abi}-debug.apk`);
    writeFileSync(dbg, body);
    writeFileSync(`${dbg}.sha256`, `${sha(body)}  MAX-Kiosk-Server-2026.11.1-${abi}-debug.apk\n`);
  }
  const log = join(dir, 'adb.log');
  writeFileSync(log, '');
  return { dir, apkDir, adb: join(dir, 'adb.cmd'), log, env: { ...process.env, FAKE_ADB_LOG: log, FAKE_ADB_FIXTURE: join(dir, 'fixture.json'), FAKE_ADB_DIR: dir } };
}
function calls(log: string): string[][] {
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
}
function run(script: string, args: string[], env: NodeJS.ProcessEnv, timeout = 120_000) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { encoding: 'utf8', timeout, env });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const joinedCalls = (c: string[][]) => c.map((a) => a.join(' '));

describe('install-android-box.ps1 (static)', () => {
  const text = readFileSync(installScript, 'utf8');
  it('is ASCII only, with no em dash', () => {
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(text)).toBe(false);
  });
  it('never removes, disables or hides a package and never asks for root', () => {
    expect(text).not.toMatch(/uninstall|pm\s+disable|pm\s+hide|adb\s+root|\bsu\b|\bsudo\b/i);
  });
  it('downloads nothing and evaluates no strings', () => {
    expect(text).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|DownloadFile|Invoke-Expression|\biex\b/);
    expect(text).not.toMatch(/cmd(\.exe)?\s+\/c/i);
  });
  it('calls adb only with an argument array, and with -s for every device call', () => {
    expect(text).toMatch(/& \$script:AdbExe @a /);
    expect(text).toMatch(/\(@\('-s', \$Serial\) \+ \$a\)/);
    expect(text).toMatch(/\[Parameter\(Mandatory = \$true\)\]\[Alias\('Device'\)\]\[string\]\$Serial/);
  });
});

describe('doctor-android-box.ps1 (static)', () => {
  const text = readFileSync(doctorScript, 'utf8');
  it('is ASCII only', () => {
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(text)).toBe(false);
  });
  it('contains nothing that changes the box', () => {
    expect(text).not.toMatch(/\binstall\b|\bput\b|set-home-activity|\bgrant\b|whitelist \+|\bservice call\b|uninstall|pm\s+disable|adb\s+root|\bsu\b/i);
  });
  it('reads only: its device calls go through Adb-Read', () => {
    expect(text).toMatch(/function Adb-Read/);
    expect(text).not.toMatch(/function Adb-Change/);
  });
});

describe.runIf(win)('install-android-box.ps1 (run, fake adb)', () => {
  it('fails without -Serial', () => {
    const s = setup('noserial', baseRules());
    const r = run(installScript, ['-Adb', s.adb, '-DryRun', '-DebugBuild'], s.env);
    expect(r.status).not.toBe(0);
    expect(calls(s.log)).toHaveLength(0);
  });

  it('rejects a serial with shell characters before any adb call', () => {
    const s = setup('badserial', baseRules());
    const r = run(installScript, ['-Serial', '1.2.3.4;calc', '-Adb', s.adb, '-DryRun', '-DebugBuild'], s.env);
    expect(r.status).toBe(1);
    expect(r.out).toContain('GAGAL');
    expect(calls(s.log)).toHaveLength(0);
  });

  it('two devices without a match fails at step 0 (never "the only device")', () => {
    const s = setup('twodev', baseRules(), 'List of devices attached\nAAA111\tdevice\nBBB222\tdevice\n\n');
    const r = run(installScript, ['-Serial', SERIAL, '-Adb', s.adb, '-DryRun', '-DebugBuild'], s.env);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: langkah 0/);
    expect(calls(s.log).every((c) => c[0] === 'devices')).toBe(true);
  });

  it('an unauthorised device fails at step 0 with the BM instruction', () => {
    const s = setup('unauth', baseRules(), `List of devices attached\n${SERIAL}\tunauthorized\n\n`);
    const r = run(installScript, ['-Serial', SERIAL, '-Adb', s.adb, '-DryRun', '-DebugBuild'], s.env);
    expect(r.status).toBe(1);
    expect(r.out).toContain('belum membenarkan');
  });

  it('-DryRun prints every changing adb call and sends none of them', () => {
    const s = setup('dry', baseRules([
      { re: '^shell service check background$', out: 'Service background: found\n' },
      dumpBg(),
      { re: '^shell getprop ro\\.build\\.version\\.sdk$', out: '33\n' },
    ]));
    const r = run(installScript, ['-Serial', SERIAL, '-Adb', s.adb, '-ApkDir', s.apkDir, '-Version', '2026.11.1', '-SetHome', '-DisableNetworkAdbAfter', '-DryRun', '-DebugBuild'], s.env);
    expect(r.status).toBe(0);
    const all = joinedCalls(calls(s.log));
    for (const bad of ['install', 'pm grant', 'deviceidle whitelist', 'device_config put', 'settings put', 'service call', 'set-home-activity', 'am start', 'forward', 'usb']) {
      expect(all.filter((l) => l.includes(bad))).toEqual([]);
    }
    expect(r.out).toMatch(/DRYRUN adb -s 10\.168\.1\.50:5555 install -r --no-incremental .*MAX-Kiosk-Server-2026\.11\.1-arm64-v8a-debug\.apk/);
    expect(r.out).toContain('DRYRUN adb -s 10.168.1.50:5555 shell cmd package set-home-activity my.maxcom.box/.KioskActivity');
    expect(r.out).toContain('shell pm grant my.maxcom.box android.permission.POST_NOTIFICATIONS');
    expect(r.out).toContain('shell dumpsys deviceidle whitelist +my.maxcom.box');
    expect(r.out).toContain('shell device_config put activity_manager max_phantom_processes 2147483647');
    expect(r.out).toContain('shell settings put global settings_enable_monitor_phantom_procs false');
    expect(r.out).toContain('shell service call background 3 i32 1 s16 my.maxcom.box');
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) expect(r.out).toMatch(new RegExp(`^(OK|SET|LANGKAU|AMARAN)\\s+${n}\\s`, 'm'));
    // Every device call (all but "devices") carries -s <serial>.
    for (const c of calls(s.log)) if (c[0] !== 'devices') expect(c.slice(0, 2)).toEqual(['-s', SERIAL]);
  });

  it('picks the APK by the first supported ABI in the list', () => {
    const a = setup('abi64', baseRules([], 'arm64-v8a,armeabi-v7a'));
    expect(run(installScript, ['-Serial', SERIAL, '-Adb', a.adb, '-ApkDir', a.apkDir, '-Version', '2026.11.1', '-DryRun', '-DebugBuild'], a.env).out).toContain('MAX-Kiosk-Server-2026.11.1-arm64-v8a-debug.apk');
    const b = setup('abi32', baseRules([], 'armeabi-v7a,armeabi'));
    const rb = run(installScript, ['-Serial', SERIAL, '-Adb', b.adb, '-ApkDir', b.apkDir, '-DryRun', '-DebugBuild'], b.env);
    expect(rb.out).toContain('MAX-Kiosk-Server-2026.11.1-armeabi-v7a-debug.apk');
    expect(rb.out).not.toContain('arm64-v8a.apk');
    const c = setup('abiNone', baseRules([], 'x86,x86_64'));
    const rc = run(installScript, ['-Serial', SERIAL, '-Adb', c.adb, '-ApkDir', c.apkDir, '-DryRun', '-DebugBuild'], c.env);
    expect(rc.status).toBe(1);
    expect(rc.out).toContain('tiada ABI yang disokong');
  });

  it('-DebugBuild finds only the -debug APK (newest version, step 2 LANGKAU, step 3 installs it)', () => {
    const s = setup('dbgonly', baseRules([], 'armeabi-v7a'));
    for (const f of readdirSync(s.apkDir)) if (!f.includes('armeabi-v7a-debug')) rmSync(join(s.apkDir, f));
    const r = run(installScript, ['-Serial', SERIAL, '-Adb', s.adb, '-ApkDir', s.apkDir, '-DryRun', '-DebugBuild'], s.env);
    expect(r.out).toMatch(/^LANGKAU\s+2\s/m);
    expect(r.out).toMatch(/DRYRUN adb .*install .*MAX-Kiosk-Server-2026\.11\.1-armeabi-v7a-debug\.apk/);
    expect(r.out).not.toMatch(/GAGAL: langkah 2/);
  });

  it('without -DebugBuild a lone -debug APK is never picked (step 2 GAGAL)', () => {
    const s = setup('reldbg', baseRules([], 'armeabi-v7a'));
    for (const f of readdirSync(s.apkDir)) if (!f.includes('armeabi-v7a-debug')) rmSync(join(s.apkDir, f));
    const r = run(installScript, ['-Serial', SERIAL, '-Adb', s.adb, '-ApkDir', s.apkDir, '-DryRun'], s.env);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: langkah 2/);
    expect(r.out).toContain('tiada MAX-Kiosk-Server-*-armeabi-v7a.apk');
    expect(joinedCalls(calls(s.log)).filter((l) => l.includes('install'))).toEqual([]);
  });

  it('-DebugBuild -Version picks the exact -debug name', () => {
    const s = setup('dbgver', baseRules([], 'armeabi-v7a'));
    const body = Buffer.from('v2 debug');
    const f = join(s.apkDir, 'MAX-Kiosk-Server-2026.11.2-armeabi-v7a-debug.apk');
    writeFileSync(f, body);
    writeFileSync(`${f}.sha256`, `${sha(body)}  x\n`);
    const r = run(installScript, ['-Serial', SERIAL, '-Adb', s.adb, '-ApkDir', s.apkDir, '-Version', '2026.11.2', '-DryRun', '-DebugBuild'], s.env);
    expect(r.out).toMatch(/DRYRUN adb .*install .*MAX-Kiosk-Server-2026\.11\.2-armeabi-v7a-debug\.apk/);
    const miss = run(installScript, ['-Serial', SERIAL, '-Adb', s.adb, '-ApkDir', s.apkDir, '-Version', '2026.11.9', '-DryRun', '-DebugBuild'], s.env);
    expect(miss.status).toBe(1);
    expect(miss.out).toContain('MAX-Kiosk-Server-2026.11.9-armeabi-v7a-debug.apk');
  });

  it('a wrong .sha256 stops before install', () => {
    const s = setup('badsha', baseRules());
    const apk = join(s.apkDir, 'MAX-Kiosk-Server-2026.11.1-arm64-v8a-debug.apk');
    writeFileSync(`${apk}.sha256`, `${'0'.repeat(64)}  x.apk\n`);
    const r = run(installScript, ['-Serial', SERIAL, '-Adb', s.adb, '-ApkDir', s.apkDir, '-Version', '2026.11.1', '-Yes', '-DebugBuild'], s.env);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GAGAL: langkah 2/);
    expect(joinedCalls(calls(s.log)).filter((l) => l.includes('install'))).toEqual([]);
  });

  it('a missing .sha256 stops before install', () => {
    const s = setup('nosha', baseRules());
    rmSync(join(s.apkDir, 'MAX-Kiosk-Server-2026.11.1-arm64-v8a-debug.apk.sha256'));
    const r = run(installScript, ['-Serial', SERIAL, '-Adb', s.adb, '-ApkDir', s.apkDir, '-Version', '2026.11.1', '-Yes', '-DebugBuild'], s.env);
    expect(r.status).toBe(1);
    expect(joinedCalls(calls(s.log)).filter((l) => l.includes('install'))).toEqual([]);
  });

  it('a release install with no signer pin filled in is refused before install', () => {
    const pins = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'android', 'android-pins.json'), 'utf8')) as { signingCertSha256?: string };
    if (pins.signingCertSha256) return; // a pinned repo needs a real signed APK; covered by build-box-apk
    const s = setup('nopin', baseRules());
    const r = run(installScript, ['-Serial', SERIAL, '-Adb', s.adb, '-ApkDir', s.apkDir, '-Version', '2026.11.1', '-Yes'], s.env);
    expect(r.status).toBe(1);
    expect(r.out).toContain('signingCertSha256 belum diisi');
    expect(joinedCalls(calls(s.log)).filter((l) => l.includes('install'))).toEqual([]);
  });

  it('refuses a device that is too small or too old', () => {
    const small = setup('small', baseRules([{ re: '^shell df -k /data$', out: 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/x 3800000 3000000 500000 86% /data\n' }]));
    const r1 = run(installScript, ['-Serial', SERIAL, '-Adb', small.adb, '-ApkDir', small.apkDir, '-DryRun', '-DebugBuild'], small.env);
    expect(r1.status).toBe(1);
    expect(r1.out).toMatch(/GAGAL: langkah 1.*1 GB/);
    const old = setup('old', baseRules([{ re: '^shell getprop ro\\.build\\.version\\.sdk$', out: '26\n' }]));
    const r2 = run(installScript, ['-Serial', SERIAL, '-Adb', old.adb, '-ApkDir', old.apkDir, '-DryRun', '-DebugBuild'], old.env);
    expect(r2.status).toBe(1);
    expect(r2.out).toContain('SDK 26');
  });

  it('step 7 is LANGKAU without the background service, AMARAN when it needs root, SET when it works; never uses root', () => {
    const none = setup('bg-none', baseRules());
    const r0 = run(installScript, ['-Serial', SERIAL, '-Adb', none.adb, '-ApkDir', none.apkDir, '-DryRun', '-DebugBuild'], none.env);
    expect(r0.out).toMatch(/^LANGKAU\s+7\s/m);
    expect(joinedCalls(calls(none.log)).filter((l) => l.includes('service call'))).toEqual([]);

    const deny = setup('bg-deny', baseRules([
      { re: '^shell service check background$', out: 'Service background: found\n' },
      dumpBg(),
      { re: '^shell service call background', out: "Result: Parcel(ffffffff 00000000 '........')\nException: Permission Denial\n" },
    ]));
    const r1 = run(installScript, ['-Serial', SERIAL, '-Adb', deny.adb, '-ApkDir', deny.apkDir, '-Version', '2026.11.1', '-Yes', '-DebugBuild', '-HealthWaitSec', '20'], deny.env);
    expect(r1.out).toMatch(/^AMARAN\s+7\s.*root/m);
    expect(r1.status).toBe(0);
    const all = joinedCalls(calls(deny.log));
    expect(all.filter((l) => /\bsu\b|\broot\b/.test(l))).toEqual([]);
    expect(all.filter((l) => l.includes('service call background 3 i32 1 s16 my.maxcom.box'))).toHaveLength(1);

    const ok = setup('bg-ok', baseRules([
      { re: '^shell service check background$', out: 'Service background: found\n' },
      { re: '^shell dumpsys background$', out: '', seq: [wl(), wl('my.maxcom.box')] },
      { re: '^shell service call background', out: "Result: Parcel(00000000 00000000 '........')\n" },
    ]));
    const r2 = run(installScript, ['-Serial', SERIAL, '-Adb', ok.adb, '-ApkDir', ok.apkDir, '-Version', '2026.11.1', '-Yes', '-DebugBuild', '-HealthWaitSec', '20'], ok.env);
    expect(r2.out).toMatch(/^SET\s+7\s/m);
  });

  describe('step 7 merges the awbms whitelist (the call SETS the whole list)', () => {
    const okCall: Rule = { re: '^shell service call background', out: "Result: Parcel(00000000 00000000 '........')\n" };
    const found: Rule = { re: '^shell service check background$', out: 'Service background: found\n' };
    const go = (name: string, over: Rule[]) => {
      const s = setup(name, baseRules([found, ...over, okCall]));
      const r = run(installScript, ['-Serial', SERIAL, '-Adb', s.adb, '-ApkDir', s.apkDir, '-Version', '2026.11.1', '-Yes', '-DebugBuild', '-HealthWaitSec', '20'], s.env);
      return { r, all: joinedCalls(calls(s.log)).filter((l) => l.includes('service call')) };
    };
    const rereadSeq = (a: string, b: string): Rule => ({ re: '^shell dumpsys background$', out: '', seq: [a, b] });

    it('keeps the existing entry and adds the package (SET, re-read confirms)', () => {
      const { r, all } = go('bg-merge', [rereadSeq(wl('my.example.guard'), wl('my.example.guard', 'my.maxcom.box'))]);
      expect(all).toEqual([`-s ${SERIAL} shell service call background 3 i32 2 s16 my.example.guard s16 my.maxcom.box`]);
      expect(r.out).toMatch(/^SET\s+7\s/m);
    });
    it('package already present: OK and no service call', () => {
      const { r, all } = go('bg-present', [dumpBg('my.example.guard', 'my.maxcom.box')]);
      expect(all).toEqual([]);
      expect(r.out).toMatch(/^OK\s+7\s/m);
    });
    it('empty list writes only the package', () => {
      const { r, all } = go('bg-empty', [rereadSeq(wl(), wl('my.maxcom.box'))]);
      expect(all).toEqual([`-s ${SERIAL} shell service call background 3 i32 1 s16 my.maxcom.box`]);
      expect(r.out).toMatch(/^SET\s+7\s/m);
    });
    it('unparseable section: AMARAN and no write', () => {
      const { r, all } = go('bg-unparse', [{ re: '^shell dumpsys background$', out: 'nothing useful here\n' }]);
      expect(all).toEqual([]);
      expect(r.out).toMatch(/^AMARAN\s+7\s/m);
      expect(r.status).toBe(0);
    });
    it('an existing entry with a space or semicolon: AMARAN and no write', () => {
      const a = go('bg-bad1', [dumpBg('my.example.guard', 'bad entry')]);
      expect(a.all).toEqual([]);
      expect(a.r.out).toMatch(/^AMARAN\s+7\s/m);
      const b = go('bg-bad2', [dumpBg('evil.pkg;rm')]);
      expect(b.all).toEqual([]);
      expect(b.r.out).toMatch(/^AMARAN\s+7\s/m);
    });
    it('re-read missing an entry: AMARAN naming old and new lists', () => {
      const { r, all } = go('bg-lost', [rereadSeq(wl('my.example.guard'), wl('my.maxcom.box'))]);
      expect(all).toHaveLength(1);
      expect(r.out).toMatch(/^AMARAN\s+7\s.*Lama: \[my\.example\.guard\].*Baharu: \[my\.maxcom\.box\]/m);
    });
  });

  it('a full run installs, tunes, sets HOME, waits for health through a forward and removes the forward', () => {
    const s = setup('full', baseRules());
    const r = run(installScript, ['-Serial', SERIAL, '-Adb', s.adb, '-ApkDir', s.apkDir, '-Version', '2026.11.1', '-SetHome', '-Yes', '-DebugBuild', '-HealthWaitSec', '30'], s.env, 180_000);
    expect(r.out).toContain('Alamat kotak: https://10.168.1.50:8443/');
    expect(r.out).toContain('Imbas kod QR pada skrin TV dengan aplikasi MAX Admin Client');
    expect(r.out).toMatch(/^OK\s+9\s/m);
    expect(r.status).toBe(0);
    const c = calls(s.log);
    const apk = join(s.apkDir, 'MAX-Kiosk-Server-2026.11.1-arm64-v8a-debug.apk');
    // The install call is one argv, apk path as one element.
    expect(c.some((a) => JSON.stringify(a) === JSON.stringify(['-s', SERIAL, 'install', '-r', '--no-incremental', apk]))).toBe(true);
    const all = joinedCalls(c);
    expect(all.some((l) => l.includes('shell cmd package set-home-activity my.maxcom.box/.KioskActivity'))).toBe(true);
    expect(all.some((l) => l.includes('shell dumpsys deviceidle whitelist +my.maxcom.box'))).toBe(true);
    // SDK 30: no notification grant, no phantom limit (SDK 31+).
    expect(all.filter((l) => l.includes('pm grant') || l.includes('device_config'))).toEqual([]);
    const fwd = all.filter((l) => /forward tcp:\d+ tcp:8787/.test(l));
    const rem = all.filter((l) => /forward --remove tcp:\d+/.test(l));
    expect(fwd).toHaveLength(1);
    expect(rem).toHaveLength(1);
    for (const a of c) if (a[0] !== 'devices') expect(a.slice(0, 2)).toEqual(['-s', SERIAL]);
    expect(all.filter((l) => /uninstall|pm disable|pm hide|\broot\b|\bsu\b/.test(l))).toEqual([]);
  });

  it('an install signed by another key is reported and nothing is removed', () => {
    const s = setup('sigclash', baseRules([{ re: '^install ', out: 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]\n', code: 1 }]));
    const r = run(installScript, ['-Serial', SERIAL, '-Adb', s.adb, '-ApkDir', s.apkDir, '-Version', '2026.11.1', '-Yes', '-DebugBuild'], s.env);
    expect(r.status).toBe(1);
    expect(r.out).toContain('menghapuskan data surau');
    expect(joinedCalls(calls(s.log)).filter((l) => /uninstall|pm clear|pm disable/.test(l))).toEqual([]);
  });

  it('works with a fake adb found on PATH when -Adb is not given', () => {
    const s = setup('onpath', baseRules());
    const env = { ...s.env, PATH: `${s.dir};${process.env.PATH ?? ''}` };
    const r = run(installScript, ['-Serial', SERIAL, '-ApkDir', s.apkDir, '-Version', '2026.11.1', '-DryRun', '-DebugBuild'], env);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^OK\s+0\s/m);
  });
});

describe.runIf(win)('doctor-android-box.ps1 (run, fake adb)', () => {
  const goodRules = (over: Rule[] = []): Rule[] => [
    ...over,
    { re: '^shell dumpsys package my\\.maxcom\\.box$', out: '  versionCode=2611012 minSdk=28\n  versionName=2026.11.1\n' },
    { re: '^shell cmd package resolve-activity', out: 'priority=0 preferredOrder=0\nmy.maxcom.box/.KioskActivity\n' },
    { re: '^shell dumpsys activity services my\\.maxcom\\.box$', out: '* ServiceRecord{1 u0 my.maxcom.box/.BoxService}\n  isForeground=true foregroundId=1\n' },
    { re: '^shell ps -A$', out: 'USER PID PPID VSZ RSS WCHAN ADDR S NAME\nu0_a54 1000 200 1 1 0 0 S my.maxcom.box\nu0_a54 1001 1000 1 1 0 0 S libnode.so\nu0_a54 1002 1000 1 1 0 0 S libmediamtx.so\n' },
    { re: '^shell ps -A -o ETIME,NAME$', out: ' ELAPSED NAME\n   05:12 libnode.so\n' },
    { re: '^shell dumpsys deviceidle whitelist$', out: 'system-excidle,com.android.shell,2000\nuser,my.maxcom.box,10054\n' },
    { re: '^shell ss -ltnu$', out: 'Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port\ntcp LISTEN 0 128 127.0.0.1:8787 0.0.0.0:*\ntcp LISTEN 0 128 *:8443 *:*\ntcp LISTEN 0 128 127.0.0.1:9997 0.0.0.0:*\nudp UNCONN 0 0 10.168.1.50:8189 0.0.0.0:*\nudp UNCONN 0 0 10.168.1.50:8890 0.0.0.0:*\n' },
    { re: '^shell df -k /data$', out: 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/x 3800000 1500000 2300000 40% /data\n' },
    { re: '^shell cat /sys/class/thermal/thermal_zone\\*/temp$', out: '47000\n51000\n' },
  ];

  it('prints OK lines, exits 0, changes nothing, uses -s and a forward it removes', () => {
    const s = setup('doc-ok', goodRules());
    const r = run(doctorScript, ['-Serial', SERIAL, '-Adb', s.adb], s.env, 180_000);
    expect(r.out).not.toMatch(/^GAGAL/m);
    expect(r.status).toBe(0);
    for (const name of ['pakej', 'skrin-utama', 'perkhidmatan', 'proses', 'bateri', 'port', 'kesihatan', 'ruang', 'suhu']) {
      expect(r.out).toMatch(new RegExp(`^OK\\s+${name}\\s`, 'm'));
    }
    expect(r.out).toContain('versi 2026.11.1');
    const c = calls(s.log);
    for (const a of c) if (a[0] !== 'devices') expect(a.slice(0, 2)).toEqual(['-s', SERIAL]);
    const all = joinedCalls(c);
    expect(all.filter((l) => /\binstall\b|\bput\b|set-home-activity|\bgrant\b|whitelist \+|service call|\bam start\b|uninstall|\broot\b/.test(l))).toEqual([]);
    expect(all.filter((l) => /forward tcp:\d+ tcp:8787/.test(l))).toHaveLength(1);
    expect(all.filter((l) => /forward --remove/.test(l))).toHaveLength(1);
  });

  it('accepts ps lines that show the full path of libnode.so and libmediamtx.so, and refuses look-alike names', () => {
    const lib = '/data/app/~~x/my.maxcom.box-1/lib/arm64';
    const ps = (node: string, mtx: string) =>
      `USER PID PPID VSZ RSS WCHAN ADDR S NAME\nu0_a54 1000 200 1 1 0 0 S my.maxcom.box\nu0_a54 1001 1000 1 1 0 0 S ${node}\nu0_a54 1002 1000 1 1 0 0 S ${mtx}\n`;
    const s = setup('doc-fullpath', goodRules([{ re: '^shell ps -A$', out: ps(`${lib}/libnode.so`, `${lib}/libmediamtx.so`) }]));
    const r = run(doctorScript, ['-Serial', SERIAL, '-Adb', s.adb], s.env, 180_000);
    expect(r.out).toMatch(/^OK\s+proses\s/m);
    const s2 = setup('doc-lookalike', goodRules([{ re: '^shell ps -A$', out: ps('xlibnode.so', 'libmediamtx.so') }]));
    const r2 = run(doctorScript, ['-Serial', SERIAL, '-Adb', s2.adb], s2.env, 180_000);
    expect(r2.out).toMatch(/^GAGAL\s+proses\s.*libnode\.so/m);
  });

  it('fails (exit 1) when 8787 is open beyond loopback, the app is not HOME or the exemption is missing', () => {
    const s = setup('doc-bad', goodRules([
      { re: '^shell ss -ltnu$', out: 'tcp LISTEN 0 128 0.0.0.0:8787 0.0.0.0:*\ntcp LISTEN 0 128 *:8443 *:*\nudp UNCONN 0 0 10.168.1.50:8189 0.0.0.0:*\nudp UNCONN 0 0 10.168.1.50:8890 0.0.0.0:*\n' },
      { re: '^shell cmd package resolve-activity', out: 'priority=0\ncom.google.android.tvlauncher/.MainActivity\n' },
      { re: '^shell dumpsys deviceidle whitelist$', out: 'system-excidle,com.android.shell,2000\n' },
    ]));
    const r = run(doctorScript, ['-Serial', SERIAL, '-Adb', s.adb], s.env, 180_000);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/^GAGAL\s+port\s.*8787 terbuka di luar loopback/m);
    expect(r.out).toMatch(/^GAGAL\s+skrin-utama\s/m);
    expect(r.out).toMatch(/^GAGAL\s+bateri\s/m);
  });

  it('-Json prints a parsable array; a check that cannot run is LANGKAU and does not fail the exit code', () => {
    const s = setup('doc-json', goodRules([{ re: '^shell cat /sys/class/thermal', out: '' }]));
    const r = run(doctorScript, ['-Serial', SERIAL, '-Adb', s.adb, '-Json'], s.env, 180_000);
    const rows = JSON.parse(r.out.slice(r.out.indexOf('['))) as { name: string; status: string }[];
    expect(rows.find((x) => x.name === 'suhu')?.status).toBe('LANGKAU');
    expect(rows.find((x) => x.name === 'pakej')?.status).toBe('OK');
    expect(r.status).toBe(0);
  });

  it('does not run against a device that is not listed', () => {
    const s = setup('doc-nodev', goodRules(), 'List of devices attached\nAAA111\tdevice\n\n');
    const r = run(doctorScript, ['-Serial', SERIAL, '-Adb', s.adb], s.env);
    expect(r.status).toBe(1);
    expect(r.out).toContain('GAGAL');
    expect(existsSync(s.log)).toBe(true);
    expect(calls(s.log).every((c) => c[0] === 'devices')).toBe(true);
  });
});
