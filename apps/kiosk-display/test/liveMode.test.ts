import { describe, expect, it } from 'vitest';
import { instantOf } from '@surau/core';
import { makeView } from './helpers.tsx';
import type { ViewOpts } from './helpers.tsx';
import { LIVE_WINDOW_MS, inLiveWindow, liveAnchors, liveDisplayMode } from '../src/live/liveMode.ts';

// Fixture: 2026-11-05 (Khamis) Asar 16:20; default azan countdown 10 min, masuk waktu 60 s, iqamah 10 min
// (iqamah time 16:30), solat screen 15 min. 2026-11-06 is a Friday: Zohor (Jumaat) 13:00, masuk waktu to 13:01,
// khutbah 20 min to 13:21, Jumaat iqamah 7 min to 13:28 (the iqamah time), Jumaat solat 15 min.
const TZ = 'Asia/Kuala_Lumpur';
const S = 1000;
const M = 60 * S;

/** The view at `hhmm` plus `offsetMs` on `date`. */
function viewAt(date: string, hhmm: string, offsetMs = 0, opts: ViewOpts = {}) {
  return makeView(date, hhmm, { ...opts, at: new Date(instantOf(date, hhmm, TZ).getTime() + offsetMs) });
}
function modeAt(date: string, hhmm: string, offsetMs = 0, opts: ViewOpts = {}, onAir = true) {
  const v = viewAt(date, hhmm, offsetMs, opts);
  return { mode: liveDisplayMode(v.now, v.state, v.settings, onAir), phase: v.state.phase };
}
const THU = '2026-11-05';
const FRI = '2026-11-06';

describe('liveDisplayMode: no live', () => {
  it('is none whatever the phase', () => {
    for (const [hhmm, off] of [['15:00', 0], ['16:19', 30 * S], ['16:20', 0], ['16:30', 0], ['16:40', 0]] as const) {
      expect(modeAt(THU, hhmm, off, {}, false).mode, hhmm).toBe('none');
    }
  });
});

describe('liveDisplayMode: the azan window (Asar 16:20)', () => {
  it('the rest of the azan countdown is clear (the live has priority)', () => {
    expect(modeAt(THU, '16:12')).toEqual({ mode: 'clear', phase: 'azanCountdown' });
    expect(modeAt(THU, '16:19', -1 * S)).toEqual({ mode: 'clear', phase: 'azanCountdown' });
  });
  it('azan - 1:00 exactly is blurred, under the azan countdown', () => {
    expect(modeAt(THU, '16:19')).toEqual({ mode: 'blurred', phase: 'azanCountdown' });
    expect(modeAt(THU, '16:19', 59 * S)).toEqual({ mode: 'blurred', phase: 'azanCountdown' });
  });
  it('the azan time itself is blurred under masuk waktu, up to azan + 0:59', () => {
    expect(modeAt(THU, '16:20')).toEqual({ mode: 'blurred', phase: 'masukWaktu' });
    expect(modeAt(THU, '16:20', 59 * S)).toEqual({ mode: 'blurred', phase: 'masukWaktu' });
  });
  it('azan + 1:00 is clear again (the iqamah countdown runs behind the live)', () => {
    expect(modeAt(THU, '16:21')).toEqual({ mode: 'clear', phase: 'iqamah' });
    expect(modeAt(THU, '16:25')).toEqual({ mode: 'clear', phase: 'iqamah' });
  });
});

describe('liveDisplayMode: the iqamah window (iqamah time 16:30)', () => {
  it('iqamah - 1:01 is clear, iqamah - 1:00 is blurred under the iqamah countdown', () => {
    expect(modeAt(THU, '16:29', -1 * S)).toEqual({ mode: 'clear', phase: 'iqamah' });
    expect(modeAt(THU, '16:29')).toEqual({ mode: 'blurred', phase: 'iqamah' });
  });
  it('the iqamah time is blurred under the solat screen, up to iqamah + 0:59', () => {
    expect(modeAt(THU, '16:30')).toEqual({ mode: 'blurred', phase: 'solat' });
    expect(modeAt(THU, '16:30', 59 * S)).toEqual({ mode: 'blurred', phase: 'solat' });
  });
  it('iqamah + 1:00 is clear: the rest of the solat screen is behind the live', () => {
    expect(modeAt(THU, '16:31')).toEqual({ mode: 'clear', phase: 'solat' });
    expect(modeAt(THU, '16:40')).toEqual({ mode: 'clear', phase: 'solat' });
  });
  it('follows the configured iqamah minutes for the day (Khamis Asar 15 min: iqamah time 16:35)', () => {
    const opts: ViewOpts = { settings: { iqamahCountdown: { minutes: { khamis: { asar: 15 } } } as never } };
    const v = viewAt(THU, '16:25', 0, opts);
    expect(v.state.phase).toBe('iqamah');
    expect(v.state.phaseEndsAt!.getTime()).toBe(instantOf(THU, '16:35', TZ).getTime());
    expect(modeAt(THU, '16:29', 30 * S, opts)).toEqual({ mode: 'clear', phase: 'iqamah' });
    expect(modeAt(THU, '16:33', 59 * S, opts)).toEqual({ mode: 'clear', phase: 'iqamah' });
    expect(modeAt(THU, '16:34', 0, opts)).toEqual({ mode: 'blurred', phase: 'iqamah' });
    expect(modeAt(THU, '16:35', 30 * S, opts)).toEqual({ mode: 'blurred', phase: 'solat' });
    expect(modeAt(THU, '16:36', 0, opts)).toEqual({ mode: 'clear', phase: 'solat' });
  });
});

describe('liveDisplayMode: iqamah disabled', () => {
  const opts: ViewOpts = { settings: { iqamahCountdown: { enabled: false } } };
  it('only the azan window applies', () => {
    expect(modeAt(THU, '16:19', 30 * S, opts).mode).toBe('blurred');
    expect(modeAt(THU, '16:20', 30 * S, opts).mode).toBe('blurred');
    // the solat screen follows masuk waktu straight away; no iqamah time, so it is behind the live
    expect(modeAt(THU, '16:21', 0, opts)).toEqual({ mode: 'clear', phase: 'solat' });
    expect(modeAt(THU, '16:29', 30 * S, opts)).toEqual({ mode: 'clear', phase: 'solat' });
    expect(modeAt(THU, '16:30', 30 * S, opts)).toEqual({ mode: 'clear', phase: 'solat' });
  });
  it('has no iqamah anchor', () => {
    const v = viewAt(THU, '16:00', 0, opts);
    expect(liveAnchors(v.state, v.settings)).toHaveLength(5);
  });
});

describe('liveDisplayMode: Friday (Jumaat 13:00, iqamah time 13:28)', () => {
  it('blurred around the azan', () => {
    expect(modeAt(FRI, '12:58', 59 * S)).toEqual({ mode: 'clear', phase: 'azanCountdown' });
    expect(modeAt(FRI, '12:59')).toEqual({ mode: 'blurred', phase: 'azanCountdown' });
    expect(modeAt(FRI, '13:00', 30 * S)).toEqual({ mode: 'blurred', phase: 'masukWaktu' });
  });
  it('the khutbah is behind the live', () => {
    expect(modeAt(FRI, '13:01')).toEqual({ mode: 'clear', phase: 'khutbah' });
    expect(modeAt(FRI, '13:20', 59 * S)).toEqual({ mode: 'clear', phase: 'khutbah' });
  });
  it('blurred 1 min either side of the Jumaat iqamah time', () => {
    expect(modeAt(FRI, '13:26', 59 * S)).toEqual({ mode: 'clear', phase: 'iqamah' });
    expect(modeAt(FRI, '13:27')).toEqual({ mode: 'blurred', phase: 'iqamah' });
    expect(modeAt(FRI, '13:28')).toEqual({ mode: 'blurred', phase: 'solat' });
    expect(modeAt(FRI, '13:28', 59 * S)).toEqual({ mode: 'blurred', phase: 'solat' });
    expect(modeAt(FRI, '13:29')).toEqual({ mode: 'clear', phase: 'solat' });
  });
  it('the Friday anchors are the azan times and the iqamah ends of the phase machine', () => {
    const v = viewAt(FRI, '10:00');
    const a = liveAnchors(v.state, v.settings).map((d) => d.getTime());
    expect(a).toContain(instantOf(FRI, '13:00', TZ).getTime());
    expect(a).toContain(instantOf(FRI, '13:28', TZ).getTime());
    expect(a).not.toContain(instantOf(FRI, '13:10', TZ).getTime());
  });
});

describe('liveDisplayMode: a window with no prayer screen up', () => {
  it('azan countdown off: azan - 0:30 is the normal phase, so the live stays clear', () => {
    const opts: ViewOpts = { settings: { azanCountdown: { enabled: false } } };
    expect(modeAt(THU, '16:19', 30 * S, opts)).toEqual({ mode: 'clear', phase: 'normal' });
    expect(modeAt(THU, '16:20', 30 * S, opts)).toEqual({ mode: 'blurred', phase: 'masukWaktu' });
  });
  it('the normal phase, syuruk and the no-data screen are clear', () => {
    expect(modeAt(THU, '15:00')).toEqual({ mode: 'clear', phase: 'normal' });
    expect(modeAt(THU, '06:52')).toEqual({ mode: 'clear', phase: 'syuruk' });
    const nodata = makeView(THU, '15:00', { days: [] });
    expect(liveDisplayMode(nodata.now, nodata.state, nodata.settings, true)).toBe('clear');
    expect(liveAnchors(nodata.state, nodata.settings)).toEqual([]);
  });
});

describe('inLiveWindow', () => {
  const a = new Date('2026-11-05T08:20:00Z');
  it('starts exactly 1 min before and ends (exclusive) exactly 1 min after', () => {
    expect(LIVE_WINDOW_MS).toBe(M);
    expect(inLiveWindow(new Date(a.getTime() - M - 1), [a])).toBe(false);
    expect(inLiveWindow(new Date(a.getTime() - M), [a])).toBe(true);
    expect(inLiveWindow(a, [a])).toBe(true);
    expect(inLiveWindow(new Date(a.getTime() + M - 1), [a])).toBe(true);
    expect(inLiveWindow(new Date(a.getTime() + M), [a])).toBe(false);
    expect(inLiveWindow(a, [])).toBe(false);
  });
});
