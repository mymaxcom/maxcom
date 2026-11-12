import type { WorkerAdminConfig } from './workerOutbox.ts';

/**
 * The cloud's calls to the Worker's registration admin routes (`/_admin/reg`), with the same admin token as the
 * outbox. Errors carry a short reason only: never the token, a header or a response body.
 */

export interface Registration {
  boxId: string;
  name: string;
  claimHash: string;
  at: string;
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
      headers: { Authorization: `Bearer ${config.token}` },
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

function clean(boxId: unknown, v: unknown): Registration | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof boxId !== 'string' || !BOX_ID_RE.test(boxId) || typeof o.claimHash !== 'string' || !HASH_RE.test(o.claimHash)) return null;
  return {
    boxId,
    // shown to an operator: no control (Cc) or format (Cf) characters (bidi overrides, zero-width), whatever the Worker holds
    name: typeof o.name === 'string' ? o.name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 80).replace(/[\uD800-\uDBFF]$/, '') : '',
    claimHash: o.claimHash,
    at: typeof o.at === 'string' ? o.at.slice(0, 40) : '',
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
