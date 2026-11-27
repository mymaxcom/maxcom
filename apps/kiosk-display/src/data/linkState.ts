import { useEffect, useRef, useState } from 'preact/hooks';
import type { BoxStateView } from '@surau/core';

type Fetch = typeof fetch;
const realFetch: Fetch = (...a) => globalThis.fetch(...a);

/** The steps of the work after the agreement, as `GET /api/kiosk/link` names them. */
export const PROGRESS_STEPS = ['backup', 'people', 'commit', 'finish'] as const;
export type ProgressStep = (typeof PROGRESS_STEPS)[number];

/** `GET /api/kiosk/link`, read defensively: a field the box did not send is null. A cookie TV gets all nulls. */
export interface LinkView {
  mode: 'main' | 'follower';
  master: { name: string } | null;
  qr: { payload: string; expiresAt: string } | null;
  step: string | null;
  code: string | null;
  peer: { name: string } | null;
  progress: { step: string; stepNo: number | null; steps: number | null; percent: number | null } | null;
  last: { outcome: string | null; finishedAt: string } | null;
  /** The cutting of a link, as the box reports it for this TV; null when none is on. */
  unlink: { step: UnlinkStep; percent: number | null } | null;
  /** O23: on a follower, since when its main box has not answered (an ISO instant); null when the box sends none. */
  masterUnreachableSince: string | null;
}

/** The steps of an unlink the TV names. `done` on a follower stays until its admin has joined. */
export const UNLINK_STEPS = ['copy', 'back', 'carry-on', 'empty', 'done'] as const;
export type UnlinkStep = (typeof UNLINK_STEPS)[number];

/** What the page shows over everything, in the order it wins when more than one is true. */
export type LinkScreenKind = 'code' | 'wait' | 'unlink' | 'progress' | 'qr' | 'done' | 'ended' | 'connecting';

/** The result window of a finished link: the box reports it for a minute, the screen keeps it for 20 s. */
export const LAST_MAX_MS = 60_000;
export const LAST_SHOW_MS = 20_000;

/** Every 5 s normally, every 2 s while a session is on (`step`) or a code is up (`qr`). */
export function linkIntervalFor(v: LinkView | null): number {
  return v !== null && (v.step !== null || v.qr !== null || v.unlink !== null || v.progress !== null) ? 2_000 : 5_000;
}

const str = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Any JSON into a LinkView: never throws, an unexpected shape reads as "nothing to show". */
export function parseLink(j: unknown): LinkView {
  const o = (typeof j === 'object' && j !== null ? j : {}) as Record<string, unknown>;
  const obj = (x: unknown): Record<string, unknown> | null => (typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : null);
  const m = obj(o.master);
  const q = obj(o.qr);
  const p = obj(o.peer);
  const pr = obj(o.progress);
  const l = obj(o.last);
  const mName = m === null ? null : str(m.name);
  const qrPayload = q === null ? null : str(q.payload);
  const qrExp = q === null ? null : str(q.expiresAt);
  const finished = l === null ? null : str(l.finishedAt);
  const pStep = pr === null ? null : str(pr.step);
  const ul = obj(o.unlink);
  const ulStep = ul === null ? null : str(ul.step);
  return {
    mode: o.mode === 'follower' ? 'follower' : 'main',
    master: mName === null ? null : { name: mName },
    qr: qrPayload !== null && qrExp !== null ? { payload: qrPayload, expiresAt: qrExp } : null,
    step: str(o.step),
    code: str(o.code),
    peer: p !== null && str(p.name) !== null ? { name: str(p.name) as string } : null,
    progress:
      pr !== null && pStep !== null ? { step: pStep, stepNo: num(pr.stepNo), steps: num(pr.steps), percent: num(pr.percent) } : null,
    last: l !== null && finished !== null ? { outcome: str(l.outcome), finishedAt: finished } : null,
    unlink:
      ul !== null && ulStep !== null && (UNLINK_STEPS as readonly string[]).includes(ulStep)
        ? { step: ulStep as UnlinkStep, percent: num(ul.percent) }
        : null,
    masterUnreachableSince: isoOrNull(o.masterUnreachableSince),
  };
}

/** A readable ISO instant as given, else null. */
function isoOrNull(x: unknown): string | null {
  const s = str(x);
  return s !== null && /^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(Date.parse(s)) ? s : null;
}

export interface LinkFetched {
  view: LinkView;
  /** The box's clock minus this TV's clock, in ms (0 when the box sent no readable time). */
  offsetMs: number;
}

/**
 * The box's time as the answer carries it: a `serverTime` in the body when there is one, else the HTTP `Date`
 * header (whole seconds, enough for a countdown). `receivedAt` is this TV's clock when the answer arrived.
 */
export function offsetFromAnswer(serverTime: unknown, dateHeader: string | null, receivedAt: number): number {
  for (const raw of [serverTime, dateHeader]) {
    if (typeof raw !== 'string') continue;
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return t - receivedAt;
  }
  return 0;
}

/** Asks the box for the link state of its own TV. Throws on a failed answer (the hook keeps the previous view). */
export async function fetchLink(fetchImpl: Fetch = realFetch): Promise<LinkFetched> {
  const res = await fetchImpl('/api/kiosk/link', { credentials: 'same-origin', cache: 'no-store' });
  const receivedAt = Date.now();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as unknown;
  const st = typeof j === 'object' && j !== null ? (j as { serverTime?: unknown }).serverTime : undefined;
  return { view: parseLink(j), offsetMs: offsetFromAnswer(st, res.headers?.get?.('date') ?? null, receivedAt) };
}

export interface LinkResult {
  view: LinkView | null;
  offsetMs: number;
}

/**
 * Polls the link state: every 5 s, every 2 s while a session or a code is up, and not at all while the page is
 * hidden (it asks again at once when the page comes back). A failed poll keeps the last good answer.
 */
export function useLinkState(opts: { fetchImpl?: Fetch; intervalMs?: (v: LinkView | null) => number; enabled?: boolean } = {}): LinkResult {
  const [result, setResult] = useState<LinkResult>({ view: null, offsetMs: 0 });
  const last = useRef<LinkResult>({ view: null, offsetMs: 0 });
  const enabled = opts.enabled !== false;
  useEffect(() => {
    if (!enabled) return undefined;
    const f = opts.fetchImpl ?? realFetch;
    const next = opts.intervalMs ?? linkIntervalFor;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const hidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const later = (): void => {
      timer = hidden() ? null : setTimeout(tick, next(last.current.view));
    };
    const tick = (): void => {
      timer = null;
      if (hidden()) return;
      fetchLink(f).then(
        (r) => {
          if (!alive) return;
          last.current = { view: r.view, offsetMs: r.offsetMs };
          setResult(last.current);
          later();
        },
        () => {
          if (!alive) return;
          later();
        },
      );
    };
    const onVisible = (): void => {
      if (alive && timer === null && !hidden()) tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);
  return result;
}

/** Whole seconds left until `iso` at the box's `serverNowMs`, never negative; null when the instant is unreadable. */
export function secondsLeftAt(iso: string | null, serverNowMs: number): number | null {
  if (!iso) return null;
  const end = Date.parse(iso);
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.ceil((end - serverNowMs) / 1000));
}

/** Age in ms of a finished link at the box's clock; null when unreadable. */
export function lastAgeMs(last: LinkView['last'], serverNowMs: number): number | null {
  if (last === null) return null;
  const t = Date.parse(last.finishedAt);
  return Number.isNaN(t) ? null : serverNowMs - t;
}

/** The outcome codes the box can end a link with (the rest read as the generic line). */
export const OUTCOME_CODES = [
  'failed',
  'cancelled',
  'cancelled_by_peer',
  'rejected',
  'rejected_by_peer',
  'expired',
  'approve_timeout',
  'restart',
  'peer_unreachable',
  'case_x_unavailable',
] as const;

/** The i18n key of the reason line for an outcome code: unknown or missing codes fall back to the generic line. */
export function reasonKeyOf(outcome: string | null): string {
  return outcome !== null && (OUTCOME_CODES as readonly string[]).includes(outcome) ? `linkWhy_${outcome}` : 'linkWhy_generic';
}

/** What the link takes over the screen with at this instant, or null (a normal box with no session shows nothing). */
export function linkScreenOf(v: LinkView | null, serverNowMs: number): Exclude<LinkScreenKind, 'connecting'> | null {
  if (v === null) return null;
  if (v.step === 'code' && v.code !== null) return 'code';
  if (v.step === 'questions' || v.step === 'agreed') return 'wait';
  // An unlink wins over the rest; its "done" matters only on the follower, which waits for its admin to join.
  if (v.unlink !== null && (v.unlink.step !== 'done' || v.mode === 'follower')) return 'unlink';
  if (v.progress !== null || v.step === 'working') return 'progress';
  if (v.qr !== null) return 'qr';
  const age = lastAgeMs(v.last, serverNowMs);
  if (age !== null && age >= -5_000 && age < Math.min(LAST_SHOW_MS, LAST_MAX_MS)) return v.last?.outcome === 'linked' ? 'done' : 'ended';
  return null;
}

/**
 * The follower fields of `/api/box/state`. The server sends them later: absent means a normal box, so every read is
 * defensive. `mode` ('follower'), `master.name`, `connected`, `awayMinutes` and `needsUpdate`.
 */
export interface FollowerInfo {
  follower: boolean;
  masterName: string | null;
  /** True when the box said the master was away for 10 minutes or more. */
  away: boolean;
  needsUpdate: boolean;
}

/** After this many minutes without the master, the small mark shows (K11: never a full-screen warning for it). */
export const AWAY_MARK_MINUTES = 10;

/** O23: after this long without the main box the corner notice names the time it was last reached. */
export const MASTER_LOST_MS = 6 * 60 * 60_000;

/**
 * O23: on a follower whose main box has not answered for 6 hours or more, the instant it was last reached (ISO), else
 * null. The link answer's `masterUnreachableSince` is used when the box sends it; otherwise the box state's
 * `awayMinutes` counted back from `nowMs` (this TV's view of the box clock). Never on a box that is not a follower.
 */
export function masterLostSince(box: BoxStateView | null, link: LinkView | null, nowMs: number): string | null {
  const b = (box ?? {}) as unknown as Record<string, unknown>;
  const follower = b.mode === 'follower' || link?.mode === 'follower';
  if (!follower) return null;
  if (link?.masterUnreachableSince) {
    const t = Date.parse(link.masterUnreachableSince);
    return nowMs - t >= MASTER_LOST_MS ? new Date(t).toISOString() : null;
  }
  if (b.mode !== 'follower') return null;
  const away = num(b.awayMinutes);
  if (away === null || away * 60_000 < MASTER_LOST_MS) return null;
  return new Date(nowMs - away * 60_000).toISOString();
}

/**
 * F17: masterLostSince for the screen, with a time that does not move. Counted back from `awayMinutes` (whole minutes)
 * the instant shifts by up to a minute on every second, so the notice would read 8:30, 8:31, 8:30. The first instant
 * computed is kept while the main box stays away; it is forgotten once the notice goes. The link answer's own
 * `masterUnreachableSince` is a fixed time and is used as it is.
 */
export function useMasterLostSince(box: BoxStateView | null, link: LinkView | null, nowMs: number): string | null {
  const latched = useRef<string | null>(null);
  const since = masterLostSince(box, link, nowMs);
  if (since === null) {
    latched.current = null;
    return null;
  }
  if (link?.masterUnreachableSince) {
    latched.current = null;
    return since;
  }
  if (latched.current === null) latched.current = since;
  return latched.current;
}

export function followerInfoOf(box: BoxStateView | null): FollowerInfo {
  const b = (box ?? {}) as unknown as Record<string, unknown>;
  const follower = b.mode === 'follower';
  const m = typeof b.master === 'object' && b.master !== null ? (b.master as Record<string, unknown>) : null;
  const away = num(b.awayMinutes);
  return {
    follower,
    masterName: m === null ? null : str(m.name),
    away: follower && away !== null && away >= AWAY_MARK_MINUTES,
    needsUpdate: b.needsUpdate === true,
  };
}
