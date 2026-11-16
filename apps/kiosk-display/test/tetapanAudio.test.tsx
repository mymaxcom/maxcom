import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { klInstant } from '@surau/core';
import { days, makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';

const holder = vi.hoisted(() => ({ view: null as unknown as KioskView }));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));

import { App } from '../src/app.tsx';

function show(view: KioskView) {
  holder.view = view;
  return render(<App />);
}

let play: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  localStorage.clear();
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
});
afterEach(() => {
  cleanup();
  play.mockRestore();
});

const D = '2026-11-03';
const FILE = 'cd'.repeat(32);
// The azan countdown also starts at 05:38 on the fixture day (imsak and subuh are ten minutes apart): switch it off to hear the imsak beep alone.
const IMSAK_ON = { imsakBeep: { enabled: true }, azanCountdown: { enabled: false } };

describe('imsakBeep', () => {
  it('beeps once at imsak with the short tone, across the ticks of that second', () => {
    const v = makeView(D, '05:38', { settings: IMSAK_ON });
    expect(v.state.beep).toBe('imsak');
    const r = show(v);
    for (const ms of [300, 700]) {
      holder.view = { ...v, now: new Date(klInstant(D, '05:38').getTime() + ms) };
      r.rerender(<App />);
    }
    expect(play).toHaveBeenCalledTimes(1);
    const el = play.mock.instances[0] as HTMLAudioElement;
    expect(el.src).toMatch(/beep-short/);
    expect(el.volume).toBeCloseTo(0.7, 5);
  });

  it('beeps again the next day', () => {
    const r = show(makeView(D, '05:38', { settings: IMSAK_ON }));
    holder.view = makeView(D, '12:00', { settings: IMSAK_ON });
    r.rerender(<App />);
    holder.view = makeView('2026-11-04', '05:38', { settings: IMSAK_ON });
    r.rerender(<App />);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('is silent when switched off (the default), at the wrong time, or with the warning beeps off', () => {
    show(makeView(D, '05:38', { settings: { azanCountdown: { enabled: false } } }));
    cleanup();
    show(makeView(D, '05:40', { settings: IMSAK_ON }));
    cleanup();
    show(makeView(D, '05:38', { settings: { ...IMSAK_ON, beeps: { enabled: false } } }));
    expect(play).not.toHaveBeenCalled();
  });
});

describe('firstAzanSubuh', () => {
  const ON = { firstAzanSubuh: { enabled: true, minutesBefore: 15, audioFile: FILE } };

  it('plays the chosen file once at Subuh minus minutesBefore', () => {
    const v = makeView(D, '05:33', { settings: ON });
    expect(v.state.firstAzan).not.toBeNull();
    const r = show(v);
    for (const ms of [1000, 2000, 10000]) {
      holder.view = { ...v, now: new Date(klInstant(D, '05:33').getTime() + ms) };
      r.rerender(<App />);
    }
    expect(play).toHaveBeenCalledTimes(1);
    expect((play.mock.instances[0] as HTMLAudioElement).src).toMatch(new RegExp(`/assets/${FILE}$`));
  });

  it('does not play a minute early, or a minute late', () => {
    show(makeView(D, '05:32', { settings: ON }));
    cleanup();
    show(makeView(D, '05:34', { settings: ON }));
    expect(play).not.toHaveBeenCalled();
  });

  it('follows the warning beeps: silent with beeps.enabled off or volume 0', () => {
    show(makeView(D, '05:33', { settings: { ...ON, beeps: { enabled: false, volume: 70 } } }));
    cleanup();
    show(makeView(D, '05:33', { settings: { ...ON, beeps: { enabled: true, volume: 0 } } }));
    expect(play).not.toHaveBeenCalled();
  });

  it('a volume change reaches the azan that is playing, without playing it again', () => {
    const v = makeView(D, '05:33', { settings: ON });
    const r = show(v);
    const el = play.mock.instances[0] as HTMLAudioElement;
    expect(el.volume).toBeCloseTo(0.7, 5);
    holder.view = makeView(D, '05:34', { settings: { ...ON, beeps: { enabled: true, volume: 30 } } });
    r.rerender(<App />);
    expect(play).toHaveBeenCalledTimes(1);
    expect(el.volume).toBeCloseTo(0.3, 5);
  });

  it('stops at the azan countdown start at the latest, and when the beeps are switched off', async () => {
    // Let the previous test's unmount effects (deferred by preact) run before counting pauses.
    await new Promise((r) => setTimeout(r, 20));
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    try {
      const r = show(makeView(D, '05:33', { settings: ON }));
      expect(play).toHaveBeenCalledTimes(1);
      holder.view = makeView(D, '05:37:59', { settings: ON });
      r.rerender(<App />);
      expect(pause).not.toHaveBeenCalled();
      holder.view = makeView(D, '05:38', { settings: ON }); // Subuh 05:48, countdown 10 min
      r.rerender(<App />);
      expect(pause).toHaveBeenCalledTimes(1);
      cleanup();
      pause.mockClear();
      localStorage.clear();
      const r2 = show(makeView('2026-11-04', '05:33', { settings: ON }));
      // The countdown beep also played at 05:38: count only the azan file.
      expect((play.mock.instances as unknown[]).filter((e) => (e as HTMLAudioElement).src.endsWith(FILE)).length).toBe(2);
      holder.view = makeView('2026-11-04', '05:33:05', { settings: { ...ON, beeps: { enabled: false } } });
      r2.rerender(<App />);
      expect(pause).toHaveBeenCalledTimes(1);
    } finally {
      pause.mockRestore();
      load.mockRestore();
    }
  });

  it('does not play again after a reload inside the start window, and plays again the next day', () => {
    show(makeView(D, '05:33', { settings: ON }));
    expect(play).toHaveBeenCalledTimes(1);
    cleanup(); // the page reloads: a fresh App, same day, still inside the 30 s window
    show(makeView(D, '05:33:10', { settings: ON }));
    expect(play).toHaveBeenCalledTimes(1);
    cleanup();
    show(makeView('2026-11-04', '05:33', { settings: ON }));
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('plays even when the storage is blocked (once per page load then)', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      show(makeView(D, '05:33', { settings: ON }));
      expect(play).toHaveBeenCalledTimes(1);
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it('does nothing when switched off or with no file chosen (no error)', () => {
    show(makeView(D, '05:33', { settings: { firstAzanSubuh: { enabled: false, minutesBefore: 15, audioFile: FILE } } }));
    cleanup();
    show(makeView(D, '05:33', { settings: { firstAzanSubuh: { enabled: true, minutesBefore: 15, audioFile: null } } }));
    expect(play).not.toHaveBeenCalled();
  });
});

describe('syurukWarning.beep', () => {
  const sy = days.find((d) => d.date === D)!.times.syuruk;
  const [h, m] = sy.split(':').map(Number) as [number, number];
  const at = `${String(h).padStart(2, '0')}:${String(m - 5).padStart(2, '0')}`;
  const BEEP_ON = { syurukWarning: { beep: true } };

  it('one short beep when the warning starts, once that day', () => {
    const r = show(makeView(D, at, { settings: BEEP_ON }));
    for (const ms of [500, 1500, 2500, 60_000]) {
      holder.view = makeView(D, at, { settings: BEEP_ON, at: new Date(klInstant(D, at).getTime() + ms) });
      r.rerender(<App />);
    }
    expect(play).toHaveBeenCalledTimes(1);
    const el = play.mock.instances[0] as HTMLAudioElement;
    expect(el.src).toMatch(/beep-short/);
    expect(el.volume).toBeCloseTo(0.7, 5);
  });

  it('silent when off (the default) or with the warning beeps off', () => {
    show(makeView(D, at));
    cleanup();
    show(makeView(D, at, { settings: { ...BEEP_ON, beeps: { enabled: false } } }));
    expect(play).not.toHaveBeenCalled();
  });
});

describe('azanCountdown.fullScreen', () => {
  const NOON = '16:12';
  const full = (v: boolean) => makeView(D, NOON, { settings: { azanCountdown: { fullScreen: v } } });

  it('on (the default): the whole-screen version with the azan time and the compact strip', () => {
    const r = show(makeView(D, NOON));
    const stage = r.container.querySelector('.stage')!;
    expect(stage.getAttribute('data-azan-full')).toBe('true');
    expect(stage.getAttribute('data-screen')).toBe('azan');
    expect(r.container.querySelector('.screen--azanfull')).not.toBeNull();
    expect(r.getByText('Azan Asar dalam')).toBeTruthy();
    expect(r.getByText('Azan pada 4:20')).toBeTruthy();
    expect(r.container.querySelector('.phase__big')!.textContent).toBe('00:08:00');
    expect(r.container.querySelector('[data-role="prayers"].strip--compact')).not.toBeNull();
    expect(r.container.querySelector('.pbar')).toBeNull();
    expect(r.container.querySelectorAll('[data-prayer]').length).toBe(7);
    expect(r.container.querySelector('[data-layer="content"]')).toBeNull();
  });

  it('off: the phase screen as before, no whole-screen markers', () => {
    const r = show(full(false));
    const stage = r.container.querySelector('.stage')!;
    expect(stage.hasAttribute('data-azan-full')).toBe(false);
    expect(r.container.querySelector('.screen--azanfull')).toBeNull();
    expect(r.container.querySelector('.azanfull__at')).toBeNull();
    expect(r.container.querySelector('.pbar')).not.toBeNull();
    expect(r.getByText('Azan Asar dalam')).toBeTruthy();
    expect(r.container.querySelector('.phase__big')!.textContent).toBe('00:08:00');
  });

  it('only the azan countdown is affected: iqamah and the normal screen stay as they were', () => {
    const iq = show(makeView(D, '16:25'));
    expect(iq.container.querySelector('.stage')!.hasAttribute('data-azan-full')).toBe(false);
    expect(iq.container.querySelector('.pbar')).not.toBeNull();
    cleanup();
    const n = show(makeView(D, '15:52'));
    expect(n.container.querySelector('.stage')!.hasAttribute('data-azan-full')).toBe(false);
  });

  it('names Zohor time on a Friday (jumaat) and uses 24 h when the bar does', () => {
    const r = show(makeView('2026-11-06', '12:51', { settings: { prayerBar: { timeFormat: '24h' } } }));
    expect(r.container.querySelector('.azanfull__at')!.textContent).toMatch(/^Azan pada \d{2}:\d{2}$/);
  });

  it('English labels', () => {
    const r = show(makeView(D, NOON, { settings: { language: { lang: 'en' } } }));
    expect(r.getByText('Azan at 4:20')).toBeTruthy();
  });
});
