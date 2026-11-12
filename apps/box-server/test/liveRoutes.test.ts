import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { KioskLive } from '@surau/core';
import { putFeature } from '../src/settingsStore.ts';
import { loginAs } from './authHelpers.ts';
import { startBody, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

const harnesses: LiveHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});
async function make(o: Parameters<typeof startLiveHarness>[0] = {}): Promise<LiveHarness> {
  const h = await startLiveHarness(o);
  harnesses.push(h);
  return h;
}
const LAN = '10.168.1.40';

const kioskLive = async (h: LiveHarness): Promise<KioskLive> =>
  (await h.app.inject({ method: 'GET', url: '/api/kiosk/live', remoteAddress: '127.0.0.1' })).json() as KioskLive;

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('GET /api/kiosk/live', () => {
  it('is false before start, true once the fake reports ready, false again after stop', async () => {
    const h = await make();
    expect(await kioskLive(h)).toEqual({ live: false, since: null, kuliah: null, audio: false, volume: 50, path: 'surau' });
    const media = await loginAs(h.app, 'media');
    await h.app.inject({ method: 'POST', url: '/api/live/start', headers: media.headers, payload: startBody(h), remoteAddress: LAN });
    expect((await kioskLive(h)).live).toBe(false);
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1', bytesReceived: 5 });
    await until(() => h.app.liveSessions!.kioskLive().live);
    const on = await kioskLive(h);
    expect(on).toMatchObject({ live: true, kuliah: { label: 'Kuliah Maghrib', penceramah: 'Ustaz Ahmad Fauzi', topic: 'Bab Solat' }, audio: false, volume: 50 });
    expect(typeof on.since).toBe('string');
    await h.app.inject({ method: 'POST', url: '/api/live/stop', headers: media.headers, payload: {}, remoteAddress: LAN });
    expect((await kioskLive(h)).live).toBe(false);
  });

  it('is false when liveOnKiosk is switched off mid-session, and follows the audio setting', async () => {
    const h = await make();
    const media = await loginAs(h.app, 'media');
    await h.app.inject({ method: 'POST', url: '/api/live/start', headers: media.headers, payload: startBody(h), remoteAddress: LAN });
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
    await until(() => h.app.liveSessions!.kioskLive().live);
    const admin = await loginAs(h.app, 'admin');
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/settings/liveOnKiosk',
      headers: admin.headers,
      payload: { enabled: true, audio: true, volume: 80 },
      remoteAddress: LAN,
    });
    expect(put.statusCode).toBe(200);
    expect(await kioskLive(h)).toMatchObject({ live: true, audio: true, volume: 80 });
    putFeature(h.app.surau.db, 'liveOnKiosk', { enabled: false }, 'test');
    expect((await kioskLive(h)).live).toBe(false);
  });

  it('is refused for an anonymous LAN caller and allowed for a signed-in user', async () => {
    const h = await make();
    expect((await h.app.inject({ method: 'GET', url: '/api/kiosk/live', remoteAddress: LAN })).statusCode).toBe(401);
    const ajk = await loginAs(h.app, 'ajk');
    expect((await h.app.inject({ method: 'GET', url: '/api/kiosk/live', headers: ajk.headers, remoteAddress: LAN })).statusCode).toBe(200);
  });
});

describe('role checks on /api/live/*', () => {
  it('AJK and treasurer are 403 on start, stop, status and whip', async () => {
    const h = await make();
    for (const role of ['ajk', 'treasurer'] as const) {
      const who = await loginAs(h.app, role);
      for (const [method, url] of [
        ['POST', '/api/live/start'],
        ['POST', '/api/live/stop'],
        ['GET', '/api/live/status'],
        ['POST', '/api/live/whip'],
        ['DELETE', '/api/live/whip/x'],
      ] as const) {
        const r = await h.app.inject({ method, url, headers: who.headers, payload: method === 'POST' ? {} : undefined, remoteAddress: LAN });
        expect(r.statusCode, `${role} ${method} ${url}`).toBe(403);
      }
    }
  });

  it('status as media: idle state is well formed', async () => {
    const h = await make();
    const media = await loginAs(h.app, 'media');
    const r = await h.app.inject({ method: 'GET', url: '/api/live/status', headers: media.headers, remoteAddress: LAN });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      session: null,
      mediamtx: { running: true, tools: { mediamtx: true, ffmpeg: true } },
      ingest: { ready: false, protocol: null },
      relay: { state: 'off' },
      youtube: { signedIn: false, state: 'none' },
    });
  });

  it('status while live reports ingest protocol and readiness', async () => {
    const h = await make();
    const media = await loginAs(h.app, 'media');
    await h.app.inject({ method: 'POST', url: '/api/live/start', headers: media.headers, payload: startBody(h), remoteAddress: LAN });
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1', bytesReceived: 1000 });
    await until(() => h.app.liveSessions!.kioskLive().live);
    const r = (await h.app.inject({ method: 'GET', url: '/api/live/status', headers: media.headers, remoteAddress: LAN })).json();
    expect(r.session).toMatchObject({ source: 'android' });
    expect(r.ingest).toMatchObject({ ready: true, protocol: 'srt' });
  });
});

describe('admin health', () => {
  it('has a live block for admins only', async () => {
    const h = await make();
    const admin = await loginAs(h.app, 'admin');
    const r = await h.app.inject({ method: 'GET', url: '/api/health', headers: admin.headers, remoteAddress: LAN });
    expect(r.json().live).toEqual({ tools: { mediamtx: true, ffmpeg: true }, mediamtx: { running: true, restarts: 0 }, firewall: 'unknown', session: null });
    const anon = await h.app.inject({ method: 'GET', url: '/api/health', remoteAddress: LAN });
    expect(anon.json().live).toBeUndefined();
    const bare = await make({ app: { liveTools: null } });
    const a2 = await loginAs(bare.app, 'admin');
    const r2 = await bare.app.inject({ method: 'GET', url: '/api/health', headers: a2.headers, remoteAddress: LAN });
    expect(r2.json().live).toEqual({ tools: { mediamtx: false, ffmpeg: false }, mediamtx: { running: false, restarts: 0 }, firewall: 'unknown', session: null });
  });
});

/** Opens /api/kiosk/events over real loopback HTTP (the box's own kiosk) and collects frames. */
function openStream(port: number): { frames: string[]; close: () => void } {
  const frames: string[] = [];
  const req = http.get({ host: '127.0.0.1', port, path: '/api/kiosk/events' }, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        frames.push(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    });
  });
  req.on('error', () => undefined);
  return { frames, close: () => req.destroy() };
}

const liveFrames = (frames: string[]): KioskLive[] =>
  frames.filter((f) => f.startsWith('event: live')).map((f) => JSON.parse(f.split('\n')[1]!.replace('data: ', '')) as KioskLive);

describe('kiosk event stream', () => {
  it('sends the current live state once on connect, after the changed event', async () => {
    const h = await make();
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const s = openStream((h.app.server.address() as AddressInfo).port);
    try {
      await until(() => s.frames.length >= 2);
      expect(s.frames[0]).toMatch(/^event: changed/);
      expect(s.frames[1]).toMatch(/^event: live/);
      expect(liveFrames(s.frames)[0]).toMatchObject({ live: false });
    } finally {
      s.close();
    }
  });

  it('delivers event: live within 100 ms of the ingest turning ready, and again on stop', async () => {
    const h = await make();
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const s = openStream((h.app.server.address() as AddressInfo).port);
    try {
      await until(() => s.frames.length >= 2);
      const media = await loginAs(h.app, 'media');
      await h.app.inject({ method: 'POST', url: '/api/live/start', headers: media.headers, payload: startBody(h), remoteAddress: LAN });
      const before = liveFrames(s.frames).length;
      const t0 = Date.now();
      h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1', bytesReceived: 9 });
      await until(() => liveFrames(s.frames).some((f) => f.live), 1000);
      expect(Date.now() - t0).toBeLessThan(100 + 60);
      expect(liveFrames(s.frames).length).toBeGreaterThan(before);
      await h.app.inject({ method: 'POST', url: '/api/live/stop', headers: media.headers, payload: {}, remoteAddress: LAN });
      await until(() => liveFrames(s.frames).at(-1)?.live === false, 1000);
    } finally {
      s.close();
    }
  });
});
