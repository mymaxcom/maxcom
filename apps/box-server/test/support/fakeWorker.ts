import { createHmac, timingSafeEqual } from 'node:crypto';

export type VmState = 'up' | 'down' | 'waking';

/**
 * A small fake of the Cloudflare Worker's side of the contract: signed `/wake`, `/dirty`, `/dirty/clear`
 * (HMAC, own prefixes, 120 s window), the `/_admin` routes (Bearer token: dirty, dev, site), and a proxy that
 * answers 503 `waking` while the VM is not up.
 */
export class FakeWorker {
  vm: VmState = 'up';
  wakes = 0;
  dirtyChecks = 0;
  clears: number[] = [];
  readonly dirty = new Map<string, number>();
  readonly secrets = new Map<string, string>();
  /** Admin side: the token it accepts, the device allowlist, and every admin call received. */
  readonly adminToken = 'test-admin-token';
  readonly devices = new Map<string, { jwk: Record<string, unknown>; revoked: boolean }>();
  readonly adminCalls: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  /** Self-registrations of unlinked boxes (`POST /register`), and every body received there. */
  readonly regs = new Map<string, { claimHash: string; name: string; at: string }>();
  readonly registerCalls: unknown[] = [];
  /** Every body sent to the cloud's `/api/sync/claim` through this Worker. */
  readonly claimCalls: { boxId?: unknown; claim?: unknown; publicJwk?: unknown }[] = [];
  /** When set, `/register` answers this status (after recording the call) instead of being served. */
  registerStatus: number | null = null;
  /** When set, `/api/sync/claim` answers this status (after recording the call) instead of reaching the cloud. */
  claimStatus: number | null = null;
  /** When set, admin calls answer this status instead of being served. */
  adminStatus: number | null = null;
  /** When true, admin calls fail like a network error. */
  adminDown = false;
  /** Everything not handled here goes to the cloud app. */
  constructor(private readonly upstream: typeof fetch, private readonly now: () => number = Date.now) {}

  setSecret(boxId: string, secret: string): void {
    this.secrets.set(boxId, secret);
  }

  private sigOk(boxId: string, msg: (ts: number) => string, headers: Headers): boolean {
    const secret = this.secrets.get(boxId);
    const ts = Number(headers.get('x-maxcom-ts'));
    const sig = headers.get('x-maxcom-sig') ?? '';
    if (secret === undefined || !Number.isFinite(ts) || Math.abs(this.now() - ts) > 120_000) return false;
    const want = createHmac('sha256', secret).update(msg(ts)).digest();
    const got = Buffer.from(sig, 'base64url');
    return got.length === want.length && timingSafeEqual(got, want);
  }

  private admin(path: string, method: string, headers: Headers, rawBody: unknown): Response {
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (this.adminDown) throw new TypeError('fetch failed');
    let body: unknown = null;
    try {
      body = typeof rawBody === 'string' && rawBody !== '' ? JSON.parse(rawBody) : null;
    } catch {
      body = null;
    }
    this.adminCalls.push({ method, path, body, auth: headers.get('authorization') });
    if (headers.get('authorization') !== `Bearer ${this.adminToken}`) return json(401, { error: 'unauthorised' });
    if (this.adminStatus !== null) return json(this.adminStatus, { error: 'injected' });
    const parts = path.split('/');
    const kind = parts[2];
    const id = decodeURIComponent(parts[3] ?? '');
    const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (kind === 'dirty' && method === 'PUT') {
      const seq = plain(body) ? body.seq : undefined;
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= 0) return json(400, { error: 'bad seq' });
      this.dirty.set(id, Math.max(this.dirty.get(id) ?? 0, seq));
      return json(200, { seq: this.dirty.get(id) });
    }
    if (kind === 'dev' && method === 'PUT') {
      const jwk = plain(body) ? body.jwk : undefined;
      const revoked = plain(body) ? body.revoked : undefined;
      if (!plain(jwk) || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || 'd' in jwk || typeof revoked !== 'boolean') return json(400, { error: 'bad jwk' });
      this.devices.set(id, { jwk, revoked });
      return json(200, {});
    }
    if (kind === 'dev' && method === 'DELETE') {
      this.devices.delete(id);
      return json(200, {});
    }
    if (kind === 'site' && method === 'PUT') {
      const secret = plain(body) ? body.wakeSecret : undefined;
      if (typeof secret !== 'string' || secret === '') return json(400, { error: 'bad secret' });
      this.secrets.set(id, secret);
      return json(200, {});
    }
    if (kind === 'site' && method === 'DELETE') {
      this.secrets.delete(id);
      return json(200, {});
    }
    if (kind === 'reg' && parts.length === 3 && method === 'GET') {
      return json(200, { regs: [...this.regs].map(([boxId, r]) => ({ boxId, ...r })) });
    }
    if (kind === 'reg' && method === 'GET') {
      const r = this.regs.get(id);
      return r === undefined ? json(404, { error: 'not_found' }) : json(200, { boxId: id, ...r });
    }
    if (kind === 'reg' && method === 'DELETE') {
      this.regs.delete(id);
      return new Response(null, { status: 204 });
    }
    return json(404, { error: 'not found' });
  }

  fetch: typeof fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const method = (init?.method ?? 'GET').toUpperCase();
    const boxId = headers.get('x-maxcom-site') ?? u.searchParams.get('site') ?? '';
    const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });

    if (u.pathname.startsWith('/_admin/')) return this.admin(u.pathname, method, headers, init?.body);
    if (u.pathname === '/register' && method === 'POST') {
      // served from the Worker's own store whatever the VM does; first claimHash wins
      const b = JSON.parse(String(init?.body ?? '{}')) as { boxId?: unknown; name?: unknown; claimHash?: unknown };
      this.registerCalls.push(b);
      if (this.registerStatus !== null) return json(this.registerStatus, { error: 'injected' });
      if (typeof b.boxId !== 'string' || !/^[0-9a-f]{16}$/.test(b.boxId) || typeof b.claimHash !== 'string' || !/^[0-9a-f]{64}$/.test(b.claimHash)) return json(400, { error: 'invalid' });
      const have = this.regs.get(b.boxId);
      if (have !== undefined) return have.claimHash === b.claimHash ? json(200, { status: 'pending' }) : json(409, { error: 'conflict' });
      this.regs.set(b.boxId, { claimHash: b.claimHash, name: typeof b.name === 'string' ? b.name : '', at: new Date(this.now()).toISOString() });
      return json(200, { status: 'pending' });
    }
    if (u.pathname === '/wake' && method === 'POST') {
      if (!this.sigOk(boxId, (ts) => `maxcom-wake-box\n${boxId}\n${ts}`, headers)) return json(401, { error: 'unsigned' });
      this.wakes += 1;
      if (this.vm === 'up') return new Response(null, { status: 204 });
      this.vm = 'waking';
      return json(202, { state: 'waking' }, { 'retry-after': '60' });
    }
    if (u.pathname === '/dirty' && method === 'GET') {
      if (!this.sigOk(boxId, (ts) => `maxcom-dirty-get\n${boxId}\n${ts}`, headers)) return json(401, { error: 'unsigned' });
      this.dirtyChecks += 1;
      return json(200, { seq: this.dirty.get(boxId) ?? 0 });
    }
    if (u.pathname === '/dirty/clear' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { upTo?: number };
      const upTo = Number(body.upTo);
      if (!this.sigOk(boxId, (ts) => `maxcom-dirty-clear\n${boxId}\n${upTo}\n${ts}`, headers)) return json(401, { error: 'unsigned' });
      this.clears.push(upTo);
      const stored = this.dirty.get(boxId) ?? 0;
      if (stored <= upTo) {
        this.dirty.delete(boxId);
        return json(200, { seq: 0 });
      }
      return json(200, { seq: stored });
    }
    if (u.pathname === '/api/sync/claim' && method === 'POST') {
      try {
        this.claimCalls.push(JSON.parse(String(init?.body ?? '{}')) as { boxId?: unknown; claim?: unknown; publicJwk?: unknown });
      } catch {
        this.claimCalls.push({});
      }
      if (this.claimStatus !== null) return json(this.claimStatus, { error: 'injected' });
    }
    if (this.vm !== 'up') return json(503, { state: 'waking' }, { 'retry-after': '60' });
    return this.upstream(input, init);
  }) as typeof fetch;
}
