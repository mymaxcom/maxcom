import { useEffect, useState } from 'preact/hooks';
import { isNotPaired, onNotPairedChange } from './bundle.ts';

export interface PairingBegin {
  code: string;
  pollToken: string;
  expiresAt: string;
}

export type PollOutcome = 'pending' | 'approved' | 'gone';

type Fetch = typeof fetch;
const realFetch: Fetch = (...a) => globalThis.fetch(...a);

/** Asks the box for a fresh 6-digit code. Throws with `status` set on HTTP errors (429 = wait). */
export async function beginPairing(fetchImpl: Fetch = realFetch): Promise<PairingBegin> {
  const res = await fetchImpl('/api/kiosk/pair/begin', { method: 'POST', credentials: 'same-origin' });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  const j = (await res.json()) as Partial<PairingBegin>;
  if (typeof j.code !== 'string' || typeof j.pollToken !== 'string' || typeof j.expiresAt !== 'string') {
    throw new Error('bad pairing reply');
  }
  return { code: j.code, pollToken: j.pollToken, expiresAt: j.expiresAt };
}

/** 'approved' means the box has set the HttpOnly cookie on this response. 404 = code expired or used. */
export async function pollPairing(pollToken: string, fetchImpl: Fetch = realFetch): Promise<PollOutcome> {
  const res = await fetchImpl('/api/kiosk/pair/poll', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pollToken }),
  });
  if (res.status === 404) return 'gone';
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { status?: unknown };
  return j.status === 'approved' ? 'approved' : 'pending';
}

export interface PairingView {
  /** The code to show on screen, or null while one is being fetched. */
  code: string | null;
  expiresAt: string | null;
  /** True once approved: the screen should reload so the data layer picks up the cookie. */
  paired: boolean;
  error: string | null;
}

const POLL_MS = 2000;
const RETRY_MS = 10_000;

/** Drives the Pair screen: begin, poll until approved, restart when the code expires. */
export function usePairing(opts: { fetchImpl?: Fetch; pollMs?: number; retryMs?: number } = {}): PairingView {
  const [view, setView] = useState<PairingView>({ code: null, expiresAt: null, paired: false, error: null });
  useEffect(() => {
    const f = opts.fetchImpl ?? realFetch;
    const pollMs = opts.pollMs ?? POLL_MS;
    const retryMs = opts.retryMs ?? RETRY_MS;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = (fn: () => void, ms: number): void => {
      if (alive) timer = setTimeout(fn, ms);
    };
    const start = (): void => {
      beginPairing(f).then(
        (b) => {
          if (!alive) return;
          setView({ code: b.code, expiresAt: b.expiresAt, paired: false, error: null });
          const tick = (): void => {
            pollPairing(b.pollToken, f).then(
              (o) => {
                if (!alive) return;
                if (o === 'approved') setView((v) => ({ ...v, paired: true }));
                else if (o === 'gone') start();
                else later(tick, pollMs);
              },
              () => later(tick, pollMs),
            );
          };
          later(tick, pollMs);
        },
        (e: unknown) => {
          if (!alive) return;
          setView({ code: null, expiresAt: null, paired: false, error: e instanceof Error ? e.message : String(e) });
          later(start, retryMs);
        },
      );
    };
    start();
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return view;
}

/** True while the box refuses this display but a cached bundle keeps it running (corner badge). */
export function useNotPaired(): boolean {
  const [v, setV] = useState(isNotPaired());
  useEffect(() => {
    setV(isNotPaired());
    return onNotPairedChange(setV);
  }, []);
  return v;
}
