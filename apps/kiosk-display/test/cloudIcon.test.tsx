import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';
import type { CloudStatus } from '../src/data/cloud.ts';

const holder = vi.hoisted(() => ({
  view: null as unknown as KioskView,
  cloud: { linked: false, lastOkAt: null, enabled: false, offline: false } as CloudStatus,
}));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));
vi.mock('../src/data/boxState.ts', async (orig) => ({
  ...(await orig<typeof import('../src/data/boxState.ts')>()),
  useBoxState: () => ({ view: null, error: null }),
}));
vi.mock('../src/data/cloud.ts', async (orig) => ({
  ...(await orig<typeof import('../src/data/cloud.ts')>()),
  useCloudStatus: () => holder.cloud,
}));

import { App } from '../src/app.tsx';

function show(view: KioskView, cloud: Partial<CloudStatus>) {
  holder.view = view;
  holder.cloud = { linked: false, lastOkAt: null, enabled: false, offline: false, ...cloud };
  return render(<App />);
}
const offline = { linked: true, enabled: true, lastOkAt: '2026-11-03T06:10:00Z', offline: true };
const online = { linked: true, enabled: true, lastOkAt: '2026-11-03T07:50:00Z', offline: false };

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('CloudIcon', () => {
  it('shows the online icon for a linked box with cloudSync on and a fresh answer, with no visible text', () => {
    const r = show(makeView('2026-11-03', '15:52'), online);
    const icon = r.getByTestId('cloud-icon');
    expect(icon.getAttribute('data-state')).toBe('online');
    expect(icon.getAttribute('role')).toBe('img');
    expect(icon.getAttribute('aria-label')).toBe('Dalam talian');
    expect(icon.getAttribute('title')).toBe('Dalam talian');
    expect(icon.textContent).toBe('');
    expect(icon.getAttribute('data-dim')).toBe('false');
  });

  it('shows the offline icon for a stale linked box; the label carries the time of the last answer', () => {
    const r = show(makeView('2026-11-03', '15:52'), offline);
    const icon = r.getByTestId('cloud-icon');
    expect(icon.getAttribute('data-state')).toBe('offline');
    expect(icon.getAttribute('aria-label')).toBe('Luar talian · Diselaraskan 2:10 PTG');
    expect(icon.textContent).toBe('');
  });

  it('says only offline when the box has never synced', () => {
    const r = show(makeView('2026-11-03', '15:52'), { linked: true, enabled: true, lastOkAt: null, offline: true });
    expect(r.getByTestId('cloud-icon').getAttribute('aria-label')).toBe('Luar talian');
  });

  it('follows the 24-hour setting', () => {
    const r = show(makeView('2026-11-03', '15:52', { settings: { prayerBar: { timeFormat: '24h' } } }), offline);
    expect(r.getByTestId('cloud-icon').getAttribute('aria-label')).toBe('Luar talian · Diselaraskan 14:10');
  });

  it('speaks English when the TV language is English', () => {
    const r = show(makeView('2026-11-03', '15:52', { settings: { language: { lang: 'en' } } }), offline);
    expect(r.getByTestId('cloud-icon').getAttribute('aria-label')).toBe('Offline · Synced 2:10 PM');
    cleanup();
    const o = show(makeView('2026-11-03', '15:52', { settings: { language: { lang: 'en' } } }), online);
    expect(o.getByTestId('cloud-icon').getAttribute('aria-label')).toBe('Online');
  });

  it('is absent for an unlinked box and for a linked box with cloudSync off', () => {
    const a = show(makeView('2026-11-03', '15:52'), { linked: false, enabled: true, offline: false });
    expect(a.queryByTestId('cloud-icon')).toBeNull();
    cleanup();
    const b = show(makeView('2026-11-03', '15:52'), { linked: true, enabled: false, lastOkAt: '2026-11-03T07:50:00Z', offline: false });
    expect(b.queryByTestId('cloud-icon')).toBeNull();
  });

  it('is absent in the admin preview', () => {
    window.history.replaceState(null, '', '/?preview=1');
    const r = show(makeView('2026-11-03', '15:52'), online);
    expect(r.queryByTestId('cloud-icon')).toBeNull();
  });

  it('dims in a prayer phase (iqamah) and hides during solat, online or offline', () => {
    const iq = show(makeView('2026-11-03', '16:25'), online);
    expect(iq.getByTestId('cloud-icon').getAttribute('data-dim')).toBe('true');
    cleanup();
    const iqOff = show(makeView('2026-11-03', '16:25'), offline);
    expect(iqOff.getByTestId('cloud-icon').getAttribute('data-dim')).toBe('true');
    cleanup();
    const solat = show(makeView('2026-11-03', '16:35'), online);
    expect(solat.queryByTestId('cloud-icon')).toBeNull();
  });

  it('is not inside the logo button, so it takes no part in the host-exit double click or hold', () => {
    const r = show(makeView('2026-11-03', '15:52'), online);
    expect(r.getByTestId('cloud-icon').closest('button')).toBeNull();
  });
});
