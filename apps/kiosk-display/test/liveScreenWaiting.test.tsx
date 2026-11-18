import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { makeView } from './helpers.tsx';
import type { LiveView } from '../src/data/live.ts';
import { LiveScreen } from '../src/screens/LiveScreen.tsx';

const LIVE: LiveView = { live: true, since: '2026-11-05T06:00:00Z', kuliah: null, audio: true, volume: 50, playable: true };
const view = () => makeView('2026-11-05', '14:00', {});

afterEach(cleanup);

describe('LiveScreen waiting card', () => {
  it('shows the card over the picture while waiting, and drops it when waiting clears', () => {
    const r = render(<LiveScreen view={view()} live={{ ...LIVE, waiting: true }} lang="ms" onAir />);
    const card = r.container.querySelector('[data-testid="live-lost"]') as HTMLElement;
    expect(card.textContent).toBe('Siaran akan bersambung sebentar lagi');
    expect(r.container.querySelector('.screen--live')!.getAttribute('data-playing')).toBe('true');
    expect(card.className).toBe('live-screen__lost');
    r.rerender(<LiveScreen view={view()} live={{ ...LIVE, waiting: false }} lang="ms" onAir />);
    expect(r.container.querySelector('[data-testid="live-lost"]')).toBeNull();
  });
  it('the card style is scrimmed, shadowed and has no backdrop-filter', () => {
    const css = readFileSync(resolve(__dirname, '../src/live/live.css'), 'utf8');
    const rule = css.slice(css.indexOf('.live-screen__lost {'), css.indexOf('}', css.indexOf('.live-screen__lost {')));
    expect(rule).toContain('rgba(0, 0, 0');
    expect(rule).toContain('text-shadow');
    expect(rule).not.toContain('backdrop-filter');
  });
  it('no card when the flag is absent', () => {
    const r = render(<LiveScreen view={view()} live={LIVE} lang="ms" onAir />);
    expect(r.container.querySelector('[data-testid="live-lost"]')).toBeNull();
  });
});
