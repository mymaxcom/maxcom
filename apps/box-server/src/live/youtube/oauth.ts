import type { YoutubeAccountReason, YoutubeAccountState, YoutubeLastGood } from '@surau/core';
import { readClientText } from './clientFile.ts';
import { TokenStore } from './tokenStore.ts';
import { YoutubeStateStore, stateFileFor } from './stateStore.ts';
import type { YoutubeState } from './stateStore.ts';
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

/** What a status read shows of the sign-in the server carries (never the device code, never a token). */
export type SigninInfo =
  | { state: 'pending'; userCode: string; verificationUrl: string; expiresAt: string }
  | { state: 'denied' | 'expired' };

/** How long a `denied` / `expired` outcome stays readable, so any app (opened later, or another phone) can show it. */
export const OUTCOME_TTL_MS = 120_000;

interface Pending {
  deviceCode: string;
  userCode: string;
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
  /** Token file name under the secret folder (default `youtube-token.json`). */
  tokenFile?: string;
  /** Called once when a sign-in the server completed stored its token (the change log row). */
  onSignedIn?: (channelTitle: string | null) => void;
  /** Keep the last good sign-in and the end of a sign-in across restarts (a box does; the old cloud grants do not). */
  persistState?: boolean;
  /** Called once when Google withdrew the grant (`invalid_grant`): the change log row and the flag push. */
  onRevoked?: () => void;
}

/** The sign-in as the status shows it: three states, never a guess presented as "signed out". */
export interface AccountView {
  state: YoutubeAccountState;
  reason: YoutubeAccountReason | null;
  lastGood: YoutubeLastGood | null;
  revokedAt: string | null;
}

/** Device-code sign-in and the access token for the box's YouTube channel. */
export class YoutubeAuth {
  private readonly d: YoutubeAuthDeps;
  private readonly store: TokenStore;
  private readonly timeoutMs: number;
  private tokens: YoutubeTokens | null;
  /** The token file is there but did not open (a locked file, a key that is not ready): not the same as signed out. */
  private unreadable = false;
  private readonly stateStore: YoutubeStateStore | null;
  private persisted: YoutubeState = { lastGood: null, out: null };
  /** Why the box cannot tell right now (set by the link that knows, for example a handover not looked at yet). */
  private unknownProbe: (() => 'handover_pending' | 'cloud_unreachable' | null) | null = null;
  private pending: Pending | null = null;
  private pollJob: Promise<SigninPoll> | null = null;
  private refreshJob: Promise<string> | null = null;
  private needsReauth = false;
  private lastErrorReason: YoutubeReason | null = null;
  /** The server's own poll of Google for the pending sign-in; none while nothing is pending. */
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private outcome: { state: 'denied' | 'expired'; untilMs: number } | null = null;

  constructor(deps: YoutubeAuthDeps) {
    this.d = deps;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
    this.store = new TokenStore(deps.dataDir, deps.tokenFile);
    this.tokens = this.store.load();
    this.unreadable = this.tokens === null && this.store.exists();
    this.stateStore = deps.persistState === true ? new YoutubeStateStore(deps.dataDir, stateFileFor(deps.tokenFile)) : null;
    if (this.stateStore !== null) {
      this.persisted = this.stateStore.load();
      // Google withdrew the grant before the last restart: the token on disk is dead, and it stays "signed out" with its date
      if (this.persisted.out?.reason === 'invalid_grant') this.needsReauth = true;
    }
  }

  /** Writes the memory of the sign-in; a memory-only auth (no data folder) keeps it in this process. */
  private remember(next: YoutubeState): void {
    this.persisted = next;
    this.stateStore?.save(next);
  }

  /** The sign-in was seen working (a sign-in, a handover, a good refresh). */
  private markGood(): void {
    const title = this.channelTitle();
    const cur = this.persisted;
    const at = this.d.now().toISOString();
    // a refresh every hour: the file is written when something changed or the last write is an hour old
    if (cur.out === null && cur.lastGood !== null && cur.lastGood.channelTitle === title && Date.parse(at) - Date.parse(cur.lastGood.at) < 3_600_000) return;
    this.remember({ lastGood: { signedIn: true, channelTitle: title, at }, out: null });
  }

  /** Only `invalid_grant` or a sign-out gets here. */
  private markOut(reason: 'invalid_grant' | 'signed_out', notify = true): void {
    this.remember({ lastGood: reason === 'signed_out' ? null : this.persisted.lastGood, out: { at: this.d.now().toISOString(), reason } });
    if (reason === 'invalid_grant' && notify) {
      try {
        this.d.onRevoked?.();
      } catch {
        /* the change log must not hide the state */
      }
    }
  }

  /** A token file that did not open is read again (a lock or a key that was not ready is gone a moment later). */
  private retryUnreadable(): void {
    if (!this.unreadable) return;
    const t = this.store.load();
    if (t === null) return;
    this.tokens = t;
    this.unreadable = false;
  }

  /** Set by the part of the box that can say why the sign-in cannot be judged (no grant here yet, cloud not asked yet). */
  setUnknownProbe(fn: (() => 'handover_pending' | 'cloud_unreachable' | null) | null): void {
    this.unknownProbe = fn;
  }

  /** The three-state view for the status. Unknown is never reported as signed out. */
  view(): AccountView {
    this.retryUnreadable();
    const lastGood = this.persisted.lastGood;
    const revokedAt = this.persisted.out?.reason === 'invalid_grant' ? this.persisted.out.at : null;
    if (this.tokens !== null && !this.needsReauth) return { state: 'signedIn', reason: null, lastGood, revokedAt: null };
    if (this.needsReauth) return { state: 'signedOut', reason: 'reauthorise', lastGood, revokedAt };
    if (this.unreadable) return { state: 'unknown', reason: 'token_unreadable', lastGood, revokedAt: null };
    const why = this.unknownProbe?.() ?? null;
    if (why !== null && this.persisted.out === null) return { state: 'unknown', reason: why, lastGood, revokedAt: null };
    return { state: 'signedOut', reason: this.persisted.out?.reason === 'signed_out' ? 'signed_out' : null, lastGood: null, revokedAt: null };
  }

  /** The operator's OAuth client; read when needed and never kept in a log or an answer. */
  private client(): { clientId: string; clientSecret: string } | null {
    const text = readClientText(this.d.dataDir);
    if (text === null) return null;
    try {
      const raw: unknown = JSON.parse(text);
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
    this.retryUnreadable();
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
    // the device code stays on the box; the screen only ever gets the user code and the address.
    // One sign-in per service: a new start replaces the one before it.
    this.cancelTimer();
    this.outcome = null;
    this.pending = {
      deviceCode,
      userCode,
      expiresAtMs,
      interval,
      nextPollAtMs: nowMs + interval * 1000,
      last: { state: 'pending', signedIn: false, channelTitle: null, interval },
    };
    this.schedule();
    return { verificationUrl: VERIFICATION_URL, userCode, expiresAt: new Date(expiresAtMs).toISOString(), interval };
  }

  /** What a status read shows: the pending code, or the denied/expired outcome for a short while; null otherwise. */
  signInState(): SigninInfo | null {
    const nowMs = this.d.now().getTime();
    const p = this.pending;
    if (p !== null) {
      if (nowMs < p.expiresAtMs) return { state: 'pending', userCode: p.userCode, verificationUrl: VERIFICATION_URL, expiresAt: new Date(p.expiresAtMs).toISOString() };
      // past its time but the timer has not looked yet: it is over
      return { state: 'expired' };
    }
    if (this.outcome !== null && nowMs < this.outcome.untilMs) return { state: this.outcome.state };
    return null;
  }

  /** The server polls Google itself at Google's own pace; nothing runs while nothing is pending. */
  private schedule(): void {
    this.cancelTimer();
    const p = this.pending;
    if (p === null || this.closed) return;
    const nowMs = this.d.now().getTime();
    const delay = Math.max(0, Math.min(p.nextPollAtMs, p.expiresAtMs) - nowMs);
    const t = setTimeout(() => {
      if (this.timer === t) this.timer = null;
      void this.tick();
    }, delay);
    t.unref();
    this.timer = t;
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.closed) return;
    try {
      await this.poll();
    } catch {
      /* a failed look is tried again at the next interval (the sign-in is bounded by its expiry) */
    }
    if (this.pending !== null) this.schedule();
  }

  /** The box is closing: the sign-in poll stops (a pending sign-in is lost, as it always was). */
  shutdown(): void {
    this.closed = true;
    this.cancelTimer();
  }

  /** Marks the access token as spent so the next use refreshes it (a 401 from YouTube). */
  invalidateAccess(): void {
    if (this.tokens !== null) this.tokens = { ...this.tokens, expiresAt: 0 };
  }

  poll(): Promise<SigninPoll> {
    // one poll at a time: a second caller shares the first one's answer
    this.pollJob ??= this.doPoll().finally(() => {
      this.pollJob = null;
    });
    return this.pollJob;
  }

  /** The pending sign-in ends; the outcome (if any) stays readable for a short while. */
  private end(p: Pending, outcome: 'denied' | 'expired' | null): void {
    if (this.pending !== p) return;
    this.pending = null;
    this.cancelTimer();
    this.outcome = outcome === null ? null : { state: outcome, untilMs: this.d.now().getTime() + OUTCOME_TTL_MS };
  }

  private async doPoll(): Promise<SigninPoll> {
    const p = this.pending;
    if (p === null) {
      const nowMs0 = this.d.now().getTime();
      if (this.outcome !== null && nowMs0 < this.outcome.untilMs && !this.signedIn()) {
        return { state: this.outcome.state, signedIn: false, channelTitle: null, interval: null };
      }
      return { state: this.signedIn() ? 'signed_in' : 'none', signedIn: this.signedIn(), channelTitle: this.channelTitle(), interval: null };
    }
    const nowMs = this.d.now().getTime();
    if (nowMs >= p.expiresAtMs) {
      this.end(p, 'expired');
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
    // a new start replaced this sign-in while Google was answering: this answer is for a dead code
    if (this.pending !== p) return { state: 'pending', signedIn: false, channelTitle: null, interval: this.pending?.interval ?? null };
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
      this.unreadable = false;
      this.lastErrorReason = null;
      this.remember({ lastGood: { signedIn: true, channelTitle: this.channelTitle(), at: this.d.now().toISOString() }, out: null });
      this.end(p, null);
      try {
        this.d.onSignedIn?.(this.channelTitle());
      } catch {
        /* the change log must not undo a sign-in */
      }
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
      this.end(p, 'denied');
      return { state: 'denied', signedIn: false, channelTitle: null, interval: null };
    } else if (code === 'expired_token') {
      this.end(p, 'expired');
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
    this.retryUnreadable();
    const t = this.tokens;
    // a file that will not open is not a withdrawn grant: no re-sign-in is asked for it
    if (t === null && this.unreadable) return Promise.reject(new YoutubeError('bad_response'));
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
      this.markGood();
      return access;
    }
    if (googleDetail(r.json) === 'invalid_grant') {
      this.needsReauth = true;
      this.markOut('invalid_grant');
      throw new YoutubeError('reauthorise', r.status, 'invalid_grant');
    }
    throw failureOf(r.status, r.json);
  }

  /* ------------------------------------------------------------ the grant handed over by the cloud (2026.11.13) */

  /** A grant is stored here (it may still need a re-sign-in when Google withdrew it). */
  hasGrant(): boolean {
    return this.tokens !== null;
  }

  /**
   * Keeps a grant the cloud held before this release, then proves it with one refresh. `invalid_grant` drops it
   * here (Google withdrew it: the status shows the re-sign-in state); any other failure keeps it for the next try.
   * Nothing here revokes at Google, logs or returns the token.
   */
  async adopt(g: { refreshToken: string; channelId: string; channelTitle: string; scope: string }): Promise<'ok' | 'invalid_grant' | 'failed'> {
    this.cancelTimer();
    this.pending = null;
    this.outcome = null;
    this.needsReauth = false;
    this.unreadable = false;
    this.lastErrorReason = null;
    // an earlier "withdrawn" note must not outlive the new grant; the proof below writes the new truth
    this.remember({ lastGood: this.persisted.lastGood, out: null });
    this.tokens = {
      refreshToken: g.refreshToken,
      accessToken: '',
      expiresAt: 0,
      channelId: g.channelId,
      channelTitle: g.channelTitle.slice(0, 100),
      scope: g.scope || YOUTUBE_SCOPE,
      streamId: null,
    };
    this.store.save(this.tokens);
    return this.prove();
  }

  /** One forced refresh of the stored grant: `ok`, `invalid_grant` (dropped here, never revoked), or `failed`. */
  async prove(): Promise<'ok' | 'invalid_grant' | 'failed'> {
    if (this.tokens === null) return 'failed';
    this.invalidateAccess();
    try {
      await this.accessToken();
      return 'ok';
    } catch (e) {
      if (e instanceof YoutubeError && e.detail === 'invalid_grant') {
        this.tokens = null;
        this.store.clear();
        this.needsReauth = true;
        return 'invalid_grant';
      }
      return 'failed';
    }
  }

  /** The cloud's grant was already withdrawn by Google: show the re-sign-in state until a new sign-in here. */
  markRevoked(): void {
    if (this.tokens !== null || this.pending !== null) return;
    this.needsReauth = true;
    // written once: every start asks again, and the change log must not get a row each time
    if (this.persisted.out?.reason !== 'invalid_grant') this.markOut('invalid_grant', false);
  }

  /**
   * The daily look: one forced refresh of the stored grant, so a withdrawn grant shows before the kuliah and not at
   * "Mula siaran". `revoked` only for Google's `invalid_grant`; a network error or a 5xx is `failed` and changes
   * nothing. Nothing is cleared or revoked here.
   */
  async verify(): Promise<'ok' | 'revoked' | 'failed' | 'skipped'> {
    this.retryUnreadable();
    if (this.tokens === null || this.needsReauth || this.pending !== null || this.closed) return 'skipped';
    this.invalidateAccess();
    try {
      await this.accessToken();
      return 'ok';
    } catch {
      return this.needsReauth ? 'revoked' : 'failed';
    }
  }

  /** The sign-in is dropped even when Google cannot be reached; the revoke is best effort. */
  async signout(): Promise<void> {
    const t = this.tokens;
    this.tokens = null;
    this.pending = null;
    this.outcome = null;
    this.cancelTimer();
    this.needsReauth = false;
    this.unreadable = false;
    this.lastErrorReason = null;
    this.store.clear();
    this.markOut('signed_out', false);
    if (t !== null) {
      try {
        await this.post(REVOKE_URL, { token: t.refreshToken });
      } catch {
        /* revoking is a courtesy */
      }
    }
  }
}
