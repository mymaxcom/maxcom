import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/preact';
import { fetchBoxState, pollIntervalFor, useBoxState } from '../src/data/boxState.ts';
import type { BoxStateResult } from '../src/data/boxState.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const view = (state: string, extra: object = {}) => ({ boxId: '0123456789abcdef', keyFp: 'f', name: 'MAXCOM X', state, reason: 'none', ...extra });
const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status });

describe('box state poll', () => {
  it('polls every 5 s unless the box is active (60 s)', () => {
    expect(pollIntervalFor('setup')).toBe(5000);
    expect(pollIntervalFor('recovery')).toBe(5000);
    expect(pollIntervalFor('locked')).toBe(5000);
    expect(pollIntervalFor(undefined)).toBe(5000);
    expect(pollIntervalFor('active')).toBe(60000);
  });

  it('fetchBoxState reads the route and refuses a malformed answer', async () => {
    const f = vi.fn(async () => json(view('setup')));
    expect((await fetchBoxState(f as unknown as typeof fetch)).state).toBe('setup');
    expect(f).toHaveBeenCalledWith('/api/box/state', { credentials: 'same-origin', cache: 'no-store' });
    await expect(fetchBoxState((async () => json({ state: 'setup' })) as unknown as typeof fetch)).rejects.toThrow();
    await expect(fetchBoxState((async () => json(view('weird'))) as unknown as typeof fetch)).rejects.toThrow();
    await expect(fetchBoxState((async () => json({}, 500)) as unknown as typeof fetch)).rejects.toThrow('HTTP 500');
  });

  it('keeps the previous view when a poll fails, and recovers on the next good one', async () => {
    const answers: (Response | Error)[] = [json(view('setup', { qr: { payload: 'maxcom1:x', expiresAt: 'e' } })), json({}, 500), new Error('net'), json(view('active'))];
    let n = 0;
    const f = (async () => {
      const a = answers[Math.min(n++, answers.length - 1)]!;
      if (a instanceof Error) throw a;
      return a.clone();
    }) as unknown as typeof fetch;
    const history: BoxStateResult[] = [];
    function Probe() {
      const r = useBoxState({ fetchImpl: f, intervalMs: () => 5 });
      history.push(r);
      return <div />;
    }
    render(<Probe />);
    await waitFor(() => expect(history.at(-1)?.view?.state).toBe('active'));
    const seen = history.map((h) => `${h.view?.state ?? 'none'}${h.error !== null ? '!' : ''}`);
    // setup, then (a failed poll: still setup, with an error), then active with no error
    expect(seen).toContain('setup');
    expect(seen).toContain('setup!');
    expect(seen.indexOf('setup!')).toBeGreaterThan(seen.indexOf('setup'));
    expect(seen.at(-1)).toBe('active');
    expect(seen.some((x) => x === 'none!')).toBe(false);
  });

  it('stops polling when unmounted', async () => {
    const f = vi.fn(async () => json(view('setup')));
    function Probe() {
      useBoxState({ fetchImpl: f as unknown as typeof fetch, intervalMs: () => 5 });
      return <div />;
    }
    const r = render(<Probe />);
    await waitFor(() => expect(f.mock.calls.length).toBeGreaterThan(1));
    await act(async () => r.unmount());
    const after = f.mock.calls.length;
    await new Promise((res) => setTimeout(res, 40));
    expect(f.mock.calls.length).toBe(after);
  });
});
