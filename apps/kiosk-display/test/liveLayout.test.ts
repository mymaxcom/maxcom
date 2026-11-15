import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom lays nothing out, so the live screen's size contract is checked on the stylesheets (like layout.test.ts).
// 1rem = min(1vw, 1.7777vh) = 19.2px on a 1920x1080 TV; 18px there is 0.9375rem, the legibility floor, and the
// live screen's own text is read from 3 m: about 24px (1.25rem) and up.
function src(file: string): string {
  const hit = [file, `apps/kiosk-display/${file}`].map((p) => resolve(process.cwd(), p)).find(existsSync);
  if (!hit) throw new Error(`${file} not found from ${process.cwd()}`);
  return readFileSync(hit, 'utf8');
}
const live = src('src/live/live.css');
const templates = src('src/templates.css');

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
/** Every rule body whose selector list is exactly `selector` (a template may have several). */
function bodies(css: string, selector: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .filter((b) => b.split('{')[0]!.trim() === selector)
    .map((b) => b.split('{')[1] ?? '')
    .join('\n');
}
const FLOOR = 18 / 19.2;
const HALL = 24 / 19.2;

describe('the live screen: the frame and the video share one box', () => {
  it('the stage defines the frame from custom properties; the height follows the width at 16:9', () => {
    const stage = rule(live, '.stage');
    for (const v of ['--live-pad-top', '--live-pad-x', '--live-pad-bottom', '--live-gap', '--live-frame-w', '--live-blur', '--live-veil', '--live-veil-dim']) {
      expect(stage, v).toContain(`${v}:`);
    }
    expect(stage).toMatch(/--live-frame-h:\s*calc\(var\(--live-frame-w\) \* 9 \/ 16\)/);
    // The frame is the main area: at least 65 % of the stage width (100rem).
    expect(rem(stage, '--live-frame-w')).toBeGreaterThanOrEqual(65);
  });

  it('the clear video box and the live screen grid use the same properties', () => {
    const clear = rule(live, '.live--clear');
    expect(clear).toMatch(/left:\s*var\(--live-pad-x\)/);
    expect(clear).toMatch(/top:\s*var\(--live-pad-top\)/);
    expect(clear).toMatch(/width:\s*var\(--live-frame-w\)/);
    expect(clear).toMatch(/height:\s*var\(--live-frame-h\)/);
    const screen = rule(live, '.screen--live');
    expect(screen).toMatch(/grid-template-columns:\s*var\(--live-frame-w\)/);
    expect(screen).toMatch(/grid-template-rows:\s*var\(--live-frame-h\)/);
    expect(screen).toMatch(/padding:\s*var\(--live-pad-top\) var\(--live-pad-x\)/);
    expect(screen).toContain("'frame side'");
    expect(screen).toContain("'strip next'");
  });

  it('nothing is placed on the frame cell but the frame; the templates dress the pieces but never move them', () => {
    const areas = [...live.matchAll(/grid-area:\s*([a-z-]+)/g)].map((m) => m[1]);
    expect(areas.filter((a) => a === 'frame')).toHaveLength(1);
    expect(rule(live, '.live-screen__frame')).toMatch(/grid-area:\s*frame/);
    const liveRules = templates
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('}')
      // (the background's frame / slab pseudo-elements shared with the blurred veil are full-stage by design)
      .filter((b) => !/\.bg::/.test(b.split('{')[0] ?? ''))
      .filter((b) => /live-screen|screen--live|live-strip|\.live\b|\.live--/.test(b.split('{')[0] ?? ''));
    expect(liveRules.length).toBeGreaterThan(10);
    for (const r of liveRules) {
      const body = r.split('{')[1] ?? '';
      expect(body, r).not.toMatch(/grid-area|grid-template|position:\s*absolute|(^|[\s;])(inset|left|top):/);
    }
  });
});

describe('the blurred live: a plain filter, never backdrop-filter', () => {
  it('blurs the video itself, in one class, and lays the template veil over it', () => {
    expect(rule(live, '.live--blurred')).toMatch(/inset:\s*0/);
    expect(rule(live, '.live--blurred .live__video')).toMatch(/filter:\s*blur\(var\(--live-blur\)\)/);
    expect(rule(live, '.live--blurred .live__veil')).toMatch(/background:\s*var\(--live-veil\)/);
    expect(rule(live, ".stage[data-dim='true'] .live--blurred .live__veil")).toMatch(/var\(--live-veil-dim\)/);
    expect(rule(live, '.live__veil')).toMatch(/display:\s*none/);
    expect(live).not.toMatch(/backdrop-filter\s*:/);
  });

  it('every layout template sets its own veil for normal and dimmed screens', () => {
    for (const id of ['oldschool', 'minimal', 'colourful', 'creative']) {
      const all = bodies(templates, `.stage[data-template='${id}']`);
      expect(all, id).toMatch(/--live-veil:/);
      expect(all, id).toMatch(/--live-veil-dim:/);
    }
  });
});

describe('the kuliah strip: read across the hall', () => {
  it('every line is at least about 24px at 1080p, the penceramah largest', () => {
    const tag = rem(rule(live, '.live-strip__tag'), 'font-size');
    const who = rem(rule(live, '.live-strip__who'), 'font-size');
    const about = rem(rule(live, '.live-strip__about'), 'font-size');
    for (const size of [tag, who, about]) expect(size).toBeGreaterThanOrEqual(HALL);
    expect(who).toBeGreaterThan(about);
  });

  it('two lines under the video: the penceramah, then the label and the topic', () => {
    expect(rule(live, '.live-strip__body')).toMatch(/flex-direction:\s*column/);
    expect(rule(live, '.live-screen__strip')).toMatch(/grid-area:\s*strip/);
  });

  it('the side column and the next prayer chip are legible too', () => {
    expect(rem(rule(live, '.screen--live .clock__hm'), 'font-size')).toBeGreaterThanOrEqual(5);
    expect(rem(rule(live, '.live-screen__dates'), 'font-size')).toBeGreaterThanOrEqual(HALL);
    expect(rem(rule(live, '.live-screen__next-label'), 'font-size')).toBeGreaterThanOrEqual(HALL);
    expect(rem(rule(live, '.live-screen__next-cd'), 'font-size')).toBeGreaterThanOrEqual(3);
    expect(rem(rule(live, '.live-screen__ident .ident__name'), 'font-size')).toBeGreaterThanOrEqual(FLOOR);
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
