import { useEffect, useState } from 'preact/hooks';
import { assetSrc } from '../../content/assets.ts';
import type { CardProps } from '../../content/ContentLayer.tsx';

/**
 * The poster screen: the whole main area is the poster, fitted whole over a blurred copy of itself (one static
 * layer), no text (the title is for the admin app only). Brand, compact clock, chip and strip stay over it.
 * If the picture cannot be loaded the card is dropped (and the stage returns to the main layout), never a broken image.
 */
export function PosterScreen({ content, itemId, onRendered }: CardProps) {
  const [failed, setFailed] = useState(false);
  // Wider than 0.85 (width over height): the chip would sit over it, so its frame starts below the chip.
  const [wide, setWide] = useState(false);
  const p = content.posters.find((x) => x.id === itemId);
  const src = p ? assetSrc(p.assetId) : null;
  const rendered = !!p && !failed && src !== null;
  useEffect(() => {
    onRendered?.(rendered);
  }, [rendered, onRendered]);
  if (!rendered) return null;
  return (
    <article class={`poster-stage${wide ? ' is-wide' : ''}`} data-card="posters" data-item={p.id}>
      <div class="poster-fill" style={`background-image:url("${src}")`} aria-hidden="true" />
      <div class="poster-frame">
        <img
          class="poster__img"
          src={src}
          alt=""
          data-item={p.id}
          onError={() => setFailed(true)}
          onLoad={(e) => {
            const i = e.currentTarget;
            setWide(i.naturalHeight > 0 && i.naturalWidth / i.naturalHeight > 0.85);
          }}
        />
      </div>
    </article>
  );
}
