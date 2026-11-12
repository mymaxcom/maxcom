// Kuala Lumpur wall clock = UTC+8 fixed. Pure UTC arithmetic; never the machine timezone.
const KL_OFFSET_MS = 8 * 60 * 60 * 1000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

function parseDate(date: string): { y: number; m: number; d: number } {
  const match = DATE_RE.exec(date);
  if (!match) throw new Error(`Invalid date "${date}", expected YYYY-MM-DD`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    throw new Error(`Invalid calendar date "${date}"`);
  }
  return { y, m, d };
}

/** YYYY-MM-DD of the instant on the Kuala Lumpur wall clock (UTC+8). */
export function klDateOf(instant: Date): string {
  const t = new Date(instant.getTime() + KL_OFFSET_MS);
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** KL wall-clock date + 'HH:mm' or 'HH:mm:ss' -> absolute instant. */
export function klInstant(date: string, hhmm: string): Date {
  const { y, m, d } = parseDate(date);
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(hhmm);
  if (!match) throw new Error(`Invalid time "${hhmm}", expected HH:mm or HH:mm:ss`);
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  const ss = match[3] === undefined ? 0 : Number(match[3]);
  if (hh > 23 || mm > 59 || ss > 59) throw new Error(`Invalid time "${hhmm}"`);
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss) - KL_OFFSET_MS);
}

/** Weekday of a calendar date: 0 = Ahad (Sunday) .. 6 = Sabtu. */
export function klWeekday(date: string): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  const { y, m, d } = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

// ---- Wall clock in the surau's own IANA time zone (Plan 13). The kl* functions above stay for the fixed UTC+8. ----

const DEFAULT_TZ = 'Asia/Kuala_Lumpur';
const TZ_SHAPE = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2})$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

interface Parts { y: number; mo: number; d: number; h: number; mi: number; s: number }

function partsOf(instant: Date, tz: string): Parts {
  const out: Parts = { y: 0, mo: 0, d: 0, h: 0, mi: 0, s: 0 };
  for (const p of formatterFor(tz).formatToParts(instant)) {
    switch (p.type) {
      case 'year': out.y = Number(p.value); break;
      case 'month': out.mo = Number(p.value); break;
      case 'day': out.d = Number(p.value); break;
      case 'hour': out.h = Number(p.value) % 24; break;
      case 'minute': out.mi = Number(p.value); break;
      case 'second': out.s = Number(p.value); break;
      default: break;
    }
  }
  return out;
}

/** True for an IANA zone name the runtime knows (also its old aliases); never throws. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length > 64 || !TZ_SHAPE.test(tz)) return false;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

/** The zone in `settings.location.timezone` when valid, else Kuala Lumpur. */
export function tzOf(settings: unknown): string {
  const tz = (settings as { location?: { timezone?: unknown } } | null | undefined)?.location?.timezone;
  return isValidTimeZone(tz) ? tz : DEFAULT_TZ;
}

/** YYYY-MM-DD of the instant on the wall clock of `tz`. */
export function dateOf(instant: Date, tz: string): string {
  const p = partsOf(instant, tz);
  return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}`;
}

/** Hour 0..23 of the instant on the wall clock of `tz`. */
export function hourOf(instant: Date, tz: string): number {
  return partsOf(instant, tz).h;
}

/** Minutes the wall clock of `tz` is ahead of UTC at that instant (negative when behind). */
export function offsetMinutes(instant: Date, tz: string): number {
  const p = partsOf(instant, tz);
  const local = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  const utc = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((local - utc) / 60000);
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Wall-clock date + 'HH:mm' or 'HH:mm:ss' in `tz` -> absolute instant. An ambiguous local time (clocks go
 * back) takes the first; one that does not exist (clocks go forward) maps to the moment the clocks changed.
 */
export function instantOf(date: string, hhmm: string, tz: string): Date {
  const { y, m, d } = parseDate(date);
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(hhmm);
  if (!match) throw new Error(`Invalid time "${hhmm}", expected HH:mm or HH:mm:ss`);
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  const ss = match[3] === undefined ? 0 : Number(match[3]);
  if (hh > 23 || mm > 59 || ss > 59) throw new Error(`Invalid time "${hhmm}"`);
  const wall = Date.UTC(y, m - 1, d, hh, mm, ss);
  const pre = offsetMinutes(new Date(wall - 36 * HOUR_MS), tz);
  const post = offsetMinutes(new Date(wall + 36 * HOUR_MS), tz);
  const candidates = [...new Set([wall - pre * 60000, wall - post * 60000])].sort((a, b) => a - b);
  const valid = candidates.filter((t) => t + offsetMinutes(new Date(t), tz) * 60000 === wall);
  if (valid.length > 0) return new Date(valid[0]!);
  // The local time was skipped: find the minute where the offset changes between the two candidates.
  let lo = candidates[0]!;
  let hi = candidates[candidates.length - 1]!;
  const offLo = offsetMinutes(new Date(lo), tz);
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000;
    if (offsetMinutes(new Date(mid), tz) === offLo) lo = mid; else hi = mid;
  }
  return new Date(hi);
}
