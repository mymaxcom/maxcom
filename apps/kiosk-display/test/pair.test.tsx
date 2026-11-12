import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/preact';
import { resolveSettings } from '@surau/core';
import { makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';
import type { PairingView } from '../src/data/pairing.ts';
import { NotPairedError, setNotPaired } from '../src/data/bundle.ts';

const holder = vi.hoisted(() => ({
  view: null as unknown as KioskView,
  pairing: { code: null, expiresAt: null, paired: false, error: null } as PairingView,
}));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));
vi.mock('../src/data/pairing.ts', async (orig) => ({
  ...(await orig<typeof import('../src/data/pairing.ts')>()),
  usePairing: () => holder.pairing,
}));

import { App } from '../src/app.tsx';
import { Pair } from '../src/screens/Pair.tsx';

const settings = resolveSettings({});
const NOT_PAIRED = new NotPairedError().message;

function pairing(p: Partial<PairingView>): PairingView {
  holder.pairing = { code: null, expiresAt: null, paired: false, error: null, ...p };
  return holder.pairing;
}
function showApp(view: KioskView) {
  holder.view = view;
  return render(<App />);
}
/** The data layer's view when the box answered 401 and nothing is cached. */
function notPairedNoData(): KioskView {
  const v = makeView('2027-01-01', '09:00');
  return { ...v, error: NOT_PAIRED, daysAhead: 0 };
}

beforeEach(() => {
  pairing({});
  setNotPaired(false);
});
afterEach(() => {
  cleanup();
  setNotPaired(false);
  vi.useRealTimers();
});

describe('Pair screen', () => {
  it('shows the surau name, the clock, the title and the code in two groups', () => {
    pairing({ code: '482913', expiresAt: new Date(Date.now() + 9 * 60_000 + 41_000).toISOString() });
    const r = render(<Pair lang="ms" settings={settings} reload={() => {}} />);
    expect(r.getByText('Surau')).toBeTruthy();
    expect(r.container.querySelector('[data-role="clock"]')).toBeTruthy();
    expect(r.getByText('Padankan skrin TV ini')).toBeTruthy();
    const code = r.container.querySelector('[data-code]')!;
    expect(code.getAttribute('data-code')).toBe('482913');
    expect(code.textContent).toBe('482 913');
    const groups = code.querySelectorAll('.pair__group');
    expect([...groups].map((g) => g.textContent)).toEqual(['482', '913']);
    expect(r.getByText('Buka aplikasi MAX Admin Client, pilih Lagi > Pengguna & peranti > Skrin TV, dan masukkan kod ini')).toBeTruthy();
    // Never any prayer information here.
    expect(r.container.querySelector('[data-prayer]')).toBeNull();
    expect(r.container.querySelector('.pbar')).toBeNull();
  });

  it('keeps the whole menu path on one line: no breakable space inside it', () => {
    pairing({ code: '482913', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const r = render(<Pair lang="ms" settings={settings} reload={() => {}} />);
    const text = r.container.querySelector('.pair__instruction')!.textContent!;
    const path = /Lagi.*Skrin.TV/.exec(text)![0];
    expect(path).not.toContain(' ');
    expect(path.replace(/ /g, ' ')).toBe('Lagi > Pengguna & peranti > Skrin TV');
  });

  it('names the box it is connected to, read from the public box info', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) =>
      String(input) === '/api/box/info'
        ? new Response(JSON.stringify({ boxId: '4f2a9c1e77b0d3a1', name: 'MAXCOM Dewan Utama' }), { status: 200 })
        : new Response('{}', { status: 404 }));
    pairing({ code: '482913', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const r = render(<Pair lang="ms" settings={settings} reload={() => {}} />);
    expect(await r.findByText('Disambung ke MAXCOM Dewan Utama')).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('leaves the line out when the box cannot say its name', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 500 }));
    pairing({ code: '482913', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const r = render(<Pair lang="ms" settings={settings} reload={() => {}} />);
    await act(async () => undefined);
    expect(r.queryByText(/Disambung ke/)).toBeNull();
    vi.unstubAllGlobals();
  });

  it('counts down to the expiry as MM:SS and ticks each second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T07:52:00Z'));
    pairing({ code: '482913', expiresAt: '2026-11-03T08:01:41Z' });
    const r = render(<Pair lang="ms" settings={settings} reload={() => {}} />);
    expect(r.getByText('Kod tamat dalam 09:41')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(r.getByText('Kod tamat dalam 09:40')).toBeTruthy();
  });

  it('says a new code is being requested once the code has expired', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T08:05:00Z'));
    pairing({ code: '482913', expiresAt: '2026-11-03T08:01:41Z' });
    const r = render(<Pair lang="ms" settings={settings} reload={() => {}} />);
    expect(r.getByText('Meminta kod baharu...')).toBeTruthy();
    expect(r.queryByText(/Kod tamat dalam/)).toBeNull();
  });

  it('shows the waiting state before the first code arrives', () => {
    pairing({});
    const r = render(<Pair lang="ms" settings={settings} reload={() => {}} />);
    expect(r.getByText('Meminta kod baharu...')).toBeTruthy();
    expect(r.container.querySelector('[data-code]')).toBeNull();
  });

  it('shows a calm error when the box is unreachable and says it keeps retrying', () => {
    pairing({ error: 'HTTP 503' });
    const r = render(<Pair lang="ms" settings={settings} reload={() => {}} />);
    expect(r.getByText('Tidak dapat menghubungi MAXCOM')).toBeTruthy();
    expect(r.getByText('Mencuba semula secara automatik')).toBeTruthy();
    expect(r.container.querySelector('[data-code]')).toBeNull();
    expect(r.container.querySelector('.screen--pair')!.getAttribute('data-state')).toBe('error');
    // The raw error text never reaches the TV.
    expect(r.queryByText(/HTTP 503/)).toBeNull();
  });

  it('reloads once the box reports the screen as paired', () => {
    pairing({ code: '482913', expiresAt: new Date(Date.now() + 60_000).toISOString(), paired: true });
    const reload = vi.fn();
    const r = render(<Pair lang="ms" settings={settings} reload={reload} />);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(r.getByText('Skrin dipadankan')).toBeTruthy();
  });

  it('speaks English when the kiosk language is English', () => {
    pairing({ code: '482913', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const r = render(<Pair lang="en" settings={settings} reload={() => {}} />);
    expect(r.getByText('Pair this TV screen')).toBeTruthy();
    expect(r.getByText(/Code expires in 0[01]:/)).toBeTruthy();
  });
});

describe('App: pairing screen and the not-paired badge', () => {
  it('renders the Pair screen when the box refused the display and nothing is cached', () => {
    pairing({ code: '123456', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    setNotPaired(true);
    const r = showApp(notPairedNoData());
    expect(r.getByText('Padankan skrin TV ini')).toBeTruthy();
    expect(r.container.querySelector('[data-code]')!.textContent).toBe('123 456');
    expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).toBe('pair');
    expect(r.container.querySelector('.screen--main')).toBeNull();
    expect(r.queryByText('Belum dipadankan')).toBeNull();
    expect(r.queryByText(/Tiada data waktu solat/)).toBeNull();
  });

  it('keeps the normal kiosk and adds the corner badge when a cached bundle exists', () => {
    setNotPaired(true);
    const r = showApp(makeView('2026-11-03', '15:52'));
    expect(r.container.querySelector('.screen--main')).toBeTruthy();
    expect(r.getByText('Asar dalam')).toBeTruthy();
    const badge = r.getByTestId('pair-badge');
    expect(badge.textContent).toContain('Belum dipadankan');
    expect(badge.getAttribute('data-dim')).toBe('false');
    expect(r.queryByText('Padankan skrin TV ini')).toBeNull();
  });

  it('shows no badge and no Pair screen while the display is paired', () => {
    const r = showApp(makeView('2026-11-03', '15:52'));
    expect(r.queryByTestId('pair-badge')).toBeNull();
    expect(r.queryByText('Padankan skrin TV ini')).toBeNull();
  });

  it('follows the not-paired flag live', async () => {
    const r = showApp(makeView('2026-11-03', '15:52'));
    expect(r.queryByTestId('pair-badge')).toBeNull();
    await act(async () => setNotPaired(true));
    expect(r.getByTestId('pair-badge')).toBeTruthy();
    await act(async () => setNotPaired(false));
    expect(r.queryByTestId('pair-badge')).toBeNull();
  });

  it('dims the badge during a prayer phase (iqamah) and hides it during solat', () => {
    setNotPaired(true);
    const iq = showApp(makeView('2026-11-03', '16:25'));
    expect(iq.container.querySelector('.screen--iqamah')).toBeTruthy();
    expect(iq.getByTestId('pair-badge').getAttribute('data-dim')).toBe('true');
    cleanup();
    const solat = showApp(makeView('2026-11-03', '16:35'));
    expect(solat.container.querySelector('.screen--solat')).toBeTruthy();
    expect(solat.queryByTestId('pair-badge')).toBeNull();
    expect(solat.queryByText('Padankan skrin TV ini')).toBeNull();
  });

  it('badge, not the Pair screen, when the box refuses a display that still has data on screen', () => {
    // Revoked mid-run with storage unavailable: the data layer reports the error but keeps the bundle.
    setNotPaired(true);
    const v = makeView('2026-11-03', '15:52');
    const r = showApp({ ...v, error: NOT_PAIRED });
    expect(r.container.querySelector('.screen--main')).toBeTruthy();
    expect(r.getByTestId('pair-badge')).toBeTruthy();
    expect(r.queryByText('Padankan skrin TV ini')).toBeNull();
  });

  it('a plain no-data error (box down, no cache) still shows the no-data screen, not Pair', () => {
    const v = makeView('2027-01-01', '09:00');
    const r = showApp({ ...v, error: 'no data: HTTP 503' });
    expect(r.getByText(/Tiada data waktu solat/)).toBeTruthy();
    expect(r.queryByText('Padankan skrin TV ini')).toBeNull();
  });
});
