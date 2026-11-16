import * as csstree from 'css-tree';
import type { CssNode } from 'css-tree';
import { isThemeName } from '@surau/core';
import { issue } from './packFormat.ts';
import { judgeCustomProperty, judgeDeclaration } from './cssAllow.ts';
import type { ThemeIssue } from './packFormat.ts';
import type { ScreenId } from '@surau/core';

/**
 * The CSS check for an uploaded theme. The CSS is parsed (css-tree), never pattern-matched: identifiers and
 * strings are compared after CSS unescaping, case-insensitively. Refusals: parse errors (including unclosed
 * blocks, strings and comments), @import and @namespace, @font-face (a pack holds no font), any url() or
 * image-set() string that is not a picture of this pack under images/, scripting constructs, selectors that reach
 * the box's own screens or the page outside the stage, and everything that can hide or move what must stay on
 * screen (animation, filter, mask, clip-path, blend modes, a text fill colour, fixed positioning, a high z-index,
 * !important, text in `content`). Constructs newer than Chrome 91 only warn.
 *
 * Round 2 (allow-list): a v1 pack is a re-skin of a built-in theme, not a re-layout. Selectors may only be classes, the
 * documented data-* hooks and structural pseudo-classes; only the properties in ALLOWED_PROPS are accepted, several with
 * bounds; everything else (including every property that moves, hides, resizes, restacks or re-types an element) is refused.
 */

export const BOX_SCREEN_IDS = ['setup', 'pair', 'recovery', 'locked', 'netcheck'] as const;

export interface CssCheckContext {
  file: string;
  /** File names present in the pack: 'kuliah.jpg'. */
  images: ReadonlySet<string>;
}

/** The highest z-index a pack may use: the protected elements sit above it (themes/protected.css). */
export const MAX_PACK_Z_INDEX = 30;

const MAX_ISSUES = 50;
/** Functions whose string arguments are addresses. */
const URL_STRING_FUNCTIONS = new Set(['url', 'image-set', '-webkit-image-set', 'src', 'image', '-webkit-image', 'cross-fade', '-webkit-cross-fade']);
/** Functions that draw another element or a script-made picture. */
const REFUSED_FUNCTIONS = new Set(['element', '-moz-element', 'paint']);
/** Class names that only the box's own screens carry. */
const BOX_CLASS_TARGETS: readonly string[] = ['box-screen', ...BOX_SCREEN_IDS.map((id) => `screen--${id}`)];
/** Class-name prefixes of the box's own overlays (the way out to the box, the network check, the preview ribbon). */
const BOX_UI_CLASS_PREFIXES: readonly string[] = ['host-exit', 'netcheck', 'preview-ribbon'];
const isBoxClass = (name: string): boolean => BOX_CLASS_TARGETS.includes(name) || BOX_UI_CLASS_PREFIXES.some((p) => name.startsWith(p));
/** The data-* hooks of the theme contract (and the guide) that a selector may read. */
const ALLOWED_DATA_ATTRS = new Set([
  'data-screen', 'data-kind', 'data-phase', 'data-card', 'data-live', 'data-live-layout', 'data-harakat', 'data-align', 'data-lang', 'data-dim', 'data-pic',
  'data-role', 'data-theme', 'data-template', 'data-bg', 'data-arfont', 'data-tarjamah',
]);
/** Structural pseudo-classes (and :not of allowed simple selectors) a selector may use. */
const ALLOWED_PSEUDO_CLASSES = new Set(['first-child', 'last-child', 'only-child', 'nth-child', 'nth-last-child', 'not', 'root']);
/** Classes of the protected elements and the text parts inside them: their size is never a pack's to set. */
const PROTECTED_CLASS_RE = /^(?:region-(?:clock|prayers|next|brand)|clock(?:$|__|--)|phase__clock|hm$|pbar$|strip(?:$|--)|pcell|next(?:$|__)|logo|num$|countdown|free-text$)/;
const NEWER_UNITS = new Set(['dvh', 'svh', 'lvh', 'dvw', 'svw', 'lvw']);
/** At-rules a pack may use; the rules inside them are scoped like the rest. */
const ALLOWED_AT_RULES = new Set(['media', 'supports', 'layer', 'container', 'charset']);
const VENDOR_PREFIX = /^-(?:webkit|moz|ms|o)-/;

/** Decodes CSS escapes (`\62 ox`, `\.`), so a disguised name compares like the plain one. */
export function cssUnescape(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([\s\S])/g, (_m, hex: string | undefined, ch: string | undefined) => {
    if (hex !== undefined) {
      const cp = parseInt(hex, 16);
      return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '�' : String.fromCodePoint(cp);
    }
    return ch === '\n' ? '' : (ch ?? '');
  });
}

const norm = (s: string): string => cssUnescape(s).toLowerCase();

// eslint-disable-next-line no-control-regex
const SCRIPT_RE = /(?:java|vb)script:/;
function looksScripted(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return SCRIPT_RE.test(norm(s).replace(/[\s\u0000-\u001f]/g, ''));
}

/** A url that is not `images/<file>` of this pack (an optional leading ./ or ../). */
function urlNotAllowed(value: string, ctx: CssCheckContext): boolean {
  const m = /^(?:\.{1,2}\/)?images\/([^/\\]+)$/.exec(value);
  if (m === null) return true;
  return !ctx.images.has(m[1]!);
}

/** Does an attribute selector with `matcher` and `value` match some target string? */
function matcherCouldMatch(matcher: string | null, value: string, targets: readonly string[]): boolean {
  if (matcher === null) return false;
  if (matcher === '=' || matcher === '~=' || matcher === '|=') return targets.includes(value);
  if (value === '') return false;
  if (matcher === '^=') return targets.some((t) => t.startsWith(value));
  if (matcher === '$=') return targets.some((t) => t.endsWith(value));
  if (matcher === '*=') return targets.some((t) => t.includes(value));
  return true; // an unknown matcher: assume it can
}

const attrName = (n: string): string => {
  const x = norm(n);
  const i = x.lastIndexOf('|');
  return i >= 0 ? x.slice(i + 1) : x;
};
const typeName = (n: string): string => {
  const x = norm(n);
  const i = x.lastIndexOf('|');
  return i >= 0 ? x.slice(i + 1) : x;
};

function newerMessage(file: string, line: number, what: string): { ms: string; en: string } {
  return {
    ms: `Kotak T95 (Chrome 91). ${file} baris ${line} guna ${what}. Gaya ini tidak akan kelihatan pada kotak ini. Waktu solat dan jam tidak terjejas.`,
    en: `T95 box (Chrome 91). ${file} line ${line} uses ${what}. This style will not show on that box. Prayer times and the clock are not affected.`,
  };
}

/** The first unbalanced or unfinished construct (unclosed block, string, comment, url), as a source offset; null when sound. */
function unfinishedAt(css: string): number | null {
  const T = csstree.tokenTypes;
  const stack: Array<{ close: number; at: number }> = [];
  let bad: number | null = null;
  csstree.tokenize(css, (type: number, start: number, end: number) => {
    if (bad !== null) return;
    switch (type) {
      case T.LeftCurlyBracket: stack.push({ close: T.RightCurlyBracket, at: start }); break;
      case T.LeftParenthesis: case T.Function: stack.push({ close: T.RightParenthesis, at: start }); break;
      case T.LeftSquareBracket: stack.push({ close: T.RightSquareBracket, at: start }); break;
      case T.RightCurlyBracket: case T.RightParenthesis: case T.RightSquareBracket: {
        const top = stack.pop();
        if (top === undefined || top.close !== type) bad = start;
        break;
      }
      case T.BadString: case T.BadUrl: bad = start; break;
      case T.Comment: if (end - start < 4 || css.slice(end - 2, end) !== '*/') bad = start; break;
      case T.String: {
        const q = css[start];
        let slashes = 0;
        for (let i = end - 2; i > start && css[i] === '\\'; i--) slashes++;
        if (end - start < 2 || css[end - 1] !== q || slashes % 2 === 1) bad = start;
        break;
      }
      case T.Url: if (css[end - 1] !== ')') bad = start; break;
      default: break;
    }
  });
  if (bad === null && stack.length > 0) bad = stack[0]!.at;
  return bad;
}

const lineOf = (css: string, offset: number): number => {
  let n = 1;
  for (let i = 0; i < offset && i < css.length; i++) if (css.charCodeAt(i) === 10) n++;
  return n;
};

/** The children of a declaration's value, or null when css-tree kept it as raw text. */
function valueNodes(decl: csstree.Declaration): CssNode[] | null {
  return decl.value.type === 'Value' ? decl.value.children.toArray() : null;
}

/** A selector that is exactly `:root`. */
function isBareRoot(sel: CssNode): boolean {
  if (sel.type !== 'Selector') return false;
  const kids = sel.children.toArray();
  return kids.length === 1 && kids[0]!.type === 'PseudoClassSelector' && norm(kids[0]!.name) === 'root';
}

/** The first compound of a selector, and the combinator that follows it. */
function leadingCompound(sel: CssNode): { nodes: CssNode[]; combinator: string | null } {
  const nodes: CssNode[] = [];
  if (sel.type !== 'Selector') return { nodes, combinator: null };
  for (const n of sel.children.toArray()) {
    if (n.type === 'Combinator') return { nodes, combinator: n.name.trim() === '' ? ' ' : n.name.trim() };
    nodes.push(n);
  }
  return { nodes, combinator: null };
}

const hasStageClass = (nodes: CssNode[]): boolean => nodes.some((n) => n.type === 'ClassSelector' && norm(n.name) === 'stage');

/** Does a selector (any compound of it) name a protected class or a data-role? */
function reachesProtected(sel: CssNode): boolean {
  let hit = false;
  csstree.walk(sel, (n: CssNode) => {
    if (n.type === 'ClassSelector' && PROTECTED_CLASS_RE.test(norm(n.name))) hit = true;
    else if (n.type === 'AttributeSelector' && attrName(n.name.name) === 'data-role') hit = true;
  });
  return hit;
}

export function checkCss(css: string, ctx: CssCheckContext): { errors: ThemeIssue[]; warnings: ThemeIssue[] } {
  const errors: ThemeIssue[] = [];
  const warnings: ThemeIssue[] = [];
  const f = ctx.file;
  const seenWarn = new Set<string>();
  const push = (list: ThemeIssue[], i: ThemeIssue): void => { if (list.length < MAX_ISSUES) list.push(i); };

  const parseErr = (line: number): void => push(errors, issue('css_parse', f, line,
    `${f} baris ${line}: CSS tidak dapat dibaca.`, `${f} line ${line}: the CSS cannot be read.`));
  const importErr = (line: number): void => push(errors, issue('css_import', f, line,
    `${f} baris ${line}: @import tidak dibenarkan.`, `${f} line ${line}: @import is not allowed.`));
  const urlErr = (line: number): void => push(errors, issue('css_url', f, line,
    `Alamat luar tidak dibenarkan. ${f} baris ${line} memuat fail dari luar tema. Letak gambar dalam folder images/.`,
    `Outside addresses are not allowed. ${f} line ${line} loads a file from outside the theme. Put pictures in images/.`));
  const scriptErr = (line: number): void => push(errors, issue('css_script', f, line,
    `${f} baris ${line}: skrip tidak dibenarkan dalam tema.`, `${f} line ${line}: scripts are not allowed in a theme.`));
  const boxErr = (line: number): void => push(errors, issue('css_box_screen', f, line,
    `${f} baris ${line}: skrin tetapan kotak MAXCOM tidak boleh digayakan.`, `${f} line ${line}: the MAXCOM box's own screens cannot be styled.`));
  const fontErr = (line: number): void => push(errors, issue('css_font', f, line,
    `${f} baris ${line}: @font-face tidak dibenarkan dalam tema (MAXCOM versi ini). Fon dipilih dalam menu Ubah suai.`,
    `${f} line ${line}: @font-face is not allowed in a theme (this MAXCOM version). The font is chosen in the Customise menu.`));
  const propErr = (line: number, what: string): void => push(errors, issue('css_property', f, line,
    `${f} baris ${line}: ${what} tidak dibenarkan dalam tema, kerana boleh menyembunyikan jam atau waktu solat.`,
    `${f} line ${line}: ${what} is not allowed in a theme, because it can hide the clock or the prayer times.`));
  const boundErr = (line: number, what: string): void => push(errors, issue('css_property', f, line,
    `${f} baris ${line}: nilai ${what} di luar had yang dibenarkan (atau guna var()/calc()), kerana boleh menutup atau menyembunyikan jam atau waktu solat.`,
    `${f} line ${line}: the value of ${what} is outside the allowed range (or uses var()/calc()), because it can cover or hide the clock or the prayer times.`));
  const varErr = (line: number, what: string): void => push(errors, issue('css_property', f, line,
    `${f} baris ${line}: pemboleh ubah ${what} tidak boleh ditetapkan oleh tema, kerana ia mengawal saiz, fon atau kedudukan. Guna nama sendiri yang bermula dengan --pack- (contoh --pack-emas), atau salah satu warna asas (--accent, --text dan seumpamanya).`,
    `${f} line ${line}: the variable ${what} cannot be set by a theme, because it controls size, font or position. Use your own name starting with --pack- (for example --pack-gold), or one of the base colours (--accent, --text and the like).`));
  const varValueErr = (line: number, what: string): void => push(errors, issue('css_property', f, line,
    `${f} baris ${line}: nilai ${what} tidak sah. Pemboleh ubah warna asas hanya menerima warna atau kecerunan; --pack-* menerima warna, kecerunan, gambar tema, nombor dan panjang kecil.`,
    `${f} line ${line}: the value of ${what} is not allowed. A base colour variable takes only a colour or gradient; --pack-* takes colours, gradients, theme pictures, numbers and small lengths.`));
  const selectorErr = (line: number, what: string): void => push(errors, issue('css_selector', f, line,
    `${f} baris ${line}: pemilih ${what} tidak dibenarkan dalam tema (hanya kelas, atribut data-* kontrak, dan :first-child/:last-child/:nth-child/:not).`,
    `${f} line ${line}: the selector ${what} is not allowed in a theme (only classes, the contract's data-* attributes, and :first-child/:last-child/:nth-child/:not).`));
  const scopeErr = (line: number): void => push(errors, issue('css_scope', f, line,
    `${f} baris ${line}: gaya tema hanya boleh mengenai pentas (.stage). html, body, #root dan :root (selain pemboleh ubah --nama) tidak dibenarkan.`,
    `${f} line ${line}: a theme may only style the stage (.stage). html, body, #root and :root (other than --name variables) are not allowed.`));
  const stringErr = (line: number): void => push(errors, issue('css_string', f, line,
    `${f} baris ${line}: teks dalam nilai pemboleh ubah (--nama) tidak dibenarkan.`,
    `${f} line ${line}: text inside a custom property (--name) value is not allowed.`));
  const warn = (line: number, what: string): void => {
    const key = `${what}|${line}`;
    if (seenWarn.has(key)) return;
    seenWarn.add(key);
    const m = newerMessage(f, line, what);
    push(warnings, issue('css_newer', f, line, m.ms, m.en));
  };

  try {
    const open = unfinishedAt(css);
    if (open !== null) parseErr(lineOf(css, open));

    const ast = csstree.parse(css, {
      positions: true,
      parseValue: true,
      parseCustomProperty: true,
      onParseError: (e: { line?: number }) => parseErr(typeof e.line === 'number' ? e.line : 1),
    });

    const fnStack: string[] = [];
    const notStack: number[] = [];
    /** One entry per rule being walked: may `:root` appear in it? (a bare :root rule that only sets --variables). */
    const rootOk: boolean[] = [];
    /** One entry per rule being walked: does its selector reach a protected element or a part of its text? (then no size property). */
    const protectedRule: boolean[] = [];
    let customDepth = 0;
    let ruleDepth = 0;
    const inUrlFunction = (): boolean => fnStack.some((n) => URL_STRING_FUNCTIONS.has(n));

    const addressNode = (value: string, line: number): void => {
      if (looksScripted(value)) scriptErr(line);
      else if (urlNotAllowed(value, ctx)) urlErr(line);
    };

    const checkDeclaration = (node: csstree.Declaration, line: number, protectedRule: boolean): void => {
      const prop = norm(node.property);
      if (prop === 'behavior' || prop === '-moz-binding') scriptErr(line);
      if (prop.startsWith('--')) {
        customDepth++;
        const cv = judgeCustomProperty(prop, valueNodes(node));
        if (cv === 'prop') varErr(line, prop);
        else if (cv === 'bound') varValueErr(line, prop);
        return;
      }
      const base = prop.replace(VENDOR_PREFIX, '');
      if (node.important !== false) propErr(line, '!important');
      const verdict = judgeDeclaration(base, valueNodes(node), protectedRule);
      if (verdict === 'prop') propErr(line, prop);
      else if (verdict === 'bound') boundErr(line, prop);
    };

    csstree.walk(ast, {
      enter(this: csstree.WalkContext, node: CssNode) {
        const line = node.loc?.start.line ?? 1;
        switch (node.type) {
          case 'Atrule': {
            const name = norm(node.name);
            if (name === 'import' || name === 'namespace') importErr(line);
            else if (name === 'font-face') fontErr(line);
            else if (name.replace(VENDOR_PREFIX, '') === 'keyframes') propErr(line, '@keyframes');
            else if (!ALLOWED_AT_RULES.has(name)) propErr(line, `@${name}`);
            else if (name === 'layer') warn(line, '@layer');
            else if (name === 'container') warn(line, '@container');
            break;
          }
          case 'Rule': {
            if (ruleDepth > 0) warn(line, 'CSS nesting');
            ruleDepth++;
            const prelude = node.prelude;
            const sels = prelude.type === 'SelectorList' ? prelude.children.toArray() : [];
            const customOnly = node.block.children.toArray().every((d) => d.type === 'Declaration' && d.property.startsWith('--'));
            rootOk.push(sels.length > 0 && sels.every(isBareRoot) && customOnly);
            protectedRule.push(sels.some(reachesProtected));
            for (const sel of sels) {
              // `.stage + x` and `.stage ~ x` reach the elements next to the stage, outside the theme's own page.
              const lead = leadingCompound(sel);
              if (lead.combinator !== null && (lead.combinator === '+' || lead.combinator === '~') && hasStageClass(lead.nodes)) scopeErr(line);
            }
            break;
          }
          case 'TypeSelector': {
            const t = typeName(node.name);
            if (t === 'html' || t === 'body') scopeErr(line);
            else selectorErr(line, t === '*' ? '*' : t);
            break;
          }
          case 'IdSelector':
            if (norm(node.name) === 'root') scopeErr(line);
            else selectorErr(line, `#${norm(node.name)}`);
            break;
          case 'ClassSelector':
            if (isBoxClass(norm(node.name))) boxErr(line);
            break;
          case 'PseudoElementSelector':
            selectorErr(line, `::${norm(node.name)}`);
            break;
          case 'AttributeSelector': {
            const name = attrName(node.name.name);
            const value = node.value === null ? '' : norm(node.value.type === 'String' ? node.value.value : node.value.name);
            const matcher = node.matcher;
            if (name === 'data-screen') {
              // A bare [data-screen] is allowed. Inside :not() any value reaches the box screens too.
              if (matcher !== null && matcherCouldMatch(matcher, value, BOX_SCREEN_IDS)) boxErr(line);
              else if (notStack.length > 0) boxErr(line);
            } else if (name !== 'class' && !ALLOWED_DATA_ATTRS.has(name)) {
              selectorErr(line, `[${name}]`);
            } else if (name === 'class') {
              // Only `[class~="name"]` with one plain class name that is not a box screen class: it matches that token and nothing else.
              const plain = matcher === '~=' && /^[a-z][a-z0-9_-]{0,63}$/.test(value) && !BOX_CLASS_TARGETS.includes(value);
              if (!plain) boxErr(line);
            }
            break;
          }
          case 'PseudoClassSelector': {
            const name = norm(node.name);
            if (!ALLOWED_PSEUDO_CLASSES.has(name)) selectorErr(line, `:${name}`);
            if (name === 'not') notStack.push(1);
            if (name === 'root' && rootOk[rootOk.length - 1] !== true) scopeErr(line);
            break;
          }
          case 'Function': {
            const name = norm(node.name);
            if (node.name.includes('\\')) propErr(line, 'a function name written with an escape');
            if (name === 'var' && inUrlFunction()) urlErr(line);
            fnStack.push(name);
            if (name === 'expression') scriptErr(line);
            else if (REFUSED_FUNCTIONS.has(name)) propErr(line, `${name}()`);
            else if (name === 'color-mix') warn(line, 'color-mix()');
            break;
          }
          case 'Dimension': {
            const unit = node.unit.toLowerCase();
            if (NEWER_UNITS.has(unit)) warn(line, `${unit} unit`);
            break;
          }
          case 'Declaration':
            // (a declaration inside an at-rule's own condition, such as @supports (display:grid), is a test, not a style)
            if (this.rule !== null) checkDeclaration(node, line, protectedRule[protectedRule.length - 1] === true);
            break;
          case 'Url':
            addressNode(node.value, line);
            break;
          case 'String':
            if (looksScripted(node.value)) scriptErr(line);
            else if (customDepth > 0) stringErr(line);
            else if (inUrlFunction() && urlNotAllowed(node.value, ctx)) urlErr(line);
            break;
          case 'Raw': {
            // Left unparsed by css-tree (a parse error is already reported): still look for what it could hide.
            const text = norm(node.value);
            if (looksScripted(node.value) || /expression\s*\(/.test(text)) scriptErr(line);
            if (/@import|@namespace/.test(text)) importErr(line);
            if (/(?:^|[^a-z0-9-])(?:url|src|image-set|-webkit-image-set|image)\s*\(/.test(text)) urlErr(line);
            if (text.includes('box-screen') || /data-screen/.test(text)) boxErr(line);
            if (customDepth > 0 && /["']/.test(text)) stringErr(line);
            break;
          }
          default:
            break;
        }
      },
      leave(node: CssNode) {
        if (node.type === 'Function') fnStack.pop();
        else if (node.type === 'Rule') { ruleDepth--; rootOk.pop(); protectedRule.pop(); }
        else if (node.type === 'PseudoClassSelector' && norm(node.name) === 'not') notStack.pop();
        else if (node.type === 'Declaration' && norm(node.property).startsWith('--')) customDepth--;
      },
    });
  } catch {
    // Deeply nested or otherwise hostile input that the parser cannot handle: refuse, never throw.
    parseErr(1);
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------------------------------------------

interface Edit { at: number; end: number; text: string }

function applyEdits(css: string, edits: Edit[]): string {
  let out = css;
  for (const e of [...edits].sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.end);
  return out;
}

const parseForEdit = (css: string): CssNode => csstree.parse(css, { positions: true, parseValue: true, parseCustomProperty: true });

/** At-rules whose rules are style rules of the stage. */
const TRANSPARENT_AT_RULES = new Set(['media', 'supports', 'layer', 'container', 'document', '-moz-document']);

/**
 * Every selector of a pack stylesheet is put under this theme's own stage: `.stage[data-theme='<name>']` (and, for a
 * screens/<id>.css file, `[data-screen='<id>']`), merged into a leading `.stage` compound, else added as an ancestor.
 * A bare `:root` rule (the validator allows only --variables in it) becomes the scoped stage. Nothing a pack writes can
 * reach another theme, the box's own screens, or the page around the stage.
 */
export function scopePackCss(css: string, o: { theme: string; screen?: ScreenId }): string {
  if (!isThemeName(o.theme)) throw new Error('bad theme name');
  const attrs = `[data-theme='${o.theme}']${o.screen === undefined ? '' : `[data-screen='${o.screen}']`}`;
  const ast = parseForEdit(css);
  const edits: Edit[] = [];
  const atStack: string[] = [];
  let ruleDepth = 0;
  csstree.walk(ast, {
    enter(node: CssNode) {
      if (node.type === 'Atrule') atStack.push(norm(node.name));
      if (node.type !== 'Rule') return;
      const top = ruleDepth === 0 && atStack.every((n) => TRANSPARENT_AT_RULES.has(n));
      ruleDepth++;
      if (!top || node.loc == null) return;
      if (node.prelude.type !== 'SelectorList') {
        // Cannot be scoped: the rule is dropped (an accepted file never reaches this).
        edits.push({ at: node.loc.start.offset, end: node.loc.end.offset, text: '' });
        return;
      }
      node.prelude.children.forEach((sel) => {
        if (sel.type !== 'Selector' || sel.loc == null) return;
        const first = sel.children.first;
        if (isBareRoot(sel)) {
          edits.push({ at: sel.loc.start.offset, end: sel.loc.end.offset, text: `.stage${attrs}` });
        } else if (first != null && first.type === 'ClassSelector' && norm(first.name) === 'stage' && first.loc != null) {
          edits.push({ at: first.loc.end.offset, end: first.loc.end.offset, text: attrs });
        } else {
          edits.push({ at: sel.loc.start.offset, end: sel.loc.start.offset, text: `.stage${attrs} ` });
        }
      });
    },
    leave(node: CssNode) {
      if (node.type === 'Atrule') atStack.pop();
      else if (node.type === 'Rule') ruleDepth--;
    },
  });
  return applyEdits(css, edits);
}

/** Every url() that passed the check becomes an absolute path under `base` (for example '/themes/hijau-siti/<hash>/'). */
export function rewriteUrls(css: string, base: string): string {
  const root = base.endsWith('/') ? base : `${base}/`;
  const ast = parseForEdit(css);
  const edits: Edit[] = [];
  const fnStack: string[] = [];
  const target = (value: string): string => {
    const m = /^(?:\.{1,2}\/)?images\/([^/\\"']+)$/.exec(value);
    return m === null ? '' : `${root}images/${m[1]}`;
  };
  csstree.walk(ast, {
    enter(node: CssNode) {
      if (node.type === 'Function') fnStack.push(norm(node.name));
      else if (node.type === 'Url' && node.loc != null) {
        edits.push({ at: node.loc.start.offset, end: node.loc.end.offset, text: `url("${target(node.value)}")` });
      } else if (node.type === 'String' && node.loc != null && fnStack.some((n) => URL_STRING_FUNCTIONS.has(n))) {
        edits.push({ at: node.loc.start.offset, end: node.loc.end.offset, text: `"${target(node.value)}"` });
      }
    },
    leave(node: CssNode) {
      if (node.type === 'Function') fnStack.pop();
    },
  });
  return applyEdits(css, edits);
}
