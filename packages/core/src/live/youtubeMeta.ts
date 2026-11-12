import type { Kitab, Kuliah, Penceramah } from '../content/types.ts';
import type { LiveYoutubeSettings } from '../features/registry.ts';

const MONTHS_MS = [
  'Januari', 'Februari', 'Mac', 'April', 'Mei', 'Jun',
  'Julai', 'Ogos', 'September', 'Oktober', 'November', 'Disember',
];
export const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;
const PLACEHOLDER = /\{(label|penceramah|topic|kitab|surau|date|time)\}/g;

export interface YoutubeMetaInput {
  kuliah: Kuliah;
  penceramah: Penceramah;
  kitab: Kitab | null;
  surauName: string;
  settings: LiveYoutubeSettings;
  now: Date;
}

export interface YoutubeMeta {
  title: string;
  description: string;
  privacy: LiveYoutubeSettings['privacy'];
}

/** Wall clock in Asia/Kuala_Lumpur (UTC+8, no daylight saving) as numbers. */
function klParts(now: Date): { y: number; m: number; d: number; hh: number; mm: number } {
  const t = new Date(now.getTime() + 8 * 3600 * 1000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: t.getUTCHours(), mm: t.getUTCMinutes() };
}

function dateText(kuliahDate: string, now: Date): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(kuliahDate);
  let y: number;
  let mo: number;
  let d: number;
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    y = Number(m[1]);
    mo = Number(m[2]);
    d = Number(m[3]);
  } else {
    const p = klParts(now);
    y = p.y;
    mo = p.m;
    d = p.d;
  }
  return `${d} ${MONTHS_MS[mo - 1]} ${y}`;
}

function timeText(kuliahTime: string, now: Date): string {
  if (/^\d{2}:\d{2}$/.test(kuliahTime)) return kuliahTime;
  const p = klParts(now);
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}

/** No angle brackets, dashes, arrows or approximation signs in anything sent to YouTube. */
export function cleanYoutubeText(s: string): string {
  return s
    .replace(/[<>]/g, '')
    .replace(/[–—]/g, ',')
    .replace(/[←→↔⇒➔]/g, ':')
    .replace(/≈/g, '');
}

const cut = (s: string, max: number): string => Array.from(s).slice(0, max).join('');

/** Title and description of the YouTube broadcast, from the kuliah and the templates in the settings. */
export function youtubeMetaFor(input: YoutubeMetaInput): YoutubeMeta {
  const { kuliah, penceramah, kitab, surauName, settings, now } = input;
  const values: Record<string, string> = {
    label: kuliah.label ?? '',
    penceramah: penceramah.name ?? '',
    topic: kuliah.topic ?? '',
    kitab: kitab?.title ?? '',
    surau: surauName ?? '',
    date: dateText(kuliah.date, now),
    time: timeText(kuliah.time, now),
  };
  const fill = (line: string): { text: string; empty: boolean } => {
    let empty = false;
    const text = line.replace(PLACEHOLDER, (_m, k: string) => {
      const v = (values[k] ?? '').trim();
      if (v === '') empty = true;
      return v;
    });
    return { text, empty };
  };

  const titleRaw = fill(String(settings.titleTemplate).replace(/\r?\n/g, ' ')).text;
  let title = cleanYoutubeText(titleRaw)
    .replace(/\s+/g, ' ')
    .replace(/^[\s:,]+|[\s:,]+$/g, '');
  title = cut(title, TITLE_MAX).trim();
  if (title === '') title = `Kuliah ${cleanYoutubeText(values.surau!).trim()}`.trim();

  const lines: string[] = [];
  for (const line of String(settings.descriptionTemplate).split(/\r?\n/)) {
    const { text, empty } = fill(line);
    if (empty) continue;
    const c = cleanYoutubeText(text).trimEnd();
    if (c.trim() === '') continue;
    lines.push(c);
  }
  const description = cut(lines.join('\n'), DESCRIPTION_MAX);

  return { title, description, privacy: settings.privacy };
}
