import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom lays nothing out, so the live-mode size contract is checked on the stylesheets (like layout.test.ts).
// 1rem = min(1vw, 1.7777vh) = 19.2px on a 1920x1080 TV; 18px there is 0.9375rem, the legibility floor.
function src(file: string): string {
  const hit = [file, `apps/kiosk-display/${file}`].map((p) => resolve(process.cwd(), p)).find(existsSync);
  if (!hit) throw new Error(`${file} not found from ${process.cwd()}`);
  return readFileSync(hit, 'utf8');
}
const styles = src('src/styles.css');
const live = src('src/live/live.css');

/** The body of the first top-level rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const re = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`);
  const m = css.match(re);
  if (!m) throw new Error(`rule not found: ${selector}`);
  return m[2]!;
}
function rem(body: string, prop: string): number {
  const m = body.match(new RegExp(`(^|[\\s;])${prop}:\\s*([\\d.]+)rem`));
  if (!m) throw new Error(`${prop} (rem) not found in: ${body.trim()}`);
  return Number(m[2]);
}
const FLOOR = 18 / 19.2;

describe('live-mode strip: a compact corner badge', () => {
  it('is low, narrow and pinned to the bottom-left of the band (never the middle of the video)', () => {
    const strip = rule(live, '.live-strip');
    expect(strip).toMatch(/grid-area:\s*band/);
    expect(strip).toMatch(/align-self:\s*end/);
    expect(strip).toMatch(/justify-self:\s*start/);
    expect(rem(strip, 'min-height')).toBeLessThanOrEqual(3.2);
    expect(strip).not.toMatch(/min-width:\s*[\d.]+rem/);
    const maxW = strip.match(/max-width:\s*min\(100%,\s*([\d.]+)rem\)/);
    expect(Number(maxW?.[1])).toBeLessThanOrEqual(56);
  });

  it('keeps every line legible across the hall (at least about 18px at 1080p) but small', () => {
    const tag = rem(rule(live, '.live-strip__tag'), 'font-size');
    const who = rem(rule(live, '.live-strip__who'), 'font-size');
    const about = rem(rule(live, '.live-strip__about'), 'font-size');
    for (const size of [tag, who, about]) {
      expect(size).toBeGreaterThanOrEqual(FLOOR);
      expect(size).toBeLessThanOrEqual(1.4);
    }
    expect(rem(rule(live, '.live-strip__dot'), 'width')).toBeLessThanOrEqual(0.9);
  });

  it('is one slim line: the body runs in a row, not two stacked lines', () => {
    const body = rule(live, '.live-strip__body');
    expect(body).toMatch(/flex-direction:\s*row/);
    expect(body).toMatch(/align-items:\s*center/);
  });
});

describe('live-mode clock: a bit smaller only while live', () => {
  it('the normal hero clock and date line stay as they are', () => {
    expect(rem(rule(styles, '.clock__hm'), 'font-size')).toBe(9.6);
    expect(rem(rule(styles, '.clock__aside'), 'font-size')).toBe(2);
    expect(rem(rule(styles, '.ident__dates'), 'font-size')).toBe(1.75);
  });

  it('under .screen--main.has-live the clock, its aside and the date line shrink well down (operator: smaller more)', () => {
    const hm = rem(rule(live, '.screen--main.has-live .clock__hm'), 'font-size');
    expect(hm).toBeGreaterThanOrEqual(4.9);
    expect(hm).toBeLessThanOrEqual(5.5);
    const aside = rem(rule(live, '.screen--main.has-live .clock__aside'), 'font-size');
    expect(aside).toBeGreaterThanOrEqual(1.1);
    expect(aside).toBeLessThanOrEqual(1.35);
    expect(aside).toBeGreaterThanOrEqual(FLOOR);
    const dates = rem(rule(live, '.screen--main.has-live .ident__dates'), 'font-size');
    expect(dates).toBeGreaterThanOrEqual(1);
    expect(dates).toBeLessThanOrEqual(1.15);
    expect(dates).toBeGreaterThanOrEqual(FLOOR);
  });

  it('the live-mode margins tighten to match the smaller type', () => {
    const dates = rule(live, '.screen--main.has-live .ident__dates');
    expect(rem(dates, 'margin-top')).toBeLessThanOrEqual(0.55);
    expect(rem(dates, 'gap')).toBeLessThan(rem(rule(styles, '.ident__dates'), 'gap'));
    // The clock is inline layout (the aside is an inline-block on the digits' baseline, Chrome 91 safe): the
    // space before the aside is its margin-left, the space between its two lines the second line's margin-top.
    expect(rem(rule(live, '.screen--main.has-live .clock__aside'), 'margin-left')).toBeLessThan(
      rem(rule(styles, '.clock__aside'), 'margin-left'),
    );
    expect(rem(rule(live, '.screen--main.has-live .clock__aside > * + *'), 'margin-top')).toBeLessThan(
      rem(rule(styles, '.clock__aside > * + *'), 'margin-top'),
    );
  });

  it('outside a live the normal margins stay as they are', () => {
    expect(rem(rule(styles, '.ident__dates'), 'margin-top')).toBe(0.9);
    expect(rem(rule(styles, '.clock__aside'), 'margin-left')).toBe(0.9);
    expect(rem(rule(styles, '.clock__aside > * + *'), 'margin-top')).toBe(0.35);
  });
});

describe('live video: a portrait picture is shown whole', () => {
  it('a portrait video is contained on a dark background, centred', () => {
    const body = rule(live, ".live__video[data-orientation='portrait']");
    expect(body).toMatch(/object-fit:\s*contain/);
    expect(body).toMatch(/object-position:\s*center/);
    expect(body).toMatch(/background:\s*(#0|rgb\(0 0 0)/);
  });
});
