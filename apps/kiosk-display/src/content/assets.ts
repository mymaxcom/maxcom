import { isPreview, previewAssetUrl } from '../data/preview.ts';

/** Box asset ids are sha256 hex; anything else never becomes an image src (no external or relative URLs). */
const ASSET_ID = /^[0-9a-f]{64}$/;

export function assetSrc(id: unknown): string | null {
  if (typeof id !== 'string' || !ASSET_ID.test(id)) return null;
  // Preview cannot send a Bearer header from <img>: it shows the blob it fetched itself (null until then).
  return isPreview() ? previewAssetUrl(id) : `/assets/${id}`;
}

/** Numeric setting leaf with a fallback (settings leaves are `unknown` for content features). */
export function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
