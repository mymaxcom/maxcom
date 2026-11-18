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

describe('boot screen (the first paint, before any surau setting is known)', () => {
  it('says BM at normal size with a small English and a small Arabic line under it', () => {
    const boot = bootDoc().getElementById('boot')!;
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
    expect(html).toMatch(/\.boot-ms \{[^}]*font-size: 4vmin/);
    expect(html).toMatch(/\.boot-en, #boot \.boot-ar \{[^}]*font-size: 2\.8vmin;[^}]*opacity: 0\.7/);
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
