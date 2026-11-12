import { useEffect } from 'preact/hooks';
import { t } from '../../i18n.ts';
import type { CardProps } from '../ContentLayer.tsx';
import { useFit } from '../paging.ts';

/**
 * Body lines allowed before the clamp cuts: generous on purpose. The text starts at its large size (read from the
 * back of the hall) and `useFit` steps the title and body down together until they fit the card, so a short
 * notice fills the card and a long one still shows whole; the clamp is only the last guard at the smallest size.
 */
const BODY_LINES = 12;
const BODY_LINES_LONG_TITLE = 10;
const TITLE_WRAP_CHARS = 34;

export function PengumumanCard({ lang, content, itemId, onRendered }: CardProps) {
  const p = content.pengumuman.find((x) => x.id === itemId);
  const { ref, fit } = useFit<HTMLDivElement>(`${itemId ?? ''}|${p?.title ?? ''}|${p?.body ?? ''}`);
  // No item (removed or expired under the rotation): tell the content layer, so the band reads as empty and Main goes idle.
  const rendered = !!p;
  useEffect(() => {
    onRendered?.(rendered);
  }, [rendered, onRendered]);
  if (!p) return null;
  const lines = p.title.length > TITLE_WRAP_CHARS ? BODY_LINES_LONG_TITLE : BODY_LINES;
  return (
    <article
      class={`card glass card--pengumuman${p.priority === 1 ? ' is-priority' : ''}`}
      data-card="pengumuman"
      data-item={p.id}
    >
      <span class="card__tag">{t('pengumuman', lang)}</span>
      <div class="pengumuman__text" ref={ref} style={`--fit:${fit}`}>
        <h2 class="pengumuman__title">{p.title}</h2>
        <p class="pengumuman__body" style={{ '--lines': String(lines) }}>{p.body}</p>
      </div>
    </article>
  );
}
