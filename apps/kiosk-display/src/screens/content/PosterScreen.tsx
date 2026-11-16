import { useEffect, useState } from 'preact/hooks';
import { assetSrc } from '../../content/assets.ts';
import type { CardProps } from '../../content/ContentLayer.tsx';

/**
 * The poster screen (theme round 2, rules 1 and 3): the top row stays (brand, date line, chip, clock), and the poster
 * takes everything below it, fitted whole and as large as the frame allows, over a blurred copy of itself (one static
 * layer). No strip and no ticker on this screen, and no text (the title is for the admin app only). The picture's own
 * proportions (`--poster-ar`, width over height, once it has loaded) size it in the frame. If the picture cannot be
 * loaded the card is dropped (and the stage returns to the main layout), never a broken image.
 */
export function PosterScreen({ content, itemId, onRendered }: CardProps) {
  const [failed, setFailed] = useState(false);
  const [measured, setMeasured] = useState<{ src: string; ratio: number } | null>(null);
  const p = content.posters.find((x) => x.id === itemId);
  const src = p ? assetSrc(p.assetId) : null;
  const rendered = !!p && !failed && src !== null;
  useEffect(() => {
    onRendered?.(rendered);
  }, [rendered, onRendered]);
  if (!rendered) return null;
  const ratio = measured && measured.src === src ? measured.ratio : null;
  return (
    <article class="poster-stage" data-card="posters" data-item={p.id} style={ratio !== null ? `--poster-ar:${ratio.toFixed(4)}` : undefined}>
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
            if (i.naturalWidth > 0 && i.naturalHeight > 0) setMeasured({ src, ratio: i.naturalWidth / i.naturalHeight });
          }}
        />
      </div>
    </article>
  );
}
