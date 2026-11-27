// Per-TV choices (feature `tvProfiles`, map field `tvs`). One surau, several TVs: each TV may override a few
// surau values; a missing field means "follow the surau". Browser-safe: no Node or kiosk-only imports.

import { THEME_NAME_RE } from '../theme/catalog.ts';

/** The most TVs one surau keeps a profile for. */
export const MAX_TVS = 16;
/** The most removals (`{ id: null }`) one patch may carry. */
const MAX_TV_REMOVALS = 64;
/** A TV id: `self` (the box's own TV) or the id of a paired device. */
export const TV_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** The id of the box's own TV (the loopback kiosk). */
export const SELF_TV = 'self';
/** The content kinds a TV may hide: the lists the kiosk content builder emits. Prayer times, azan and iqamah are never hideable. */
export const TV_HIDE_KINDS = [
  'kuliah', 'pengumuman', 'ticker', 'poster', 'video', 'programKhas', 'takwim', 'hadis', 'worldTime', 'tugasan', 'zikir', 'tabung',
] as const;
export type TvHideKind = (typeof TV_HIDE_KINDS)[number];
const MAX_HIDE_KINDS = 20;

export interface TvProfileLive {
  show?: boolean;
  audio?: boolean;
  volume?: number;
  fit?: 'cover' | 'contain';
  showStrip?: boolean;
}
export interface TvProfileSounds {
  beeps?: boolean;
  azan?: boolean;
  tilawah?: boolean;
}
export interface TvProfile {
  name?: string;
  templateId?: string;
  orientation?: 'landscape' | 'portrait';
  lang?: 'auto' | 'ms' | 'en' | 'ar';
  live?: TvProfileLive;
  hideKinds?: TvHideKind[];
  sounds?: TvProfileSounds;
}
export type TvProfiles = Record<string, TvProfile>;

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** True for a usable TV id (`__proto__` would make a map entry set a prototype, so it is never an id). */
export const isTvId = (k: unknown): k is string => typeof k === 'string' && TV_ID_RE.test(k) && k !== '__proto__';

const ORIENTATIONS: readonly string[] = ['landscape', 'portrait'];
const LANGS: readonly string[] = ['auto', 'ms', 'en', 'ar'];
const FITS: readonly string[] = ['cover', 'contain'];
const PROFILE_KEYS = ['name', 'templateId', 'orientation', 'lang', 'live', 'hideKinds', 'sounds'];
const LIVE_KEYS = ['show', 'audio', 'volume', 'fit', 'showStrip'];
const SOUND_KEYS = ['beeps', 'azan', 'tilawah'];

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const nameOk = (v: unknown): v is string => typeof v === 'string' && v.length <= 80 && !CONTROL_RE.test(v) && v.trim().length >= 1 && v.trim().length <= 40;

function profileError(path: string, p: unknown): string | null {
  if (!isPlain(p)) return `${path} must be an object`;
  for (const k of Object.keys(p)) {
    if (!PROFILE_KEYS.includes(k)) return `${path}.${k} is not a known setting`;
  }
  if (has(p, 'name') && !nameOk(p.name)) return `${path}.name must be 1..40 plain characters`;
  if (has(p, 'templateId') && !(typeof p.templateId === 'string' && THEME_NAME_RE.test(p.templateId))) {
    return `${path}.templateId must be a theme name (a-z, 0-9, hyphen, at most 32)`;
  }
  if (has(p, 'orientation') && !(typeof p.orientation === 'string' && ORIENTATIONS.includes(p.orientation))) {
    return `${path}.orientation must be one of ${ORIENTATIONS.join(', ')}`;
  }
  if (has(p, 'lang') && !(typeof p.lang === 'string' && LANGS.includes(p.lang))) return `${path}.lang must be one of ${LANGS.join(', ')}`;
  if (has(p, 'live')) {
    const l = p.live;
    if (!isPlain(l)) return `${path}.live must be an object`;
    for (const k of Object.keys(l)) {
      if (!LIVE_KEYS.includes(k)) return `${path}.live.${k} is not a known setting`;
    }
    for (const k of ['show', 'audio', 'showStrip']) {
      if (has(l, k) && !isBool(l[k])) return `${path}.live.${k} must be true or false`;
    }
    if (has(l, 'volume') && !(typeof l.volume === 'number' && Number.isInteger(l.volume) && l.volume >= 0 && l.volume <= 100)) {
      return `${path}.live.volume must be an integer 0..100`;
    }
    if (has(l, 'fit') && !(typeof l.fit === 'string' && FITS.includes(l.fit))) return `${path}.live.fit must be one of ${FITS.join(', ')}`;
  }
  if (has(p, 'hideKinds')) {
    const h = p.hideKinds;
    if (!Array.isArray(h)) return `${path}.hideKinds must be a list`;
    if (h.length > MAX_HIDE_KINDS) return `${path}.hideKinds may have at most ${MAX_HIDE_KINDS} items`;
    if (!h.every((x) => typeof x === 'string' && (TV_HIDE_KINDS as readonly string[]).includes(x))) {
      return `${path}.hideKinds must list known content kinds`;
    }
    if (new Set(h).size !== h.length) return `${path}.hideKinds must not repeat a kind`;
  }
  if (has(p, 'sounds')) {
    const s = p.sounds;
    if (!isPlain(s)) return `${path}.sounds must be an object`;
    for (const k of Object.keys(s)) {
      if (!SOUND_KEYS.includes(k)) return `${path}.sounds.${k} is not a known setting`;
      if (!isBool(s[k])) return `${path}.sounds.${k} must be true or false`;
    }
  }
  return null;
}

/**
 * Null when `raw` is a valid `tvs` value or patch. A TV is `{...profile}`; `null` removes that TV (a patch only: the stored
 * row keeps the null so the removal travels to the other boxes and the cloud, and a read never shows it).
 */
export function tvProfilesError(raw: unknown): string | null {
  if (!isPlain(raw)) return 'tvs must be an object';
  let live = 0;
  let removals = 0;
  for (const id of Object.keys(raw)) {
    if (!isTvId(id)) return `tvs.${id} is not a valid TV id`;
    if (raw[id] === null) {
      removals++;
      continue;
    }
    live++;
    const e = profileError(`tvs.${id}`, raw[id]);
    if (e) return e;
  }
  if (live > MAX_TVS) return `tvs may hold at most ${MAX_TVS} TVs`;
  if (removals > MAX_TV_REMOVALS) return `tvs may remove at most ${MAX_TV_REMOVALS} TVs at once`;
  return null;
}

/** Number of live (not removed) TVs in a stored `tvs` map. */
export function tvCount(map: unknown): number {
  return isPlain(map) ? Object.keys(map).filter((k) => map[k] !== null && map[k] !== undefined).length : 0;
}

/** One profile cleaned for a read: only known, valid fields survive. */
function cleanProfile(p: Plain): TvProfile {
  const out: TvProfile = {};
  if (nameOk(p.name)) out.name = p.name.trim();
  if (typeof p.templateId === 'string' && THEME_NAME_RE.test(p.templateId)) out.templateId = p.templateId;
  if (typeof p.orientation === 'string' && ORIENTATIONS.includes(p.orientation)) out.orientation = p.orientation as TvProfile['orientation'];
  if (typeof p.lang === 'string' && LANGS.includes(p.lang)) out.lang = p.lang as TvProfile['lang'];
  if (isPlain(p.live)) {
    const l = p.live;
    const live: TvProfileLive = {};
    if (isBool(l.show)) live.show = l.show;
    if (isBool(l.audio)) live.audio = l.audio;
    if (typeof l.volume === 'number' && Number.isInteger(l.volume) && l.volume >= 0 && l.volume <= 100) live.volume = l.volume;
    if (typeof l.fit === 'string' && FITS.includes(l.fit)) live.fit = l.fit as 'cover' | 'contain';
    if (isBool(l.showStrip)) live.showStrip = l.showStrip;
    if (Object.keys(live).length > 0) out.live = live;
  }
  if (Array.isArray(p.hideKinds)) {
    const seen = new Set<string>();
    const kinds: TvHideKind[] = [];
    for (const x of p.hideKinds) {
      if (kinds.length >= MAX_HIDE_KINDS) break;
      if (typeof x === 'string' && (TV_HIDE_KINDS as readonly string[]).includes(x) && !seen.has(x)) {
        seen.add(x);
        kinds.push(x as TvHideKind);
      }
    }
    if (kinds.length > 0) out.hideKinds = kinds;
  }
  if (isPlain(p.sounds)) {
    const s = p.sounds;
    const sounds: TvProfileSounds = {};
    for (const k of SOUND_KEYS) if (isBool(s[k])) sounds[k as keyof TvProfileSounds] = s[k];
    if (Object.keys(sounds).length > 0) out.sounds = sounds;
  }
  return out;
}

/** Read side: keeps the TVs with a usable id and drops removed entries, junk fields and anything past the cap. Never throws. */
export function sanitizeTvProfiles(raw: unknown): TvProfiles {
  const out: TvProfiles = {};
  if (!isPlain(raw)) return out;
  let n = 0;
  for (const id of Object.keys(raw)) {
    if (n >= MAX_TVS) break;
    if (!isTvId(id) || !isPlain(raw[id])) continue;
    out[id] = cleanProfile(raw[id]);
    n++;
  }
  return out;
}
