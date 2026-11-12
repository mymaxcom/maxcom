import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/preact';
import { computeKioskState, klInstant, parseJakimCsv, resolveSettings } from '@surau/core';
import { useKiosk } from '../src/data/kiosk.ts';
import { tarawihMonthFor } from '../src/data/tarawih.ts';

const days = parseJakimCsv(
  readFileSync(resolve(process.cwd(), '../../packages/core/test/fixtures/SGR01-2026.csv'), 'utf8'),
);

function Probe() {
  const k = useKiosk();
  return (
    <div
      data-testid="p"
      data-phase={k.state.phase}
      data-next={k.state.next?.name ?? ''}
      data-ready={String(k.ready)}
      data-error={k.error ?? ''}
      data-tz={k.tz}
      data-source={k.todaySource.source}
      data-emergency={String(k.todaySource.emergency)}
      data-footer={k.todaySource.footer?.ms ?? ''}
    >
      x
    </div>
  );
}

describe('useKiosk', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, '', '/?now=2026-11-03T15:52:00%2B08:00');
    class ES {
      onopen = null;
      onerror = null;
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('EventSource', ES);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('normal phase, next asar', async () => {
    const bundle = { version: 1, zone: 'SGR01', days, settings: resolveSettings({}), serverTime: new Date().toISOString() };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(bundle), { status: 200 }));
    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(getByTestId('p').dataset.ready).toBe('true'));
    expect(getByTestId('p').dataset.phase).toBe('normal');
    expect(getByTestId('p').dataset.next).toBe('asar');
  });

  it('a Nairobi bundle: tz from prayer.timezone, today by the Nairobi date, footer and source from the bundle', async () => {
    window.history.replaceState(null, '', '/?now=2026-11-09T12:30:00%2B03:00');
    const day = {
      date: '2026-11-09',
      hijri: { y: 1448, m: 5, d: 20 },
      times: { imsak: '04:40', subuh: '04:50', syuruk: '06:00', zohor: '12:20', asar: '15:30', maghrib: '18:20', isyak: '19:30' },
      source: 'calc',
      corrected: [],
      emergency: false,
      hijriSource: 'calc',
    };
    const prayer = {
      country: 'KE',
      hasOfficial: false,
      timezone: 'Africa/Nairobi',
      utcOffsetMinutes: 180,
      footerMs: 'Kiraan setempat (Liga Dunia Islam), Nairobi',
      footerEn: 'x',
    };
    const bundle = {
      version: 1,
      zone: 'NBO',
      days: [day],
      prayer,
      settings: resolveSettings({ location: { timezone: 'Africa/Nairobi' } }),
      serverTime: new Date().toISOString(),
    };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(bundle), { status: 200 }));
    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(getByTestId('p').dataset.ready).toBe('true'));
    const d = getByTestId('p').dataset;
    expect(d.tz).toBe('Africa/Nairobi');
    expect(d.phase).not.toBe('noData');
    expect(d.source).toBe('calc');
    expect(d.emergency).toBe('false');
    expect(d.footer).toBe('Kiraan setempat (Liga Dunia Islam), Nairobi');
  });

  it('an old bundle without prayer: KL zone, official, no footer', async () => {
    const bundle = { version: 1, zone: 'SGR01', days, settings: resolveSettings({}), serverTime: new Date().toISOString() };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(bundle), { status: 200 }));
    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(getByTestId('p').dataset.ready).toBe('true'));
    const d = getByTestId('p').dataset;
    expect(d.tz).toBe('Asia/Kuala_Lumpur');
    expect(d.source).toBe('official');
    expect(d.emergency).toBe('false');
    expect(d.footer).toBe('');
  });

  it('noData with error and no throw', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    const { getByTestId } = render(<Probe />);
    await waitFor(() => expect(getByTestId('p').dataset.error).toMatch(/no data/));
    expect(getByTestId('p').dataset.phase).toBe('noData');
  });
});

describe('tarawihMonthFor', () => {
  const s = resolveSettings({});
  it('first night of Ramadan (eve, after Maghrib) is month 9 with tarawih', () => {
    expect(tarawihMonthFor(klInstant('2026-02-18', '21:30'), days, s)).toBe(9);
    const st = computeKioskState(klInstant('2026-02-18', '21:30'), days, s, 9);
    expect(st.phase).toBe('tarawih');
  });
  it('eve of 1 Syawal is month 10 (no tarawih)', () => {
    const now = klInstant('2026-03-20', '21:30');
    expect(tarawihMonthFor(now, days, s)).toBe(10);
    expect(computeKioskState(now, days, s, 10).phase).not.toBe('tarawih');
  });
  it('after midnight on 1 Ramadan is still month 9', () => {
    expect(tarawihMonthFor(klInstant('2026-02-19', '00:30'), days, s)).toBe(9);
  });
  it('adjustDays +1 moves the month (2026-02-17 21:30 -> 9)', () => {
    const adj = resolveSettings({ hijriDate: { enabled: false, adjustDays: 1 } });
    expect(tarawihMonthFor(klInstant('2026-02-17', '21:30'), days, adj)).toBe(9);
    expect(tarawihMonthFor(klInstant('2026-02-17', '21:30'), days, s)).toBe(8);
  });
});
