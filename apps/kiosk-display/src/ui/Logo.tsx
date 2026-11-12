import { useEffect, useState } from 'preact/hooks';
import { imageWantsLightPlate } from './logoInk.ts';

export interface SurauLogoProps {
  /** The bundle's logo URL (`/surau-logo?v=...`), or null for none. */
  src: string | null;
  class?: string;
}

/**
 * Whether the surau's name is written out beside the logo: always without a logo; with one, unless
 * `surauInfo.showName` is exactly false (the logo already carries the name). Never throws.
 */
export function nameShownOf(settings: { surauInfo?: { showName?: unknown } } | null | undefined, logo: string | null | undefined): boolean {
  if (!logo) return true;
  try {
    return settings?.surauInfo?.showName !== false;
  } catch {
    return true;
  }
}

interface Natural {
  src: string;
  w: number;
  h: number;
  plate: boolean;
}

/**
 * The surau logo beside the name. Renders nothing without a URL, and hides itself for good (for that URL)
 * when the picture cannot be loaded: a missing logo never leaves a broken-image icon on the TV.
 *
 * Once the picture has decoded it carries two sizing hints for the CSS: `--logo-cap` (twice the bitmap's
 * pixel height, so a tiny file is never blown up into a blur) and `data-shape` ("wide" for a wordmark whose
 * aspect is over 2, "compact" otherwise). Dark ink on transparency (a black wordmark) gets `data-plate="light"`:
 * the CSS then draws it on the light plate so it stays readable on the dark screen.
 */
export function SurauLogo({ src, class: cls }: SurauLogoProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const [natural, setNatural] = useState<Natural | null>(null);
  useEffect(() => setFailed(null), [src]);
  if (!src || failed === src) return null;
  const n = natural && natural.src === src && natural.w > 0 && natural.h > 0 ? natural : null;
  return (
    <img
      class={`logo${cls ? ` ${cls}` : ''}`}
      src={src}
      alt=""
      aria-hidden="true"
      data-role="logo"
      data-plate={n?.plate ? 'light' : undefined}
      data-shape={n ? (n.w / n.h > 2 ? 'wide' : 'compact') : undefined}
      style={n ? `--logo-cap:${n.h * 2}px` : undefined}
      decoding="async"
      onLoad={(e) => {
        const el = e.currentTarget;
        setNatural({ src, w: el.naturalWidth, h: el.naturalHeight, plate: imageWantsLightPlate(el) });
      }}
      onError={() => setFailed(src)}
    />
  );
}
