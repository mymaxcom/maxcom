import type { KioskState } from '@surau/core';
import { fmtClock, prayerLabel } from '../format.ts';
import { PRAYER_AR, t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';

export interface NextChipProps {
  next: NonNullable<KioskState['next']>;
  now: Date;
  lang: Lang;
  timeFormat: '12h' | '24h';
  tz: string;
  /** A test hook (the live screen's chip). */
  testId?: string;
}

/** "1 jam 42 minit lagi" / "39 minit lagi" / "sebentar lagi" (EN: "in 1 h 42 min" / "in 39 min" / "in a moment"). */
export function chipRelative(ms: number, lang: Lang): string {
  const total = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 60_000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h >= 1) return t(m === 0 ? 'chipRelH' : 'chipRelHM', lang, { h, m });
  if (m >= 1) return t('chipRelM', lang, { m });
  return t('chipRelNow', lang);
}

/** The next-prayer chip of the content shell: Arabic name (shown by themes that turn it on), name, time, how long. */
export function NextChip({ next, now, lang, timeFormat, tz, testId }: NextChipProps) {
  const c = fmtClock(next.at, timeFormat, false, lang, tz);
  const ar = (PRAYER_AR as Record<string, string>)[next.name] ?? '';
  return (
    <div class="region-next next--chip" data-role="next" data-testid={testId}>
      {ar !== '' ? <span class="next-ar arab">{ar}</span> : null}
      <span class="chip-k" data-must="">{prayerLabel(next.name, lang)}</span>
      <span class="chip-t num" data-must="">{c.ampm ? `${c.hm} ${c.ampm}` : c.hm}</span>
      <span class="chip-rel">{chipRelative(next.at.getTime() - now.getTime(), lang)}</span>
    </div>
  );
}
