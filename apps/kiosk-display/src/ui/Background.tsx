import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { autoTone, dateOf, hourOf, instantOf, tzOf } from '@surau/core';
import type { ImageStats, Settings, Tone } from '@surau/core';
import { assetSrc } from '../content/assets.ts';
import bg1 from '../assets/backgrounds/default-1.jpg';
import bg2 from '../assets/backgrounds/default-2.jpg';
import bg2Plain from '../assets/backgrounds/default-2-plain.jpg';

/** The tone used before an image has been measured (mockup theme 1). */
export const DEFAULT_TONE: Tone = { shadeAlpha: 0.55, glass: '#06302b', accent: '#f0c97a', text: '#ffffff' };

const BUILT_IN: Record<string, string> = { 'default-1': bg1, 'default-2': bg2 };

/** Mean relative luminance and a short palette from a 32x18 downsample of the image. */
export function sampleImage(img: HTMLImageElement): ImageStats {
  const W = 32;
  const H = 18;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { meanLuma: 0.3, palette: [] };
  ctx.drawImage(img, 0, 0, W, H);
  const { data } = ctx.getImageData(0, 0, W, H);

  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  // Bucket to 4 bits per channel; keep the running sum so each bucket reports its mean colour.
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let luma = 0;
  const px = W * H;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    luma += 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bk = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bk.n += 1;
    bk.r += r;
    bk.g += g;
    bk.b += b;
    buckets.set(key, bk);
  }
  const hex2 = (n: number): string => Math.round(n).toString(16).padStart(2, '0');
  const palette = [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 5)
    .map((bk) => `#${hex2(bk.r / bk.n)}${hex2(bk.g / bk.n)}${hex2(bk.b / bk.n)}`);
  return { meanLuma: luma / px, palette };
}

/** Which of the configured images shows now (daily or hourly rotation on the surau's wall clock). */
export function pickBackground(images: readonly string[], rotate: string, now: Date, tz: string = 'Asia/Kuala_Lumpur'): string | null {
  if (images.length === 0) return null;
  const date = dateOf(now, tz);
  const dayNo = Math.floor(instantOf(date, '00:00', tz).getTime() / 86_400_000);
  let idx = 0;
  if (rotate === 'daily') idx = dayNo;
  else if (rotate === 'hourly') {
    const hour = hourOf(now, tz);
    idx = dayNo * 24 + hour;
  }
  return images[((idx % images.length) + images.length) % images.length] ?? null;
}

/** Uploaded images (later plans) live under our own /uploads/ path: one plain file name, nothing else. */
const UPLOAD_RE = /^\/uploads\/(?!\.+$)[A-Za-z0-9._-]{1,100}$/;

/** A picture uploaded to the box: its 64-hex content id, served by the box at /assets/<id>. */
const ASSET_ID_RE = /^[0-9a-f]{64}$/;

/**
 * The URL an image name resolves to: a built-in asset by its own key, a box picture id
 * (/assets/<id>), or a same-origin /uploads/<file> path. Anything else (`//host`, `/\x`, `http:`, `..`, prototype keys)
 * falls back to default-1 so a setting can never make the TV load a foreign image.
 */
export function urlFor(name: string): string {
  if (Object.prototype.hasOwnProperty.call(BUILT_IN, name)) return BUILT_IN[name] ?? bg1;
  if (ASSET_ID_RE.test(name)) return `/assets/${name}`;
  if (UPLOAD_RE.test(name)) return name;
  return bg1;
}

/**
 * Whether the picture, after the surau's black shade (0..1) has darkened it, is 'light' or 'dark' (the stage's
 * `data-pic`): themes dress free text over it light-on-dark or dark-on-light. Null while it has not been measured.
 */
export function pictureTone(meanLuma: number | null, shade: number): 'light' | 'dark' | null {
  if (meanLuma === null || !Number.isFinite(meanLuma)) return null;
  const s = Number.isFinite(shade) ? Math.min(1, Math.max(0, shade)) : 0;
  return meanLuma * (1 - s) > 0.25 ? 'light' : 'dark';
}

/**
 * The tone of the default look: measured from the picture on screen while autoTone is on, else the fixed tone. The
 * accent is styling and has one control, Ubah suai "Warna aksen" (it overrides the measured accent on the stage): the
 * old autoTone.override colour is no longer offered in Tetapan and a stored one is ignored.
 */
export function resolveTone(measured: Tone | null, settings: Settings): Tone {
  return settings.autoTone.enabled && measured ? measured : DEFAULT_TONE;
}

/** The pictures of the surau's backgrounds list (Tetapan), in order; `ownOnly` leaves out the built-in default photos. */
function listImages(settings: Settings, ownOnly: boolean): string[] {
  const bg = settings.backgrounds;
  if (!bg.enabled || !Array.isArray(bg.images)) return [];
  const all = (bg.images as unknown[]).filter((x): x is string => typeof x === 'string');
  return ownOnly ? all.filter((x) => !Object.prototype.hasOwnProperty.call(BUILT_IN, x)) : all;
}

/**
 * The backgrounds list's picture for a theme other than the default look (spec 6.10.1 layer 4, under the menu and the
 * pack pictures): the surau's own pictures only, rotated as on the default look. The built-in default photos belong to
 * the default look; every other theme's own field stands in for them. Null when the list has none of its own.
 */
export function themeListPicture(settings: Settings, now: Date): string | null {
  const name = pickBackground(listImages(settings, true), String(settings.backgrounds.rotate ?? 'daily'), now, tzOf(settings));
  return name ? urlFor(name) : null;
}

/**
 * Whether the default look shows one of the surau's OWN pictures from the backgrounds list right now (the built-in
 * default photos are the look itself, not a picture the surau chose). The stage then wears `data-picture`.
 */
export function ownListPictureOn(settings: Settings, now: Date): boolean {
  const name = pickBackground(listImages(settings, false), String(settings.backgrounds.rotate ?? 'daily'), now, tzOf(settings));
  return name !== null && !Object.prototype.hasOwnProperty.call(BUILT_IN, name);
}

/** CSS custom properties for a tone; set on the stage element. */
export function toneVars(tone: Tone): Record<string, string> {
  const rgb = (hex: string): string => {
    const h = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
    return `${parseInt(h.slice(1, 3), 16)} ${parseInt(h.slice(3, 5), 16)} ${parseInt(h.slice(5, 7), 16)}`;
  };
  return {
    '--glass-rgb': rgb(tone.glass),
    '--accent': tone.accent,
    '--accent-rgb': rgb(tone.accent),
    '--shade': String(tone.shadeAlpha),
    '--text': tone.text,
  };
}

export interface BackgroundProps {
  settings: Settings;
  now: Date;
  /** Reports the measured tone of the image that is on screen (null while none is). */
  onTone: (tone: Tone | null) => void;
  /** A box picture id the surau chose for this screen's menu background; null/absent = none. */
  menuImage?: string | null;
  /** The pack's own picture for this screen (used only when no menu picture shows); drawn and measured like `menuImage`. */
  packImageUrl?: string | null;
  /** The menu picture could not be loaded: the caller drops it and the next layer shows. */
  onMenuImageFailed?: () => void;
  /** Mean luminance (0..1) of the menu picture once measured; null when it cannot be (or there is none). */
  onMenuLuma?: (luma: number | null) => void;
}

/**
 * Full-screen background: the picture, its gradient shade and the solat dim layer.
 * Shared by Main and Phase so the picture never flashes between screens.
 */
export function Background({ settings, now, onTone, menuImage, packImageUrl, onMenuImageFailed, onMenuLuma }: BackgroundProps) {
  const bg = settings.backgrounds;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const images = useMemo(() => listImages(settings, false), [bg.images, bg.enabled]);
  const name = pickBackground(images, String(bg.rotate ?? 'daily'), now, tzOf(settings));
  const src = name ? urlFor(name) : null;
  const [readySrc, setReadySrc] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const probeRef = useRef<HTMLImageElement>(null);
  // The menu picture (spec 6.10.1): the tone is measured from it instead of the background list's picture.
  const menuSrc = menuImage ? assetSrc(menuImage) : (packImageUrl ?? null);

  const report = (img: HTMLImageElement): void => {
    try {
      const stats = sampleImage(img);
      onTone(autoTone(stats));
      if (menuSrc !== null) onMenuLuma?.(stats.meanLuma);
    } catch {
      onTone(null);
      if (menuSrc !== null) onMenuLuma?.(null);
    }
  };
  const measure = (img: HTMLImageElement): void => {
    if (menuSrc === null) report(img);
    setReadySrc(src);
  };

  useEffect(() => {
    const img = imgRef.current;
    if (menuSrc !== null) return;
    if (!src || !img) {
      onTone(null);
      return;
    }
    if (img.complete && img.naturalWidth > 0) measure(img);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, menuSrc]);

  useEffect(() => {
    const probe = probeRef.current;
    if (menuSrc === null || !probe) return;
    if (probe.complete && probe.naturalWidth > 0) report(probe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuSrc]);

  return (
    <div class="bg" aria-hidden="true">
      {src ? (
        <img
          ref={imgRef}
          class={`bg__img${readySrc === src ? ' is-ready' : ''}`}
          src={src}
          alt=""
          decoding="async"
          onLoad={(e) => measure(e.currentTarget)}
          onError={() => onTone(null)}
        />
      ) : null}
      {/* The night picture without its moon: the Default look's content screens show it over the picture (CSS), so the
          moon never sits behind the enlarged text there. Never measured: the tone stays the picture's. */}
      {name === 'default-2' && readySrc === src ? <img class="bg__plain" src={bg2Plain} alt="" decoding="async" /> : null}
      {menuSrc !== null ? (
        <>
          <div class="bg__menu" />
          <img
            ref={probeRef}
            class="bg__probe"
            src={menuSrc}
            alt=""
            onLoad={(e) => report(e.currentTarget)}
            onError={() => {
              onTone(null);
              onMenuLuma?.(null);
              onMenuImageFailed?.();
            }}
          />
        </>
      ) : null}
      <div class="bg__shade" />
      <div class="bg__scrim" />
      <div class="bg__dim" />
    </div>
  );
}
