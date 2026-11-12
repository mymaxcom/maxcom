import type { KioskLive } from '@surau/core';

export interface ChangeBus {
  emit(version: number): void;
  on(fn: (version: number) => void): () => void;
  /** Live state changes (start, stop, ingest ready flips, audio setting), beside the version events. */
  emitLive(live: KioskLive): void;
  onLive(fn: (live: KioskLive) => void): () => void;
}

/** Fan-out of change notifications (settings and prayer-data writes, live state) to SSE clients. */
export function createChangeBus(): ChangeBus {
  const listeners = new Set<(version: number) => void>();
  const liveListeners = new Set<(live: KioskLive) => void>();
  return {
    emit(version: number): void {
      for (const fn of [...listeners]) {
        try {
          fn(version);
        } catch {
          // A broken listener must not prevent the others from notifying.
        }
      }
    },
    on(fn: (version: number) => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    emitLive(live: KioskLive): void {
      for (const fn of [...liveListeners]) {
        try {
          fn(live);
        } catch {
          // Same rule as above.
        }
      }
    },
    onLive(fn: (live: KioskLive) => void): () => void {
      liveListeners.add(fn);
      return () => {
        liveListeners.delete(fn);
      };
    },
  };
}
