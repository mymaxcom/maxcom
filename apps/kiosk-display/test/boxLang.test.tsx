import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
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
import { BOX_LANG_KEY, readBoxLang, useBoxLang, writeBoxLang } from '../src/data/boxLang.ts';
import { AR, tb, tbx } from '../src/i18n-box.ts';
import { STRINGS } from '../src/i18n.ts';
import { nextFocus } from '../src/ui/LangSwitch.tsx';
import { nextNetFocus } from '../src/screens/NetCheck.tsx';
import { BoxClock, fmtAtBox } from '../src/screens/BoxChrome.tsx';

/** Every Malay box-screen key, for the test that Arabic covers them all. */
const BOX_KEY_PATTERN = /^(setup|recovery|locked|net|pair(?!Badge)|boxLang)/;
const boxKeys = (): string[] => Object.keys(STRINGS.ms).filter((k) => BOX_KEY_PATTERN.test(k));

const expiresAt = '2026-11-03T08:01:41Z';
const setupBox = () => boxView({ qr: { payload: qrPayload(), expiresAt } });
function show(box: BoxStateView | null, view: KioskView = makeView('2026-11-03', '15:52')) {
  holder.box = box;
  holder.view = view;
  return render(<App />);
}
const press = (key: string) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key }));
  window.dispatchEvent(new KeyboardEvent('keyup', { key }));
};
const opt = (r: ReturnType<typeof render>, l: string) => r.container.querySelector(`.langswitch__opt[data-lang="${l}"]`)!;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-03T07:52:00Z'));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

describe('box-screen strings', () => {
  it('Arabic covers every box-screen key, with nothing empty', () => {
    const keys = boxKeys();
    expect(keys.length).toBeGreaterThan(70);
    const missing = keys.filter((k) => !(k in AR) || AR[k]!.trim() === '');
    expect(missing).toEqual([]);
  });

  it('every Arabic key is also a Malay and English key, with the same placeholders', () => {
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
    for (const [k, ar] of Object.entries(AR)) {
      expect(STRINGS.ms[k], k).toBeTruthy();
      expect(STRINGS.en[k], k).toBeTruthy();
      // The Arabic pairing line names the menu path as a value; the others carry it in the text.
      if (k !== 'pairInstruction') expect(vars(ar), k).toBe(vars(STRINGS.ms[k]!));
    }
  });

  it('product names stay in Latin letters in Arabic', () => {
    expect(AR.setupLead).toContain('MAX Admin Client');
    expect(AR.setupTitle).toContain('MAXCOM');
  });

  it('Malay and English come from the kiosk strings unchanged', () => {
    expect(tb('setupTitle', 'ms')).toBe('Sediakan MAXCOM ini');
    expect(tb('setupTitle', 'en')).toBe('Set up this MAXCOM');
    expect(tb('setupTitle', 'ar')).toBe(AR.setupTitle);
  });

  it('isolates filled-in values in Arabic only', () => {
    expect(tbx('lockedId', 'ms', { id: '4F2A 9C1E' })).toBe('ID: 4F2A 9C1E');
    const r = render(<p>{tbx('lockedId', 'ar', { id: '4F2A 9C1E' })}</p>);
    const bdi = r.container.querySelector('bdi')!;
    expect(bdi.getAttribute('dir')).toBe('ltr');
    expect(bdi.textContent).toBe('4F2A 9C1E');
  });

  it('writes Arabic times with ص / م and keeps the kiosk words otherwise', () => {
    expect(fmtAtBox('2026-11-03T07:51:00Z', '12h', 'ar')).toBe('3:51 م');
    expect(fmtAtBox('2026-11-03T07:51:00Z', '12h', 'ms')).toBe('3:51 PTG');
    expect(fmtAtBox('2026-11-03T07:51:00Z', '24h', 'ar')).toBe('15:51');
    expect(fmtAtBox(null, '12h', 'ar')).toBeNull();
  });
});

describe('remembering the choice', () => {
  it('reads and writes the display key', () => {
    expect(readBoxLang()).toBeNull();
    writeBoxLang('ar');
    expect(localStorage.getItem(BOX_LANG_KEY)).toBe('ar');
    expect(readBoxLang()).toBe('ar');
    localStorage.setItem(BOX_LANG_KEY, 'fr');
    expect(readBoxLang()).toBeNull();
  });

  it('never throws when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(readBoxLang()).toBeNull();
    expect(() => writeBoxLang('en')).not.toThrow();
    // The screen still works and still switches for this page.
    const r = show(setupBox());
    expect(r.getByText('Sediakan MAXCOM ini')).toBeTruthy();
    fireEvent.click(opt(r, 'en'));
    expect(r.getByText('Set up this MAXCOM')).toBeTruthy();
  });
});

describe('switch on the setup screen', () => {
  it('a fresh box starts in BM, with the switch and the MAXCOM mark', () => {
    const r = show(setupBox());
    expect(r.getByTestId('lang-switch')).toBeTruthy();
    expect(opt(r, 'ms').getAttribute('aria-pressed')).toBe('true');
    expect(opt(r, 'ar').textContent).toBe('عربي');
    expect(r.container.querySelector('[data-role="maxcom-logo"]')).toBeTruthy();
    expect(r.container.querySelector('.box-body')!.getAttribute('dir')).toBe('ltr');
  });

  it('starts in English when the surau has chosen English', () => {
    const r = show(setupBox(), makeView('2026-11-03', '15:52', { settings: { language: { lang: 'en' } } }));
    expect(opt(r, 'en').getAttribute('aria-pressed')).toBe('true');
  });

  it('a click on عربي turns the text side right to left, keeps the QR, and is remembered', () => {
    const r = show(setupBox());
    fireEvent.click(opt(r, 'ar'));
    expect(r.getByText(AR.setupTitle!)).toBeTruthy();
    const body = r.container.querySelector('.box-body')!;
    expect(body.getAttribute('dir')).toBe('rtl');
    expect(body.getAttribute('lang')).toBe('ar');
    expect(r.getByTestId('qr')).toBeTruthy();
    expect(localStorage.getItem(BOX_LANG_KEY)).toBe('ar');
    // The address stays left to right inside the Arabic text.
    expect(r.getByText('https://10.168.1.20:8443').getAttribute('dir')).toBe('ltr');
    cleanup();
    const again = show(setupBox());
    expect(opt(again, 'ar').getAttribute('aria-pressed')).toBe('true');
  });

  it('the remote: up to the switch, left to EN, OK picks it without opening the network check', async () => {
    localStorage.setItem(BOX_LANG_KEY, 'ar');
    const r = show(setupBox());
    const net = () => r.container.querySelector('.box-foot .tvbtn')!;
    expect(net().classList.contains('is-focused')).toBe(true);
    await act(async () => press('ArrowUp'));
    expect(opt(r, 'ar').classList.contains('is-focused')).toBe(true);
    expect(net().classList.contains('is-focused')).toBe(false);
    await act(async () => press('ArrowLeft'));
    expect(opt(r, 'en').classList.contains('is-focused')).toBe(true);
    await act(async () => press('Enter'));
    expect(opt(r, 'en').getAttribute('aria-pressed')).toBe('true');
    expect(r.container.querySelector('.netcheck')).toBeNull();
    // Down returns to the button, and OK opens the check as before.
    await act(async () => press('ArrowDown'));
    expect(net().classList.contains('is-focused')).toBe(true);
    await act(async () => press('Enter'));
    expect(r.container.querySelector('.netcheck')).toBeTruthy();
  });

  it('OK with no arrow pressed still opens the network check', async () => {
    const r = show(setupBox());
    await act(async () => press('Enter'));
    expect(r.container.querySelector('.netcheck')).toBeTruthy();
  });
});

describe('the main program keeps the surau language', () => {
  it('an active box ignores the box-screen choice', () => {
    localStorage.setItem(BOX_LANG_KEY, 'ar');
    const r = show(boxView({ state: 'active' }));
    expect(r.container.querySelector('.screen--main')).toBeTruthy();
    expect(r.queryByTestId('lang-switch')).toBeNull();
    expect(r.container.querySelector('[lang="ar"]')).toBeNull();
    expect(r.container.querySelector('[dir="rtl"]')).toBeNull();
  });

  it('the stopped screen follows the choice', () => {
    localStorage.setItem(BOX_LANG_KEY, 'ar');
    const r = show(boxView({ state: 'locked' }));
    expect(r.getByText(AR.lockedTitle!)).toBeTruthy();
    expect(r.getByTestId('lang-switch').getAttribute('data-tone')).toBe('quiet');
  });
});

describe('focus moves', () => {
  it('walks the switch and the screen button', () => {
    expect(nextFocus('net', 'up', true, 'ms')).toBe('ms');
    expect(nextFocus('net', 'right', true, 'en')).toBe('en');
    expect(nextFocus('ms', 'left', true, 'ms')).toBe('ms');
    expect(nextFocus('ms', 'right', true, 'ms')).toBe('en');
    expect(nextFocus('ar', 'right', true, 'ms')).toBe('ar');
    expect(nextFocus('en', 'down', true, 'ms')).toBe('net');
    expect(nextFocus('en', 'down', false, 'ms')).toBe('en');
    expect(nextFocus(null, 'down', false, 'ms')).toBeNull();
    expect(nextFocus(null, 'up', false, 'ar')).toBe('ar');
    expect(nextFocus('ar', 'next', true, 'ms')).toBe('net');
    expect(nextFocus('net', 'next', true, 'ms')).toBe('ms');
    expect(nextFocus('ms', 'prev', false, 'ms')).toBe('ar');
  });

  it('the network check keeps left/right on its two buttons and reaches the switch with up', () => {
    expect(nextNetFocus(1, 'left', 'ms', true)).toBe(0);
    expect(nextNetFocus(0, 'right', 'ms', true)).toBe(1);
    expect(nextNetFocus(1, 'up', 'en', true)).toBe('en');
    expect(nextNetFocus('en', 'right', 'en', true)).toBe('ar');
    expect(nextNetFocus('ar', 'down', 'en', true)).toBe(1);
    // Without a switch every arrow swaps the buttons, as before.
    expect(nextNetFocus(1, 'up', 'ms', false)).toBe(0);
    expect(nextNetFocus(0, 'down', 'ms', false)).toBe(1);
  });
});

describe('which language the box screens start in', () => {
  function Probe({ surau, remember }: { surau: 'ms' | 'en'; remember?: boolean }) {
    const [lang, set] = useBoxLang(surau, remember === undefined ? {} : { remember });
    return <button type="button" data-lang={lang} onClick={() => set('ar')} />;
  }
  const probe = (r: ReturnType<typeof render>) => r.container.querySelector('button')!;

  it('a stored ms beats a surau en', () => {
    localStorage.setItem(BOX_LANG_KEY, 'ms');
    const r = render(<Probe surau="en" />);
    expect(probe(r).getAttribute('data-lang')).toBe('ms');
  });

  it('a preview (remember false) reads and writes no storage', () => {
    localStorage.setItem(BOX_LANG_KEY, 'ar');
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const r = render(<Probe surau="en" remember={false} />);
    expect(probe(r).getAttribute('data-lang')).toBe('en');
    fireEvent.click(probe(r));
    expect(probe(r).getAttribute('data-lang')).toBe('ar');
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(localStorage.getItem(BOX_LANG_KEY)).toBe('ar');
  });
});

describe('the Arabic clock', () => {
  const at = (iso: string) => new Date(iso);
  it('draws the afternoon suffix as م and the morning one as ص', () => {
    const pm = render(<BoxClock now={at('2026-11-03T07:51:00Z')} timeFormat="12h" showSeconds={false} lang="ar" />);
    expect(pm.container.querySelector('[lang="ar"]')!.textContent).toBe('م');
    cleanup();
    const am = render(<BoxClock now={at('2026-11-03T01:05:00Z')} timeFormat="12h" showSeconds={false} lang="ar" variant="compact" />);
    expect(am.container.querySelector('[lang="ar"]')!.textContent).toBe('ص');
    cleanup();
    const ms = render(<BoxClock now={at('2026-11-03T07:51:00Z')} timeFormat="12h" showSeconds={false} lang="ms" />);
    expect(ms.container.textContent).toContain('PTG');
  });
});
