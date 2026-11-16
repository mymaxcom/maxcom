import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkScreenHealth, boxUiRectOk, contrastFails, opacityFails, minContrastOver, MUST_MIN_REM } from '../src/themes/health.ts';
import type { ElMetrics, MustMetrics } from '../src/themes/health.ts';
import { PROTECTED_CSS } from '../src/themes/protectedCss.ts';

// Round 2: the protected rules pin the box's own overlays and the text parts; the health check looks at every
// `data-must` part (rendered, non-empty, big enough, inside the screen, on top at five points, readable).
const vp = { width: 1920, height: 1080 };
const must = (over: Partial<MustMetrics> = {}): MustMetrics => ({
  displayed: true, hasText: true, visible: true, opacity: 1, rect: { left: 100, top: 100, right: 300, bottom: 160 }, fontRem: 3, covered: false, textHidden: false, contrast: 8, picture: false, transformed: false, ...over,
});
const role = (over: Partial<ElMetrics> = {}): ElMetrics => ({
  displayed: true, visible: true, opacity: 1, rect: { left: 10, top: 10, right: 600, bottom: 200 }, fontRem: 10, heightRem: 4, covered: false, textHidden: false, contrast: 7, musts: [must()], cells: null, ...over,
});
function run(roleName: 'clock' | 'prayers' | 'next' | 'countdown', m: ElMetrics) {
  const stage = document.createElement('div');
  const el = document.createElement('div');
  el.setAttribute('data-role', roleName);
  stage.appendChild(el);
  // 'tiada-data' needs the clock only; 'azan' needs clock and countdown. Use the screens that need exactly the role under test.
  const screen = roleName === 'clock' ? 'tiada-data' : 'biasa';
  const others = new Map<string, ElMetrics>();
  if (screen === 'biasa') {
    for (const r of ['clock', 'prayers', 'next']) {
      if (r === roleName) continue;
      const o = document.createElement('div');
      o.setAttribute('data-role', r);
      stage.appendChild(o);
      others.set(r, role());
    }
  }
  return checkScreenHealth(stage, screen, { logoSet: false, base: 'creative', viewport: vp, measure: (e) => (e === el ? m : others.get(e.getAttribute('data-role')!)!) });
}

describe('data-must parts are checked one by one', () => {
  it('all parts fine passes', () => {
    expect(run('clock', role()).ok).toBe(true);
  });
  it('N2: a hidden part (display none on a child) fails the role', () => {
    expect(run('clock', role({ musts: [must(), must({ displayed: false })] })).ok).toBe(false);
  });
  it('a role with no data-must part at all fails (the parts cannot be hidden by deleting them)', () => {
    expect(run('clock', role({ musts: [] })).ok).toBe(false);
  });
  it('an empty part fails', () => {
    expect(run('clock', role({ musts: [must({ hasText: false })] })).ok).toBe(false);
  });
  it('a part below the measured minimum fails', () => {
    expect(run('clock', role({ musts: [must({ fontRem: MUST_MIN_REM - 0.01 })] })).ok).toBe(false);
    expect(run('clock', role({ musts: [must({ fontRem: MUST_MIN_REM })] })).ok).toBe(true);
  });
  it('a part that sticks out of the viewport fails, also by a little', () => {
    expect(run('clock', role({ musts: [must({ rect: { left: 1800, top: 100, right: 1925, bottom: 160 } })] })).ok).toBe(false);
    expect(run('clock', role({ musts: [must({ rect: { left: -20, top: 100, right: 300, bottom: 160 } })] })).ok).toBe(false);
  });
  it('a part that is covered at a corner (N3) fails', () => {
    expect(run('clock', role({ musts: [must({ covered: true })] })).ok).toBe(false);
  });
  it('a part with faded, hidden or unreadable text fails', () => {
    expect(run('clock', role({ musts: [must({ opacity: 0.5 })] })).ok).toBe(false);
    expect(run('clock', role({ musts: [must({ visible: false })] })).ok).toBe(false);
    expect(run('clock', role({ musts: [must({ textHidden: true })] })).ok).toBe(false);
    expect(run('clock', role({ musts: [must({ contrast: 1.2 })] })).ok).toBe(false);
  });
  it('S3: a picture behind a part with no plate (contrast unknown) fails; a known contrast passes', () => {
    expect(run('clock', role({ musts: [must({ contrast: null, picture: true })] })).ok).toBe(false);
    expect(run('clock', role({ musts: [must({ contrast: 4.5, picture: false })] })).ok).toBe(true);
  });
  it('S1: a part that is mirrored, turned or scaled fails', () => {
    expect(run('clock', role({ musts: [must({ transformed: true })] })).ok).toBe(false);
  });
  it('the number of prayer cells must equal the expected number (a hidden cell fails)', () => {
    expect(run('prayers', role({ cells: { expected: 6, rendered: 5 } })).ok).toBe(false);
    expect(run('prayers', role({ cells: { expected: 6, rendered: 6 } })).ok).toBe(true);
  });
});

describe('the box own overlay is exempt only at its expected small size', () => {
  const rect = (w: number, h: number) => ({ left: 0, top: 0, right: w, bottom: h });
  it('the way out to the box in its corner is exempt; the same element grown over the screen is not', () => {
    expect(boxUiRectOk('host-exit', rect(120, 30), 19.2)).toBe(true);
    expect(boxUiRectOk('host-exit', rect(1920, 1080), 19.2)).toBe(false);
  });
  it('the preview ribbon is a thin strip; taller is not exempt', () => {
    expect(boxUiRectOk('preview-ribbon', rect(1920, 30), 19.2)).toBe(true);
    expect(boxUiRectOk('preview-ribbon', rect(1920, 600), 19.2)).toBe(false);
  });
  it('the network check is a whole box screen', () => {
    expect(boxUiRectOk('netcheck', rect(1920, 1080), 19.2)).toBe(true);
  });
});

describe('the contrast fails only when the pack made it worse', () => {
  it('contrastFails', () => {
    expect(contrastFails(2.76, 2.76)).toBe(false); // the base theme alone is already like this
    expect(contrastFails(2.4, 2.76)).toBe(false); // within the allowance
    expect(contrastFails(1.2, 8)).toBe(true); // the pack made the clock unreadable
    expect(contrastFails(2, null)).toBe(true); // nothing to compare with
    expect(contrastFails(5, 12)).toBe(false); // above the floor
    expect(contrastFails(null, 12)).toBe(false);
  });
  it('a part with a low contrast that the base theme has too passes; one the pack ruined fails', () => {
    expect(run('clock', role({ musts: [must({ contrast: 2.7, baseline: 2.76 })] })).ok).toBe(true);
    expect(run('clock', role({ musts: [must({ contrast: 1.1, baseline: 12 })] })).ok).toBe(false);
  });
});

describe('opacity relative to the base theme', () => {
  it('a dimmed screen of the base theme is not the pack, a pack that fades is', () => {
    expect(opacityFails(0.6, 0.6)).toBe(false);
    expect(opacityFails(0.2, 0.6)).toBe(true);
    expect(opacityFails(0.5, undefined)).toBe(true);
    expect(opacityFails(1, 1)).toBe(false);
  });
});

describe('contrast against every stop of a gradient', () => {
  it('the minimum over the candidates counts (S3)', () => {
    const fill: [number, number, number, number] = [200, 200, 200, 1];
    const dark: [number, number, number, number] = [0, 0, 0, 1];
    const light: [number, number, number, number] = [200, 200, 200, 1];
    expect(minContrastOver(fill, [dark])).toBeGreaterThan(8);
    expect(minContrastOver(fill, [dark, light])).toBeLessThan(1.1);
  });
});

describe('protected.css pins the box overlays and the text parts', () => {
  const css = PROTECTED_CSS;
  it.each([
    ['host-exit position', /\.host-exit[^{]*\{[^}]*position: fixed !important/],
    ['host-exit z-index', /\.host-exit[^{]*\{[^}]*z-index: 40 !important/],
    ['host-exit display', /\.host-exit[^{]*\{[^}]*display: flex !important/],
    ['host-exit visibility', /\.host-exit[^{]*\{[^}]*visibility: visible !important/],
    ['host-exit transform', /\.host-exit[^{]*\{[^}]*transform: none !important/],
    ['host-exit width', /\.host-exit[^{]*\{[^}]*width: auto !important/],
    ['preview-ribbon', /\.preview-ribbon[^{]*\{[^}]*z-index: 50 !important/],
    ['netcheck', /\.netcheck[^{]*\{[^}]*visibility: visible !important/],
    ['text security', /-webkit-text-security: none !important/],
    ['text stroke', /-webkit-text-stroke: 0 !important/],
    ['text decoration', /text-decoration: none !important/],
    ['unicode-bidi', /unicode-bidi: normal !important/],
    ['zoom', /zoom: 1 !important/],
    ['marker', /::marker/],
    ['plate', /\[data-must\]\[data-mx-plate\]/],
  ])('%s', (_what, re) => {
    expect(css).toMatch(re);
  });
  it('the readable copy equals the string', () => {
    const norm = (t: string): string => t.split(String.fromCharCode(13)).join('');
    expect(norm(readFileSync(resolve(process.cwd(), 'src/themes/protected.css'), 'utf8'))).toBe(norm(PROTECTED_CSS));
  });
});
