import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { autoTone, dateOf, hourOf, instantOf, tzOf } from '@surau/core';
import type { ImageStats, Settings, Tone } from '@surau/core';
import bg1 from '../assets/backgrounds/default-1.jpg';
import bg2 from '../assets/backgrounds/default-2.jpg';

/** The tone used before an image has been measured (mockup theme 1). */
export const DEFAULT_TONE: Tone = { shadeAlpha: 0.55, glass: '#06302b', accent: '#f0c97a', text: '#ffffff' };

const BUILT_IN: Record<string, string> = { 'default-1': bg1, 'default-2': bg2 };
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

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

/** Apply a manual override (hex accent) or disable auto tone altogether. */
export function resolveTone(measured: Tone | null, settings: Settings): Tone {
  const at = settings.autoTone;
  const base = at.enabled && measured ? measured : DEFAULT_TONE;
  const override = at.enabled && typeof at.override === 'string' && HEX_RE.test(at.override.trim())
    ? at.override.trim().toLowerCase()
    : null;
  return override ? { ...base, accent: override } : base;
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
}

/**
 * Full-screen background: the picture, its gradient shade and the solat dim layer.
 * Shared by Main and Phase so the picture never flashes between screens.
 */
export function Background({ settings, now, onTone }: BackgroundProps) {
  const bg = settings.backgrounds;
  const images = useMemo(
    () => (Array.isArray(bg.images) ? (bg.images as unknown[]).filter((x): x is string => typeof x === 'string') : []),
    [bg.images],
  );
  const name = bg.enabled ? pickBackground(images, String(bg.rotate ?? 'daily'), now, tzOf(settings)) : null;
  const src = name ? urlFor(name) : null;
  const [readySrc, setReadySrc] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const measure = (img: HTMLImageElement): void => {
    try {
      onTone(autoTone(sampleImage(img)));
    } catch {
      onTone(null);
    }
    setReadySrc(src);
  };

  useEffect(() => {
    const img = imgRef.current;
    if (!src || !img) {
      onTone(null);
      return;
    }
    if (img.complete && img.naturalWidth > 0) measure(img);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

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
      <div class="bg__shade" />
      <div class="bg__dim" />
    </div>
  );
}
