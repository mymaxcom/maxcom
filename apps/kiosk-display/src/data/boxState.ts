import { useEffect, useRef, useState } from 'preact/hooks';
import type { BoxState, BoxStateView } from '@surau/core';

type Fetch = typeof fetch;
const realFetch: Fetch = (...a) => globalThis.fetch(...a);

/** Every 5 s while the box is not active (a QR is on screen), every 60 s when active. */
export function pollIntervalFor(state: BoxState | undefined): number {
  return state === 'active' ? 60_000 : 5_000;
}

export interface BoxStateResult {
  /** The last good answer; kept when a poll fails, so a hiccup never changes the screen. */
  view: BoxStateView | null;
  error: string | null;
}

/** Asks the box which screen it is in. Throws on a failed or malformed answer (the hook keeps the previous view). */
export async function fetchBoxState(fetchImpl: Fetch = realFetch): Promise<BoxStateView> {
  const res = await fetchImpl('/api/box/state', { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as Partial<BoxStateView>;
  if (
    typeof j.boxId !== 'string' ||
    (j.state !== 'setup' && j.state !== 'active' && j.state !== 'recovery' && j.state !== 'locked')
  ) {
    throw new Error('bad box state');
  }
  return j as BoxStateView;
}

/**
 * The box's name for the pairing screen. `/api/box/info` is public: an unpaired display is refused `/api/box/state`,
 * and an unpaired display is the only one that ever shows that screen. A failure just leaves the line out.
 */
export function useBoxName(fetchImpl: Fetch = realFetch): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchImpl('/api/box/info', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) return;
        const j = (await res.json()) as { name?: unknown };
        if (alive && typeof j.name === 'string' && j.name !== '') setName(j.name);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return name;
}

export function useBoxState(opts: { fetchImpl?: Fetch; intervalMs?: (state: BoxState | undefined) => number } = {}): BoxStateResult {
  const [result, setResult] = useState<BoxStateResult>({ view: null, error: null });
  const last = useRef<BoxStateView | null>(null);
  useEffect(() => {
    const f = opts.fetchImpl ?? realFetch;
    const next = opts.intervalMs ?? pollIntervalFor;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = (): void => {
      fetchBoxState(f).then(
        (v) => {
          if (!alive) return;
          last.current = v;
          setResult({ view: v, error: null });
          timer = setTimeout(tick, next(v.state));
        },
        (e: unknown) => {
          if (!alive) return;
          setResult({ view: last.current, error: e instanceof Error ? e.message : 'error' });
          timer = setTimeout(tick, next(last.current?.state));
        },
      );
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return result;
}
