import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';
import { captureHostBridge, exitToHost, parseHostHash, resetHostBridgeForTest } from '../src/data/hostExit.ts';

const holder = vi.hoisted(() => ({ view: null as unknown as KioskView, box: null as Record<string, unknown> | null }));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));
vi.mock('../src/data/boxState.ts', async (orig) => ({
  ...(await orig<typeof import('../src/data/boxState.ts')>()),
  useBoxState: () => ({ view: holder.box, error: null }),
}));

import { App } from '../src/app.tsx';
import { HostExit } from '../src/ui/HostExit.tsx';

const TOKEN = 'ab'.repeat(32);

beforeEach(() => {
  resetHostBridgeForTest();
  holder.view = makeView('2026-11-03', '15:52');
  holder.box = null;
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { MaxcomHost?: unknown }).MaxcomHost;
});

describe('parseHostHash', () => {
  it('accepts a port in range with a 64-hex token', () => {
    expect(parseHostHash(`#mxhost=51234.${TOKEN}`)).toEqual({ port: 51234, token: TOKEN });
    expect(parseHostHash(`#mxhost=1024.${TOKEN}`)?.port).toBe(1024);
    expect(parseHostHash(`#mxhost=65535.${TOKEN}`)?.port).toBe(65535);
  });
  it('ignores a bad port or token', () => {
    expect(parseHostHash(`#mxhost=1023.${TOKEN}`)).toBeNull();
    expect(parseHostHash(`#mxhost=65536.${TOKEN}`)).toBeNull();
    expect(parseHostHash(`#mxhost=80.${TOKEN}`)).toBeNull();
    expect(parseHostHash(`#mxhost=51234.${TOKEN.slice(1)}`)).toBeNull();
    expect(parseHostHash(`#mxhost=51234.${TOKEN}0`)).toBeNull();
    expect(parseHostHash(`#mxhost=51234.${'zz'.repeat(32)}`)).toBeNull();
    expect(parseHostHash('#other')).toBeNull();
    expect(parseHostHash('')).toBeNull();
  });
});

describe('captureHostBridge', () => {
  it('keeps the target, stores it for reloads and removes the hash', () => {
    window.history.replaceState(null, '', `/?x=1#mxhost=51234.${TOKEN}`);
    expect(captureHostBridge()).toEqual({ port: 51234, token: TOKEN });
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?x=1');
    resetHostBridgeForTest();
    expect(captureHostBridge()).toEqual({ port: 51234, token: TOKEN });
  });
  it('ignores a bad hash but still removes it', () => {
    window.history.replaceState(null, '', `/#mxhost=80.${TOKEN}`);
    expect(captureHostBridge()).toBeNull();
    expect(window.location.hash).toBe('');
  });
});

describe('exitToHost', () => {
  it('prefers the Android bridge', async () => {
    const exit = vi.fn();
    const f = vi.fn();
    expect(await exitToHost({ MaxcomHost: { exit } }, f as unknown as typeof fetch)).toBe('android');
    expect(exit).toHaveBeenCalledOnce();
    expect(f).not.toHaveBeenCalled();
  });
  it('posts the token to the loopback listener', async () => {
    window.history.replaceState(null, '', `/#mxhost=51234.${TOKEN}`);
    captureHostBridge();
    const f = vi.fn().mockResolvedValue(new Response(null));
    expect(await exitToHost({}, f as unknown as typeof fetch)).toBe('windows');
    expect(f).toHaveBeenCalledWith('http://127.0.0.1:51234/exit', { method: 'POST', body: TOKEN, mode: 'no-cors', cache: 'no-store' });
  });
  it('does nothing without a bridge, and survives a failing fetch', async () => {
    const f = vi.fn();
    expect(await exitToHost({}, f as unknown as typeof fetch)).toBe('none');
    expect(f).not.toHaveBeenCalled();
    window.history.replaceState(null, '', `/#mxhost=51234.${TOKEN}`);
    captureHostBridge();
    expect(await exitToHost({}, (() => Promise.reject(new Error('down'))) as typeof fetch)).toBe('none');
  });
});

describe('HostExit on the kiosk', () => {
  it('shows on the normal kiosk and double-click calls the Android bridge', () => {
    const exit = vi.fn();
    (window as unknown as { MaxcomHost: unknown }).MaxcomHost = { exit };
    const r = render(<App />);
    const logo = r.getByTestId('host-exit');
    fireEvent.click(logo);
    expect(exit).not.toHaveBeenCalled();
    fireEvent.dblClick(logo);
    expect(exit).toHaveBeenCalledOnce();
  });
  it('double-click posts to the Windows helper read from the hash', () => {
    const f = vi.fn().mockResolvedValue(new Response(null));
    vi.stubGlobal('fetch', f);
    window.history.replaceState(null, '', `/#mxhost=51234.${TOKEN}`);
    const r = render(<App />);
    expect(window.location.hash).toBe('');
    fireEvent.dblClick(r.getByTestId('host-exit'));
    const call = f.mock.calls.find((c) => String(c[0]).startsWith('http://127.0.0.1:51234/exit'));
    expect(call?.[1]).toMatchObject({ method: 'POST', body: TOKEN });
  });
  it('is hidden in the admin preview', () => {
    window.history.replaceState(null, '', '/?preview=1');
    const r = render(<App />);
    expect(r.queryByTestId('host-exit')).toBeNull();
  });
  it('is hidden on a stopped box', () => {
    holder.box = { state: 'locked', boxId: 'ABC' };
    const r = render(<App />);
    expect(r.queryByTestId('host-exit')).toBeNull();
  });
});

describe('HostExit pulse timer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it('pulses for 600 ms after a double-click', () => {
    vi.useFakeTimers();
    const r = render(<HostExit />);
    const logo = r.getByTestId('host-exit');
    fireEvent.dblClick(logo);
    expect(logo.getAttribute('data-pulse')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(599);
    });
    expect(logo.getAttribute('data-pulse')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(logo.getAttribute('data-pulse')).toBe('false');
  });
  it('clears the pulse timer on unmount (no state update after it is gone)', () => {
    vi.useFakeTimers();
    const r = render(<HostExit />);
    // let preact run the mount effect (it waits for the next frame), so its cleanup is registered
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.dblClick(r.getByTestId('host-exit'));
    fireEvent.dblClick(r.getByTestId('host-exit'));
    expect(vi.getTimerCount(), 'one pulse timer at a time').toBe(1);
    const set = vi.spyOn(globalThis, 'setTimeout');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    fireEvent.dblClick(r.getByTestId('host-exit'));
    const pulseCall = set.mock.calls.findIndex((c) => c[1] === 600);
    expect(pulseCall).toBeGreaterThanOrEqual(0);
    const pulseId = set.mock.results[pulseCall]!.value as unknown;
    clear.mockClear();
    act(() => r.unmount());
    expect(clear.mock.calls.some((c) => c[0] === pulseId), 'the pulse timer is cleared on unmount').toBe(true);
  });
});
