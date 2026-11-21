import type { WorkerAdminConfig } from './workerOutbox.ts';

/**
 * The cloud's calls to the Worker's registration admin routes (`/_admin/reg`), with the same admin token as the
 * outbox. Errors carry a short reason only: never the token, a header or a response body.
 */

export interface Registration {
  boxId: string;
  name: string;
  claimHash: string;
  /** First registration. */
  at: string;
  /** Last registration (the Worker refreshes it on every one); absent from a Worker that predates it. */
  seenAt?: string;
  /** The box's own name, as the box sent it (absent from boxes that do not send it). */
  boxName?: string;
  platform?: 'android' | 'windows' | 'linux';
  /** The MAX Kiosk Server version, YYYY.MM.N. */
  version?: string;
}

const CALL_TIMEOUT_MS = 15_000;
const MAX_ANSWER = 512 * 1024;
const BOX_ID_RE = /^[0-9a-f]{16}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

export class RegError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = 'RegError';
  }
}

async function adminCall(config: WorkerAdminConfig, method: 'GET' | 'DELETE', path: string): Promise<Response> {
  try {
    return await (config.fetchImpl ?? fetch)(`${config.url.replace(/\/+$/, '')}${path}`, {
      method,
      redirect: 'manual',
      // a DELETE with nothing to say still sends `{}` as JSON; a GET sends nothing
      headers: { Authorization: `Bearer ${config.token}`, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
      ...(method === 'GET' ? {} : { body: '{}' }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch {
    throw new RegError('unreachable');
  }
}

async function jsonOf(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length > MAX_ANSWER) throw new RegError('bad_answer');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RegError('bad_answer');
  }
}

/** Text shown to an operator: no control (Cc) or format (Cf) characters (bidi overrides, zero-width), at most `max`. */
function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, max).replace(/[\uD800-\uDBFF]$/, '') : '';
}

function clean(boxId: unknown, v: unknown): Registration | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof boxId !== 'string' || !BOX_ID_RE.test(boxId) || typeof o.claimHash !== 'string' || !HASH_RE.test(o.claimHash)) return null;
  return {
    boxId,
    // shown to an operator: no control (Cc) or format (Cf) characters (bidi overrides, zero-width), whatever the Worker holds
    name: text(o.name, 80),
    claimHash: o.claimHash,
    at: typeof o.at === 'string' ? o.at.slice(0, 40) : '',
    ...(typeof o.seenAt === 'string' && o.seenAt !== '' ? { seenAt: o.seenAt.slice(0, 40) } : {}),
    // optional, whatever the Worker holds: each is checked again here and left out when empty or not valid
    ...(text(o.boxName, 60) !== '' ? { boxName: text(o.boxName, 60) } : {}),
    ...(o.platform === 'android' || o.platform === 'windows' || o.platform === 'linux' ? { platform: o.platform } : {}),
    ...(typeof o.version === 'string' && /^\d{4}\.\d{2}\.\d{1,3}$/.test(o.version) ? { version: o.version } : {}),
  };
}

/** Every pending registration the Worker holds. */
export async function listRegistrations(config: WorkerAdminConfig): Promise<Registration[]> {
  const res = await adminCall(config, 'GET', '/_admin/reg');
  if (res.status !== 200) {
    await res.arrayBuffer().catch(() => undefined);
    throw new RegError(`http_${res.status}`);
  }
  const j = (await jsonOf(res)) as { regs?: unknown };
  if (!Array.isArray(j?.regs)) throw new RegError('bad_answer');
  return j.regs.map((r) => clean((r as { boxId?: unknown } | null)?.boxId, r)).filter((r): r is Registration => r !== null);
}

/** One box's pending registration, or null when the Worker holds none. */
export async function getRegistration(config: WorkerAdminConfig, boxId: string): Promise<Registration | null> {
  if (!BOX_ID_RE.test(boxId)) throw new RegError('bad_box_id');
  const res = await adminCall(config, 'GET', `/_admin/reg/${boxId}`);
  if (res.status === 404) {
    await res.arrayBuffer().catch(() => undefined);
    return null;
  }
  if (res.status !== 200) {
    await res.arrayBuffer().catch(() => undefined);
    throw new RegError(`http_${res.status}`);
  }
  const r = clean(boxId, await jsonOf(res));
  if (r === null) throw new RegError('bad_answer');
  return r;
}

/** Remove a box's pending registration (after its claim, or a squatter's entry). A missing one is fine. */
export async function deleteRegistration(config: WorkerAdminConfig, boxId: string): Promise<void> {
  if (!BOX_ID_RE.test(boxId)) throw new RegError('bad_box_id');
  const res = await adminCall(config, 'DELETE', `/_admin/reg/${boxId}`);
  await res.arrayBuffer().catch(() => undefined);
  if (res.status !== 204 && res.status !== 200 && res.status !== 404) throw new RegError(`http_${res.status}`);
}

/** A registration older than this (by the time it carries) is stale: not listed as pending (it still expires at the Worker). */
export const PENDING_FRESH_MS = 24 * 3_600_000;
/** A box that registered less than this ago and is not held by the cap is simply about to link by itself. */
export const PENDING_GRACE_MS = 10 * 60_000;

/** Milliseconds since the first registration (`at`); NaN when it carries no readable time. */
export function registrationAgeMs(r: Pick<Registration, 'at'>, now: Date): number {
  const at = Date.parse(r.at);
  return Number.isFinite(at) ? now.getTime() - at : Number.NaN;
}

/** True when the box last registered over a day ago (by `seenAt`, else `at` for an older Worker), or carries no time. */
export function isStaleRegistration(r: Pick<Registration, 'at' | 'seenAt'>, now: Date): boolean {
  const seen = Date.parse(r.seenAt ?? r.at);
  const age = Number.isFinite(seen) ? now.getTime() - seen : Number.NaN;
  return !(age <= PENDING_FRESH_MS);
}
