import { useEffect, useMemo, useRef } from 'preact/hooks';
import { tilawahWindow } from '@surau/core';
import type { KioskContent } from '@surau/core';
import type { KioskView } from '../data/kiosk.ts';
import { isPreview } from '../data/preview.ts';
import { tarawihMonthFor } from '../data/tarawih.ts';

export interface Player {
  start(reciter: string, surah: number, ayatCount: number): void;
  stop(): void;
  playing(): boolean;
}

const AUDIO_BASE = '/islamic/audio';
const RECITER_RE = /^[A-Za-z0-9_.-]+$/;

const pad3 = (n: number): string => String(n).padStart(3, '0');

/** One <audio> element plays /islamic/audio/<reciter>/<surah>/<aaa>.mp3 in order and preloads the next ayat. */
export function createTilawahPlayer(opts: { base: string; volume: number }): Player {
  let main: HTMLAudioElement | null = null;
  let next: HTMLAudioElement | null = null;
  let active = false;
  let loggedError = false;
  let reciter = '';
  let surah = 0;
  let count = 0;
  let n = 0;
  /** Consecutive ayat that failed to play; one missing file is skipped, a second in a row ends the recitation. */
  let failures = 0;
  let failedAt = 0;

  const url = (aya: number): string => `${opts.base}/${reciter}/${surah}/${pad3(aya)}.mp3`;

  const halt = (): void => {
    active = false;
    try {
      main?.pause();
      main?.removeAttribute('src');
      main?.load();
    } catch {
      // element already gone
    }
  };

  const fail = (e: unknown): void => {
    if (!active) return;
    // An 'error' event and a play() rejection can both report the same ayat: count it once.
    if (failedAt === n) return;
    failedAt = n;
    failures += 1;
    if (failures < 2 && n < count) {
      n += 1;
      playCurrent();
      return;
    }
    halt();
    if (!loggedError) {
      loggedError = true;
      console.warn('tilawah: playback ended', e instanceof Error ? e.message : String(e));
    }
  };

  const playCurrent = (): void => {
    if (!main) return;
    main.src = url(n);
    if (n < count && next) next.src = url(n + 1);
    try {
      const p = main.play() as Promise<void> | undefined;
      p?.catch(fail);
    } catch (e) {
      fail(e);
    }
  };

  const ensure = (): void => {
    if (main) return;
    main = new Audio();
    next = new Audio();
    next.preload = 'auto';
    next.volume = 0;
    main.addEventListener('ended', () => {
      if (!active) return;
      failures = 0;
      if (n >= count) {
        halt();
        return;
      }
      n += 1;
      playCurrent();
    });
    main.addEventListener('error', () => fail(new Error('audio error')));
  };

  return {
    start(r, s, c) {
      if (!RECITER_RE.test(r) || /^\.+$/.test(r)) return;
      if (!Number.isInteger(s) || s < 1 || s > 114) return;
      if (!Number.isInteger(c) || c < 1 || c > 286) return;
      ensure();
      if (!main) return;
      reciter = r;
      surah = s;
      count = c;
      n = 1;
      failures = 0;
      failedAt = 0;
      active = true;
      main.volume = Math.min(1, Math.max(0, opts.volume / 100));
      playCurrent();
    },
    stop() {
      halt();
    },
    playing() {
      return active;
    },
  };
}

/**
 * Plays tilawah during its window (ends when the azan countdown starts). Mounted only inside Main,
 * so any prayer phase unmounts it and the cleanup stops the audio.
 */
export function useTilawah(view: KioskView, content: KioskContent | null, impl?: Player): void {
  const own = useRef<Player | null>(null);
  const settingsVolume = (view.settings as unknown as { tilawah?: { volume?: unknown } }).tilawah?.volume;
  const volume = typeof settingsVolume === 'number' ? settingsVolume : 60;

  const plan = useMemo(() => {
    // A preview is silent: audio elements cannot send the Bearer header anyway.
    if (!content || isPreview()) return null;
    const today = view.state.today;
    const days = today ? [today] : [];
    const month = tarawihMonthFor(view.now, days, view.settings) ?? view.hijri?.m;
    const win = tilawahWindow(view.now, days, view.settings, content.tilawah.slots, month);
    if (!win) return null;
    const av = content.tilawah.available[win.slot.surah];
    if (!av) return null;
    return { key: `${win.slot.id}|${win.startsAt.getTime()}`, reciter: av.reciter, surah: win.slot.surah, ayatCount: av.ayatCount };
  }, [view.now, view.state.today, view.settings, view.hijri, content]);

  const planRef = useRef(plan);
  planRef.current = plan;
  const key = plan ? plan.key : null;

  useEffect(() => {
    const p = planRef.current;
    if (key === null || !p) return undefined;
    let player = impl;
    if (!player) {
      own.current ??= createTilawahPlayer({ base: AUDIO_BASE, volume });
      player = own.current;
    }
    const target = player;
    target.start(p.reciter, p.surah, p.ayatCount);
    return () => target.stop();
  }, [key, impl, volume]);
}
