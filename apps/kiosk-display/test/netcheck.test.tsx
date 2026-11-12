import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import type { BoxStateView, NetCheckView } from '@surau/core';
import { makeView } from './helpers.tsx';
import { boxView, qrPayload } from './boxFixture.ts';
import type { KioskView } from '../src/data/kiosk.ts';

const holder = vi.hoisted(() => ({
  view: null as unknown as KioskView,
  box: null as BoxStateView | null,
}));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));
vi.mock('../src/data/boxState.ts', async (orig) => ({
  ...(await orig<typeof import('../src/data/boxState.ts')>()),
  useBoxState: () => ({ view: holder.box, error: null }),
}));

import { App } from '../src/app.tsx';
import { NetCheck, classifyInterfaces } from '../src/screens/NetCheck.tsx';

const PROBE_EXPIRES = '2026-11-03T08:01:41Z';
const netFixture = (over: Partial<NetCheckView> = {}): NetCheckView => ({
  interfaces: [{ name: 'Ethernet', address: '10.168.1.20', up: true }],
  https: { listening: true, port: 8443 },
  linked: false,
  lastPull: null,
  lastPhoneSeenAt: null,
  probe: { payload: qrPayload({ type: 'probe' }), expiresAt: PROBE_EXPIRES },
  ...over,
});

let answers: (() => Response)[];
let calls: number;
function stubNet(...a: (() => Response)[]): void {
  answers = a;
  calls = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    if (String(input) !== '/api/box/netcheck') return new Response('{}', { status: 404 });
    const fn = answers[Math.min(calls, answers.length - 1)]!;
    calls++;
    return fn();
  });
}
const ok = (v: NetCheckView) => () => new Response(JSON.stringify(v), { status: 200 });
const key = (k: string, type: 'keydown' | 'keyup' = 'keydown') => window.dispatchEvent(new KeyboardEvent(type, { key: k }));
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
const settings = makeView('2026-11-03', '15:52').settings;
async function open(props: Partial<Parameters<typeof NetCheck>[0]> = {}) {
  const onClose = vi.fn();
  const r = render(<NetCheck lang="ms" settings={settings} boxState="active" keyFp="" onClose={onClose} {...props} />);
  await flush();
  return { r, onClose };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-03T07:52:00Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('NetCheck rows', () => {
  it('renders the interfaces, server, phone and cloud from the box', async () => {
    stubNet(ok(netFixture({
      linked: true,
      lastPull: '2026-11-03T07:48:00Z',
      lastPhoneSeenAt: '2026-11-03T07:51:00Z',
    })));
    const { r } = await open();
    expect(r.getByText('Disambung, 10.168.1.20')).toBeTruthy();
    expect(r.getByText('Tidak digunakan')).toBeTruthy(); // Wi-Fi
    expect(r.getByText('Berjalan di https://10.168.1.20:8443')).toBeTruthy();
    expect(r.getByText('Telefon sampai ke MAXCOM ini pada 3:51 PTG')).toBeTruthy();
    expect(r.getByText('Dipautkan, Diselaraskan 3:48 PTG')).toBeTruthy();
    expect(r.getByText('Telefon boleh sampai ke MAXCOM ini')).toBeTruthy();
    expect(r.queryByText(/pengasingan pelanggan/)).toBeNull();
  });

  it('explains client isolation when no phone was seen', async () => {
    stubNet(ok(netFixture()));
    const { r } = await open();
    expect(r.getByText('Tiada telefon sampai dalam 10 minit terakhir')).toBeTruthy();
    expect(r.getByText(/pengasingan pelanggan/)).toBeTruthy();
    expect(r.getByText('Tidak dipautkan')).toBeTruthy();
    expect(r.getByText(/tiada jalan lain selain rangkaian yang sama/)).toBeTruthy();
  });

  it('says when HTTPS is not running', async () => {
    stubNet(ok(netFixture({ https: { listening: false, port: null } })));
    const { r } = await open();
    expect(r.getByText('HTTPS tidak aktif')).toBeTruthy();
  });

  it('shows the Internet row only during setup', async () => {
    stubNet(ok(netFixture()));
    const a = await open({ boxState: 'setup' });
    expect(a.r.getByText('Tidak perlu untuk persediaan')).toBeTruthy();
    cleanup();
    const b = await open({ boxState: 'active' });
    expect(b.r.queryByText('Internet')).toBeNull();
  });

  it('draws the probe QR', async () => {
    stubNet(ok(netFixture()));
    const { r } = await open();
    expect(r.getByTestId('qr')).toBeTruthy();
    expect(r.getByText('Uji sambungan dari telefon')).toBeTruthy();
  });

  it('says so on a screen the box does not answer (404 on a paired display)', async () => {
    stubNet(() => new Response('{}', { status: 404 }));
    const { r } = await open();
    expect(r.getByText('Semakan rangkaian tidak tersedia pada skrin ini')).toBeTruthy();
    expect(r.queryByTestId('qr')).toBeNull();
  });

  it('classifies interface names and ignores virtual adapters', () => {
    const c = classifyInterfaces([
      { name: 'vEthernet (WSL)', address: '172.20.0.1', up: true },
      { name: 'Tailscale', address: '100.64.0.1', up: true },
      { name: 'wlan0', address: '10.168.1.44', up: true },
      { name: 'eth0', address: '10.168.1.20', up: true },
    ]);
    expect(c.ethernet?.address).toBe('10.168.1.20');
    expect(c.wifi?.address).toBe('10.168.1.44');
  });
});

describe('NetCheck keys', () => {
  it('OK tests again and shows the new answer', async () => {
    stubNet(ok(netFixture()), ok(netFixture({ lastPhoneSeenAt: '2026-11-03T07:51:00Z' })));
    const { r } = await open();
    expect(r.getByText('Tiada telefon sampai dalam 10 minit terakhir')).toBeTruthy();
    expect(r.getByText('Uji semula').classList.contains('is-focused')).toBe(true);
    key('Enter');
    key('Enter', 'keyup');
    await flush();
    expect(calls).toBe(2);
    expect(r.getByText('Telefon sampai ke MAXCOM ini pada 3:51 PTG')).toBeTruthy();
  });

  it('a failed re-test keeps the last rows on screen', async () => {
    stubNet(ok(netFixture()), () => new Response('{}', { status: 500 }));
    const { r } = await open();
    key('Enter');
    key('Enter', 'keyup');
    await flush();
    expect(r.getByText('Disambung, 10.168.1.20')).toBeTruthy();
  });

  it('the arrows move focus to Kembali, and OK then closes', async () => {
    stubNet(ok(netFixture()));
    const { r, onClose } = await open();
    await act(async () => { key('ArrowLeft'); });
    expect(r.getByText('Kembali').classList.contains('is-focused')).toBe(true);
    expect(r.getByText('Uji semula').classList.contains('is-focused')).toBe(false);
    key('Enter');
    key('Enter', 'keyup');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);
  });

  it('Back closes', async () => {
    stubNet(ok(netFixture()));
    const { onClose } = await open();
    key('Backspace');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes by itself after 90 seconds, and not before', async () => {
    stubNet(ok(netFixture()));
    const { onClose } = await open();
    act(() => {
      vi.advanceTimersByTime(89_000);
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a key press gives the person another 90 seconds', async () => {
    stubNet(ok(netFixture()));
    const { onClose } = await open();
    act(() => {
      vi.advanceTimersByTime(80_000);
    });
    await act(async () => { key('ArrowLeft'); });
    act(() => {
      vi.advanceTimersByTime(80_000);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a pointer press inside the overlay gives the person another 90 seconds', async () => {
    stubNet(ok(netFixture()));
    const { r, onClose } = await open();
    act(() => {
      vi.advanceTimersByTime(80_000);
    });
    fireEvent.pointerDown(r.container.querySelector('.netcheck')!);
    act(() => {
      vi.advanceTimersByTime(80_000);
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('App: opening the network check', () => {
  const show = (box: BoxStateView) => {
    holder.box = box;
    holder.view = makeView('2026-11-03', '15:52');
    return render(<App />);
  };
  const expiresAt = '2026-11-03T08:01:41Z';
  const hold = async () => {
    await act(async () => {
      key('Enter');
      await vi.advanceTimersByTimeAsync(3000);
    });
    await act(async () => {
      key('Enter', 'keyup');
      await vi.advanceTimersByTimeAsync(0);
    });
  };

  it('holding OK opens it over Main, and Back closes it', async () => {
    stubNet(ok(netFixture()));
    const r = show(boxView({ state: 'active' }));
    expect(r.container.querySelector('.netcheck')).toBeNull();
    await hold();
    expect(r.container.querySelector('.netcheck')).toBeTruthy();
    expect(r.container.querySelector('.screen--main')).toBeTruthy();
    await act(async () => { key('Escape'); });
    expect(r.container.querySelector('.netcheck')).toBeNull();
    expect(r.container.querySelector('.screen--main')).toBeTruthy();
  });

  it('a short OK on the normal kiosk does nothing', async () => {
    stubNet(ok(netFixture()));
    const r = show(boxView({ state: 'active' }));
    await act(async () => {
      key('Enter');
      key('Enter', 'keyup');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(r.container.querySelector('.netcheck')).toBeNull();
  });

  it('a short OK on the setup screen presses its button', async () => {
    stubNet(ok(netFixture()));
    const r = show(boxView({ state: 'setup', qr: { payload: qrPayload(), expiresAt } }));
    await act(async () => {
      key('Enter');
      key('Enter', 'keyup');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(r.container.querySelector('.netcheck')).toBeTruthy();
  });

  it('a short OK on the recovery screen presses its button', async () => {
    stubNet(ok(netFixture()));
    const r = show(boxView({ state: 'recovery', reason: 'no_admin', qr: { payload: qrPayload({ type: 'recovery' }), expiresAt: new Date(Date.now() + 300_000).toISOString() } }));
    await act(async () => {
      key('Enter');
      key('Enter', 'keyup');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(r.container.querySelector('.netcheck')).toBeTruthy();
  });

  it('a damaged box has no button for OK to press', async () => {
    stubNet(ok(netFixture()));
    const r = show(boxView({ state: 'recovery', reason: 'db_damaged' }));
    expect(r.container.querySelector('.tvbtn')).toBeNull();
    await act(async () => {
      key('Enter');
      key('Enter', 'keyup');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(r.container.querySelector('.netcheck')).toBeNull();
  });

  it('never opens on a stopped box', async () => {
    stubNet(ok(netFixture()));
    const r = show(boxView({ state: 'locked' }));
    await hold();
    expect(r.container.querySelector('.netcheck')).toBeNull();
    expect(r.getByText('Perkhidmatan dihentikan')).toBeTruthy();
    expect(calls).toBe(0);
  });

  it('goes away if the box is stopped while it is open, and stays away', async () => {
    stubNet(ok(netFixture()));
    const r = show(boxView({ state: 'active' }));
    await hold();
    expect(r.container.querySelector('.netcheck')).toBeTruthy();
    holder.box = boxView({ state: 'locked' });
    r.rerender(<App />);
    await flush();
    expect(r.container.querySelector('.netcheck')).toBeNull();
    holder.box = boxView({ state: 'active' });
    r.rerender(<App />);
    await flush();
    expect(r.container.querySelector('.netcheck')).toBeNull();
  });
});
