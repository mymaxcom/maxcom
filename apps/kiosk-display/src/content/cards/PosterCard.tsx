import { useEffect, useState } from 'preact/hooks';
import { assetSrc } from '../assets.ts';
import type { CardProps } from '../ContentLayer.tsx';

/**
 * A poster takes the whole screen: the image fitted whole over a blurred copy of itself, no text (the title
 * is for the admin app only). Main keeps a thin strip at the bottom with the clock and the next prayer.
 * If the picture cannot be loaded (box down and never fetched, or the display was revoked) the card
 * is dropped instead of showing a black panel with a broken-image icon, and Main is told so the normal
 * layout stays.
 */
export function PosterCard({ content, itemId, onRendered }: CardProps) {
  const [failed, setFailed] = useState(false);
  const p = content.posters.find((x) => x.id === itemId);
  const src = p ? assetSrc(p.assetId) : null;
  const rendered = !!p && !failed && src !== null;
  useEffect(() => {
    onRendered?.(rendered);
  }, [rendered, onRendered]);
  if (!rendered) return null;
  return (
    <article class="card card--poster" data-card="posters" data-item={p.id}>
      <img class="poster__blur" src={src} alt="" aria-hidden="true" />
      <img class="poster__img" src={src} alt="" data-item={p.id} onError={() => setFailed(true)} />
    </article>
  );
}
