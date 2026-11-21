import type { KioskLive } from '@surau/core';

type VersionListener = (version: number, surauId: string) => void;
type LiveListener = (live: KioskLive, surauId: string) => void;
type PlayNowListener = (itemId: string, surauId: string) => void;

/** A listener with an optional surau filter: `null` hears every event, an id hears only that surau's. */
interface Scoped<T> {
  fn: T;
  surauId: string | null;
}

export interface ChangeBus {
  /** Emit a change for one surau . */
  emit(version: number, surauId: string): void;
  /** Subscribe to version events; pass a surauId to hear only that surau's events. */
  on(fn: VersionListener, surauId?: string): () => void;
  /** Live state changes (start, stop, ingest ready flips, audio setting), beside the version events. */
  emitLive(live: KioskLive, surauId: string): void;
  /** Subscribe to live events; pass a surauId to hear only that surau's events. */
  onLive(fn: LiveListener, surauId?: string): () => void;
  /** "Main sekarang": the kiosk shows this video item at once (event `play-now`). */
  emitPlayNow(itemId: string, surauId: string): void;
  onPlayNow(fn: PlayNowListener, surauId?: string): () => void;
}

/** Fan-out of change notifications (settings and prayer-data writes, live state) to SSE clients. */
export function createChangeBus(): ChangeBus {
  const listeners = new Set<Scoped<VersionListener>>();
  const liveListeners = new Set<Scoped<LiveListener>>();
  const playNowListeners = new Set<Scoped<PlayNowListener>>();
  const deliver = <T>(scoped: Set<Scoped<T>>, surauId: string, call: (fn: T) => void): void => {
    for (const { fn, surauId: filter } of [...scoped]) {
      if (filter !== null && filter !== surauId) continue;
      try {
        call(fn);
      } catch {
        // A broken listener must not prevent the others from notifying.
      }
    }
  };
  return {
    emit(version: number, surauId: string): void {
      deliver(listeners, surauId, (fn) => fn(version, surauId));
    },
    on(fn: VersionListener, surauId?: string): () => void {
      const item: Scoped<VersionListener> = { fn, surauId: surauId ?? null };
      listeners.add(item);
      return () => {
        listeners.delete(item);
      };
    },
    emitLive(live: KioskLive, surauId: string): void {
      deliver(liveListeners, surauId, (fn) => fn(live, surauId));
    },
    onLive(fn: LiveListener, surauId?: string): () => void {
      const item: Scoped<LiveListener> = { fn, surauId: surauId ?? null };
      liveListeners.add(item);
      return () => {
        liveListeners.delete(item);
      };
    },
    emitPlayNow(itemId: string, surauId: string): void {
      deliver(playNowListeners, surauId, (fn) => fn(itemId, surauId));
    },
    onPlayNow(fn: PlayNowListener, surauId?: string): () => void {
      const item: Scoped<PlayNowListener> = { fn, surauId: surauId ?? null };
      playNowListeners.add(item);
      return () => {
        playNowListeners.delete(item);
      };
    },
  };
}
