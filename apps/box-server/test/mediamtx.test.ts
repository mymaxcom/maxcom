import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediamtxApi, createLiveSecrets, ensureBoxPassword, mediaBindHost, renderMediamtxConfig, startMediamtx, webrtcAdvertisedHosts } from '../src/live/mediamtx.ts';
import type { MediamtxEvent, MediamtxSupervisor } from '../src/live/mediamtx.ts';
import { startFakeMediamtx } from './support/fakeMediamtx.ts';
import type { FakeMediamtx } from './support/fakeMediamtx.ts';

const dirs: string[] = [];
const sups: MediamtxSupervisor[] = [];
const fakes: FakeMediamtx[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of sups.splice(0)) await s.stop();
  for (const f of fakes.splice(0)) await f.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-mtx-'));
  dirs.push(d);
  return d;
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const PASS = 'p4ssw0rd-secret-0123456789abcdef';

describe('renderMediamtxConfig', () => {
  const dataDir = '/var/maxcom/data';
  const yml = renderMediamtxConfig({ dataDir, lanIps: ['10.168.1.20'], password: PASS });

  it('binds every HTTP-ish listener to loopback', () => {
    expect(yml).toMatch(/^apiAddress: 127\.0\.0\.1:9997$/m);
    expect(yml).toMatch(/^rtspAddress: 127\.0\.0\.1:8554$/m);
    expect(yml).toMatch(/^webrtcAddress: 127\.0\.0\.1:8889$/m);
    expect(yml).not.toMatch(/0\.0\.0\.0/);
    // the only address keys without 127.0.0.1 are the two UDP media ports
    const wild = [...yml.matchAll(/^(\w*Address): (?!127\.0\.0\.1|'')(\S+)$/gm)].map((m) => m[1]);
    expect(wild.sort()).toEqual(['srtAddress', 'webrtcLocalUDPAddress']);
  });

  it('binds only the UDP media ports to the LAN, on the certificate LAN address', () => {
    expect(yml).toMatch(/^webrtcLocalUDPAddress: 10\.168\.1\.20:8189$/m);
    expect(yml).toMatch(/^srtAddress: 10\.168\.1\.20:8890$/m);
    expect(yml).toMatch(/^webrtcLocalTCPAddress: ''$/m);
  });

  it('binds media to the single LAN address only; zero or several keep every interface', () => {
    expect(mediaBindHost(['10.168.1.14', '127.0.0.1', '::1'])).toBe('10.168.1.14');
    expect(mediaBindHost(['fd00::5'])).toBe('[fd00::5]');
    expect(mediaBindHost([])).toBe('');
    expect(mediaBindHost(['127.0.0.1'])).toBe('');
    expect(mediaBindHost(['10.168.1.14', '10.0.0.5'])).toBe('');
    const none = renderMediamtxConfig({ dataDir, lanIps: [], password: PASS });
    expect(none).toMatch(/^webrtcLocalUDPAddress: :8189$/m);
    expect(none).toMatch(/^srtAddress: :8890$/m);
  });

  it('turns off every other protocol and listener', () => {
    for (const k of ['rtmp', 'hls', 'playback', 'metrics', 'pprof']) expect(yml).toMatch(new RegExp(`^${k}: no$`, 'm'));
    expect(yml).toMatch(/^api: yes$/m);
    expect(yml).toMatch(/^webrtcEncryption: no$/m);
    expect(yml).toMatch(/^webrtcIPsFromInterfaces: no$/m);
    expect(yml).toMatch(/^webrtcICEServers2: \[\]$/m);
    expect(yml).toMatch(/^rtspTransports: \[tcp\]$/m);
    expect(yml).toMatch(/record: no/);
  });

  it('advertises the LAN IP and loopback only', () => {
    expect(yml).toMatch(/^webrtcAdditionalHosts: \['10\.168\.1\.20'\]$/m);
  });

  it('logs to stdout only, so the supervisor can redact it', () => {
    expect(yml).toMatch(/^logDestinations: \[stdout\]$/m);
    expect(yml).not.toMatch(/^logFile:/m);
    expect(yml).not.toContain('mediamtx.log');
  });

  it('holds the box user as a hash, never the clear password', () => {
    expect(yml).not.toContain(PASS);
    expect(yml).toMatch(/pass: 'sha256:[A-Za-z0-9+/]{43}='/);
    expect(yml).toMatch(/user: box/);
    expect(yml).toMatch(/authMethod: internal/);
  });

  it('restricts the box user to loopback addresses', () => {
    expect(yml).toMatch(/ips: \['127\.0\.0\.1', '::1'\]/);
  });

  it('keeps the surau path as a publisher path with an empty passphrase', () => {
    expect(yml).toMatch(/^paths:\r?\n {2}surau:/m);
    expect(yml).toMatch(/source: publisher/);
    expect(yml).toMatch(/srtPublishPassphrase: ''/);
  });

  it('refuses a LAN address that is not an IP literal', () => {
    expect(() => renderMediamtxConfig({ dataDir, lanIps: ["1.2.3.4', evil: '"], password: PASS })).toThrow();
  });

  const shipped = fileURLToPath(new URL('../../../tools/live/mediamtx/mediamtx.yml', import.meta.url));
  it.skipIf(!existsSync(shipped))('only uses keys that exist in the installed mediamtx.yml', () => {
    const keysOf = (text: string): Set<string> => new Set([...text.matchAll(/^\s*(?:- )?([A-Za-z][A-Za-z0-9_]*):/gm)].map((m) => m[1] as string));
    const known = keysOf(readFileSync(shipped, 'utf8'));
    const ours = [...keysOf(yml)].filter((k) => k !== 'surau');
    expect(ours.filter((k) => !known.has(k))).toEqual([]);
  });
  if (!existsSync(shipped)) console.warn('NOTICE: tools/live/mediamtx/mediamtx.yml not installed; config key check skipped');
});

describe('rendered config: listeners and advertised addresses', () => {
  const yml = renderMediamtxConfig({ dataDir: '/var/maxcom/data', lanIps: ['10.168.1.20'], password: PASS });
  const shipped = fileURLToPath(new URL('../../../tools/live/mediamtx/mediamtx.yml', import.meta.url));
  // the only protocols this box uses
  const USED = ['api', 'rtsp', 'srt', 'webrtc'];

  const flagsOf = (text: string): Map<string, boolean> =>
    new Map([...text.matchAll(/^([A-Za-z][A-Za-z0-9]*): ?(yes|no|true|false)\s*(?:#.*)?$/gm)].map((m) => [m[1] as string, m[2] === 'yes' || m[2] === 'true']));

  it('switches the MoQ server off by name (v1.21 enables it on :8892 and :8893 by default)', () => {
    expect(yml).toMatch(/^moq: no$/m);
  });

  it('turns off every protocol this box does not use, by name', () => {
    const flags = flagsOf(yml);
    for (const k of ['rtmp', 'hls', 'playback', 'metrics', 'pprof', 'moq']) expect(flags.get(k), k).toBe(false);
    for (const k of USED) expect(flags.get(k), k).toBe(true);
  });

  it.skipIf(!existsSync(shipped))('leaves no listener of the installed default config enabled except api, rtsp, webrtc and srt', () => {
    const text = readFileSync(shipped, 'utf8');
    const defaults = flagsOf(text);
    // a listener-enabling key is a top-level on/off switch with an address key of its own (moq has moqHTTP2Address, ...)
    const addressKeys = [...text.matchAll(/^([A-Za-z][A-Za-z0-9]*Address):/gm)].map((m) => m[1] as string);
    const listeners = [...defaults.keys()].filter((k) => addressKeys.some((a) => a.startsWith(k)));
    expect(listeners.sort()).toEqual(expect.arrayContaining(['api', 'hls', 'metrics', 'moq', 'playback', 'pprof', 'rtmp', 'rtsp', 'srt', 'webrtc']));
    const ours = flagsOf(yml);
    // a missing key falls back to the shipped default (all of these default to on)
    const enabled = listeners.filter((k) => ours.get(k) ?? defaults.get(k) ?? false);
    expect(enabled.sort()).toEqual([...USED].sort());
  });

  it('every address key is loopback, or one of the two LAN UDP ports, or empty', () => {
    const pairs = [...yml.matchAll(/^([A-Za-z0-9]*Address): (.+)$/gm)].map((m) => [m[1] as string, (m[2] as string).trim()] as const);
    expect(pairs.length).toBeGreaterThanOrEqual(5);
    const lan = new Map([
      ['webrtcLocalUDPAddress', '10.168.1.20:8189'],
      ['srtAddress', '10.168.1.20:8890'],
    ]);
    for (const [key, value] of pairs) {
      const ok = /^127\.0\.0\.1:\d+$/.test(value) || value === "''" || lan.get(key) === value;
      expect(ok, `${key}: ${value}`).toBe(true);
    }
    // and the two LAN ports are exactly UDP media ports, with no TCP ICE listener
    expect(pairs.filter(([, v]) => !v.startsWith('127.') && v !== "''").map(([k]) => k).sort()).toEqual(['srtAddress', 'webrtcLocalUDPAddress']);
    expect(yml).toMatch(/^webrtcLocalTCPAddress: ''$/m);
  });

  it('advertises only the LAN addresses of the certificate to WebRTC clients, never every interface', () => {
    expect(yml).toMatch(/^webrtcIPsFromInterfaces: no$/m);
    // a VPN adapter (10.66.0.4) that the certificate does not name is not offered
    const two = renderMediamtxConfig({ dataDir: '/d', lanIps: ['10.168.1.14', '127.0.0.1', '::1', '169.254.3.4'], password: PASS });
    expect(two).toMatch(/^webrtcAdditionalHosts: \['10\.168\.1\.14'\]$/m);
    expect(two).not.toContain('10.66.0.4');
    expect(two).not.toContain('169.254');
  });

  it('lists several LAN addresses once each, and falls back to loopback only when there is none', () => {
    expect(webrtcAdvertisedHosts(['10.168.1.14', '10.168.1.14', '10.0.0.5'])).toEqual(['10.168.1.14', '10.0.0.5']);
    expect(webrtcAdvertisedHosts([])).toEqual(['127.0.0.1']);
    expect(webrtcAdvertisedHosts(['127.0.0.1', '::1'])).toEqual(['127.0.0.1']);
  });

  it('declares the kiosk audio path as a publisher path next to surau', () => {
    expect(yml).toMatch(/^ {2}surau-kiosk:\r?\n {4}source: publisher$/m);
  });
});

describe('ensureBoxPassword', () => {
  it('creates a 32 char password once and reuses it', () => {
    const dir = tempDir();
    const a = ensureBoxPassword(dir);
    expect(a).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(ensureBoxPassword(dir)).toBe(a);
    expect(readFileSync(join(dir, 'secret', 'mediamtx.pass'), 'utf8').trim()).toBe(a);
  });
});

describe('startMediamtx supervisor', () => {
  function sup(script: string, extra: Record<string, unknown> = {}): { s: MediamtxSupervisor; events: MediamtxEvent[]; dir: string } {
    const dir = tempDir();
    const events: MediamtxEvent[] = [];
    const s = startMediamtx({
      exe: process.execPath,
      args: ['-e', script],
      dataDir: dir,
      backoffBaseMs: 10,
      backoffMaxMs: 40,
      onEvent: (e) => events.push(e),
      ...extra,
    });
    sups.push(s);
    return { s, events, dir };
  }

  it('restarts a crashing process with growing delay', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { s, events } = sup('process.exit(1)', { maxRestarts: 4 });
    s.start();
    await until(() => s.status().state === 'failed');
    const delays = events.filter((e) => e.type === 'backoff').map((e) => e.delayMs);
    expect(delays).toEqual([10, 20, 40, 40]);
    expect(s.status().restarts).toBe(4);
  });

  it('marks failed after the 10th restart in the window and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { s, events } = sup('process.exit(1)');
    s.start();
    // 11 real process spawns: slow on a loaded Windows machine.
    await until(() => s.status().state === 'failed', 25_000);
    expect(s.status().restarts).toBe(10);
    expect(events.filter((e) => e.type === 'spawn')).toHaveLength(11);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(s.status().running).toBe(false);
    expect(s.status().lastExit).not.toBeNull();
    await new Promise((r) => setTimeout(r, 120));
    expect(events.filter((e) => e.type === 'spawn')).toHaveLength(11);
  }, 40_000);

  it('reports running with a pid, and stops cleanly without restarting', async () => {
    const { s, events } = sup('setInterval(() => {}, 1000)');
    s.start();
    await until(() => s.status().running);
    expect(s.status().pid).toBeGreaterThan(0);
    expect(s.status().state).toBe('running');
    expect(s.status().since).not.toBeNull();
    await s.stop();
    expect(s.status().running).toBe(false);
    expect(s.status().state).toBe('stopped');
    await new Promise((r) => setTimeout(r, 100));
    expect(events.filter((e) => e.type === 'spawn')).toHaveLength(1);
  });

  it('stop() during backoff cancels the restart', async () => {
    const { s, events } = sup('process.exit(1)', { backoffBaseMs: 500, backoffMaxMs: 500 });
    s.start();
    await until(() => events.some((e) => e.type === 'backoff'));
    await s.stop();
    await new Promise((r) => setTimeout(r, 120));
    expect(events.filter((e) => e.type === 'spawn')).toHaveLength(1);
    expect(s.status().state).toBe('stopped');
  });

  it('writes child output to mediamtx.out.log with the password redacted', async () => {
    const { s, dir } = sup(`console.log('hello ${PASS} world'); setInterval(() => {}, 1000)`, { redact: [PASS] });
    s.start();
    const log = join(dir, 'live', 'mediamtx.out.log');
    await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('world'));
    const text = readFileSync(log, 'utf8');
    expect(text).not.toContain(PASS);
    expect(text).toContain('hello ***');
  });

  it('redacts live session credentials registered after start, raw and URL-encoded, from the log', async () => {
    const secrets = createLiveSecrets();
    const pub = 'PubPassAbc123XyzPubPassAbc123Xy';
    const phrase = 'Passphrase24AlnumAbcdefg';
    const relay = 'RelayReadPass0123456789abcdefgh';
    const script = `
      setTimeout(() => {
        console.log('SRT closed: invalid stream ID publish:surau:pub-s1:${pub}');
        console.log('SRT closed: invalid stream ID publish%3Asurau%3Apub-s1%3A${pub}');
        console.log('conn passphrase=${phrase} read rtsp://relay-s1:${relay}@127.0.0.1:8554/surau');
        console.error('box ${PASS} and ${encodeURIComponent('p4ssw0rd secret/x')}');
        console.log('tail-marker');
      }, 300);
      setInterval(() => {}, 1000)`;
    const { s, dir } = sup(script, { redact: () => [PASS, ...secrets.list()] });
    s.start();
    // registered after the supervisor is already running (a session starts later)
    secrets.add(pub, phrase, relay, 'p4ssw0rd secret/x');
    const log = join(dir, 'live', 'mediamtx.out.log');
    await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('tail-marker'));
    const text = readFileSync(log, 'utf8');
    for (const secret of [pub, phrase, relay, PASS, 'p4ssw0rd secret/x', encodeURIComponent('p4ssw0rd secret/x')]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('invalid stream ID publish:surau:pub-s1:***');
    expect(text).toContain('publish%3Asurau%3Apub-s1%3A***');
  });

  it('runs MediaMTX with the live folder as its working directory', async () => {
    const { s, dir } = sup(`console.log('cwd=' + process.cwd()); setInterval(() => {}, 1000)`);
    s.start();
    const log = join(dir, 'live', 'mediamtx.out.log');
    await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('cwd='));
    const line = readFileSync(log, 'utf8').split(String.fromCharCode(10)).find((l) => l.includes('cwd=')) ?? '';
    expect(realpathSync(line.slice(line.indexOf('cwd=') + 4).trim())).toBe(realpathSync(join(dir, 'live')));
  });

  it('never prints the password on the console', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    }
    const { s } = sup(`console.log('${PASS}'); process.exit(1)`, { redact: [PASS], maxRestarts: 1 });
    s.start();
    await until(() => s.status().state === 'failed');
    expect(logs.join('\n')).not.toContain(PASS);
  });

  it('rotates the output log at the size limit', async () => {
    const { s, dir } = sup(`for (let i = 0; i < 400; i++) console.log('x'.repeat(100)); setInterval(() => {}, 1000)`, { logMaxBytes: 10_000 });
    s.start();
    await until(() => existsSync(join(dir, 'live', 'mediamtx.out.log.1')));
    await s.stop();
    const size = readFileSync(join(dir, 'live', 'mediamtx.out.log')).length;
    expect(size).toBeLessThanOrEqual(10_000 + 200);
  });

  it('start() twice does not spawn two processes', async () => {
    const { s, events } = sup('setInterval(() => {}, 1000)');
    s.start();
    s.start();
    await until(() => s.status().running);
    expect(events.filter((e) => e.type === 'spawn')).toHaveLength(1);
  });
});

describe('MediamtxApi against the fake', () => {
  async function api(): Promise<{ api: MediamtxApi; fake: FakeMediamtx }> {
    const fake = await startFakeMediamtx();
    fakes.push(fake);
    return { api: new MediamtxApi({ port: fake.port, user: fake.user, pass: fake.pass }), fake };
  }

  it('pathGet parses ready and bytesReceived', async () => {
    const { api: a, fake } = await api();
    expect((await a.pathGet('surau')).ready).toBe(false);
    fake.setReady(true, { bytesReceived: 4096, sourceType: 'webRTCSession', sourceId: 's1', tracks: ['H264', 'Opus'], readers: 2 });
    const p = await a.pathGet('surau');
    expect(p.ready).toBe(true);
    expect(p.bytesReceived).toBe(4096);
    expect(p.source).toEqual({ type: 'webRTCSession', id: 's1' });
    expect(p.readers).toBe(2);
    expect(p.tracks).toEqual(['H264', 'Opus']);
  });

  it('adds a second and third user although MediaMTX reads stored users back with null slices (v1.21), and removes one', async () => {
    const { api: a, fake } = await api();
    await a.authUserAdd({ user: 'pub-1', pass: 'p1', permissions: [{ action: 'publish', path: 'surau' }] });
    await a.authUserAdd({ user: 'relay-1', pass: 'p2', permissions: [{ action: 'read', path: 'surau' }], ips: ['127.0.0.1', '::1'] });
    await a.authUserAdd({ user: 'kioskaudio-1', pass: 'p3', permissions: [{ action: 'read', path: 'surau' }], ips: ['127.0.0.1', '::1'] });
    const users = fake.global.authInternalUsers;
    expect(users.map((u) => u.user)).toEqual(['box', 'pub-1', 'relay-1', 'kioskaudio-1']);
    for (const u of users) {
      expect(Array.isArray(u.ips)).toBe(true);
      expect(Array.isArray(u.permissions)).toBe(true);
    }
    expect(users.find((u) => u.user === 'pub-1')?.ips).toEqual([]);
    expect(users.find((u) => u.user === 'relay-1')?.ips).toEqual(['127.0.0.1', '::1']);
    await a.authUserRemove('pub-1');
    expect(fake.global.authInternalUsers.map((u) => u.user)).toEqual(['box', 'relay-1', 'kioskaudio-1']);
  });

  it('refuses a user ip that is not an IP literal', async () => {
    const { api: a } = await api();
    await expect(a.authUserAdd({ user: 'relay-2', pass: 'p', permissions: [], ips: ['0.0.0.0/0; evil'] })).rejects.toThrow('bad ip');
  });

  it('pathGet of an unknown path is not ready (no throw)', async () => {
    const { api: a } = await api();
    expect((await a.pathGet('nothing')).ready).toBe(false);
  });

  it('sends basic auth', async () => {
    const { api: a, fake } = await api();
    await a.pathGet('surau');
    const expected = `Basic ${Buffer.from(`${fake.user}:${fake.pass}`).toString('base64')}`;
    expect(fake.requests[0]?.authorization).toBe(expected);
  });

  it('a wrong password surfaces as an error with no secret in the message', async () => {
    const { fake } = await api();
    const bad = new MediamtxApi({ port: fake.port, user: fake.user, pass: 'wrong-' + PASS });
    const err = await bad.pathGet('surau').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/401|auth/i);
    expect((err as Error).message).not.toContain(PASS);
  });

  it('authUserAdd and authUserRemove round-trip through the global config', async () => {
    const { api: a, fake } = await api();
    await a.authUserAdd({ user: 'pub-abc', pass: 'secretpass', permissions: [{ action: 'publish', path: 'surau' }] });
    const users = fake.global.authInternalUsers as Array<{ user: string; pass: string; permissions: unknown[] }>;
    expect(users.map((u) => u.user)).toEqual(['box', 'pub-abc']);
    expect(users[1]?.permissions).toEqual([{ action: 'publish', path: 'surau' }]);
    await a.authUserAdd({ user: 'pub-abc', pass: 'other', permissions: [{ action: 'publish', path: 'surau' }] });
    expect((fake.global.authInternalUsers as unknown[]).length).toBe(2);
    await a.authUserRemove('pub-abc');
    expect((fake.global.authInternalUsers as Array<{ user: string }>).map((u) => u.user)).toEqual(['box']);
    await a.authUserRemove('pub-abc');
  });

  it('refuses to remove the box user or add one called box', async () => {
    const { api: a } = await api();
    await expect(a.authUserRemove('box')).rejects.toThrow();
    await expect(a.authUserAdd({ user: 'box', pass: 'x', permissions: [] })).rejects.toThrow();
  });

  it('serialises concurrent user changes (no lost update)', async () => {
    const { api: a, fake } = await api();
    await Promise.all(
      ['u1', 'u2', 'u3', 'u4'].map((user) => a.authUserAdd({ user, pass: 'p', permissions: [{ action: 'publish', path: 'surau' }] })),
    );
    expect((fake.global.authInternalUsers as Array<{ user: string }>).map((u) => u.user).sort()).toEqual(['box', 'u1', 'u2', 'u3', 'u4']);
  });

  it('pathsPatch sets the srt passphrase', async () => {
    const { api: a, fake } = await api();
    await a.pathsPatch('surau', { srtPublishPassphrase: 'abcdefghijklmnopqrstuvwx' });
    expect(fake.paths.get('surau')).toEqual({ srtPublishPassphrase: 'abcdefghijklmnopqrstuvwx' });
  });

  it('kickPublisher kicks webrtc and srt sessions by id', async () => {
    const { api: a, fake } = await api();
    await a.kickPublisher({ type: 'webRTCSession', id: 'w1' });
    await a.kickPublisher({ type: 'srtConn', id: 's1' });
    expect(fake.kicked).toEqual(['webrtcsessions/w1', 'srtconns/s1']);
  });

  it('kickPublisher ignores other source types and bad ids', async () => {
    const { api: a, fake } = await api();
    await a.kickPublisher({ type: 'rtspSession', id: 'x' });
    await a.kickPublisher({ type: 'webRTCSession', id: '../etc' });
    expect(fake.kicked).toEqual([]);
  });

  it('health is true against the fake and false when nothing listens', async () => {
    const { api: a, fake } = await api();
    expect(await a.health()).toBe(true);
    await fake.close();
    fakes.length = 0;
    expect(await a.health()).toBe(false);
  });

  it('times out a hung server', async () => {
    const http = await import('node:http');
    const hung = http.createServer(() => undefined);
    await new Promise<void>((r) => hung.listen(0, '127.0.0.1', r));
    const port = (hung.address() as { port: number }).port;
    const a = new MediamtxApi({ port, user: 'box', pass: 'x', timeoutMs: 150 });
    const t0 = Date.now();
    await expect(a.pathGet('surau')).rejects.toThrow(/timeout/i);
    expect(Date.now() - t0).toBeLessThan(2000);
    hung.closeAllConnections();
    await new Promise<void>((r) => hung.close(() => r()));
  });
});

describe('app wiring', () => {
  it('buildApp without liveTools starts nothing', async () => {
    const { buildApp } = await import('../src/app.ts');
    const app = buildApp(':memory:');
    await app.ready();
    expect(app.liveRuntime).toBeNull();
    await app.close();
  });

  it('buildApp with an empty tools folder reports missing tools and does not throw', async () => {
    const { buildApp } = await import('../src/app.ts');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dir = tempDir();
    mkdirSync(join(dir, 'tools'));
    const app = buildApp(':memory:', { dataDir: join(dir, 'data'), liveTools: { dir: join(dir, 'tools') } });
    await app.ready();
    expect(app.liveRuntime?.tools.missing).toEqual(['mediamtx', 'ffmpeg']);
    expect(app.liveRuntime?.supervisor).toBeNull();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/live tools/i);
    await app.close();
  });

  it('buildApp supervises MediaMTX after ready and stops it on close', async () => {
    const { buildApp } = await import('../src/app.ts');
    const dir = tempDir();
    const tools = join(dir, 'tools');
    mkdirSync(join(tools, 'mediamtx'), { recursive: true });
    mkdirSync(join(tools, 'ffmpeg'), { recursive: true });
    writeFileSync(join(tools, 'ffmpeg', 'ffmpeg.exe'), 'stub');
    writeFileSync(join(tools, 'mediamtx', 'mediamtx.exe'), 'stub');
    const events: MediamtxEvent[] = [];
    const app = buildApp(':memory:', {
      dataDir: join(dir, 'data'),
      liveTools: { dir: tools, spawn: { exe: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], onEvent: (e) => events.push(e) } },
    });
    await app.ready();
    const sup = app.liveRuntime?.supervisor;
    expect(sup).toBeTruthy();
    await until(() => sup?.status().running === true);
    expect(existsSync(join(dir, 'data', 'live', 'mediamtx.yml'))).toBe(true);
    expect(existsSync(join(dir, 'data', 'secret', 'mediamtx.pass'))).toBe(true);
    await app.close();
    expect(sup?.status().running).toBe(false);
  });
});
