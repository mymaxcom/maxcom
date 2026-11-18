import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAMERA_PASSWORD_MASK } from '@surau/core';
import { CameraError, CameraStore, CameraTester, cameraPullUrl, cameraSecrets, pullFailureReason } from '../src/live/camera.ts';
import type { CameraRecord, MediamtxLogTail } from '../src/live/camera.ts';
import { createLiveSecrets } from '../src/live/mediamtx.ts';

/** The MediaMTX lines recorded in T0 (2026-11-17), as the supervisor writes them (`out ` prefix). */
const LINE = {
  login: 'out 2026/11/17 06:37:18 ERR [path surau-uji] [RTSP source] bad status code: 401 (Unauthorized)',
  path: 'out 2026/11/17 06:37:30 ERR [path surau-uji] [RTSP source] bad status code: 404 (Not Found)',
  refused: 'out 2026/11/17 06:38:01 ERR [path surau-uji] [RTSP source] dial tcp 10.168.1.20:8699: connectex: No connection could be made because the target machine actively refused it.',
  timeout: 'out 2026/11/17 06:38:20 ERR [path surau-uji] [RTSP source] dial tcp 10.255.255.1:554: i/o timeout',
  eof: 'out 2026/11/17 06:38:40 ERR [path surau-uji] [RTSP source] EOF',
  started: 'out 2026/11/17 06:37:12 INF [path surau-uji] [RTSP source] started',
  other: 'out 2026/11/17 06:37:18 ERR [path surau-cam] [RTSP source] bad status code: 401 (Unauthorized)',
};

describe('pullFailureReason: the recorded MediaMTX lines', () => {
  it('maps each T0 line to its reason', () => {
    expect(pullFailureReason([LINE.login])).toBe('login');
    expect(pullFailureReason([LINE.path])).toBe('path');
    expect(pullFailureReason([LINE.refused])).toBe('port_closed');
    expect(pullFailureReason([LINE.timeout])).toBe('no_answer');
    expect(pullFailureReason([LINE.eof])).toBe('unknown');
    expect(pullFailureReason([LINE.started])).toBe('unknown');
    expect(pullFailureReason([])).toBe('unknown');
  });

  it('reads only the test path, and the newest recognised line decides', () => {
    expect(pullFailureReason([LINE.other])).toBe('unknown');
    expect(pullFailureReason([LINE.login, LINE.started, LINE.path])).toBe('path');
    expect(pullFailureReason([LINE.timeout, LINE.eof])).toBe('no_answer');
  });
});

/* ---------------------------------------------------------------- the tester, against a scripted MediaMTX */

interface Script {
  /** Transports under which this address delivers a picture. */
  worksOn?: Array<'tcp' | 'udp'>;
  tracks?: string[];
  /** The log line MediaMTX writes while it fails. */
  fail?: string;
}

const CAM = (name: string): string => `rtsp://viewer:lihat123@10.168.1.20:554/${name}`;

function rig(scripts: Record<string, Script>, opts: { patchFails?: boolean; getFails?: boolean } = {}) {
  const patches: Array<{ name: string; patch: Record<string, unknown> }> = [];
  const lines: string[] = [];
  let current: { script: Script; transport: string } | null = null;
  const api = {
    async pathsPatch(name: string, patch: Record<string, unknown>): Promise<void> {
      patches.push({ name, patch: { ...patch } });
      if (opts.patchFails && typeof patch.source === 'string' && patch.source !== 'publisher') throw new Error('mediamtx api: PATCH failed with status 500');
      if (patch.source === 'publisher') {
        current = null;
        return;
      }
      const script = scripts[String(patch.source)] ?? { fail: LINE.timeout };
      current = { script, transport: String(patch.rtspTransport) };
      if (!(script.worksOn ?? []).includes(current.transport as 'tcp' | 'udp') && script.fail !== undefined) lines.push(script.fail);
    },
    async pathGet(): Promise<{ ready: boolean; source: { type: string; id: string } | null; readers: number; bytesReceived: number; tracks: string[] }> {
      if (opts.getFails) throw new Error('mediamtx api: unreachable (ECONNREFUSED)');
      const ok = current !== null && (current.script.worksOn ?? []).includes(current.transport as 'tcp' | 'udp');
      return { ready: ok, source: ok ? { type: 'rtspSource', id: '' } : null, readers: 0, bytesReceived: 0, tracks: ok ? (current?.script.tracks ?? []) : [] };
    },
  };
  const log: MediamtxLogTail = { mark: () => lines.length, since: (m) => lines.slice(m) };
  const secrets = createLiveSecrets();
  const mk = (o: { api?: typeof api | null } = {}) =>
    new CameraTester({ api: () => (o.api === undefined ? api : o.api), log, secrets, readyTimeoutMs: 60, pollMs: 1, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => new Date('2026-11-17T08:00:00Z') });
  return { api, patches, lines, secrets, tester: mk(), mk };
}

const rec = (name: string): CameraRecord => ({ url: CAM(name) });
const sources = (patches: Array<{ patch: Record<string, unknown> }>): unknown[] => patches.map((p) => p.patch.source);

describe('CameraTester.testCamera', () => {
  it('ok over TCP with picture and sound: codecs and audio stored, the test path put back', async () => {
    const r = rig({ [CAM('main')]: { worksOn: ['tcp', 'udp'], tracks: ['H264', 'MPEG-4 Audio'] } });
    const out = await r.tester.testCamera(rec('main'), 'tcp', []);
    expect(out).toMatchObject({ code: 'ok', ok: true, hasAudio: true, codecs: ['H264', 'MPEG-4 Audio'], transport: 'tcp' });
    expect(r.patches[0]).toEqual({ name: 'surau-uji', patch: { source: CAM('main'), sourceOnDemand: false, rtspTransport: 'tcp' } });
    expect(r.patches.at(-1)).toEqual({ name: 'surau-uji', patch: { source: 'publisher' } });
  });

  it('G.711 sound counts as audio; a picture without sound is hasAudio false', async () => {
    const g = rig({ [CAM('g')]: { worksOn: ['tcp'], tracks: ['H264', 'G711'] }, [CAM('n')]: { worksOn: ['tcp'], tracks: ['H264'] } });
    expect((await g.tester.testCamera(rec('g'), 'tcp', [])).hasAudio).toBe(true);
    expect(await g.tester.testCamera(rec('n'), 'tcp', [])).toMatchObject({ code: 'ok', hasAudio: false, codecs: ['H264'] });
  });

  it('H.265 alone is refused for the box path (codec) but the tracks are still reported', async () => {
    const r = rig({ [CAM('h')]: { worksOn: ['tcp'], tracks: ['H265', 'MPEG-4 Audio'] } });
    expect(await r.tester.testCamera(rec('h'), 'tcp', [])).toMatchObject({ code: 'codec', ok: false, hasAudio: true, codecs: ['H265', 'MPEG-4 Audio'] });
  });

  it.each([
    ['login', LINE.login, 'login'],
    ['path', LINE.path, 'path'],
    ['port closed', LINE.refused, 'unreachable'],
    ['no answer', LINE.timeout, 'unreachable'],
    ['an unrecognised failure', LINE.eof, 'unreachable'],
  ])('failure %s (from the MediaMTX log) gives result code %s; closed port and no answer share one code', async (_n, line, code) => {
    const r = rig({ [CAM('x')]: { worksOn: [], fail: line } });
    const out = await r.tester.testCamera(rec('x'), 'tcp', []);
    expect(out).toMatchObject({ code, ok: false, hasAudio: null, codecs: [], transport: null });
    expect(r.patches.at(-1)).toEqual({ name: 'surau-uji', patch: { source: 'publisher' } });
  });

  it('forced TCP and forced UDP make one attempt each with that transport', async () => {
    const r = rig({ [CAM('u')]: { worksOn: ['udp'], tracks: ['H264'], fail: LINE.timeout } });
    expect((await r.tester.testCamera(rec('u'), 'tcp', [])).code).toBe('unreachable');
    expect(r.patches.filter((p) => p.patch.source === CAM('u')).map((p) => p.patch.rtspTransport)).toEqual(['tcp']);
    expect((await r.tester.testCamera(rec('u'), 'udp', [])).code).toBe('ok');
    expect(r.patches.filter((p) => p.patch.source === CAM('u')).map((p) => p.patch.rtspTransport)).toEqual(['tcp', 'udp']);
  });

  it('Automatik tries TCP, then UDP, and reports the transport that worked', async () => {
    const r = rig({ [CAM('u')]: { worksOn: ['udp'], tracks: ['H264', 'G711'], fail: LINE.timeout } });
    const out = await r.tester.testCamera(rec('u'), 'auto', []);
    expect(out).toMatchObject({ code: 'ok', transport: 'udp' });
    expect(r.patches.filter((p) => p.patch.source === CAM('u')).map((p) => p.patch.rtspTransport)).toEqual(['tcp', 'udp']);
  });

  it('Automatik stays on TCP when TCP works', async () => {
    const r = rig({ [CAM('t')]: { worksOn: ['tcp', 'udp'], tracks: ['H264'] } });
    expect((await r.tester.testCamera(rec('t'), 'auto', [])).transport).toBe('tcp');
    expect(r.patches.filter((p) => p.patch.source === CAM('t'))).toHaveLength(1);
  });

  it('Automatik does not retry a wrong login or a wrong stream path over UDP', async () => {
    const a = rig({ [CAM('l')]: { worksOn: [], fail: LINE.login } });
    expect((await a.tester.testCamera(rec('l'), 'auto', [])).code).toBe('login');
    expect(a.patches.filter((p) => p.patch.source === CAM('l'))).toHaveLength(1);
    const b = rig({ [CAM('p')]: { worksOn: [], fail: LINE.path } });
    expect((await b.tester.testCamera(rec('p'), 'auto', [])).code).toBe('path');
    expect(b.patches.filter((p) => p.patch.source === CAM('p'))).toHaveLength(1);
  });

  it('Automatik with both transports failing reports the failure of the last attempt', async () => {
    const r = rig({ [CAM('x')]: { worksOn: [], fail: LINE.timeout } });
    expect((await r.tester.testCamera(rec('x'), 'auto', [])).code).toBe('unreachable');
    expect(r.patches.filter((p) => p.patch.source === CAM('x')).map((p) => p.patch.rtspTransport)).toEqual(['tcp', 'udp']);
  });

  it('the test path is put back when MediaMTX errors in the middle (and the answer is "unavailable")', async () => {
    const r = rig({ [CAM('x')]: { worksOn: ['tcp'], tracks: ['H264'] } }, { getFails: true });
    expect((await r.tester.testCamera(rec('x'), 'tcp', [])).code).toBe('unavailable');
    expect(r.patches.at(-1)).toEqual({ name: 'surau-uji', patch: { source: 'publisher' } });
    expect(r.tester.busy).toBe(false);
  });

  it('is put back even when the patch itself failed', async () => {
    const r = rig({}, { patchFails: true });
    expect((await r.tester.testCamera(rec('x'), 'tcp', [])).code).toBe('unavailable');
    expect(r.patches.at(-1)).toEqual({ name: 'surau-uji', patch: { source: 'publisher' } });
  });

  it('one test at a time: a second call while one runs is busy and touches nothing', async () => {
    const r = rig({ [CAM('x')]: { worksOn: [], fail: LINE.timeout } });
    const first = r.tester.testCamera(rec('x'), 'tcp', []);
    const second = await r.tester.testCamera(rec('x'), 'tcp', []);
    expect(second.code).toBe('busy');
    await first;
    expect(r.tester.busy).toBe(false);
  });

  it('refuses without an address, with an address the rules refuse, and with no MediaMTX; nothing is patched', async () => {
    const r = rig({});
    expect((await r.tester.testCamera(null, 'tcp', [])).code).toBe('not_configured');
    expect((await r.tester.testCamera({ url: 'rtsp://8.8.8.8:554/x' }, 'tcp', [])).code).toBe('bad_address');
    expect((await r.tester.testCamera({ url: 'rtsp://127.0.0.1:554/x' }, 'tcp', [])).code).toBe('bad_address');
    expect((await r.tester.testCamera({ url: 'rtsp://10.168.1.5:554/x' }, 'tcp', ['10.168.1.5'])).code).toBe('bad_address');
    expect((await r.mk({ api: null }).testCamera(rec('x'), 'tcp', [])).code).toBe('unavailable');
    expect(r.patches).toEqual([]);
  });

  it('adds the login to the log redactor before the address reaches MediaMTX, and returns it nowhere', async () => {
    const r = rig({ [CAM('main')]: { worksOn: ['tcp'], tracks: ['H264'] } });
    const out = await r.tester.testCamera(rec('main'), 'tcp', []);
    expect(r.secrets.list()).toEqual(expect.arrayContaining(['lihat123', 'viewer']));
    expect(JSON.stringify(out)).not.toMatch(/lihat123|viewer/);
    // the address travels as one JSON string through the API, nowhere else
    expect(r.patches.filter((p) => JSON.stringify(p).includes('lihat123')).every((p) => p.name === 'surau-uji' && p.patch.source === CAM('main'))).toBe(true);
  });

  it('a separate login is put into the address for the pull only when the address has none', async () => {
    const url = 'rtsp://10.168.1.20:554/main';
    const r = rig({ 'rtsp://cam%40x:p%40ss%27w@10.168.1.20:554/main': { worksOn: ['tcp'], tracks: ['H264'] } });
    expect((await r.tester.testCamera({ url, username: 'cam@x', password: "p@ss'w" }, 'tcp', [])).code).toBe('ok');
    expect(r.secrets.list()).toEqual(expect.arrayContaining(["p@ss'w", 'cam@x']));
  });
});

describe('cameraPullUrl and cameraSecrets', () => {
  it('credentials in the address win over the separate boxes', () => {
    expect(cameraPullUrl({ url: 'rtsp://a:b@10.168.1.2/x', username: 'u', password: 'p' })).toBe('rtsp://a:b@10.168.1.2/x');
    expect(cameraPullUrl({ url: 'rtsp://10.168.1.2/x', username: 'u', password: 'p' })).toBe('rtsp://u:p@10.168.1.2/x');
    expect(cameraPullUrl({ url: 'rtsp://10.168.1.2/x', username: 'u' })).toBe('rtsp://u@10.168.1.2/x');
    expect(cameraPullUrl({ url: 'rtsp://10.168.1.2/x', password: 'p' })).toBe('rtsp://10.168.1.2/x');
  });

  it('lists every spelling of the login to scrub', () => {
    const s = cameraSecrets({ url: 'rtsp://us%40er:pa%3Ass@10.168.1.2/x' });
    expect(s).toEqual(expect.arrayContaining(['us%40er', 'us@er', 'pa%3Ass', 'pa:ss']));
  });
});

/* ---------------------------------------------------------------- the sealed store */

describe('CameraStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'surau-cam-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const mk = (): CameraStore => new CameraStore(dir, { boxIps: ['10.168.1.2'], now: () => new Date('2026-11-17T08:00:00Z') });
  const allFiles = (): string => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name !== 'box.key') out.push(readFileSync(p, 'latin1'));
      }
    };
    walk(dir);
    return out.join('\n');
  };

  it('starts empty', () => {
    const s = mk();
    expect(s.get()).toBeNull();
    expect(s.lastTest).toBeNull();
    expect(s.getMasked()).toEqual({ configured: false, url: '', username: null, hasPassword: false, lastTest: null });
  });

  it('seals the address: the file holds no readable address or password; read-back shows dots', () => {
    const s = mk();
    const m = s.save({ url: 'rtsp://viewer:lihat123@10.168.1.20:554/main' });
    expect(m).toMatchObject({ configured: true, url: `rtsp://viewer:${CAMERA_PASSWORD_MASK}@10.168.1.20:554/main`, username: 'viewer', hasPassword: true });
    expect(JSON.stringify(m)).not.toContain('lihat123');
    const disk = allFiles();
    expect(disk).not.toContain('lihat123');
    expect(disk).not.toContain('10.168.1.20');
    expect(s.get()).toEqual({ url: 'rtsp://viewer:lihat123@10.168.1.20:554/main' });
    expect(mk().get()?.url).toContain('lihat123');
  });

  it('saving the address with the dots keeps the stored password; a different login with the dots is refused', () => {
    const s = mk();
    s.save({ url: 'rtsp://viewer:lihat123@10.168.1.20:554/main' });
    s.save({ url: `rtsp://viewer:${CAMERA_PASSWORD_MASK}@10.168.1.20:554/main` });
    expect(s.get()?.url).toBe('rtsp://viewer:lihat123@10.168.1.20:554/main');
    expect(() => s.save({ url: `rtsp://admin:${CAMERA_PASSWORD_MASK}@10.168.1.20:554/main` })).toThrow(CameraError);
    expect(() => mk().save({ url: `rtsp://x:${CAMERA_PASSWORD_MASK}@10.168.1.20:554/o` })).toThrow(CameraError);
  });

  it('the dots keep the stored password only for the same host, port and path; otherwise the password is asked again', () => {
    const s = mk();
    s.save({ url: 'rtsp://viewer:lihat123@10.168.1.20:554/main' });
    for (const rest of ['10.168.1.21:554/main', '10.168.1.20:8554/main', '10.168.1.20:554/other']) {
      let err: unknown;
      try {
        s.save({ url: `rtsp://viewer:${CAMERA_PASSWORD_MASK}@${rest}` });
      } catch (e) {
        err = e;
      }
      expect(err, rest).toBeInstanceOf(CameraError);
      expect((err as CameraError).code).toBe('password_again');
      expect((err as CameraError).message).toBe('Masukkan kata laluan semula.');
    }
    expect(s.get()?.url).toBe('rtsp://viewer:lihat123@10.168.1.20:554/main'); // nothing was changed
  });

  it('the separate login boxes: the mask keeps the stored password only for the same host, port and path', () => {
    const s = mk();
    s.save({ url: 'rtsp://10.168.1.20:554/main', username: 'viewer', password: 'lihat123' });
    for (const rest of ['10.168.1.21:554/main', '10.168.1.20:8554/main', '10.168.1.20:554/other']) {
      let err: unknown;
      try {
        s.save({ url: `rtsp://${rest}`, username: 'viewer', password: CAMERA_PASSWORD_MASK });
      } catch (e) {
        err = e;
      }
      expect(err, rest).toBeInstanceOf(CameraError);
      expect((err as CameraError).code).toBe('password_again');
    }
    expect(s.get()).toEqual({ url: 'rtsp://10.168.1.20:554/main', username: 'viewer', password: 'lihat123' });
    s.save({ url: 'rtsp://10.168.1.20:554/main', username: 'viewer2', password: CAMERA_PASSWORD_MASK });
    expect(s.get()?.password).toBe('lihat123');
    s.save({ url: 'rtsp://10.168.1.21:554/main', username: 'viewer', password: 'baharu1' });
    expect(s.get()?.password).toBe('baharu1');
  });

  it('a test result that belongs to an older address is not attached to the newly saved one', () => {
    const s = mk();
    s.save({ url: 'rtsp://10.168.1.20:554/main' });
    const tested = cameraPullUrl(s.get() as CameraRecord);
    s.save({ url: 'rtsp://10.168.1.21:554/main' });
    s.setLastTest({ code: 'ok', ok: true, at: '2026-11-17T08:00:00.000Z', hasAudio: true, codecs: ['H264'], transport: 'tcp' }, tested);
    expect(s.lastTest).toBeNull();
    s.setLastTest({ code: 'ok', ok: true, at: '2026-11-17T08:00:00.000Z', hasAudio: true, codecs: ['H264'], transport: 'tcp' }, cameraPullUrl(s.get() as CameraRecord));
    expect(s.lastTest?.code).toBe('ok');
  });

  it('refuses an address the rules refuse, without echoing it', () => {
    const s = mk();
    for (const url of ['http://10.168.1.20/x', 'rtsp://8.8.8.8/x', 'rtsp://127.0.0.1/x', 'rtsp://10.168.1.2/x', 'rtsp://camera.local/x', '', 'rtsp://10.168.1.20/a b']) {
      let err: unknown;
      try {
        s.save({ url });
      } catch (e) {
        err = e;
      }
      expect(err, url).toBeInstanceOf(CameraError);
      expect((err as CameraError).status).toBe(400);
      if (url !== '') expect((err as CameraError).message).not.toContain(url);
    }
    expect(s.get()).toBeNull();
  });

  it('separate login boxes are kept only when the address has no login; password omitted keeps, empty removes', () => {
    const s = mk();
    expect(s.save({ url: 'rtsp://10.168.1.20:554/main', username: 'viewer', password: 'lihat123' })).toMatchObject({ username: 'viewer', hasPassword: true, url: 'rtsp://10.168.1.20:554/main' });
    expect(s.get()).toEqual({ url: 'rtsp://10.168.1.20:554/main', username: 'viewer', password: 'lihat123' });
    s.save({ url: 'rtsp://10.168.1.20:554/main', username: 'viewer' });
    expect(s.get()?.password).toBe('lihat123');
    s.save({ url: 'rtsp://10.168.1.20:554/main', username: 'viewer', password: CAMERA_PASSWORD_MASK });
    expect(s.get()?.password).toBe('lihat123');
    s.save({ url: 'rtsp://10.168.1.20:554/main', username: 'viewer', password: '' });
    expect(s.get()?.password).toBeUndefined();
    s.save({ url: 'rtsp://a:b@10.168.1.20:554/main', username: 'viewer', password: 'ignored' });
    expect(s.get()).toEqual({ url: 'rtsp://a:b@10.168.1.20:554/main' });
    expect(() => s.save({ url: 'rtsp://10.168.1.20:554/main', username: 'x\u0000y' })).toThrow(CameraError);
  });

  it('keeps the last test with the record; a changed address forgets it, an unchanged one keeps it', () => {
    const s = mk();
    s.save({ url: 'rtsp://10.168.1.20:554/main' });
    const t = { code: 'ok' as const, ok: true, at: '2026-11-17T08:00:00.000Z', hasAudio: true, codecs: ['H264', 'G711'], transport: 'tcp' as const };
    s.setLastTest(t);
    expect(mk().lastTest).toEqual(t);
    expect(s.getMasked().lastTest).toEqual(t);
    s.save({ url: 'rtsp://10.168.1.20:554/main' });
    expect(s.lastTest).toEqual(t);
    s.save({ url: 'rtsp://10.168.1.21:554/main' });
    expect(s.lastTest).toBeNull();
  });

  it('clear removes the record and its file', () => {
    const s = mk();
    s.save({ url: 'rtsp://viewer:lihat123@10.168.1.20:554/main' });
    s.clear();
    expect(s.get()).toBeNull();
    expect(allFiles()).not.toContain('lihat123');
  });

  it('a damaged file reads as no camera and logs no address', () => {
    const s = mk();
    s.save({ url: 'rtsp://viewer:lihat123@10.168.1.20:554/main' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // overwrite the sealed file with junk
      const f = join(dir, 'secret', 'live-camera.json');
      writeFileSync(f, 'junk');
      expect(mk().get()).toBeNull();
      expect(warn.mock.calls.flat().join(' ')).not.toMatch(/lihat123|192\.168/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('[L8] a refused camera address says why', () => {
  const REASONS: Array<[string, string]> = [
    ['not_rtsp', 'http://10.168.1.20/main'],
    ['not_ipv4', 'rtsp://camera.local/main'],
    ['not_private', 'rtsp://8.8.8.8:554/main'],
    ['is_box', 'rtsp://10.168.1.2:554/main'],
    ['bad_port', 'rtsp://10.168.1.20:99999/main'],
    ['bad_login_chars', 'rtsp://us[er:pw@10.168.1.20:554/main'],
    ['bad_path', 'rtsp://10.168.1.20:554/a|b'],
    ['too_long', `rtsp://10.168.1.20:554/${'a'.repeat(450)}`],
  ];
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'surau-cam-l8-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each(REASONS)('[L8] %s', (reason, url) => {
    const s = new CameraStore(dir, { boxIps: ['10.168.1.2'], now: () => new Date('2026-11-17T08:00:00Z') });
    let caught: unknown = null;
    try {
      s.save({ url });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CameraError);
    expect(caught).toMatchObject({ status: 400, code: 'bad_address', detail: { reason } });
    // the address itself is never echoed
    expect(JSON.stringify((caught as CameraError).detail)).not.toContain('192.168');
  });

  it('[L8] the test of a refused address names the same reason', async () => {
    const tester = new CameraTester({ api: () => null, log: { lines: () => [], size: () => 0 } as unknown as MediamtxLogTail, now: () => new Date('2026-11-17T08:00:00Z') } as never);
    for (const [reason, url] of REASONS) {
      const out = await tester.testCamera({ url }, 'tcp', ['10.168.1.2']);
      expect(out.code).toBe('bad_address');
      expect(out.reason, reason).toBe(reason);
    }
  });
});
