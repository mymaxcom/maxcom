import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/preact';
import { beginPairing, pollPairing, useNotPaired, usePairing } from '../src/data/pairing.ts';
import { setNotPaired } from '../src/data/bundle.ts';

const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status });

afterEach(() => {
  cleanup();
  setNotPaired(false);
  vi.useRealTimers();
});

describe('pairing client', () => {
  it('beginPairing posts with same-origin credentials and returns the code', async () => {
    const f = vi.fn(async () => json({ code: '123456', pollToken: 'tok', expiresAt: 'x' }));
    const r = await beginPairing(f as unknown as typeof fetch);
    expect(r.code).toBe('123456');
    expect(f).toHaveBeenCalledWith('/api/kiosk/pair/begin', { method: 'POST', credentials: 'same-origin' });
  });

  it('beginPairing surfaces 429 as an error with status', async () => {
    const f = (async () => json({ errors: ['x'] }, 429)) as unknown as typeof fetch;
    await expect(beginPairing(f)).rejects.toMatchObject({ status: 429 });
  });

  it('pollPairing maps pending / approved / gone', async () => {
    const mk = (res: Response) => (async () => res) as unknown as typeof fetch;
    expect(await pollPairing('t', mk(json({ status: 'pending' })))).toBe('pending');
    expect(await pollPairing('t', mk(json({ status: 'approved' })))).toBe('approved');
    expect(await pollPairing('t', mk(json({ errors: [] }, 404)))).toBe('gone');
  });

  it('usePairing shows the code, polls, restarts when gone, then reports paired', async () => {
    let begins = 0;
    const polls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/begin')) {
        begins++;
        return json({ code: begins === 1 ? '111111' : '222222', pollToken: `tok${begins}`, expiresAt: 'e' });
      }
      const tok = (JSON.parse(String(init?.body)) as { pollToken: string }).pollToken;
      polls.push(tok);
      if (tok === 'tok1') return json({ errors: [] }, 404);
      return json({ status: polls.length > 2 ? 'approved' : 'pending' });
    }) as unknown as typeof fetch;
    let latest: ReturnType<typeof usePairing> | null = null;
    function Probe() {
      latest = usePairing({ fetchImpl: f, pollMs: 5, retryMs: 5 });
      return <div>{latest.code}</div>;
    }
    render(<Probe />);
    await waitFor(() => expect(latest?.code).toBe('111111'));
    await waitFor(() => expect(latest?.code).toBe('222222'));
    await waitFor(() => expect(latest?.paired).toBe(true));
  });

  it('useNotPaired follows the flag', async () => {
    let v = false;
    function Probe() {
      v = useNotPaired();
      return <div />;
    }
    render(<Probe />);
    expect(v).toBe(false);
    await act(async () => setNotPaired(true));
    expect(v).toBe(true);
  });
});
