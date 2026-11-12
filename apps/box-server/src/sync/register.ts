import type { DatabaseSync } from 'node:sqlite';
import { sha256hex } from '../auth/crypto.ts';
import { getSettings } from '../settingsStore.ts';
import { parseLinkAnswer, storeLink } from './linkStore.ts';
import { generateSyncKeyPair, loadOrCreateClaim, normaliseCloudUrl } from './syncKey.ts';

/**
 * The box links itself to the MAXCOM cloud (SECURITY code). Nothing is asked of the surau; MAXCOM approves once.
 *
 *  1. An unlinked box with `cloudSync` on makes a 32-byte claim secret R (sealed in `secret/sync.claim`, kept across
 *     restarts, bound to the cloud origin) and announces `POST <cloud>/register` {boxId, name, claimHash: sha256(R)}
 *     to the Worker: every 6 hours after an accepted one (200), 15 minutes after a 409 or 429, 6 hours after a 400.
 *     The Worker never wakes the VM for it. The box shows a claim code (the first 8 hex of the claimHash).
 *  2. A MAXCOM operator sees the pending box (`users.ts cloud-pending`) and approves it (`cloud-approve`, optionally
 *     checking the claim code the surau reads out): the cloud stores the approval bound to that claimHash.
 *  3. At most every 5 minutes (15 after a 429) the box sends `POST <cloud>/api/sync/claim` {boxId, claim: R,
 *     publicJwk}. While the VM sleeps the Worker answers 503 (never a wake: retried with the agent's backoff); 401
 *     means not approved yet. A 200 carries the same answer as `/api/sync/link`, which is stored exactly as the link
 *     command stores it (with the key pair that was sent), and R is deleted. Then normal sync starts.
 *
 * R is never logged and is sent only to the origin it was made for; only its hash goes anywhere else. A state
 * change is logged once, never on every check.
 */

export const DEFAULT_CLOUD_URL = 'https://api.mymaxcom.my';
/** A registration the Worker accepted (200) is repeated this often while the box is unlinked (it refreshes its TTL). */
export const REGISTER_EVERY_MS = 6 * 3_600_000;
/** A registration answered 409 (another claimHash holds the id) or 429 (rate limit, Worker full) is retried after this. */
export const REG_RETRY_MS = 15 * 60_000;
/** A registration answered 400 (or another 4xx) is retried after this. */
export const REG_BAD_RETRY_MS = 6 * 3_600_000;
/** While unapproved, the claim goes to the cloud at most this often (the cloud allows 5 per 10 minutes per box). */
export const CLAIM_EVERY_MS = 5 * 60_000;
/** After a 429 on the claim the box waits this long. */
export const CLAIM_BACKOFF_MS = 15 * 60_000;
/** After this long of nothing but 401 on the claim, the box says once how to recover. */
export const UNAPPROVED_WARN_MS = 24 * 3_600_000;
const CALL_TIMEOUT_MS = 30_000;
// sync_state keys (all `autolink_*`, all cleared by storeLink when the box links)
const REG_AT_KEY = 'autolink_reg_at';
const REG_RETRY_KEY = 'autolink_reg_retry_at';
const CLAIM_AT_KEY = 'autolink_claim_at';
const CLAIM_WAIT_KEY = 'autolink_claim_wait';
const UNAPPROVED_KEY = 'autolink_401_since';
/** The claim code of the registration the Worker accepted: the first 8 hex of its claimHash (shown to the surau). */
export const CLAIM_CODE_KEY = 'autolink_claim_code';
const CLAIM_CODE_RE = /^[0-9a-f]{8}$/;

const STALE_LINE =
  'Belum diluluskan selepas 24 jam. Jika sudah diluluskan, jalankan cloud-revoke-site kemudian cloud-approve semula. / ' +
  'Not approved after 24 hours. If it was approved, run cloud-revoke-site and then cloud-approve again.';

/** A name fit to show an operator: no control (Cc) or format (Cf) characters (bidi overrides, zero-width), at most 80. */
export function cleanRegName(raw: string): string {
  return raw.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 80).replace(/[\uD800-\uDBFF]$/, '');
}

/** The claim code a pending box shows (`GET /api/sync/status`), or null. */
export function claimCodeOf(db: DatabaseSync): string | null {
  const r = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(CLAIM_CODE_KEY);
  return typeof r?.value === 'string' && CLAIM_CODE_RE.test(r.value) ? r.value : null;
}

export type LinkState = 'linked' | 'pending' | 'off';
/** linked: the box is now linked; pending: keep asking quietly; retry: the cloud is down or asleep (back off). */
export type StepResult = 'linked' | 'pending' | 'retry';

/**
 * Safety net: under vitest (VITEST set; spawned children inherit it) the box must never contact the MAXCOM
 * production cloud (mymaxcom.my or any subdomain), whatever a test forgot to override. Production has no VITEST.
 */
export function isBlockedUnderTest(cloudUrl: string, env: Record<string, string | undefined> = process.env): boolean {
  if (env.VITEST === undefined || env.VITEST === '') return false;
  try {
    const host = new URL(cloudUrl).hostname.toLowerCase();
    return host === 'mymaxcom.my' || host.endsWith('.mymaxcom.my');
  } catch {
    return false;
  }
}

/** The cloud an unlinked box asks: the operator's override (env SURAU_CLOUD_URL), else the setting, else MAXCOM's. https only. */
export function autoLinkCloud(
  override: string | null | undefined,
  setting: unknown,
  env: Record<string, string | undefined> = process.env,
): string | null {
  let url: string | null = null;
  for (const raw of [override ?? '', typeof setting === 'string' ? setting : '']) {
    if (raw.trim() === '') continue;
    const u = normaliseCloudUrl(raw);
    if (u !== null) {
      url = u;
      break;
    }
  }
  url ??= normaliseCloudUrl(DEFAULT_CLOUD_URL);
  if (url !== null && isBlockedUnderTest(url, env)) {
    if (!blockedLogged) {
      blockedLogged = true;
      console.log('Sync: running under a test; the MAXCOM production cloud is not contacted (auto-link off)');
    }
    return null;
  }
  return url;
}
let blockedLogged = false;

/** `link` of `GET /api/sync/status` on a box. */
export function linkState(db: DatabaseSync): LinkState {
  const linked = db.prepare("SELECT value FROM sync_state WHERE key = 'linked'").get();
  if (linked?.value === '1') return 'linked';
  return getSettings(db).cloudSync.enabled === true ? 'pending' : 'off';
}

export interface AutoLinkOptions {
  db: DatabaseSync;
  dataDir: string;
  boxId: string;
  now: () => Date;
  fetchImpl: typeof fetch;
  /** Operator override of the cloud address (env SURAU_CLOUD_URL). */
  cloudUrl?: string | null;
}

export class AutoLink {
  private readonly o: AutoLinkOptions;
  /** The last state logged per channel (`reg`: registration, `claim`: the claim), so a state is logged once. */
  private readonly lastLogged = new Map<string, string>();
  /** The key pair of the claim in flight: made when a claim is first sent, reused until the claim succeeds. */
  private pair: ReturnType<typeof generateSyncKeyPair> | null = null;

  constructor(o: AutoLinkOptions) {
    this.o = o;
  }

  private note(channel: 'reg' | 'claim', state: string, line: string): void {
    if (this.lastLogged.get(channel) === state) return;
    this.lastLogged.set(channel, state);
    console.log(`Sync: ${line}`);
  }

  private async post(url: string, body: unknown): Promise<Response | null> {
    try {
      return await this.o.fetchImpl(url, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
  }

  private getState(key: string): string | null {
    const r = this.o.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
    return typeof r?.value === 'string' ? r.value : null;
  }

  private setState(key: string, value: string): void {
    this.o.db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  private dropState(key: string): void {
    this.o.db.prepare('DELETE FROM sync_state WHERE key = ?').run(key);
  }

  /** A stored time in ms, or 0 when absent or unreadable. */
  private timeOf(key: string): number {
    const v = this.getState(key);
    const t = v === null ? NaN : Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }

  /**
   * Register when the last accepted registration is 6 h old and no retry wait runs. A stored time further ahead than
   * its own wait (the clock went back) counts as due.
   */
  private registerDue(now: number): boolean {
    const last = this.timeOf(REG_AT_KEY);
    if (last !== 0 && last <= now && now - last < REGISTER_EVERY_MS) return false;
    const retry = this.timeOf(REG_RETRY_KEY);
    if (retry !== 0 && retry > now && retry - now <= REG_BAD_RETRY_MS) return false;
    return true;
  }

  private claimDue(now: number): boolean {
    const last = this.timeOf(CLAIM_AT_KEY);
    if (last === 0 || last > now) return true;
    const wait = this.getState(CLAIM_WAIT_KEY) === String(CLAIM_BACKOFF_MS) ? CLAIM_BACKOFF_MS : CLAIM_EVERY_MS;
    return now - last >= wait;
  }

  private async register(cloud: string, claim: string, now: number): Promise<void> {
    const { db, boxId } = this.o;
    const name = cleanRegName(getSettings(db).surauInfo.name);
    const claimHash = sha256hex(claim);
    const res = await this.post(`${cloud}/register`, { boxId, name, claimHash });
    const status = res?.status ?? 0;
    await res?.arrayBuffer().catch(() => undefined);
    // a network failure or a 5xx is tried again on the next check
    if (status === 0 || status >= 500) return;
    if (status === 200) {
      const code = claimHash.slice(0, 8);
      this.setState(REG_AT_KEY, new Date(now).toISOString());
      this.dropState(REG_RETRY_KEY);
      this.setState(CLAIM_CODE_KEY, code);
      this.note('reg', `registered:${code}`, `registered with the MAXCOM cloud (claim code ${code}); waiting for approval`);
      return;
    }
    const wait = status === 409 || status === 429 ? REG_RETRY_MS : REG_BAD_RETRY_MS;
    this.setState(REG_RETRY_KEY, new Date(now + wait).toISOString());
    if (status === 409) this.note('reg', 'conflict', 'the MAXCOM cloud holds another registration for this box id; MAXCOM must clear it (trying again in 15 minutes)');
    else if (status === 429) this.note('reg', 'limited', 'the MAXCOM cloud refused the registration for now (too many); trying again in 15 minutes');
    else if (status === 400) this.note('reg', 'invalid', 'the MAXCOM cloud refused the registration as invalid; trying again in 6 hours');
  }

  /** One try: register when due, then claim when due. Never throws. */
  async step(): Promise<StepResult> {
    const { db, dataDir, boxId } = this.o;
    const cloud = autoLinkCloud(this.o.cloudUrl, getSettings(db).cloudSync.cloudUrl);
    if (cloud === null) return 'pending';
    let claim: string;
    try {
      claim = loadOrCreateClaim(dataDir, cloud);
    } catch {
      this.note('claim', 'no_claim', 'cannot store the cloud claim secret; automatic link waits');
      return 'pending';
    }

    const now = this.o.now().getTime();
    if (this.registerDue(now)) await this.register(cloud, claim, now);
    if (!this.claimDue(now)) return 'pending';

    // one pair per claim in flight: the pair that is sent is the pair that is stored
    this.pair ??= generateSyncKeyPair();
    const pair = this.pair;
    this.setState(CLAIM_AT_KEY, new Date(now).toISOString());
    this.setState(CLAIM_WAIT_KEY, String(CLAIM_EVERY_MS));
    const res = await this.post(`${cloud}/api/sync/claim`, { boxId, claim, publicJwk: pair.publicJwk });
    if (res === null) return 'retry';
    if (res.status === 200) {
      const answer = parseLinkAnswer(await res.json().catch(() => null));
      if (answer === null) {
        this.note('claim', 'bad_answer', 'the cloud gave a bad claim answer');
        return 'retry';
      }
      storeLink(db, dataDir, { privateJwk: pair.privateJwk, publicJwk: pair.publicJwk, cloudUrl: cloud, answer, now: this.o.now() });
      this.pair = null;
      this.note('claim', 'linked', `linked to the MAXCOM cloud (${answer.name.slice(0, 80)})`);
      return 'linked';
    }
    await res.arrayBuffer().catch(() => undefined);
    // the VM sleeps (503 from the Worker) or is unwell: normal, never a wake
    if (res.status >= 500) return 'retry';
    if (res.status === 429) {
      // the cloud's limiter: wait longer; this says nothing about the approval
      this.setState(CLAIM_WAIT_KEY, String(CLAIM_BACKOFF_MS));
      this.note('claim', 'limited', 'the MAXCOM cloud is limiting claims; trying again in 15 minutes');
      return 'pending';
    }
    if (res.status === 401) {
      let since = this.timeOf(UNAPPROVED_KEY);
      if (since === 0 || since > now) {
        since = now;
        this.setState(UNAPPROVED_KEY, new Date(now).toISOString());
      }
      if (now - since >= UNAPPROVED_WARN_MS) this.note('claim', 'stale', STALE_LINE);
      else this.note('claim', 'pending', 'waiting for MAXCOM to approve this box');
      return 'pending';
    }
    this.dropState(UNAPPROVED_KEY);
    this.note('claim', 'pending', 'waiting for MAXCOM to approve this box');
    return 'pending';
  }
}
