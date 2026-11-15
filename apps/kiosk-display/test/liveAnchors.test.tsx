import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/preact';
import { instantOf } from '@surau/core';
import { makeView } from './helpers.tsx';
import { useLiveAnchors } from '../src/live/liveMode.ts';

const TZ = 'Asia/Kuala_Lumpur';
const S = 1000;
const THU = '2026-11-05';
const FRI = '2026-11-06';
const viewAt = (date: string, hhmm: string, offsetMs = 0) =>
  makeView(date, hhmm, { at: new Date(instantOf(date, hhmm, TZ).getTime() + offsetMs) });

describe('useLiveAnchors: built once per day, not every second', () => {
  it('calls the builder once across many ticks, again when the day changes', () => {
    let calls = 0;
    const build = (): Date[] => {
      calls += 1;
      return [];
    };
    const first = viewAt(THU, '16:00');
    function Probe({ view }: { view: ReturnType<typeof viewAt> }) {
      useLiveAnchors(view.state, view.settings, build);
      return null;
    }
    const r = render(<Probe view={first} />);
    for (let s = 1; s <= 30; s++) {
      const tick = { ...viewAt(THU, '16:00', s * S) };
      r.rerender(<Probe view={{ ...tick, state: { ...tick.state, today: first.state.today }, settings: first.settings }} />);
    }
    expect(calls).toBe(1);
    const next = viewAt(FRI, '12:00');
    r.rerender(<Probe view={next} />);
    expect(calls).toBe(2);
  });
});
