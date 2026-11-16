import { useEffect, useRef } from 'preact/hooks';
import type { KioskState, Settings } from '@surau/core';
import { isPreview } from '../data/preview.ts';

export interface AzanPlayer {
  play(url: string, volume: number): void;
  /** Changes the volume of what is playing now (0..1); nothing when idle. */
  setVolume(volume: number): void;
  stop(): void;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** One <audio> element, like the beeps and the tilawah player: the box app's WebView allows playing without a tap. */
export function createAzanPlayer(): AzanPlayer {
  let el: HTMLAudioElement | null = null;
  let started = false;
  return {
    play(url, volume) {
      el ??= new Audio();
      started = true;
      el.src = url;
      el.volume = clamp01(volume);
      const p = el.play() as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => undefined);
    },
    setVolume(volume) {
      if (el && started) el.volume = clamp01(volume);
    },
    stop() {
      if (!el || !started) return;
      started = false;
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        // element already gone
      }
    },
  };
}

let defaultPlayer: AzanPlayer | null = null;
const player = (): AzanPlayer => (defaultPlayer ??= createAzanPlayer());

/** Where the kiosk remembers the day it played the first azan, so a reload inside the 30 s start window does not replay it. */
export const FIRST_AZAN_PLAYED_KEY = 'maxcom.firstAzan.playedFor';

function playedFor(): string | null {
  try {
    return globalThis.localStorage?.getItem(FIRST_AZAN_PLAYED_KEY) ?? null;
  } catch {
    return null;
  }
}

function markPlayed(day: string): void {
  try {
    globalThis.localStorage?.setItem(FIRST_AZAN_PLAYED_KEY, day);
  } catch {
    // storage blocked or full: the in-memory key still keeps it to once per page load
  }
}

/**
 * Plays the chosen audio file once when `state.firstAzan` is set (Subuh minus minutesBefore). Once per day: the key is
 * the start time in memory, and the day is kept in localStorage so a reload inside the start window does not play it
 * again. It follows the warning beeps: `beeps.enabled` off or `beeps.volume` 0 is silent, and a volume change reaches
 * the azan that is playing. It stops by `stopsAt` at the latest (the Subuh azan countdown start, or Subuh), and while
 * `muted` (a stopped box, or a live that has priority) it plays nothing and stops what is playing, the same rule as the
 * prayer beeps. No file chosen: the state is never set, so nothing happens and nothing fails.
 */
export function useFirstAzan(
  state: KioskState,
  settings: Settings,
  opts: { muted: boolean; now: Date; impl?: AzanPlayer },
): void {
  const last = useRef<string | null>(null);
  /** The end of what is playing now (ms), or null when nothing of ours plays. */
  const stopsAt = useRef<number | null>(null);
  const fa = state.firstAzan;
  const key = fa ? `${fa.startsAt.getTime()}|${fa.audioFile}` : null;
  const day = state.today?.date ?? '';
  const { muted, impl, now } = opts;
  const b = settings.beeps as { enabled?: unknown; volume?: unknown } | undefined;
  const volume = typeof b?.volume === 'number' ? b.volume : 70;
  const silent = muted || b?.enabled === false || volume <= 0;

  const stop = (): void => {
    stopsAt.current = null;
    (impl ?? defaultPlayer)?.stop();
  };

  useEffect(() => {
    if (silent && stopsAt.current !== null) stop();
  }, [silent, impl]);

  // A volume change while it plays applies at once, without starting it again.
  useEffect(() => {
    if (stopsAt.current !== null) (impl ?? defaultPlayer)?.setVolume(volume / 100);
  }, [volume, impl]);

  const t = now.getTime();
  useEffect(() => {
    if (stopsAt.current !== null && t >= stopsAt.current) stop();
  }, [t, impl]);

  useEffect(() => {
    if (!fa || key === null || key === last.current || silent || isPreview()) return;
    last.current = key;
    if (day !== '' && playedFor() === day) return;
    if (t >= fa.stopsAt.getTime()) return;
    if (day !== '') markPlayed(day);
    stopsAt.current = fa.stopsAt.getTime();
    (impl ?? player()).play(`/assets/${fa.audioFile}`, volume / 100);
  }, [key, silent, impl, volume, day]);

  // Unmount: stop only what this hook started (the player is shared by the page).
  useEffect(() => () => {
    if (stopsAt.current !== null) stop();
  }, [impl]);
}
