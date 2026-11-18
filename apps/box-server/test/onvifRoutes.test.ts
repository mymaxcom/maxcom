import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { createLimiters } from '../src/auth/authz.ts';
import { CameraStore } from '../src/live/camera.ts';
import { registerCameraRoutes } from '../src/live/cameraRoutes.ts';
import { OnvifClient } from '../src/live/onvif.ts';
import type { OnvifTransport } from '../src/live/onvif.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { loginAs } from './authHelpers.ts';
import { changeLogText, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

const LAN = '10.168.1.40';
const URI = 'rtsp://10.168.1.20:554/main';
const PASS = 'rahsia-kamera-9';

const harnesses: LiveHarness[] = [];
const minis: FastifyInstance[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const m of minis.splice(0)) await m.close();
});

/** A scripted camera: one device on 10.168.1.20 that answers every SOAP call with the stream address. */
function transport(): OnvifTransport {
  const env = (inner: string): string => `<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"><e:Body>${inner}</e:Body></e:Envelope>`;
  return {
    probe: async (message) => {
      const id = /<w:MessageID>([^<]+)</.exec(message)?.[1] ?? '';
      return [
        {
          from: '10.168.1.20',
          text: env('').replace('<e:Body></e:Body>', `<e:Header><a:RelatesTo xmlns:a="x">${id}</a:RelatesTo></e:Header><e:Body><d:ProbeMatch xmlns:d="y"><d:Types>dn:NetworkVideoTransmitter</d:Types><d:Scopes>onvif://www.onvif.org/name/Kamera%20Dewan</d:Scopes><d:XAddrs>http://10.168.1.20/onvif/device_service</d:XAddrs></d:ProbeMatch></e:Body>`),
        },
      ];
    },
    post: async (_ip, _port, _path, body) => {
      if (body.includes('<GetProfiles')) return { status: 200, text: env('<P><Profiles token="t1"><VideoEncoderConfiguration><Encoding>H264</Encoding><Width>1920</Width><Height>1080</Height></VideoEncoderConfiguration></Profiles></P>') };
      if (body.includes('<GetStreamUri')) return { status: 200, text: env(`<R><Uri>${URI}</Uri></R>`) };
      return { status: 200, text: env('<C/>') };
    },
  };
}

async function make(roles: string[] = ['live']) {
  const h = await startLiveHarness();
  harnesses.push(h);
  const app = Fastify();
  minis.push(app);
  app.addHook('onRequest', async (request) => {
    (request as { auth: unknown }).auth = { kind: 'user', userId: 'u1', deviceId: 'd1', roles, sessionId: 's1', ops: false };
    (request as { tenant: unknown }).tenant = { surauId: LOCAL_SURAU_ID };
  });
  registerCameraRoutes(app, {
    db: h.app.surau.db,
    store: new CameraStore(h.dataDir, { boxIps: [LAN] }),
    tester: null,
    sessions: { current: () => null },
    limiters: createLimiters(),
    boxIps: [LAN],
    onvif: new OnvifClient({ transport: transport(), boxIps: [LAN] }),
  });
  await app.ready();
  return { h, app };
}

describe('POST /api/live/camera/discover and /discover/fill', () => {
  it('lists name + IP only', async () => {
    const { app } = await make();
    const r = await app.inject({ method: 'POST', url: '/api/live/camera/discover', payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ cameras: [{ name: 'Kamera Dewan', ip: '10.168.1.20' }] });
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('fill answers the address with the login merged and a masked copy; the audit and the answer elsewhere never hold the password', async () => {
    const { h, app } = await make();
    const r = await app.inject({ method: 'POST', url: '/api/live/camera/discover/fill', payload: { ip: '10.168.1.20', username: 'viewer', password: PASS } });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { url: string; masked: string };
    expect(body.url).toBe(`rtsp://viewer:${PASS}@10.168.1.20:554/main`);
    expect(body.masked).not.toContain(PASS);
    expect(changeLogText(h.app)).toContain('discover-fill');
    expect(changeLogText(h.app)).not.toContain(PASS);
  });

  it('refuses a bad or non-private address and a bad body with fixed words, never 401', async () => {
    const { app } = await make();
    for (const payload of [{ ip: '8.8.8.8' }, { ip: 5 }, { ip: LAN }, [] ]) {
      const r = await app.inject({ method: 'POST', url: '/api/live/camera/discover/fill', payload: payload as never });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ code: 'bad_address' });
    }
  });

  it('is rate limited', async () => {
    const { app } = await make();
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await app.inject({ method: 'POST', url: '/api/live/camera/discover', payload: {} })).statusCode;
    expect(last).toBe(429);
  });
});

describe('who may use discovery', () => {
  it('live and admin may; Media may not', async () => {
    const h = await startLiveHarness();
    harnesses.push(h);
    for (const [role, ok] of [['live', true], ['admin', true], ['media', false]] as const) {
      const who = await loginAs(h.app, role);
      for (const url of ['/api/live/camera/discover', '/api/live/camera/discover/fill']) {
        const r = await h.app.inject({ method: 'POST', url, headers: who.headers, remoteAddress: LAN, payload: {} });
        if (ok) expect([401, 403], `${role} ${url}`).not.toContain(r.statusCode);
        else expect(r.statusCode, `${role} ${url}`).toBe(403);
      }
    }
  });
});
