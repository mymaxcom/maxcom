import { describe, expect, it } from 'vitest';
import { makeView } from './helpers.tsx';
import { visibleNextOf } from '../src/ui/visibleNext.ts';

describe('visibleNextOf: what the TV names as next', () => {
  it('is the state next when it is shown', () => {
    const v = makeView('2026-11-03', '15:52');
    expect(visibleNextOf(v.state, v.settings, v.now, v.tz)).toEqual(v.state.next);
  });
  it('skips a hidden Syuruk to Zohor, at Zohor today', () => {
    const v = makeView('2026-11-03', '06:30', { settings: { prayerBar: { showSyuruk: false } } });
    expect(v.state.next!.name).toBe('syuruk');
    const n = visibleNextOf(v.state, v.settings, v.now, v.tz)!;
    expect(n.name).toBe('zohor');
    expect(n.at.getTime() - v.now.getTime()).toBe((6 * 60 + 30) * 60_000);
  });
  it('skips a hidden Imsak after Isyak to Subuh, a day later', () => {
    const v = makeView('2026-11-03', '21:30', { settings: { prayerBar: { showImsak: false } } });
    expect(v.state.next!.name).toBe('imsak');
    const n = visibleNextOf(v.state, v.settings, v.now, v.tz)!;
    expect(n.name).toBe('subuh');
    expect(n.at.getTime() - v.now.getTime()).toBe((8 * 60 + 18) * 60_000);
  });
  it('names Friday Zohor Jumaat when it stands in for a hidden Syuruk', () => {
    const v = makeView('2026-11-06', '06:30', { settings: { prayerBar: { showSyuruk: false } } });
    expect(visibleNextOf(v.state, v.settings, v.now, v.tz)!.name).toBe('jumaat');
  });
});
