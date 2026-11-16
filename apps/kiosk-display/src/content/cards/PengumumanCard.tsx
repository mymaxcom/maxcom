import { useEffect } from 'preact/hooks';
import { t } from '../../i18n.ts';
import type { CardProps } from '../ContentLayer.tsx';
import { pageAt, splitForPages, useFit } from '../paging.ts';

/**
 * The text starts at its large size (read from the back of the hall, times the surau's text size) and `useFit` steps
 * the title and body down together a little; when that is not enough the body is split over pages (shown one after
 * the other for equal shares of the slot), so a long notice, or a larger text size, never loses a word.
 */
export function PengumumanCard({ view, lang, content, itemId, startedAt, durationSeconds, onRendered }: CardProps) {
  const p = content.pengumuman.find((x) => x.id === itemId);
  const { ref, fit, pages } = useFit<HTMLDivElement>(`${itemId ?? ''}|${p?.title ?? ''}|${p?.body ?? ''}`, { paged: true });
  // No item (removed or expired under the rotation): tell the content layer, so the band reads as empty and Main goes idle.
  const rendered = !!p;
  useEffect(() => {
    onRendered?.(rendered);
  }, [rendered, onRendered]);
  if (!p) return null;
  const chunks = pages > 1 ? splitForPages(p.body, pages) : [p.body];
  const n = chunks.length;
  const sub = n > 1 ? pageAt(view.now, startedAt, durationSeconds / n, n, view.tz) : 0;
  return (
    <article
      class={`card glass card--pengumuman${p.priority === 1 ? ' is-priority' : ''}`}
      data-card="pengumuman"
      data-item={p.id}
    >
      <span class="card__tag">{t('pengumuman', lang)}</span>
      {n > 1 ? <span class="pengumuman__sub num">{`${sub + 1} / ${n}`}</span> : null}
      <div class="pengumuman__text" ref={ref} style={`--fit:${fit}`}>
        <h2 class="pengumuman__title">{p.title}</h2>
        <p class="pengumuman__body">{chunks[sub]}</p>
      </div>
    </article>
  );
}
