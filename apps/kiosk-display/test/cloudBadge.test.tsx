import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';
import type { CloudStatus } from '../src/data/cloud.ts';

const holder = vi.hoisted(() => ({
  view: null as unknown as KioskView,
  cloud: { linked: false, lastOkAt: null, offline: false } as CloudStatus,
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
  holder.cloud = { linked: false, lastOkAt: null, offline: false, ...cloud };
  return render(<App />);
}
const offline = { linked: true, lastOkAt: '2026-11-03T06:10:00Z', offline: true };

afterEach(cleanup);

describe('CloudBadge', () => {
  it('shows for an offline linked box, with the time of the last sync', () => {
    const r = show(makeView('2026-11-03', '15:52'), offline);
    const badge = r.getByTestId('cloud-badge');
    expect(badge.textContent).toBe('Luar talian · Diselaraskan 2:10 PTG');
    expect(badge.getAttribute('data-dim')).toBe('false');
  });

  it('says only offline when the box has never synced', () => {
    const r = show(makeView('2026-11-03', '15:52'), { linked: true, lastOkAt: null, offline: true });
    expect(r.getByTestId('cloud-badge').textContent).toBe('Luar talian');
  });

  it('follows the 24-hour setting', () => {
    const r = show(makeView('2026-11-03', '15:52', { settings: { prayerBar: { timeFormat: '24h' } } }), offline);
    expect(r.getByTestId('cloud-badge').textContent).toBe('Luar talian · Diselaraskan 14:10');
  });

  it('is absent for an unlinked box and a box still in touch', () => {
    const a = show(makeView('2026-11-03', '15:52'), { linked: false, offline: false });
    expect(a.queryByTestId('cloud-badge')).toBeNull();
    cleanup();
    const b = show(makeView('2026-11-03', '15:52'), { linked: true, lastOkAt: '2026-11-03T07:50:00Z', offline: false });
    expect(b.queryByTestId('cloud-badge')).toBeNull();
  });

  it('dims in a prayer phase (iqamah) and hides during solat', () => {
    const iq = show(makeView('2026-11-03', '16:25'), offline);
    expect(iq.getByTestId('cloud-badge').getAttribute('data-dim')).toBe('true');
    cleanup();
    const solat = show(makeView('2026-11-03', '16:35'), offline);
    expect(solat.queryByTestId('cloud-badge')).toBeNull();
  });
});
