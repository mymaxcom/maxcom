import type { FastifyInstance } from 'fastify';
import type { Login } from '../authHelpers.ts';

/** A browser screen on the LAN: not the box's own loopback kiosk. */
export const TV_IP = '10.168.1.77';

/** Pairs a browser screen through the real routes; returns its cookie header value and its device id. */
export async function pairTv(app: FastifyInstance, admin: Login, deviceName = 'TV foyer'): Promise<{ cookie: string; deviceId: string }> {
  const b = (await app.inject({ method: 'POST', url: '/api/kiosk/pair/begin', remoteAddress: TV_IP })).json() as { code: string; pollToken: string };
  const a = await app.inject({
    method: 'POST', url: '/api/kiosk/pair/approve', remoteAddress: '10.9.9.9', headers: admin.headers, payload: { code: b.code, deviceName },
  });
  if (a.statusCode !== 200) throw new Error(`approve ${a.statusCode}`);
  const p = await app.inject({ method: 'POST', url: '/api/kiosk/pair/poll', remoteAddress: TV_IP, payload: { pollToken: b.pollToken } });
  const raw = p.headers['set-cookie'];
  const line = Array.isArray(raw) ? String(raw[0]) : String(raw);
  return { cookie: line.split(';')[0]!, deviceId: String(a.json().deviceId) };
}
