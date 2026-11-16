// Menu pictures that failed to load, kept per asset id so one bad picture never hides another, and retried:
// when the settings changed since the failure (a new bundle: the picture may have been uploaded or replaced) and
// otherwise at most once a minute per picture.

/** A failed picture is tried again after this long even when nothing changed. */
export const PICTURE_RETRY_MS = 60_000;
/** A settings change retries at once, but never faster than this after the last failure (a bundle reload loop must not hammer the box). */
export const PICTURE_RETRY_FLOOR_MS = 5_000;

export interface FailedPictures {
  /** The picture `id` could not be loaded at `now` (ms), while `version` (any object that changes with new settings) was current. */
  mark(id: string, version: object, now: number): void;
  /** True while `id` should stay hidden: it failed, nothing changed since and the wait is not over. */
  blocked(id: string, version: object, now: number): boolean;
}

export function createFailedPictures(): FailedPictures {
  const failed = new Map<string, { at: number; version: object }>();
  return {
    mark(id, version, now) {
      failed.set(id, { at: now, version });
    },
    blocked(id, version, now) {
      const f = failed.get(id);
      if (f === undefined) return false;
      const age = now - f.at;
      if (age >= PICTURE_RETRY_MS) return false;
      if (f.version !== version && age >= PICTURE_RETRY_FLOOR_MS) return false;
      return true;
    },
  };
}
