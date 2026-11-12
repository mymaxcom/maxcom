import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotPairedError, isNotPaired, loadBundle, onNotPairedChange, resetSharedStream, setNotPaired, subscribe } from '../src/data/bundle.ts';

function fakeStorage(opts: { throwOnSet?: boolean } = {}): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => {
      if (opts.throwOnSet) throw new Error('QuotaExceededError');
      m.set(k, v);
    },
  };
}

const bundle = { version: 3, zone: 'SGR01', days: [], settings: {}, serverTime: '2026-11-03T07:52:00Z' };
const okFetch = (async () => new Response(JSON.stringify(bundle), { status: 200 })) as unknown as typeof fetch;
const failFetch = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;

describe('loadBundle', () => {
  it('fetches, stores and reports network', async () => {
    const s = fakeStorage();
    const r = await loadBundle(okFetch, s);
    expect(r.source).toBe('network');
    expect(r.bundle.version).toBe(3);
    expect(JSON.parse(s.getItem('surau.bundle')!).bundle.version).toBe(3);
  });

  it('falls back to cache when fetch rejects', async () => {
    const s = fakeStorage();
    const first = await loadBundle(okFetch, s);
    const r = await loadBundle(failFetch, s);
    expect(r.source).toBe('cache');
    expect(r.bundle.version).toBe(3);
    expect(r.fetchedAt).toBe(first.fetchedAt);
  });

  it('falls back to cache on non-2xx', async () => {
    const s = fakeStorage();
    await loadBundle(okFetch, s);
    const bad = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    expect((await loadBundle(bad, s)).source).toBe('cache');
  });

  it('falls back to cache on bad shape', async () => {
    const s = fakeStorage();
    await loadBundle(okFetch, s);
    const bad = (async () => new Response('{"nope":1}', { status: 200 })) as unknown as typeof fetch;
    expect((await loadBundle(bad, s)).source).toBe('cache');
  });

  it('throws no data on corrupt cache with failing fetch', async () => {
    const s = fakeStorage();
    s.setItem('surau.bundle', '{not json');
    await expect(loadBundle(failFetch, s)).rejects.toThrow(/no data/);
  });

  describe('logo', () => {
    const withLogo = (logo: unknown) =>
      (async () => new Response(JSON.stringify({ ...bundle, logo }), { status: 200 })) as unknown as typeof fetch;

    it('keeps the box public logo URL and caches it', async () => {
      const s = fakeStorage();
      const r = await loadBundle(withLogo('/surau-logo?v=0123456789abcdef'), s);
      expect(r.bundle.logo).toBe('/surau-logo?v=0123456789abcdef');
      expect((await loadBundle(failFetch, s)).bundle.logo).toBe('/surau-logo?v=0123456789abcdef');
      expect((await loadBundle(withLogo('/surau-logo'), fakeStorage())).bundle.logo).toBe('/surau-logo');
    });

    it('is null when absent or null', async () => {
      expect((await loadBundle(okFetch, fakeStorage())).bundle.logo).toBeNull();
      expect((await loadBundle(withLogo(null), fakeStorage())).bundle.logo).toBeNull();
    });

    it.each([
      ['an external URL', 'https://evil.example/logo.png'],
      ['a protocol-relative URL', '//evil.example/surau-logo'],
      ['a javascript URL', 'javascript:alert(1)'],
      ['a data URL', 'data:image/png;base64,AAAA'],
      ['another box path', '/assets/' + 'a'.repeat(64)],
      ['a logo path with extra query', '/surau-logo?v=abc&x=1'],
      ['a non-string', 42],
    ])('refuses %s (treated as no logo)', async (_n, logo) => {
      expect((await loadBundle(withLogo(logo), fakeStorage())).bundle.logo).toBeNull();
    });
  });

  it('throws no data when nothing cached', async () => {
    await expect(loadBundle(failFetch, fakeStorage())).rejects.toThrow(/no data/);
  });

  it('survives storage write failure', async () => {
    const r = await loadBundle(okFetch, fakeStorage({ throwOnSet: true }));
    expect(r.source).toBe('network');
  });
});

class FakeES {
  static instances: FakeES[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(url: string) { this.url = url; FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() { this.closed = true; }
  emit(type: string, data: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data } as MessageEvent);
  }
}

describe('subscribe', () => {
  beforeEach(() => { vi.useFakeTimers(); FakeES.instances = []; resetSharedStream(); });
  afterEach(() => { resetSharedStream(); vi.useRealTimers(); });
  const impl = FakeES as unknown as typeof EventSource;

  it('calls onChange with the version', () => {
    const cb = vi.fn();
    subscribe(cb, { EventSourceImpl: impl });
    expect(FakeES.instances[0]!.url).toBe('/api/kiosk/events');
    FakeES.instances[0]!.emit('changed', '{"version":7}');
    expect(cb).toHaveBeenCalledWith(7);
  });

  it('reconnects with doubling backoff', () => {
    subscribe(() => {}, { EventSourceImpl: impl });
    FakeES.instances[0]!.onerror?.();
    expect(FakeES.instances[0]!.closed).toBe(true);
    vi.advanceTimersByTime(1999);
    expect(FakeES.instances.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeES.instances.length).toBe(2);
    FakeES.instances[1]!.onerror?.();
    vi.advanceTimersByTime(3999);
    expect(FakeES.instances.length).toBe(2);
    vi.advanceTimersByTime(1);
    expect(FakeES.instances.length).toBe(3);
  });

  it('resets backoff after a successful open', () => {
    subscribe(() => {}, { EventSourceImpl: impl });
    FakeES.instances[0]!.onerror?.();
    vi.advanceTimersByTime(2000);
    FakeES.instances[1]!.onopen?.();
    FakeES.instances[1]!.onerror?.();
    vi.advanceTimersByTime(2000);
    expect(FakeES.instances.length).toBe(3);
  });

  it('shares ONE stream between subscribers and closes it with the last unsubscribe', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unA = subscribe(a, { EventSourceImpl: impl });
    const unB = subscribe(b, { EventSourceImpl: impl });
    expect(FakeES.instances.length).toBe(1);
    FakeES.instances[0]!.emit('changed', '{"version":3}');
    expect(a).toHaveBeenCalledWith(3);
    expect(b).toHaveBeenCalledWith(3);
    unA();
    expect(FakeES.instances[0]!.closed).toBe(false);
    FakeES.instances[0]!.emit('changed', '{"version":4}');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    unB();
    expect(FakeES.instances[0]!.closed).toBe(true);
    subscribe(() => {}, { EventSourceImpl: impl });
    expect(FakeES.instances.length).toBe(2);
  });

  it('unsubscribe closes and clears timers', () => {
    const un = subscribe(() => {}, { EventSourceImpl: impl });
    FakeES.instances[0]!.onerror?.();
    un();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60000);
    expect(FakeES.instances.length).toBe(1);
    const un2 = subscribe(() => {}, { EventSourceImpl: impl });
    un2();
    expect(FakeES.instances[1]!.closed).toBe(true);
  });
});

describe('bundle day validation', () => {
  const good = (date: string) => ({
    date,
    hijri: { y: 1448, m: 5, d: 1 },
    times: { imsak: '05:50', subuh: '06:00', syuruk: '07:10', zohor: '13:10', asar: '16:20', maghrib: '19:10', isyak: '20:20' },
  });
  const mk = (days: unknown[]) =>
    (async () => new Response(JSON.stringify({ ...bundle, days }), { status: 200 })) as unknown as typeof fetch;

  it('drops malformed days and keeps the rest', async () => {
    const bad1 = { ...good('2026-11-04'), times: { ...good('x').times, isyak: '' } };
    const bad2 = { ...good('2026-11-05'), times: { ...good('x').times, subuh: '25:00' } };
    const bad3 = { ...good('2026-11-06'), hijri: undefined };
    const bad4 = good('06-11-2026');
    const bad5 = { date: '2026-11-07', hijri: {}, times: { subuh: '06:00' } };
    const r = await loadBundle(mk([good('2026-11-03'), bad1, bad2, bad3, bad4, bad5, null, 'x', good('2026-11-08')]), fakeStorage());
    expect(r.bundle.days.map((d) => d.date)).toEqual(['2026-11-03', '2026-11-08']);
  });

  it('cached bundle is sanitised too', async () => {
    const s = fakeStorage();
    s.setItem('surau.bundle', JSON.stringify({ bundle: { ...bundle, days: [good('2026-11-03'), { date: 'bad' }] }, fetchedAt: 1 }));
    const r = await loadBundle(failFetch, s);
    expect(r.bundle.days.length).toBe(1);
  });

  it('rejects a bundle with settings missing', async () => {
    const noSettings = (async () => new Response(JSON.stringify({ version: 1, zone: 'x', days: [] }), { status: 200 })) as unknown as typeof fetch;
    await expect(loadBundle(noSettings, fakeStorage())).rejects.toThrow(/no data/);
  });
});

describe('pairing (401) handling', () => {
  const unauth = (async () => new Response('{"errors":["x"]}', { status: 401 })) as unknown as typeof fetch;
  afterEach(() => setNotPaired(false));

  it('sends same-origin credentials', async () => {
    const spy = vi.fn(okFetch);
    await loadBundle(spy as unknown as typeof fetch, fakeStorage());
    expect(spy.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin' });
  });

  it('401 with no cached bundle throws NotPairedError', async () => {
    await expect(loadBundle(unauth, fakeStorage())).rejects.toBeInstanceOf(NotPairedError);
    expect(isNotPaired()).toBe(true);
  });

  it('401 with a cached bundle keeps running on the cache and raises the flag', async () => {
    const s = fakeStorage();
    await loadBundle(okFetch, s);
    const seen: boolean[] = [];
    const off = onNotPairedChange((v) => seen.push(v));
    const r = await loadBundle(unauth, s);
    expect(r.source).toBe('cache');
    expect(r.bundle.version).toBe(3);
    expect(isNotPaired()).toBe(true);
    await loadBundle(okFetch, s);
    expect(isNotPaired()).toBe(false);
    off();
    expect(seen).toEqual([true, false]);
  });

  it('other failures with no cache stay a plain error, not NotPaired', async () => {
    await expect(loadBundle(failFetch, fakeStorage())).rejects.not.toBeInstanceOf(NotPairedError);
    expect(isNotPaired()).toBe(false);
  });
});

describe('loadBundle prayer block (Plan 13)', () => {
  const nairobi = {
    country: 'KE',
    hasOfficial: false,
    timezone: 'Africa/Nairobi',
    utcOffsetMinutes: 180,
    footerMs: 'Kiraan setempat (Liga Dunia Islam), Nairobi',
    footerEn: 'Calculated locally (Muslim World League), Nairobi',
  };
  const body = (prayer: unknown) => ({ version: 1, zone: 'NBO', days: [], prayer, settings: {}, serverTime: 'x' });
  const ok = (b: unknown) => (async () => new Response(JSON.stringify(b), { status: 200 })) as unknown as typeof fetch;

  it('keeps a valid prayer block', async () => {
    expect((await loadBundle(ok(body(nairobi)), fakeStorage())).bundle.prayer).toEqual(nairobi);
  });

  it('an old bundle without prayer has none (the KL default applies)', async () => {
    expect((await loadBundle(ok(bundle), fakeStorage())).bundle.prayer).toBeUndefined();
  });

  it('drops a prayer block with a bad zone or wrong shape', async () => {
    for (const p of [{ ...nairobi, timezone: 'Not/AZone' }, { ...nairobi, footerMs: 5 }, 'x', null]) {
      expect((await loadBundle(ok(body(p)), fakeStorage())).bundle.prayer).toBeUndefined();
    }
  });
});
