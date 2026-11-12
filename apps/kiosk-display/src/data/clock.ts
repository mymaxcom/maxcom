import { useEffect, useState } from 'preact/hooks';
import { isPreview } from './preview.ts';

/** '?now=2026-11-03T15:52:00%2B08:00' -> that instant; anything invalid -> null. */
export function parseNowOverride(search: string): Date | null {
  const raw = new URLSearchParams(search).get('now');
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * ?now= is a development/proof aid: honoured in dev, in tests, or when the URL also carries proof=1 or preview=1.
 * A preview page shows no data until the host hands it a token, so a faked clock there reveals nothing, and a
 * paired display (whose URL has no preview=1) is not affected.
 */
export function nowOverrideAllowed(
  search: string,
  env: { DEV?: boolean; MODE?: string } = import.meta.env,
): boolean {
  if (env.DEV || env.MODE === 'test') return true;
  return new URLSearchParams(search).get('proof') === '1' || isPreview(search);
}

/** Current time, ticking on each second boundary. With ?now= it starts there and advances in real time. */
export function useNow(): Date {
  const [offset] = useState(() => {
    let o: Date | null = null;
    try {
      const search = window.location.search;
      o = nowOverrideAllowed(search) ? parseNowOverride(search) : null;
    } catch {
      o = null;
    }
    return o ? o.getTime() - Date.now() : 0;
  });
  const [now, setNow] = useState(() => new Date(Date.now() + offset));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      setNow(new Date(Date.now() + offset));
      timer = setTimeout(tick, 1000 - (Date.now() % 1000));
    };
    timer = setTimeout(tick, 1000 - (Date.now() % 1000));
    return () => clearTimeout(timer);
  }, [offset]);

  return now;
}
