import { useEffect, useRef } from 'preact/hooks';

export type RemoteKey = 'ok' | 'back' | null;

/** TV remotes send keyboard events to a browser: OK is Enter (or Select), Back is Backspace, Escape or GoBack. */
export function classifyKey(ev: { key?: string; code?: string }): RemoteKey {
  const key = ev.key ?? '';
  const code = ev.code ?? '';
  if (key === 'Enter' || key === 'Select' || code === 'Enter' || code === 'NumpadEnter') return 'ok';
  if (key === 'Backspace' || key === 'Escape' || key === 'GoBack' || key === 'BrowserBack' || code === 'Backspace' || code === 'Escape') {
    return 'back';
  }
  return null;
}

export interface RemoteHandlers {
  onOk?: () => void;
  onBack?: () => void;
  /** OK held for `holdMs` (default 3 s) fires this once, and then the release is not an OK press. */
  onHoldOk?: () => void;
  holdMs?: number;
}

/**
 * OK fires on release, unless it was held long enough for `onHoldOk`. Key auto-repeat never restarts the hold
 * timer. Back fires on press.
 */
export function useRemoteKeys(handlers: RemoteHandlers): void {
  const h = useRef(handlers);
  h.current = handlers;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let held = false;
    const clear = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const down = (ev: KeyboardEvent): void => {
      const k = classifyKey(ev);
      if (k === 'back') {
        h.current.onBack?.();
      } else if (k === 'ok') {
        if (ev.repeat || timer !== null || held) return;
        timer = setTimeout(() => {
          timer = null;
          held = true;
          h.current.onHoldOk?.();
        }, h.current.holdMs ?? 3000);
      }
    };
    const up = (ev: KeyboardEvent): void => {
      if (classifyKey(ev) !== 'ok') return;
      const wasPending = timer !== null;
      clear();
      if (held) {
        held = false;
        return;
      }
      if (wasPending) h.current.onOk?.();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      clear();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);
}
