import { sourceUrlError } from '../net.ts';
import { validateImageRef } from '../image.ts';
import { isoInstantMs } from '../sync/merge.ts';
import { FEATURES, KIOSK_TEMPLATE_IDS } from './registry.ts';
import { SURAHS } from './lists.ts';
import { isCountryCode } from '../prayer/countries.ts';
import { isValidTimeZone } from '../time.ts';
import type { FeatureDef, FeatureKey, FeatureSettings, Settings } from './registry.ts';

const BY_KEY = new Map<string, FeatureDef>(FEATURES.map((f) => [f.key, f]));
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function isFeatureKey(k: string): k is FeatureKey {
  return BY_KEY.has(k);
}

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Constraint for a leaf, picked by the top-level setting name it sits under. */
type Rule =
  | { t: 'int'; min: number; max: number }
  | { t: 'enum'; vals: readonly string[] }
  | { t: 'intSet'; vals: readonly number[] }
  | { t: 'regex'; re: RegExp; what: string }
  | { t: 'text'; min: number; max: number; re?: RegExp; what?: string }
  | { t: 'sourceUrl' }
  | { t: 'decimal'; min: number; max: number; places: number; nullable: boolean }
  | { t: 'timeZone' }
  | { t: 'country' };

/** Settings whose children are `{ name, url }` pairs; their leaves are ruled by `ds.<leaf>`, not by the parent name. */
const SOURCE_KEYS: ReadonlySet<string> = new Set(['esolat', 'esolatZones', 'nominatim', 'quranText', 'quranAudio', 'hadeethenc']);
const leafRuleName = (top: string, k: string): string => (SOURCE_KEYS.has(top) ? `ds.${k}` : top);

const MIN120: Rule = { t: 'int', min: 0, max: 120 };
const SEC600: Rule = { t: 'int', min: 0, max: 600 };

function ruleFor(name: string): Rule | undefined {
  if (name === 'segmentMinutes') return { t: 'int', min: 5, max: 60 };
  // Explicit cases first: both names also match the generic minutes rule below, which would allow 0..120.
  if (name === 'adjustMinutes') return { t: 'int', min: -30, max: 30 };
  if (name === 'imsakMinutes') return { t: 'int', min: 5, max: 20 };
  if (name === 'minutes' || name.startsWith('minutes') || name.endsWith('Minutes')) return MIN120;
  if (name === 'screenSeconds' || name === 'endWarningSeconds' || name === 'durationSeconds') return SEC600;
  // Every amount setting is whole sen, up to RM 1 billion.
  if (name.length > 3 && name.endsWith('Sen')) return { t: 'int', min: 0, max: 100_000_000_000 };
  switch (name) {
    case 'volume': return { t: 'int', min: 0, max: 100 };
    case 'adjustDays': return { t: 'int', min: -2, max: 2 };
    case 'hijriMonth': return { t: 'int', min: 1, max: 12 };
    case 'switchAt': return { t: 'enum', vals: ['maghrib', 'midnight'] };
    case 'timeFormat': return { t: 'enum', vals: ['12h', '24h'] };
    case 'lang': return { t: 'enum', vals: ['ms', 'en'] };
    case 'mode': return { t: 'enum', vals: ['landscape', 'portrait'] };
    case 'templateId': return { t: 'enum', vals: KIOSK_TEMPLATE_IDS };
    case 'rotate': return { t: 'enum', vals: ['daily', 'hourly', 'off'] };
    case 'order': return { t: 'int', min: 0, max: 99 };
    case 'daysAhead': return { t: 'int', min: 1, max: 60 };
    case 'maxItems': return { t: 'int', min: 1, max: 20 };
    case 'count': return { t: 'int', min: 1, max: 10 };
    case 'ayatFrom': return { t: 'int', min: 1, max: 286 };
    case 'ayatTo': return { t: 'int', min: 1, max: 286 };
    case 'surah': return { t: 'int', min: 1, max: 114 };
    case 'cacheMaxMb': return { t: 'int', min: 50, max: 2000 };
    case 'pick': return { t: 'enum', vals: ['daily', 'random', 'manual'] };
    case 'fit': return { t: 'enum', vals: ['cover', 'contain'] };
    case 'privacy': return { t: 'enum', vals: ['public', 'unlisted', 'private'] };
    case 'relayFrom': return { t: 'enum', vals: ['box', 'phone'] };
    case 'noVideoSeconds': return { t: 'int', min: 5, max: 60 };
    case 'cloudWakeSeconds': return { t: 'int', min: 10, max: 60 };
    case 'syncHistoryDays': return { t: 'intSet', vals: [180, 365] };
    case 'message': return { t: 'text', min: 1, max: 100 };
    case 'relayVideo': return { t: 'enum', vals: ['copy', 'reencode'] };
    case 'maxBitrateKbps': return { t: 'int', min: 500, max: 6000 };
    case 'titleTemplate': return { t: 'text', min: 1, max: 100 };
    case 'descriptionTemplate': return { t: 'text', min: 0, max: 500 };
    case 'speed': return { t: 'enum', vals: ['slow', 'normal', 'fast'] };
    case 'shape': return { t: 'enum', vals: ['round', 'square'] };
    case 'source': return { t: 'enum', vals: ['own', 'hadeethenc', 'both'] };
    case 'mix': return { t: 'enum', vals: ['list', 'alternate', 'random'] };
    case 'changeEvery': return { t: 'enum', vals: ['day', 'card'] };
    case 'perDay': return { t: 'int', min: 1, max: 10 };
    case 'fontSize': return { t: 'enum', vals: ['auto', 's', 'm', 'l'] };
    case 'textSize': return { t: 'enum', vals: ['s', 'm', 'l'] };
    case 'ds.name': return { t: 'text', min: 1, max: 60, re: /^[^<>\x00-\x1f\x7f]+$/, what: 'plain text' };
    case 'ds.url': return { t: 'sourceUrl' };
    case 'name': return { t: 'text', min: 1, max: 80 };
    case 'kind': return { t: 'enum', vals: ['surau', 'masjid'] };
    case 'shortAddress': return { t: 'text', min: 0, max: 120 };
    case 'helpName': return { t: 'text', min: 0, max: 60 };
    case 'helpPhone': return { t: 'text', min: 0, max: 30, re: /^\+?[0-9][0-9 -]{6,18}$/, what: 'a phone number like 012-345 6789' };
    case 'helpEmail': return { t: 'text', min: 0, max: 120, re: /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/, what: 'an email address like name@example.my' };
    case 'reciter': return { t: 'regex', re: /^[A-Za-z0-9_]{3,64}$/, what: 'a reciter folder name' };
    case 'dirtyCheckSeconds': return { t: 'int', min: 60, max: 900 };
    case 'keepDays': return { t: 'intSet', vals: [0, 1, 3, 7, 30] };
    case 'replaceGappyLive': return { t: 'enum', vals: ['ask', 'never', 'always'] };
    case 'cloudUrl': return { t: 'text', min: 0, max: 200, re: /^https:\/\/[^\s<>\u0000-\u001f\u007f]+$/, what: 'an https:// address' };
    case 'latitude': return { t: 'decimal', min: -90, max: 90, places: 4, nullable: true };
    case 'longitude': return { t: 'decimal', min: -180, max: 180, places: 4, nullable: true };
    case 'country': return { t: 'country' };
    case 'timezone': return { t: 'timeZone' };
    case 'city': return { t: 'text', min: 0, max: 80 };
    case 'method': return { t: 'enum', vals: ['auto', 'mwl', 'egyptian', 'karachi', 'ummAlQura', 'dubai', 'qatar', 'kuwait', 'moonsighting', 'singapore', 'tehran', 'turkey', 'northAmerica', 'jakim', 'kemenag', 'uoif', 'morocco', 'algeria', 'russia'] };
    case 'madhab': return { t: 'enum', vals: ['auto', 'shafi', 'hanafi'] };
    case 'highLatitude': return { t: 'enum', vals: ['auto', 'middleOfNight', 'seventhOfNight', 'twilightAngle'] };
    case 'zone': return { t: 'regex', re: /^[A-Z]{3}\d{2}$/, what: 'a zone code like SGR01' };
    case 'figure': return { t: 'enum', vals: ['balance', 'month', 'lastEntry'] };
    case 'highlightSeconds': return { t: 'int', min: 0, max: 120 };
    case 'qrAssetId': return { t: 'regex', re: /^$|^[0-9a-f]{64}$/, what: 'a picture id or empty' };
    case 'manualTitle': return { t: 'text', min: 0, max: 40 };
    case 'row1Label': case 'row2Label': case 'row3Label': return { t: 'text', min: 0, max: 40 };
    case 'penceramahFundId': return { t: 'regex', re: /^$|^[A-Za-z0-9_-]{1,100}$/, what: 'a tabung id or empty' };
    case 'startedOn': return { t: 'regex', re: /^$|^\d{4}-\d{2}-\d{2}$/, what: 'a date YYYY-MM-DD or empty' };
    default: return undefined;
  }
}

const MAX_TEXT = 500;
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const ASSET_ID_RE = /^[0-9a-f]{64}$/;
const MAX_IMAGES = 20;
const IMAGE_RE = /^(?:[0-9a-f]{64}|[a-z0-9-]{1,40}|\/uploads\/[A-Za-z0-9._-]{1,100})$/;
const validImage = (x: unknown): boolean =>
  typeof x === 'string' && IMAGE_RE.test(x) && !x.includes('..');

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Error text for a leaf value against the default's type and the name rule, or null if fine. */
function leafError(path: string, name: string, v: unknown, d: unknown): string | null {
  // The logo is the one setting that holds an image: '' (none), a plain asset id, or an adjusted image.
  if (name === 'logo') {
    if (v === '') return null;
    const errs: string[] = [];
    validateImageRef(path, v, errs, 'logo');
    return errs.length === 0 ? null : errs[0]!;
  }
  const rule = ruleFor(name);
  if (typeof d === 'boolean') return typeof v === 'boolean' ? null : `${path} must be true or false`;
  if (typeof d === 'number') {
    if (rule?.t === 'intSet') {
      return typeof v === 'number' && rule.vals.includes(v)
        ? null : `${path} must be one of ${rule.vals.join(', ')}`;
    }
    const r = rule && rule.t === 'int' ? rule : { t: 'int' as const, min: 0, max: 1000000 };
    return typeof v === 'number' && Number.isInteger(v) && v >= r.min && v <= r.max
      ? null : `${path} must be an integer ${r.min}..${r.max}`;
  }
  if (typeof d === 'string') {
    if (typeof v !== 'string') return `${path} must be text`;
    if (v.length > MAX_TEXT) return `${path} must be at most ${MAX_TEXT} characters`;
    if (rule?.t === 'enum' && !rule.vals.includes(v)) return `${path} must be one of ${rule.vals.join(', ')}`;
    if (rule?.t === 'country' && !isCountryCode(v)) return `${path} must be a two-letter country code like MY`;
    if (rule?.t === 'timeZone' && !isValidTimeZone(v)) return `${path} must be a time zone like Asia/Kuala_Lumpur`;
    if (rule?.t === 'regex' && !rule.re.test(v)) return `${path} must be ${rule.what}`;
    if (rule?.t === 'sourceUrl') {
      const e = sourceUrlError(v);
      return e === null ? null : `${path} ${e}`;
    }
    if (rule?.t === 'text') {
      const len = v.trim().length;
      if (len < rule.min) return `${path} is required`;
      if (v.length > rule.max) return `${path} must be at most ${rule.max} characters`;
      if (rule.re && v !== '' && !rule.re.test(v)) return `${path} must be ${rule.what ?? 'valid'}`;
    }
    return null;
  }
  if (d === null) {
    if (rule?.t === 'decimal') {
      if (v === null) return rule.nullable ? null : `${path} is required`;
      const ok = typeof v === 'number' && Number.isFinite(v) && v >= rule.min && v <= rule.max
        && Number(v.toFixed(rule.places)) === v;
      return ok ? null : `${path} must be a number ${rule.min}..${rule.max} with at most ${rule.places} decimals, or empty`;
    }
    if (name === 'override') return v === null || (typeof v === 'string' && HEX_RE.test(v)) ? null : `${path} must be null or a colour like #12AB34`;
    if (name === 'audioFile') return v === null || (typeof v === 'string' && ASSET_ID_RE.test(v)) ? null : `${path} must be null or an audio file id`;
    if (name === 'suspendedAt') return v === null || (typeof v === 'string' && isoInstantMs(v) !== null) ? null : `${path} must be null or a time`;
    if (typeof v === 'string' && v.length > MAX_TEXT) return `${path} must be at most ${MAX_TEXT} characters`;
    return v === null || typeof v === 'string' ? null : `${path} must be text or null`;
  }
  if (Array.isArray(d)) {
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return `${path} must be a list of text`;
    if (v.some((x) => (x as string).length > MAX_TEXT)) return `${path} items must be at most ${MAX_TEXT} characters`;
    if (name === 'sourceOrder') {
      const want = ['official', 'calc', 'file'];
      if (v.length !== 3 || !want.every((x) => v.includes(x))) {
        return `${path} must list official, calc and file exactly once each`;
      }
    }
    if (name === 'images') {
      if (v.length > MAX_IMAGES) return `${path} may have at most ${MAX_IMAGES} items`;
      if (!v.every(validImage)) {
        return `${path} items must be a built-in name (a-z, 0-9, -), a box picture id or /uploads/<file name>`;
      }
    }
    return null;
  }
  return `${path} is not a supported setting`;
}

/** Validate a (partial) object against a default object's shape. Collects errors. */
function checkObject(path: string, name: string, v: unknown, d: Plain, errors: string[]): void {
  if (!isPlain(v)) { errors.push(`${path} must be an object`); return; }
  for (const k of Object.keys(v)) {
    const sub = `${path}.${k}`;
    if (!has(d, k)) { errors.push(`${sub} is not a known setting`); continue; }
    const dv = d[k];
    if (isPlain(dv)) checkObject(sub, name, v[k], dv, errors);
    else {
      const e = leafError(sub, leafRuleName(name, k), v[k], dv);
      if (e) errors.push(e);
    }
  }
}

/** Stored value for a leaf if usable; for the background list, drops bad entries and falls back to the default. */
function storedLeaf(name: string, stored: Plain, k: string, dv: unknown): { v: unknown } | null {
  if (!has(stored, k)) return null;
  const raw = stored[k];
  if (name === 'images' && Array.isArray(dv) && Array.isArray(raw)) {
    const kept = raw.filter(validImage).slice(0, MAX_IMAGES);
    return { v: kept.length > 0 ? kept : dv };
  }
  return leafError(k, name, raw, dv) === null ? { v: raw } : null;
}

/** Deep-merge stored over defaults; invalid or unknown stored data is ignored. Never throws. */
function mergeObject(name: string, stored: unknown, d: Plain): Plain {
  const out: Plain = {};
  const s: Plain = isPlain(stored) ? stored : {};
  for (const k of Object.keys(d)) {
    const dv = d[k];
    if (isPlain(dv)) out[k] = mergeObject(name, s[k], dv);
    else {
      const hit = storedLeaf(leafRuleName(name, k), s, k, dv);
      out[k] = clone(hit ? hit.v : dv);
    }
  }
  return out;
}

/** Defaults plus stored values, validated; locked features forced on. Never throws. */
export function resolveSettings(stored: Partial<Record<string, Partial<FeatureSettings>>>): Settings {
  const src: Plain = isPlain(stored) ? stored : {};
  const out = {} as Settings;
  for (const f of FEATURES) {
    const raw = has(src, f.key) ? src[f.key] : undefined;
    const s: Plain = isPlain(raw) ? raw : {};
    const merged: Plain = {};
    for (const k of Object.keys(f.defaults)) {
      const dv = f.defaults[k];
      if (isPlain(dv)) merged[k] = mergeObject(k, s[k], dv);
      else {
        const hit = storedLeaf(k, s, k, dv);
        merged[k] = clone(hit ? hit.v : dv);
      }
    }
    const enabled = f.locked ? true : typeof s.enabled === 'boolean' ? s.enabled : f.defaultEnabled;
    (out as Record<FeatureKey, FeatureSettings>)[f.key] = { ...merged, enabled };
  }
  return out;
}

/** Rules that look at several fields at once, run on the patch merged over the stored/default values. */
const FEATURE_RULES: Partial<Record<FeatureKey, (merged: Plain, errors: string[]) => void>> = {
  ayatCard(m, errors) {
    const surah = m.surah;
    const from = m.ayatFrom;
    const to = m.ayatTo;
    if (typeof surah !== 'number' || typeof from !== 'number' || typeof to !== 'number') return;
    const s = SURAHS[surah - 1];
    if (!s) return;
    if (to > s.ayat) { errors.push(`ayatTo: ${s.nameMs} has ${s.ayat} verses`); return; }
    if (from > s.ayat) { errors.push(`ayatFrom: ${s.nameMs} has ${s.ayat} verses`); return; }
    if (from > to) { errors.push('ayatFrom must not be after ayatTo'); return; }
    if (to - from > 4) errors.push('ayatCard shows at most 5 verses at once');
  },
};

/** The fields a cross-field rule reads: the rule runs only when a patch touches one of them (an old stored row that breaks it stays savable). */
const RULE_FIELDS: Partial<Record<FeatureKey, readonly string[]>> = {
  ayatCard: ['surah', 'ayatFrom', 'ayatTo'],
};

export function validateFeatureSettings(
  key: FeatureKey,
  patch: unknown,
  current?: Partial<FeatureSettings>,
): { ok: true; value: Partial<FeatureSettings> } | { ok: false; errors: string[] } {
  const f = BY_KEY.get(key);
  if (!f) return { ok: false, errors: [`unknown feature ${String(key)}`] };
  if (!isPlain(patch)) return { ok: false, errors: ['settings must be an object'] };
  const errors: string[] = [];
  for (const k of Object.keys(patch)) {
    if (k === 'enabled') {
      if (typeof patch.enabled !== 'boolean') errors.push('enabled must be true or false');
      else if (f.locked && !patch.enabled) errors.push(`${key} is locked and cannot be switched off`);
      continue;
    }
    if (!has(f.defaults, k)) { errors.push(`${k} is not a known setting`); continue; }
    const dv = f.defaults[k];
    if (isPlain(dv)) checkObject(k, k, patch[k], dv, errors);
    else {
      const e = leafError(k, k, patch[k], dv);
      if (e) errors.push(e);
    }
  }
  const rule = FEATURE_RULES[key];
  if (rule && current !== undefined && errors.length === 0 && (RULE_FIELDS[key] ?? []).some((k) => has(patch, k))) {
    const defaults = f.defaults as Plain;
    const merged: Plain = { ...defaults, ...(isPlain(current) ? current : {}), ...patch };
    rule(merged, errors);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: patch as Partial<FeatureSettings> };
}
