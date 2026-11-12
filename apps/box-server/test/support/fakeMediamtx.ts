import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** A tiny stand-in for the MediaMTX control API and WHIP/WHEP endpoints (loopback, tests only). */
export interface FakePathState {
  ready: boolean;
  bytesReceived: number;
  readers: number;
  sourceType: string | null;
  sourceId: string | null;
  tracks: string[];
}

export interface FakeRequestLog {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  cookie: string | undefined;
  body: string;
}

export interface FakeMediamtx {
  port: number;
  user: string;
  pass: string;
  /** Every request seen, in order. */
  requests: FakeRequestLog[];
  /** The fake's global config (authInternalUsers is the only part it models). */
  global: { authInternalUsers: Array<Record<string, unknown>> };
  paths: Map<string, Record<string, unknown>>;
  path: FakePathState;
  kicked: string[];
  /** Milliseconds every control API answer is held back (a slow MediaMTX config reload); 0 = none. */
  apiDelayMs: number;
  /** Makes the WHIP/WHEP endpoints answer this status (null: normal behaviour). */
  webOverride: { status: number } | null;
  /** Session id the next WHIP/WHEP answer carries in its Location header. */
  webSessionId: string;
  /** Drops every WHIP/WHEP connection without answering. */
  setWebDown: (down: boolean) => void;
  setReady: (ready: boolean, patch?: Partial<FakePathState>) => void;
  close: () => Promise<void>;
}

const SDP_ANSWER = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';

export async function startFakeMediamtx(opts: { user?: string; pass?: string } = {}): Promise<FakeMediamtx> {
  const user = opts.user ?? 'box';
  const pass = opts.pass ?? 'fake-pass-0123456789abcdef012345';
  let webDown = false;
  const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const state: FakeMediamtx = {
    port: 0,
    user,
    pass,
    requests: [],
    global: { authInternalUsers: [{ user: 'box', pass: 'sha256:x', permissions: [{ action: 'api' }] }] },
    paths: new Map(),
    path: { ready: false, bytesReceived: 0, readers: 0, sourceType: null, sourceId: null, tracks: [] },
    kicked: [],
    apiDelayMs: 0,
    webOverride: null,
    webSessionId: 'fake-session-1',
    setWebDown(down) {
      webDown = down;
    },
    setReady(ready, patch = {}) {
      Object.assign(state.path, patch, { ready });
      if (!ready) Object.assign(state.path, { sourceType: null, sourceId: null, tracks: [] });
    },
    close: () => closeServer(),
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '';
      state.requests.push({
        method: req.method ?? '',
        url,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        cookie: req.headers.cookie,
        body,
      });
      const json = (status: number, value: unknown): void => {
        const send = (): void => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(value));
        };
        if (state.apiDelayMs > 0 && url.startsWith('/v3/')) setTimeout(send, state.apiDelayMs);
        else send();
      };
      const isApi = url.startsWith('/v3/');
      if (isApi && req.headers.authorization !== expected) return json(401, { error: 'authentication failed' });
      const method = req.method ?? '';
      if (method === 'GET' && url === '/v3/config/global/get') {
        // like MediaMTX v1.21: a user stored without `ips`/`permissions` reads back with them as null
        const g = state.global as { authInternalUsers?: unknown };
        const users = Array.isArray(g.authInternalUsers)
          ? (g.authInternalUsers as Array<Record<string, unknown>>).map((u) => ({ ...u, ips: u.ips ?? null, permissions: u.permissions ?? null }))
          : g.authInternalUsers;
        return json(200, { ...state.global, ...(users === undefined ? {} : { authInternalUsers: users }) });
      }
      if (method === 'PATCH' && url === '/v3/config/global/patch') {
        const patch = JSON.parse(body) as { authInternalUsers?: unknown };
        // like MediaMTX v1.21: a null slice in the patch is refused ("cannot set slice ... to nil")
        if (Array.isArray(patch.authInternalUsers)) {
          const i = (patch.authInternalUsers as Array<Record<string, unknown>>).findIndex((u) => !Array.isArray(u.ips) || !Array.isArray(u.permissions));
          if (i >= 0) return json(400, { error: `cannot set slice "authInternalUsers[${i}].ips" to nil` });
        }
        Object.assign(state.global, patch);
        return json(200, {});
      }
      const pathPatch = /^\/v3\/config\/paths\/patch\/([^/]+)$/.exec(url);
      if (method === 'PATCH' && pathPatch) {
        const name = decodeURIComponent(pathPatch[1] as string);
        state.paths.set(name, { ...(state.paths.get(name) ?? {}), ...(JSON.parse(body) as object) });
        return json(200, {});
      }
      const pathGet = /^\/v3\/paths\/get\/([^/]+)$/.exec(url);
      if (method === 'GET' && pathGet) {
        if (decodeURIComponent(pathGet[1] as string) !== 'surau') return json(404, { error: 'path not found' });
        const p = state.path;
        return json(200, {
          name: 'surau',
          ready: p.ready,
          source: p.sourceType ? { type: p.sourceType, id: p.sourceId ?? '' } : null,
          tracks: p.tracks,
          bytesReceived: p.bytesReceived,
          readers: Array.from({ length: p.readers }, (_, i) => ({ type: 'webrtcSession', id: `r${i}` })),
        });
      }
      const kick = /^\/v3\/(webrtcsessions|srtconns)\/kick\/([^/]+)$/.exec(url);
      if (method === 'POST' && kick) {
        state.kicked.push(`${kick[1]}/${kick[2]}`);
        return json(200, {});
      }
      if (method === 'GET' && url === '/v3/paths/list') return json(200, { itemCount: 0, items: [] });
      const web = /^\/(?:surau|surau-kiosk)\/(whip|whep)$/.exec(url);
      if ((method === 'POST' && web) || (method === 'DELETE' && /^\/(?:surau|surau-kiosk)\/(whip|whep)\/[^/]+$/.test(url))) {
        if (webDown) return req.socket.destroy();
        if (state.webOverride) {
          res.writeHead(state.webOverride.status);
          return res.end();
        }
      }
      if (method === 'POST' && web) {
        if (req.headers.authorization === undefined) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="mediamtx"' });
          return res.end();
        }
        res.writeHead(201, { 'Content-Type': 'application/sdp', Location: `/${url.split('/')[1]}/${web[1]}/${state.webSessionId}` });
        return res.end(SDP_ANSWER);
      }
      if (method === 'DELETE' && /^\/(?:surau|surau-kiosk)\/(whip|whep)\/[^/]+$/.test(url)) {
        res.writeHead(200);
        return res.end();
      }
      json(404, { error: 'not found' });
    });
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  state.port = (server.address() as AddressInfo).port;

  function closeServer(): Promise<void> {
    return new Promise((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  }
  return state;
}
