import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/preact';
import { LINK_STRINGS, tl } from '../src/i18n-box.ts';
import type { BoxLang } from '../src/i18n-box.ts';
import {
  OUTCOME_CODES,
  PROGRESS_STEPS,
  followerInfoOf,
  linkIntervalFor,
  linkScreenOf,
  offsetFromAnswer,
  parseLink,
  reasonKeyOf,
  secondsLeftAt,
  useLinkState,
} from '../src/data/linkState.ts';
import type { LinkResult, LinkView } from '../src/data/linkState.ts';
import { FollowerMarks, Link, LinkQr } from '../src/screens/Link.tsx';
import { Setup } from '../src/screens/Setup.tsx';
import { boxView, qrPayload } from './boxFixture.ts';
import { makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';

const holder = vi.hoisted(() => ({ view: null as unknown as KioskView }));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));

import { App } from '../src/app.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const LANGS: BoxLang[] = ['ms', 'en', 'ar'];

const NONE = {
  mode: 'main',
  master: null,
  qr: null,
  step: null,
  code: null,
  peer: null,
  progress: null,
  last: null,
  unlink: null,
};
const link = (over: Record<string, unknown> = {}): LinkView => parseLink({ ...NONE, ...over });
const QR = { payload: qrPayload({ type: 'link' as never }), expiresAt: new Date(Date.now() + 300_000).toISOString() };

describe('link strings', () => {
  it('has the same keys, none empty, in Malay, English and Arabic', () => {
    const ms = Object.keys(LINK_STRINGS.ms).sort();
    for (const l of LANGS) {
      expect(Object.keys(LINK_STRINGS[l]).sort()).toEqual(ms);
      for (const [k, v] of Object.entries(LINK_STRINGS[l])) expect(v.trim(), `${l}.${k}`).not.toBe('');
    }
  });
  it('has a reason for every outcome code and a name for every progress step', () => {
    for (const o of OUTCOME_CODES) expect(LINK_STRINGS.ms[`linkWhy_${o}`], o).toBeTruthy();
    for (const s of PROGRESS_STEPS) expect(LINK_STRINGS.ar[`linkStep_${s}`], s).toBeTruthy();
  });
  it('writes no dash, arrow or approximate sign in any language', () => {
    for (const l of LANGS) for (const v of Object.values(LINK_STRINGS[l])) expect(v).not.toMatch(/[–—→←≈~]/);
  });
  it('names the product box "MAXCOM Kiosk Box", never "kotak", and has the too-many-viewers line', () => {
    for (const l of LANGS) {
      for (const [k, v] of Object.entries(LINK_STRINGS[l])) expect(v, `${l}.${k}`).not.toMatch(/kotak/i);
      expect(LINK_STRINGS[l].linkQrTitle, l).toContain('MAXCOM Kiosk Box');
      expect(LINK_STRINGS[l].liveTooManyViewers!.trim(), l).not.toBe('');
    }
    expect(LINK_STRINGS.ms.linkMasterWord).toBe('MAXCOM Kiosk Box utama');
  });
  it('keeps every placeholder in every language', () => {
    for (const k of Object.keys(LINK_STRINGS.ms)) {
      const slots = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
      for (const l of LANGS) expect(slots(LINK_STRINGS[l][k]!), `${l}.${k}`).toBe(slots(LINK_STRINGS.ms[k]!));
    }
  });
});

describe('what the page shows', () => {
  it('nothing for a normal box and for a cookie TV answer', () => {
    expect(linkScreenOf(null, Date.now())).toBeNull();
    expect(linkScreenOf(link(), Date.now())).toBeNull();
    expect(linkScreenOf(parseLink({ mode: 'main', master: null, qr: null, step: null, code: null, progress: null, last: null }), Date.now())).toBeNull();
    expect(linkScreenOf(parseLink('rubbish'), Date.now())).toBeNull();
    expect(linkScreenOf(parseLink({ qr: { payload: 3 } }), Date.now())).toBeNull();
  });
  it('picks the state from the answer', () => {
    const now = Date.now();
    expect(linkScreenOf(link({ qr: QR }), now)).toBe('qr');
    expect(linkScreenOf(link({ step: 'code', code: '482193', peer: { name: 'Dewan Utama' } }), now)).toBe('code');
    expect(linkScreenOf(link({ step: 'questions' }), now)).toBe('wait');
    expect(linkScreenOf(link({ step: 'agreed' }), now)).toBe('wait');
    expect(linkScreenOf(link({ step: 'working' }), now)).toBe('progress');
    expect(linkScreenOf(link({ progress: { step: 'people', stepNo: 2, steps: 4, percent: null } }), now)).toBe('progress');
    const fin = (ms: number, outcome: string) => ({ outcome, finishedAt: new Date(now - ms).toISOString() });
    expect(linkScreenOf(link({ last: fin(5_000, 'linked') }), now)).toBe('done');
    expect(linkScreenOf(link({ last: fin(5_000, 'rejected') }), now)).toBe('ended');
    expect(linkScreenOf(link({ last: fin(25_000, 'linked') }), now)).toBeNull();
    expect(linkScreenOf(link({ last: fin(25_000, 'failed') }), now)).toBeNull();
  });
  it('leaves a finished link by itself after 20 s on the box clock', () => {
    const fin = { outcome: 'cancelled', finishedAt: '2026-11-22T10:00:00.000Z' };
    const at = Date.parse(fin.finishedAt);
    expect(linkScreenOf(link({ last: fin }), at + 19_000)).toBe('ended');
    expect(linkScreenOf(link({ last: fin }), at + 21_000)).toBeNull();
  });
  it('an unknown outcome falls back to the generic line', () => {
    expect(reasonKeyOf('something_new')).toBe('linkWhy_generic');
    expect(reasonKeyOf(null)).toBe('linkWhy_generic');
    expect(reasonKeyOf('expired')).toBe('linkWhy_expired');
    const { container } = render(
      <Link lang="en" kind="ended" view={link({ last: { outcome: 'something_new', finishedAt: new Date().toISOString() } })} offsetMs={0} />,
    );
    expect(container.textContent).toContain(tl('linkWhy_generic', 'en'));
    expect(container.textContent).toContain('Link cancelled');
  });
});

describe('each state, in every language', () => {
  const cases: { name: string; kind: Parameters<typeof Link>[0]['kind']; view: LinkView; keys: string[] }[] = [
    { name: 'qr', kind: 'qr', view: link({ qr: QR }), keys: ['linkQrLead'] },
    { name: 'code', kind: 'code', view: link({ step: 'code', code: '482193', peer: { name: 'Dewan Utama' } }), keys: ['linkCodeTitle', 'linkCodeHint'] },
    { name: 'wait', kind: 'wait', view: link({ step: 'questions' }), keys: ['linkWaitTitle'] },
    {
      name: 'progress',
      kind: 'progress',
      view: link({ progress: { step: 'people', stepNo: 2, steps: 4, percent: 40 } }),
      keys: ['linkProgressTitle', 'linkStep_people'],
    },
    { name: 'done', kind: 'done', view: link({ last: { outcome: 'linked', finishedAt: new Date().toISOString() } }), keys: ['linkDoneTitle'] },
    { name: 'ended', kind: 'ended', view: link({ last: { outcome: 'expired', finishedAt: new Date().toISOString() } }), keys: ['linkEndedTitle', 'linkWhy_expired'] },
    { name: 'connecting', kind: 'connecting', view: link({ mode: 'follower', master: { name: 'Surau Al-Hidayah' } }), keys: ['linkConnectingSub'] },
  ];
  for (const c of cases) {
    for (const lang of LANGS) {
      it(`${c.name} in ${lang}`, () => {
        const r = render(<Link lang={lang} kind={c.kind} view={c.view} offsetMs={0} />);
        const text = r.container.textContent ?? '';
        for (const k of c.keys) expect(text).toContain(tl(k, lang));
        const root = r.container.querySelector('[data-screen="link"]')!;
        expect(root.getAttribute('dir')).toBe(lang === 'ar' ? 'rtl' : 'ltr');
        expect(root.getAttribute('lang')).toBe(lang);
      });
    }
  }
  it('the code is in two groups, read left to right, in Arabic too', () => {
    const r = render(<Link lang="ar" kind="code" view={link({ step: 'code', code: '482193', peer: { name: 'Dewan Utama' } })} offsetMs={0} />);
    const span = r.getByTestId('link-code').querySelector('span')!;
    expect(span.textContent).toBe('482 193');
    expect(span.getAttribute('dir')).toBe('ltr');
    expect(r.container.querySelector('[data-screen="link"]')!.getAttribute('dir')).toBe('rtl');
    expect(r.container.textContent).toContain('Dewan Utama');
  });
  it('progress says the step number and the percent', () => {
    const r = render(<Link lang="ms" kind="progress" view={link({ progress: { step: 'people', stepNo: 2, steps: 4, percent: 40 } })} offsetMs={0} />);
    expect(r.getByTestId('link-step').textContent).toBe('Langkah 2 daripada 4');
    expect(r.container.textContent).toContain('40%');
    cleanup();
    const w = render(<Link lang="en" kind="progress" view={link({ step: 'working' })} offsetMs={0} />);
    expect(w.container.textContent).toContain('Linking the MAXCOM Kiosk Boxes');
    expect(w.container.textContent).not.toContain('%');
  });
  it('connecting names the main box', () => {
    const r = render(<Link lang="ms" kind="connecting" view={null} offsetMs={0} masterName="Surau Al-Hidayah" />);
    expect(r.container.textContent).toContain('Menyambung ke Surau Al-Hidayah');
  });
});

describe('the unlink and the store move', () => {
  it('reads the unlink field defensively', () => {
    expect(link().unlink).toBeNull();
    expect(link({ unlink: { step: 'bogus' } }).unlink).toBeNull();
    expect(link({ unlink: { step: 'copy', percent: 'x' } }).unlink).toEqual({ step: 'copy', percent: null });
    expect(link({ unlink: { step: 'carry-on', percent: 30 } }).unlink).toEqual({ step: 'carry-on', percent: 30 });
  });
  it('an unlink takes the screen; done only on a follower', () => {
    const now = Date.now();
    expect(linkScreenOf(link({ unlink: { step: 'back', percent: null } }), now)).toBe('unlink');
    expect(linkScreenOf(link({ unlink: { step: 'done', percent: null } }), now)).toBeNull();
    expect(linkScreenOf(link({ mode: 'follower', unlink: { step: 'done', percent: null } }), now)).toBe('unlink');
    expect(linkIntervalFor(link({ unlink: { step: 'copy', percent: 5 } }))).toBe(2_000);
  });
  const steps: [string, string][] = [
    ['copy', 'unlinkStep_copy'],
    ['back', 'unlinkStep_back'],
    ['carry-on', 'unlinkStep_carry_on'],
    ['empty', 'unlinkStep_empty'],
  ];
  for (const lang of LANGS) {
    for (const [step, key] of steps) {
      it(`${step} in ${lang}`, () => {
        const r = render(<Link lang={lang} kind="unlink" view={link({ unlink: { step, percent: 62 } })} offsetMs={0} />);
        expect(r.getByTestId('unlink-step').textContent).toBe(tl(key, lang));
        const pct = r.getByTestId('unlink-pct');
        expect(pct.textContent).toBe('62%');
        expect(pct.getAttribute('dir')).toBe('ltr');
      });
    }
    it(`done on a follower in ${lang}`, () => {
      const r = render(<Link lang={lang} kind="unlink" view={link({ mode: 'follower', unlink: { step: 'done', percent: null } })} offsetMs={0} />);
      expect(r.container.textContent).toContain(tl('unlinkDoneBody', lang));
    });
    it(`the store move shows its percent in ${lang}`, () => {
      const r = render(<Link lang={lang} kind="progress" view={link({ progress: { step: 'commit', stepNo: 3, steps: 4, percent: 62 } })} offsetMs={0} />);
      const t = r.getByTestId('link-move');
      expect(t.textContent).toContain('62%');
      expect(t.textContent).toContain(tl('linkStep_move', lang, { pct: '62%' }).replace('62%', ''));
    });
  }
  it('says the Malay lines the plan gives', () => {
    expect(LINK_STRINGS.ms.unlinkStep_copy).toBe('Menyalin data sekarang');
    expect(LINK_STRINGS.ms.unlinkDoneBody).toBe('Pautan diputuskan. Pentadbir Box ini: imbas kod untuk menyambung.');
    expect(LINK_STRINGS.ms.linkStep_move).toBe('Memindahkan data, {pct}');
  });
});

describe('the countdown follows the box clock', () => {
  it('counts against the server offset, not the TV clock alone', () => {
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    // The box is two minutes ahead of this TV: three minutes are left, not five.
    const a = render(<LinkQr payload={QR.payload} expiresAt={expiresAt} offsetMs={120_000} rem={30} lang="ms" />);
    expect(a.getByTestId('link-countdown').textContent).toContain('03:00');
    cleanup();
    const b = render(<LinkQr payload={QR.payload} expiresAt={expiresAt} offsetMs={0} rem={30} lang="ms" />);
    expect(b.getByTestId('link-countdown').textContent).toContain('05:00');
    cleanup();
    const c = render(<LinkQr payload={QR.payload} expiresAt={expiresAt} offsetMs={-60_000} rem={30} lang="en" />);
    expect(c.getByTestId('link-countdown').textContent).toContain('06:00');
  });
  it('shows the renewing line once the box clock passes the end', () => {
    const r = render(<LinkQr payload={QR.payload} expiresAt={new Date(Date.now() + 30_000).toISOString()} offsetMs={60_000} rem={30} lang="en" />);
    expect(r.container.textContent).toContain(tl('linkQrRenewing', 'en'));
    expect(r.queryByTestId('link-countdown')).toBeNull();
  });
  it('reads the offset from the body time, else the Date header, else zero', () => {
    expect(offsetFromAnswer('2026-11-22T10:00:10.000Z', null, Date.parse('2026-11-22T10:00:00.000Z'))).toBe(10_000);
    expect(offsetFromAnswer(undefined, 'Sun, 22 Nov 2026 10:00:05 GMT', Date.parse('2026-11-22T10:00:00.000Z'))).toBe(5_000);
    expect(offsetFromAnswer(undefined, null, 1)).toBe(0);
    expect(offsetFromAnswer('nonsense', 'nonsense', 1)).toBe(0);
    expect(secondsLeftAt('2026-11-22T10:05:00.000Z', Date.parse('2026-11-22T10:02:00.000Z'))).toBe(180);
    expect(secondsLeftAt('bad', 0)).toBeNull();
  });
});

describe('the poller', () => {
  it('asks every 5 s, every 2 s while a session or a code is up', () => {
    expect(linkIntervalFor(null)).toBe(5_000);
    expect(linkIntervalFor(link())).toBe(5_000);
    expect(linkIntervalFor(link({ qr: QR }))).toBe(2_000);
    expect(linkIntervalFor(link({ step: 'questions' }))).toBe(2_000);
    expect(linkIntervalFor(link({ last: { outcome: 'linked', finishedAt: 'x' } }))).toBe(5_000);
  });

  function Probe({ f, out }: { f: typeof fetch; out: LinkResult[] }) {
    out.push(useLinkState({ fetchImpl: f }));
    return <div />;
  }
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });

  it('speeds up when a session starts, slows down when it ends', async () => {
    vi.useFakeTimers();
    const answers = [NONE, { ...NONE, step: 'questions' }, { ...NONE, step: 'questions' }, NONE, NONE];
    let n = 0;
    const f = vi.fn(async () => json(answers[Math.min(n++, answers.length - 1)]));
    const out: LinkResult[] = [];
    render(<Probe f={f as unknown as typeof fetch} out={out} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1); // idle answer: next poll in 5 s
    await vi.advanceTimersByTimeAsync(4_900);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(f).toHaveBeenCalledTimes(2); // a session is up: every 2 s
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f).toHaveBeenCalledTimes(4); // the session ended: back to 5 s
    await vi.advanceTimersByTimeAsync(4_000);
    expect(f).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(f).toHaveBeenCalledTimes(5);
  });

  it('stops while the page is hidden and asks again when it is back', async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => json(NONE));
    const out: LinkResult[] = [];
    render(<Probe f={f as unknown as typeof fetch} out={out} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1);
    const set = (v: string) => Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
    set('hidden');
    await vi.advanceTimersByTimeAsync(5_100); // the pending poll fires, sees the page hidden, does not ask
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f).toHaveBeenCalledTimes(1);
    set('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(2);
    set('visible');
  });

  it('keeps the last good answer when a poll fails', async () => {
    vi.useFakeTimers();
    let n = 0;
    const f = vi.fn(async () => {
      if (n++ === 1) throw new Error('net');
      return json({ ...NONE, step: 'questions' });
    });
    const out: LinkResult[] = [];
    render(<Probe f={f as unknown as typeof fetch} out={out} />);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_100);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(f.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(out[out.length - 1]!.view?.step).toBe('questions');
  });
});

describe('follower marks', () => {
  it('reads the fields defensively: a box that sends none is a normal box', () => {
    const none = followerInfoOf(boxView({ state: 'active' }));
    expect(none).toEqual({ follower: false, masterName: null, away: false, needsUpdate: false });
    expect(followerInfoOf(null).away).toBe(false);
    const bad = followerInfoOf({ ...boxView(), mode: 'follower', master: 7, awayMinutes: 'x', needsUpdate: 'yes' } as never);
    expect(bad).toEqual({ follower: true, masterName: null, away: false, needsUpdate: false });
  });
  it('the away mark comes at 10 minutes', () => {
    const at = (m: number) => followerInfoOf({ ...boxView(), mode: 'follower', master: { name: 'Dewan Utama' }, connected: false, awayMinutes: m } as never);
    expect(at(9).away).toBe(false);
    expect(at(10).away).toBe(true);
    expect(at(10).masterName).toBe('Dewan Utama');
  });
  for (const lang of LANGS) {
    it(`draws both marks in ${lang}, in the corner of its side`, () => {
      const r = render(<FollowerMarks info={{ follower: true, masterName: 'Dewan Utama', away: true, needsUpdate: true }} lang={lang} />);
      expect(r.container.textContent).toContain(tl('linkMasterAway', lang));
      expect(r.container.textContent).toContain(tl('linkNeedsUpdate', lang));
      expect(r.getByTestId('follower-marks').getAttribute('dir')).toBe(lang === 'ar' ? 'rtl' : 'ltr');
    });
  }
  it('draws nothing when there is nothing to say', () => {
    const r = render(<FollowerMarks info={{ follower: true, masterName: null, away: false, needsUpdate: false }} lang="ms" />);
    expect(r.queryByTestId('follower-marks')).toBeNull();
  });
});

describe('the setup screen', () => {
  const setupView = makeView('2026-11-03', '15:52');
  const box = boxView({ state: 'setup', qr: { payload: qrPayload(), expiresAt: new Date(Date.now() + 300_000).toISOString() } });
  for (const lang of LANGS) {
    it(`keeps its QR and says the link line in ${lang}; the link QR comes with the labels`, () => {
      const without = render(<Setup box={box} view={setupView} lang={lang} />);
      expect(without.container.textContent).toContain(tl('setupHasMaxcom', lang));
      expect(without.queryByTestId('link-qr')).toBeNull();
      expect(without.getByTestId('qr-card')).toBeTruthy();
      cleanup();
      const withQr = render(<Setup box={box} view={setupView} lang={lang} link={link({ qr: QR })} linkOffsetMs={0} />);
      expect(withQr.getByTestId('link-qr')).toBeTruthy();
      expect(withQr.getByTestId('qr-card')).toBeTruthy();
      expect(withQr.container.textContent).toContain(tl('setupNewSurau', lang));
      expect(withQr.container.textContent).toContain(tl('setupExisting', lang));
    });
  }
});

describe('the whole page', () => {
  const stateView = (extra: object = {}) => ({ ...boxView({ state: 'active' }), ...extra });
  function stubBox(box: object, linkAnswer: object) {
    const f = vi.fn(async (url: string) => {
      if (url === '/api/box/state') return json(box);
      if (url === '/api/kiosk/link') return json(linkAnswer);
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', f);
    return f;
  }
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });

  it('a normal box with no session stays as it was', async () => {
    holder.view = makeView('2026-11-03', '15:52');
    const f = stubBox(stateView(), NONE);
    const r = render(<App />);
    await waitFor(() => expect(f.mock.calls.some((c) => c[0] === '/api/kiosk/link')).toBe(true));
    await waitFor(() => expect(f.mock.calls.some((c) => c[0] === '/api/box/state')).toBe(true));
    await new Promise((res) => setTimeout(res, 30));
    expect(r.container.querySelector('[data-screen="link"]')).toBeNull();
    expect(r.queryByTestId('follower-marks')).toBeNull();
    expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).not.toBe('link');
  });

  it('a matching code takes the screen on the box that is set up', async () => {
    holder.view = makeView('2026-11-03', '15:52');
    stubBox(stateView(), { ...NONE, step: 'code', code: '482193', peer: { name: 'Dewan Utama' } });
    const r = render(<App />);
    await waitFor(() => expect(r.container.querySelector('[data-screen="link"]')).not.toBeNull());
    expect(r.getByTestId('link-code').textContent).toBe('482 193');
  });

  it('a follower shows the away mark after 10 minutes, and no full screen', async () => {
    holder.view = makeView('2026-11-03', '15:52');
    stubBox(stateView({ mode: 'follower', master: { name: 'Dewan Utama' }, connected: false, awayMinutes: 12, needsUpdate: true }), NONE);
    const r = render(<App />);
    await waitFor(() => expect(r.queryByTestId('follower-marks')).not.toBeNull());
    expect(r.container.querySelector('[data-mark="away"]')).not.toBeNull();
    expect(r.container.querySelector('[data-mark="update"]')).not.toBeNull();
    expect(r.container.querySelector('[data-screen="link"]')).toBeNull();
  });

  it('a follower away for under 10 minutes shows no mark', async () => {
    holder.view = makeView('2026-11-03', '15:52');
    const f = stubBox(stateView({ mode: 'follower', master: { name: 'Dewan Utama' }, connected: false, awayMinutes: 4 }), NONE);
    const r = render(<App />);
    await waitFor(() => expect(f.mock.calls.some((c) => c[0] === '/api/box/state')).toBe(true));
    await new Promise((res) => setTimeout(res, 30));
    expect(r.queryByTestId('follower-marks')).toBeNull();
  });

  it('a follower with nothing stored says whom it is connecting to', async () => {
    holder.view = makeView('2026-11-03', '15:52', { days: [] });
    stubBox(stateView({ mode: 'follower', master: { name: 'Surau Al-Hidayah' } }), { ...NONE, mode: 'follower', master: { name: 'Surau Al-Hidayah' } });
    const r = render(<App />);
    await waitFor(() => expect(r.container.querySelector('[data-kind="connecting"]')).not.toBeNull());
    expect(r.container.textContent).toContain('Menyambung ke Surau Al-Hidayah');
  });
});
