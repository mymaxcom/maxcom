import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface GoogleCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: Record<string, unknown> | null;
}

export const FAKE_STREAM_KEY = 'xkey-aaaa-bbbb-cccc-dddd';
export const FAKE_REFRESH = 'refresh-token-SECRET-1';
export const FAKE_DEVICE_CODE = 'device-code-SECRET-1';

export interface FakeGoogle {
  port: number;
  calls: GoogleCall[];
  /** `fetch` that sends the two Google hosts to this fake (everything else is refused). */
  fetchImpl: typeof fetch;
  /** The user approved the device code. */
  approve: boolean;
  /** Answer the refresh grant with this error keyword (for example `invalid_grant`). */
  refreshError: string | null;
  /** Answer the complete transition with 403 and this reason. */
  transitionError: string | null;
  /** Answer every liveBroadcasts.insert with this status. */
  insertStatus: number;
  /** Delay (ms) before answering every request, to prove the timeout. */
  delayMs: number;
  /** Respond to the next channels.list with this many padding bytes (to prove the size cap). */
  bigBody: number;
  streams: Map<string, { name: string; reusable: boolean }>;
  /** Broadcast ids that exist (inserted, not deleted). */
  broadcasts: Set<string>;
  /** lifeCycleStatus every broadcast reports (default `live`). */
  lifeCycle: string;
  /** Answer liveBroadcasts/bind with this status (default 200). */
  bindStatus: number;
  count(path: string): number;
  close(): Promise<void>;
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  let accessN = 0;
  let streamN = 0;
  let bcN = 0;
  const fake = {
    calls: [] as GoogleCall[],
    approve: false,
    refreshError: null as string | null,
    transitionError: null as string | null,
    insertStatus: 200,
    delayMs: 0,
    bigBody: 0,
    streams: new Map<string, { name: string; reusable: boolean }>(),
    broadcasts: new Set<string>(),
    lifeCycle: 'live',
    bindStatus: 200,
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const body = Buffer.concat(chunks).toString('utf8');
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(body) as Record<string, unknown>;
      } catch {
        json = null;
      }
      const call: GoogleCall = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body, json };
      fake.calls.push(call);
      const send = (status: number, obj: unknown): void => {
        const text = JSON.stringify(obj);
        const go = (): void => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(text);
        };
        if (fake.delayMs > 0) setTimeout(go, fake.delayMs);
        else go();
      };
      const form = new URLSearchParams(body);
      const p = url.pathname;
      if (p === '/device/code') {
        return send(200, { device_code: FAKE_DEVICE_CODE, user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 });
      }
      if (p === '/token') {
        if (form.get('grant_type') === 'refresh_token') {
          if (fake.refreshError !== null) return send(400, { error: fake.refreshError, error_description: 'Token has been expired or revoked.' });
          accessN++;
          return send(200, { access_token: `access-token-${accessN + 1}`, expires_in: 3600, token_type: 'Bearer' });
        }
        if (!fake.approve) return send(428, { error: 'authorization_pending' });
        return send(200, { access_token: 'access-token-1', refresh_token: FAKE_REFRESH, expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube', token_type: 'Bearer' });
      }
      if (p === '/revoke') return send(200, {});
      if (!(req.headers.authorization ?? '').startsWith('Bearer access-token-')) return send(401, { error: { code: 401, errors: [{ reason: 'authError' }] } });
      if (p === '/youtube/v3/channels') {
        if (fake.bigBody > 0) return send(200, { items: [], pad: 'x'.repeat(fake.bigBody) });
        return send(200, { items: [{ id: 'UC-surau', snippet: { title: 'Surau D\'Waqaf' } }] });
      }
      if (p === '/youtube/v3/liveStreams' && call.method === 'GET') {
        const id = url.searchParams.get('id') ?? '';
        const s = fake.streams.get(id);
        if (!s) return send(200, { items: [] });
        return send(200, {
          items: [{ id, cdn: { ingestionInfo: { streamName: s.name, ingestionAddress: 'rtmps://a.rtmps.youtube.com:443/live2' } }, status: { streamStatus: 'active', healthStatus: { status: 'good' } } }],
        });
      }
      if (p === '/youtube/v3/liveStreams' && call.method === 'POST') {
        streamN++;
        const id = `stream-${streamN}`;
        const name = streamN === 1 ? FAKE_STREAM_KEY : `${FAKE_STREAM_KEY}-${streamN}`;
        const reusable = (json?.contentDetails as { isReusable?: unknown } | undefined)?.isReusable === true;
        fake.streams.set(id, { name, reusable });
        return send(200, { id, cdn: { ingestionInfo: { streamName: name } } });
      }
      if (p === '/youtube/v3/liveStreams' && call.method === 'DELETE') {
        const id = url.searchParams.get('id') ?? '';
        if (!fake.streams.delete(id)) return send(404, { error: { code: 404, errors: [{ reason: 'notFound' }] } });
        return send(200, {});
      }
      if (p === '/youtube/v3/liveBroadcasts' && call.method === 'GET') {
        const id = url.searchParams.get('id') ?? '';
        if (!fake.broadcasts.has(id)) return send(200, { items: [] });
        return send(200, { items: [{ id, status: { lifeCycleStatus: fake.lifeCycle } }] });
      }
      if (p === '/youtube/v3/liveBroadcasts' && call.method === 'DELETE') {
        const id = url.searchParams.get('id') ?? '';
        if (!fake.broadcasts.delete(id)) return send(404, { error: { code: 404, errors: [{ reason: 'notFound' }] } });
        return send(200, {});
      }
      if (p === '/youtube/v3/liveBroadcasts' && call.method === 'POST') {
        if (fake.insertStatus !== 200) return send(fake.insertStatus, { error: { code: fake.insertStatus, errors: [{ reason: fake.insertStatus === 403 ? 'quotaExceeded' : 'backendError' }] } });
        bcN++;
        fake.broadcasts.add(`bc-${bcN}`);
        return send(200, { id: `bc-${bcN}`, ...(json ?? {}) });
      }
      if (p === '/youtube/v3/liveBroadcasts/bind') {
        if (fake.bindStatus !== 200) return send(fake.bindStatus, { error: { code: fake.bindStatus, errors: [{ reason: 'backendError' }] } });
        return send(200, { id: url.searchParams.get('id') });
      }
      if (p === '/youtube/v3/liveBroadcasts/transition') {
        if (fake.transitionError !== null) return send(403, { error: { code: 403, errors: [{ reason: fake.transitionError }] } });
        return send(200, { id: url.searchParams.get('id') });
      }
      return send(404, { error: { code: 404, errors: [{ reason: 'notFound' }] } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !['oauth2.googleapis.com', 'www.googleapis.com'].includes(u.hostname)) throw new Error('fakeGoogle: refused host');
    return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
  }) as typeof fetch;
  return Object.assign(fake, {
    port,
    fetchImpl,
    count: (path: string) => fake.calls.filter((c) => c.path === path).length,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }) as FakeGoogle;
}
