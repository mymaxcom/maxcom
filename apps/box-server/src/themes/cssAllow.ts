import type { CssNode } from 'css-tree';

/**
 * The property allow-list of a pack (round 2). A v1 pack re-skins a built-in theme: colours, pack pictures and gradients,
 * borders, radii, bounded shadows, spacing and weights. Everything not listed here is refused, whatever its name or vendor
 * prefix (the caller strips the prefix first). A bounded property also refuses var() and calc(), because a bound that
 * cannot be read cannot be proven.
 */

export type Verdict = 'ok' | 'prop' | 'bound';

const REM_PX = 16;
const BORDER_MAX = 0.5;
const OUTLINE_MAX = 0.3;
const SHADOW_BLUR_MAX = 2;
const SHADOW_SPREAD_MAX = 0.5;
const SHADOW_OFFSET_MAX = 1;
const SHADOW_LAYERS_MAX = 4;
const PAD_MAX = 8;
// no negative margin: a later item with a background could slide over the clock or the prayer times in a grid or flex layout
const MARGIN_MIN = 0;
const MARGIN_MAX = 8;
const SIZE_MAX_REM = 100;

const COLOUR_FNS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix']);
const GRADIENT_FNS = new Set(['linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
  '-webkit-linear-gradient', '-webkit-radial-gradient', '-webkit-repeating-linear-gradient', '-webkit-repeating-radial-gradient']);
const PICTURE_FNS = new Set(['url', 'image-set', '-webkit-image-set']);

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const sideProps = (stem: string, tail = ''): string[] => SIDES.map((s) => `${stem}-${s}${tail}`);
// Logical equivalents of the physical sides (the kiosk CSS is direction-neutral). Each is treated exactly like its physical twin.
const LOGICAL = ['inline', 'inline-start', 'inline-end', 'block', 'block-start', 'block-end'] as const;
const logicalProps = (stem: string, tail = ''): string[] => LOGICAL.map((s) => `${stem}-${s}${tail}`);

const COLOUR_PROPS = new Set(['color', 'background-color', 'border-color', ...sideProps('border', '-color'), ...logicalProps('border', '-color'), 'outline-color']);
const KEYWORD_PROPS = new Set(['font-weight', 'font-style', 'text-transform', 'text-align', 'border-style', ...sideProps('border', '-style'), ...logicalProps('border', '-style'), 'outline-style']);
const BACKGROUND_PROPS = new Set(['background', 'background-image', 'background-size', 'background-position', 'background-repeat', 'background-origin']);
const BORDER_WIDTH_PROPS = new Set(['border', 'border-width', ...sideProps('border'), ...sideProps('border', '-width'), ...logicalProps('border'), ...logicalProps('border', '-width')]);
const RADIUS_PROPS = new Set(['border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius']);
const PADDING_PROPS = new Set(['padding', ...sideProps('padding'), ...logicalProps('padding')]);
const MARGIN_PROPS = new Set(['margin', ...sideProps('margin'), ...logicalProps('margin')]);
const GAP_PROPS = new Set(['gap', 'row-gap', 'column-gap', 'grid-gap']);
const SIZE_PROPS = new Set(['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height']);

/** Property names (prefix stripped) a pack may use at all. */
export const ALLOWED_PROPS: ReadonlySet<string> = new Set([
  ...COLOUR_PROPS, ...KEYWORD_PROPS, ...BACKGROUND_PROPS, ...BORDER_WIDTH_PROPS, ...RADIUS_PROPS, ...PADDING_PROPS, ...MARGIN_PROPS, ...GAP_PROPS, ...SIZE_PROPS,
  'outline', 'outline-width', 'outline-offset', 'box-shadow', 'text-shadow', 'letter-spacing', 'word-spacing', 'line-height',
]);

/** A length in rem (em counts the same; px at 16 px to the rem); null when it is not an absolute length. */
function remOf(n: CssNode): number | null {
  if (n.type === 'Number') return Number(n.value) === 0 ? 0 : null;
  if (n.type !== 'Dimension') return null;
  const v = Number(n.value);
  if (!Number.isFinite(v)) return null;
  const u = n.unit.toLowerCase();
  if (u === 'rem' || u === 'em') return v;
  if (u === 'px') return v / REM_PX;
  return null;
}
const fnName = (n: CssNode): string => (n.type === 'Function' ? n.name.toLowerCase() : '');
const isComma = (n: CssNode): boolean => n.type === 'Operator' && n.value === ',';
const sizeUnitless = (kids: CssNode[]): boolean => kids.every((k) => k.type === 'Number' || k.type === 'Dimension' || k.type === 'Percentage');

/** Only plain tokens and colour functions: no var(), calc() or any other function, no url, no string. */
function plainTokens(kids: CssNode[]): boolean {
  return kids.every((k) => {
    switch (k.type) {
      case 'Number': case 'Dimension': case 'Percentage': case 'Identifier': case 'Hash': case 'Operator': return true;
      case 'Function': return COLOUR_FNS.has(fnName(k));
      default: return false;
    }
  });
}

/** Every length in `kids` lies within [lo, hi] rem (percentages only when `pct`); everything else must be a plain token. */
function lengthsWithin(kids: CssNode[], lo: number, hi: number, pct = false, pctMax = 100): boolean {
  if (!plainTokens(kids)) return false;
  for (const k of kids) {
    if (k.type === 'Percentage') {
      if (!pct || !(Number(k.value) <= pctMax)) return false;
    } else if (k.type === 'Dimension' || k.type === 'Number') {
      const r = remOf(k);
      if (r === null) {
        // a unitless number outside a length slot (an opacity-like colour channel is inside a function, so not here)
        return false;
      }
      if (r < lo || r > hi) return false;
    }
  }
  return true;
}

function shadowOk(kids: CssNode[], text: boolean): boolean {
  const layers: CssNode[][] = [[]];
  for (const k of kids) {
    if (isComma(k)) layers.push([]);
    else layers[layers.length - 1]!.push(k);
  }
  if (layers.length > SHADOW_LAYERS_MAX) return false;
  for (const layer of layers) {
    if (!plainTokens(layer)) return false;
    const lens = layer.filter((k) => k.type === 'Dimension' || k.type === 'Number').map(remOf);
    if (lens.some((l) => l === null)) return false;
    const n = lens as number[];
    if (n.length < 2 || n.length > (text ? 3 : 4)) return false;
    if (Math.abs(n[0]!) > SHADOW_OFFSET_MAX || Math.abs(n[1]!) > SHADOW_OFFSET_MAX) return false;
    if (n.length >= 3 && (n[2]! < 0 || n[2]! > SHADOW_BLUR_MAX)) return false;
    if (!text && n.length === 4 && n[3]! > SHADOW_SPREAD_MAX) return false;
  }
  return true;
}

/** A background value: colours, pack pictures, gradients, keywords, lengths and percentages (no other function, no var-free surprises). */
function backgroundOk(kids: CssNode[]): boolean {
  return kids.every((k) => {
    switch (k.type) {
      case 'Number': case 'Dimension': case 'Percentage': case 'Identifier': case 'Hash': case 'Operator': case 'Url': case 'String': return true;
      case 'Function': {
        const n = fnName(k);
        if (n === 'var') return true;
        if (PICTURE_FNS.has(n) || GRADIENT_FNS.has(n) || COLOUR_FNS.has(n)) return true;
        return false;
      }
      default: return false;
    }
  });
}

function colourOrKeyword(kids: CssNode[]): boolean {
  return kids.every((k) => {
    switch (k.type) {
      case 'Number': case 'Identifier': case 'Hash': case 'Operator': case 'Dimension': case 'Percentage': return true;
      case 'Function': return fnName(k) === 'var' || COLOUR_FNS.has(fnName(k));
      default: return false;
    }
  });
}

/**
 * Judge one declaration. `base` is the property name without a vendor prefix; `kids` the value (null when css-tree kept it as
 * raw text); `protectedRule`: the rule's selector reaches a protected element or one of its text parts.
 */
export function judgeDeclaration(base: string, kids: CssNode[] | null, protectedRule: boolean): Verdict {
  if (!ALLOWED_PROPS.has(base)) return 'prop';
  if (kids === null || kids.length === 0) return 'bound';
  if (COLOUR_PROPS.has(base)) return colourOrKeyword(kids) ? 'ok' : 'bound';
  if (KEYWORD_PROPS.has(base)) return colourOrKeyword(kids) ? 'ok' : 'bound';
  if (BACKGROUND_PROPS.has(base)) return backgroundOk(kids) ? 'ok' : 'bound';
  if (BORDER_WIDTH_PROPS.has(base)) return lengthsWithin(kids, 0, BORDER_MAX) ? 'ok' : 'bound';
  if (base === 'outline' || base === 'outline-width') return lengthsWithin(kids, 0, OUTLINE_MAX) ? 'ok' : 'bound';
  if (base === 'outline-offset') return lengthsWithin(kids, -OUTLINE_MAX, OUTLINE_MAX) ? 'ok' : 'bound';
  if (RADIUS_PROPS.has(base)) return lengthsWithin(kids, 0, SIZE_MAX_REM, true) ? 'ok' : 'bound';
  if (base === 'box-shadow') return shadowOk(kids, false) ? 'ok' : 'bound';
  if (base === 'text-shadow') return shadowOk(kids, true) ? 'ok' : 'bound';
  if (PADDING_PROPS.has(base)) return lengthsWithin(kids, 0, PAD_MAX, true) ? 'ok' : 'bound';
  if (MARGIN_PROPS.has(base)) return kids.every((k) => (k.type === 'Identifier' ? k.name.toLowerCase() === 'auto' : lengthsWithin([k], MARGIN_MIN, MARGIN_MAX, true, 50))) ? 'ok' : 'bound';
  if (GAP_PROPS.has(base)) return lengthsWithin(kids, 0, PAD_MAX, true) ? 'ok' : 'bound';
  if (base === 'letter-spacing') return lengthsWithin(kids, 0, 0.3) ? 'ok' : 'bound';
  if (base === 'word-spacing') return lengthsWithin(kids, 0, 0.5) ? 'ok' : 'bound';
  if (base === 'line-height') {
    if (kids.length !== 1) return 'bound';
    const k = kids[0]!;
    if (k.type === 'Number') return Number(k.value) >= 1 ? 'ok' : 'bound';
    if (k.type === 'Percentage') return Number(k.value) >= 100 ? 'ok' : 'bound';
    if (k.type === 'Dimension' && k.unit.toLowerCase() === 'em') return Number(k.value) >= 1 ? 'ok' : 'bound';
    if (k.type === 'Identifier' && k.name.toLowerCase() === 'normal') return 'ok';
    return 'bound';
  }
  if (SIZE_PROPS.has(base)) {
    if (protectedRule) return 'prop';
    if (kids.every((k) => k.type === 'Identifier')) return 'ok';
    return sizeUnitless(kids) && lengthsWithin(kids.filter((k) => k.type !== 'Percentage'), 0, SIZE_MAX_REM) && kids.every((k) => k.type !== 'Percentage' || Number(k.value) <= 100) ? 'ok' : 'bound';
  }
  return 'prop';
}

// ---------------------------------------------------------------------------------------------------------------
// Custom properties (round 3). The built-in CSS feeds theme variables into properties a pack may not set (font-family,
// font-size, transform, clip-path, sizes, plates, the legibility shade...). A pack that could set any `--*` would get
// those back, so it may set only its own `--pack-*` variables and a short list of base-theme COLOUR tokens.

/** The prefix of a pack's own variables. */
export const PACK_VAR_PREFIX = '--pack-';

/** Base-theme tokens that the built-in CSS uses only as colours (colour, background, border, shadow). A colour or gradient value only. */
export const ALLOWED_COLOUR_TOKENS: ReadonlySet<string> = new Set([
  '--accent', '--accent-2', '--text', '--ink', '--muted', '--paper', '--hair', '--rule', '--mint', '--green', '--sunset', '--harakat',
  '--cell-a', '--cell-b', '--slab-a', '--slab-b', '--live-frame-ring', '--live-frame-fill', '--live-veil',
]);
/** Colour tokens written as three channel numbers ("127 220 154") and read as `rgb(var(--accent-rgb) / .4)`. */
export const ALLOWED_RGB_TOKENS: ReadonlySet<string> = new Set(['--accent-rgb', '--glass-rgb']);

const isVarOfAllowedToken = (k: CssNode): boolean => {
  if (k.type !== 'Function' || k.name.toLowerCase() !== 'var') return false;
  const first = k.children.first;
  if (first == null || first.type !== 'Identifier') return false;
  const n = first.name.toLowerCase();
  return n.startsWith(PACK_VAR_PREFIX) || ALLOWED_COLOUR_TOKENS.has(n) || ALLOWED_RGB_TOKENS.has(n);
};

/** A colour or gradient: a keyword, a hex colour, a colour or gradient function, a var() of an allowed token. No picture, string, length or calc(). */
function colourValueOnly(kids: CssNode[]): boolean {
  return kids.every((k) => {
    switch (k.type) {
      case 'Identifier': case 'Hash': return true;
      case 'Function': return COLOUR_FNS.has(fnName(k)) || GRADIENT_FNS.has(fnName(k)) || isVarOfAllowedToken(k);
      default: return false;
    }
  });
}

/** A value of a pack's own variable: colours, gradients, pictures of the pack, numbers, lengths within the padding bounds, keywords. */
function packVarValueOk(kids: CssNode[]): boolean {
  return kids.every((k) => {
    switch (k.type) {
      case 'Identifier': case 'Hash': case 'Operator': case 'Url': return true;
      case 'Number': return Number.isFinite(Number(k.value));
      case 'Percentage': return Number(k.value) <= 100 && Number(k.value) >= 0;
      case 'Dimension': {
        const r = remOf(k);
        return r !== null && r >= 0 && r <= PAD_MAX;
      }
      case 'Function': {
        const n = fnName(k);
        return COLOUR_FNS.has(n) || GRADIENT_FNS.has(n) || PICTURE_FNS.has(n) || isVarOfAllowedToken(k);
      }
      default: return false;
    }
  });
}

/** Three channel numbers 0 to 255, spaces or commas between them. */
function rgbTripletOk(kids: CssNode[]): boolean {
  const nums = kids.filter((k) => !(k.type === 'Operator' && k.value === ','));
  if (nums.length !== 3 || kids.length - nums.length > 2) return false;
  return nums.every((k) => k.type === 'Number' && Number.isInteger(Number(k.value)) && Number(k.value) >= 0 && Number(k.value) <= 255);
}

/**
 * Judge one custom-property declaration. `name` is unescaped and lower-case. 'prop': this variable is not a pack's to set;
 * 'bound': the value is not one that variable may hold.
 */
export function judgeCustomProperty(name: string, kids: CssNode[] | null): Verdict {
  const own = name.startsWith(PACK_VAR_PREFIX) && name.length > PACK_VAR_PREFIX.length;
  const colour = ALLOWED_COLOUR_TOKENS.has(name);
  const rgb = ALLOWED_RGB_TOKENS.has(name);
  if (!own && !colour && !rgb) return 'prop';
  if (kids === null || kids.length === 0) return 'bound';
  if (own) return packVarValueOk(kids) ? 'ok' : 'bound';
  if (rgb) return rgbTripletOk(kids) ? 'ok' : 'bound';
  return colourValueOnly(kids) ? 'ok' : 'bound';
}
