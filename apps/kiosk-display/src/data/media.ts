import { isPreview } from './preview.ts';

/** Name of the service worker's picture cache (kept in step with build/sw-plugin.ts). */
export const MEDIA_CACHE = 'surau-media-v1';

function post(msg: Record<string, unknown>): void {
  if (isPreview()) return;
  try {
    globalThis.navigator?.serviceWorker?.controller?.postMessage(msg);
  } catch {
    /* no worker: nothing to tell */
  }
}

/** Tells the worker which pictures the latest content uses; it drops every other cached picture. */
export function keepMedia(ids: readonly string[]): void {
  post({ type: 'media-keep', ids: [...ids] });
}

/** The box refused this display (401): forget every cached picture, from the page and via the worker. */
export function clearMedia(): void {
  if (isPreview()) return;
  post({ type: 'media-clear' });
  try {
    void globalThis.caches?.delete(MEDIA_CACHE).catch(() => undefined);
  } catch {
    /* Cache API unavailable */
  }
}
