import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { assetSrc } from '../../content/assets.ts';
import type { CardProps } from '../../content/ContentLayer.tsx';

/** The bottom of the header elements of the stage, in the stage's own CSS pixels, relative to the poster stage. */
export function headerBottom(stage: HTMLElement): number | null {
  const root = stage.closest('.stage');
  if (!root) return null;
  const box = stage.getBoundingClientRect();
  const k = stage.offsetWidth > 0 && box.width > 0 ? box.width / stage.offsetWidth : 1;
  let bottom = 0;
  for (const el of Array.from(root.querySelectorAll('.region-brand, .shell-top'))) {
    const r = el.getBoundingClientRect();
    if (r.height > 0) bottom = Math.max(bottom, (r.bottom - box.top) / k);
  }
  return bottom > 0 ? bottom : null;
}

/**
 * The poster screen (2026.11.13): the picture frame starts just below the header row (brand and date line on one side,
 * chip and clock on the other) and runs down to near the bottom edge, over a blurred copy of itself (one static layer).
 * The header's real bottom is measured (a long surau name makes it taller) and set as `--poster-top`; CSS falls back to
 * a constant when it is missing. Per poster `stretch` (absent = true, "Regangkan"): true pulls the picture to the
 * frame's exact width and height, false keeps it whole in its own proportions (`--poster-ar`, width over height, once it
 * has loaded). No strip, no ticker, no text. If the picture cannot be loaded the card is dropped (and the stage returns
 * to the main layout), never a broken image.
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
  const stageRef = useRef<HTMLElement>(null);
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setTop((prev) => {
      const b = headerBottom(el);
      return b === null || (prev !== null && Math.abs(prev - b) < 0.5) ? prev : b;
    });
    measure();
    const settle = window.setTimeout(measure, 700); // after the theme's entry motion has settled
    window.addEventListener('resize', measure);
    // Only the brand/name/date region can change the header's height (a longer name or date): the seconds clock lives
    // in `.shell-top` and is not watched, so a tick every second does not force a layout. Debounced, 200 ms.
    const root = el.closest('.stage');
    let debounce: number | null = null;
    const later = (): void => {
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        debounce = null;
        measure();
      }, 200);
    };
    const mo = typeof MutationObserver === 'function' && root ? new MutationObserver(later) : null;
    if (mo && root) {
      for (const region of Array.from(root.querySelectorAll('.region-brand'))) {
        mo.observe(region, { childList: true, subtree: true, characterData: true });
      }
    }
    return () => {
      window.removeEventListener('resize', measure);
      mo?.disconnect();
      window.clearTimeout(settle);
      if (debounce !== null) window.clearTimeout(debounce);
    };
  }, [rendered, itemId]);
  if (!rendered) return null;
  const ratio = measured && measured.src === src ? measured.ratio : null;
  const vars = [ratio !== null ? `--poster-ar:${ratio.toFixed(4)}` : '', top !== null ? `--poster-top:${top.toFixed(1)}px` : ''].filter(Boolean).join(';');
  return (
    <article ref={stageRef} class="poster-stage" data-card="posters" data-item={p.id} style={vars || undefined}>
      <div class="poster-fill" style={`background-image:url("${src}")`} aria-hidden="true" />
      <div class="poster-frame" data-stretch={p.stretch !== false ? 'true' : 'false'}>
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
