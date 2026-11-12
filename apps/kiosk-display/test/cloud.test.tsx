import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/preact';
import { fetchCloud, isOffline, useCloudStatus } from '../src/data/cloud.ts';
import type { CloudStatus } from '../src/data/cloud.ts';

afterEach(cleanup);

const NOW = Date.parse('2026-11-09T10:00:00Z');
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();
const linked = (lastOkAt: string | null) => ({ linked: true, lastOkAt, cloudSyncEnabled: true });

describe('isOffline', () => {
  it('is false for an unlinked box, however old', () => {
    expect(isOffline({ linked: false, lastOkAt: null, cloudSyncEnabled: true }, NOW)).toBe(false);
    expect(isOffline({ linked: false, lastOkAt: ago(600), cloudSyncEnabled: true }, NOW)).toBe(false);
    expect(isOffline(null, NOW)).toBe(false);
  });
  it('is false with cloudSync switched off', () => {
    expect(isOffline({ linked: true, lastOkAt: ago(600), cloudSyncEnabled: false }, NOW)).toBe(false);
  });
  it('is false at 14 minutes and true at 16 for a linked box', () => {
    expect(isOffline(linked(ago(14)), NOW)).toBe(false);
    expect(isOffline(linked(ago(16)), NOW)).toBe(true);
  });
  it('is true for a linked box that never had an exchange, and for a garbled time', () => {
    expect(isOffline(linked(null), NOW)).toBe(true);
    expect(isOffline(linked('not a date'), NOW)).toBe(true);
  });
});

describe('cloud status', () => {
  it('fetchCloud maps the route answer', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ linked: true, lastOkAt: ago(1), cloudSyncEnabled: true })));
    expect(await fetchCloud(f as unknown as typeof fetch)).toEqual(linked(ago(1)));
    expect(f).toHaveBeenCalledWith('/api/kiosk/cloud', { credentials: 'same-origin', cache: 'no-store' });
    await expect(fetchCloud((async () => new Response('{}', { status: 500 })) as unknown as typeof fetch)).rejects.toThrow();
  });

  it('useCloudStatus reports offline for a stale linked box and not for a fresh one', async () => {
    const stale = (async () => new Response(JSON.stringify(linked(ago(30))))) as unknown as typeof fetch;
    let s: CloudStatus = { linked: false, lastOkAt: null, offline: false };
    function Probe(p: { f: typeof fetch }) {
      s = useCloudStatus({ fetchImpl: p.f, now: () => NOW });
      return <div />;
    }
    const r = render(<Probe f={stale} />);
    await waitFor(() => expect(s.offline).toBe(true));
    expect(s.linked).toBe(true);
    r.unmount();
    const fresh = (async () => new Response(JSON.stringify(linked(ago(2))))) as unknown as typeof fetch;
    render(<Probe f={fresh} />);
    await waitFor(() => expect(s.linked).toBe(true));
    expect(s.offline).toBe(false);
  });

  it('a failing poll leaves the badge hidden', async () => {
    const f = (async () => {
      throw new Error('net');
    }) as unknown as typeof fetch;
    let s: CloudStatus = { linked: false, lastOkAt: null, offline: false };
    function Probe() {
      s = useCloudStatus({ fetchImpl: f, now: () => NOW });
      return <div />;
    }
    render(<Probe />);
    await new Promise((res) => setTimeout(res, 20));
    expect(s.offline).toBe(false);
  });
});
