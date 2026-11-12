import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { secretDir } from '../../auth/secrets.ts';
import { TokenStore } from './tokenStore.ts';
import type { YoutubeTokens } from './tokenStore.ts';

/** Short, stable reasons. Raw Google bodies, tokens and codes never become an error message. */
export type YoutubeReason = 'quota' | 'forbidden' | 'network' | 'reauthorise' | 'not_configured' | 'bad_response' | 'not_found';

export class YoutubeError extends Error {
  readonly reason: YoutubeReason;
  readonly status: number;
  /** Google's own error keyword (for example `redundantTransition`): a fixed vocabulary, safe to compare. */
  readonly detail: string;
  constructor(reason: YoutubeReason, status = 0, detail = '') {
    super(reason);
    this.name = 'YoutubeError';
    this.reason = reason;
    this.status = status;
    this.detail = detail;
  }
}

export const GOOGLE_HOSTS: ReadonlySet<string> = new Set(['oauth2.googleapis.com', 'www.googleapis.com']);
const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true';
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';
const VERIFICATION_URL = 'https://www.google.com/device';
const MAX_BODY_BYTES = 256 * 1024;
const REFRESH_MARGIN_MS = 60_000;

export interface HttpOptions {
  timeoutMs: number;
  maxBytes?: number;
}

/**
 * The one door to Google. Only the two API hosts, https only (the guarded fetch also refuses private
 * addresses and redirects), a hard timeout, a response size cap, and errors reduced to short reasons.
 */
export async function googleRequest(
  fetchImpl: typeof fetch,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  opts: HttpOptions,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  let host = '';
  try {
    const u = new URL(url);
    host = u.protocol === 'https:' ? u.hostname : '';
  } catch {
    host = '';
  }
  if (!GOOGLE_HOSTS.has(host)) throw new YoutubeError('forbidden');
  const cap = opts.maxBytes ?? MAX_BODY_BYTES;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctl.signal });
    let text = '';
    if (res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) {
          ctl.abort();
          throw new YoutubeError('bad_response', res.status);
        }
        chunks.push(value);
      }
      text = Buffer.concat(chunks).toString('utf8');
    }
    let json: Record<string, unknown> | null = null;
    if (text !== '') {
      try {
        const v: unknown = JSON.parse(text);
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) json = v as Record<string, unknown>;
      } catch {
        json = null;
      }
    }
    return { status: res.status, json };
  } catch (e) {
    if (e instanceof YoutubeError) throw e;
    throw new YoutubeError('network');
  } finally {
    clearTimeout(timer);
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The Google error keyword of an answer (`error.errors[0].reason`, or OAuth's `error`): a fixed vocabulary. */
export function googleDetail(json: Record<string, unknown> | null): string {
  if (json === null) return '';
  const e = json.error;
  if (typeof e === 'string') return e.slice(0, 60);
  if (typeof e === 'object' && e !== null) {
    const errs = (e as { errors?: unknown }).errors;
    if (Array.isArray(errs) && typeof errs[0] === 'object' && errs[0] !== null) return str((errs[0] as { reason?: unknown }).reason).slice(0, 60);
  }
  return '';
}

/** Maps an HTTP failure to a short reason. */
export function failureOf(status: number, json: Record<string, unknown> | null): YoutubeError {
  const detail = googleDetail(json);
  if (status === 401) return new YoutubeError('reauthorise', status, detail);
  if (status === 403 && /quota|rateLimit|dailyLimit/i.test(detail)) return new YoutubeError('quota', status, detail);
  if (status === 403) return new YoutubeError('forbidden', status, detail);
  if (status === 404) return new YoutubeError('not_found', status, detail);
  if (status === 429) return new YoutubeError('quota', status, detail);
  return new YoutubeError(status >= 500 ? 'network' : 'bad_response', status, detail);
}

export interface SigninBegin {
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
  interval: number;
}

export type PollState = 'none' | 'pending' | 'signed_in' | 'denied' | 'expired' | 'error';
export interface SigninPoll {
  state: PollState;
  signedIn: boolean;
  channelTitle: string | null;
  interval: number | null;
}

interface Pending {
  deviceCode: string;
  expiresAtMs: number;
  interval: number;
  nextPollAtMs: number;
  last: SigninPoll;
}

export interface YoutubeAuthDeps {
  dataDir: string;
  fetchImpl: typeof fetch;
  now: () => Date;
  timeoutMs?: number;
}

/** Device-code sign-in and the access token for the box's YouTube channel. */
export class YoutubeAuth {
  private readonly d: YoutubeAuthDeps;
  private readonly store: TokenStore;
  private readonly clientPath: string;
  private readonly timeoutMs: number;
  private tokens: YoutubeTokens | null;
  private pending: Pending | null = null;
  private pollJob: Promise<SigninPoll> | null = null;
  private refreshJob: Promise<string> | null = null;
  private needsReauth = false;
  private lastErrorReason: YoutubeReason | null = null;

  constructor(deps: YoutubeAuthDeps) {
    this.d = deps;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
    this.store = new TokenStore(deps.dataDir);
    this.clientPath = join(secretDir(deps.dataDir), 'youtube-client.json');
    this.tokens = this.store.load();
  }

  /** The operator's OAuth client; read when needed and never kept in a log or an answer. */
  private client(): { clientId: string; clientSecret: string } | null {
    if (!existsSync(this.clientPath)) return null;
    try {
      const raw: unknown = JSON.parse(readFileSync(this.clientPath, 'utf8'));
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
      // the flat form, or Google's download as it comes: wrapped in "installed" or "web"
      const top = raw as Record<string, unknown>;
      const inner = top.installed ?? top.web;
      const src = typeof top.client_id === 'string' || inner === undefined ? top : inner;
      if (typeof src !== 'object' || src === null || Array.isArray(src)) return null;
      const v = src as { client_id?: unknown; client_secret?: unknown };
      if (typeof v.client_id !== 'string' || v.client_id === '' || typeof v.client_secret !== 'string' || v.client_secret === '') return null;
      return { clientId: v.client_id, clientSecret: v.client_secret };
    } catch {
      return null;
    }
  }

  configured(): boolean {
    return this.client() !== null;
  }

  signedIn(): boolean {
    return this.tokens !== null && !this.needsReauth;
  }

  channelTitle(): string | null {
    return this.tokens !== null && this.tokens.channelTitle !== '' ? this.tokens.channelTitle : null;
  }

  channelId(): string | null {
    return this.tokens !== null && this.tokens.channelId !== '' ? this.tokens.channelId : null;
  }

  lastError(): YoutubeReason | null {
    return this.needsReauth ? 'reauthorise' : this.lastErrorReason;
  }

  streamId(): string | null {
    return this.tokens?.streamId ?? null;
  }

  saveStreamId(id: string): void {
    if (this.tokens === null) return;
    this.tokens = { ...this.tokens, streamId: id };
    this.store.save(this.tokens);
  }

  private post(url: string, fields: Record<string, string>): ReturnType<typeof googleRequest> {
    return googleRequest(
      this.d.fetchImpl,
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() },
      { timeoutMs: this.timeoutMs },
    );
  }

  /* ------------------------------------------------------------ sign-in */

  async begin(): Promise<SigninBegin> {
    const client = this.client();
    if (client === null) throw new YoutubeError('not_configured');
    const r = await this.post(DEVICE_CODE_URL, { client_id: client.clientId, scope: YOUTUBE_SCOPE });
    if (r.status !== 200) throw failureOf(r.status, r.json);
    const j = r.json;
    const deviceCode = str(j?.device_code);
    const userCode = str(j?.user_code);
    const expiresIn = typeof j?.expires_in === 'number' ? j.expires_in : 0;
    if (deviceCode === '' || userCode === '' || expiresIn <= 0) throw new YoutubeError('bad_response', r.status);
    const interval = typeof j?.interval === 'number' && j.interval >= 1 && j.interval <= 60 ? Math.ceil(j.interval) : 5;
    const nowMs = this.d.now().getTime();
    const expiresAtMs = nowMs + Math.min(expiresIn, 1800) * 1000;
    // the device code stays on the box; the screen only ever gets the user code and the address
    this.pending = {
      deviceCode,
      expiresAtMs,
      interval,
      nextPollAtMs: nowMs + interval * 1000,
      last: { state: 'pending', signedIn: false, channelTitle: null, interval },
    };
    return { verificationUrl: VERIFICATION_URL, userCode, expiresAt: new Date(expiresAtMs).toISOString(), interval };
  }

  poll(): Promise<SigninPoll> {
    // one poll at a time: a second caller shares the first one's answer
    this.pollJob ??= this.doPoll().finally(() => {
      this.pollJob = null;
    });
    return this.pollJob;
  }

  private async doPoll(): Promise<SigninPoll> {
    const p = this.pending;
    if (p === null) return { state: this.signedIn() ? 'signed_in' : 'none', signedIn: this.signedIn(), channelTitle: this.channelTitle(), interval: null };
    const nowMs = this.d.now().getTime();
    if (nowMs >= p.expiresAtMs) {
      this.pending = null;
      return { state: 'expired', signedIn: false, channelTitle: null, interval: null };
    }
    // Google's pacing is kept box-side: an early poll gets the cached answer and costs no request
    if (nowMs < p.nextPollAtMs) return p.last;
    const client = this.client();
    if (client === null) throw new YoutubeError('not_configured');
    p.nextPollAtMs = nowMs + p.interval * 1000;
    let r;
    try {
      r = await this.post(TOKEN_URL, {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        device_code: p.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
    } catch (e) {
      this.lastErrorReason = e instanceof YoutubeError ? e.reason : 'network';
      return { ...p.last, state: 'error' };
    }
    const j = r.json;
    if (r.status === 200 && str(j?.access_token) !== '' && str(j?.refresh_token) !== '') {
      const accessToken = str(j?.access_token);
      const expiresIn = typeof j?.expires_in === 'number' ? j.expires_in : 3600;
      const channel = await this.readChannel(accessToken);
      this.tokens = {
        refreshToken: str(j?.refresh_token),
        accessToken,
        expiresAt: nowMs + expiresIn * 1000,
        channelId: channel.id,
        channelTitle: channel.title,
        scope: str(j?.scope) || YOUTUBE_SCOPE,
        streamId: null,
      };
      this.store.save(this.tokens);
      this.needsReauth = false;
      this.lastErrorReason = null;
      this.pending = null;
      return { state: 'signed_in', signedIn: true, channelTitle: this.channelTitle(), interval: null };
    }
    const code = googleDetail(j);
    let out: SigninPoll;
    if (code === 'authorization_pending') out = { state: 'pending', signedIn: false, channelTitle: null, interval: p.interval };
    else if (code === 'slow_down') {
      p.interval = Math.min(p.interval + 5, 60);
      p.nextPollAtMs = nowMs + p.interval * 1000;
      out = { state: 'pending', signedIn: false, channelTitle: null, interval: p.interval };
    } else if (code === 'access_denied') {
      this.pending = null;
      return { state: 'denied', signedIn: false, channelTitle: null, interval: null };
    } else if (code === 'expired_token') {
      this.pending = null;
      return { state: 'expired', signedIn: false, channelTitle: null, interval: null };
    } else {
      this.lastErrorReason = failureOf(r.status, j).reason;
      out = { state: 'error', signedIn: false, channelTitle: null, interval: p.interval };
    }
    p.last = out;
    return out;
  }

  private async readChannel(accessToken: string): Promise<{ id: string; title: string }> {
    try {
      const r = await googleRequest(this.d.fetchImpl, CHANNELS_URL, { headers: { Authorization: `Bearer ${accessToken}` } }, { timeoutMs: this.timeoutMs });
      const items = r.status === 200 && r.json !== null && Array.isArray(r.json.items) ? (r.json.items as unknown[]) : [];
      const first = items[0];
      if (typeof first === 'object' && first !== null) {
        const o = first as { id?: unknown; snippet?: { title?: unknown } };
        return { id: str(o.id), title: str(o.snippet?.title).slice(0, 100) };
      }
    } catch {
      /* the sign-in itself succeeded; the title can be read later */
    }
    return { id: '', title: '' };
  }

  /* ------------------------------------------------------------ access token */

  /** A usable access token, refreshed 60 s before it expires. `invalid_grant` marks the box for re-authorisation and is never retried. */
  accessToken(): Promise<string> {
    const t = this.tokens;
    if (t === null || this.needsReauth) return Promise.reject(new YoutubeError('reauthorise'));
    if (this.d.now().getTime() < t.expiresAt - REFRESH_MARGIN_MS) return Promise.resolve(t.accessToken);
    this.refreshJob ??= this.refresh(t).finally(() => {
      this.refreshJob = null;
    });
    return this.refreshJob;
  }

  private async refresh(t: YoutubeTokens): Promise<string> {
    const client = this.client();
    if (client === null) throw new YoutubeError('not_configured');
    const r = await this.post(TOKEN_URL, {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: t.refreshToken,
      grant_type: 'refresh_token',
    });
    const access = str(r.json?.access_token);
    if (r.status === 200 && access !== '') {
      const expiresIn = typeof r.json?.expires_in === 'number' ? r.json.expires_in : 3600;
      this.tokens = { ...t, accessToken: access, expiresAt: this.d.now().getTime() + expiresIn * 1000 };
      this.store.save(this.tokens);
      this.lastErrorReason = null;
      return access;
    }
    if (googleDetail(r.json) === 'invalid_grant') {
      this.needsReauth = true;
      throw new YoutubeError('reauthorise', r.status, 'invalid_grant');
    }
    throw failureOf(r.status, r.json);
  }

  /** The sign-in is dropped even when Google cannot be reached; the revoke is best effort. */
  async signout(): Promise<void> {
    const t = this.tokens;
    this.tokens = null;
    this.pending = null;
    this.needsReauth = false;
    this.lastErrorReason = null;
    this.store.clear();
    if (t !== null) {
      try {
        await this.post(REVOKE_URL, { token: t.refreshToken });
      } catch {
        /* revoking is a courtesy */
      }
    }
  }
}
