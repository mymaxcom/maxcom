import { dateOf } from '@surau/core';
import type { TugasanRole, TugasanView } from '@surau/core';
import { fmtDateShort, t, ymdParts } from '../../i18n.ts';
import { assetSrc, num } from '../assets.ts';
import type { CardProps } from '../ContentLayer.tsx';

/** Columns (dates) and rows per column the card holds at a size readable from 10 m. */
const MAX_DAYS = 3;
const MAX_ROWS = 4;
const ROLE_ORDER: Record<TugasanRole, number> = { imam: 0, bilal: 1, khatib: 2, ajk: 3 };
const ROLE_KEY: Record<TugasanRole, string> = { imam: 'roleImam', bilal: 'roleBilal', khatib: 'roleKhatib', ajk: 'roleAjk' };

function addDays(date: string, n: number): string {
  const p = ymdParts(date);
  if (!p) return date;
  return new Date(p.utc + n * 86_400_000).toISOString().slice(0, 10);
}

/** Coming duties within `daysAhead`, grouped by date (sorted), roles in imam, bilal, khatib, ajk order. */
export function groupTugasan(list: TugasanView[], today: string, daysAhead: number): { date: string; rows: TugasanView[] }[] {
  const last = addDays(today, Math.max(0, daysAhead));
  const byDate = new Map<string, TugasanView[]>();
  for (const x of list) {
    if (x.date < today || x.date > last) continue;
    const rows = byDate.get(x.date) ?? [];
    rows.push(x);
    byDate.set(x.date, rows);
  }
  return [...byDate.keys()]
    .sort()
    .slice(0, MAX_DAYS)
    .map((date) => ({
      date,
      rows: byDate.get(date)!
        .sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || a.petugas.name.localeCompare(b.petugas.name))
        .slice(0, MAX_ROWS),
    }));
}

const initial = (name: string): string => (name.trim().match(/\p{L}/u)?.[0] ?? '').toUpperCase();

export function TugasanCard({ view, lang, content }: CardProps) {
  const today = dateOf(view.now, view.tz);
  const days = groupTugasan(content.tugasan, today, num(view.settings.tugasan.daysAhead, 14));
  if (days.length === 0) return null;

  return (
    <article class="card glass card--tugasan" data-card="tugasan">
      <span class="card__tag">{t('tugasan', lang)}</span>
      <div class={`tugasan__days cols-${days.length}`}>
        {days.map(({ date, rows }) => (
          <section class={`tugasan__day${date === today ? ' is-today' : ''}`} key={date} data-date={date}>
            <h3 class="tugasan__date">
              {date === today ? (
                <>
                  <b>{t('today', lang)}</b>
                  <span class="sep" aria-hidden="true" />
                  <span>{fmtDateShort(date, lang)}</span>
                </>
              ) : fmtDateShort(date, lang)}
            </h3>
            <ul class="tugasan__rows">
              {rows.map((x) => {
                const photo = assetSrc(x.petugas.photoAssetId);
                return (
                  <li class="tugasan__row" key={x.id} data-role={x.role}>
                    {photo ? (
                      <span class="tugasan__photo"><img src={photo} alt="" /></span>
                    ) : (
                      <span class="tugasan__photo is-empty" aria-hidden="true">{initial(x.petugas.name)}</span>
                    )}
                    <span class="tugasan__text">
                      <span class="tugasan__role">{t(ROLE_KEY[x.role] ?? 'roleAjk', lang)}</span>
                      <span class="tugasan__name">{x.petugas.name}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </article>
  );
}
