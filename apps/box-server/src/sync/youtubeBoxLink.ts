import type { DatabaseSync } from 'node:sqlite';
import type { YoutubeService } from '../live/youtube/api.ts';
import { readClientText, writeClientText } from '../live/youtube/clientFile.ts';
import { getSettings } from '../settingsStore.ts';
import { LOCAL_SURAU_ID } from '../tenant.ts';
import { BOX_REPORT_HEADERS, cloudFetch } from './agent.ts';
import { loadSyncKey, normaliseCloudUrl } from './syncKey.ts';
import { openClient } from './youtubeSeal.ts';

/**
 * The box's half of "YouTube held by the box only" (release 2026.11.13; cloud half `youtubeBoxCloud.ts`).
 * SECURITY scope: OAuth refresh tokens.
 *
 *  - The OAuth client (D2): a linked box takes the operator's client file from the cloud, sealed to this box, and
 *    keeps it as `secret/youtube-client.json`. An unlinked box keeps a file the operator placed.
 *  - The handover is over (2026.11.15, phase 4): the cloud holds no grant, so nothing is taken from it. The box only
 *    settles ("nothing to move") on its first round. What stays is the finishing of one a box began before: a grant
 *    it adopted and has not yet acknowledged, or one Google withdrew that the cloud has not yet heard about.
 *  - The flag: after a sign-in, a sign-out, a handover or a withdrawn grant, the box pushes {signedIn, channelTitle,
 *    revoked} so the app can show it away from the surau. Never a token.
 *
 * Nothing here logs or returns a token, the client secret or what the cloud answered; failures are short outcomes.
 * Never throws.
 */

const TIMEOUT_MS = 8_000;
const BODY_CAP = 32 * 1024;
const FIRST_MS = 20_000;
const EVERY_MS = 5 * 60_000;
const STATE_KEY = 'youtube_handover';
const FLAG_KEY = 'youtube_flag_sent';
/** When the flag was last taken by the cloud (ms): it is sent again at least once a day, even when unchanged (M3). */
const FLAG_AT_KEY = 'youtube_flag_sent_at';
const FLAG_REPEAT_MS = 24 * 3_600_000;
/** The repeat of a withdrawn-grant acknowledgement backs off by try (F8): 2 min, 10 min, 1 h, then every 6 h, for 3 days, then once a day. */
const REVOKED_RETRY_MS = [2 * 60_000, 10 * 60_000, 3_600_000, 6 * 3_600_000] as const;
const REVOKED_SLOW_AFTER_MS = 3 * 86_400_000;
const REVOKED_SLOW_RETRY_MS = 86_400_000;

export type HandoverOutcome = 'skipped' | 'held' | 'none' | 'adopted' | 'revoked' | 'failed';
export type ClientOutcome = 'skipped' | 'written' | 'same' | 'none' | 'failed';

export interface YoutubeBoxLinkOptions {
  db: DatabaseSync;
  dataDir: string;
  now: () => Date;
  boxId: string;
  service: YoutubeService;
  fetchImpl?: typeof fetch | undefined;
  cloudUrl?: string | null | undefined;
  /** Run the timer (default true). Tests drive `cycle` themselves. */
  auto?: boolean | undefined;
}

/** What the box remembers about the handover (ids only). */
type HandoverState =
  | { state: 'adopted'; id: string }
  | { state: 'done' }
  /** `n` tries so far, `since` the first and `at` the last one (ms); the id is kept until the cloud has heard (M3). */
  | { state: 'revoked'; id?: string; n?: number; since?: number; at?: number };

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class YoutubeBoxLink {
  private readonly o: YoutubeBoxLinkOptions;
  private readonly fetchImpl: typeof fetch;
  private busy: Promise<void> | null = null;
  private clientChecked = false;
  /** True once, in this process start, the box got the cloud's own client file (written or already the same). */
  private clientOk = false;
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;

  constructor(o: YoutubeBoxLinkOptions) {
    this.o = o;
    this.fetchImpl = o.fetchImpl ?? cloudFetch(o.dataDir);
    // a grant Google withdrew before it could move: the box keeps asking for a sign-in across restarts
    try {
      if (this.state()?.state === 'revoked' && !o.service.holdsGrant()) o.service.markRevoked();
    } catch {
      /* a database that cannot be read shows the plain signed-out state */
    }
  }

  /**
   * Why the sign-in cannot be judged yet: this box holds no grant of its own and has not yet settled the old handover
   * (its first round after the start does, with no call to the cloud), so the answer is "not known", never "signed
   * out". Null once the box holds a grant, the handover is settled, or the box is not linked.
   */
  unknownReason(): 'handover_pending' | null {
    try {
      if (this.link() === null || this.o.service.holdsGrant() || this.state() !== null) return null;
      return 'handover_pending';
    } catch {
      return null;
    }
  }

  // ---- the link --------------------------------------------------------------------------------------------------

  private link(): { token: string; base: string; privateJwk: Record<string, unknown> } | null {
    try {
      if (getSettings(this.o.db, LOCAL_SURAU_ID).cloudSync.enabled !== true) return null;
      const key = loadSyncKey(this.o.dataDir);
      if (key === null) return null;
      const override = this.o.cloudUrl ? normaliseCloudUrl(this.o.cloudUrl) : null;
      return { token: key.siteToken, base: override ?? key.cloudUrl, privateJwk: key.privateJwk as Record<string, unknown> };
    } catch {
      return null;
    }
  }

  private async call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> } | null> {
    const link = this.link();
    if (link === null) return null;
    // the same theme header as every other request of this box's agent (the cloud records the box's contract)
    const headers: Record<string, string> = { Authorization: `Bearer ${link.token}`, ...BOX_REPORT_HEADERS };
    const init: RequestInit = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) };
    // a write with nothing to say still sends `{}` as JSON (never a bodyless POST, PUT or DELETE); a GET sends nothing
    if (body !== undefined || method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }
    try {
      const res = await this.fetchImpl(`${link.base}${path}`, init);
      let text = '';
      if (res.body) {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > BODY_CAP) {
            await reader.cancel().catch(() => undefined);
            return null;
          }
          chunks.push(value);
        }
        text = Buffer.concat(chunks).toString('utf8');
      }
      let json: Record<string, unknown> = {};
      try {
        const v: unknown = JSON.parse(text);
        if (isRec(v)) json = v;
      } catch {
        json = {};
      }
      return { status: res.status, json };
    } catch {
      return null;
    }
  }

  private state(): HandoverState | null {
    const r = this.o.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(STATE_KEY);
    if (r === undefined || typeof r.value !== 'string') return null;
    try {
      const v = JSON.parse(r.value) as Record<string, unknown>;
      if (v.state === 'adopted' && typeof v.id === 'string') return { state: 'adopted', id: v.id };
      if (v.state === 'revoked') {
        if (typeof v.id !== 'string') return { state: 'revoked' };
        const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
        const n = num(v.n);
        const since = num(v.since);
        const at = num(v.at);
        return { state: 'revoked', id: v.id, ...(n !== undefined ? { n } : {}), ...(since !== undefined ? { since } : {}), ...(at !== undefined ? { at } : {}) };
      }
      if (v.state === 'done') return { state: 'done' };
    } catch {
      /* unreadable: as if never asked */
    }
    return null;
  }

  private setState(s: HandoverState): void {
    this.o.db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(STATE_KEY, JSON.stringify(s));
  }

  // ---- D2: the OAuth client --------------------------------------------------------------------------------------

  /** Takes the operator's client file from the cloud (sealed to this box) and keeps it when it differs. */
  async fetchClient(): Promise<ClientOutcome> {
    try {
      const link = this.link();
      if (link === null) return 'skipped';
      const res = await this.call('GET', '/api/sync/youtube/client');
      if (res === null || (res.status !== 200 && res.status !== 404)) return 'failed';
      if (res.status === 404) return 'none';
      if (res.json.boxId !== this.o.boxId || typeof res.json.sealed !== 'string') return 'failed';
      let text: string;
      try {
        text = openClient(link.privateJwk, res.json.sealed, this.o.boxId);
        if (!isRec(JSON.parse(text))) return 'failed';
      } catch {
        return 'failed';
      }
      // kept sealed at rest (S3); an older plaintext file reads as the same text and is sealed by that read
      if (readClientText(this.o.dataDir) === text) return 'same';
      writeClientText(this.o.dataDir, text);
      return 'written';
    } catch {
      return 'failed';
    }
  }

  // ---- the handover ----------------------------------------------------------------------------------------------

  private async ack(id: string, ok: boolean, code?: string): Promise<boolean> {
    const body = ok ? { handoverId: id, ok: true, channelTitle: this.o.service.info().channelTitle } : { handoverId: id, ok: false, code: code ?? 'error' };
    const res = await this.call('POST', '/api/sync/youtube/handover/ack', body);
    if (res === null || res.status !== 200) return false;
    // `acknowledged false`: the cloud keeps its copy (it did not take a failure it can ignore); asked again later
    return res.json.acknowledged === true;
  }

  /**
   * Settles the old handover. The cloud holds no grant now, so nothing is asked of it: a box with no state yet is
   * simply "done" ("nothing to move"). What is still finished here is a handover begun by an earlier version: a
   * grant adopted whose acknowledgement did not get through, and one Google withdrew that the cloud has not heard.
   */
  async handover(): Promise<HandoverOutcome> {
    try {
      if (this.link() === null) return 'skipped';
      const st = this.state();
      const svc = this.o.service;
      if (st?.state === 'revoked' && st.id !== undefined) {
        // Google withdrew it and the cloud has not heard yet: say so again until it lands (M3), backing off (F8)
        const t = this.o.now().getTime();
        const n = st.n ?? 1;
        const since = st.since ?? t;
        // after 3 days of refusals the cloud is still asked, once a day, until it has heard (never silent for good)
        const slow = t - since > REVOKED_SLOW_AFTER_MS;
        const wait = slow ? REVOKED_SLOW_RETRY_MS : (REVOKED_RETRY_MS[Math.min(n, REVOKED_RETRY_MS.length) - 1] ?? 0);
        if (st.at !== undefined && t - st.at < wait) return 'held';
        if (!(await this.ack(st.id, false, 'invalid_grant'))) {
          this.setState({ state: 'revoked', id: st.id, n: n + 1, since, at: t });
          if (slow) console.warn('YouTube: the cloud has not yet heard that Google withdrew the grant; asking again tomorrow');
          return 'failed';
        }
        this.setState({ state: 'revoked' });
        return 'revoked';
      }
      if (st?.state === 'done' || st?.state === 'revoked') return 'held';
      if (st?.state === 'adopted') {
        // kept here, the acknowledgement did not get through: prove it again, then say so
        if (!svc.holdsGrant()) {
          this.setState({ state: 'done' });
          return 'held';
        }
        const proof = await svc.proveGrant();
        if (proof === 'failed') return 'failed';
        const ok = proof === 'ok';
        if (!(await this.ack(st.id, ok, ok ? undefined : 'invalid_grant'))) return 'failed';
        this.setState(ok ? { state: 'done' } : { state: 'revoked' });
        return ok ? 'adopted' : 'revoked';
      }
      // no state yet: the cloud holds no grant (a grant signed in here is this box's own), so there is nothing to move
      this.setState({ state: 'done' });
      return svc.holdsGrant() ? 'held' : 'none';
    } catch {
      return 'failed';
    }
  }

  // ---- the flag --------------------------------------------------------------------------------------------------

  private flag(): { signedIn: boolean; channelTitle: string | null; revoked: boolean; signedOut?: true } {
    const i = this.o.service.info();
    // `signedOut` (Y7): a person signed out here, so the cloud drops its old copy of the grant too. Only then.
    const signedOut = !i.signedIn && i.state === 'signedOut' && i.reason === 'signed_out';
    return { signedIn: i.signedIn, channelTitle: i.signedIn ? i.channelTitle : null, revoked: !i.signedIn && i.lastError === 'reauthorise', ...(signedOut ? { signedOut: true as const } : {}) };
  }

  /** Pushes the non-secret flag when it differs from the last one the cloud took. */
  async pushFlag(): Promise<boolean> {
    try {
      if (this.link() === null) return false;
      // before the handover was looked at, the cloud's own grant is the truth: no flag over it yet
      if (this.state() === null && !this.o.service.holdsGrant()) return false;
      // a sign-in that cannot be judged (a token file that will not open) is not told to the cloud as "signed out"
      if (this.o.service.info().state === 'unknown') return false;
      const f = this.flag();
      const text = JSON.stringify(f);
      const last = this.o.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(FLAG_KEY);
      const t = this.o.now().getTime();
      const at = Number(this.o.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(FLAG_AT_KEY)?.value);
      // unchanged and sent within the day: nothing to say. Older than a day, it goes again: another box of the surau
      // may have written its own flag in the meantime, and the holder's word replaces it.
      if (last !== undefined && last.value === text && Number.isFinite(at) && t - at < FLAG_REPEAT_MS && t >= at) return true;
      let res = await this.call('PUT', '/api/sync/youtube/flag', f);
      // a cloud from before 2026.11.15 takes exactly the three old keys: the flag goes again without the new one
      if (res !== null && res.status === 400 && f.signedOut === true) {
        const { signedOut: _drop, ...old } = f;
        void _drop;
        res = await this.call('PUT', '/api/sync/youtube/flag', old);
      }
      if (res === null || (res.status !== 200 && res.status !== 409)) return false;
      // 409: another box of this surau holds the flag; nothing is stored, so a later round asks again (Q6)
      if (res.status === 409) return false;
      const put = this.o.db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      put.run(FLAG_KEY, text);
      put.run(FLAG_AT_KEY, String(t));
      return true;
    } catch {
      return false;
    }
  }

  /** A sign-in or a sign-out here: a withdrawn handover is over, and the cloud hears the new flag. */
  changed(): void {
    try {
      // a sign-in or sign-out made here settles the handover (this box now decides), so the flag below always goes out (M2)
      const st = this.state();
      if (st?.state !== 'adopted' && st?.state !== 'done' && this.link() !== null) this.setState({ state: 'done' });
    } catch {
      /* ignore */
    }
    void this.pushFlag();
  }

  /** One round: the client (once per start, or while none is set), the handover (settled locally), then the flag. Never throws. */
  cycle(): Promise<void> {
    if (this.busy !== null) return this.busy;
    this.busy = (async () => {
      try {
        if (this.link() === null) return;
        if (!this.clientChecked || !this.o.service.configured()) {
          const c = await this.fetchClient();
          if (c !== 'failed') this.clientChecked = true;
          if (c === 'written' || c === 'same') this.clientOk = true;
        }
        // a box that already has a client (placed by the operator) counts as ready (Q2): no cloud client file is needed
        if (!this.clientOk && this.o.service.configured()) this.clientOk = true;
        // finishing an earlier handover proves the grant with Google, which needs the client (without it a failed proof
        // could be taken for a withdrawn grant); settling "nothing to move" needs no client and no cloud
        if (this.clientOk || this.state() === null) await this.handover();
        await this.pushFlag();
      } catch {
        /* the next round tries again */
      }
    })().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  start(): void {
    if (this.o.auto === false || this.timer !== null) return;
    this.first = setTimeout(() => void this.cycle(), FIRST_MS);
    this.first.unref();
    this.timer = setInterval(() => void this.cycle(), EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.first !== null) clearTimeout(this.first);
    if (this.timer !== null) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }
}
