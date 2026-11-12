import { DAY_KEYS } from '../features/registry.ts';
import { validateImageRef } from '../image.ts';
import type { ImageRef, ImageSlotKey } from '../image.ts';
import type { ContentKind, ContentItemOf, HadisExt } from './types.ts';

export const CONTENT_KINDS: readonly ContentKind[] = [
  'penceramah',
  'kitab',
  'kuliah',
  'pengumuman',
  'ticker',
  'poster',
  'programKhas',
  'takwim',
  'hadis',
  'worldTime',
  'petugas',
  'tugasan',
  'zikir',
  'tilawahSlot',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const TZ_RE = /^(?:[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+\-]+){1,2}|UTC)$/;
function isIanaZone(tz: string): boolean {
  if (!TZ_RE.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
const MAX_TEXT = 2000;
const MAX_TICKER = 300;
const MAX_POSTER_TITLE = 80;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function checkDate(path: string, v: unknown, errors: string[]): string | undefined {
  if (typeof v !== 'string' || !DATE_RE.test(v)) {
    errors.push(`${path} must be a date YYYY-MM-DD`);
    return undefined;
  }
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    errors.push(`${path} is not a valid calendar date`);
    return undefined;
  }
  return v;
}

function checkTime(path: string, v: unknown, errors: string[]): string | undefined {
  if (typeof v !== 'string' || !TIME_RE.test(v)) {
    errors.push(`${path} must be a time HH:mm`);
    return undefined;
  }
  const [hh, mm] = v.split(':').map(Number) as [number, number];
  if (hh > 23 || mm > 59) {
    errors.push(`${path} is not a valid time`);
    return undefined;
  }
  return v;
}

function checkDateTime(path: string, v: unknown, errors: string[]): string | undefined {
  if (typeof v !== 'string' || !DATETIME_RE.test(v)) {
    errors.push(`${path} must be a date-time YYYY-MM-DDTHH:mm`);
    return undefined;
  }
  const [date, time] = v.split('T') as [string, string];
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const t = new Date(Date.UTC(y, m - 1, d, hh, mm));
  if (
    t.getUTCFullYear() !== y ||
    t.getUTCMonth() !== m - 1 ||
    t.getUTCDate() !== d ||
    t.getUTCHours() !== hh ||
    t.getUTCMinutes() !== mm
  ) {
    errors.push(`${path} is not a valid date-time`);
    return undefined;
  }
  return v;
}

function checkText(path: string, v: unknown, errors: string[], max = MAX_TEXT): string | undefined {
  if (typeof v !== 'string') {
    errors.push(`${path} must be text`);
    return undefined;
  }
  const trimmed = v.trim();
  if (trimmed.length > max) {
    errors.push(`${path} must be at most ${max} characters`);
    return undefined;
  }
  return trimmed;
}

function checkOptionalText(path: string, v: unknown, errors: string[], max = MAX_TEXT): string | undefined {
  if (v === undefined) return undefined;
  return checkText(path, v, errors, max);
}

function checkEnum<T extends string>(path: string, v: unknown, vals: readonly T[], errors: string[]): T | undefined {
  if (typeof v !== 'string' || !(vals as readonly string[]).includes(v)) {
    errors.push(`${path} must be one of ${vals.join(', ')}`);
    return undefined;
  }
  return v as T;
}

function checkInt(path: string, v: unknown, min: number, max: number, errors: string[]): number | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    errors.push(`${path} must be an integer ${min}..${max}`);
    return undefined;
  }
  return v;
}

function checkOptionalInt(path: string, v: unknown, min: number, max: number, errors: string[]): number | undefined {
  if (v === undefined) return undefined;
  return checkInt(path, v, min, max, errors);
}

/** An image field: the legacy plain asset id or an adjusted image object (see ../image.ts). */
function checkImage(path: string, v: unknown, slot: ImageSlotKey, errors: string[]): ImageRef | undefined {
  return validateImageRef(path, v, errors, slot);
}

function checkOptionalImage(path: string, v: unknown, slot: ImageSlotKey, errors: string[]): ImageRef | undefined {
  if (v === undefined) return undefined;
  return checkImage(path, v, slot, errors);
}

function checkDayList(path: string, v: unknown, allowDaily: boolean, errors: string[]): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0) {
    errors.push(`${path} must be a non-empty list of days`);
    return undefined;
  }
  const allowed = new Set<string>(['umum', ...DAY_KEYS]);
  if (allowDaily) allowed.add('daily');
  if (!v.every((x) => typeof x === 'string' && allowed.has(x))) {
    errors.push(`${path} must contain only valid day keys`);
    return undefined;
  }
  return v as string[];
}

function checkRange(from: string | undefined, to: string | undefined, errors: string[]): void {
  if (from && to && from > to) {
    errors.push('from must be on or before to');
  }
}

type Builder<T> = (src: Record<string, unknown>, errors: string[]) => T | undefined;

function buildPenceramah(src: Record<string, unknown>, errors: string[]): ContentItemOf<'penceramah'> | undefined {
  const name = checkText('name', src.name, errors);
  const title = checkOptionalText('title', src.title, errors);
  const phone = checkOptionalText('phone', src.phone, errors);
  const photoAssetId = checkOptionalImage('photoAssetId', src.photoAssetId, 'penceramah', errors);
  if (!name) return undefined;
  return { name, title, phone, photoAssetId } as ContentItemOf<'penceramah'>;
}

function buildKitab(src: Record<string, unknown>, errors: string[]): ContentItemOf<'kitab'> | undefined {
  const title = checkText('title', src.title, errors);
  const author = checkOptionalText('author', src.author, errors);
  const coverAssetId = checkOptionalImage('coverAssetId', src.coverAssetId, 'kitab', errors);
  if (!title) return undefined;
  return { title, author, coverAssetId } as ContentItemOf<'kitab'>;
}

function buildKuliah(src: Record<string, unknown>, errors: string[]): ContentItemOf<'kuliah'> | undefined {
  const date = checkDate('date', src.date, errors);
  const slot = checkEnum('slot', src.slot, ['subuh', 'zohor', 'asar', 'maghrib', 'isyak', 'lain'], errors);
  const time = checkTime('time', src.time, errors);
  const label = checkText('label', src.label, errors);
  const penceramahId = checkText('penceramahId', src.penceramahId, errors);
  const kitabId = checkOptionalText('kitabId', src.kitabId, errors);
  const topic = checkOptionalText('topic', src.topic, errors);
  const status = checkEnum('status', src.status, ['aktif', 'batal'], errors);
  const seriesId = checkOptionalText('seriesId', src.seriesId, errors);
  if (!date || !slot || !time || !label || !penceramahId || !status) return undefined;
  return { date, slot, time, label, penceramahId, kitabId, topic, status, seriesId } as ContentItemOf<'kuliah'>;
}

function buildPengumuman(src: Record<string, unknown>, errors: string[]): ContentItemOf<'pengumuman'> | undefined {
  const title = checkText('title', src.title, errors);
  const body = checkText('body', src.body, errors);
  const from = checkDate('from', src.from, errors);
  const to = checkDate('to', src.to, errors);
  const priority = checkInt('priority', src.priority, 1, 3, errors) as 1 | 2 | 3 | undefined;
  checkRange(from, to, errors);
  if (!title || !body || !from || !to || priority === undefined) return undefined;
  return { title, body, from, to, priority } as ContentItemOf<'pengumuman'>;
}

function buildTicker(src: Record<string, unknown>, errors: string[]): ContentItemOf<'ticker'> | undefined {
  const text = checkText('text', src.text, errors, MAX_TICKER);
  const from = checkDate('from', src.from, errors);
  const to = checkDate('to', src.to, errors);
  checkRange(from, to, errors);
  if (!text || !from || !to) return undefined;
  return { text, from, to } as ContentItemOf<'ticker'>;
}

function buildPoster(src: Record<string, unknown>, errors: string[]): ContentItemOf<'poster'> | undefined {
  const title = checkText('title', src.title, errors, MAX_POSTER_TITLE);
  if (title === '') errors.push('title is required');
  const assetId = checkImage('assetId', src.assetId, 'poster', errors);
  const days = checkDayList('days', src.days, false, errors);
  const from = src.from === undefined ? undefined : checkDate('from', src.from, errors);
  const to = src.to === undefined ? undefined : checkDate('to', src.to, errors);
  const order = checkInt('order', src.order, 0, 1000000, errors);
  checkRange(from, to, errors);
  if (!title || !assetId || !days || order === undefined) return undefined;
  const out: Record<string, unknown> = { title, assetId, days, order };
  if (from !== undefined) out.from = from;
  if (to !== undefined) out.to = to;
  return out as unknown as ContentItemOf<'poster'>;
}

function buildProgramKhas(src: Record<string, unknown>, errors: string[]): ContentItemOf<'programKhas'> | undefined {
  const title = checkText('title', src.title, errors);
  const at = checkDateTime('at', src.at, errors);
  const showFrom = checkDate('showFrom', src.showFrom, errors);
  const showTo = checkDate('showTo', src.showTo, errors);
  const assetId = checkOptionalImage('assetId', src.assetId, 'programKhas', errors);
  const note = checkOptionalText('note', src.note, errors);
  const status = checkEnum('status', src.status, ['aktif', 'batal'], errors);
  checkRange(showFrom, showTo, errors);
  if (!title || !at || !showFrom || !showTo || !status) return undefined;
  return { title, at, showFrom, showTo, assetId, note, status } as ContentItemOf<'programKhas'>;
}

function buildTakwim(src: Record<string, unknown>, errors: string[]): ContentItemOf<'takwim'> | undefined {
  const date = checkDate('date', src.date, errors);
  const hijriLabel = checkOptionalText('hijriLabel', src.hijriLabel, errors);
  const title = checkText('title', src.title, errors);
  const assetId = checkOptionalImage('assetId', src.assetId, 'takwim', errors);
  if (!date || !title) return undefined;
  return { date, hijriLabel, title, assetId } as ContentItemOf<'takwim'>;
}

const HADIS_GRADE_KEYS = ['sahih', 'hasan', 'sahih_lighairihi', 'hasan_lighairihi', 'dhaif', 'maudhu'] as const;
const PROVIDER_ID_RE = /^\d{1,8}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function checkHadisExt(path: string, v: unknown, errors: string[]): HadisExt | undefined {
  if (v === undefined) return undefined;
  if (!isPlain(v)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  for (const k of Object.keys(v)) {
    if (!['provider', 'id', 'attributionAr', 'gradeAr', 'categories', 'fetchedAt', 'digest', 'blocked'].includes(k)) {
      errors.push(`${path}.${k} is not a known field`);
    }
  }
  const before = errors.length;
  const provider = checkEnum(`${path}.provider`, v.provider, ['hadeethenc'], errors);
  const id = typeof v.id === 'string' && PROVIDER_ID_RE.test(v.id) ? v.id : undefined;
  if (id === undefined) errors.push(`${path}.id must be 1 to 8 digits`);
  const attributionAr = checkText(`${path}.attributionAr`, v.attributionAr, errors, 200);
  const gradeAr = checkText(`${path}.gradeAr`, v.gradeAr, errors, 60);
  let categories: string[] | undefined;
  if (!Array.isArray(v.categories) || v.categories.length > 20 ||
      !v.categories.every((c) => typeof c === 'string' && PROVIDER_ID_RE.test(c))) {
    errors.push(`${path}.categories must be a list of at most 20 category ids`);
  } else categories = v.categories as string[];
  const fetchedAt = typeof v.fetchedAt === 'string' && ISO_RE.test(v.fetchedAt) && !Number.isNaN(Date.parse(v.fetchedAt))
    ? v.fetchedAt : undefined;
  if (fetchedAt === undefined) errors.push(`${path}.fetchedAt must be an ISO time`);
  const digest = typeof v.digest === 'string' && DIGEST_RE.test(v.digest) ? v.digest : undefined;
  if (digest === undefined) errors.push(`${path}.digest must be 64 hex characters`);
  let blocked: boolean | undefined;
  if (v.blocked !== undefined) {
    if (typeof v.blocked === 'boolean') blocked = v.blocked;
    else errors.push(`${path}.blocked must be true or false`);
  }
  if (errors.length > before || !provider || id === undefined || attributionAr === undefined || gradeAr === undefined ||
      !categories || fetchedAt === undefined || digest === undefined) return undefined;
  return { provider, id, attributionAr, gradeAr, categories, fetchedAt, digest, ...(blocked === true ? { blocked } : {}) };
}

function buildHadis(src: Record<string, unknown>, errors: string[]): ContentItemOf<'hadis'> | undefined {
  const textMs = checkText('textMs', src.textMs, errors);
  const textAr = checkOptionalText('textAr', src.textAr, errors);
  const source = checkText('source', src.source, errors);
  const title = checkOptionalText('title', src.title, errors, 300);
  const intro = checkOptionalText('intro', src.intro, errors, 400);
  const grade = src.grade === undefined ? undefined : checkEnum('grade', src.grade, HADIS_GRADE_KEYS, errors);
  let shown: boolean | undefined;
  if (src.shown !== undefined) {
    if (typeof src.shown === 'boolean') shown = src.shown;
    else errors.push('shown must be true or false');
  }
  const order = checkOptionalInt('order', src.order, 0, 1000000, errors);
  const ext = checkHadisExt('ext', src.ext, errors);
  if (!textMs || !source) return undefined;
  return { textMs, textAr, source, title, intro, grade, shown, order, ext } as ContentItemOf<'hadis'>;
}

function buildWorldTime(src: Record<string, unknown>, errors: string[]): ContentItemOf<'worldTime'> | undefined {
  const city = checkText('city', src.city, errors);
  const tz = checkText('tz', src.tz, errors);
  const order = checkInt('order', src.order, 0, 1000000, errors);
  if (tz !== undefined && !isIanaZone(tz)) {
    errors.push('tz must be a valid IANA timezone');
  }
  if (!city || !tz || order === undefined) return undefined;
  return { city, tz, order } as ContentItemOf<'worldTime'>;
}

function buildPetugas(src: Record<string, unknown>, errors: string[]): ContentItemOf<'petugas'> | undefined {
  const name = checkText('name', src.name, errors);
  const photoAssetId = checkOptionalImage('photoAssetId', src.photoAssetId, 'petugas', errors);
  if (!name) return undefined;
  return { name, photoAssetId } as ContentItemOf<'petugas'>;
}

function buildTugasan(src: Record<string, unknown>, errors: string[]): ContentItemOf<'tugasan'> | undefined {
  const date = checkDate('date', src.date, errors);
  const role = checkEnum('role', src.role, ['imam', 'bilal', 'khatib', 'ajk'], errors);
  const petugasId = checkText('petugasId', src.petugasId, errors);
  const note = checkOptionalText('note', src.note, errors);
  if (!date || !role || !petugasId) return undefined;
  return { date, role, petugasId, note } as ContentItemOf<'tugasan'>;
}

function buildZikir(src: Record<string, unknown>, errors: string[]): ContentItemOf<'zikir'> | undefined {
  const order = checkInt('order', src.order, 0, 1000000, errors);
  const textAr = checkText('textAr', src.textAr, errors);
  const textMs = checkText('textMs', src.textMs, errors);
  const repeat = checkOptionalInt('repeat', src.repeat, 1, 10000, errors);
  if (order === undefined || !textAr || !textMs) return undefined;
  return { order, textAr, textMs, repeat } as ContentItemOf<'zikir'>;
}

function buildTilawahSlot(src: Record<string, unknown>, errors: string[]): ContentItemOf<'tilawahSlot'> | undefined {
  const days = checkDayList('days', src.days, true, errors);
  const before = checkEnum('before', src.before, ['subuh', 'zohor', 'asar', 'maghrib', 'isyak'], errors);
  const minutesBefore = checkInt('minutesBefore', src.minutesBefore, 1, 120, errors);
  const surah = checkInt('surah', src.surah, 1, 114, errors);
  const enabled = typeof src.enabled === 'boolean' ? src.enabled : undefined;
  if (enabled === undefined) {
    errors.push('enabled must be true or false');
  }
  if (!days || !before || minutesBefore === undefined || surah === undefined || enabled === undefined) return undefined;
  return { days, before, minutesBefore, surah, enabled } as ContentItemOf<'tilawahSlot'>;
}

/** Suggested title for a new poster: `Poster <live count + 1>`. Pass the live (not deleted) posters. */
export function defaultPosterTitle(existingLivePosters: readonly unknown[]): string {
  return `Poster ${existingLivePosters.length + 1}`;
}

const BUILDERS: Record<ContentKind, Builder<ContentItemOf<ContentKind>>> = {
  penceramah: buildPenceramah,
  kitab: buildKitab,
  kuliah: buildKuliah,
  pengumuman: buildPengumuman,
  ticker: buildTicker,
  poster: buildPoster,
  programKhas: buildProgramKhas,
  takwim: buildTakwim,
  hadis: buildHadis,
  worldTime: buildWorldTime,
  petugas: buildPetugas,
  tugasan: buildTugasan,
  zikir: buildZikir,
  tilawahSlot: buildTilawahSlot,
};

const META_KEYS = new Set(['id', 'updatedAt', 'updatedBy']);

export function isContentKind(k: string): k is ContentKind {
  return (CONTENT_KINDS as readonly string[]).includes(k);
}

export function newId(): string {
  // Web Crypto: available in Node 19+ and every browser, so core stays browser-safe.
  return globalThis.crypto.randomUUID();
}

export function validateContent(
  kind: string,
  item: unknown,
): { ok: true; value: ContentItemOf<any> } | { ok: false; errors: string[] } {
  if (!isContentKind(kind)) {
    return { ok: false, errors: [`unknown content kind ${kind}`] };
  }
  if (!isPlain(item)) {
    return { ok: false, errors: ['item must be an object'] };
  }

  const errors: string[] = [];

  // Reject unknown keys (metadata keys are accepted but not forwarded to builders).
  for (const k of Object.keys(item)) {
    if (!META_KEYS.has(k)) {
      // Builders will validate known keys and add errors for missing/invalid ones.
      // Unknown keys are caught after builder runs by checking the source object keys.
    }
  }

  const meta = {
    id: typeof item.id === 'string' ? item.id : undefined,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : undefined,
    updatedBy: typeof item.updatedBy === 'string' ? item.updatedBy : undefined,
  };

  const built = BUILDERS[kind](item, errors);

  // Catch unknown keys only when the item otherwise built successfully.
  if (built) {
    const validKeys = new Set<string>(Object.keys(built));
    for (const k of Object.keys(item)) {
      if (!META_KEYS.has(k) && !validKeys.has(k)) {
        errors.push(`${k} is not a known field`);
      }
    }
  }

  if (!built || errors.length) {
    return { ok: false, errors };
  }

  const value = { ...built } as ContentItemOf<any>;
  if (meta.id) value.id = meta.id;
  if (meta.updatedAt) value.updatedAt = meta.updatedAt;
  if (meta.updatedBy) value.updatedBy = meta.updatedBy;

  return { ok: true, value };
}
