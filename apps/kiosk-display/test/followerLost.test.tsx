import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, renderHook } from '@testing-library/preact';
import { MASTER_LOST_MS, masterLostSince, parseLink, useMasterLostSince } from '../src/data/linkState.ts';
import { FollowerMarks } from '../src/screens/Link.tsx';

/**
 * O23 (2026.11.15): a follower whose main box has not answered for 6 hours shows a small corner notice
 * "Tidak dapat menghubungi MAXCOM utama sejak <masa>" in the TV language; the content keeps playing. The time comes from
 * the link answer's `masterUnreachableSince` when the box sends it, else from the box state's `awayMinutes`.
 */
afterEach(cleanup);

const NOW = Date.parse('2026-11-24T10:00:00Z'); // 18:00 in Kuala Lumpur
const follower = (awayMinutes: number) => ({ mode: 'follower', master: { name: 'Surau Al-Hidayah' }, connected: false, awayMinutes, needsUpdate: false }) as never;
const info = { follower: true, masterName: 'Surau Al-Hidayah', away: true, needsUpdate: false };

describe('when the main box counts as lost', () => {
  it('6 hours is the line', () => {
    expect(MASTER_LOST_MS).toBe(6 * 60 * 60_000);
  });

  it('from the box state: 6 hours or more of awayMinutes, the time it was last reached', () => {
    expect(masterLostSince(follower(359), null, NOW)).toBeNull();
    expect(masterLostSince(follower(360), null, NOW)).toBe('2026-11-24T04:00:00.000Z');
    expect(masterLostSince(follower(600), null, NOW)).toBe('2026-11-24T00:00:00.000Z');
  });

  it('the link answer wins when it names the time (lane M field), and is read defensively', () => {
    const link = parseLink({ mode: 'follower', masterUnreachableSince: '2026-11-23T20:30:00Z' });
    expect(link.masterUnreachableSince).toBe('2026-11-23T20:30:00Z');
    expect(masterLostSince(follower(5), link, NOW)).toBe('2026-11-23T20:30:00.000Z');
    // less than 6 hours ago: no notice yet
    expect(masterLostSince(follower(5), parseLink({ mode: 'follower', masterUnreachableSince: '2026-11-24T06:00:00Z' }), NOW)).toBeNull();
    expect(parseLink({ masterUnreachableSince: 'yesterday' }).masterUnreachableSince).toBeNull();
    expect(parseLink({ masterUnreachableSince: 7 }).masterUnreachableSince).toBeNull();
    expect(parseLink({}).masterUnreachableSince).toBeNull();
  });

  it('never on a box that is not a follower', () => {
    expect(masterLostSince({ mode: 'main', awayMinutes: 900 } as never, null, NOW)).toBeNull();
    expect(masterLostSince(null, null, NOW)).toBeNull();
    expect(masterLostSince({ mode: 'follower', awayMinutes: 'x' } as never, null, NOW)).toBeNull();
  });
});

describe('F17: the notice time is fixed once (no minute-to-minute wobble)', () => {
  type P = { box: unknown; link: ReturnType<typeof parseLink> | null; now: number };
  const hook = (p: P) => renderHook((q: P) => useMasterLostSince(q.box as never, q.link, q.now), { initialProps: p });

  it('from awayMinutes: the first instant computed stays while the box stays away', () => {
    const h = hook({ box: follower(360), link: null, now: NOW });
    expect(h.result.current).toBe('2026-11-24T04:00:00.000Z');
    // 30 s later the box still says 360 (whole minutes): a fresh count would read 04:00:30
    h.rerender({ box: follower(360), link: null, now: NOW + 30_000 });
    expect(h.result.current).toBe('2026-11-24T04:00:00.000Z');
    h.rerender({ box: follower(361), link: null, now: NOW + 90_000 });
    expect(h.result.current).toBe('2026-11-24T04:00:00.000Z');
  });

  it('the main box answering again clears it; a new absence latches its own time', () => {
    const h = hook({ box: follower(360), link: null, now: NOW });
    h.rerender({ box: follower(0), link: null, now: NOW + 60_000 });
    expect(h.result.current).toBeNull();
    h.rerender({ box: follower(400), link: null, now: NOW + 120_000 });
    expect(h.result.current).toBe('2026-11-24T03:22:00.000Z');
  });

  it('the link answer names the time itself and wins over a latched count', () => {
    const h = hook({ box: follower(360), link: null, now: NOW });
    const link = parseLink({ mode: 'follower', masterUnreachableSince: '2026-11-23T20:30:00Z' });
    h.rerender({ box: follower(360), link, now: NOW + 30_000 });
    expect(h.result.current).toBe('2026-11-23T20:30:00.000Z');
  });
});

describe('the corner notice', () => {
  const show = (lang: 'ms' | 'en' | 'ar', since: string, timeFormat: '12h' | '24h' = '12h') =>
    render(<FollowerMarks info={info} lang={lang} lostSince={since} timeFormat={timeFormat} tz="Asia/Kuala_Lumpur" nowMs={NOW} />);

  it('BM, the same day: the time only, in place of the short away mark', () => {
    const r = show('ms', '2026-11-24T04:00:00.000Z');
    const mark = r.container.querySelector('[data-mark="lost"]')!;
    expect(mark.textContent).toBe('Tidak dapat menghubungi MAXCOM utama sejak 12:00 PTG');
    expect(r.container.querySelector('[data-mark="away"]')).toBeNull();
  });

  it('an earlier day names the day and month too', () => {
    const r = show('ms', '2026-11-23T00:30:00.000Z', '24h');
    expect(r.container.querySelector('[data-mark="lost"]')!.textContent).toBe('Tidak dapat menghubungi MAXCOM utama sejak Isn 23 Nov, 08:30');
  });

  it('English and Arabic', () => {
    const en = show('en', '2026-11-24T04:00:00.000Z');
    expect(en.container.querySelector('[data-mark="lost"]')!.textContent).toBe('Cannot reach the main MAXCOM since 12:00 PM');
    cleanup();
    const ar = show('ar', '2026-11-24T04:00:00.000Z');
    const mark = ar.container.querySelector('[data-mark="lost"]')!;
    expect(mark.textContent).toContain('تعذر الاتصال بـ MAXCOM الرئيسي منذ');
    expect(mark.textContent).toContain('12:00 م');
    expect(ar.getByTestId('follower-marks').getAttribute('dir')).toBe('rtl');
  });

  it('without a lost time the marks are as before', () => {
    const r = render(<FollowerMarks info={info} lang="ms" />);
    expect(r.container.querySelector('[data-mark="away"]')).toBeTruthy();
    expect(r.container.querySelector('[data-mark="lost"]')).toBeNull();
  });
});
