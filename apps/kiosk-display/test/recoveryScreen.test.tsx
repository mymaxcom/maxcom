import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import type { BoxStateView } from '@surau/core';
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

function show(box: BoxStateView) {
  holder.box = box;
  holder.view = makeView('2026-11-03', '15:52');
  return render(<App />);
}
const qr = () => ({ payload: qrPayload({ type: 'recovery' }), expiresAt: new Date(Date.now() + 300_000).toISOString() });
const noAdmin = (over: Partial<BoxStateView> = {}) =>
  boxView({ state: 'recovery', reason: 'no_admin', name: 'MAXCOM Dewan Utama', surauName: 'Surau D\'Waqaf', qr: qr(), ...over });
const damaged = (over: Partial<BoxStateView> = {}) =>
  boxView({ state: 'recovery', reason: 'db_damaged', name: 'MAXCOM Dewan Utama', surauName: 'Surau D\'Waqaf', ...over });

afterEach(cleanup);

describe('Recovery screen, no active Pentadbir', () => {
  it('keeps the prayer bar and the clock under the recovery card', () => {
    const r = show(noAdmin());
    expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).toBe('recovery');
    expect(r.container.querySelector('.pbar')).toBeTruthy();
    expect(r.container.querySelector('[data-role="clock"]')).toBeTruthy();
    expect(r.getByText('Surau ini perlukan Pentadbir baharu')).toBeTruthy();
    expect(r.getByText('Mod pemulihan')).toBeTruthy();
    expect(r.getByTestId('qr')).toBeTruthy();
    expect(r.getByText('Kod pemulihan, sekali guna')).toBeTruthy();
    expect(r.getByText('Surau D\'Waqaf')).toBeTruthy();
    expect(r.getByText('MAXCOM Dewan Utama')).toBeTruthy();
    expect(r.queryByText('Waktu solat tidak dapat dibaca')).toBeNull();
  });

  it('tells an unlinked box to use the recovery code', () => {
    const r = show(noAdmin({ linked: false }));
    expect(r.getByText(/kod pemulihan yang ditulis di atas kertas/)).toBeTruthy();
    expect(r.queryByText(/meluluskan Pentadbir baharu/)).toBeNull();
  });

  it('names both paths on a linked box', () => {
    const r = show(noAdmin({ linked: true }));
    expect(r.getByText(/kod pemulihan.*meluluskan Pentadbir baharu/)).toBeTruthy();
  });

  it('has the network check button', () => {
    const r = show(noAdmin());
    expect(r.getByText('Semakan rangkaian').classList.contains('is-focused')).toBe(true);
  });

  it('a paired hall display, given the state without a QR, keeps its normal content', () => {
    const r = show(noAdmin({ qr: undefined }));
    expect(r.queryByTestId('qr')).toBeNull();
    expect(r.container.querySelector('.qrcard')).toBeNull();
    expect(r.queryByText('Surau ini perlukan Pentadbir baharu')).toBeNull();
    expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).not.toBe('recovery');
    expect(r.container.querySelector('[data-screen="recovery"]')).toBeNull();
  });

  it('the loopback kiosk, given the QR, shows the recovery screen', () => {
    const r = show(noAdmin());
    expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).toBe('recovery');
    expect(r.getByText('Surau ini perlukan Pentadbir baharu')).toBeTruthy();
  });
});

describe('Recovery screen, a box with no recovery code (upgraded)', () => {
  it('shows no QR and tells the surau to contact the installer', () => {
    const r = show(noAdmin({ qr: undefined, recoveryCodeSet: false }));
    expect(r.queryByTestId('qr')).toBeNull();
    expect(r.container.querySelector('.qrcard')).toBeNull();
    expect(r.getByText('Tiada kod pemulihan dibuat untuk MAXCOM ini.')).toBeTruthy();
    expect(r.getByText('Sila hubungi pemasang MAXCOM anda.')).toBeTruthy();
    expect(r.container.textContent).not.toMatch(/[Ii]mbas kod/);
    expect(r.container.querySelector('.pbar')).toBeTruthy();
  });

  it('even a stray QR is not drawn while the box says it has no code', () => {
    const r = show(noAdmin({ recoveryCodeSet: false }));
    expect(r.queryByTestId('qr')).toBeNull();
  });

  it('a box with a code keeps the steps and the QR', () => {
    const r = show(noAdmin({ recoveryCodeSet: true }));
    expect(r.getByTestId('qr')).toBeTruthy();
    expect(r.queryByText('Tiada kod pemulihan dibuat untuk MAXCOM ini.')).toBeNull();
    expect(r.getByText(/kod pemulihan yang ditulis di atas kertas/)).toBeTruthy();
  });
});

describe('Recovery screen, damaged database', () => {
  it('shows the card alone: no prayer bar, a plain line saying why', () => {
    const r = show(damaged());
    expect(r.container.querySelector('.pbar')).toBeNull();
    expect(r.getByText('Data surau perlu dipulihkan')).toBeTruthy();
    expect(r.getByText('Waktu solat tidak dapat dibaca')).toBeTruthy();
    expect(r.getByText('MAXCOM Dewan Utama')).toBeTruthy();
  });

  it('never asks anyone to scan a code that is not there', () => {
    for (const linked of [true, false]) {
      const r = show(damaged({ linked }));
      expect(r.queryByTestId('qr')).toBeNull();
      expect(r.container.textContent).not.toMatch(/[Ii]mbas kod/);
      cleanup();
    }
  });

  it('uses the linked and the unlinked steps', () => {
    const l = show(damaged({ linked: true }));
    expect(l.getByText(/sandaran awan/)).toBeTruthy();
    cleanup();
    const u = show(damaged({ linked: false }));
    expect(u.getByText(/pemacu USB/)).toBeTruthy();
  });
});
