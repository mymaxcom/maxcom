import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';

const holder = vi.hoisted(() => ({ view: null as unknown as KioskView }));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));

import { App } from '../src/app.tsx';

function show(view: KioskView) {
  holder.view = view;
  return render(<App />);
}
const stage = (r: ReturnType<typeof render>) => r.container.querySelector('.stage') as HTMLElement;
const ID = 'c'.repeat(64);
const withStyles = (templateId: string, styles: unknown, at = '15:52') =>
  makeView('2026-11-03', at, { settings: { kioskTemplate: { templateId }, themeStyle: { styles } as never } });

afterEach(() => cleanup());

describe('theme style on the stage', () => {
  it('an empty themeStyle leaves the stage exactly as before', () => {
    const r = show(makeView('2026-11-03', '15:52', { settings: { kioskTemplate: { templateId: 'creative' } } }));
    expect(stage(r).getAttribute('style') ?? '').toBe('');
    expect(stage(r).hasAttribute('data-align')).toBe(false);
    expect(stage(r).hasAttribute('data-bg')).toBe(false);
  });

  it('one-screen values beat all-screen values, on that screen only', () => {
    const styles = { creative: { semua: { accent: '#111111' }, skrin: { iqamah: { accent: '#222222', align: 'tengah' } } } };
    let r = show(withStyles('creative', styles));
    expect(stage(r).style.getPropertyValue('--accent')).toBe('#111111');
    cleanup();
    r = show(withStyles('creative', styles, '16:25'));
    expect(stage(r).style.getPropertyValue('--accent')).toBe('#222222');
    expect(stage(r).getAttribute('data-align')).toBe('center');
  });

  it('values of another theme do not apply', () => {
    const r = show(withStyles('creative', { minimal: { semua: { accent: '#111111' }, skrin: {} } }));
    expect(stage(r).style.getPropertyValue('--accent')).toBe('');
  });

  it('a menu background shows .bg__menu and data-bg; when the picture errors both go and nothing is black', () => {
    const r = show(withStyles('creative', { creative: { semua: { bgImage: ID, bgFit: 'kecil' }, skrin: {} } }));
    expect(r.container.querySelector('.bg__menu')).toBeTruthy();
    expect(stage(r).getAttribute('data-bg')).toBe('image');
    expect(stage(r).style.getPropertyValue('--bg-image')).toBe(`url("/assets/${ID}")`);
    fireEvent.error(r.container.querySelector('.bg__probe') as HTMLElement);
    expect(r.container.querySelector('.bg__menu')).toBeNull();
    expect(stage(r).hasAttribute('data-bg')).toBe(false);
    expect(stage(r).style.getPropertyValue('--bg-image')).toBe('');
  });

  it('the default theme keeps its measured tone and adds the menu accent on top', () => {
    const r = show(withStyles('default', { default: { semua: { accent: '#ff7a98' }, skrin: {} } }));
    expect(stage(r).style.getPropertyValue('--accent')).toBe('#ff7a98');
    expect(stage(r).style.getPropertyValue('--glass-rgb')).toBe('6 48 43');
  });

  it('over a menu picture the stage carries the effective darkness: saved, else the theme default; clamped on the default look', () => {
    let r = show(withStyles('creative', { creative: { semua: { bgImage: ID }, skrin: {} } }));
    expect(stage(r).style.getPropertyValue('--shade')).toBe('0.35');
    cleanup();
    r = show(withStyles('creative', { creative: { semua: { bgImage: ID, shade: 60 }, skrin: {} } }));
    expect(stage(r).style.getPropertyValue('--shade')).toBe('0.6');
    cleanup();
    r = show(withStyles('default', { default: { semua: { bgImage: ID, shade: 5 }, skrin: {} } }));
    expect(stage(r).style.getPropertyValue('--shade')).toBe('0.25');
    cleanup();
    r = show(withStyles('default', { default: { semua: { bgImage: ID }, skrin: {} } }));
    expect(stage(r).style.getPropertyValue('--shade')).toBe('0.55');
  });

  it('without a picture a theme default darkness is not put on the stage; the surau own value is', () => {
    let r = show(withStyles('minimal', {}));
    expect(stage(r).style.getPropertyValue('--shade')).toBe('');
    cleanup();
    r = show(withStyles('minimal', { minimal: { semua: { shade: 12 }, skrin: {} } }));
    expect(stage(r).style.getPropertyValue('--shade')).toBe('0.12');
  });

  it('a menu font sits on the stage (and Old School follows it); kiri is an explicit alignment', () => {
    const r = show(withStyles('oldschool', { oldschool: { semua: { font: 'amiri', align: 'kiri' }, skrin: {} } }));
    expect(stage(r).style.getPropertyValue('--font')).toBe("'Amiri', serif");
    expect(stage(r).style.getPropertyValue('--serif')).toBe("'Amiri', serif");
    expect(stage(r).getAttribute('data-align')).toBe('left');
  });

  it('a picture that failed is hidden, then tried again after a minute', () => {
    vi.useFakeTimers();
    try {
      const view = withStyles('creative', { creative: { semua: { bgImage: ID }, skrin: {} } });
      const r = show(view);
      fireEvent.error(r.container.querySelector('.bg__probe') as HTMLElement);
      expect(r.container.querySelector('.bg__menu')).toBeNull();
      vi.setSystemTime(Date.now() + 61_000);
      r.rerender(<App />);
      expect(r.container.querySelector('.bg__menu')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
