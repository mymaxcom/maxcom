import { useEffect, useState } from 'preact/hooks';

type Fetch = typeof fetch;
const realFetch: Fetch = (...a) => globalThis.fetch(...a);

export interface CloudView {
  linked: boolean;
  lastOkAt: string | null;
  cloudSyncEnabled: boolean;
}

export const OFFLINE_GRACE_MS = 15 * 60_000;

/**
 * A linked box (cloudSync on) that has had no good cloud exchange for 15 minutes shows the small offline badge.
 * An unlinked box, or one with cloudSync off, never does.
 */
export function isOffline(view: CloudView | null, nowMs: number, graceMs: number = OFFLINE_GRACE_MS): boolean {
  if (view === null || !view.linked || !view.cloudSyncEnabled) return false;
  if (view.lastOkAt === null) return true;
  const t = Date.parse(view.lastOkAt);
  return Number.isNaN(t) ? true : nowMs - t > graceMs;
}

export async function fetchCloud(fetchImpl: Fetch = realFetch): Promise<CloudView> {
  const res = await fetchImpl('/api/kiosk/cloud', { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as Partial<CloudView>;
  return {
    linked: j.linked === true,
    lastOkAt: typeof j.lastOkAt === 'string' ? j.lastOkAt : null,
    cloudSyncEnabled: j.cloudSyncEnabled === true,
  };
}

export interface CloudStatus {
  linked: boolean;
  lastOkAt: string | null;
  offline: boolean;
}

/** Polls the box once a minute; a failed poll keeps the last answer. */
export function useCloudStatus(opts: { fetchImpl?: Fetch; intervalMs?: number; now?: () => number } = {}): CloudStatus {
  const [view, setView] = useState<CloudView | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    const f = opts.fetchImpl ?? realFetch;
    let alive = true;
    const poll = (): void => {
      fetchCloud(f).then(
        (v) => alive && setView(v),
        () => undefined,
      );
    };
    poll();
    const id = setInterval(() => {
      poll();
      setTick((n) => n + 1);
    }, opts.intervalMs ?? 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  const now = (opts.now ?? Date.now)();
  return { linked: view?.linked === true, lastOkAt: view?.lastOkAt ?? null, offline: isOffline(view, now) };
}
