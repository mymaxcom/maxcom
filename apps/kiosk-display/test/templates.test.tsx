import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { KIOSK_TEMPLATE_IDS } from '@surau/core';
import { makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';

const holder = vi.hoisted(() => ({ view: null as unknown as KioskView }));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));

import { App } from '../src/app.tsx';
import { templateOf } from '../src/templates.ts';

function show(view: KioskView) {
  holder.view = view;
  return render(<App />);
}
const stage = (r: ReturnType<typeof render>) => r.container.querySelector('.stage') as HTMLElement;

afterEach(() => cleanup());

describe('presentation templates: data-template on the stage', () => {
  it('the default template is the current look: data-template="default" and the tone variables inline', () => {
    const r = show(makeView('2026-11-03', '15:52'));
    expect(stage(r).getAttribute('data-template')).toBe('default');
    expect(stage(r).style.getPropertyValue('--accent')).toBe('#f0c97a');
    expect(stage(r).style.getPropertyValue('--glass-rgb')).toBe('6 48 43');
  });

  it('follows the setting for every template; a non-default one carries no inline tone (its stylesheet owns the colours)', () => {
    for (const id of KIOSK_TEMPLATE_IDS) {
      const r = show(makeView('2026-11-03', '15:52', { settings: { kioskTemplate: { templateId: id } } }));
      expect(stage(r).getAttribute('data-template'), id).toBe(id);
      expect(stage(r).style.getPropertyValue('--accent') !== '', id).toBe(id === 'default');
      cleanup();
    }
  });

  it('a phase screen carries the template too (iqamah at 16:25)', () => {
    const r = show(makeView('2026-11-03', '16:25', { settings: { kioskTemplate: { templateId: 'oldschool' } } }));
    expect(stage(r).getAttribute('data-phase')).toBe('iqamah');
    expect(stage(r).getAttribute('data-template')).toBe('oldschool');
    expect(r.container.querySelector('.screen--phase')).toBeTruthy();
  });

  it('an unknown or missing value falls back to default', () => {
    const v = makeView('2026-11-03', '15:52');
    (v.settings.kioskTemplate as { templateId: unknown }).templateId = 'neon';
    let r = show(v);
    expect(stage(r).getAttribute('data-template')).toBe('default');
    expect(stage(r).style.getPropertyValue('--accent')).toBe('#f0c97a');
    cleanup();
    // An older box sends no kioskTemplate feature at all.
    const old = makeView('2026-11-03', '15:52');
    delete (old.settings as Partial<KioskView['settings']>).kioskTemplate;
    r = show(old);
    expect(stage(r).getAttribute('data-template')).toBe('default');
  });

  it('templateOf: known ids pass, anything else is default (prototype keys included)', () => {
    for (const id of KIOSK_TEMPLATE_IDS) expect(templateOf({ templateId: id, enabled: true })).toBe(id);
    for (const bad of [undefined, null, 5, '', 'Default', 'toString', '__proto__', { templateId: 'x' }]) {
      expect(templateOf(bad === undefined || bad === null ? bad : { templateId: bad, enabled: true } as never)).toBe('default');
    }
    // A switched-off feature is the default look.
    expect(templateOf({ templateId: 'creative', enabled: false })).toBe('default');
  });
});

describe('presentation templates: the stylesheet', () => {
  const file = ['src/templates.css', 'apps/kiosk-display/src/templates.css'].map((p) => resolve(process.cwd(), p)).find(existsSync);
  const css = file ? readFileSync(file, 'utf8') : '';
  /** Every top-level selector (comments and @-rule wrappers stripped). */
  const selectors = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@media[^{]*\{/g, '')
    .split('}')
    .map((b) => b.split('{')[0]!.trim())
    .filter((s) => s !== '' && !s.startsWith('@') && !/^(from|to|\d+%)/.test(s));

  it('exists and is imported once by the app', () => {
    expect(file).toBeTruthy();
    const app = readFileSync(resolve(file!, '../app.tsx'), 'utf8');
    expect(app.match(/import '\.\/templates\.css';/g)?.length).toBe(1);
  });

  it('never restyles the default: every selector is scoped to one non-default template', () => {
    expect(selectors.length).toBeGreaterThan(40);
    const others = KIOSK_TEMPLATE_IDS.filter((id) => id !== 'default');
    /** A selector list split on its top-level commas (`:is(a, b)` stays whole). */
    const parts = (list: string): string[] => {
      const out: string[] = [];
      let depth = 0;
      let cur = '';
      for (const ch of list) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
      }
      out.push(cur.trim());
      return out;
    };
    for (const list of selectors) {
      for (const sel of parts(list)) {
        const m = sel.match(/^\.stage\[data-template='([a-z]+)'\]/);
        expect(m, sel).toBeTruthy();
        expect(others, sel).toContain(m![1]);
      }
    }
  });

  it('styles every non-default template, and none loads anything from outside', () => {
    for (const id of KIOSK_TEMPLATE_IDS.filter((x) => x !== 'default')) {
      expect(css, id).toContain(`.stage[data-template='${id}'] {`);
      expect(css, id).toMatch(new RegExp(`\\.stage\\[data-template='${id}'\\] \\.bg__img`));
    }
    expect(css).not.toMatch(/url\(\s*['"]?(https?:|\/\/)/);
    expect(css).not.toMatch(/@import/);
  });
});
