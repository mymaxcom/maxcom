import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup } from '@testing-library/preact';
import { makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';

const holder = vi.hoisted(() => ({ view: null as unknown as KioskView }));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));

const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function bootDoc(): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

const bootLangJs = readFileSync(resolve(__dirname, '../public/boot-lang.js'), 'utf8');
const logoSvg = readFileSync(resolve(__dirname, '../src/assets/brand/maxcom-logo.svg'), 'utf8');

/** Runs the boot language script of index.html against a parsed boot page with `stored` in the display's storage. */
function bootWith(stored: string | null): Document {
  const doc = bootDoc();
  const storage = { getItem: (k: string) => (k === 'mx-tv-lang' ? stored : null) };
  new Function('document', 'localStorage', bootLangJs)(doc, storage);
  return doc;
}

describe('boot screen (the first paint, before any surau setting is known)', () => {
  it('shows the MAXCOM wordmark, inlined (no request), named for a screen reader', () => {
    const logo = bootDoc().querySelector('#boot svg.boot-logo')!;
    expect(logo).toBeTruthy();
    expect(logo.getAttribute('role')).toBe('img');
    expect(logo.getAttribute('aria-label')).toBe('MAXCOM');
    // the same drawing as the brand file: the dome and the letters
    expect(logo.querySelector('#dome')).toBeTruthy();
    expect(logo.querySelector('#letters')).toBeTruthy();
    expect(logoSvg).toContain(logo.querySelector('#dome')!.getAttribute('d')!.slice(0, 60));
  });

  it('with no language known: the three lines, BM first, smaller under the logo', () => {
    const boot = bootWith(null).getElementById('boot')!;
    expect(boot.getAttribute('data-lang')).toBeNull();
    const ms = boot.querySelector('.boot-ms')!;
    const en = boot.querySelector('.boot-en')!;
    const ar = boot.querySelector('.boot-ar')!;
    expect(ms.textContent).toBe('Memuatkan MAXCOM');
    expect(en.textContent).toBe('Loading MAXCOM');
    expect(ar.textContent).toBe('جارٍ تحميل MAXCOM');
    expect(ms.getAttribute('dir')).toBe('ltr');
    expect(ar.getAttribute('dir')).toBe('rtl');
    expect(ar.getAttribute('lang')).toBe('ar');
    // the English and Arabic lines are smaller and muted than the BM line
    expect(html).toMatch(/#boot \.boot-ms \{[^}]*font-size: 2\.6vmin/);
    expect(html).toMatch(/#boot \.boot-en, #boot \.boot-ar \{[^}]*font-size: 2\.2vmin;[^}]*opacity: 0\.7/);
  });

  it('with the last TV language stored: one line in that language', () => {
    for (const [lang, text] of [['ms', 'Memuatkan MAXCOM'], ['en', 'Loading MAXCOM'], ['ar', 'جارٍ تحميل MAXCOM']] as const) {
      const doc = bootWith(lang);
      const boot = doc.getElementById('boot')!;
      expect(boot.getAttribute('data-lang')).toBe(lang);
      expect(doc.documentElement.getAttribute('lang')).toBe(lang);
      expect(boot.querySelector(`.boot-${lang}`)!.textContent).toBe(text);
    }
    // the CSS keeps only that line, at the full size
    expect(html).toMatch(/#boot\[data-lang\] \.boot-line \{[^}]*display: none/);
    expect(html).toMatch(/#boot\[data-lang='ms'\] \.boot-ms, #boot\[data-lang='en'\] \.boot-en, #boot\[data-lang='ar'\] \.boot-ar \{[^}]*display: block;[^}]*font-size: 3vmin/);
  });

  it('a stored value that is not a TV language, or storage that throws, leaves the three lines', () => {
    expect(bootWith('fr').getElementById('boot')!.getAttribute('data-lang')).toBeNull();
    const doc = bootDoc();
    new Function('document', 'localStorage', bootLangJs)(doc, { getItem: () => { throw new Error('denied'); } });
    expect(doc.getElementById('boot')!.getAttribute('data-lang')).toBeNull();
  });

  it('loads the boot language script as a plain (blocking) script right after the boot screen, before the program', () => {
    const at = html.indexOf('<script src="/boot-lang.js"></script>');
    expect(at).toBeGreaterThan(html.indexOf('id="boot"'));
    expect(at).toBeLessThan(html.indexOf('/src/main.tsx'));
    // no inline script: the box's page policy allows scripts from its own origin only
    expect(/<script>(?!<\/script>)/.test(html)).toBe(false);
  });

  it('the kiosk remembers the TV language it shows, for the next boot screen', async () => {
    localStorage.removeItem('mx-tv-lang');
    const { render } = await import('@testing-library/preact');
    const { App } = await import('../src/app.tsx');
    holder.view = makeView('2026-11-03', '15:52', { settings: { language: { lang: 'en' } } });
    render(<App />);
    expect(localStorage.getItem('mx-tv-lang')).toBe('en');
    cleanup();
    holder.view = makeView('2026-11-03', '15:52', { settings: { language: { lang: 'ar' } } });
    render(<App />);
    expect(localStorage.getItem('mx-tv-lang')).toBe('ar');
    cleanup();
    // not before the settings are known
    localStorage.removeItem('mx-tv-lang');
    holder.view = { ...makeView('2026-11-03', '15:52', { settings: { language: { lang: 'en' } } }), ready: false };
    render(<App />);
    expect(localStorage.getItem('mx-tv-lang')).toBeNull();
    localStorage.removeItem('mx-tv-lang');
  });

  it('carries no dash, arrow, approximation sign or Arabic-Indic digit', () => {
    const text = bootDoc().getElementById('boot')!.textContent!;
    expect(/[\u2014\u2013\u2248\u2192\u2190\u0660-\u0669]|->|=>/.test(text)).toBe(false);
  });

  it('is replaced by the program when it starts', async () => {
    holder.view = makeView('2026-11-03', '15:52');
    document.body.innerHTML = bootDoc().body.innerHTML.replace(/<script[\s\S]*?<\/script>/g, '');
    expect(document.getElementById('boot')).not.toBeNull();
    await import('../src/main.tsx');
    expect(document.getElementById('boot')).toBeNull();
    expect(document.querySelector('.stage')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Memuatkan MAXCOM');
  });
});
