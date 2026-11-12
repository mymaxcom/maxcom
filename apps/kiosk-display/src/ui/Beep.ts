import { useEffect, useRef } from 'preact/hooks';
import type { KioskState, Settings } from '@surau/core';
import shortUrl from '../assets/sounds/beep-short.wav';
import longUrl from '../assets/sounds/beep-long.wav';
import { isPreview } from '../data/preview.ts';

export type BeepKind = 'short' | 'long';

export interface BeepPlayer {
  play(kind: BeepKind, volume: number): void;
}

/** Plays the bundled tones through <audio>; volume 0..1. */
export function createAudioPlayer(): BeepPlayer {
  const cache: Partial<Record<BeepKind, HTMLAudioElement>> = {};
  const get = (kind: BeepKind): HTMLAudioElement => {
    let el = cache[kind];
    if (!el) {
      el = document.createElement('audio');
      el.src = kind === 'short' ? shortUrl : longUrl;
      el.preload = 'auto';
      cache[kind] = el;
    }
    return el;
  };
  return {
    play(kind, volume) {
      const el = get(kind);
      el.volume = Math.max(0, Math.min(1, volume));
      el.currentTime = 0;
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => undefined);
    },
  };
}

let defaultPlayer: BeepPlayer | null = null;
function player(): BeepPlayer {
  if (!defaultPlayer) defaultPlayer = createAudioPlayer();
  return defaultPlayer;
}

/** Short tone for the countdown start and the iqamah end warning; long tone when the time enters. */
export function kindFor(beep: NonNullable<KioskState['beep']>): BeepKind {
  return beep === 'masukWaktu' ? 'long' : 'short';
}

/**
 * Plays the beep once when `state.beep` becomes set. The state machine keeps
 * `beep` set for one whole second, so three ticks in that second share one
 * key (kind + stage end) and the sound plays once.
 */
export function useBeep(state: KioskState, settings: Settings, impl?: BeepPlayer): void {
  const last = useRef<string | null>(null);
  const key = state.beep ? `${state.beep}@${state.phase}@${state.phaseEndsAt?.getTime() ?? 0}` : null;
  useEffect(() => {
    if (!key || key === last.current || isPreview()) return;
    last.current = key;
    const b = settings.beeps;
    if (!b.enabled) return;
    const vol = typeof b.volume === 'number' ? b.volume : 70;
    if (vol <= 0) return;
    (impl ?? player()).play(kindFor(state.beep!), vol / 100);
  }, [key, settings.beeps, impl, state.beep]);
}
