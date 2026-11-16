import { useEffect, useState } from 'preact/hooks';
import { PICTURE_RETRY_MS } from '../themes/failedPictures.ts';

// Card pictures (a notice's picture, a programme's picture) that failed to load: the card falls back to its text-only
// layout, and Main keeps the ticker for that slot, because the ticker gives way only to a picture that is really there.
// Kept per asset id and tried again after PICTURE_RETRY_MS (a picture still syncing to the box may arrive later).

const failed = new Map<string, number>();
const listeners = new Set<() => void>();

/** The card picture `id` could not be loaded (missing or undecodable); `now` in ms. */
export function markCardPictureFailed(id: string, now: number = Date.now()): void {
  const known = cardPictureFailed(id, now);
  failed.set(id, now);
  if (!known) for (const l of [...listeners]) l();
}

/** True while `id` counts as failed: it failed less than PICTURE_RETRY_MS ago. */
export function cardPictureFailed(id: string | null | undefined, now: number = Date.now()): boolean {
  if (typeof id !== 'string') return false;
  const at = failed.get(id);
  if (at === undefined) return false;
  if (now - at >= PICTURE_RETRY_MS) {
    failed.delete(id);
    return false;
  }
  return true;
}

/** Re-renders the caller when a card picture fails (Main's ticker decision reads `cardPictureFailed`). */
export function useCardPictureFailures(): void {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = (): void => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}

/** Tests only: forget every failure. */
export function resetCardPictureFailures(): void {
  failed.clear();
}
