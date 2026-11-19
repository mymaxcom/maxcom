import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';
import { STRINGS } from '../src/i18n.ts';

// W14: the TV language Arabic on every built-in template. jsdom lays nothing out, so the clipping, overflow and font
// checks of the same screens run in Chromium (test/tv-ar-shots.mjs, screenshots at 1920x1080 and the T95's 960x540@2).
// Here: every main phase renders on every template, right to left, in Arabic, with no key left untranslated.

const holder = vi.hoisted(() => ({ view: null as unknown as KioskView }));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));

import { App } from '../src/app.tsx';

const TEMPLATES = ['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic'];
const PHASES: { phase: string; date: string; at: string; title: string }[] = [
  { phase: 'azanCountdown', date: '2026-11-03', at: '16:12', title: 'أذان العصر بعد' },
  { phase: 'masukWaktu', date: '2026-11-03', at: '16:20', title: 'حان الآن وقت صلاة العصر' },
  { phase: 'iqamah', date: '2026-11-03', at: '16:25', title: 'الإقامة بعد' },
  { phase: 'solat', date: '2026-11-03', at: '16:35', title: 'الصلاة قائمة' },
  { phase: 'khutbah', date: '2026-11-06', at: '13:05', title: 'خطبة الجمعة جارية' },
];
const KEYS = new Set(Object.keys(STRINGS.ms));

function show(template: string, date: string, at: string) {
  holder.view = makeView(date, at, { settings: { language: { lang: 'ar' }, kioskTemplate: { templateId: template } } });
  return render(<App />);
}

afterEach(() => cleanup());

describe('TV language Arabic on every template', () => {
  for (const template of TEMPLATES) {
    for (const p of PHASES) {
      it(`${template}: ${p.phase} in Arabic, right to left`, () => {
        const r = show(template, p.date, p.at);
        const stage = r.container.querySelector('.stage')!;
        expect(stage.getAttribute('data-phase')).toBe(p.phase);
        expect(stage.getAttribute('data-template')).toBe(template);
        expect(stage.getAttribute('dir')).toBe('rtl');
        expect(stage.getAttribute('lang')).toBe('ar');
        expect(r.container.querySelector('.phase__title')!.textContent).toBe(p.title);
        // No string key shows as itself, and no Malay prayer word is left in the prayer bar.
        const words = (stage.textContent ?? '').split(/[\s,.:()]+/);
        expect(words.filter((w) => KEYS.has(w) && w.length > 4)).toEqual([]);
        const labels = [...r.container.querySelectorAll('.pcell__label, .pcell-label')].map((e) => e.textContent ?? '');
        expect(labels.length).toBeGreaterThan(0);
        for (const l of labels) expect(l).toMatch(/^[؀-ۿ ]+$/);
      });
    }
    it(`${template}: the main screen in Arabic`, () => {
      const r = show(template, '2026-11-03', '15:52');
      expect(r.container.querySelector('.stage')!.getAttribute('dir')).toBe('rtl');
      expect(r.getByText('العصر بعد')).toBeTruthy();
    });
  }
});

/** A selector list split at its top-level commas (not the ones inside :is()). */
function topLevel(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of sel) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  return [...out, cur];
}

describe('the right-to-left stylesheet', () => {
  const css = readFileSync(resolve(__dirname, '../src/rtl.css'), 'utf8');

  it('is scoped to the Arabic stage and uses no physical left/right', () => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = code.split('}').map((r) => r.trim()).filter((r) => r !== '' && !r.startsWith('@') && !/^(from|to)\b/.test(r));
    for (const r of rules) {
      const sel = r.split('{')[0]!.trim();
      if (sel === '' || /^(from|to)$/.test(sel) || sel.startsWith('@')) continue;
      for (const s of topLevel(sel)) expect(s.trim(), s).toMatch(/^\.stage\[data-lang='ar'\]/);
    }
    expect(code).not.toMatch(/(^|[\s;{])(left|right|margin-left|margin-right|padding-left|padding-right)\s*:/m);
  });

  it("the Arabic face covers the Arabic letters only, from the bundled Amiri files", () => {
    expect(css).toMatch(/font-family: 'MX Arabic'/);
    expect(css).toMatch(/@fontsource\/amiri\/files\/amiri-arabic-400-normal\.woff2/);
    expect(css).toMatch(/@fontsource\/amiri\/files\/amiri-arabic-700-normal\.woff2/);
    expect(css).toMatch(/unicode-range: U\+0600-06FF/);
  });
});

describe('Arabic Art on an Arabic screen and an uploaded theme', () => {
  const css = readFileSync(resolve(__dirname, '../src/rtl.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = css.split('}').map((r) => r.trim()).find((r) => /:is\(\.pcell__label, \.pcell-label, \.chip-k\)\s*\{\s*display:\s*none/.test(r));

  it('hides the small labels on the built-in Arabic Art only, never on a ready pack (they are data-must parts)', () => {
    expect(rule).toBeDefined();
    const sel = rule!.split('{')[0]!;
    expect(sel).toContain("[data-template='arabic']");
    expect(sel).toContain(":not([data-pack='ready'])");
  });

  it('really shows them on a ready pack and hides them on the built-in screen', () => {
    const style = document.createElement('style');
    style.textContent = `${rule!}}`;
    document.head.appendChild(style);
    const stage = (pack: string | null): HTMLElement => {
      const d = document.createElement('div');
      d.className = 'stage';
      d.setAttribute('data-lang', 'ar');
      d.setAttribute('data-template', 'arabic');
      if (pack !== null) d.setAttribute('data-pack', pack);
      d.innerHTML = '<span class="chip-k" data-must="">x</span>';
      document.body.appendChild(d);
      return d;
    };
    const display = (d: HTMLElement): string => getComputedStyle(d.querySelector('.chip-k')!).display;
    const a = stage(null);
    const b = stage('ready');
    const c = stage('failed');
    expect(display(a)).toBe('none');
    expect(display(b)).not.toBe('none');
    expect(display(c)).toBe('none');
    for (const d of [a, b, c]) d.remove();
    style.remove();
  });
});

describe('zoom on the protected parts of an uploaded theme (Chrome 91 rect semantics)', () => {
  it('the protected rules force zoom 1 on everything inside the prayers and next roles, where the Arabic zoom lands', () => {
    const prot = readFileSync(resolve(__dirname, '../src/themes/protected.css'), 'utf8');
    expect(prot).toMatch(/\[data-role='prayers'\]:not\(\[aria-hidden='true'\] \*\) \*,/);
    expect(prot).toMatch(/\[data-role='next'\]:not\(\[aria-hidden='true'\] \*\) \*,/);
    expect(prot).toMatch(/zoom: 1 !important/);
  });
});
