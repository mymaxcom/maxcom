// The health check of an uploaded theme (spec 6.6, 6.10.5): after a pack has loaded, and on every screen change, the
// elements that must never be lost are looked at as the browser really draws them.
import { PROTECTED } from '@surau/core';
import type { KioskTemplateId, ProtectedEl, ScreenId } from '@surau/core';
import type { StageScreenId } from '../screens/screenId.ts';
import minSizes from './minSizes.json';

export interface ElMetrics {
  displayed: boolean;
  visible: boolean;
  opacity: number;
  rect: { left: number; top: number; right: number; bottom: number };
  fontRem: number;
  heightRem: number;
  /** Something that is not the element, nor inside it, is drawn over its centre (a layer a pack added). */
  covered: boolean;
  /** Some text inside it is drawn at no size, faded, hidden, without any area, or in a colour that cannot be seen. */
  textHidden: boolean;
  /** The lowest contrast ratio of its text against the background behind it; null when that cannot be worked out (a picture behind it, no text). */
  contrast: number | null;
  /** The same ratio with the pack's stylesheet switched off for a moment (the base theme alone); null when unknown. */
  baselineContrast?: number | null;
  /** The opacity of the element with the pack's stylesheet off (a built-in theme may dim a part itself). */
  baselineOpacity?: number;
  /** The `data-must` parts inside it (the hour and minute, each prayer cell's name and time, the countdown digits, the next prayer's name). */
  musts?: MustMetrics[];
  /** The prayer cells the screen declared (`data-cells`) and the number drawn; null when the element declares none. */
  cells?: { expected: number; rendered: number } | null;
}
/** One part that must show, as drawn. */
export interface MustMetrics {
  displayed: boolean;
  hasText: boolean;
  visible: boolean;
  opacity: number;
  /** The union of the part's box and the rectangles its text is drawn in. */
  rect: { left: number; top: number; right: number; bottom: number };
  fontRem: number;
  /** Something else is drawn at the centre or at one of the four inset corners of its text. */
  covered: boolean;
  textHidden: boolean;
  contrast: number | null;
  /** The same ratio with the pack's stylesheet switched off for a moment (the base theme alone); null when unknown. */
  baseline?: number | null;
  baselineOpacity?: number;
  /** A picture is behind it and no plate (so the contrast is unknown). */
  picture: boolean;
  /** The part is drawn mirrored, turned, or at another size than it was laid out at (a transform or a zoom on it or on an ancestor). */
  transformed: boolean;
}
/** Reads one element as drawn. The real one asks the browser; tests inject their own. */
export type Measure = (el: Element) => ElMetrics;

/** The check runs this long after the pack is ready and after every screen change (the layout has settled). */
export const HEALTH_DELAY_MS = 600;
/** And again at this interval while the pack is on the stage, and (debounced) after an animation or a transition. */
export const HEALTH_INTERVAL_MS = 60_000;
export const MIN_OPACITY = 0.9;
export const MIN_SIZE_FACTOR = 0.9;
export const VIEWPORT_TOLERANCE_PX = 1;
/** WCAG's floor for large text; the clock and the prayer times are large text. */
export const MIN_CONTRAST = 3;
/**
 * The contrast is read from the layers the page draws, which a theme may also paint with things the check cannot read (a pseudo-element, a
 * blend). So a ratio below the floor fails only when the pack made it worse: below this share of what the base theme alone gives.
 */
export const CONTRAST_KEEP = 0.85;
/** The element that carries the pack's stylesheet (packLoader.ts PACK_LINK_ID). */
const PACK_SHEET_ID = 'mx-theme-pack';
/** Is a contrast below the floor the pack's doing (it is lower than the base theme's own by more than the allowance)? */
/** An opacity below the floor fails only when the base theme alone is not that dim already (a dimmed prayer screen dims its clock itself). */
export function opacityFails(now: number, baseline: number | undefined): boolean {
  if (now >= MIN_OPACITY) return false;
  return !(baseline !== undefined && now >= baseline * CONTRAST_KEEP);
}
export function contrastFails(now: number | null, baseline: number | null | undefined): boolean {
  if (now == null || now >= MIN_CONTRAST) return false;
  return baseline == null || now < baseline * CONTRAST_KEEP;
}
/** The smallest text anywhere inside a protected element (the built-in themes' smallest is 0.8rem): below this it is not readable on the hall display. */
export const MIN_TEXT_REM = 0.5;
/** The smallest a `data-must` part may be drawn (the built-in themes' smallest such text is 0.8rem; the role's own measured size is checked as well). */
export const MUST_MIN_REM = 0.7;
/** The roles whose text parts are marked `data-must`: none of them may have no part at all. */
const MUST_ROLES: readonly ProtectedEl[] = ['clock', 'prayers', 'countdown', 'next'];

type SizeTable = Record<string, Record<string, Partial<Record<ProtectedEl, number>>>>;
const TABLE = minSizes as unknown as SizeTable;

/** A computed colour (`rgb(1, 2, 3)`, `rgba(1, 2, 3, 0.5)`, `rgb(1 2 3 / 50%)`) as [r, g, b, a], else null. */
export function parseColor(value: string): [number, number, number, number] | null {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(value.trim());
  if (m === null) return null;
  const a = m[4] === undefined ? 1 : m[5] === '%' ? Number(m[4]) / 100 : Number(m[4]);
  const c: [number, number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3]), a];
  return c.every((x) => Number.isFinite(x)) ? c : null;
}

const channel = (v: number): number => {
  const x = v / 255;
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: readonly number[]): number => 0.2126 * channel(c[0]!) + 0.7152 * channel(c[1]!) + 0.0722 * channel(c[2]!);

/** WCAG contrast ratio of two opaque colours (1 to 21). */
export function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `top` drawn over `under`, both [r, g, b, a]; the result is opaque when `under` is. */
export function over(top: readonly number[], under: readonly number[]): [number, number, number, number] {
  const a = top[3]!;
  const ua = under[3]!;
  const outA = a + ua * (1 - a);
  if (outA === 0) return [0, 0, 0, 0];
  const mix = (i: number): number => (top[i]! * a + under[i]! * ua * (1 - a)) / outA;
  return [mix(0), mix(1), mix(2), outA];
}

/** The text of an element itself (not of its children), without blanks. */
const ownText = (el: Element): string => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join('').trim();

type RGBA = [number, number, number, number];

/** The lowest contrast of `fill` drawn over each candidate backdrop (every colour stop of a gradient counts). */
export function minContrastOver(fill: RGBA, candidates: readonly RGBA[]): number {
  let low = Infinity;
  for (const bg of candidates) low = Math.min(low, contrastRatio(over(fill, bg), bg));
  return low;
}

/** Every rgb()/rgba() colour in a computed `background-image` value (a gradient's colour stops). */
function gradientStops(value: string): RGBA[] {
  const out: RGBA[] = [];
  for (const m of value.matchAll(/rgba?\([^)]*\)/g)) {
    const c = parseColor(m[0]);
    if (c !== null) out.push(c);
  }
  return out;
}

const MAX_CANDIDATES = 32;

/** A picture that comes from a pack (a url under /themes/ or a blob in the preview); the base theme's own pictures are its business. */
const PACK_PICTURE = /url\([^)]*(?:\/themes\/|blob:)/i;
const PICTURE_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'SVG', 'PICTURE']);

/** Every element drawn at a point, topmost first, including layers a theme made click-through (pointer-events: none), for the moment it takes. */
function elementsAt(x: number, y: number): Element[] {
  const style = document.createElement('style');
  style.textContent = '.stage[data-pack] * { pointer-events: auto !important; }';
  document.head.appendChild(style);
  try {
    return document.elementsFromPoint(x, y);
  } finally {
    style.remove();
  }
}

/**
 * What can be behind an element, read from the layers really drawn at the middle of its text (the element's own background and
 * everything under it, also the screen's background layers that are not its ancestors): each layer's colour and image laid over
 * what is below. A gradient fans the possibilities out (one per colour stop), so the contrast is judged against every stop.
 * `candidates` is null when the backdrop cannot be known (a picture of the base theme or the surau, a video); `picture` is true
 * when a picture of the pack is behind it (a plate is then put under it, see applyPlates).
 */
export function backdropOf(el: Element): { candidates: RGBA[] | null; picture: boolean } {
  const rects = textRects(el);
  const r = rects[0] ?? el.getBoundingClientRect();
  const x = Math.min(Math.max((r.left + r.right) / 2, 0), window.innerWidth - 1);
  const y = Math.min(Math.max((r.top + r.bottom) / 2, 0), window.innerHeight - 1);
  const stack = elementsAt(x, y);
  const at = stack.indexOf(el);
  let below: Element[];
  if (at >= 0) {
    below = stack.slice(at);
  } else {
    below = [];
    for (let n: Element | null = el; n !== null; n = n.parentElement) below.push(n);
  }
  let candidates: RGBA[] | null = null;
  let picture = false;
  for (let i = below.length - 1; i >= 0; i--) {
    const node = below[i]!;
    if (PICTURE_TAGS.has(node.tagName.toUpperCase())) { candidates = null; picture = false; continue; }
    const cs = getComputedStyle(node);
    const c = parseColor(cs.backgroundColor);
    const img = cs.backgroundImage;
    const hasImg = img !== 'none' && img !== '';
    if (c !== null && c[3] > 0) {
      // an opaque colour hides everything beneath it, a picture included
      if (c[3] >= 0.99) { candidates = [c]; picture = false; }
      else if (candidates !== null) candidates = candidates.map((u) => over(c, u));
    }
    if (hasImg) {
      if (PACK_PICTURE.test(img)) { picture = true; candidates = null; continue; }
      const stops = /url\(/i.test(img) ? [] : gradientStops(img);
      if (stops.length === 0) { candidates = null; continue; } // a picture of the base theme: its own business
      const next: RGBA[] = [];
      for (const st of stops) {
        if (candidates !== null) for (const u of candidates) next.push(over(st, u));
        else if (st[3] >= 0.99) next.push(st);
        else { next.length = 0; candidates = null; break; }
      }
      if (candidates !== null || next.length > 0) candidates = next.slice(0, MAX_CANDIDATES);
    }
  }
  return { candidates, picture };
}

/** Is the text of this element drawn somewhere other than its own box or the screen (text-indent, an offset: the box stays, the glyphs leave)? */
function glyphsOutside(el: Element, box: DOMRect): boolean {
  for (const n of el.childNodes) {
    if (n.nodeType !== 3 || (n.textContent ?? '').trim() === '') continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const b = range.getBoundingClientRect();
    const cx = (b.left + b.right) / 2;
    const cy = (b.top + b.bottom) / 2;
    if (!(b.width > 0) || !(b.height > 0)) return true;
    if (cx < box.left - 2 || cx > box.right + 2 || cy < box.top - 2 || cy > box.bottom + 2) return true;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return true;
  }
  return false;
}

/** The box's own overlays (the network check, the way out to the box, the preview ribbon) and how big each may be: a theme cannot make an element with these classes. */
const BOX_UI = '.netcheck, .host-exit, .preview-ribbon';
type BoxUiKind = 'host-exit' | 'preview-ribbon' | 'netcheck';
const BOX_UI_KINDS: readonly BoxUiKind[] = ['host-exit', 'preview-ribbon', 'netcheck'];

/** Is this box overlay at its expected size (so that being under it is not a theme's doing)? A grown one counts as covering. */
export function boxUiRectOk(kind: BoxUiKind, rect: { left: number; top: number; right: number; bottom: number }, rootPx: number): boolean {
  if (kind === 'netcheck') return true; // a whole box screen by design (a pack is never loaded on it)
  const w = (rect.right - rect.left) / rootPx;
  const h = (rect.bottom - rect.top) / rootPx;
  if (kind === 'host-exit') return w <= 12 && h <= 3;
  return h <= 3;
}

function boxUiHit(hit: Element, rootPx: number): boolean {
  const el = hit.closest(BOX_UI);
  if (el === null) return false;
  const kind = BOX_UI_KINDS.find((k) => el.classList.contains(k));
  return kind !== undefined && boxUiRectOk(kind, el.getBoundingClientRect(), rootPx);
}

/** The element at a point, seeing every element, even one a pack made click-through (pointer-events: none), for the moment it takes. */
function hitTest(x: number, y: number): Element | null {
  const style = document.createElement('style');
  style.textContent = '.stage[data-pack] * { pointer-events: auto !important; }';
  document.head.appendChild(style);
  try {
    return document.elementFromPoint(x, y);
  } finally {
    style.remove();
  }
}

/** The five probe points of a rectangle: its centre and four points 15 % in from the sides and 30 % in from top and bottom (a large line box is mostly empty at its edges: the ink lies in the middle band). */
export function probePoints(p: { left: number; top: number; right: number; bottom: number }): Array<[number, number]> {
  const w = p.right - p.left;
  const h = p.bottom - p.top;
  const cx = (p.left + p.right) / 2;
  const cy = (p.top + p.bottom) / 2;
  return [[cx, cy], [p.left + 0.15 * w, p.top + 0.3 * h], [p.right - 0.15 * w, p.top + 0.3 * h], [p.left + 0.15 * w, p.bottom - 0.3 * h], [p.right - 0.15 * w, p.bottom - 0.3 * h]];
}

/** Is something that is not `el` (nor inside it, nor the box's own overlay at its expected size) drawn at any of the probe points? */
/** An element that paints nothing of its own (no colour, no picture): another part of the same protected element lying over a text part's box does not cover its glyphs. */
function paintsNothing(el: Element): boolean {
  const cs = getComputedStyle(el);
  const c = parseColor(cs.backgroundColor);
  return (c === null || c[3] < 0.1) && (cs.backgroundImage === 'none' || cs.backgroundImage === '');
}

function coveredAt(el: Element, rects: Array<{ left: number; top: number; right: number; bottom: number }>, rootPx: number, ancestorOk = false): boolean {
  const roleEl = ancestorOk ? el.closest('[data-role]') : null;
  for (const p of rects) {
    for (const [px, py] of probePoints(p)) {
      const x = Math.min(Math.max(px, 0), window.innerWidth - 1);
      const y = Math.min(Math.max(py, 0), window.innerHeight - 1);
      const hit = hitTest(x, y);
      if (hit === null || !(hit === el || el.contains(hit) || (ancestorOk && hit.contains(el)) || (roleEl !== null && roleEl.contains(hit) && paintsNothing(hit)) || boxUiHit(hit, rootPx))) return true;
    }
  }
  return false;
}

const chainOpacity = (el: Element): number => {
  let o = 1;
  for (let n: Element | null = el; n !== null; n = n.parentElement) {
    const v = parseFloat(getComputedStyle(n).opacity);
    o *= Number.isFinite(v) ? v : 1;
    if (n.classList.contains('stage')) break;
  }
  return o;
};
const chainDisplayed = (el: Element): boolean => {
  if (el.getClientRects().length === 0) return false;
  for (let n: Element | null = el; n !== null; n = n.parentElement) {
    if (getComputedStyle(n).display === 'none') return false;
    if (n.classList.contains('stage')) break;
  }
  return true;
};

/** The rectangle(s) the text of an element is really drawn in (not the box around it). */
function textRects(el: Element): DOMRect[] {
  const range = document.createRange();
  range.selectNodeContents(el);
  if (typeof range.getClientRects !== 'function') return []; // no layout engine (a test page)
  return [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
}

/** Do the transforms from the element up to the stage mirror, turn or resize it (beyond what the built-in themes do for decoration)? */
export function transformedBy(el: Element): boolean {
  let m = new DOMMatrix();
  for (let n: Element | null = el; n !== null; n = n.parentElement) {
    const t = getComputedStyle(n).transform;
    if (t !== '' && t !== 'none') {
      try {
        m = new DOMMatrix(t).multiply(m);
      } catch {
        return true;
      }
    }
    if (n.classList.contains('stage')) break;
  }
  const sx = Math.hypot(m.a, m.b);
  const sy = Math.hypot(m.c, m.d);
  const det = m.a * m.d - m.b * m.c;
  const turn = Math.abs((Math.atan2(m.b, m.a) * 180) / Math.PI);
  return !(det > 0) || sx < 0.8 || sx > 1.25 || sy < 0.8 || sy > 1.25 || turn > 10;
}

/** A box-shadow or an outline that paints well outside its element is not hit-testable, so it is looked for on its own. */
interface Ring { el: Element; rect: { left: number; top: number; right: number; bottom: number } }

function splitTop(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

/** Elements of the stage whose shadow spread or outline reaches more than 1rem past their box: the reach of what they can paint over. */
export function ringsOf(stage: Element, root: number): Ring[] {
  const rings: Ring[] = [];
  for (const el of [stage, ...stage.querySelectorAll('*')]) {
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    if (!(box.width > 0 || box.height > 0)) continue;
    let reach = 0;
    let dx = 0;
    let dy = 0;
    const shadow = cs.boxShadow;
    if (shadow !== 'none' && shadow !== '') {
      for (const layer of splitTop(shadow)) {
        if (/inset/.test(layer)) continue;
        const nums = [...layer.replace(/rgba?\([^)]*\)/g, '').matchAll(/-?\d*\.?\d+px/g)].map((m) => parseFloat(m[0]));
        const spread = nums[3] ?? 0;
        if (spread > reach) { reach = spread; dx = nums[0] ?? 0; dy = nums[1] ?? 0; }
      }
    }
    const ow = parseFloat(cs.outlineWidth) || 0;
    if (cs.outlineStyle !== 'none' && ow > 0) reach = Math.max(reach, ow + Math.max(0, parseFloat(cs.outlineOffset) || 0));
    if (reach > root) rings.push({ el, rect: { left: box.left - reach + dx, top: box.top - reach + dy, right: box.right + reach + dx, bottom: box.bottom + reach + dy } });
  }
  return rings;
}

const intersects = (a: Ring['rect'], b: Ring['rect']): boolean => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** One `data-must` part as drawn. */
function mustMetricsOf(el: Element, root: number, rings: Ring[], baseline: number | null, baselineOpacity: number | undefined): MustMetrics {
  const cs = getComputedStyle(el);
  const hasText = (el.textContent ?? '').trim() !== '';
  const displayed = chainDisplayed(el);
  const opacity = chainOpacity(el);
  const tr = textRects(el);
  const own = el.getBoundingClientRect();
  // the box that must be inside the screen: the union of the glyph rectangles and the element's own box
  const rects = tr.length > 0 ? tr : [own];
  const left = Math.min(own.left, ...rects.map((r) => r.left));
  const top = Math.min(own.top, ...rects.map((r) => r.top));
  const right = Math.max(own.right, ...rects.map((r) => r.right));
  const bottom = Math.max(own.bottom, ...rects.map((r) => r.bottom));
  const fill = parseColor(cs.getPropertyValue('-webkit-text-fill-color')) ?? parseColor(cs.color);
  const textHidden =
    !(parseFloat(cs.fontSize) >= MIN_TEXT_REM * root) || tr.length === 0 || (fill !== null && fill[3] < 0.1) || glyphsOutside(el, own) ||
    cs.visibility !== 'visible' || cs.getPropertyValue('text-decoration-line').includes('line-through') || ['disc', 'circle', 'square'].includes(cs.getPropertyValue('-webkit-text-security')) ||
    parseFloat(cs.getPropertyValue('-webkit-text-stroke-width') || '0') > 0.05 * (parseFloat(cs.fontSize) || 16);
  // A zoom or a scale shows in the glyph box: text is about 1.0 to 1.5 times its font size tall, whatever the line height.
  const fontPx = parseFloat(cs.fontSize) || 0;
  const glyphH = tr.length > 0 ? Math.max(...tr.map((r) => r.height)) : 0;
  const transformed = transformedBy(el) || (fontPx > 0 && (glyphH / fontPx < 0.7 || glyphH / fontPx > 3));
  let contrast: number | null = null;
  let picture = false;
  if (fill !== null && hasText) {
    const back = backdropOf(el);
    picture = back.picture;
    if (!back.picture && back.candidates !== null) contrast = minContrastOver(fill, back.candidates);
  }
  return {
    displayed,
    hasText,
    visible: cs.visibility === 'visible',
    opacity,
    rect: { left, top, right, bottom },
    fontRem: (parseFloat(cs.fontSize) || 0) / root,
    covered:
      displayed && tr.length > 0
        ? coveredAt(el, tr.map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })), root, true) ||
          rings.some((g) => g.el !== el && !el.contains(g.el) && !g.el.contains(el) && tr.some((r) => intersects(g.rect, r)))
        : true,
    textHidden,
    contrast,
    baseline,
    ...(baselineOpacity === undefined ? {} : { baselineOpacity }),
    picture,
    transformed,
  };
}

/**
 * Where a picture is behind a protected text part, the part gets a solid plate (protected.css, `[data-must][data-mx-plate]`):
 * the contrast is then the plate's own. Run before every health check; the attribute is the kiosk's, never the pack's.
 */
export function applyPlates(stage: Element): void {
  for (const el of stage.querySelectorAll('[data-role] [data-must], [data-must][data-role]')) {
    if (el.closest("[aria-hidden='true']") !== null) continue;
    el.removeAttribute('data-mx-plate');
    if (backdropOf(el).picture) el.setAttribute('data-mx-plate', '1');
  }
}

export const realMeasure: Measure = (el) => {
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const cs = getComputedStyle(el);
  // Opacity multiplies up the tree; display:none anywhere above removes the element from the page.
  const opacity = chainOpacity(el);
  const displayed = chainDisplayed(el);
  const r = el.getBoundingClientRect();

  // The element itself and every element inside it that carries text: at a size and in a colour that show, over a background that reads.
  let textHidden = false;
  // (what is not rendered at all, such as the Arabic extras a theme keeps at display: none, is not visible text)
  const textEls = [el, ...el.querySelectorAll('*')].filter((e) => ownText(e) !== '' && e.getClientRects().length > 0 && getComputedStyle(e).visibility === 'visible');
  const shown: Element[] = [];
  const opNow = new Map<Element, number>();
  for (const t of textEls) {
    const tcs = getComputedStyle(t);
    const tr = t.getBoundingClientRect();
    const o = chainOpacity(t);
    const fill = parseColor(tcs.getPropertyValue('-webkit-text-fill-color')) ?? parseColor(tcs.color);
    opNow.set(t, o);
    if (!(parseFloat(tcs.fontSize) >= MIN_TEXT_REM * root) || !(tr.width > 0) || !(tr.height > 0) || (fill !== null && fill[3] < 0.1) || glyphsOutside(t, tr)) {
      textHidden = true;
      continue;
    }
    shown.push(t);
  }
  // The parts that must show: every data-must element (the element itself when it carries the attribute).
  const mustEls = [...(el.hasAttribute('data-must') ? [el] : []), ...el.querySelectorAll('[data-must]')];

  // The contrast of one element's text against what is behind it (a picture of the base theme, or no text: unknown, null).
  const contrastOf = (t: Element): number | null => {
    const tcs = getComputedStyle(t);
    const fill = parseColor(tcs.getPropertyValue('-webkit-text-fill-color')) ?? parseColor(tcs.color);
    if (fill === null || (t.textContent ?? '').trim() === '') return null;
    const back = backdropOf(t);
    return back.picture || back.candidates === null ? null : minContrastOver(fill, back.candidates);
  };
  const lowest = (xs: Array<number | null>): number | null => xs.reduce<number | null>((acc, v) => (v === null ? acc : acc === null ? v : Math.min(acc, v)), null);
  // The same, with the pack's stylesheet off for the moment this takes (nothing is painted in between): what the base theme alone gives.
  const baseOf = new Map<Element, number | null>();
  const opBase = new Map<Element, number>();
  const sheet = (document.getElementById(PACK_SHEET_ID) as HTMLLinkElement | HTMLStyleElement | null)?.sheet ?? null;
  if (sheet !== null) {
    sheet.disabled = true;
    try {
      for (const e of new Set([...shown, ...mustEls])) {
        baseOf.set(e, contrastOf(e));
        opBase.set(e, chainOpacity(e));
      }
      opBase.set(el, chainOpacity(el));
    } finally {
      sheet.disabled = false;
    }
  }
  for (const t of shown) if (opacityFails(opNow.get(t) ?? 1, opBase.get(t))) textHidden = true;
  const contrast = lowest(shown.map(contrastOf));
  const baselineContrast = sheet === null ? null : lowest(shown.map((e) => baseOf.get(e) ?? null));

  // Is the centre of the element, and of each piece of text in it, really the element (or something in it) that the eye sees?
  const covered = coveredAt(el, [el, ...textEls.slice(0, 12)].map((e) => e.getBoundingClientRect()).filter((p) => p.width > 0 && p.height > 0), root);

  const rings = mustEls.length > 0 ? ringsOf(el.closest('.stage') ?? document.documentElement, root) : [];
  const musts = mustEls.map((m) => mustMetricsOf(m, root, rings, sheet === null ? null : (baseOf.get(m) ?? null), opBase.get(m)));

  // The cells of the prayer bar: the number drawn must be the number the screen declared.
  const declared = el.getAttribute('data-cells');
  const cells = declared === null ? null : { expected: Number(declared), rendered: [...el.querySelectorAll('.pcell')].filter((c) => chainDisplayed(c)).length };

  return {
    displayed,
    visible: cs.visibility === 'visible',
    opacity,
    rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    fontRem: (parseFloat(cs.fontSize) || 0) / root,
    heightRem: r.height / root,
    covered,
    textHidden,
    contrast,
    baselineContrast,
    ...(opBase.has(el) ? { baselineOpacity: opBase.get(el)! } : {}),
    musts,
    cells,
  };
};

/** The elements the screen must still show: the catalog's list (the phases without an entry need the clock and the prayer times), plus the logo when the surau has one. */
export function requiredRoles(screen: StageScreenId, logoSet: boolean): ProtectedEl[] {
  const own = Object.prototype.hasOwnProperty.call(PROTECTED, screen) ? PROTECTED[screen as ScreenId] : (['clock', 'prayers'] as const);
  const roles: ProtectedEl[] = [...own];
  if (logoSet && !roles.includes('logo')) roles.push('logo');
  return roles;
}

/** The size a built-in theme gives the element, in rem: this screen's entry, else the smallest of that role across the theme's screens, else none. */
export function minSizeOf(base: KioskTemplateId, screen: StageScreenId, role: ProtectedEl): number {
  const theme = Object.prototype.hasOwnProperty.call(TABLE, base) ? TABLE[base] : undefined;
  if (theme === undefined) return 0;
  const own = Object.prototype.hasOwnProperty.call(theme, screen) ? theme[screen]?.[role] : undefined;
  if (own !== undefined) return own;
  let smallest: number | undefined;
  for (const entry of Object.values(theme)) {
    const v = entry[role];
    if (v !== undefined && (smallest === undefined || v < smallest)) smallest = v;
  }
  return smallest ?? 0;
}

export interface HealthResult { ok: boolean; failed: ProtectedEl[] }

function mustPasses(x: MustMetrics, viewport: { width: number; height: number }): boolean {
  if (!x.displayed || !x.hasText || !x.visible || opacityFails(x.opacity, x.baselineOpacity) || x.covered || x.textHidden || x.picture || x.transformed) return false;
  if (contrastFails(x.contrast, x.baseline)) return false;
  const tol = VIEWPORT_TOLERANCE_PX;
  const { left, top, right, bottom } = x.rect;
  if (!(right - left > 0) || !(bottom - top > 0)) return false;
  if (left < -tol || top < -tol || right > viewport.width + tol || bottom > viewport.height + tol) return false;
  return x.fontRem >= MUST_MIN_REM;
}

function passes(m: ElMetrics, need: number, role: ProtectedEl, viewport: { width: number; height: number }): boolean {
  if (!m.displayed || !m.visible || opacityFails(m.opacity, m.baselineOpacity)) return false;
  const t = VIEWPORT_TOLERANCE_PX;
  const { left, top, right, bottom } = m.rect;
  if (!(right - left > 0) || !(bottom - top > 0)) return false;
  if (left < -t || top < -t || right > viewport.width + t || bottom > viewport.height + t) return false;
  if (m.covered || m.textHidden) return false;
  if (contrastFails(m.contrast, m.baselineContrast)) return false;
  if (m.musts !== undefined) {
    if (m.musts.length === 0 && MUST_ROLES.includes(role)) return false;
    if (!m.musts.every((x) => mustPasses(x, viewport))) return false;
  }
  if (m.cells != null && m.cells.rendered !== m.cells.expected) return false;
  const size = role === 'logo' ? m.heightRem : m.fontRem;
  return size >= need * MIN_SIZE_FACTOR;
}

/**
 * For each required role at least one element `[data-role=<role>]` that is not inside an `[aria-hidden='true']` element (the
 * logo is itself aria-hidden: it counts) must pass
 * every rule: displayed, visible, opacity at least 0.9, a box inside the viewport (1 px tolerance), nothing drawn over its
 * centre, every piece of text in it at a size and in a colour that shows, text contrast of at least 3:1 against the
 * background behind it, and a font size (a logo: its height) of at least 0.9 of the base theme's own.
 */
export function checkScreenHealth(
  stage: Element,
  screen: StageScreenId,
  opts: { logoSet: boolean; base: KioskTemplateId; viewport: { width: number; height: number }; measure?: Measure },
): HealthResult {
  const measure = opts.measure ?? realMeasure;
  const failed: ProtectedEl[] = [];
  for (const role of requiredRoles(screen, opts.logoSet)) {
    const need = minSizeOf(opts.base, screen, role);
    const candidates = [...stage.querySelectorAll(`[data-role="${role}"]`)].filter((e) => e.parentElement?.closest("[aria-hidden='true']") == null);
    let ok = false;
    for (const el of candidates) {
      let m: ElMetrics;
      try {
        m = measure(el);
      } catch {
        continue;
      }
      if (passes(m, need, role, opts.viewport)) { ok = true; break; }
    }
    if (!ok) failed.push(role);
  }
  return { ok: failed.length === 0, failed };
}
